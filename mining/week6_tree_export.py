#!/usr/bin/env python3
"""Export the validated Week 5 preference tree as a Week 6 serving fragment.

Walks the checksummed preference_ranker joblib bundle into the pure-JSON
tree_model shape the stdlib backend serves, plus a tree_features_by_show
reference table for one demo user seed.  That table is a single-user demo
reference; live per-user feature computation stays a serving-side concern.

The backend is imported only inside self_check(): this module otherwise
depends on the mining stack (numpy/sklearn/joblib).
"""

import argparse
import sys
from pathlib import Path

from pre_rec_tree import fit_preference_model, predict_liked
from preference_features import LABELS
from ranking_scores import build_content_context, candidate_pool, content_scores
from user_behavior_features import (
    ROOT,
    build_candidate_features,
    build_snapshot,
    load_source,
    week5_output_path,
)
from week5_artifacts import TREE_FEATURES, load_bundle, write_json

BUNDLE_NAME = "preference_ranker"
BACKEND_SRC = ROOT / "backend" / "src"
PARITY_TOLERANCE = 1e-9


def tree_nodes(estimator):
    """Flatten the sklearn tree_ arrays into JSON-safe backend nodes."""
    tree = estimator.tree_
    nodes = []
    for index in range(int(tree.node_count)):
        if int(tree.children_left[index]) == -1:
            nodes.append({
                "feature": -1,
                "values": [float(value) for value in tree.value[index][0]],
            })
        else:
            nodes.append({
                "feature": int(tree.feature[index]),
                "threshold": float(tree.threshold[index]),
                "left": int(tree.children_left[index]),
                "right": int(tree.children_right[index]),
            })
    return nodes


def build_tree_model(bundle):
    """Backend tree_model: base features plus __missing indicators, never NaN."""
    feature_order = bundle["feature_order"]
    indicator_count = len(bundle["model_feature_order"]) - len(feature_order)
    medians = [float(bundle["medians"][name]) for name in feature_order]
    return {
        "status": "ready",
        "features": [str(name) for name in bundle["model_feature_order"]],
        "medians": medians + [0.0] * indicator_count,
        "missing_indicator_count": indicator_count,
        "nodes": tree_nodes(bundle["tree"]),
        "classes": [str(label) for label in bundle["classes"]],
    }


def build_tree_features(snapshot, user_key, candidate_ids, content):
    """Raw six-feature rows per candidate; None stays None, never imputed."""
    features = build_candidate_features(snapshot, user_key, candidate_ids, content or {})
    return {
        show_id: [features[show_id][name] for name in TREE_FEATURES]
        for show_id in candidate_ids
    }


def export_fragment(run_dir, source_manifest, cohort, cutoff, user_key):
    """Load the guarded bundle and derive both fragment halves."""
    source = load_source(source_manifest)
    bundle, _metadata = load_bundle(run_dir, BUNDLE_NAME, source, cohort, cutoff, trusted=True)
    snapshot = build_snapshot(source, cohort, cutoff)
    if user_key not in snapshot["users"]:
        raise ValueError(f"user {user_key} is absent from the {cohort} snapshot at {cutoff}")
    context = build_content_context(source)
    candidate_ids = candidate_pool(snapshot, user_key)
    content = content_scores(snapshot, user_key, context)
    return {
        "tree_model": build_tree_model(bundle),
        "tree_features_by_show": build_tree_features(snapshot, user_key, candidate_ids, content),
    }


def _backend_probability():
    sys.path.insert(0, str(BACKEND_SRC))
    from cinemind.recommendations.core import _tree_probability

    return _tree_probability


def _row(label, **overrides):
    row = {name: 0.5 for name in TREE_FEATURES}
    row.update(overrides)
    row["label"] = label
    return row


def _signal_rows(signals, count=30):
    return [_row(LABELS[index % len(LABELS)], content_profile_similarity=signals[LABELS[index % len(LABELS)]])
            for index in range(count)]


