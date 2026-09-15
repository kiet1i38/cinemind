"""Allow-listed PostgreSQL operations for the protected reset service."""

from uuid import UUID

from cinemind.db.locks import acquire_maintenance_lock


_SESSION_TABLES = (
    "interaction.ratings",
    "interaction.watch_sessions",
    "interaction.search_events",
    "interaction.sessions",
)

_AUTH_TABLES = (
    "auth.sessions",
    "auth.users",
)


class ResetRepository:
    """Delete only known application tables using parameterized predicates."""

    def __init__(self, connection):
        self.connection = connection

    def transaction(self):
        """Return the connection transaction context."""

        return self.connection.transaction()

    def acquire_write_lock(self) -> None:
        """Serialize reset deletes with every application write."""

        acquire_maintenance_lock(self.connection)

    def delete_session_interactions(self, session_id: UUID) -> dict[str, int]:
        """Delete all interaction rows belonging to one anonymous session."""

        # Migration 013 created repair watch rows in the rating's session
        # scope. Remove those rows before deleting the source watch rows; the
        # ratings remain in their own session but lose the derived watch link.
        # This keeps RESET CURRENT SESSION from leaving source-session metrics
        # behind in another session.
        self.connection.execute(
            """
            UPDATE interaction.ratings AS rating
            SET watch_session_id = NULL
            WHERE rating.watch_session_id IN (
                SELECT repair.watch_session_id
                FROM interaction.watch_sessions AS repair
                JOIN interaction.watch_sessions AS source
                  ON source.watch_session_id = repair.repair_source_watch_session_id
                WHERE repair.is_repair = TRUE
                  AND source.session_id = %s
            )
            """,
            (session_id,),
        )
        repair_result = self.connection.execute(
            """
            DELETE FROM interaction.watch_sessions AS repair
            USING interaction.watch_sessions AS source
            WHERE repair.is_repair = TRUE
              AND repair.repair_source_watch_session_id = source.watch_session_id
              AND source.session_id = %s
            """,
            (session_id,),
        )
        deleted = self._delete_tables(_SESSION_TABLES, "WHERE session_id = %s", (session_id,))
        deleted["interaction.watch_sessions"] += int(repair_result.rowcount)
        return deleted

    def delete_all_interactions(self) -> dict[str, int]:
        """Delete all current interaction rows while preserving the catalog."""

        return self._delete_tables(_SESSION_TABLES)

    def delete_all_user_data(self) -> dict[str, int]:
        """Delete every account and interaction row while preserving catalog and ops."""

        deleted = self._delete_tables(_AUTH_TABLES)
        deleted.update(self.delete_all_interactions())
        return deleted

    def _delete_tables(
        self,
        table_names: tuple[str, ...],
        predicate: str = "",
        parameters: tuple = (),
    ) -> dict[str, int]:
        deleted: dict[str, int] = {}
        for table_name in table_names:
            result = self.connection.execute(
                f"DELETE FROM {table_name} {predicate}",
                parameters,
            )
            deleted[table_name] = int(result.rowcount)
        return deleted
