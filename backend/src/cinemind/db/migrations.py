"""Ordered, idempotent SQL migration runner."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MigrationResult:
    """Result of applying migrations."""

    applied_versions: tuple[str, ...]


class MigrationRunner:
    """Apply SQL files once and record their versions in PostgreSQL."""

    def __init__(self, connection, migrations_path: Path):
        self.connection = connection
        self.migrations_path = migrations_path

    def apply(self) -> MigrationResult:
        """Apply missing migrations in filename order."""

        self._ensure_migration_table()
        applied = self._applied_versions()
        applied_now: list[str] = []

        for migration_path in self._migration_files():
            version = migration_path.stem
            if version in applied:
                continue

            sql = migration_path.read_text(encoding="utf-8")
            with self.connection.transaction():
                self.connection.execute(sql)
                self.connection.execute(
                    "INSERT INTO ops.schema_migrations (version) VALUES (%s)",
                    (version,),
                )
            applied_now.append(version)

        return MigrationResult(applied_versions=tuple(applied_now))

    def _migration_files(self) -> list[Path]:
        if not self.migrations_path.is_dir():
            raise FileNotFoundError(
                f"Migration directory does not exist: {self.migrations_path}"
            )
        return sorted(self.migrations_path.glob("*.sql"))

    def _ensure_migration_table(self) -> None:
        with self.connection.transaction():
            self.connection.execute("CREATE SCHEMA IF NOT EXISTS ops")
            self.connection.execute(
                """
                CREATE TABLE IF NOT EXISTS ops.schema_migrations (
                    version VARCHAR(255) PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def _applied_versions(self) -> set[str]:
        with self.connection.transaction():
            rows = self.connection.execute(
                "SELECT version FROM ops.schema_migrations"
            ).fetchall()
        return {row["version"] for row in rows}