def _check_model_shape(bundle, tree_model):
    indicators = len(TREE_FEATURES)
    assert tree_model["missing_indicator_count"] == indicators
    assert tree_model["features"] == list(TREE_FEATURES) + [f"{name}__missing" for name in TREE_FEATURES]
    assert tree_model["medians"] == [bundle["medians"][name] for name in TREE_FEATURES] + [0.0] * indicators
    assert tree_model["classes"] == list(bundle["classes"])
    assert tree_model["nodes"] and all(
        len(node["values"]) == len(tree_model["classes"])
        for node in tree_model["nodes"]
        if node["feature"] < 0
    )


def _check_backend_parity(tree_model, bundle, rows, tree_probability):
    expected = predict_liked(bundle, rows)
    assert expected is not None
    for row, want in zip(rows, expected):
        got = tree_probability([row[name] for name in TREE_FEATURES], tree_model)
        assert got is not None and abs(got - want) < PARITY_TOLERANCE, (got, want)


def _fixture_snapshot():
    return {
        "catalog_genres": {"a": {"Action", "Drama"}, "b": {"Drama"}, "c": {"Comedies"}},
        "users": {"u1": {"genre_shares": {"Action": 0.5, "Drama": 0.5}, "watch_event_rows_7d": 2,
                         "unique_watched_titles_30d": 3, "liked_titles_30d": 1,
                         "days_since_last_interaction": 0.5, "seen": ["a"]}},
    }


def self_check():
    signals = {"disliked": 0.1, "neutral": 0.5, "liked": 0.9}
    train = _signal_rows(signals)
    train[0]["content_profile_similarity"] = None
    train[3]["genre_affinity"] = None
    bundle, _report = fit_preference_model(train, _signal_rows(signals, count=15))
    tree_model = build_tree_model(bundle)
    _check_model_shape(bundle, tree_model)

    tree_probability = _backend_probability()
    probe = [{name: 0.5 for name in TREE_FEATURES},
             dict.fromkeys(TREE_FEATURES)]
    _check_backend_parity(tree_model, bundle, train + probe, tree_probability)

    # Liked class index is read from classes, never assumed: a two-class tree
    # can put liked first, and the exported leaf values must follow that order.
    two_class = [_row("liked", content_profile_similarity=value) for value in (0.9, 0.8)]
    two_class += [_row("neutral", content_profile_similarity=value) for value in (0.1, 0.2)]
    small, _report = fit_preference_model(two_class, two_class)
    assert small["classes"][0] == "liked"
    small_model = build_tree_model(small)
    _check_model_shape(small, small_model)
    _check_backend_parity(small_model, small, two_class + [dict(two_class[2], genre_affinity=None)],
                          tree_probability)

    snapshot = _fixture_snapshot()
    table = build_tree_features(snapshot, "u1", candidate_pool(snapshot, "u1"), None)
    assert list(table) == ["b", "c"] and all(len(row) == len(TREE_FEATURES) for row in table.values())
    assert table["b"][0] is None and table["b"][1] == 0.5 and table["c"][1] == 0.0
    print("self-check ok: tree walk, medians/indicator shape, backend probability parity")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--source-manifest", type=Path)
    parser.add_argument("--cohort", choices=("team_test", "synthetic"))
    parser.add_argument("--cutoff")
    parser.add_argument("--user-key")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if not all((args.run_dir, args.source_manifest, args.cohort, args.cutoff, args.user_key, args.output)):
        parser.error("--run-dir, --source-manifest, --cohort, --cutoff, --user-key and --output are required")
    fragment = export_fragment(args.run_dir, args.source_manifest, args.cohort, args.cutoff, args.user_key)
    output = week5_output_path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, fragment)
    print(f"tree fragment: nodes={len(fragment['tree_model']['nodes'])} "
          f"shows={len(fragment['tree_features_by_show'])} output={output}")


if __name__ == "__main__":
    main()
