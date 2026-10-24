"""Account-scoped recommendation orchestration."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from cinemind.recommendations.artifacts import RecommendationArtifactStore
from cinemind.recommendations.core import content_similarity_scores, rank_recommendations


CATALOG_PAGE_SIZE = 1_000
MAX_CATALOG_TITLES = 100_000


class RecommendationService:
    def __init__(self, catalog_repository, interaction_repository, artifact_store: RecommendationArtifactStore):
        self.catalog_repository = catalog_repository
        self.interaction_repository = interaction_repository
        self.artifact_store = artifact_store

    def status(self) -> dict[str, Any]:
        snapshot = self.artifact_store.load()
        artifact = snapshot.artifact or {}
        cluster = artifact.get("cluster_model")
        tree = artifact.get("tree_model")
        content_vectors = artifact.get("content_vectors")
        counts = artifact.get("dataset_counts")
        safe_counts = {
            str(name): int(value)
            for name, value in counts.items()
            if isinstance(name, str) and isinstance(value, int) and not isinstance(value, bool) and value >= 0
        } if isinstance(counts, dict) else {}
        return {
            "status": "ready" if snapshot.status == "ready" else "degraded",
            "artifact_status": snapshot.status,
            "reason": snapshot.reason,
            "model_version": artifact.get("model_version"),
            "evidence_status": "demo_only",
            "components": {
                "popularity": "ready" if artifact.get("popularity") else "catalog_fallback",
                "content": "tfidf" if content_vectors else "genre_profile_fallback",
                "cluster": "ready" if isinstance(cluster, dict) and cluster.get("status") == "ready" else "disabled",
                "p_like": "ready" if isinstance(tree, dict) and tree.get("status") == "ready" else "disabled",
            },
            "dataset_counts": safe_counts,
        }

    def recommend(self, *, user_id: UUID, algorithm: str, limit: int) -> dict[str, Any]:
        catalog = self._read_catalog()
        history = self.interaction_repository.interaction_state(user_id=user_id)
        ratings = list(history.get("ratings", ()))
        seen_show_ids = set(self.interaction_repository.seen_show_ids(user_id))
        snapshot = self.artifact_store.load()
        artifact = snapshot.artifact
        vectors = artifact.get("content_vectors", {}) if artifact else {}
        # One request, one clock: content scoring and ranking must not observe
        # slightly different recency windows.
        now = datetime.now(timezone.utc)
        similarity = content_similarity_scores(ratings, vectors, now=now) if vectors else None
        result = rank_recommendations(
            catalog=catalog,
            ratings=ratings,
            seen_show_ids=seen_show_ids,
            artifact=artifact,
            algorithm=algorithm,
            limit=limit,
            content_similarity=similarity,
            tree_features_by_show=(artifact or {}).get("tree_features_by_show"),
            now=now,
        )
        return {
            **result,
            "algorithm": algorithm,
            "artifact_status": snapshot.status,
        }

    def _read_catalog(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for offset in range(0, MAX_CATALOG_TITLES, CATALOG_PAGE_SIZE):
            page = list(self.catalog_repository.list_titles(limit=CATALOG_PAGE_SIZE, offset=offset))
            rows.extend(dict(row) for row in page)
            if len(page) < CATALOG_PAGE_SIZE:
                return rows
        raise ValueError("Active catalog exceeds the recommendation safety limit")
