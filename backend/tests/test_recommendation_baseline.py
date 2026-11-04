import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from cinemind.recommendations.artifacts import RecommendationArtifactStore, seal_artifact
from cinemind.recommendations.baseline_features import TREE_BASE_FEATURES, baseline_readiness
from cinemind.recommendations.service import RecommendationService


def title(show_id, name, genres):
    return {
        "show_id": show_id,
        "title": name,
        "release_year": 2024,
        "genres": genres,
        "content_type": "Movie",
    }


def tree_model():
    base = list(TREE_BASE_FEATURES)
    return {
        "status": "ready",
        "features": base + [f"{name}__missing" for name in base],
        "medians": [0.0] * (len(base) * 2),
        "missing_indicator_count": len(base),
        "classes": ["liked", "disliked"],
        "nodes": [
            {"feature": 1, "threshold": 0.5, "left": 1, "right": 2},
            {"feature": -1, "values": [0, 1]},
            {"feature": -1, "values": [1, 0]},
        ],
    }


def cluster_model():
    return {
        "status": "ready",
        "space": "scaled_genre_share_v1",
        "features": [
            "genre_share__Action",
            "genre_share__Drama",
            "log1p_unique_watched_titles_30d",
            "log1p_watch_event_rows_7d",
        ],
        "means": [0.0, 0.0, 0.0, 0.0],
        "scales": [1.0, 1.0, 1.0, 1.0],
        "centroids": [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]],
        "item_scores": {
            "0": {"action-pick": 0.9, "drama-pick": 0.1},
            "1": {"action-pick": 0.1, "drama-pick": 0.9},
        },
        "history_days": 30,
        "recent_days": 7,
    }


class StubCatalog:
    def __init__(self, rows):
        self.rows = rows

    def list_titles(self, *, limit, offset):
        return self.rows[offset : offset + limit]


class StubHistory:
    def __init__(self, ratings):
        self.ratings = tuple(ratings)

    def interaction_state(self, *, session_id=None, user_id=None):
        return {"ratings": self.ratings}

    def seen_show_ids(self, user_id):
        return frozenset()

    def watch_events(self, user_id):
        return ()

    def search_events(self, user_id):
        return ()


class BaselineReadinessTests(unittest.TestCase):
    def test_ready_requires_the_roster_and_both_models(self):
        self.assertEqual(baseline_readiness(True, False), ("degraded", "demo_only", "week6-tfidf-popularity-v2"))
        self.assertEqual(
            baseline_readiness(False, True),
            ("degraded", "baseline_not_holdout", "week6-baseline-v1"),
        )
        self.assertEqual(
            baseline_readiness(True, True),
            ("ready", "baseline_not_holdout", "week6-baseline-v1"),
        )


class LiveBaselineTests(unittest.TestCase):
    def _service(self, ratings):
        artifact = {
            "schema_version": 1,
            "seed_status": "ready",
            "model_version": "week6-baseline-v1",
            "evidence_status": "baseline_not_holdout",
            "popularity": {"action-pick": 0.2, "drama-pick": 0.2},
            "content_vectors": {
                "liked-action": {"action": 1.0},
                "action-pick": {"action": 1.0},
                "liked-drama": {"drama": 1.0},
                "drama-pick": {"drama": 1.0},
            },
            "tree_features_by_show": {"action-pick": [0.0] * 6},
            "cluster_model": cluster_model(),
            "tree_model": tree_model(),
            "disabled_components": {},
        }
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "artifact.json"
        path.write_text(json.dumps(seal_artifact(artifact)), encoding="utf-8")
        catalog = [
            title("action-pick", "Action Pick", ["Action"]),
            title("drama-pick", "Drama Pick", ["Drama"]),
            title("liked-action", "Liked Action", ["Action"]),
            title("liked-drama", "Liked Drama", ["Drama"]),
        ]
        return RecommendationService(
            StubCatalog(catalog),
            StubHistory(ratings),
            RecommendationArtifactStore(path),
        )

    def test_cluster_and_preference_follow_the_signed_in_user(self):
        now = "2026-10-16T00:00:00+00:00"
        action_user = self._service([
            {"show_id": "liked-action", "rating": 9, "event_at": now},
        ])
        drama_user = self._service([
            {"show_id": "liked-drama", "rating": 9, "event_at": now},
        ])

        action = action_user.recommend(user_id=UUID(int=1), algorithm="cluster", limit=5)
        drama = drama_user.recommend(user_id=UUID(int=2), algorithm="cluster", limit=5)
        preference = action_user.recommend(user_id=UUID(int=1), algorithm="p_like", limit=5)
        status = action_user.status()

        self.assertEqual(action["items"][0]["title"]["show_id"], "action-pick")
        self.assertEqual(drama["items"][0]["title"]["show_id"], "drama-pick")
        by_id = {row["title"]["show_id"]: row for row in preference["items"]}
        self.assertEqual(by_id["action-pick"]["component_scores"]["p_like"], 1.0)
        self.assertEqual(by_id["drama-pick"]["component_scores"]["p_like"], 0.0)
        self.assertEqual(status["components"]["cluster"], "ready")
        self.assertEqual(status["components"]["p_like"], "ready")
        self.assertEqual(preference["evidence_status"], "baseline_not_holdout")

    def test_static_tree_table_is_not_the_live_score(self):
        service = self._service([
            {"show_id": "liked-action", "rating": 9, "event_at": datetime(2026, 10, 16, tzinfo=timezone.utc)},
        ])
        result = service.recommend(user_id=UUID(int=1), algorithm="p_like", limit=5)
        by_id = {row["title"]["show_id"]: row for row in result["items"]}
        # The frozen table would have scored action-pick from six zeros.
        # The live genre affinity of an Action profile is 1, so P(like) is 1.
        self.assertEqual(by_id["action-pick"]["component_scores"]["p_like"], 1.0)
