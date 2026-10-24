"""Response schemas for account recommendations."""

from pydantic import BaseModel

from cinemind.catalog.schemas import CatalogTitleResponse


class RecommendationItemResponse(BaseModel):
    title: CatalogTitleResponse
    score: float
    component_scores: dict[str, float | None]
    reasons: list[str]


class RecommendationResponse(BaseModel):
    algorithm: str
    items: list[RecommendationItemResponse]
    mode: str
    evidence_status: str
    model_version: str | None = None
    active_weights: dict[str, float]
    artifact_status: str


class RecommendationStatusResponse(BaseModel):
    status: str
    artifact_status: str
    reason: str | None = None
    model_version: str | None = None
    evidence_status: str
    components: dict[str, str]
    dataset_counts: dict[str, int]
