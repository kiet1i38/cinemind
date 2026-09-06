"""PostgreSQL connection helpers."""

from contextlib import contextmanager
from threading import Lock
import time
from typing import Iterator

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout
from psycopg.rows import dict_row

from cinemind.config import Settings


_pool_lock = Lock()
_pool: ConnectionPool | None = None
_pool_signature: tuple[str, int, int, int, int] | None = None


def open_connection(settings: Settings):
    """Open a dictionary-row PostgreSQL connection for startup probes only."""

    return psycopg.connect(
        settings.database_url,
        connect_timeout=settings.db_connect_timeout_seconds,
        row_factory=dict_row,
    )


def _connection_pool(settings: Settings) -> ConnectionPool:
    """Return one bounded pool for the current process configuration."""

    global _pool, _pool_signature
    signature = (
        settings.database_url,
        settings.db_pool_min_size,
        settings.db_pool_max_size,
        settings.db_pool_timeout_seconds,
        settings.db_connect_timeout_seconds,
    )
    with _pool_lock:
        if _pool is None or _pool_signature != signature:
            if _pool is not None:
                _pool.close()
            _pool = ConnectionPool(
                conninfo=settings.database_url,
                kwargs={
                    "connect_timeout": settings.db_connect_timeout_seconds,
                    "row_factory": dict_row,
                },
                min_size=settings.db_pool_min_size,
                max_size=settings.db_pool_max_size,
                timeout=settings.db_pool_timeout_seconds,
                open=False,
            )
            _pool.open(wait=False)
            _pool_signature = signature
        return _pool


@contextmanager
def connection_scope(settings: Settings) -> Iterator:
    """Borrow a connection from the bounded pool for one operation."""

    try:
        with _connection_pool(settings).connection() as connection:
            yield connection
    except PoolTimeout as error:
        raise psycopg.OperationalError("PostgreSQL connection pool is busy") from error


def wait_for_database(settings: Settings) -> None:
    """Wait for PostgreSQL during container startup."""

    last_error: Exception | None = None
    for attempt in range(settings.db_connect_retries):
        try:
            with open_connection(settings) as connection:
                connection.execute("SELECT 1")
            return
        except psycopg.OperationalError as error:
            last_error = error
            if attempt + 1 < settings.db_connect_retries:
                time.sleep(settings.db_connect_retry_delay_seconds)

    raise RuntimeError("PostgreSQL did not become ready in time") from last_error


def close_pool() -> None:
    """Close the process pool when the application shuts down."""

    global _pool, _pool_signature
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
            _pool_signature = None
