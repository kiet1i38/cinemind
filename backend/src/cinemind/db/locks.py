"""Shared PostgreSQL advisory locks for destructive and append-only writes."""

from typing import Any
from uuid import UUID


# Keep this key stable across releases so every process uses one lock domain.
WRITE_MAINTENANCE_LOCK_KEY = 271820260
# Keep the hash seed stable so the same client mutation id maps to the same
# transaction lock across processes and releases.
MUTATION_LOCK_HASH_SEED = WRITE_MAINTENANCE_LOCK_KEY


def acquire_write_lock(connection: Any) -> None:
    """Take a shared transaction lock for normal application writes."""

    connection.execute(
        "SELECT pg_advisory_xact_lock_shared(%s)",
        (WRITE_MAINTENANCE_LOCK_KEY,),
    )


def acquire_mutation_lock(connection: Any, client_mutation_id: UUID) -> None:
    """Take an exclusive transaction lock for one client mutation id.

    Normal interaction writes intentionally share the maintenance lock so
    unrelated requests can run concurrently. The idempotency scope check is
    therefore only race-free when requests carrying the same mutation id also
    share an exclusive lock of their own.
    """

    connection.execute(
        """
        SELECT pg_advisory_xact_lock(
            hashtextextended(%s::text, %s)
        )
        """,
        (str(client_mutation_id), MUTATION_LOCK_HASH_SEED),
    )


def acquire_maintenance_lock(connection: Any) -> None:
    """Take the exclusive transaction lock used by destructive maintenance."""

    connection.execute(
        "SELECT pg_advisory_xact_lock(%s)",
        (WRITE_MAINTENANCE_LOCK_KEY,),
    )
