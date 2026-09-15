"""FastAPI application entry point."""

from datetime import datetime, timezone
import logging

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from cinemind.admin.routes import router as admin_router
from cinemind.auth.routes import router as auth_router
from cinemind.catalog.routes import router as catalog_router
from cinemind.catalog.schemas import ReadinessResponse
from cinemind.config import get_settings
from cinemind.db.connection import close_pool, connection_scope
from cinemind.db.migrations import MigrationRunner
from cinemind.interaction.routes import router as interaction_router
from cinemind.middleware import (
    CSRFMiddleware,
    InteractionRateLimitMiddleware,
    RequestBodyLimitMiddleware,
)


logger = logging.getLogger(__name__)

REQUIRED_TABLES = (
    ("ops", "schema_migrations"),
    ("ops", "dataset_sources"),
    ("ops", "ingestion_runs"),
    ("ops", "data_quality_issues"),
    ("catalog", "titles"),
    ("catalog", "title_genres"),
    ("catalog", "title_cast"),
    ("catalog", "title_countries"),
    ("catalog", "title_directors"),
    ("interaction", "sessions"),
    ("interaction", "search_events"),
    ("interaction", "watch_sessions"),
    ("interaction", "ratings"),
    ("auth", "users"),
    ("auth", "sessions"),
)

REQUIRED_COLUMNS = (
    ("interaction", "sessions", "session_token_hash"),
    ("interaction", "sessions", "expires_at"),
    ("interaction", "search_events", "client_mutation_id"),
    ("interaction", "search_events", "client_occurred_at"),
    ("interaction", "search_events", "client_device_id"),
    ("interaction", "search_events", "client_event_sequence"),
    ("interaction", "watch_sessions", "client_mutation_id"),
    ("interaction", "watch_sessions", "client_occurred_at"),
    ("interaction", "watch_sessions", "client_device_id"),
    ("interaction", "watch_sessions", "client_event_sequence"),
    ("interaction", "watch_sessions", "is_repair"),
    ("interaction", "watch_sessions", "repair_source_watch_session_id"),
    ("interaction", "ratings", "client_mutation_id"),
    ("interaction", "ratings", "client_occurred_at"),
    ("interaction", "ratings", "client_device_id"),
    ("interaction", "ratings", "client_event_sequence"),
    ("catalog", "titles", "is_active"),
    ("catalog", "titles", "source_checksum_sha256"),
    ("auth", "sessions", "last_seen_at"),
)


def create_app() -> FastAPI:
    """Create the application without performing database work at import time."""

    application = FastAPI(
        title="CineMind API",
        version="0.2.0",
        description=(
            "Catalog and anonymous interaction APIs for the CineMind data-mining prototype. "
            "Administrative reset operations are protected and intentionally excluded from OpenAPI."
        ),
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )
    settings = get_settings()
    application.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=settings.max_request_body_bytes,
    )
    application.add_middleware(
        InteractionRateLimitMiddleware,
        max_attempts=settings.interaction_rate_limit_max_attempts,
        window_seconds=settings.interaction_rate_limit_window_seconds,
        trust_proxy_headers=settings.trust_proxy_headers,
        auth_cookie_name=settings.auth_cookie_name,
        trusted_proxy_networks=settings.trusted_proxy_networks,
    )
    application.add_middleware(
        CSRFMiddleware,
        allowed_origins=settings.cors_allowed_origins,
        trust_proxy_headers=settings.trust_proxy_headers,
        trusted_proxy_networks=settings.trusted_proxy_networks,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allowed_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(catalog_router)
    application.include_router(interaction_router)
    application.include_router(auth_router)
    application.include_router(admin_router)
    application.add_event_handler("shutdown", close_pool)

    @application.get("/healthz")
    def healthcheck() -> dict[str, str]:
        """Return process health without requiring PostgreSQL."""

        return {"status": "ok"}

    @application.get("/readyz", response_model=ReadinessResponse)
    def readiness() -> ReadinessResponse:
        """Verify that PostgreSQL and every runtime schema are available."""

        try:
            settings = get_settings()
            with connection_scope(settings) as connection:
                required_values = ", ".join(
                    f"('{schema_name}', '{table_name}')"
                    for schema_name, table_name in REQUIRED_TABLES
                )
                rows = connection.execute(
                    f"""
                    SELECT required.schema_name,
                           required.table_name,
                           to_regclass(required.schema_name || '.' || required.table_name)
                               AS qualified_name
                    FROM (VALUES {required_values}) AS required(schema_name, table_name)
                    """
                ).fetchall()
                column_placeholders = ", ".join(
                    "(%s, %s, %s)" for _ in REQUIRED_COLUMNS
                )
                column_parameters = [
                    value
                    for column in REQUIRED_COLUMNS
                    for value in column
                ]
                column_rows = connection.execute(
                    f"""
                    SELECT required.schema_name,
                           required.table_name,
                           required.column_name
                    FROM (VALUES {column_placeholders}) AS required(
                        schema_name, table_name, column_name
                    )
                    LEFT JOIN information_schema.columns available
                      ON available.table_schema = required.schema_name
                     AND available.table_name = required.table_name
                     AND available.column_name = required.column_name
                    WHERE available.column_name IS NULL
                    """,
                    column_parameters,
                ).fetchall()
                expected_migrations = MigrationRunner(
                    connection, settings.migrations_path
                ).expected_migrations()
                applied_rows = connection.execute(
                    """
                    SELECT version, checksum_sha256
                    FROM ops.schema_migrations
                    """
                ).fetchall()
        except (OSError, ValueError, psycopg.Error) as error:
            logger.warning("CineMind readiness probe failed: %s", error)
            raise HTTPException(status_code=503, detail="Database is unavailable") from error

        missing = [
            f"{row['schema_name']}.{row['table_name']}"
            for row in rows
            if row["qualified_name"] is None
        ]
        missing_columns = [
            f"{row['schema_name']}.{row['table_name']}.{row['column_name']}"
            for row in column_rows
        ]
        expected_by_version = {
            migration.version: migration.checksum_sha256
            for migration in expected_migrations
        }
        applied_by_version = {
            str(row["version"]): (
                str(row["checksum_sha256"]).strip().lower()
                if row["checksum_sha256"]
                else None
            )
            for row in applied_rows
        }
        missing_migrations = sorted(set(expected_by_version) - set(applied_by_version))
        extra_migrations = sorted(set(applied_by_version) - set(expected_by_version))
        drifted_migrations = sorted(
            version
            for version, checksum in expected_by_version.items()
            if applied_by_version.get(version) != checksum
        )
        if missing or missing_columns or missing_migrations or extra_migrations or drifted_migrations:
            logger.warning(
                "CineMind readiness failed: tables=%s columns=%s missing_migrations=%s "
                "extra_migrations=%s drifted_migrations=%s",
                missing,
                missing_columns,
                missing_migrations,
                extra_migrations,
                drifted_migrations,
            )
            raise HTTPException(status_code=503, detail="Database schema is not ready")
        latest_migration = expected_migrations[-1] if expected_migrations else None
        return ReadinessResponse(
            status="ready",
            catalog_table="catalog.titles",
            checked_at=datetime.now(timezone.utc),
            migration_version=latest_migration.version if latest_migration else None,
            migration_checksum_sha256=(
                latest_migration.checksum_sha256 if latest_migration else None
            ),
        )

    return application


app = create_app()
