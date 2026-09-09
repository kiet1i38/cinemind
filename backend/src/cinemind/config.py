"""Environment-backed configuration for the CineMind backend."""

from dataclasses import dataclass, field
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


def _bool_from_environment(name: str, default: bool) -> bool:
    """Parse a human-friendly boolean environment value."""

    value = os.getenv(name)
    if value is None:
        return default

    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


@dataclass(frozen=True)
class Settings:
    """Runtime settings with safe local-development defaults."""

    environment: str
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
    db_pool_min_size: int
    db_pool_max_size: int
    db_pool_timeout_seconds: int
    max_request_body_bytes: int
    max_watch_minutes: int
    cors_allowed_origins: tuple[str, ...]
    trust_proxy_headers: bool
    require_https: bool
    auth_cookie_name: str
    auth_session_ttl_days: int
    auth_password_iterations: int
    auth_rate_limit_window_seconds: int
    auth_rate_limit_max_attempts: int
    interaction_rate_limit_window_seconds: int
    interaction_rate_limit_max_attempts: int
    admin_reset_username: str
    admin_reset_password: str = field(repr=False)
    reset_enabled: bool
    full_reset_enabled: bool

    def __post_init__(self) -> None:
        """Reject unsafe or internally inconsistent runtime limits early."""

        positive_limits = {
            "db_pool_min_size": self.db_pool_min_size,
            "db_pool_max_size": self.db_pool_max_size,
            "db_pool_timeout_seconds": self.db_pool_timeout_seconds,
            "db_connect_retries": self.db_connect_retries,
            "db_connect_timeout_seconds": self.db_connect_timeout_seconds,
            "max_request_body_bytes": self.max_request_body_bytes,
            "max_watch_minutes": self.max_watch_minutes,
            "auth_session_ttl_days": self.auth_session_ttl_days,
            "auth_password_iterations": self.auth_password_iterations,
            "auth_rate_limit_window_seconds": self.auth_rate_limit_window_seconds,
            "auth_rate_limit_max_attempts": self.auth_rate_limit_max_attempts,
            "interaction_rate_limit_window_seconds": self.interaction_rate_limit_window_seconds,
            "interaction_rate_limit_max_attempts": self.interaction_rate_limit_max_attempts,
        }
        invalid = [name for name, value in positive_limits.items() if value < 1]
        if invalid:
            raise ValueError(f"Runtime limits must be positive: {', '.join(invalid)}")
        if self.db_connect_retry_delay_seconds < 0:
            raise ValueError("db_connect_retry_delay_seconds must be non-negative")
        if self.db_pool_min_size > self.db_pool_max_size:
            raise ValueError("db_pool_min_size must not exceed db_pool_max_size")
        if self.auth_password_iterations < 10_000:
            raise ValueError("auth_password_iterations must be at least 10000")
        if self.auth_session_ttl_days > 365:
            raise ValueError("auth_session_ttl_days must not exceed 365")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Build immutable settings once per process."""

    environment = os.getenv("CINEMIND_ENVIRONMENT", "development").strip().casefold() or "development"
    configured_database_url = os.getenv("DATABASE_URL")
    if configured_database_url:
        database_url = configured_database_url
    elif environment in {"development", "test"}:
        database_url = "postgresql:///cinemind"
    else:
        raise ValueError("DATABASE_URL must be configured outside local development")

    trust_proxy_headers = _bool_from_environment("TRUST_PROXY_HEADERS", False)
    require_https = _bool_from_environment(
        "REQUIRE_HTTPS",
        environment == "production",
    )

    return Settings(
        environment=environment,
        database_url=database_url,
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
        db_pool_min_size=_int_from_environment("DB_POOL_MIN_SIZE", 1),
        db_pool_max_size=_int_from_environment("DB_POOL_MAX_SIZE", 5),
        db_pool_timeout_seconds=_int_from_environment("DB_POOL_TIMEOUT_SECONDS", 5),
        max_request_body_bytes=_int_from_environment(
            "MAX_REQUEST_BODY_BYTES", 32768
        ),
        max_watch_minutes=_int_from_environment("MAX_WATCH_MINUTES", 10080),
        cors_allowed_origins=_list_from_environment(
            "CORS_ALLOWED_ORIGINS",
            ("http://localhost:5173", "http://127.0.0.1:5173"),
        ),
        trust_proxy_headers=trust_proxy_headers,
        require_https=require_https,
        auth_cookie_name=os.getenv("AUTH_COOKIE_NAME", "cinemind_auth").strip()
        or "cinemind_auth",
        auth_session_ttl_days=_int_from_environment("AUTH_SESSION_TTL_DAYS", 30),
        auth_password_iterations=_int_from_environment(
            "AUTH_PASSWORD_ITERATIONS", 600000
        ),
        auth_rate_limit_window_seconds=_int_from_environment(
            "AUTH_RATE_LIMIT_WINDOW_SECONDS", 300
        ),
        auth_rate_limit_max_attempts=_int_from_environment(
            "AUTH_RATE_LIMIT_MAX_ATTEMPTS", 10
        ),
        interaction_rate_limit_window_seconds=_int_from_environment(
            "INTERACTION_RATE_LIMIT_WINDOW_SECONDS", 60
        ),
        interaction_rate_limit_max_attempts=_int_from_environment(
            "INTERACTION_RATE_LIMIT_MAX_ATTEMPTS", 120
        ),
        admin_reset_username=os.getenv("ADMIN_RESET_USERNAME", "").strip(),
        admin_reset_password=os.getenv("ADMIN_RESET_PASSWORD", ""),
        # Local maintenance can be enabled by default, but production must
        # explicitly opt in. A missing secret never exposes the endpoint.
        reset_enabled=_bool_from_environment("RESET_ENABLED", environment != "production"),
        full_reset_enabled=_bool_from_environment("FULL_RESET_ENABLED", False),
    )
