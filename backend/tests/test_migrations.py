"""Regression tests for immutable migration checksums."""

from contextlib import nullcontext
from pathlib import Path
import tempfile
import unittest

from cinemind.db.migrations import MigrationDriftError, MigrationRunner, file_checksum


class _Result:
    def __init__(self, rows=(), rowcount=0):
        self.rows = list(rows)
        self.rowcount = rowcount

    def fetchall(self):
        return self.rows


class _FakeConnection:
    def __init__(self, applied=None):
        self.applied = dict(applied or {})
        self.statements = []

    def transaction(self):
        return nullcontext(self)

    def execute(self, statement, params=()):
        self.statements.append((statement, params))
        if "SELECT version, checksum_sha256" in statement:
            return _Result([
                {"version": version, "checksum_sha256": checksum}
                for version, checksum in self.applied.items()
            ])
        if "INSERT INTO ops.schema_migrations" in statement:
            self.applied[params[0]] = params[1]
        if "UPDATE ops.schema_migrations" in statement:
            self.applied[params[1]] = params[0]
        return _Result()


class MigrationChecksumTests(unittest.TestCase):
    def test_repository_manifest_contains_checksum_for_latest_migration(self):
        migrations_path = Path(__file__).parents[1] / "migrations"
        manifest = MigrationRunner(_FakeConnection(), migrations_path).expected_migrations()

        self.assertEqual(manifest[-1].version, "011_global_interaction_idempotency")
        self.assertTrue(all(len(item.checksum_sha256) == 64 for item in manifest))

    def test_missing_migration_is_applied_and_recorded_with_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "001_add_table.sql"
            path.write_text("CREATE TABLE example (id integer);", encoding="utf-8")
            checksum = file_checksum(path)
            connection = _FakeConnection()

            result = MigrationRunner(connection, Path(directory)).apply()

        self.assertEqual(result.applied_versions, ("001_add_table",))
        self.assertEqual(connection.applied["001_add_table"], checksum)

    def test_changed_applied_migration_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "001_add_table.sql"
            path.write_text("CREATE TABLE example (id integer);", encoding="utf-8")
            connection = _FakeConnection({"001_add_table": "0" * 64})

            with self.assertRaises(MigrationDriftError):
                MigrationRunner(connection, Path(directory)).apply()

    def test_legacy_null_checksum_is_backfilled_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "001_add_table.sql"
            path.write_text("CREATE TABLE example (id integer);", encoding="utf-8")
            checksum = file_checksum(path)
            connection = _FakeConnection({"001_add_table": None})

            result = MigrationRunner(connection, Path(directory)).apply()

        self.assertEqual(result.applied_versions, ())
        self.assertEqual(connection.applied["001_add_table"], checksum)


if __name__ == "__main__":
    unittest.main()
