"""Apply migrations and load the normalized catalog into PostgreSQL."""

from datetime import datetime, timezone
from contextlib import contextmanager
from hashlib import sha256
import json
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid4, uuid5

from cinemind.catalog.loader import load_catalog
from cinemind.catalog.models import CatalogLoadResult
from cinemind.catalog.repository import CatalogRepository
from cinemind.config import Settings, get_settings
from cinemind.db.connection import connection_scope, wait_for_database
from cinemind.db.migrations import MigrationRunner
from cinemind.ops.models import DataQualityIssue, DatasetSource
from cinemind.ops.repository import OpsRepository


def bootstrap_catalog(settings: Settings) -> dict:
    """Migrate the database, load records and return an audit summary."""

    wait_for_database(settings)
    with connection_scope(settings) as connection, _advisory_lock(connection):
        migration_result = MigrationRunner(
            connection, settings.migrations_path
        ).apply()
        load_error = None
        try:
            checksum = file_checksum(settings.catalog_seed_path)
            load_result = load_catalog(settings.catalog_seed_path)
        except Exception as error:
            # Register the source and a failed ingestion run even when the
            # seed is missing, unreadable, or malformed.  Startup diagnostics
            # must not disappear before the loader can produce a result.
            load_error = error
            checksum = ""
            load_result = CatalogLoadResult(records=(), issues=(), rows_read=0)
        source = build_source(settings, checksum)
        ops = OpsRepository(connection)
        catalog_repository = CatalogRepository(connection)

        with connection.transaction():
            source_id = ops.ensure_dataset_source(source)
            previous_checksum = ops.get_source_checksum(source_id)

        catalog_is_current = _catalog_matches_source(
            catalog_repository,
            load_result.records,
            source_id,
            checksum,
        )
        if load_error is None and previous_checksum == checksum and catalog_is_current:
            with connection.transaction():
                reconciled_runs = ops.reconcile_running_ingestion_runs(source_id)
            summary = CatalogRepository(connection).summary()
            return {
                "migrations_applied": list(migration_result.applied_versions),
                "ingestion_run_id": None,
                "rows_read": load_result.rows_read,
                "rows_loaded": 0,
                "quality_issues": 0,
                "reconciled_running_runs": reconciled_runs,
                "skipped_unchanged_source": True,
                "catalog_summary": summary,
            }

        ingestion_run_id = uuid4()
        with connection.transaction():
            ops.reconcile_running_ingestion_runs(source_id)
            ops.create_ingestion_run(
                ingestion_run_id=ingestion_run_id,
                source_id=source_id,
                started_at=datetime.now(timezone.utc),
                rows_read=load_result.rows_read,
            )

        try:
            # Commit audit issues independently of the catalog replacement so
            # an all-invalid seed still leaves a durable quality trail.
            with connection.transaction():
                ops.record_quality_issues(
                    ingestion_run_id,
                    tuple(_to_quality_issue(issue) for issue in load_result.issues),
                )
            if load_error is not None:
                raise load_error
            if not load_result.records:
                raise ValueError("Catalog contains no valid records")

            with connection.transaction():
                rows_loaded = catalog_repository.replace_catalog(
                    load_result.records, source_id, checksum
                )
                ops.mark_dataset_source_ingested(
                    source_id=source_id,
                    checksum=checksum,
                    collected_at=source.collected_at,
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
            "rows_loaded": rows_loaded,
            "quality_issues": len(load_result.issues),
            "catalog_summary": summary,
        }


def build_source(settings: Settings, checksum: str) -> DatasetSource:
    """Build a deterministic source identity from configuration."""

    # The database enforces uniqueness by name and type.  Derive the stable
    # UUID from the same identity so a URI change updates the existing source
    # row instead of creating a parallel, stale source identity.
    source_key = f"{settings.catalog_source_name.strip().casefold()}:{settings.catalog_source_type.strip().casefold()}"
    return DatasetSource(
        source_id=uuid5(NAMESPACE_URL, source_key),
        source_name=settings.catalog_source_name,
        source_type=settings.catalog_source_type,
        source_uri=settings.catalog_source_uri,
        schema_version=settings.catalog_schema_version,
        collected_at=datetime.now(timezone.utc),
        checksum_sha256=checksum,
    )


def _catalog_matches_source(repository, records, source_id, checksum: str) -> bool:
    """Run the integrity guard when the repository supports it.

    The fallback keeps lightweight repository doubles and older integrations
    compatible while production repositories enforce provenance and row-set
    checks before a checksum-only skip.
    """

    checker = getattr(repository, "matches_source", None)
    if checker is None:
        return True
    return bool(checker(records, source_id, checksum))


@contextmanager
def _advisory_lock(connection):
    """Serialize bootstrap/migration work across multiple backend workers."""

    lock_key = 271820260
    connection.execute("SELECT pg_advisory_lock(%s)", (lock_key,))
    try:
        yield
    finally:
        connection.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))


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
