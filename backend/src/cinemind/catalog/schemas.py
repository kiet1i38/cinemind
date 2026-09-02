"""HTTP response models for catalog endpoints."""

from datetime import date, datetime

from pydantic import BaseModel, Field


class CatalogTitleResponse(BaseModel):
    """Normalized title returned to API consumers."""

    title_id: int
    show_id: str
    content_type: str
    title: str
    description: str | None
    date_added: date | None
    release_year: int | None
    content_rating: str | None
    movie_duration_min: int | None
    season_count: int | None
    duration_basis: str
    poster_provider: str | None
    poster_path: str | None
    poster_url: str | None
    poster_status: str
    genres: list[str] = Field(default_factory=list)
    cast: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    directors: list[str] = Field(default_factory=list)


class CatalogPageResponse(BaseModel):
    """Paginated catalog response."""

    items: list[CatalogTitleResponse]
    total: int
    limit: int
    offset: int


class CatalogSummaryResponse(BaseModel):
    """Catalog health summary."""

    total: int
    movies: int
    tv_shows: int
    public_posters: int
    fallback_posters: int


class ReadinessResponse(BaseModel):
    """Database readiness response."""

    status: str
    catalog_table: str
    checked_at: datetime
