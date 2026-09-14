"""Ordered SQL migrations with checksum-based drift detection."""

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path


class MigrationDriftError(RuntimeError):
    """Raised when an applied migration no longer matches its source file."""


@dataclass(frozen=True)
class MigrationResult:
    """Result of applying migrations."""

    applied_versions: tuple[str, ...]


@dataclass(frozen=True)
class MigrationMetadata:
    """Version and immutable source checksum for one migration file."""

    version: str
    checksum_sha256: str


class MigrationRunner:
    """Apply SQL files once and record their source checksum in PostgreSQL."""

    def __init__(self, connection, migrations_path: Path):
        self.connection = connection
        self.migrations_path = migrations_path

    def apply(self) -> MigrationResult:
        """Validate applied files and apply missing migrations in filename order."""

        self._ensure_migration_table()
        migration_paths = self._migration_files()
        applied = self._applied_versions()
        applied_now: list[str] = []

        for migration_path in migration_paths:
            version = migration_path.stem
            checksum = file_checksum(migration_path)
            recorded_checksum = applied.get(version)
            if recorded_checksum is not None:
                if recorded_checksum != checksum:
                    raise MigrationDriftError(
                        f"Migration {version} checksum drift detected: "
                        f"database={recorded_checksum}, file={checksum}"
                    )
                continue
            if version in applied:
                # Databases created before checksum tracking are backfilled once
                # at this boundary. Future edits fail closed.
                self._backfill_checksum(version, checksum)
                continue

            sql = migration_path.read_text(encoding="utf-8")
            with self.connection.transaction():
                self.connection.execute(sql)
                self.connection.execute(
                    """
                    INSERT INTO ops.schema_migrations (version, checksum_sha256)
                    VALUES (%s, %s)
                    """,
                    (version, checksum),
                )
            applied_now.append(version)

        return MigrationResult(applied_versions=tuple(applied_now))

    def expected_migrations(self) -> tuple[MigrationMetadata, ...]:
        """Return the current ordered migration manifest for readiness checks."""

        return tuple(
            MigrationMetadata(path.stem, file_checksum(path))
            for path in self._migration_files()
        )

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
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    checksum_sha256 CHAR(64)
                )
                """
            )
            self.connection.execute(
                """
                ALTER TABLE ops.schema_migrations
                ADD COLUMN IF NOT EXISTS checksum_sha256 CHAR(64)
                """
            )

    def _applied_versions(self) -> dict[str, str | None]:
        with self.connection.transaction():
            rows = self.connection.execute(
                "SELECT version, checksum_sha256 FROM ops.schema_migrations"
            ).fetchall()
        return {
            str(row["version"]): (
                str(row["checksum_sha256"]).strip().lower()
                if row["checksum_sha256"]
                else None
            )
            for row in rows
        }

    def _backfill_checksum(self, version: str, checksum: str) -> None:
        with self.connection.transaction():
            self.connection.execute(
                """
                UPDATE ops.schema_migrations
                SET checksum_sha256 = %s
                WHERE version = %s AND checksum_sha256 IS NULL
                """,
                (checksum, version),
            )


def file_checksum(path: Path) -> str:
    """Calculate a streaming SHA-256 checksum for a migration file."""

    digest = sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
