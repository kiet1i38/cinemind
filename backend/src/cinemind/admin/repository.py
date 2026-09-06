"""Allow-listed PostgreSQL operations for the protected reset service."""

from uuid import UUID


_SESSION_TABLES = (
    "interaction.ratings",
    "interaction.watch_sessions",
    "interaction.favorites",
    "interaction.watchlist_items",
    "interaction.search_events",
    "interaction.sessions",
)

_CATALOG_TABLES = (
    "catalog.title_genres",
    "catalog.title_cast",
    "catalog.title_countries",
    "catalog.title_directors",
    "catalog.titles",
)

_OPS_TABLES = (
    "ops.data_quality_issues",
    "ops.ingestion_runs",
    "ops.dataset_sources",
    "ops.schema_migrations",
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

    def delete_session_interactions(self, session_id: UUID) -> dict[str, int]:
        """Delete all interaction rows belonging to one anonymous session."""

        return self._delete_tables(_SESSION_TABLES, "WHERE session_id = %s", (session_id,))

    def delete_all_interactions(self) -> dict[str, int]:
        """Delete all current interaction rows while preserving the catalog."""

        return self._delete_tables(_SESSION_TABLES)

    def delete_all_application_data(self) -> dict[str, int]:
        """Delete all rows that can be rebuilt by the catalog bootstrap."""

        deleted = self._delete_tables(_AUTH_TABLES)
        deleted.update(self.delete_all_interactions())
        deleted.update(self._delete_tables(_CATALOG_TABLES))
        deleted.update(self._delete_tables(_OPS_TABLES))
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
