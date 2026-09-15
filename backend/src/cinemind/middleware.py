"""ASGI middleware used to bound untrusted HTTP request bodies and writes."""

from collections.abc import Callable
import hashlib
from uuid import UUID

from starlette.responses import JSONResponse

from cinemind.security import (
    SlidingWindowRateLimiter,
    client_address_from_headers,
    consume_many,
    is_trusted_proxy,
)


class _RequestBodyTooLarge(Exception):
    """Internal signal raised when a streamed body exceeds the configured cap."""


class RequestBodyLimitMiddleware:
    """Reject oversized bodies before route handlers parse or persist them."""

    def __init__(self, app, max_body_bytes: int):
        if max_body_bytes < 1:
            raise ValueError("max_body_bytes must be positive")
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_body_bytes:
            await self._respond_too_large(scope, receive, send)
            return

        received_bytes = 0

        async def limited_receive():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_body_bytes:
                    raise _RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _RequestBodyTooLarge:
            await self._respond_too_large(scope, receive, send)

    @staticmethod
    def _content_length(scope) -> int | None:
        headers = {
            key.decode("latin-1").casefold(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        raw_length = headers.get("content-length")
        if raw_length is None:
            return None
        try:
            value = int(raw_length)
        except ValueError:
            return None
        return value if value >= 0 else None

    @staticmethod
    async def _respond_too_large(scope, receive, send) -> None:
        response = JSONResponse(
            {"detail": "Request body is too large"},
            status_code=413,
        )
        await response(scope, receive, send)


class InteractionRateLimitMiddleware:
    """Keep interaction quotas isolated by client, principal, and endpoint.

    Failure buckets protect error paths, while write buckets consume every
    successful or failed mutation. A separate client bucket prevents callers
    from bypassing the principal key, and session creation has its own quota.
    """

    def __init__(
        self,
        app,
        max_attempts: int,
        window_seconds: int,
        trust_proxy_headers: bool = False,
        auth_cookie_name: str = "cinemind_auth",
        trusted_proxy_networks: tuple[str, ...] = (),
    ):
        self.app = app
        self.trust_proxy_headers = trust_proxy_headers
        self.auth_cookie_name = auth_cookie_name
        self.trusted_proxy_networks = trusted_proxy_networks
        self.session_limiter = SlidingWindowRateLimiter(max_attempts, window_seconds)
        self.client_limiter = SlidingWindowRateLimiter(
            max(max_attempts * 5, max_attempts), window_seconds
        )
        self.session_creation_limiter = SlidingWindowRateLimiter(
            max_attempts, window_seconds
        )
        self.write_client_limiter = SlidingWindowRateLimiter(max_attempts, window_seconds)
        self.write_principal_limiter = SlidingWindowRateLimiter(max_attempts, window_seconds)
        self.write_endpoint_limiter = SlidingWindowRateLimiter(max_attempts, window_seconds)

    async def __call__(self, scope, receive: Callable, send: Callable) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (
            path == "/api/interaction" or path.startswith("/api/interaction/")
        ):
            await self.app(scope, receive, send)
            return

        headers = _scope_headers(scope)
        client = client_address_from_headers(
            _scope_direct_client(scope),
            headers,
            trust_proxy_headers=self.trust_proxy_headers,
            trusted_proxy_networks=self.trusted_proxy_networks,
        )
        principal = _interaction_principal(
            headers,
            client,
            auth_cookie_name=self.auth_cookie_name,
        )
        client_key = f"interaction-client:{client}"
        principal_key = f"interaction-principal:{principal}"
        method = scope.get("method", "GET").upper()
        is_write = method in {"POST", "PUT", "PATCH", "DELETE"}
        # Keep the endpoint dimension isolated per real client. A global
        # endpoint bucket would let one caller exhaust the quota for everyone.
        endpoint_key = f"interaction-write-endpoint:{method}:{path}:{client}"
        is_session_creation = (
            scope.get("method", "GET") == "POST"
            and path == "/api/interaction/sessions"
        )
        decision = self.client_limiter.check(client_key)
        principal_decision = self.session_limiter.check(principal_key)
        reservations = []
        reservation_names = []
        if is_session_creation:
            reservations.append((self.session_creation_limiter, client_key))
            reservation_names.append("creation")
        if is_write:
            reservations.extend(
                (
                    (self.write_client_limiter, client_key),
                    (self.write_principal_limiter, principal_key),
                    (self.write_endpoint_limiter, endpoint_key),
                )
            )
            reservation_names.extend(("write_client", "write_principal", "write_endpoint"))
        # Do not consume any write/creation bucket when the base client or
        # principal failure bucket is already denied. More importantly, reserve
        # all write dimensions together so a denied principal cannot poison the
        # shared client or endpoint bucket for later callers.
        reserved = consume_many(tuple(reservations)) if decision.allowed and principal_decision.allowed else ()
        reservation_decisions = dict(zip(reservation_names, reserved))
        creation_decision = reservation_decisions.get("creation")
        write_client_decision = reservation_decisions.get("write_client")
        write_principal_decision = reservation_decisions.get("write_principal")
        write_endpoint_decision = reservation_decisions.get("write_endpoint")
        if (
            not decision.allowed
            or not principal_decision.allowed
            or (creation_decision is not None and not creation_decision.allowed)
            or (write_client_decision is not None and not write_client_decision.allowed)
            or (write_principal_decision is not None and not write_principal_decision.allowed)
            or (write_endpoint_decision is not None and not write_endpoint_decision.allowed)
        ):
            retry_after = max(
                decision.retry_after_seconds,
                principal_decision.retry_after_seconds,
                creation_decision.retry_after_seconds if creation_decision else 0,
                write_client_decision.retry_after_seconds if write_client_decision else 0,
                write_principal_decision.retry_after_seconds if write_principal_decision else 0,
                write_endpoint_decision.retry_after_seconds if write_endpoint_decision else 0,
            )
            await JSONResponse(
                {"detail": "Too many interaction requests. Please try again later."},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )(scope, receive, send)
            return

        status_code = 500

        async def capture_send(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message.get("status", 500))
            await send(message)

        try:
            await self.app(scope, receive, capture_send)
        except Exception:
            self.client_limiter.record_failure(client_key)
            self.session_limiter.record_failure(principal_key)
            raise
        if status_code >= 400:
            self.client_limiter.record_failure(client_key)
            self.session_limiter.record_failure(principal_key)


class CSRFMiddleware:
    """Reject cross-site browser writes while preserving non-browser API use."""

    SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})

    def __init__(
        self,
        app,
        allowed_origins: tuple[str, ...],
        trust_proxy_headers: bool = False,
        trusted_proxy_networks: tuple[str, ...] = (),
    ):
        self.app = app
        self.allowed_origins = frozenset(origin.rstrip("/") for origin in allowed_origins)
        self.trust_proxy_headers = trust_proxy_headers
        self.trusted_proxy_networks = trusted_proxy_networks

    async def __call__(self, scope, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http" or scope.get("method", "GET") in self.SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not path.startswith("/api/"):
            await self.app(scope, receive, send)
            return

        headers = _scope_headers(scope)
        origin = headers.get("origin", "").rstrip("/")
        fetch_site = headers.get("sec-fetch-site", "").casefold()
        request_origin = _scope_origin(
            scope,
            trust_proxy_headers=self.trust_proxy_headers,
            trusted_proxy_networks=self.trusted_proxy_networks,
        )
        origin_is_allowed = not origin or origin == request_origin or origin in self.allowed_origins
        if fetch_site == "cross-site" or not origin_is_allowed:
            await JSONResponse(
                {"detail": "Cross-site request blocked"},
                status_code=403,
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _scope_headers(scope) -> dict[str, str]:
    return {
        key.decode("latin-1").casefold(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }


def _scope_direct_client(scope) -> str | None:
    client = scope.get("client")
    return client[0] if client else None


def _scope_origin(
    scope,
    *,
    trust_proxy_headers: bool = False,
    trusted_proxy_networks: tuple[str, ...] = (),
) -> str:
    headers = _scope_headers(scope)
    host = headers.get("host", "").strip()
    scheme = scope.get("scheme", "http")
    if trust_proxy_headers and is_trusted_proxy(
        _scope_direct_client(scope), trusted_proxy_networks
    ):
        forwarded_scheme = headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().casefold()
        if forwarded_scheme in {"http", "https"}:
            scheme = forwarded_scheme
        forwarded_host = headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
        if forwarded_host:
            host = forwarded_host
    return f"{scheme}://{host}" if host else ""


def _cookie_value(cookie_header: str, name: str) -> str:
    for part in cookie_header.split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name:
            return value
    return ""


def _interaction_principal(
    headers: dict[str, str],
    client: str,
    *,
    auth_cookie_name: str,
) -> str:
    """Derive a stable limiter principal using the configured auth cookie."""

    session = _validated_session_header(headers.get("x-cinemind-session", ""))
    auth_cookie = _cookie_value(headers.get("cookie", ""), auth_cookie_name)
    return session or (
        hashlib.sha256(auth_cookie.encode("utf-8")).hexdigest()
        if auth_cookie
        else client
    )


def _validated_session_header(value: str) -> str:
    """Use only canonical UUID session headers as limiter principals."""

    normalized = str(value or "").strip()
    if len(normalized) > 64:
        return ""
    try:
        return str(UUID(normalized))
    except (ValueError, AttributeError, TypeError):
        return ""
