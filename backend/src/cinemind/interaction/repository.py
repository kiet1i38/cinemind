"""Parameterized PostgreSQL repository for the interaction schema."""

from datetime import datetime
from decimal import Decimal
from typing import Iterator
from uuid import UUID

from psycopg.types.json import Jsonb

from cinemind.catalog.repository import CatalogRepository
from cinemind.db.locks import acquire_write_lock


class InteractionRepository:
    """Persist interaction events without embedding business rules in routes."""

    def __init__(self, connection):
        self.connection = connection

    def transaction(self):
        """Return a PostgreSQL transaction context for service-level atomic work."""

        return self.connection.transaction()

    def acquire_write_lock(self) -> None:
        """Serialize interaction writes with destructive maintenance."""

        acquire_write_lock(self.connection)

    def create_session(
        self,
        session_id: UUID,
        started_at: datetime,
        expires_at: datetime,
        locale: str | None,
        platform: str | None,
        user_id: UUID | None = None,
        session_token_hash: str | None = None,
    ) -> dict:
        row = self.connection.execute(
            """
            INSERT INTO interaction.sessions (
                session_id, started_at, last_seen_at, expires_at, locale, platform, user_id,
                session_token_hash
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING session_id, started_at, last_seen_at, expires_at
            """,
            (session_id, started_at, started_at, expires_at, locale, platform, user_id, session_token_hash),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not create interaction session")
        return dict(row)

    def get_session(self, session_id: UUID) -> dict | None:
        row = self.connection.execute(
            """
            SELECT session_id, started_at, last_seen_at, expires_at, ended_at, locale, platform,
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
            WHERE session_id = %s AND ended_at IS NULL AND expires_at > CURRENT_TIMESTAMP
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

    def count_catalog_results(self, normalized_query: str, filters: dict[str, str]) -> int:
        """Calculate search telemetry from the authoritative active catalog."""

        clauses = ["t.is_active = TRUE"]
        parameters: list = []
        if normalized_query:
            pattern = f"%{CatalogRepository._escape_like(normalized_query)}%"
            clauses.append(
                "("
                "t.title ILIKE %s ESCAPE '!' "
                "OR EXISTS (SELECT 1 FROM catalog.title_directors d "
                "WHERE d.title_id = t.title_id AND d.director_name ILIKE %s ESCAPE '!') "
                "OR EXISTS (SELECT 1 FROM catalog.title_cast c "
                "WHERE c.title_id = t.title_id AND c.person_name ILIKE %s ESCAPE '!') "
                "OR EXISTS (SELECT 1 FROM catalog.title_genres g "
                "WHERE g.title_id = t.title_id AND g.genre_name ILIKE %s ESCAPE '!')"
                ")"
            )
            parameters.extend((pattern, pattern, pattern, pattern))

        content_type = filters.get("type", "all")
        if content_type != "all":
            clauses.append("t.content_type = %s")
            parameters.append(content_type)

        genre = filters.get("genre", "all")
        if genre != "all":
            clauses.append(
                "EXISTS (SELECT 1 FROM catalog.title_genres gf "
                "WHERE gf.title_id = t.title_id AND gf.genre_name = %s)"
            )
            parameters.append(genre)

        year = filters.get("year", "all")
        if year == "2020s":
            clauses.append("t.release_year >= %s")
            parameters.append(2020)
        elif year == "2010s":
            clauses.append("t.release_year >= %s AND t.release_year < %s")
            parameters.extend((2010, 2020))
        elif year == "before2010":
            clauses.append("t.release_year < %s")
            parameters.append(2010)

        row = self.connection.execute(
            f"SELECT COUNT(*) AS total FROM catalog.titles t WHERE {' AND '.join(clauses)}",
            parameters,
        ).fetchone()
        return int(row["total"] if row else 0)

    def catalog_genre_exists(self, genre: str) -> bool:
        """Check that a submitted genre belongs to the active catalog."""

        row = self.connection.execute(
            """
            SELECT EXISTS(
                SELECT 1
                FROM catalog.title_genres g
                JOIN catalog.titles t ON t.title_id = g.title_id
                WHERE g.genre_name = %s AND t.is_active = TRUE
            ) AS available
            """,
            (genre,),
        ).fetchone()
        return bool(row and row["available"])

    def create_search_event(
        self,
        session_id: UUID,
        query_text: str,
        normalized_query: str,
        result_count: int,
        filters: dict[str, str],
        client_mutation_id: UUID | None = None,
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        if client_mutation_id is not None:
            existing = self.connection.execute(
                """
                SELECT search_event_id, session_id, query_text, normalized_query,
                       result_count, filters, occurred_at, client_occurred_at,
                       client_device_id, client_event_sequence
                FROM interaction.search_events
                WHERE client_mutation_id = %s
                ORDER BY search_event_id ASC
                LIMIT 1
                """,
                (client_mutation_id,),
            ).fetchone()
            if existing is not None:
                return dict(existing)
        if client_mutation_id is None:
            row = self.connection.execute(
                """
                INSERT INTO interaction.search_events (
                    session_id, query_text, normalized_query, result_count, filters,
                    client_occurred_at, client_device_id, client_event_sequence
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING search_event_id, session_id, query_text, normalized_query,
                          result_count, filters, occurred_at, client_occurred_at,
                          client_device_id, client_event_sequence
                """,
                (
                    session_id,
                    query_text,
                    normalized_query,
                    result_count,
                    Jsonb(filters),
                    client_occurred_at,
                    client_device_id,
                    client_event_sequence,
                ),
            ).fetchone()
        else:
            row = self.connection.execute(
                """
                INSERT INTO interaction.search_events (
                    session_id, query_text, normalized_query, result_count, filters,
                    client_occurred_at, client_mutation_id, client_device_id,
                    client_event_sequence
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (client_mutation_id)
                    WHERE client_mutation_id IS NOT NULL DO NOTHING
                    RETURNING search_event_id, session_id, query_text, normalized_query,
                          result_count, filters, occurred_at, client_occurred_at,
                          client_device_id, client_event_sequence
                """,
                (
                    session_id,
                    query_text,
                    normalized_query,
                    result_count,
                    Jsonb(filters),
                    client_occurred_at,
                    client_mutation_id,
                    client_device_id,
                    client_event_sequence,
                ),
            ).fetchone()
            if row is None:
                row = self.connection.execute(
                    """
                    SELECT search_event_id, session_id, query_text, normalized_query,
                           result_count, filters, occurred_at, client_occurred_at,
                           client_device_id, client_event_sequence
                    FROM interaction.search_events
                    WHERE client_mutation_id = %s
                    ORDER BY search_event_id ASC
                    LIMIT 1
                    """,
                    (client_mutation_id,),
                ).fetchone()
        if row is None:
            raise RuntimeError("Could not create search event")
        return dict(row)

    def get_search_event_by_mutation(self, client_mutation_id: UUID) -> dict | None:
        """Find an acknowledged search event before consulting current catalog data."""

        row = self.connection.execute(
            """
            SELECT search_event_id, session_id, query_text, normalized_query,
                   result_count, filters, occurred_at, client_occurred_at,
                   client_device_id, client_event_sequence
            FROM interaction.search_events
            WHERE client_mutation_id = %s
            ORDER BY search_event_id ASC
            LIMIT 1
            """,
            (client_mutation_id,),
        ).fetchone()
        return dict(row) if row else None

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
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
        is_repair: bool = False,
        repair_source_watch_session_id: UUID | None = None,
    ) -> dict:
        if client_mutation_id is not None:
            existing = self.connection.execute(
                """
                SELECT watch_session_id, session_id, title_id, watch_seconds,
                       runtime_seconds, completion_rate, duration_basis, recorded_at,
                       client_occurred_at, client_device_id, client_event_sequence,
                       is_repair, repair_source_watch_session_id
                FROM interaction.watch_sessions
                WHERE client_mutation_id = %s
                ORDER BY recorded_at ASC, watch_session_id ASC
                LIMIT 1
                """,
                (client_mutation_id,),
            ).fetchone()
            if existing is not None:
                return dict(existing)
        row = self.connection.execute(
            """
            INSERT INTO interaction.watch_sessions (
                watch_session_id, session_id, title_id, watch_seconds,
                runtime_seconds, completion_rate, duration_basis,
                client_occurred_at, client_mutation_id, client_device_id,
                client_event_sequence, is_repair, repair_source_watch_session_id
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (client_mutation_id)
                WHERE client_mutation_id IS NOT NULL DO NOTHING
            RETURNING watch_session_id, session_id, title_id, watch_seconds,
                      runtime_seconds, completion_rate, duration_basis, recorded_at,
                      client_occurred_at, client_device_id, client_event_sequence,
                      is_repair, repair_source_watch_session_id
            """,
            (
                watch_session_id,
                session_id,
                title_id,
                watch_seconds,
                runtime_seconds,
                completion_rate,
                duration_basis,
                client_occurred_at,
                client_mutation_id,
                client_device_id,
                client_event_sequence,
                is_repair,
                repair_source_watch_session_id,
            ),
        ).fetchone()
        if row is None and client_mutation_id is not None:
            row = self.connection.execute(
                """
                SELECT watch_session_id, session_id, title_id, watch_seconds,
                       runtime_seconds, completion_rate, duration_basis, recorded_at,
                       client_occurred_at, client_device_id, client_event_sequence,
                       is_repair, repair_source_watch_session_id
                FROM interaction.watch_sessions
                WHERE client_mutation_id = %s
                ORDER BY recorded_at ASC, watch_session_id ASC
                LIMIT 1
                """,
                (client_mutation_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Could not create watch session")
        return dict(row)

    def get_watch_session_by_mutation(self, client_mutation_id: UUID) -> dict | None:
        """Find an acknowledged watch event even when its title is inactive."""

        row = self.connection.execute(
            """
            SELECT ws.watch_session_id, ws.session_id, ws.title_id,
                   t.show_id, ws.watch_seconds, ws.runtime_seconds,
                   ws.completion_rate, ws.duration_basis, ws.recorded_at,
                   ws.client_occurred_at, ws.client_device_id,
                   ws.client_event_sequence
            FROM interaction.watch_sessions ws
            LEFT JOIN catalog.titles t ON t.title_id = ws.title_id
            WHERE ws.client_mutation_id = %s
            ORDER BY ws.recorded_at ASC, ws.watch_session_id ASC
            LIMIT 1
            """,
            (client_mutation_id,),
        ).fetchone()
        return dict(row) if row else None

    def create_rating(
        self,
        session_id: UUID,
        title_id: int,
        rating: Decimal,
        watch_session_id: UUID | None,
        client_mutation_id: UUID | None = None,
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        if client_mutation_id is not None:
            existing = self.connection.execute(
                """
                SELECT rating_id, session_id, watch_session_id, title_id,
                       rating_value, rated_at, client_occurred_at,
                       client_device_id, client_event_sequence
                FROM interaction.ratings
                WHERE client_mutation_id = %s
                ORDER BY rating_id ASC
                LIMIT 1
                """,
                (client_mutation_id,),
            ).fetchone()
            if existing is not None:
                return dict(existing)
        row = self.connection.execute(
            """
            INSERT INTO interaction.ratings (
                session_id, watch_session_id, title_id, rating_value,
                client_occurred_at, client_mutation_id, client_device_id,
                client_event_sequence
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (client_mutation_id)
                WHERE client_mutation_id IS NOT NULL DO NOTHING
            RETURNING rating_id, session_id, watch_session_id, title_id,
                      rating_value, rated_at, client_occurred_at
                      , client_device_id, client_event_sequence
            """,
            (
                session_id,
                watch_session_id,
                title_id,
                rating,
                client_occurred_at,
                client_mutation_id,
                client_device_id,
                client_event_sequence,
            ),
        ).fetchone()
        if row is None and client_mutation_id is not None:
            row = self.connection.execute(
                """
                SELECT rating_id, session_id, watch_session_id, title_id,
                       rating_value, rated_at, client_occurred_at,
                       client_device_id, client_event_sequence
                FROM interaction.ratings
                WHERE client_mutation_id = %s
                ORDER BY rating_id ASC
                LIMIT 1
                """,
                (client_mutation_id,),
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

    def get_rating_by_mutation(self, client_mutation_id: UUID) -> dict | None:
        """Find an acknowledged rating before validating a rotated session link."""

        row = self.connection.execute(
            """
            SELECT r.rating_id, r.session_id, r.watch_session_id, r.title_id,
                   t.show_id,
                   r.rating_value, r.rated_at, r.client_occurred_at,
                   r.client_device_id, r.client_event_sequence
            FROM interaction.ratings r
            LEFT JOIN catalog.titles t ON t.title_id = r.title_id
            WHERE r.client_mutation_id = %s
            ORDER BY r.rating_id ASC
            LIMIT 1
            """,
            (client_mutation_id,),
        ).fetchone()
        return dict(row) if row else None

    def attach_rating_watch_session(
        self,
        rating_id: int,
        watch_session_id: UUID,
        session_id: UUID,
        title_id: int,
    ) -> dict | None:
        """Link a repaired watch to one historical rating without moving scope."""

        row = self.connection.execute(
            """
            UPDATE interaction.ratings
            SET watch_session_id = %s
            WHERE rating_id = %s
              AND session_id = %s
              AND title_id = %s
              AND watch_session_id IS NULL
            RETURNING rating_id, session_id, watch_session_id, title_id,
                      rating_value, rated_at, client_occurred_at,
                      client_device_id, client_event_sequence
            """,
            (watch_session_id, rating_id, session_id, title_id),
        ).fetchone()
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
            WITH device_latest AS (
                SELECT
                   r.rating_id,
                   r.title_id,
                   r.rating_value,
                   r.rated_at,
                   r.client_occurred_at,
                   r.client_device_id,
                   r.client_event_sequence,
                   r.watch_session_id,
                   ws.watch_seconds,
                   t.show_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY r.title_id, COALESCE(r.client_device_id, r.session_id)
                           ORDER BY
                               r.client_event_sequence DESC NULLS LAST,
                               r.rated_at DESC,
                               r.rating_id DESC
                       ) AS device_rank
                FROM interaction.ratings r
                JOIN interaction.sessions s ON s.session_id = r.session_id
                JOIN catalog.titles t ON t.title_id = r.title_id AND t.is_active = TRUE
                LEFT JOIN interaction.watch_sessions ws ON ws.watch_session_id = r.watch_session_id
                WHERE {session_clause}
            )
            SELECT DISTINCT ON (title_id)
                   show_id,
                   rating_value AS rating,
                   watch_seconds,
                   rated_at,
                   rated_at AS event_at,
                   client_occurred_at,
                   client_device_id,
                   client_event_sequence
            FROM device_latest
            WHERE device_rank = 1
            ORDER BY title_id, rated_at DESC, rating_id DESC
            """,
            (session_parameter,),
        ).fetchall()
        return {"ratings": tuple(dict(row) for row in ratings)}
