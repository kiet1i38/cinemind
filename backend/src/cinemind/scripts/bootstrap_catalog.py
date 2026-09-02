"""Apply migrations and load the normalized catalog into PostgreSQL."""

from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid4, uuid5

from cinemind.catalog.loader import load_catalog
from cinemind.catalog.repository import CatalogRepository
from cinemind.config import Settings, get_settings
from cinemind.db.connection import connection_scope, wait_for_database
from cinemind.db.migrations import MigrationRunner
from cinemind.ops.models import DataQualityIssue, DatasetSource
from cinemind.ops.repository import OpsRepository


def bootstrap_catalog(settings: Settings) -> dict:
    """Migrate the database, load records and return an audit summary."""

    wait_for_database(settings)
    with connection_scope(settings) as connection:
        migration_result = MigrationRunner(
            connection, settings.migrations_path
        ).apply()
        load_result = load_catalog(settings.catalog_seed_path)
        checksum = file_checksum(settings.catalog_seed_path)
        source = build_source(settings, checksum)
        ops = OpsRepository(connection)

        with connection.transaction():
            source_id = ops.upsert_dataset_source(source)

        ingestion_run_id = uuid4()
        with connection.transaction():
            ops.create_ingestion_run(
                ingestion_run_id=ingestion_run_id,
                source_id=source_id,
                started_at=datetime.now(timezone.utc),
                rows_read=load_result.rows_read,
            )

        try:
            if not load_result.records:
                raise ValueError("Catalog contains no valid records")

            with connection.transaction():
                ops.record_quality_issues(
                    ingestion_run_id,
                    tuple(_to_quality_issue(issue) for issue in load_result.issues),
                )
                rows_loaded = CatalogRepository(connection).replace_catalog(
                    load_result.records, source_id
                )

            final_status = (
                "succeeded_with_warnings" if load_result.issues else "succeeded"
            )
            with connection.transaction():
                ops.finish_ingestion_run(
                    ingestion_run_id=ingestion_run_id,
                    status=final_status,
                    rows_loaded=rows_loaded,
                    finished_at=datetime.now(timezone.utc),
                )
        except Exception as error:
            with connection.transaction():
                ops.finish_ingestion_run(
                    ingestion_run_id=ingestion_run_id,
                    status="failed",
                    rows_loaded=0,
                    finished_at=datetime.now(timezone.utc),
                    error_message=str(error)[:2000],
                )
            raise

        summary = CatalogRepository(connection).summary()
        return {
            "migrations_applied": list(migration_result.applied_versions),
            "ingestion_run_id": str(ingestion_run_id),
            "rows_read": load_result.rows_read,
            "rows_loaded": len(load_result.records),
            "quality_issues": len(load_result.issues),
            "catalog_summary": summary,
        }


def build_source(settings: Settings, checksum: str) -> DatasetSource:
    """Build a deterministic source identity from configuration."""

    source_key = f"{settings.catalog_source_type}:{settings.catalog_source_uri}"
    return DatasetSource(
        source_id=uuid5(NAMESPACE_URL, source_key),
        source_name=settings.catalog_source_name,
        source_type=settings.catalog_source_type,
        source_uri=settings.catalog_source_uri,
        schema_version=settings.catalog_schema_version,
        collected_at=datetime.now(timezone.utc),
        checksum_sha256=checksum,
    )


def file_checksum(path: Path) -> str:
    """Calculate a streaming SHA-256 checksum."""

    digest = sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _to_quality_issue(issue) -> DataQualityIssue:
    """Map loader issues to the ops table contract."""

    return DataQualityIssue(
        table_name="catalog.titles",
        record_key=issue.record_key,
        issue_type=issue.issue_type,
        severity=issue.severity,
        details=issue.details,
    )


def main() -> None:
    """Run the bootstrap command and print a machine-readable summary."""

    try:
        result = bootstrap_catalog(get_settings())
    except Exception as error:
        print(f"Catalog bootstrap failed: {error}", file=sys.stderr)
        raise
    print(json.dumps(result, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
