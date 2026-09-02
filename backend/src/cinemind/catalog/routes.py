"""HTTP routes for the catalog schema."""

from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Query

from cinemind.catalog.repository import CatalogRepository
from cinemind.catalog.schemas import (
    CatalogPageResponse,
    CatalogSummaryResponse,
    CatalogTitleResponse,
)
from cinemind.catalog.service import CatalogFilters, CatalogService
from cinemind.config import get_settings
from cinemind.db.connection import connection_scope


router = APIRouter(prefix="/api/catalog", tags=["catalog"])
SUPPORTED_TYPES = frozenset({"Movie", "TV Show"})


def get_catalog_service() -> Iterator[CatalogService]:
    """Create one repository connection per request."""

    with connection_scope(get_settings()) as connection:
        yield CatalogService(CatalogRepository(connection))


@router.get("/summary", response_model=CatalogSummaryResponse)
def get_catalog_summary(
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogSummaryResponse:
    """Return basic counts for smoke tests and monitoring."""

    return CatalogSummaryResponse(**service.repository.summary())


@router.get("", response_model=CatalogPageResponse)
def list_catalog(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    query: str | None = Query(default=None, max_length=200),
    content_type: str | None = Query(default=None, alias="type"),
    genre: str | None = Query(default=None, max_length=120),
    release_year: int | None = Query(default=None, ge=1888, le=2100),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogPageResponse:
    """List catalog titles with safe, parameterized filters."""

    normalized_type = _optional_filter(content_type)
    if normalized_type and normalized_type not in SUPPORTED_TYPES:
        raise HTTPException(status_code=400, detail="type must be Movie or TV Show")

    page = service.get_page(
        CatalogFilters(
            query=_optional_filter(query),
            content_type=normalized_type,
            genre=_optional_filter(genre),
            release_year=release_year,
        ),
        limit=limit,
        offset=offset,
    )
    return CatalogPageResponse(
        items=[CatalogTitleResponse(**dict(item)) for item in page.items],
        total=page.total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{show_id}", response_model=CatalogTitleResponse)
def get_catalog_title(
    show_id: str,
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogTitleResponse:
    """Return one title and all normalized relations."""

    title = service.repository.get_title(show_id.strip())
    if title is None:
        raise HTTPException(status_code=404, detail="Catalog title not found")
    return CatalogTitleResponse(**title)


def _optional_filter(value: str | None) -> str | None:
    """Trim a text filter and convert blank input to no filter."""

    normalized = value.strip() if value else ""
    return normalized or None
