"""Domain models for anonymous CineMind interactions."""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True)
class SessionRecord:
    """An anonymous browser session."""

    session_id: UUID
    started_at: datetime
    last_seen_at: datetime
    ended_at: datetime | None
    locale: str | None
    platform: str | None


@dataclass(frozen=True)
class WatchMetrics:
    """Normalized watch values stored for one interaction."""

    watch_seconds: int
    runtime_seconds: int | None
    completion_rate: Decimal | None
    duration_basis: str


@dataclass(frozen=True)
class InteractionState:
    """Latest user-facing state for an anonymous session."""

    ratings: tuple[dict, ...]
    favorites: tuple[dict, ...]
    watchlist_items: tuple[dict, ...]
