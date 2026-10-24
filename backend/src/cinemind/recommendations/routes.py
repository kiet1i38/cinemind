"""Authenticated API routes for data-mining recommendations."""

from collections.abc import Iterator
from enum import Enum
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response

from cinemind.auth.dependencies import AuthContext, require_auth_context
from cinemind.catalog.repository import CatalogRepository
from cinemind.config import get_settings
from cinemind.db.connection import connection_scope
from cinemind.interaction.repository import InteractionRepository
from cinemind.recommendations.artifacts import RecommendationArtifactStore
from cinemind.recommendations.schemas import (
    RecommendationResponse,
    RecommendationStatusResponse,
)
from cinemind.recommendations.service import RecommendationService


router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])


@lru_cache(maxsize=1)
def get_recommendation_artifact_store() -> RecommendationArtifactStore:
    """Keep the verified immutable artifact cached across requests."""

    return RecommendationArtifactStore()


def get_recommendation_service() -> Iterator[RecommendationService]:
    """Use one database connection per recommendation request."""

    with connection_scope(get_settings()) as connection:
        yield RecommendationService(
            CatalogRepository(connection),
            InteractionRepository(connection),
            get_recommendation_artifact_store(),
        )


def _mark_private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Cookie"


@router.get("/status", response_model=RecommendationStatusResponse)
def get_recommendation_status(
    response: Response,
    _context: AuthContext = Depends(require_auth_context),
    service: RecommendationService = Depends(get_recommendation_service),
) -> dict:
    """Describe model readiness without disclosing account data."""

    _mark_private(response)
    return service.status()


class RecommendationLimit(int, Enum):
    """The only page sizes the API contract supports."""

    FIVE = 5
    TEN = 10


@router.get("", response_model=RecommendationResponse)
def get_recommendations(
    response: Response,
    algorithm: Literal["popularity", "content", "hybrid"] = Query(default="hybrid"),
    limit: RecommendationLimit = Query(default=RecommendationLimit.TEN),
    context: AuthContext = Depends(require_auth_context),
    service: RecommendationService = Depends(get_recommendation_service),
) -> dict:
    """Rank unseen titles using only the authenticated account's committed history."""

    _mark_private(response)
    return service.recommend(user_id=context.user_id, algorithm=algorithm, limit=int(limit))
