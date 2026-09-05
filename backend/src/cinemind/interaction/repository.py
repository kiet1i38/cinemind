"""Parameterized PostgreSQL repository for the interaction schema."""

from datetime import datetime
from decimal import Decimal
from typing import Iterator
from uuid import UUID

from psycopg.types.json import Jsonb


class InteractionRepository:
    """Persist interaction events without embedding business rules in routes."""

    def __init__(self, connection):
        self.connection = connection

    def transaction(self):
        """Return a PostgreSQL transaction context for service-level atomic work."""

        return self.connection.transaction()

    def create_session(
        self,
        session_id: UUID,
        started_at: datetime,
        locale: str | None,
        platform: str | None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.sessions (session_id, started_at, last_seen_at, locale, platform)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING session_id, started_at, last_seen_at
            """,
            (session_id, started_at, started_at, locale, platform),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create interaction session")
        return dict(row)

    def get_session(self, session_id: UUID) -> dict | None:
        row = self.connection.execute(
            """
            SELECT session_id, started_at, last_seen_at, ended_at, locale, platform
            FROM interaction.sessions
            WHERE session_id = %s
            """,
            (session_id,),
        ).fetchone()
        return dict(row) if row else None

    def touch_session(self, session_id: UUID) -> None:
        result = self.connection.execute(
            """
            UPDATE interaction.sessions
            SET last_seen_at = CURRENT_TIMESTAMP
            WHERE session_id = %s AND ended_at IS NULL
            """,
            (session_id,),
        )
        if result.rowcount != 1:
            raise LookupError(f"Interaction session not found: {session_id}")

    def get_title(self, show_id: str) -> dict | None:
        row = self.connection.execute(
            """
            SELECT title_id, show_id, content_type, movie_duration_min, season_count
            FROM catalog.titles
            WHERE show_id = %s
            """,
            (show_id,),
        ).fetchone()
        return dict(row) if row else None

    def create_search_event(
        self,
        session_id: UUID,
        query_text: str,
        normalized_query: str,
        result_count: int,
        filters: dict[str, str],
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.search_events (
                session_id, query_text, normalized_query, result_count, filters
            )
            VALUES (%s, %s, %s, %s, %s)
            RETURNING search_event_id, session_id, query_text, normalized_query,
                      result_count, filters, occurred_at
            """,
            (session_id, query_text, normalized_query, result_count, Jsonb(filters)),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create search event")
        return dict(row)

    def create_watch_session(
        self,
        watch_session_id: UUID,
        session_id: UUID,
        title_id: int,
        watch_seconds: int,
        runtime_seconds: int | None,
        completion_rate: Decimal | None,
        duration_basis: str,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.watch_sessions (
                watch_session_id, session_id, title_id, watch_seconds,
                runtime_seconds, completion_rate, duration_basis
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING watch_session_id, session_id, title_id, watch_seconds,
                      runtime_seconds, completion_rate, duration_basis, recorded_at
            """,
            (
                watch_session_id,
                session_id,
                title_id,
                watch_seconds,
                runtime_seconds,
                completion_rate,
                duration_basis,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create watch session")
        return dict(row)

    def create_rating(
        self,
        session_id: UUID,
        title_id: int,
        rating: Decimal,
        watch_session_id: UUID | None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.ratings (
                session_id, watch_session_id, title_id, rating_value
            )
            VALUES (%s, %s, %s, %s)
            RETURNING rating_id, session_id, watch_session_id, title_id,
                      rating_value, rated_at
            """,
            (session_id, watch_session_id, title_id, rating),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create rating")
        return dict(row)

    def get_watch_session(self, watch_session_id: UUID) -> dict | None:
        """Return the ownership information for a linked watch event."""

        row = self.connection.execute(
            """
            SELECT watch_session_id, session_id, title_id
            FROM interaction.watch_sessions
            WHERE watch_session_id = %s
            """,
            (watch_session_id,),
        ).fetchone()
        return dict(row) if row else None

    def add_preference(self, table_name: str, session_id: UUID, title_id: int) -> dict:
        table = self._preference_table(table_name)
        id_column = "favorite_id" if table_name == "favorites" else "watchlist_item_id"
        row = self.connection.execute(
            f"""
            INSERT INTO interaction.{table} (session_id, title_id)
            VALUES (%s, %s)
            ON CONFLICT (session_id, title_id) WHERE removed_at IS NULL
            DO UPDATE SET removed_at = NULL, added_at = CURRENT_TIMESTAMP
            RETURNING session_id, title_id, added_at AS changed_at
            """,
            (session_id, title_id),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Could not add interaction {id_column}")
        return dict(row)

    def remove_preference(self, table_name: str, session_id: UUID, title_id: int) -> dict | None:
        table = self._preference_table(table_name)
        row = self.connection.execute(
            f"""
            UPDATE interaction.{table}
            SET removed_at = CURRENT_TIMESTAMP
            WHERE session_id = %s AND title_id = %s AND removed_at IS NULL
            RETURNING session_id, title_id, removed_at AS changed_at
            """,
            (session_id, title_id),
        ).fetchone()
        return dict(row) if row else None

    def interaction_state(self, session_id: UUID) -> dict[str, tuple[dict, ...]]:
        ratings = self.connection.execute(
            """
            SELECT DISTINCT ON (r.title_id)
                   t.show_id,
                   r.rating_value AS rating,
                   ws.watch_seconds,
                   r.rated_at
            FROM interaction.ratings r
            JOIN catalog.titles t ON t.title_id = r.title_id
            LEFT JOIN interaction.watch_sessions ws ON ws.watch_session_id = r.watch_session_id
            WHERE r.session_id = %s
            ORDER BY r.title_id, r.rated_at DESC, r.rating_id DESC
            """,
            (session_id,),
        ).fetchall()
        favorites = self._active_preferences("favorites", session_id)
        watchlist_items = self._active_preferences("watchlist_items", session_id)
        return {
            "ratings": tuple(dict(row) for row in ratings),
            "favorites": favorites,
            "watchlist_items": watchlist_items,
        }

    def _active_preferences(self, table_name: str, session_id: UUID) -> tuple[dict, ...]:
        table = self._preference_table(table_name)
        rows = self.connection.execute(
            f"""
            SELECT t.show_id, p.added_at AS changed_at
            FROM interaction.{table} p
            JOIN catalog.titles t ON t.title_id = p.title_id
            WHERE p.session_id = %s AND p.removed_at IS NULL
            ORDER BY p.added_at DESC, t.show_id
            """,
            (session_id,),
        ).fetchall()
        return tuple(dict(row) for row in rows)

    @staticmethod
    def _preference_table(table_name: str) -> str:
        allowed = {"favorites", "watchlist_items"}
        if table_name not in allowed:
            raise ValueError("Unsupported interaction preference table")
        return table_name
