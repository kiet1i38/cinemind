"""Persistence operations for the ops schema."""

from datetime import datetime
from uuid import UUID

from psycopg.types.json import Jsonb

from cinemind.ops.models import DataQualityIssue, DatasetSource


class OpsRepository:
    """Write audit records for source registration and ingestion."""

    def __init__(self, connection):
        self.connection = connection

    def upsert_dataset_source(self, source: DatasetSource) -> UUID:
        """Create or refresh a source definition and return its stable ID."""

        row = self.connection.execute(
            """
            INSERT INTO ops.dataset_sources (
                source_id,
                source_name,
                source_type,
                source_uri,
                schema_version,
                collected_at,
                checksum_sha256
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source_name, source_type)
            DO UPDATE SET
                source_uri = EXCLUDED.source_uri,
                schema_version = EXCLUDED.schema_version,
                collected_at = EXCLUDED.collected_at,
                checksum_sha256 = EXCLUDED.checksum_sha256,
                is_active = TRUE,
                updated_at = CURRENT_TIMESTAMP
            RETURNING source_id
            """,
            (
                source.source_id,
                source.source_name,
                source.source_type,
                source.source_uri,
                source.schema_version,
                source.collected_at,
                source.checksum_sha256,
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("Could not register dataset source")
        return UUID(str(row["source_id"]))

    def create_ingestion_run(
        self,
        ingestion_run_id: UUID,
        source_id: UUID,
        started_at: datetime,
        rows_read: int,
    ) -> None:
        """Create an ingestion run in the running state."""

        self.connection.execute(
            """
            INSERT INTO ops.ingestion_runs (
                ingestion_run_id,
                source_id,
                started_at,
                status,
                rows_read
            )
            VALUES (%s, %s, %s, 'running', %s)
            """,
            (ingestion_run_id, source_id, started_at, rows_read),
        )

    def record_quality_issues(
        self,
        ingestion_run_id: UUID,
        issues: tuple[DataQualityIssue, ...],
    ) -> None:
        """Persist all issues found for an ingestion run."""

        if not issues:
            return

        values = [
            (
                ingestion_run_id,
                issue.table_name,
                issue.record_key,
                issue.issue_type,
                issue.severity,
                Jsonb(issue.details),
            )
            for issue in issues
        ]
        with self.connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO ops.data_quality_issues (
                    ingestion_run_id,
                    table_name,
                    record_key,
                    issue_type,
                    severity,
                    details
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                values,
            )

    def finish_ingestion_run(
        self,
        ingestion_run_id: UUID,
        status: str,
        rows_loaded: int,
        finished_at: datetime,
        error_message: str | None = None,
    ) -> None:
        """Complete an ingestion run with its final audit state."""

        result = self.connection.execute(
            """
            UPDATE ops.ingestion_runs
            SET status = %s,
                rows_loaded = %s,
                finished_at = %s,
                error_message = %s
            WHERE ingestion_run_id = %s
            """,
            (status, rows_loaded, finished_at, error_message, ingestion_run_id),
        )
        if result.rowcount != 1:
            raise RuntimeError(f"Ingestion run not found: {ingestion_run_id}")
