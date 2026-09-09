"""HTTP routes for account registration, cookie sessions, and logout."""

from collections.abc import Iterator
import hashlib

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
from cinemind.security import SlidingWindowRateLimiter
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
auth_registration_rate_limiter = SlidingWindowRateLimiter(
    max_attempts=get_settings().auth_rate_limit_max_attempts,
    window_seconds=get_settings().auth_rate_limit_window_seconds,
)


def get_auth_service() -> Iterator[AuthService]:
    """Create a short-lived repository connection for one auth request."""

    settings = get_settings()
    with connection_scope(settings) as connection:
        yield AuthService(AuthRepository(connection), settings)


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> AuthResponse:
    """Register an account and merge the current anonymous session when possible."""

    settings = get_settings()
    _require_secure_transport(request, settings)
    rate_key = _auth_rate_limit_key(request, payload.email, "register")
    _enforce_auth_rate_limit(request, rate_key)
    _enforce_registration_rate_limit(request)
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
        raise HTTPException(status_code=409, detail=str(error)) from error
    except AuthValidationError as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=400, detail=str(error)) from error
    except psycopg.errors.UniqueViolation as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=409, detail="An account with these details already exists") from error
    finally:
        # Count every registration attempt, including successful ones.  A
        # success must not create a loophole for automated account creation.
        _record_registration_attempt(request)
    _record_auth_success(request, rate_key)
    return _complete_auth_response(response, request, result, settings)


@router.post("/login", response_model=AuthResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> AuthResponse:
    """Sign in by email or username without disclosing account existence."""

    settings = get_settings()
    _require_secure_transport(request, settings)
    rate_key = _auth_rate_limit_key(request, payload.identifier, "login")
    _enforce_auth_rate_limit(request, rate_key)
    try:
        result = service.login(
            payload.identifier,
            payload.password,
            payload.anonymous_session_id,
            _user_agent(request),
            anonymous_session_token=payload.anonymous_session_token,
        )
    except InvalidCredentialsError as error:
        _record_auth_failure(request, rate_key)
        raise HTTPException(status_code=401, detail="Invalid email/username or password") from error
    except AuthValidationError as error:
        _record_auth_failure(request, rate_key)
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
    if not settings.trust_proxy_headers:
        return False
    forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().casefold()
    return forwarded == "https"


def _require_secure_transport(request: Request, settings: Settings) -> None:
    """Prevent authentication material from being issued over plaintext HTTP."""

    if settings.require_https and not _request_is_secure(request, settings):
        raise HTTPException(status_code=400, detail="Secure transport is required")


def _auth_rate_limit_key(request: Request, identifier: str, operation: str) -> str:
    """Build a bounded, non-sensitive bucket key from client and identifier."""

    address = client_address_from_request(request, get_settings())
    identifier_hash = hashlib.sha256(
        str(identifier).strip().casefold().encode("utf-8")
    ).hexdigest()
    return f"{operation}:{address}:{identifier_hash}"


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
    )


def _enforce_auth_rate_limit(request: Request, identifier_key: str) -> None:
    """Raise a neutral retry response when an auth bucket is exhausted."""

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


def _enforce_registration_rate_limit(request: Request) -> None:
    """Bound total account-creation attempts from one client address."""

    decision = auth_registration_rate_limiter.check(_auth_ip_key(request, "register"))
    if decision.allowed:
        return
    raise HTTPException(
        status_code=429,
        detail="Too many registration attempts. Please try again later.",
        headers={"Retry-After": str(decision.retry_after_seconds)},
    )


def _record_auth_failure(request: Request, identifier_key: str) -> None:
    auth_rate_limiter.record_failure(identifier_key)
    auth_ip_rate_limiter.record_failure(_auth_ip_key(request, identifier_key.split(":", 1)[0]))


def _record_auth_success(request: Request, identifier_key: str) -> None:
    auth_rate_limiter.record_success(identifier_key)


def _record_registration_attempt(request: Request) -> None:
    auth_registration_rate_limiter.record_failure(_auth_ip_key(request, "register"))
