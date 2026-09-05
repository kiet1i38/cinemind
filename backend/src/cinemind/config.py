"""Environment-backed configuration for the CineMind backend."""

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _int_from_environment(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default

    try:
        return int(value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error


def _list_from_environment(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = os.getenv(name)
    if value is None:
        return default

    values = tuple(item.strip() for item in value.split(",") if item.strip())
    return values or default


@dataclass(frozen=True)
class Settings:
    """Runtime settings with safe local-development defaults."""

    database_url: str
    catalog_seed_path: Path
    migrations_path: Path
    catalog_source_name: str
    catalog_source_type: str
    catalog_source_uri: str
    catalog_schema_version: str
    db_connect_retries: int
    db_connect_retry_delay_seconds: int
    db_connect_timeout_seconds: int
    max_watch_minutes: int
    cors_allowed_origins: tuple[str, ...]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Build immutable settings once per process."""

    return Settings(
        database_url=os.getenv(
            "DATABASE_URL",
            "postgresql://cinemind:cinemind_dev@localhost:5432/cinemind",
        ),
        catalog_seed_path=Path(
            os.getenv(
                "CATALOG_SEED_PATH",
                str(PROJECT_ROOT / "frontend/public/data/catalog.json"),
            )
        ),
        migrations_path=Path(
            os.getenv("MIGRATIONS_PATH", str(PROJECT_ROOT / "backend/migrations"))
        ),
        catalog_source_name=os.getenv(
            "CATALOG_SOURCE_NAME", "Netflix Movies and TV Shows"
        ),
        catalog_source_type=os.getenv("CATALOG_SOURCE_TYPE", "kaggle"),
        catalog_source_uri=os.getenv(
            "CATALOG_SOURCE_URI",
            "https://www.kaggle.com/datasets/shivamb/netflix-shows/data",
        ),
        catalog_schema_version=os.getenv(
            "CATALOG_SCHEMA_VERSION", "catalog-json-v1"
        ),
        db_connect_retries=_int_from_environment("DB_CONNECT_RETRIES", 30),
        db_connect_retry_delay_seconds=_int_from_environment(
            "DB_CONNECT_RETRY_DELAY_SECONDS", 1
        ),
        db_connect_timeout_seconds=_int_from_environment(
            "DB_CONNECT_TIMEOUT_SECONDS", 5
        ),
        max_watch_minutes=_int_from_environment("MAX_WATCH_MINUTES", 10080),
        cors_allowed_origins=_list_from_environment(
            "CORS_ALLOWED_ORIGINS",
            ("http://localhost:5173", "http://127.0.0.1:5173"),
        ),
    )
