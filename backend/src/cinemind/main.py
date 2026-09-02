"""FastAPI application entry point."""

from datetime import datetime, timezone

import psycopg
from fastapi import FastAPI, HTTPException

from cinemind.catalog.routes import router as catalog_router
from cinemind.catalog.schemas import ReadinessResponse
from cinemind.config import get_settings
from cinemind.db.connection import connection_scope


def create_app() -> FastAPI:
    """Create the application without performing database work at import time."""

    application = FastAPI(title="CineMind API", version="0.1.0")
    application.include_router(catalog_router)

    @application.get("/healthz")
    def healthcheck() -> dict[str, str]:
        """Return process health without requiring PostgreSQL."""

        return {"status": "ok"}

    @application.get("/readyz", response_model=ReadinessResponse)
    def readiness() -> ReadinessResponse:
        """Verify that PostgreSQL and the catalog table are available."""

        try:
            with connection_scope(get_settings()) as connection:
                row = connection.execute(
                    "SELECT to_regclass('catalog.titles') AS table_name"
                ).fetchone()
        except psycopg.Error as error:
            raise HTTPException(status_code=503, detail="Database is unavailable") from error

        if row is None or row["table_name"] is None:
            raise HTTPException(status_code=503, detail="Catalog schema is not ready")
        return ReadinessResponse(
            status="ready",
            catalog_table=str(row["table_name"]),
            checked_at=datetime.now(timezone.utc),
        )

    return application


app = create_app()
