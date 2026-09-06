"""Protected administrative routes excluded from the public OpenAPI schema."""

import logging
import secrets
from collections.abc import Iterator

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from cinemind.admin.repository import ResetRepository
from cinemind.admin.schemas import ResetRequest, ResetResponse
from cinemind.admin.service import ResetService, ResetValidationError
from cinemind.config import Settings, get_settings
from cinemind.db.connection import connection_scope
from cinemind.auth.routes import _request_is_secure


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"])
basic_auth = HTTPBasic(auto_error=False)


def require_admin(
    request: Request,
    credentials: HTTPBasicCredentials | None = Depends(basic_auth),
) -> Settings:
    """Validate Basic Auth before opening a database connection."""

    settings = get_settings()
    if request is not None and settings.require_https and not _request_is_secure(request, settings):
        raise HTTPException(status_code=400, detail="Secure transport is required")
    _require_admin(credentials, settings)
    return settings


def get_reset_service(settings: Settings = Depends(require_admin)) -> Iterator[ResetService]:
    """Create a short-lived repository connection for one reset request."""

    with connection_scope(settings) as connection:
        yield ResetService(ResetRepository(connection), settings)


@router.post(
    "/reset",
    response_model=ResetResponse,
    status_code=status.HTTP_200_OK,
    include_in_schema=False,
)
def reset_database(
    payload: ResetRequest,
    service: ResetService = Depends(get_reset_service),
) -> ResetResponse:
    """Reset protected data after Basic Auth and an exact confirmation phrase."""

    try:
        return ResetResponse(**service.reset(payload))
    except ResetValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except psycopg.Error:
        logger.exception("CineMind database reset failed")
        raise HTTPException(status_code=503, detail="Database reset is unavailable") from None


def _require_admin(
    credentials: HTTPBasicCredentials | None,
    settings: Settings,
) -> None:
    """Validate Basic Auth without exposing configured secret state."""

    if not settings.reset_enabled:
        raise HTTPException(status_code=503, detail="Database reset is unavailable")
    if not settings.admin_reset_username or not settings.admin_reset_password:
        raise HTTPException(status_code=503, detail="Admin reset credentials are not configured")

    valid_username = bool(credentials) and secrets.compare_digest(
        credentials.username,
        settings.admin_reset_username,
    )
    valid_password = bool(credentials) and secrets.compare_digest(
        credentials.password,
        settings.admin_reset_password,
    )
    if not (valid_username and valid_password):
        raise HTTPException(
            status_code=401,
            detail="Invalid admin credentials",
            headers={"WWW-Authenticate": "Basic"},
        )
