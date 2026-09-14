"""Shared PostgreSQL advisory locks for destructive and append-only writes."""

from typing import Any


# Keep this key stable across releases so every process uses one lock domain.
WRITE_MAINTENANCE_LOCK_KEY = 271820260


def acquire_write_lock(connection: Any) -> None:
    """Wait for the shared write/maintenance lock in the current transaction."""

    connection.execute(
        "SELECT pg_advisory_xact_lock(%s)",
        (WRITE_MAINTENANCE_LOCK_KEY,),
    )
