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
    ("interaction", "favorites"),
    ("interaction", "watchlist_items"),
    ("auth", "users"),
    ("auth", "sessions"),
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
    )
    application.add_middleware(
        CSRFMiddleware,
        allowed_origins=settings.cors_allowed_origins,
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
            with connection_scope(get_settings()) as connection:
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
        except psycopg.Error as error:
            raise HTTPException(status_code=503, detail="Database is unavailable") from error

        missing = [
            f"{row['schema_name']}.{row['table_name']}"
            for row in rows
            if row["qualified_name"] is None
        ]
        if missing:
            logger.warning("CineMind readiness is missing required database objects: %s", missing)
            raise HTTPException(status_code=503, detail="Database schema is not ready")
        return ReadinessResponse(
            status="ready",
            catalog_table="catalog.titles",
            checked_at=datetime.now(timezone.utc),
        )

    return application


app = create_app()
