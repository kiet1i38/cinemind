import json
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from cinemind.recommendations.artifacts import (
    RecommendationArtifactStore,
    _validate_artifact,
    seal_artifact,
)
from cinemind.recommendations.core import _tree_probability
from cinemind.recommendations.service import RecommendationService


def catalog_title(show_id, year=2025):
    return {
        "show_id": show_id,
        "title": show_id,
        "release_year": year,
        "genres": ["Drama"],
    }


def valid_tree_model():
    return {
        "status": "ready",
        "features": ["watch_ratio"],
        "classes": ["liked", "disliked"],
        "medians": [0.5],
        "nodes": [
            {"feature": 0, "threshold": 0.5, "left": 1, "right": 2},
            {"feature": -1, "values": [3, 1]},
            {"feature": -1, "values": [1, 3]},
        ],
    }


def tree_artifact(tree_model, tree_features_by_show=None):
    return {
        "schema_version": 1,
        "seed_status": "ready",
        "model_version": "week6-tree-test",
        "popularity": {},
        "content_vectors": {},
        "tree_features_by_show": {} if tree_features_by_show is None else tree_features_by_show,
        "cluster_model": None,
        "tree_model": tree_model,
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


def seal_to_path(artifact, directory):
    path = Path(directory) / "artifact.json"
    path.write_text(json.dumps(seal_artifact(artifact)), encoding="utf-8")
    return path


class TreeModelArtifactTests(unittest.TestCase):
    def _load(self, artifact):
        with tempfile.TemporaryDirectory() as temporary:
            return RecommendationArtifactStore(seal_to_path(artifact, temporary)).load()

    def _assert_invalid(self, artifact):
        snapshot = self._load(artifact)
        self.assertEqual(snapshot.status, "invalid", snapshot.reason)
        self.assertIsNone(snapshot.artifact)
        return snapshot

    def test_branching_node_without_children_is_rejected_before_serving(self):
        # Verified repro: a node that branches but carries no left/right child
        # passed the old shallow object check and raised KeyError at serving.
        model = valid_tree_model()
        model["nodes"] = [{"feature": 0, "threshold": 0.5}]
        with tempfile.TemporaryDirectory() as temporary:
            store = RecommendationArtifactStore(seal_to_path(tree_artifact(model, {"show-1": [0.4]}), temporary))
            snapshot = store.load()
            self.assertEqual(snapshot.status, "invalid")
            service = RecommendationService(
                StubCatalogRepository([catalog_title("show-1")]),
                StubInteractionRepository(
                    ratings=[{"show_id": "show-0", "rating": 9, "event_at": "2026-10-16T00:00:00+00:00"}]
                ),
                store,
            )
            result = service.recommend(user_id=UUID(int=1), algorithm="hybrid", limit=5)

        self.assertEqual(result["items"][0]["title"]["show_id"], "show-1")
        self.assertEqual(result["artifact_status"], "invalid")

    def test_feature_index_out_of_range_is_rejected(self):
        model = valid_tree_model()
        model["nodes"][0]["feature"] = 1
        self._assert_invalid(tree_artifact(model))

    def test_threshold_must_be_present_numeric_and_finite(self):
        for case in ("absent", "null", "string", "boolean"):
            model = valid_tree_model()
            if case == "absent":
                del model["nodes"][0]["threshold"]
            elif case == "null":
                model["nodes"][0]["threshold"] = None
            elif case == "string":
                model["nodes"][0]["threshold"] = "high"
            else:
                model["nodes"][0]["threshold"] = True
            self._assert_invalid(tree_artifact(model))
        # Infinity cannot travel through seal_artifact's canonical JSON dump,
        # so the finiteness branch is checked on the validator directly.
        model = valid_tree_model()
        model["nodes"][0]["threshold"] = float("inf")
        self.assertEqual(
            _validate_artifact(tree_artifact(model)),
            "tree_model node threshold must be a finite number",
        )

    def test_child_references_must_be_in_range_integers(self):
        for child in (3, -1, "1", 1.0, True):
            model = valid_tree_model()
            model["nodes"][0]["left"] = child
            self._assert_invalid(tree_artifact(model))
        model = valid_tree_model()
        model["nodes"][0]["right"] = 99
        self._assert_invalid(tree_artifact(model))

    def test_leaf_values_must_match_classes_and_be_positive_counts(self):
        for values in ([1], ["liked", 1], [-1, 2], [0, 0], [True, 1]):
            model = valid_tree_model()
            model["nodes"][1]["values"] = values
            self._assert_invalid(tree_artifact(model))

    def test_medians_must_align_with_features(self):
        model = valid_tree_model()
        model["medians"] = [0.5, 0.25]
        self._assert_invalid(tree_artifact(model))

    def test_classes_must_be_non_empty_unique_and_include_liked(self):
        for classes in ([], ["liked", "liked"], ["disliked", "neutral"]):
            model = valid_tree_model()
            model["classes"] = classes
            self._assert_invalid(tree_artifact(model))

    def test_disabled_tree_model_is_accepted_and_reports_p_like_disabled(self):
        artifact = tree_artifact({"status": "disabled"})
        self.assertEqual(self._load(artifact).status, "ready")
        with tempfile.TemporaryDirectory() as temporary:
            service = RecommendationService(
                StubCatalogRepository([]),
                StubInteractionRepository(),
                RecommendationArtifactStore(seal_to_path(artifact, temporary)),
            )
            status = service.status()

        self.assertEqual(status["artifact_status"], "ready")
        self.assertEqual(status["components"]["p_like"], "disabled")

    def test_tree_feature_rows_must_match_tree_width_when_ready(self):
        model = valid_tree_model()
        self._assert_invalid(tree_artifact(model, {"show-1": [0.4, 0.9]}))
        self._assert_invalid(tree_artifact(model, {"show-1": ["high"]}))
        self._assert_invalid(tree_artifact(model, {"show-1": [True]}))
        self.assertEqual(self._load(tree_artifact(model, {"show-1": [None]})).status, "ready")

        # Rows cover the base features only; indicator columns are absent.
        wide = valid_tree_model()
        wide["features"] = ["watch_ratio", "is_missing"]
        wide["medians"] = [0.5, 0.0]
        wide["missing_indicator_count"] = 1
        self.assertEqual(self._load(tree_artifact(wide, {"show-1": [0.4]})).status, "ready")
        self._assert_invalid(tree_artifact(wide, {"show-1": [0.4, 0.0]}))

    def test_not_ready_tree_model_skips_row_width_check(self):
        self.assertEqual(
            self._load(tree_artifact({"status": "disabled"}, {"show-1": [0.4, 0.9]})).status,
            "ready",
        )


class TreeProbabilityCycleTests(unittest.TestCase):
    def test_cyclic_node_graph_with_valid_indices_returns_none(self):
        model = {
            "status": "ready",
            "features": ["watch_ratio"],
            "classes": ["liked", "disliked"],
            "medians": [0.5],
            "nodes": [
                {"feature": 0, "threshold": 1.0, "left": 0, "right": 0},
                {"feature": -1, "values": [3, 1]},
            ],
        }

        self.assertIsNone(_tree_probability([0.4], model))


if __name__ == "__main__":
    unittest.main()
