"""HTTP routes for account registration, cookie sessions, and logout."""

from collections.abc import Iterator
import hashlib
from threading import Lock
import time

import psycopg
from fastapi import APIRouter, Depends, Request, Response, status

from cinemind.auth.dependencies import AuthContext, get_optional_auth_context, require_auth_context
from cinemind.auth.repository import AuthRepository
from cinemind.auth.schemas import (
    AuthResponse,
    AuthStateResponse,
    LoginRequest,
    LogoutRequest,
    LogoutResponse,
    RegisterRequest,
    UserResponse,
)
from cinemind.auth.service import (
    AuthService,
    AuthValidationError,
    DuplicateAccountError,
    InvalidCredentialsError,
)
from cinemind.config import Settings, get_settings
from cinemind.db.connection import connection_scope
from cinemind.security import SlidingWindowRateLimiter, consume_many, is_trusted_proxy
from fastapi import HTTPException


router = APIRouter(prefix="/api/auth", tags=["auth"])
auth_rate_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_rate_limit_max_attempts,
    window_seconds=get_settings().auth_rate_limit_window_seconds,
)
auth_ip_rate_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_rate_limit_max_attempts,
    window_seconds=get_settings().auth_rate_limit_window_seconds,
)
auth_login_attempt_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_login_rate_limit_max_attempts,
    window_seconds=get_settings().auth_login_rate_limit_window_seconds,
)
auth_login_ip_attempt_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_login_rate_limit_max_attempts,
    window_seconds=get_settings().auth_login_rate_limit_window_seconds,
)
auth_registration_rate_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_rate_limit_max_attempts,
    window_seconds=get_settings().auth_rate_limit_window_seconds,
)
_auth_cleanup_lock = Lock()
_last_auth_cleanup = 0.0


def get_auth_service() -> Iterator[AuthService]:
    """Create a short-lived repository connection for one auth request."""

    settings = get_settings()
    with connection_scope(settings) as connection:
        repository = AuthRepository(connection)
        _maybe_cleanup_auth_sessions(repository, settings)
        yield AuthService(repository, settings)


def _prepare_register_request(request: Request, payload: RegisterRequest) -> str:
    """Validate transport and rate limits before opening a DB connection."""

    settings = get_settings()
    _require_secure_transport(request, settings)
    rate_key = _auth_rate_limit_key(request, payload.email, "register")
    _enforce_auth_rate_limit(request, rate_key)
    _enforce_registration_rate_limit(request)
    return rate_key


def _prepare_login_request(request: Request, payload: LoginRequest) -> str:
    """Resolve the login principal and enforce limits before password work."""

    settings = get_settings()
    _require_secure_transport(request, settings)
    # Reject an already-exhausted client before borrowing a database connection
    # to resolve the account. The account bucket must still be resolved after
    # this cheap preflight so email and username aliases share one quota.
    _enforce_login_ip_preflight(request)
    # Resolve aliases before reserving the account-attempt bucket. Email and
    # username are both accepted login identifiers, so hashing the raw input
    # would give one account two independent quotas. Unknown identifiers use a
    # stable per-identifier principal, not a global bucket that could become an
    # account-existence oracle.
    user_id = _lookup_login_user_id(payload.identifier, settings)
    principal = _login_rate_limit_principal(payload.identifier, user_id)
    rate_key = _auth_rate_limit_key(request, payload.identifier, "login", principal=principal)
    account_rate_key = _auth_identifier_rate_limit_key(payload.identifier, "login", principal=principal)
    _enforce_login_attempt_rate_limit(request, account_rate_key)
    _enforce_auth_rate_limit(request, rate_key)
    return rate_key


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    prepared_rate_key: str | None = Depends(_prepare_register_request),
    service: AuthService = Depends(get_auth_service),
) -> AuthResponse:
    """Register an account and merge the current anonymous session when possible."""

    settings = get_settings()
    rate_key = prepared_rate_key if isinstance(prepared_rate_key, str) else _auth_rate_limit_key(request, payload.email, "register")
    try:
        result = service.register(
            payload.email,
            payload.username,
            payload.display_name,
            payload.password,
            payload.anonymous_session_id,
            _user_agent(request),
            anonymous_session_token=payload.anonymous_session_token,
        )
    except DuplicateAccountError as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=400, detail="Unable to create account") from error
    except AuthValidationError as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=400, detail=str(error)) from error
    except psycopg.errors.UniqueViolation as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=400, detail="Unable to create account") from error
    _record_auth_success(request, rate_key)
    return _complete_auth_response(response, request, result, settings)


