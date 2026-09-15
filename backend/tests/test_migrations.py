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

        self.assertEqual(manifest[-1].version, "014_mark_rating_watch_repairs")
        self.assertTrue(all(len(item.checksum_sha256) == 64 for item in manifest))

    def test_global_idempotency_repair_deduplicates_before_unique_indexes(self):
        migration = (Path(__file__).parents[1] / "migrations" / "012_repair_global_interaction_idempotency.sql").read_text(encoding="utf-8")

        self.assertLess(migration.index("DELETE FROM interaction.search_events"), migration.index("CREATE UNIQUE INDEX"))
        self.assertIn("DELETE FROM interaction.ratings", migration)
        self.assertIn("UPDATE interaction.ratings AS rating", migration)
        self.assertIn("DELETE FROM interaction.watch_sessions", migration)
        self.assertIn("search_events_mutation_global_uidx", migration)
        self.assertIn("watch_sessions_mutation_global_uidx", migration)
        self.assertIn("ratings_mutation_global_uidx", migration)

    def test_rating_watch_repair_preserves_cross_scope_signal_metrics(self):
        migration = (Path(__file__).parents[1] / "migrations" / "013_repair_rating_watch_links.sql").read_text(encoding="utf-8")

        self.assertIn("interaction_rating_watch_repairs", migration)
        self.assertIn("client_mutation_id", migration)
        self.assertIn("watch_session_id = repair.repaired_watch_session_id", migration)
        self.assertIn("client_mutation_id,", migration)

    def test_rating_watch_repairs_are_excluded_from_mining_projection(self):
        migration = (Path(__file__).parents[1] / "migrations" / "014_mark_rating_watch_repairs.sql").read_text(encoding="utf-8")

        self.assertIn("is_repair BOOLEAN NOT NULL DEFAULT FALSE", migration)
        self.assertIn("repair_source_watch_session_id UUID", migration)
        self.assertIn("watch_sessions_repair_source_fk", migration)
        self.assertIn("watch_sessions_for_mining", migration)
        self.assertIn("WHERE is_repair = FALSE", migration)
        self.assertIn("rating-watch-repair:", migration)

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
