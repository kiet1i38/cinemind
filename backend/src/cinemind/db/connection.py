"""PostgreSQL connection helpers."""

from contextlib import contextmanager
import time
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

from cinemind.config import Settings


def open_connection(settings: Settings):
    """Open a dictionary-row PostgreSQL connection."""

    return psycopg.connect(
        settings.database_url,
        connect_timeout=settings.db_connect_timeout_seconds,
        row_factory=dict_row,
    )


@contextmanager
def connection_scope(settings: Settings) -> Iterator:
    """Yield a connection and always close it after the operation."""

    connection = open_connection(settings)
    try:
        yield connection
    finally:
        connection.close()


def wait_for_database(settings: Settings) -> None:
    """Wait for PostgreSQL during container startup."""

    last_error: Exception | None = None
    for attempt in range(settings.db_connect_retries):
        try:
            with connection_scope(settings) as connection:
                connection.execute("SELECT 1")
            return
        except psycopg.OperationalError as error:
            last_error = error
            if attempt + 1 < settings.db_connect_retries:
                time.sleep(settings.db_connect_retry_delay_seconds)

    raise RuntimeError("PostgreSQL did not become ready in time") from last_error