@router.post("/login", response_model=AuthResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    prepared_rate_key: str | None = Depends(_prepare_login_request),
    service: AuthService = Depends(get_auth_service),
) -> AuthResponse:
    """Sign in by email or username without disclosing account existence."""

    settings = get_settings()
    rate_key = prepared_rate_key if isinstance(prepared_rate_key, str) else _auth_rate_limit_key(request, payload.identifier, "login")
    try:
        result = service.login(
            payload.identifier,
            payload.password,
            payload.anonymous_session_id,
            _user_agent(request),
            anonymous_session_token=payload.anonymous_session_token,
        )
    except InvalidCredentialsError as error:
        if not _record_auth_failure(request, rate_key):
            raise _auth_failure_limit_exception() from error
        raise HTTPException(status_code=401, detail="Invalid email/username or password") from error
    except AuthValidationError as error:
        if not _record_auth_failure(request, rate_key):
            raise _auth_failure_limit_exception() from error
        raise HTTPException(status_code=400, detail=str(error)) from error
    _record_auth_success(request, rate_key)
    return _complete_auth_response(response, request, result, settings)


@router.get("/me", response_model=AuthStateResponse)
def me(
    context: AuthContext | None = Depends(get_optional_auth_context),
) -> AuthStateResponse:
    """Return account state for the shell without forcing login."""

    if context is None:
        return AuthStateResponse(authenticated=False, user=None)
    return AuthStateResponse(
        authenticated=True,
        user=UserResponse(**context.user),
    )


@router.post("/logout", response_model=LogoutResponse)
def logout(
    request: Request,
    response: Response,
    payload: LogoutRequest | None = None,
    service: AuthService = Depends(get_auth_service),
) -> LogoutResponse:
    """Revoke only the current browser session."""

    service.logout(
        request.cookies.get(get_settings().auth_cookie_name),
        payload.interaction_session_id if payload else None,
        payload.interaction_session_token if payload else None,
    )
    _clear_cookie(response, get_settings())
    return LogoutResponse()


@router.post("/logout-all", response_model=LogoutResponse)
def logout_all(
    request: Request,
    response: Response,
    context: AuthContext = Depends(require_auth_context),
    service: AuthService = Depends(get_auth_service),
) -> LogoutResponse:
    """Revoke every active browser session for the account."""

    service.logout_all(context.user_id)
    _clear_cookie(response, get_settings())
    return LogoutResponse()


def _complete_auth_response(
    response: Response,
    request: Request,
    result: dict,
    settings: Settings,
) -> AuthResponse:
    """Set the secure cookie and expose only the safe response fields."""

    response.set_cookie(
        key=settings.auth_cookie_name,
        value=result["token"],
        max_age=settings.auth_session_ttl_days * 24 * 60 * 60,
        httponly=True,
        secure=_request_is_secure(request, settings),
        samesite="lax",
        path="/",
    )
    return AuthResponse(
        user=UserResponse(**result["user"]),
        interaction_session_id=result["interaction_session_id"],
    )


def _clear_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(settings.auth_cookie_name, path="/")


def _user_agent(request: Request) -> str | None:
    value = request.headers.get("user-agent", "").strip()
    return value[:512] or None


def _request_is_secure(request: Request, settings: Settings) -> bool:
    """Trust forwarded HTTPS only when the deployment explicitly opts in."""

    if request.url.scheme == "https":
        return True
    if not settings.trust_proxy_headers or not is_trusted_proxy(
        request.client.host if request.client else None,
        settings.trusted_proxy_networks,
    ):
        return False
    forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().casefold()
    return forwarded == "https"


def _require_secure_transport(request: Request, settings: Settings) -> None:
    """Prevent authentication material from being issued over plaintext HTTP."""

    if settings.require_https and not _request_is_secure(request, settings):
        raise HTTPException(status_code=400, detail="Secure transport is required")


def _auth_rate_limit_key(
    request: Request,
    identifier: str,
    operation: str,
    *,
    principal: str | None = None,
) -> str:
    """Build a bounded, non-sensitive bucket key from client and identifier."""

    address = client_address_from_request(request, get_settings())
    identifier_hash = hashlib.sha256(
        str(principal if principal is not None else identifier).strip().casefold().encode("utf-8")
    ).hexdigest()
    return f"{operation}:{address}:{identifier_hash}"


def _auth_identifier_rate_limit_key(
    identifier: str,
    operation: str,
    *,
    principal: str | None = None,
) -> str:
    """Build an account bucket that cannot be bypassed by rotating IPs."""

    identifier_hash = hashlib.sha256(
        str(principal if principal is not None else identifier).strip().casefold().encode("utf-8")
    ).hexdigest()
    return f"{operation}:account:{identifier_hash}"


def _lookup_login_user_id(identifier: str, settings: Settings) -> str | None:
    """Resolve a login alias to a stable account key before password work."""

    normalized = str(identifier).strip().casefold()
    if not normalized:
        return None
    try:
        with connection_scope(settings) as connection:
            user = AuthRepository(connection).get_user_by_identifier(normalized)
    except psycopg.Error:
        # The authenticated service will report the actual database failure;
        # rate limiting must not turn an infrastructure outage into account
        # enumeration or a new externally visible error.
        return None
    return str(user["user_id"]) if user and user.get("user_id") else None


def _login_rate_limit_principal(identifier: str, user_id: str | None = None) -> str:
    if user_id:
        return f"user:{user_id}"
    # Unknown aliases must be isolated by their normalized value. A global
    # "unknown" bucket lets an attacker pre-fill it and distinguish a 429 for
    # a missing account from a 401 for a real account from another IP.
    normalized = str(identifier).strip().casefold()
    identifier_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"unknown:{identifier_hash}"


