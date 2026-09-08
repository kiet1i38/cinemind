"""Regression tests for transactional catalog bootstrap behavior."""

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import unittest

from cinemind.scripts import bootstrap_catalog


class _FakeConnection:
    def transaction(self):
        return nullcontext(self)


class _FakeOpsRepository:
    def __init__(self, source_id):
        self.source_id = source_id
        self.checksum = "old-checksum"
        self.marked_checksums = []
        self.finished_statuses = []

    def get_source_checksum(self, _source_id):
        return self.checksum

    def ensure_dataset_source(self, _source):
        return self.source_id

    def reconcile_running_ingestion_runs(self, _source_id):
        return 0

    def create_ingestion_run(self, **_kwargs):
        return None

    def record_quality_issues(self, *_args):
        return None

    def mark_dataset_source_ingested(self, source_id, checksum, collected_at):
        self.marked_checksums.append((source_id, checksum, collected_at))
        self.checksum = checksum

    def finish_ingestion_run(self, *, status, **_kwargs):
        self.finished_statuses.append(status)


class _FakeCatalogRepository:
    def __init__(self, _connection, state):
        self.state = state

    def replace_catalog(self, records, _source_id, _checksum):
        self.state["replace_calls"] += 1
        if self.state["fail_next_replace"]:
            self.state["fail_next_replace"] = False
            raise RuntimeError("simulated catalog replacement failure")
        return len(records)

    def summary(self):
        return {"titles": 1}


class BootstrapCatalogTests(unittest.TestCase):
    def test_failed_replacement_does_not_publish_checksum_and_retries_next_run(self):
        source_id = uuid4()
        ops = _FakeOpsRepository(source_id)
        catalog_state = {"fail_next_replace": True, "replace_calls": 0}
        settings = SimpleNamespace(
            migrations_path=Path("migrations"),
            catalog_seed_path=Path("catalog.json"),
            catalog_source_name="Netflix catalog",
            catalog_source_type="seed",
            catalog_source_uri="catalog.json",
            catalog_schema_version="v1",
        )
        load_result = SimpleNamespace(
            records=[object()],
            issues=(),
            rows_read=1,
        )

        with (
            patch.object(bootstrap_catalog, "wait_for_database"),
            patch.object(bootstrap_catalog, "connection_scope", return_value=nullcontext(_FakeConnection())),
            patch.object(bootstrap_catalog, "_advisory_lock", return_value=nullcontext()),
            patch.object(bootstrap_catalog, "MigrationRunner") as migration_runner,
            patch.object(bootstrap_catalog, "load_catalog", return_value=load_result),
            patch.object(bootstrap_catalog, "file_checksum", return_value="new-checksum"),
            patch.object(bootstrap_catalog, "OpsRepository", return_value=ops),
            patch.object(
                bootstrap_catalog,
                "CatalogRepository",
                side_effect=lambda connection: _FakeCatalogRepository(connection, catalog_state),
            ),
        ):
            migration_runner.return_value.apply.return_value = SimpleNamespace(applied_versions=())

            with self.assertRaisesRegex(RuntimeError, "simulated catalog replacement failure"):
                bootstrap_catalog.bootstrap_catalog(settings)

            self.assertEqual(ops.marked_checksums, [])
            self.assertEqual(ops.checksum, "old-checksum")
            self.assertEqual(ops.finished_statuses[-1], "failed")

            result = bootstrap_catalog.bootstrap_catalog(settings)

        self.assertEqual(catalog_state["replace_calls"], 2)
        self.assertEqual(len(ops.marked_checksums), 1)
        self.assertEqual(ops.checksum, "new-checksum")
        self.assertEqual(result["rows_loaded"], 1)
        self.assertIsNotNone(result["ingestion_run_id"])


if __name__ == "__main__":
    unittest.main()
