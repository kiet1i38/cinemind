"""FastAPI dependencies for optional and required cookie authentication."""

from dataclasses import dataclass
from collections.abc import Iterator
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status

from cinemind.auth.crypto import hash_session_token
from cinemind.auth.repository import AuthRepository
from cinemind.config import get_settings
from cinemind.db.connection import connection_scope


@dataclass(frozen=True)
class AuthContext:
    """Verified account identity derived from one opaque cookie."""

    user_id: UUID
    auth_session_id: UUID
    user: dict
    interaction_session_id: UUID | None = None


def get_optional_auth_context(request: Request) -> AuthContext | None:
    """Resolve a valid cookie without requiring login for catalog browsing."""

    token = request.cookies.get(get_settings().auth_cookie_name)
    if not token:
        return None
    with connection_scope(get_settings()) as connection:
        repository = AuthRepository(connection)
        with repository.transaction():
            repository.acquire_write_lock()
            record = repository.get_auth_context(hash_session_token(token))
            interaction_session_id = None
            raw_interaction_session_id = request.headers.get("x-cinemind-session")
            interaction_session_token = request.headers.get("x-cinemind-session-token")
            if record and raw_interaction_session_id and interaction_session_token:
                try:
                    interaction_session_id = repository.get_attached_interaction_session(
                        UUID(raw_interaction_session_id),
                        record["user_id"],
                        hash_session_token(interaction_session_token),
                    )
                except ValueError:
                    interaction_session_id = None
    if not record:
        return None
    return AuthContext(
        user_id=record["user_id"],
        auth_session_id=record["auth_session_id"],
        interaction_session_id=interaction_session_id,
        user={
            key: record[key]
            for key in (
                "user_id",
                "email",
                "username",
                "display_name",
                "created_at",
                "last_login_at",
            )
        },
    )


def require_auth_context(
    context: AuthContext | None = Depends(get_optional_auth_context),
) -> AuthContext:
    """Reject protected interaction actions when the cookie is absent/invalid."""

    if context is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "AUTH_REQUIRED", "message": "Authentication required"},
        )
    return context