def _auth_ip_key(request: Request, operation: str) -> str:
    address = client_address_from_request(request, get_settings())
    return f"{operation}:{address}"


def client_address_from_request(request: Request, settings: Settings) -> str:
    """Resolve the actual peer address, honoring proxy headers only by opt-in."""

    from cinemind.security import client_address_from_headers

    return client_address_from_headers(
        request.client.host if request.client else None,
        {key.casefold(): value for key, value in request.headers.items()},
        trust_proxy_headers=settings.trust_proxy_headers,
        trusted_proxy_networks=settings.trusted_proxy_networks,
    )


def _enforce_auth_rate_limit(request: Request, identifier_key: str) -> None:
    """Run a cheap preflight before password work.

    Failed credentials are reserved atomically in ``_record_auth_failure``
    after password verification. Keeping this preflight non-consuming avoids
    charging successful logins against a failure-only quota.
    """

    ip_decision = auth_ip_rate_limiter.check(_auth_ip_key(request, identifier_key.split(":", 1)[0]))
    identifier_decision = auth_rate_limiter.check(identifier_key)
    if ip_decision.allowed and identifier_decision.allowed:
        return
    decision = ip_decision if not ip_decision.allowed else identifier_decision
    raise HTTPException(
        status_code=429,
        detail="Too many authentication attempts. Please try again later.",
        headers={"Retry-After": str(decision.retry_after_seconds)},
    )


def _enforce_login_ip_preflight(request: Request) -> None:
    """Fail fast when the request address already exhausted login quotas."""

    ip_key = _auth_ip_key(request, "login")
    decisions = (
        auth_login_ip_attempt_limiter.check(ip_key),
        auth_ip_rate_limiter.check(ip_key),
    )
    decision = next((candidate for candidate in decisions if not candidate.allowed), None)
    if decision is None:
        return
    raise HTTPException(
        status_code=429,
        detail="Too many login attempts. Please try again later.",
        headers={"Retry-After": str(decision.retry_after_seconds)},
    )


def _enforce_login_attempt_rate_limit(request: Request, identifier_key: str) -> None:
    """Consume a quota for every login, including valid-password attempts."""

    operation = identifier_key.split(":", 1)[0]
    identifier_decision, ip_decision = consume_many(
        (
            (auth_login_attempt_limiter, identifier_key),
            (auth_login_ip_attempt_limiter, _auth_ip_key(request, operation)),
        )
    )
    if identifier_decision.allowed and ip_decision.allowed:
        return
    decision = ip_decision if not ip_decision.allowed else identifier_decision
    raise HTTPException(
        status_code=429,
        detail="Too many login attempts. Please try again later.",
        headers={"Retry-After": str(decision.retry_after_seconds)},
    )


def _enforce_registration_rate_limit(request: Request) -> None:
    """Bound total account-creation attempts from one client address."""

    decision = auth_registration_rate_limiter.consume(_auth_ip_key(request, "register"))
    if decision.allowed:
        return
    raise HTTPException(
        status_code=429,
        detail="Too many registration attempts. Please try again later.",
        headers={"Retry-After": str(decision.retry_after_seconds)},
    )


def _record_auth_failure(request: Request, identifier_key: str) -> bool:
    """Atomically reserve the failure quota in both dimensions."""

    identifier_decision, ip_decision = consume_many(
        (
            (auth_rate_limiter, identifier_key),
            (auth_ip_rate_limiter, _auth_ip_key(request, identifier_key.split(":", 1)[0])),
        )
    )
    return identifier_decision.allowed and ip_decision.allowed


def _auth_failure_limit_exception() -> HTTPException:
    return HTTPException(
        status_code=429,
        detail="Too many authentication attempts. Please try again later.",
        headers={"Retry-After": str(get_settings().auth_rate_limit_window_seconds)},
    )


def _record_auth_success(request: Request, identifier_key: str) -> None:
    auth_rate_limiter.record_success(identifier_key)


def _record_registration_attempt(request: Request) -> None:
    auth_registration_rate_limiter.record_attempt(_auth_ip_key(request, "register"))


def _maybe_cleanup_auth_sessions(repository: AuthRepository, settings: Settings) -> None:
    """Run bounded session retention cleanup at most once per process interval."""

    global _last_auth_cleanup
    now = time.monotonic()
    with _auth_cleanup_lock:
        interval = max(1, int(getattr(settings, "auth_session_cleanup_interval_seconds", 300)))
        if now - _last_auth_cleanup < interval:
            return
        try:
            with repository.transaction():
                repository.acquire_write_lock()
                repository.cleanup_sessions(
                    max(1, int(getattr(settings, "auth_session_retention_days", 30)))
                )
        except psycopg.Error:
            # A later request retries cleanup; auth availability should not be
            # hidden behind a best-effort retention task.
            return
        _last_auth_cleanup = now
