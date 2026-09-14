"""Pydantic request and response models for interaction endpoints."""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field, StrictStr, field_validator

from cinemind.interaction.limits import normalize_filters


class SessionCreateRequest(BaseModel):
    """Optional metadata for a new anonymous session."""

    locale: str | None = Field(default=None, min_length=1, max_length=16)
    platform: str | None = Field(default=None, min_length=1, max_length=32)

    @field_validator("locale", "platform", mode="before")
    @classmethod
    def reject_blank_metadata(cls, value: str | None) -> str | None:
        """Normalize metadata and reject values the database cannot store."""

        if value is None:
            return None
        normalized = str(value).strip()
        if not normalized:
            raise ValueError("metadata must contain a non-whitespace value")
        return normalized


class SessionResponse(BaseModel):
    """Created or refreshed anonymous session."""

    session_id: UUID
    started_at: datetime
    last_seen_at: datetime
    session_token: str


class SearchEventCreateRequest(BaseModel):
    """A debounced search interaction from the frontend."""

    session_id: UUID
    query: str = Field(..., min_length=1, max_length=200)
    result_count: int = Field(default=0, ge=0, le=2_147_483_647)
    filters: dict[StrictStr, StrictStr] = Field(default_factory=dict)
    client_mutation_id: UUID | None = None

    @field_validator("filters")
    @classmethod
    def validate_filters(cls, value: dict[str, str]) -> dict[str, str]:
        """Reject oversized or malformed filter payloads before persistence."""

        return normalize_filters(value)


class SearchEventResponse(BaseModel):
    """Stored search interaction."""

    search_event_id: int
    session_id: UUID
    query_text: str
    normalized_query: str
    result_count: int
    filters: dict[str, str]
    occurred_at: datetime


class WatchSessionCreateRequest(BaseModel):
    """Raw watch duration submitted by the UI."""

    session_id: UUID
    show_id: str = Field(..., min_length=1, max_length=32)
    watch_minutes: int = Field(..., ge=0)
    client_mutation_id: UUID | None = None


class WatchSessionResponse(BaseModel):
    """Normalized watch session."""

    watch_session_id: UUID
    session_id: UUID
    show_id: str
    watch_seconds: int
    runtime_seconds: int | None
    completion_rate: Decimal | None
    duration_basis: str
    recorded_at: datetime


class RatingCreateRequest(BaseModel):
    """A title rating, optionally linked to a watch session."""

    session_id: UUID
    show_id: str = Field(..., min_length=1, max_length=32)
    rating: Decimal = Field(...)
    watch_session_id: UUID | None = None
    client_mutation_id: UUID | None = None

    @field_validator("rating")
    @classmethod
    def validate_rating(cls, value: Decimal) -> Decimal:
        return _validate_rating(value)


class RatingResponse(BaseModel):
    """Stored rating event."""

    rating_id: int
    session_id: UUID
    show_id: str
    rating: Decimal
    watch_session_id: UUID | None
    rated_at: datetime


class SignalCreateRequest(BaseModel):
    """Atomic rating plus watch duration submission."""

    session_id: UUID
    show_id: str = Field(..., min_length=1, max_length=32)
    rating: Decimal = Field(...)
    watch_minutes: int = Field(..., ge=0)
    client_mutation_id: UUID | None = None

    @field_validator("rating")
    @classmethod
    def validate_rating(cls, value: Decimal) -> Decimal:
        return _validate_rating(value)


class SignalResponse(BaseModel):
    """Atomic signal result."""

    watch_session: WatchSessionResponse
    rating: RatingResponse


class RatingStateResponse(BaseModel):
    """Latest rating for a title in a session."""

    show_id: str
    rating: Decimal
    watch_minutes: int | None
    rated_at: datetime


class InteractionStateResponse(BaseModel):
    """All persisted state needed to restore the frontend session."""

    session_id: UUID
    ratings: list[RatingStateResponse] = Field(default_factory=list)


def _validate_rating(value: Decimal) -> Decimal:
    """Accept finite ratings from 0.5 to 10 in exact half-point steps."""

    rating = Decimal(value)
    if not rating.is_finite() or rating < Decimal("0.5") or rating > Decimal("10"):
        raise ValueError("rating must be between 0.5 and 10")
    if (rating * 2) != (rating * 2).to_integral_value():
        raise ValueError("rating must use increments of 0.5")
    return rating.quantize(Decimal("0.1"))
