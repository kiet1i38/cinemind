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
        user_id: UUID | None = None,
        session_token_hash: str | None = None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.sessions (
                session_id, started_at, last_seen_at, locale, platform, user_id,
                session_token_hash
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING session_id, started_at, last_seen_at
            """,
            (session_id, started_at, started_at, locale, platform, user_id, session_token_hash),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create interaction session")
        return dict(row)

    def get_session(self, session_id: UUID) -> dict | None:
        row = self.connection.execute(
            """
            SELECT session_id, started_at, last_seen_at, ended_at, locale, platform,
                   user_id, session_token_hash
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
            WHERE show_id = %s AND is_active = TRUE
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
        client_mutation_id: UUID | None = None,
    ) -> dict:
        if client_mutation_id is None:
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
        else:
            row = self.connection.execute(
                """
                INSERT INTO interaction.search_events (
                    session_id, query_text, normalized_query, result_count, filters,
                    client_mutation_id
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (session_id, client_mutation_id)
                    WHERE client_mutation_id IS NOT NULL DO NOTHING
                RETURNING search_event_id, session_id, query_text, normalized_query,
                          result_count, filters, occurred_at
                """,
                (session_id, query_text, normalized_query, result_count, Jsonb(filters), client_mutation_id),
            ).fetchone()
            if row is None:
                row = self.connection.execute(
                    """
                    SELECT search_event_id, session_id, query_text, normalized_query,
                           result_count, filters, occurred_at
                    FROM interaction.search_events
                    WHERE session_id = %s AND client_mutation_id = %s
                    """,
                    (session_id, client_mutation_id),
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
        client_mutation_id: UUID | None = None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.watch_sessions (
                watch_session_id, session_id, title_id, watch_seconds,
                runtime_seconds, completion_rate, duration_basis, client_mutation_id
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (session_id, client_mutation_id)
                WHERE client_mutation_id IS NOT NULL DO NOTHING
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
                client_mutation_id,
            ),
        ).fetchone()
        if row is None and client_mutation_id is not None:
            row = self.connection.execute(
                """
                SELECT watch_session_id, session_id, title_id, watch_seconds,
                       runtime_seconds, completion_rate, duration_basis, recorded_at
                FROM interaction.watch_sessions
                WHERE session_id = %s AND client_mutation_id = %s
                """,
                (session_id, client_mutation_id),
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
        client_mutation_id: UUID | None = None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.ratings (
                session_id, watch_session_id, title_id, rating_value, client_mutation_id
            )
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (session_id, client_mutation_id)
                WHERE client_mutation_id IS NOT NULL DO NOTHING
            RETURNING rating_id, session_id, watch_session_id, title_id,
                      rating_value, rated_at
            """,
            (session_id, watch_session_id, title_id, rating, client_mutation_id),
        ).fetchone()
        if row is None and client_mutation_id is not None:
            row = self.connection.execute(
                """
                SELECT rating_id, session_id, watch_session_id, title_id,
                       rating_value, rated_at
                FROM interaction.ratings
                WHERE session_id = %s AND client_mutation_id = %s
                """,
                (session_id, client_mutation_id),
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

    def add_preference(
        self,
        table_name: str,
        session_id: UUID,
        title_id: int,
        user_id: UUID | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        table = self._preference_table(table_name)
        id_column = "favorite_id" if table_name == "favorites" else "watchlist_item_id"
        if client_mutation_id is not None:
            existing = self.connection.execute(
                f"""
                SELECT session_id, title_id, added_at AS changed_at, removed_at
                FROM interaction.{table}
                WHERE session_id = %s AND client_mutation_id = %s
                """,
                (session_id, client_mutation_id),
            ).fetchone()
            if existing is not None:
                return dict(existing)

        scope_clause = "s.user_id = %s" if user_id is not None else "p.session_id = %s"
        scope_values = (user_id,) if user_id is not None else (session_id,)
        self.connection.execute(
            f"""
            UPDATE interaction.{table} AS p
            SET removed_at = CURRENT_TIMESTAMP
            FROM interaction.sessions AS s
            WHERE p.session_id = s.session_id
              AND p.title_id = %s
              AND p.removed_at IS NULL
              AND {scope_clause}
            """,
            (title_id, *scope_values),
        )
        row = self.connection.execute(
            f"""
            INSERT INTO interaction.{table} (session_id, title_id, client_mutation_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (session_id, title_id) WHERE removed_at IS NULL
            DO UPDATE SET removed_at = NULL,
                          added_at = CURRENT_TIMESTAMP,
                          client_mutation_id = EXCLUDED.client_mutation_id
            RETURNING session_id, title_id, added_at AS changed_at
            """,
            (session_id, title_id, client_mutation_id),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Could not add interaction {id_column}")
        return dict(row)

    def remove_preference(
        self,
        table_name: str,
        session_id: UUID,
        title_id: int,
        user_id: UUID | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict | None:
        table = self._preference_table(table_name)
        if client_mutation_id is not None:
            existing = self.connection.execute(
                f"""
                SELECT session_id, title_id, removed_at AS changed_at
                FROM interaction.{table}
                WHERE session_id = %s AND client_mutation_id = %s
                """,
                (session_id, client_mutation_id),
            ).fetchone()
            if existing is not None:
                return dict(existing)

        scope_clause = "s.user_id = %s" if user_id is not None else "p.session_id = %s"
        scope_values = (user_id,) if user_id is not None else (session_id,)
        rows = self.connection.execute(
            f"""
            UPDATE interaction.{table} AS p
            SET removed_at = CURRENT_TIMESTAMP
            FROM interaction.sessions AS s
            WHERE p.session_id = s.session_id
              AND p.title_id = %s AND p.removed_at IS NULL
              AND {scope_clause}
            RETURNING p.session_id, p.title_id, p.removed_at AS changed_at
            """,
            (title_id, *scope_values),
        ).fetchall()
        row = next((candidate for candidate in rows if candidate["session_id"] == session_id), None)
        if row is None and rows:
            row = rows[0]
        if client_mutation_id is not None:
            # Keep the original add mutation attached to the historical row
            # and record this removal as a separate tombstone.  Overwriting
            # the add ID made a delayed add replay resurrect a preference.
            tombstone = self.connection.execute(
                f"""
                INSERT INTO interaction.{table} (
                    session_id, title_id, removed_at, client_mutation_id
                )
                VALUES (%s, %s, CURRENT_TIMESTAMP, %s)
                ON CONFLICT (session_id, client_mutation_id)
                    WHERE client_mutation_id IS NOT NULL DO NOTHING
                RETURNING session_id, title_id, removed_at AS changed_at
                """,
                (session_id, title_id, client_mutation_id),
            ).fetchone()
            if tombstone is not None:
                row = tombstone
        elif row is None:
            return None
        return dict(row) if row else None

    def interaction_state(
        self,
        session_id: UUID,
        user_id: UUID | None = None,
    ) -> dict[str, tuple[dict, ...]]:
        session_clause = "s.user_id = %s" if user_id is not None else "s.session_id = %s"
        session_parameter = user_id if user_id is not None else session_id
        ratings = self.connection.execute(
            f"""
            SELECT DISTINCT ON (r.title_id)
                   t.show_id,
                   r.rating_value AS rating,
                   ws.watch_seconds,
                   r.rated_at
            FROM interaction.ratings r
            JOIN interaction.sessions s ON s.session_id = r.session_id
            JOIN catalog.titles t ON t.title_id = r.title_id AND t.is_active = TRUE
            LEFT JOIN interaction.watch_sessions ws ON ws.watch_session_id = r.watch_session_id
            WHERE {session_clause}
            ORDER BY r.title_id, r.rated_at DESC, r.rating_id DESC
            """,
            (session_parameter,),
        ).fetchall()
        favorites = self._active_preferences("favorites", session_id, user_id)
        watchlist_items = self._active_preferences("watchlist_items", session_id, user_id)
        return {
            "ratings": tuple(dict(row) for row in ratings),
            "favorites": favorites,
            "watchlist_items": watchlist_items,
        }

    def _active_preferences(
        self,
        table_name: str,
        session_id: UUID,
        user_id: UUID | None = None,
    ) -> tuple[dict, ...]:
        table = self._preference_table(table_name)
        id_column = "favorite_id" if table_name == "favorites" else "watchlist_item_id"
        session_clause = "s.user_id = %s" if user_id is not None else "s.session_id = %s"
        session_parameter = user_id if user_id is not None else session_id
        rows = self.connection.execute(
            f"""
            WITH latest AS (
                SELECT DISTINCT ON (p.title_id)
                       p.title_id, p.added_at, p.removed_at
                FROM interaction.{table} p
                JOIN interaction.sessions s ON s.session_id = p.session_id
                WHERE {session_clause}
                ORDER BY p.title_id, p.added_at DESC, p.{id_column} DESC
            )
            SELECT t.show_id, latest.added_at AS changed_at
            FROM latest
            JOIN catalog.titles t ON t.title_id = latest.title_id
            WHERE latest.removed_at IS NULL AND t.is_active = TRUE
            ORDER BY latest.added_at DESC, t.show_id
            """,
            (session_parameter,),
        ).fetchall()
        return tuple(dict(row) for row in rows)

    @staticmethod
    def _preference_table(table_name: str) -> str:
        allowed = {"favorites", "watchlist_items"}
        if table_name not in allowed:
            raise ValueError("Unsupported interaction preference table")
        return table_name
