"""Account-scoped recommendation orchestration."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from cinemind.recommendations.artifacts import RecommendationArtifactStore
from cinemind.recommendations.baseline_features import (
    catalog_genre_index,
    live_cluster_id,
    live_tree_features,
    uses_live_tree,
)
from cinemind.recommendations.core import (
    _ASSIGNED_CLUSTER_UNSET,
    content_similarity_scores,
    rank_recommendations,
)


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
        evidence_status = artifact.get("evidence_status")
        return {
            "status": "ready" if snapshot.status == "ready" else "degraded",
            "artifact_status": snapshot.status,
            "reason": snapshot.reason,
            "model_version": artifact.get("model_version"),
            "evidence_status": evidence_status if evidence_status in {"demo_only", "baseline_not_holdout"} else "demo_only",
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
        watches = self._events("watch_events", user_id)
        searches = self._events("search_events", user_id)
        genres = catalog_genre_index(catalog)
        tree_model = (artifact or {}).get("tree_model")
        cluster_model = (artifact or {}).get("cluster_model") if artifact else None
        baseline_cluster = isinstance(cluster_model, dict) and cluster_model.get("space") == "scaled_genre_share_v1"
        assigned_cluster = (
            live_cluster_id(ratings, watches, searches, genres, cluster_model, now)
            if baseline_cluster
            else _ASSIGNED_CLUSTER_UNSET
        )
        if uses_live_tree(tree_model):
            candidate_ids = [str(item.get("show_id") or item.get("id")) for item in catalog]
            tree_features = live_tree_features(
                ratings, watches, searches, genres, vectors if isinstance(vectors, dict) else {},
                candidate_ids, now,
            )
        else:
            tree_features = (artifact or {}).get("tree_features_by_show")
        result = rank_recommendations(
            catalog=catalog,
            ratings=ratings,
            seen_show_ids=seen_show_ids,
            artifact=artifact,
            algorithm=algorithm,
            limit=limit,
            content_similarity=similarity,
            tree_features_by_show=tree_features,
            now=now,
            assigned_cluster=assigned_cluster,
        )
        return {
            **result,
            "algorithm": algorithm,
            "artifact_status": snapshot.status,
        }

    def _events(self, name: str, user_id: UUID) -> list[dict[str, Any]]:
        method = getattr(self.interaction_repository, name, None)
        if method is None:
            return []
        return list(method(user_id))

    def _read_catalog(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for offset in range(0, MAX_CATALOG_TITLES, CATALOG_PAGE_SIZE):
            page = list(self.catalog_repository.list_titles(limit=CATALOG_PAGE_SIZE, offset=offset))
            rows.extend(dict(row) for row in page)
            if len(page) < CATALOG_PAGE_SIZE:
                return rows
        raise ValueError("Active catalog exceeds the recommendation safety limit")
