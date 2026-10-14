"""Bounded golden fixtures and logical output reproducibility checks."""

import copy
import json
from pathlib import Path
import tempfile

from generate_week5_demo import RATING_FIELDS, WATCH_FIELDS, SEARCH_FIELDS, write_csv
from user_behavior_features import load_source, build_snapshot, build_user_matrix
from build_preference_dataset import sha256_file
from week5_artifacts import output_dir, write_json


def expect_error(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError("invalid fixture accepted")


def fixture_files(directory):
    catalog = [{"show_id": sid, "type": "Movie", "title_clean": sid,
                "description_clean": "fixture", "genres_clean": genres,
                "movie_duration_min": "90", "cleaning_status": "valid"}
               for sid, genres in (("a", "Action, Drama"), ("b", "Drama"), ("c", "Comedies"))]
    ratings = [{"target_key": key, "user_key": user, "cohort": "synthetic", "show_id": sid,
                "rating_value": value, "rated_at": when}
               for key, user, sid, value, when in (
                ("r1", "u", "a", "8", "2026-07-29T00:00:00Z"),
                ("r2", "u", "b", "8", "2026-07-29T00:00:00Z"),
                ("r3", "u", "a", "2", "2026-07-30T00:00:00Z"),
                ("r4", "future", "c", "8", "2026-08-01T00:00:00Z"))]
    watches = [{"watch_key": "w1", "user_key": "u", "cohort": "synthetic", "show_id": "a",
                "watch_seconds": "60", "completion_rate": "0.1", "duration_basis": "movie_minutes",
                "recorded_at": "2026-07-29T00:00:00Z", "is_repair": "true"}]
    searches = [{"search_key": f"s{i}", "user_key": owner, "cohort": "synthetic", "occurred_at": "2026-07-28T00:00:00Z"}
                for i, owner in enumerate(("NULL", "None", "\\N", "", "cold"))]
    paths = {key: directory / (key + ".csv") for key in ("catalog", "ratings", "watches", "searches")}
    for key, rows, fields in (("catalog", catalog, list(catalog[0])), ("ratings", ratings, RATING_FIELDS),
                              ("watches", watches, WATCH_FIELDS + ["is_repair"]), ("searches", searches, SEARCH_FIELDS)):
        write_csv(paths[key], fields, rows)
    manifest = {"cohort": "synthetic", "input_paths": {key: str(path) for key, path in paths.items()},
                "input_sha256": {key: sha256_file(path) for key, path in paths.items()}}
    write_json(directory / "source.json", manifest)
    return manifest, ratings, paths


def source_self_check():
    with tempfile.TemporaryDirectory(dir=output_dir("tmp/week5/checks")) as folder:
        directory = Path(folder)
        manifest, ratings, paths = fixture_files(directory)
        source = load_source(directory / "source.json")
        snapshot = build_snapshot(source, "synthetic", "2026-08-01T00:00:00Z")
        assert sorted(snapshot["users"]) == ["cold", "u"]
        assert snapshot["users"]["u"]["liked_ids"] == ["b"]
        assert snapshot["users"]["u"]["genre_shares"]["Drama"] == 1
        assert source["exclusions"]["searches_null_owner_rows_excluded"] == 4
        assert source["exclusions"]["repair_watch_rows_excluded"] == 1
        assert len(build_user_matrix(snapshot)["rows"]) == 1
        expect_error(lambda: build_snapshot(source, "team_test", "2026-08-01T00:00:00Z"))
        for extra in ({**ratings[0]}, {**ratings[0], "target_key": "conflict", "rating_value": "2"},
                      {**ratings[0], "target_key": "cohort", "cohort": "team_test"},
                      {**ratings[0], "target_key": "join", "show_id": "absent"}):
            write_csv(paths["ratings"], RATING_FIELDS, ratings + [extra])
            changed = copy.deepcopy(manifest)
            changed["input_sha256"]["ratings"] = sha256_file(paths["ratings"])
            write_json(directory / "source.json", changed)
            expect_error(lambda: load_source(directory / "source.json"))
        write_json(directory / "source.json", manifest)
        expect_error(lambda: load_source(directory / "source.json"))
    print("self-check ok: NULL/future/override/repair/duplicate/cohort/join/hash fixtures")


def logical_json(path):
    value = json.loads(Path(path).read_text())
    def scrub(node):
        if isinstance(node, dict):
            return {key: scrub(item) for key, item in node.items()
                    if key not in {"generated_at_utc", "generator_command", "builder_command", "manifest_path",
                                   "source_manifest", "fixed_train_cluster_run", "input_paths", "bundle_sha256"}}
        return [scrub(item) for item in node] if isinstance(node, list) else node
    return scrub(value)


def artifact_self_check():
    import week5_artifacts as artifacts
    source = {"hashes": {"catalog": "fixture"}, "genre_universe": ["Drama"]}
    cutoff = "2026-08-01T00:00:00Z"
    meta = {**artifacts.provenance(source, "synthetic"), "feature_version": "user_clusters-v1",
            "feature_order": ["genre_share__Drama", "log1p_unique_watched_titles_30d", "log1p_watch_event_rows_7d"],
            "trained_through": cutoff, "selected_through": cutoff}
    with tempfile.TemporaryDirectory(dir=output_dir("tmp/week5/checks")) as folder:
        directory = Path(folder)
        artifacts.save_bundle(directory, "user_clusters", {"fixture": 42}, meta)
        assert artifacts.load_bundle(directory, "user_clusters", source, "synthetic", cutoff, True)[0] == {"fixture": 42}
        path = directory / "user_clusters.json"
        valid = json.loads(path.read_text())
        original = artifacts.joblib.load
        def forbidden_load(_):
            raise AssertionError("unpickle happened before negative guard")
        artifacts.joblib.load = forbidden_load
        try:
            for key, value in (("cohort", "team_test"), ("schema_version", "old"),
                              ("input_sha256", {}), ("runtime", {}), ("feature_order", []),
                              ("feature_version", "old"), ("selected_through", "2026-08-02T00:00:00Z")):
                write_json(path, {**valid, key: value})
                expect_error(lambda: artifacts.load_bundle(directory, "user_clusters", source, "synthetic", cutoff, True))
            write_json(path, valid)
            expect_error(lambda: artifacts.load_bundle(directory, "user_clusters", source, "synthetic", cutoff, False))
            with (directory / "user_clusters.joblib").open("ab") as handle:
                handle.write(b"tampered")
            expect_error(lambda: artifacts.load_bundle(directory, "user_clusters", source, "synthetic", cutoff, True))
        finally:
            artifacts.joblib.load = original
    print("self-check ok: trusted roundtrip;9 negative guards before unpickle")


if __name__ == "__main__":
    source_self_check()
    artifact_self_check()
