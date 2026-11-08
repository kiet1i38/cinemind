#!/usr/bin/env python3
"""Train the Week 6 Decision Tree and K-means baseline and write JSON fragments.

The backend stays free of scikit-learn. This script fits both models on events
before the export cutoff, then writes the portable shapes prepare.py merges
into the recommendation artifact. A missing seed directory fails closed.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from kmeans import assign_clusters, fit_clusters
from decision_tree import chronological_split, classification_metrics, fit_preference_model, predict_liked
from preference_features import label_for
from hybrid_ranking import popularity_scores
from user_behavior_features import ROOT, build_snapshot, group_by_user
from week5_artifacts import TREE_FEATURES
from week6_tree_export import build_tree_model


BACKEND_SRC = ROOT / "backend" / "src"
COHORT = "synthetic"


def _backend():
    sys.path.insert(0, str(BACKEND_SRC))
    from cinemind.recommendations.baseline_features import (
        CLUSTER_SPACE,
        TREE_BASE_FEATURES,
        assign_scaled_cluster,
        cluster_vector,
        equal_weight_similarity,
        tree_feature_rows,
        user_profile,
    )
    from cinemind.recommendations.core import _tree_probability

    return {
        "space": CLUSTER_SPACE,
        "features": TREE_BASE_FEATURES,
        "assign": assign_scaled_cluster,
        "vector": cluster_vector,
        "similarity": equal_weight_similarity,
        "rows": tree_feature_rows,
        "profile": user_profile,
        "probability": _tree_probability,
    }


def _aware(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _read_json(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("catalog json must be a list")
    return payload


def _genres(record: dict) -> set[str]:
    listed = record.get("listedIn")
    if isinstance(listed, str):
        return {part.strip() for part in listed.split(",") if part.strip()}
    if isinstance(listed, list):
        return {str(part).strip() for part in listed if str(part).strip()}
    return set()


def _catalog(records: list[dict]) -> tuple[dict, dict, list]:
    genres = {}
    for record in records:
        show_id = str(record.get("id") or record.get("show_id") or "").strip()
        if not show_id:
            raise ValueError("catalog record is missing an id")
        genres[show_id] = _genres(record)
    universe = sorted({genre for values in genres.values() for genre in values})
    return {show_id: {"show_id": show_id} for show_id in genres}, genres, universe


def _source(ratings, watches, searches, genres, universe) -> dict:
    return {
        "catalog_genres": genres,
        "genre_universe": universe,
        "ratings_by_user": group_by_user(ratings),
        "watches_by_user": group_by_user(watches),
        "searches_by_user": group_by_user(searches),
        "ratings": ratings,
        "watches": watches,
        "searches": searches,
        "cohort": COHORT,
        "coverage": {},
    }


def _training_rows(source, vectors, helpers, cutoff: datetime) -> list[dict]:
    rows = []
    for event in source["ratings"]:
        if event["event_time"] >= cutoff or event["label"] is None:
            continue
        snapshot = build_snapshot(source, COHORT, event["event_time"])
        user = snapshot["users"].get(event["user_key"])
        if user is None:
            continue
        content = helpers["similarity"](user["liked_ids"], vectors)
        features = helpers["rows"](user, snapshot["catalog_genres"], [event["show_id"]], content)
        row = {name: features[event["show_id"]][index] for index, name in enumerate(TREE_FEATURES)}
        row.update({"label": event["label"], "rated_at": event["event_time"], "show_id": event["show_id"]})
        rows.append(row)
    return rows


def _cluster_fragment(snapshot, bundle, report) -> dict:
    helpers = _backend()
    assignments = assign_clusters(snapshot, bundle)
    members = defaultdict(list)
    for row in assignments:
        if row["cluster_id"] is not None:
            members[int(row["cluster_id"])].append(row["user_key"])
    item_scores = {}
    for cluster_id, users in sorted(members.items()):
        scores = popularity_scores(snapshot, users) or {}
        item_scores[str(cluster_id)] = {show_id: float(score) for show_id, score in scores.items()}
    scaler, model = bundle["scaler"], bundle["model"]
    return {
        "cluster_model": {
            "status": "ready",
            "space": helpers["space"],
            "features": list(bundle["feature_order"]),
            "means": [float(value) for value in scaler.mean_],
            "scales": [float(value) if float(value) else 1.0 for value in scaler.scale_],
            "centroids": [[float(value) for value in row] for row in model.cluster_centers_],
            "item_scores": item_scores,
            "history_days": int(snapshot["history_days"]),
            "recent_days": int(snapshot["recent_days"]),
            "selected_k": int(bundle["k"]),
            "signal_eligible": bool(bundle.get("signal_eligible")),
            "metrics": {
                "silhouette": report["selection_detail"].get("silhouette"),
                "median_pairwise_ari": report["selection_detail"].get("median_pairwise_ari"),
                "cluster_counts": report["selection_detail"].get("cluster_counts"),
            },
        }
    }


def _fit_tree(rows: list[dict]):
    split = chronological_split(rows)
    if split is None:
        raise ValueError("baseline tree needs at least three distinct rating times")
    train, validation, test = split
    if not train or not validation:
        raise ValueError("baseline tree needs non-empty train and validation splits")
    bundle, report = fit_preference_model(train, validation)
    metrics = None
    if test:
        from decision_tree import matrix
        import numpy

        _, encoded = matrix(test, TREE_FEATURES, bundle["medians"])
        predicted = [str(value) for value in bundle["tree"].predict(numpy.asarray(encoded, dtype=float))]
        metrics = classification_metrics([row["label"] for row in test], predicted)
    return bundle, report, metrics, {"train": len(train), "validation": len(validation), "test": len(test)}


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def _fixture_source():
    start = _aware("2026-03-01T00:00:00+00:00")
    genres = {"a1": {"Action"}, "a2": {"Action"}, "d1": {"Drama"}, "d2": {"Drama"}}
    universe = ["Action", "Drama"]

    def rating(user, show, value, day):
        moment = start + timedelta(days=day)
        return {
            "target_key": f"{user}-{show}-{day}", "user_key": user, "cohort": COHORT, "show_id": show,
            "event_time": moment, "rating_value": value, "label": label_for(value, "fixture"),
        }

    ratings = [
        rating("u1", "a1", "9", 1), rating("u2", "d1", "9", 2), rating("u3", "a2", "8", 3),
        rating("u1", "d1", "2", 4), rating("u2", "a1", "8", 5), rating("u3", "d2", "4", 6),
        rating("u1", "a2", "9", 7), rating("u2", "d2", "8", 8), rating("u3", "a1", "2", 9),
    ]
    watches = [{
        "watch_key": "w1", "user_key": "u1", "cohort": COHORT, "show_id": "a1",
        "event_time": start + timedelta(days=1, hours=2), "watch_seconds": 60.0,
        "completion_rate": 1.0, "duration_basis": "movie_minutes",
    }]
    return _source(ratings, watches, [], genres, universe), start + timedelta(days=12)


def _parity(source, snapshot, bundle, tree_bundle, vectors) -> None:
    helpers = _backend()
    user = snapshot["users"]["u1"]
    events = _serving_events(source, "u1")
    profile = helpers["profile"](
        events["ratings"], events["watches"], [], source["catalog_genres"], snapshot["genre_universe"],
        _aware(snapshot["cutoff"]), history_days=snapshot["history_days"], recent_days=snapshot["recent_days"],
    )
    assert profile["liked_ids"] == user["liked_ids"], (profile["liked_ids"], user["liked_ids"])
    assert profile["watch_event_rows_7d"] == user["watch_event_rows_7d"]
    assert profile["unique_watched_titles_30d"] == user["unique_watched_titles_30d"]
    assert abs(profile["days_since_last_interaction"] - user["days_since_last_interaction"]) < 1e-9
    for genre, share in user["genre_shares"].items():
        assert abs(profile["genre_shares"][genre] - share) < 1e-9
    model = _cluster_fragment(snapshot, bundle, {"selection_detail": {
        "silhouette": None, "median_pairwise_ari": None, "cluster_counts": bundle["cluster_counts"],
    }})["cluster_model"]
    got = helpers["assign"](helpers["vector"](profile, model["features"]), model)
    expected = next(row["cluster_id"] for row in assign_clusters(snapshot, bundle) if row["user_key"] == "u1")
    assert got == expected, (got, expected)
    content = helpers["similarity"](user["liked_ids"], vectors)
    rows = helpers["rows"](user, source["catalog_genres"], ["d1"], content)
    probability = helpers["probability"](rows["d1"], build_tree_model(tree_bundle))
    trained = predict_liked(tree_bundle, [{name: rows["d1"][index] for index, name in enumerate(TREE_FEATURES)}])
    assert probability is not None and trained and abs(probability - trained[0]) < 1e-9


def _serving_events(source, user_key) -> dict:
    ratings = [
        {"show_id": event["show_id"], "rating": event["rating_value"], "event_at": event["event_time"]}
        for event in source["ratings"] if event["user_key"] == user_key
    ]
    watches = [
        {"show_id": event["show_id"], "event_at": event["event_time"]}
        for event in source["watches"] if event["user_key"] == user_key
    ]
    return {"ratings": ratings, "watches": watches}


def self_check() -> None:
    source, cutoff = _fixture_source()
    snapshot = build_snapshot(source, COHORT, cutoff)
    bundle, report = fit_clusters(snapshot)
    if bundle is None:
        raise SystemExit("self-check could not fit a cluster model")
    vectors = {
        "a1": {"action": 1.0},
        "a2": {"action": 0.8, "fun": 0.6},
        "d1": {"drama": 1.0},
        "d2": {"drama": 0.6, "quiet": 0.8},
    }
    rows = _training_rows(source, vectors, _backend(), cutoff)
    tree_bundle, tree_report, metrics, sizes = _fit_tree(rows)
    _parity(source, snapshot, bundle, tree_bundle, vectors)
    print(
        "self-check ok: "
        f"k={bundle['k']} tree={tree_bundle['selected_name']} "
        f"splits={sizes} metrics={None if metrics is None else metrics['test_metrics']['macro_f1']}"
    )
    assert tree_report["criterion"] == "entropy"
    assert list(TREE_FEATURES) == list(_backend()["features"])


def _csv_rows(path: Path) -> list[dict]:
    import csv

    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _seed_source(seed_dir: Path, catalog_path: Path):
    context = _csv_rows(seed_dir / "week6_export_context.csv")
    if len(context) != 1:
        raise ValueError("export context must contain one row")
    cutoff = _aware(context[0]["export_cutoff"])
    mapped = {row["user_key"] for row in _csv_rows(seed_dir / "week6_cohort_map.csv") if row.get("cohort") == COHORT}
    _, genres, universe = _catalog(_read_json(catalog_path))
    ratings, watches, searches = [], [], []
    for row in _csv_rows(seed_dir / "ratings.csv"):
        if row["user_key"] not in mapped:
            continue
        moment = _aware(row["rated_at"])
        if moment >= cutoff or row["rating_value"].strip() in {"0", "0.0"}:
            continue
        try:
            label = label_for(row["rating_value"], "ratings")
        except ValueError:
            continue
        if row["show_id"] not in genres:
            raise ValueError("rating show_id is absent from the catalog")
        ratings.append({
            "target_key": row["target_key"], "user_key": row["user_key"], "cohort": COHORT,
            "show_id": row["show_id"], "event_time": moment, "rating_value": row["rating_value"], "label": label,
        })
    for row in _csv_rows(seed_dir / "watches_for_mining.csv"):
        if row["user_key"] not in mapped or row["show_id"] not in genres:
            continue
        moment = _aware(row["recorded_at"])
        if moment >= cutoff:
            continue
        watches.append({
            "watch_key": row["watch_key"], "user_key": row["user_key"], "cohort": COHORT,
            "show_id": row["show_id"], "event_time": moment, "watch_seconds": float(row["watch_seconds"] or 0),
            "completion_rate": None, "duration_basis": "movie_minutes",
        })
    for row in _csv_rows(seed_dir / "searches.csv"):
        if row["user_key"] not in mapped:
            continue
        moment = _aware(row["occurred_at"])
        if moment >= cutoff:
            continue
        searches.append({"search_key": row["search_key"], "user_key": row["user_key"], "cohort": COHORT, "event_time": moment})
    return _source(ratings, watches, searches, genres, universe), cutoff, _content_vectors(_read_json(catalog_path))


def _content_vectors(records: list[dict]) -> dict:
    sys.path.insert(0, str(BACKEND_SRC))
    from cinemind.recommendations.prepare import _content_vectors as build_vectors

    catalog = {}
    for record in records:
        show_id = str(record.get("id") or record.get("show_id") or "").strip()
        if show_id:
            catalog[show_id] = record
    return build_vectors(catalog)


def export_baseline(seed_dir: Path, catalog_path: Path, output_dir: Path) -> dict:
    if not seed_dir.is_dir():
        raise SystemExit(f"missing Week 6 seed directory: {seed_dir}")
    source, cutoff, vectors = _seed_source(seed_dir, catalog_path)
    snapshot = build_snapshot(source, COHORT, cutoff)
    bundle, report = fit_clusters(snapshot)
    if bundle is None:
        raise SystemExit(f"cluster baseline was not fit: {report.get('reason')}")
    rows = _training_rows(source, vectors, _backend(), cutoff)
    tree_bundle, tree_report, metrics, sizes = _fit_tree(rows)
    tree_payload = {"tree_model": build_tree_model(tree_bundle), "tree_features_by_show": {}}
    cluster_payload = _cluster_fragment(snapshot, bundle, report)
    evidence = {
        "evidence_status": "baseline_not_holdout",
        "cohort": COHORT,
        "cutoff": snapshot["cutoff"],
        "splits": sizes,
        "tree": {"selected": tree_bundle["selected_name"], "validation_macro_f1": tree_bundle["validation_macro_f1"]},
        "cluster": cluster_payload["cluster_model"]["metrics"],
        "test_metrics": None if metrics is None else metrics["test_metrics"],
        "tree_rows": len(rows),
        "selection_metric": tree_report["selection_metric"],
    }
    _write(output_dir / "tree_fragment.json", tree_payload)
    _write(output_dir / "cluster_fragment.json", cluster_payload)
    _write(output_dir / "baseline_metrics.json", evidence)
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--seed-dir", type=Path, default=ROOT / "tmp" / "week6" / "seed")
    parser.add_argument("--catalog", type=Path, default=ROOT / "frontend" / "public" / "data" / "catalog.json")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "tmp" / "week6" / "baseline")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    evidence = export_baseline(args.seed_dir, args.catalog, args.output_dir)
    print(
        "baseline export "
        f"status={evidence['evidence_status']} rows={evidence['tree_rows']} "
        f"k_metrics={evidence['cluster']} tree={evidence['tree']}"
    )


if __name__ == "__main__":
    main()
