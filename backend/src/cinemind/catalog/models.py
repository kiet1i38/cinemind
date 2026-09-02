"""Domain models for normalized catalog records."""

from dataclasses import dataclass
from datetime import date
from typing import Any


@dataclass(frozen=True)
class CatalogRecord:
    """A validated catalog record ready for PostgreSQL persistence."""

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
    genres: tuple[str, ...]
    cast: tuple[str, ...]
    countries: tuple[str, ...]
    directors: tuple[str, ...]


@dataclass(frozen=True)
class CatalogIssue:
    """A non-fatal quality issue attached to a catalog row."""

    record_key: str | None
    issue_type: str
    severity: str
    details: dict[str, Any]


@dataclass(frozen=True)
class CatalogLoadResult:
    """Validated records and issues produced by the loader."""

    records: tuple[CatalogRecord, ...]
    issues: tuple[CatalogIssue, ...]
    rows_read: int
