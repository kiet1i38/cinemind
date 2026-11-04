import unittest

from cinemind.recommendations.core import rank_recommendations


# Minimal ready tree: a single always-taken leaf with 3 liked vs 1 disliked,
# so every show in tree_features_by_show resolves to p_like = 0.75.
TREE_MODEL = {
    "status": "ready",
    "features": ["f0"],
    "medians": [0.0],
    "nodes": [{"feature": -1, "values": [3, 1]}],
    "classes": ["liked", "disliked"],
}

# Every Drama candidate shares the seed's genre profile (rating 9 -> 0.8) and
# gets no similarity input, so its content blend is exactly 0.8 * 0 + 0.2 * 0.8.
CONTENT = 0.8 * 0.0 + 0.2 * 0.8

LIKED_RATING = [{"show_id": "seed", "rating": 9}]


def title(show_id, name, year, genres):
    return {
        "title_id": len(show_id),
        "show_id": show_id,
        "content_type": "Movie",
        "title": name,
        "description": None,
        "date_added": None,
        "release_year": year,
        "content_rating": None,
        "movie_duration_min": 100,
        "season_count": None,
        "duration_basis": "movie_runtime",
        "poster_provider": None,
        "poster_path": None,
        "poster_url": None,
        "poster_status": "missing",
        "genres": genres,
        "cast": [],
        "countries": [],
        "directors": [],
    }


def _artifact(popularity, *, item_scores=None):
    return {
        "schema_version": 1,
        "seed_status": "ready",
        "model_version": "week6-test",
        "popularity": popularity,
        "content_vectors": {},
        "tree_features_by_show": {},
        "cluster_model": None if item_scores is None else {
            "status": "ready",
            "features": ["Drama"],
            "centroids": [[0.8]],
            "item_scores": item_scores,
        },
        "tree_model": TREE_MODEL,
    }


