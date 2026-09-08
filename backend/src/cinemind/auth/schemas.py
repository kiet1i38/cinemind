"""Pydantic contracts for authentication and account pages."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class RegisterRequest(BaseModel):
    """Create an account and optionally merge the current browser session."""

    email: str = Field(..., min_length=3, max_length=320)
    username: str = Field(..., min_length=3, max_length=32)
    display_name: str = Field(..., min_length=1, max_length=80)
    password: str = Field(..., min_length=1, max_length=128)
    anonymous_session_id: UUID | None = None
    anonymous_session_token: str | None = Field(default=None, min_length=20, max_length=256)


class LoginRequest(BaseModel):
    """Sign in with either the normalized email or username."""

    identifier: str = Field(..., min_length=1, max_length=320)
    password: str = Field(..., min_length=1, max_length=128)
    anonymous_session_id: UUID | None = None
    anonymous_session_token: str | None = Field(default=None, min_length=20, max_length=256)


class UserResponse(BaseModel):
    """Safe account fields exposed to the browser."""

    user_id: UUID
    email: str
    username: str
    display_name: str
    created_at: datetime
    last_login_at: datetime | None = None


class AuthResponse(BaseModel):
    """Successful register or login response."""

    user: UserResponse
    interaction_session_id: UUID | None = None


class AuthStateResponse(BaseModel):
    """Current cookie-authenticated state without exposing token details."""

    authenticated: bool
    user: UserResponse | None = None


class LogoutResponse(BaseModel):
    """Small response for idempotent logout operations."""

    ok: bool = True


class LogoutRequest(BaseModel):
    """Optional browser interaction session to end with the auth session."""

    interaction_session_id: UUID | None = None
    interaction_session_token: str | None = Field(default=None, min_length=20, max_length=256)
