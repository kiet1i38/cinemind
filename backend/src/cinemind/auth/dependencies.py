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


def get_optional_auth_context(request: Request) -> AuthContext | None:
    """Resolve a valid cookie without requiring login for catalog browsing."""

    token = request.cookies.get(get_settings().auth_cookie_name)
    if not token:
        return None
    with connection_scope(get_settings()) as connection:
        record = AuthRepository(connection).get_auth_context(hash_session_token(token))
    if not record:
        return None
    return AuthContext(
        user_id=record["user_id"],
        auth_session_id=record["auth_session_id"],
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
            detail="Authentication required",
        )
    return context