class PerItemRenormalizedWeightsTests(unittest.TestCase):
    """Weights re-normalize per item over the components it actually has."""

    def _rank(self, shows, popularity, *, item_scores=None, tree_features=None, ratings=None):
        catalog = [title("seed", "Seed", 2026, ["Drama"])] + [
            title(show_id, name, year, ["Drama"]) for show_id, name, year in shows
        ]
        return rank_recommendations(
            catalog=catalog,
            ratings=LIKED_RATING if ratings is None else ratings,
            seen_show_ids={"seed"},
            artifact=_artifact(popularity, item_scores=item_scores),
            algorithm="hybrid",
            limit=10,
            tree_features_by_show=tree_features or {},
        )

    def test_item_missing_p_like_renormalizes_over_its_present_components(self):
        result = self._rank(
            shows=[("full", "Full Signals", 2025), ("sparse", "Sparse Signals", 2024)],
            popularity={"full": 1.0, "sparse": 0.9},
            item_scores={"0": {"full": 0.5, "sparse": 0.5}},
            tree_features={"full": [0.0]},
        )
        by_id = {row["title"]["show_id"]: row for row in result["items"]}

        expected = round((0.50 * 0.9 + 0.15 * CONTENT + 0.25 * 0.5) / (0.50 + 0.15 + 0.25), 6)
        self.assertEqual(by_id["sparse"]["score"], expected)
        self.assertIsNone(by_id["sparse"]["component_scores"]["p_like"])
        self.assertIn("Limited signals for this title", by_id["sparse"]["reasons"])
        self.assertNotIn("Limited signals for this title", by_id["full"]["reasons"])

    def test_strong_item_missing_p_like_still_outranks_weaker_item_with_p_like(self):
        result = self._rank(
            shows=[("strong", "Zeta", 2024), ("weak", "Alpha", 2025)],
            popularity={"strong": 1.0, "weak": 1.0},
            item_scores={"0": {"strong": 1.0, "weak": 0.85}},
            tree_features={"weak": [0.0]},
        )
        by_id = {row["title"]["show_id"]: row for row in result["items"]}

        strong = round((0.50 * 1.0 + 0.15 * CONTENT + 0.25 * 1.0) / (0.50 + 0.15 + 0.25), 6)
        weak = round(0.50 * 1.0 + 0.15 * CONTENT + 0.25 * 0.85 + 0.10 * 0.75, 6)
        # Both tie-breaks (year, then title) favor weak, so only a strictly
        # higher score can put strong first; deflating strong by the missing
        # 0.10 weight would rank weak above it.
        self.assertEqual([row["title"]["show_id"] for row in result["items"]], ["strong", "weak"])
        self.assertEqual(by_id["strong"]["score"], strong)
        self.assertEqual(by_id["weak"]["score"], weak)

    def test_item_missing_cluster_renormalizes_over_popularity_and_content(self):
        result = self._rank(
            shows=[("member", "Member", 2025), ("outsider", "Outsider", 2024)],
            popularity={"member": 0.4, "outsider": 0.6},
            item_scores={"0": {"member": 0.5}},
            tree_features={},
        )
        by_id = {row["title"]["show_id"]: row for row in result["items"]}

        self.assertIsNone(by_id["outsider"]["component_scores"]["cluster"])
        expected = round((0.50 * 0.6 + 0.15 * CONTENT) / (0.50 + 0.15), 6)
        self.assertEqual(by_id["outsider"]["score"], expected)
        self.assertEqual(by_id["member"]["component_scores"]["cluster"], 0.5)
        self.assertIn("Limited signals for this title", by_id["outsider"]["reasons"])

    def test_fully_covered_item_keeps_the_pool_normalized_weighted_sum(self):
        result = self._rank(
            shows=[("covered", "Covered", 2025)],
            popularity={"covered": 0.7},
            item_scores={"0": {"covered": 0.6}},
            tree_features={"covered": [0.0]},
        )
        row = result["items"][0]

        self.assertEqual(row["component_scores"]["p_like"], 0.75)
        expected = round(0.50 * 0.7 + 0.15 * CONTENT + 0.25 * 0.6 + 0.10 * 0.75, 6)
        self.assertEqual(row["score"], expected)
        self.assertNotIn("Limited signals for this title", row["reasons"])

    def test_pool_empty_component_is_dropped_and_remaining_weights_sum_to_one(self):
        result = self._rank(
            shows=[("x", "X", 2025), ("y", "Y", 2024)],
            popularity={"x": 0.8, "y": 0.4},
            item_scores=None,
            tree_features={"x": [0.0], "y": [0.0]},
        )
        by_id = {row["title"]["show_id"]: row for row in result["items"]}

        self.assertEqual(set(result["active_weights"]), {"popularity", "content", "p_like"})
        self.assertAlmostEqual(sum(result["active_weights"].values()), 1.0, places=12)
        expected = round((0.50 * 0.8 + 0.15 * CONTENT + 0.10 * 0.75) / (0.50 + 0.15 + 0.10), 6)
        self.assertEqual(by_id["x"]["score"], expected)
        self.assertNotIn("Limited signals for this title", by_id["x"]["reasons"])
        self.assertNotIn("Limited signals for this title", by_id["y"]["reasons"])

    def test_item_without_any_component_scores_zero_and_ranks_last(self):
        result = self._rank(
            shows=[
                ("known-a", "Known A", 2025),
                ("known-b", "Known B", 2024),
                ("unknown", "Unknown", 2023),
            ],
            popularity={"known-a": 0.9, "known-b": 0.5},
            item_scores=None,
            tree_features=None,
            # A real rating below the liked gate keeps content and p_like
            # pool-empty, so "unknown" genuinely has no component at all.
            ratings=[{"show_id": "seed", "rating": 5}],
        )
        rows = result["items"]

        self.assertEqual(
            [row["title"]["show_id"] for row in rows], ["known-a", "known-b", "unknown"]
        )
        self.assertEqual(rows[-1]["score"], 0.0)
        self.assertEqual(
            rows[-1]["reasons"], ["A catalog pick based on the available demo signals"]
        )

    def test_active_weights_stay_at_pool_level_when_p_like_is_sparse(self):
        result = self._rank(
            shows=[("full", "Full Signals", 2025), ("sparse", "Sparse Signals", 2024)],
            popularity={"full": 1.0, "sparse": 0.9},
            item_scores={"0": {"full": 0.5, "sparse": 0.5}},
            tree_features={"full": [0.0]},
        )

        self.assertEqual(
            result["active_weights"],
            {"popularity": 0.50, "content": 0.15, "cluster": 0.25, "p_like": 0.10},
        )


if __name__ == "__main__":
    unittest.main()
