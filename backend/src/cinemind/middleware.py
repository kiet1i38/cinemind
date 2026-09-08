"""ASGI middleware used to bound untrusted HTTP request bodies and writes."""

from collections.abc import Callable
import hashlib

from starlette.responses import JSONResponse

from cinemind.security import SlidingWindowRateLimiter, client_address_from_headers


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
    """Keep interaction error buckets isolated by client and browser session.

    The interaction limiter is intentionally failure-based: successful calls
    clear the failure bucket, while malformed, unauthorized, and server-error
    responses consume a slot.  A separate client bucket prevents a caller from
    bypassing the session key by rotating arbitrary session headers.
    """

    def __init__(
        self,
        app,
        max_attempts: int,
        window_seconds: int,
        trust_proxy_headers: bool = False,
        auth_cookie_name: str = "cinemind_auth",
    ):
        self.app = app
        self.trust_proxy_headers = trust_proxy_headers
        self.auth_cookie_name = auth_cookie_name
        self.session_limiter = SlidingWindowRateLimiter(max_attempts, window_seconds)
        self.client_limiter = SlidingWindowRateLimiter(
            max(max_attempts * 5, max_attempts), window_seconds
        )

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
        )
        principal = _interaction_principal(
            headers,
            client,
            auth_cookie_name=self.auth_cookie_name,
        )
        client_key = f"interaction-client:{client}"
        principal_key = f"interaction-principal:{principal}"
        decision = self.client_limiter.check(client_key)
        principal_decision = self.session_limiter.check(principal_key)
        if not decision.allowed or not principal_decision.allowed:
            retry_after = max(decision.retry_after_seconds, principal_decision.retry_after_seconds)
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
        else:
            self.client_limiter.record_success(client_key)
            self.session_limiter.record_success(principal_key)


class CSRFMiddleware:
    """Reject cross-site browser writes while preserving non-browser API use."""

    SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})

    def __init__(self, app, allowed_origins: tuple[str, ...]):
        self.app = app
        self.allowed_origins = frozenset(origin.rstrip("/") for origin in allowed_origins)

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
        request_origin = _scope_origin(scope)
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


def _scope_origin(scope) -> str:
    headers = _scope_headers(scope)
    host = headers.get("host", "").strip()
    return f"{scope.get('scheme', 'http')}://{host}" if host else ""


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

    session = headers.get("x-cinemind-session", "").strip()
    auth_cookie = _cookie_value(headers.get("cookie", ""), auth_cookie_name)
    return session or (
        hashlib.sha256(auth_cookie.encode("utf-8")).hexdigest()
        if auth_cookie
        else client
    )
