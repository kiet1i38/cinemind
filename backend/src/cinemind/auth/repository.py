"""Parameterized PostgreSQL repository for users and cookie sessions."""

from datetime import datetime
from uuid import UUID


class AuthRepository:
    """Persist account records without putting SQL in route handlers."""

    def __init__(self, connection):
        self.connection = connection

    def transaction(self):
        """Return a transaction context for one auth use case."""

        return self.connection.transaction()

    def get_user_by_identifier(self, identifier: str) -> dict | None:
        row = self.connection.execute(
            """
            SELECT user_id, email, username, display_name, password_hash,
                   is_active, created_at, last_login_at
            FROM auth.users
            WHERE lower(email) = lower(%s) OR lower(username) = lower(%s)
            LIMIT 1
            """,
            (identifier, identifier),
        ).fetchone()
        return dict(row) if row else None

    def get_user(self, user_id: UUID) -> dict | None:
        row = self.connection.execute(
            """
            SELECT user_id, email, username, display_name, password_hash,
                   is_active, created_at, last_login_at
            FROM auth.users
            WHERE user_id = %s
            """,
            (user_id,),
        ).fetchone()
        return dict(row) if row else None

    def create_user(
        self,
        user_id: UUID,
        email: str,
        username: str,
        display_name: str,
        password_hash: str,
        created_at: datetime,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO auth.users (
                user_id, email, username, display_name, password_hash, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING user_id, email, username, display_name,
                      is_active, created_at, last_login_at
            """,
            (user_id, email, username, display_name, password_hash, created_at),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create account")
        return dict(row)

    def set_last_login(self, user_id: UUID, logged_in_at: datetime) -> None:
        self.connection.execute(
            """
            UPDATE auth.users
            SET last_login_at = %s
            WHERE user_id = %s
            """,
            (logged_in_at, user_id),
        )

    def create_session(
        self,
        auth_session_id: UUID,
        user_id: UUID,
        token_hash: str,
        created_at: datetime,
        expires_at: datetime,
        user_agent: str | None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO auth.sessions (
                auth_session_id, user_id, token_hash, user_agent,
                created_at, last_seen_at, expires_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING auth_session_id, user_id, expires_at
            """,
            (
                auth_session_id,
                user_id,
                token_hash,
                user_agent,
                created_at,
                created_at,
                expires_at,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create auth session")
        return dict(row)

    def get_auth_context(self, token_hash: str) -> dict | None:
        row = self.connection.execute(
            """
            SELECT s.auth_session_id,
                   u.user_id, u.email, u.username, u.display_name,
                   u.created_at, u.last_login_at
            FROM auth.sessions s
            JOIN auth.users u ON u.user_id = s.user_id
            WHERE s.token_hash = %s
              AND s.revoked_at IS NULL
              AND s.expires_at > CURRENT_TIMESTAMP
              AND u.is_active = TRUE
            """,
            (token_hash,),
        ).fetchone()
        return dict(row) if row else None

    def revoke_session(self, token_hash: str) -> None:
        self.connection.execute(
            """
            UPDATE auth.sessions
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE token_hash = %s AND revoked_at IS NULL
            """,
            (token_hash,),
        )

    def revoke_all_sessions(self, user_id: UUID) -> None:
        self.connection.execute(
            """
            UPDATE auth.sessions
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE user_id = %s AND revoked_at IS NULL
            """,
            (user_id,),
        )

    def attach_interaction_session(self, session_id: UUID, user_id: UUID) -> bool:
        """Bind only an anonymous or already-owned interaction session."""

        row = self.connection.execute(
            """
            UPDATE interaction.sessions
            SET user_id = %s, last_seen_at = CURRENT_TIMESTAMP
            WHERE session_id = %s
              AND ended_at IS NULL
              AND (user_id IS NULL OR user_id = %s)
            RETURNING session_id
            """,
            (user_id, session_id, user_id),
        ).fetchone()
        return row is not None
