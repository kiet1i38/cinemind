"""Pydantic contracts for the protected database reset boundary."""

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class ResetScope(str, Enum):
    """Supported reset scopes exposed by the separate admin page."""

    INTERACTION = "interaction"
    DEMO = "demo"
    FULL = "full"


class ResetRequest(BaseModel):
    """A deliberately explicit reset request."""

    scope: ResetScope
    confirmation: str = Field(..., min_length=1, max_length=64)
    session_id: UUID | None = None


class ResetResponse(BaseModel):
    """Auditable result returned after a reset operation."""

    scope: ResetScope
    reset_at: datetime
    deleted_rows: dict[str, int]
    catalog_reseeded: bool
    seeded_catalog_rows: int
    catalog_summary: dict[str, int] | None = None
