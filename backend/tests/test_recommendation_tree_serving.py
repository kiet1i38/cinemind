import json
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from cinemind.recommendations.artifacts import RecommendationArtifactStore, seal_artifact
from cinemind.recommendations.core import _tree_probability
from cinemind.recommendations.service import RecommendationService


def catalog_title(show_id, year=2025):
    return {
        "show_id": show_id,
        "title": show_id,
        "release_year": year,
        "genres": ["Drama"],
    }


# One raw feature plus its __missing indicator; a single always-taken leaf
# with 3 liked vs 1 disliked, so every row resolves to p_like = 0.75.
INDICATOR_TREE_MODEL = {
    "status": "ready",
    "features": ["f0", "f0__missing"],
    "medians": [0.5, 0.0],
    "missing_indicator_count": 1,
    "nodes": [{"feature": -1, "values": [3, 1]}],
    "classes": ["liked", "disliked"],
}


class StubCatalogRepository:
    def __init__(self, rows):
        self.rows = rows

    def list_titles(self, *, limit, offset):
        return self.rows[offset : offset + limit]


class StubInteractionRepository:
    def __init__(self, ratings=(), seen=()):
        self.ratings = tuple(ratings)
        self.seen = frozenset(seen)

    def interaction_state(self, *, session_id=None, user_id=None):
        return {"ratings": self.ratings}

    def seen_show_ids(self, user_id):
        return self.seen


class TreeServingEndToEndTests(unittest.TestCase):
    def test_missing_value_row_serves_p_like_through_median_and_indicator(self):
        artifact = {
            "schema_version": 1,
            "seed_status": "ready",
            "model_version": "week6-tree-serving-test",
            "popularity": {},
            "content_vectors": {},
            "tree_features_by_show": {"a": [0.9], "b": [None]},
            "cluster_model": None,
            "tree_model": INDICATOR_TREE_MODEL,
            "disabled_components": {"cluster": "not_enabled_without_validated_week5_cluster_artifact"},
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact.json"
            path.write_text(json.dumps(seal_artifact(artifact)), encoding="utf-8")
            store = RecommendationArtifactStore(path)
            service = RecommendationService(
                StubCatalogRepository([catalog_title("a"), catalog_title("b")]),
                StubInteractionRepository(
                    ratings=[{"show_id": "seed", "rating": 9, "event_at": "2026-10-16T00:00:00+00:00"}],
                    seen={"seed"},
                ),
                store,
            )
            status = service.status()
            result = service.recommend(user_id=UUID(int=1), algorithm="hybrid", limit=5)

        self.assertEqual(status["components"]["p_like"], "ready")
        by_id = {row["title"]["show_id"]: row for row in result["items"]}
        self.assertEqual(by_id["a"]["component_scores"]["p_like"], 0.75)
        # "b" reaches the same leaf via median impute plus an indicator of 1.0.
        self.assertEqual(by_id["b"]["component_scores"]["p_like"], 0.75)


class IndicatorColumnTests(unittest.TestCase):
    def test_indicator_reads_the_original_value_not_the_imputed_median(self):
        model = {
            "status": "ready",
            "features": ["f0", "f0__missing"],
            "medians": [0.5, 0.0],
            "missing_indicator_count": 1,
            "nodes": [
                {"feature": 1, "threshold": 0.5, "left": 1, "right": 2},
                {"feature": -1, "values": [1, 0]},
                {"feature": -1, "values": [0, 1]},
            ],
            "classes": ["liked", "disliked"],
        }

        # The branch is on the indicator column: 0.5 is a real value that
        # merely equals the median and must classify as present, while only
        # None flips the indicator to 1.0.
        self.assertEqual(_tree_probability([0.5], model), 1.0)
        self.assertEqual(_tree_probability([0.9], model), 1.0)
        self.assertEqual(_tree_probability([None], model), 0.0)
        # Rows cover the base features only; supplying the indicator is rejected.
        self.assertIsNone(_tree_probability([0.5, 0.0], model))
        self.assertIsNone(_tree_probability([0.5, 0.0, 1.0], model))


if __name__ == "__main__":
    unittest.main()
