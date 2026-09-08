"""Account use cases, normalization, and session lifecycle rules."""

from datetime import datetime, timedelta, timezone
import re
from uuid import UUID, uuid4

from cinemind.auth.crypto import (
    dummy_password_hash,
    hash_password,
    hash_session_token,
    new_session_token,
    verify_password,
)
from cinemind.auth.repository import AuthRepository
from cinemind.config import Settings


EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")


class AuthValidationError(ValueError):
    """Raised when account input violates a product rule."""


class DuplicateAccountError(ValueError):
    """Raised without revealing which account field is already registered."""


class InvalidCredentialsError(ValueError):
    """Raised for every invalid identifier/password combination."""


class AuthService:
    """Coordinate user creation and opaque cookie-session persistence."""

    def __init__(self, repository: AuthRepository, settings: Settings):
        self.repository = repository
        self.settings = settings

    def register(
        self,
        email: str,
        username: str,
        display_name: str,
        password: str,
        anonymous_session_id: UUID | None,
        user_agent: str | None,
        anonymous_session_token: str | None = None,
    ) -> dict:
        normalized_email = self._normalize_email(email)
        normalized_username = self._normalize_username(username)
        normalized_display_name = self._normalize_display_name(display_name)
        self._validate_password(password)
        return self._create_authenticated_session(
            normalized_email,
            normalized_username,
            normalized_display_name,
            password,
            anonymous_session_id,
            user_agent,
            anonymous_session_token,
        )

    def login(
        self,
        identifier: str,
        password: str,
        anonymous_session_id: UUID | None,
        user_agent: str | None,
        anonymous_session_token: str | None = None,
    ) -> dict:
        normalized_identifier = self._normalize_identifier(identifier)
        with self.repository.transaction():
            user = self.repository.get_user_by_identifier(normalized_identifier)
            password_hash = (
                user.get("password_hash", "")
                if user
                else dummy_password_hash(self._password_iterations())
            )
            password_valid = verify_password(password, password_hash)
            if not user or not user.get("is_active") or not password_valid:
                raise InvalidCredentialsError("Invalid credentials")
            return self._create_login_session(
                user,
                anonymous_session_id,
                user_agent,
                anonymous_session_token,
            )

    def logout(
        self,
        raw_token: str | None,
        interaction_session_id: UUID | None = None,
        interaction_session_token: str | None = None,
    ) -> None:
        if not raw_token:
            return
        with self.repository.transaction():
            auth_token_hash = hash_session_token(raw_token)
            context = (
                self.repository.get_auth_context(auth_token_hash)
                if hasattr(self.repository, "get_auth_context")
                else None
            )
            self.repository.revoke_session(auth_token_hash)
            if context and interaction_session_id and hasattr(self.repository, "end_interaction_session"):
                self.repository.end_interaction_session(
                    interaction_session_id,
                    context["user_id"],
                    hash_session_token(interaction_session_token or ""),
                )

    def logout_all(self, user_id: UUID) -> None:
        with self.repository.transaction():
            self.repository.revoke_all_sessions(user_id)
            if hasattr(self.repository, "end_user_interaction_sessions"):
                self.repository.end_user_interaction_sessions(user_id)

    def _create_authenticated_session(
        self,
        email: str,
        username: str,
        display_name: str,
        password: str,
        anonymous_session_id: UUID | None,
        user_agent: str | None,
        anonymous_session_token: str | None = None,
    ) -> dict:
        now = datetime.now(timezone.utc)
        user_id = uuid4()
        raw_token = new_session_token()
        with self.repository.transaction():
            try:
                self._raise_if_duplicate(email, username)
                user = self.repository.create_user(
                    user_id,
                    email,
                    username,
                    display_name,
                    hash_password(password, self._password_iterations()),
                    now,
                )
            except Exception as error:
                if self._is_unique_violation(error):
                    raise DuplicateAccountError("An account with these details already exists") from None
                raise
            self.repository.set_last_login(user_id, now)
            attached = self._attach_session(
                anonymous_session_id,
                user_id,
                anonymous_session_token,
            )
            self.repository.create_session(
                uuid4(),
                user_id,
                hash_session_token(raw_token),
                now,
                now + timedelta(days=self._session_ttl_days()),
                user_agent,
            )
            user = self.repository.get_user(user_id) or user
        return self._result(user, raw_token, anonymous_session_id if attached else None)

    def _create_login_session(
        self,
        user: dict,
        anonymous_session_id: UUID | None,
        user_agent: str | None,
        anonymous_session_token: str | None = None,
    ) -> dict:
        now = datetime.now(timezone.utc)
        raw_token = new_session_token()
        self.repository.set_last_login(user["user_id"], now)
        attached = self._attach_session(
            anonymous_session_id,
            user["user_id"],
            anonymous_session_token,
        )
        self.repository.create_session(
            uuid4(),
            user["user_id"],
            hash_session_token(raw_token),
            now,
            now + timedelta(days=self._session_ttl_days()),
            user_agent,
        )
        refreshed_user = self.repository.get_user(user["user_id"]) or user
        return self._result(refreshed_user, raw_token, anonymous_session_id if attached else None)

    def _attach_session(
        self,
        session_id: UUID | None,
        user_id: UUID,
        session_token: str | None = None,
    ) -> bool:
        if not session_id:
            return False
        if session_token is not None:
            return bool(
                self.repository.attach_interaction_session(
                    session_id,
                    user_id,
                    hash_session_token(session_token),
                )
            )
        return bool(self.repository.attach_interaction_session(session_id, user_id))

    @staticmethod
    def _result(user: dict, raw_token: str, interaction_session_id: UUID | None) -> dict:
        safe_user = {key: value for key, value in user.items() if key != "password_hash"}
        return {
            "user": safe_user,
            "token": raw_token,
            "interaction_session_id": interaction_session_id,
        }

    def _raise_if_duplicate(self, email: str, username: str) -> None:
        if self.repository.get_user_by_identifier(email) or self.repository.get_user_by_identifier(username):
            raise DuplicateAccountError("An account with these details already exists")

    def _password_iterations(self) -> int:
        value = int(getattr(self.settings, "auth_password_iterations", 600000))
        if value < 10000:
            raise AuthValidationError("Password work factor is too low")
        return value

    def _session_ttl_days(self) -> int:
        value = int(getattr(self.settings, "auth_session_ttl_days", 30))
        if value < 1 or value > 365:
            raise AuthValidationError("Session lifetime must be between 1 and 365 days")
        return value

    @staticmethod
    def _normalize_identifier(value: str) -> str:
        normalized = str(value).strip().casefold()
        if not normalized:
            raise AuthValidationError("Email or username is required")
        return normalized

    @classmethod
    def _normalize_email(cls, value: str) -> str:
        normalized = str(value).strip().casefold()
        if not EMAIL_PATTERN.fullmatch(normalized) or len(normalized) > 320:
            raise AuthValidationError("Enter a valid email address")
        return normalized

    @classmethod
    def _normalize_username(cls, value: str) -> str:
        normalized = str(value).strip().casefold()
        if not USERNAME_PATTERN.fullmatch(normalized):
            raise AuthValidationError("Username must use 3 to 32 letters, numbers, dots, hyphens, or underscores")
        return normalized

    @staticmethod
    def _normalize_display_name(value: str) -> str:
        normalized = re.sub(r"\s+", " ", str(value).strip())
        if not normalized or len(normalized) > 80:
            raise AuthValidationError("Display name must be between 1 and 80 characters")
        return normalized

    @staticmethod
    def _validate_password(value: str) -> None:
        if len(str(value)) < 8 or len(str(value)) > 128:
            raise AuthValidationError("Password must be between 8 and 128 characters")

    @staticmethod
    def _is_unique_violation(error: Exception) -> bool:
        return error.__class__.__name__ == "UniqueViolation"
