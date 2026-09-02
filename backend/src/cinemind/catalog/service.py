"""Application service for catalog query use cases."""

from dataclasses import dataclass

from cinemind.catalog.repository import CatalogRepository


@dataclass(frozen=True)
class CatalogFilters:
    """Supported catalog filters."""

    query: str | None = None
    content_type: str | None = None
    genre: str | None = None
    release_year: int | None = None


@dataclass(frozen=True)
class CatalogPage:
    """A paginated catalog result."""

    items: tuple[dict, ...]
    total: int
    limit: int
    offset: int


class CatalogService:
    """Coordinate catalog reads without exposing repository details to routes."""

    def __init__(self, repository: CatalogRepository):
        self.repository = repository

    def get_page(self, filters: CatalogFilters, limit: int, offset: int) -> CatalogPage:
        """Return one stable page using the same filters for count and rows."""

        items = self.repository.list_titles(
            limit=limit,
            offset=offset,
            query=filters.query,
            content_type=filters.content_type,
            genre=filters.genre,
            release_year=filters.release_year,
        )
        total = self.repository.count_titles(
            query=filters.query,
            content_type=filters.content_type,
            genre=filters.genre,
            release_year=filters.release_year,
        )
        return CatalogPage(items=items, total=total, limit=limit, offset=offset)
