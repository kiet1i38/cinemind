#!/usr/bin/env python3
"""Week 5 K-means; fixture styles gate eligibility after fitting, never enter X."""

import argparse
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import adjusted_rand_score, silhouette_score
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

from user_behavior_features import INSUFFICIENT, READY, build_snapshot, build_user_matrix, load_source, write_user_features
from week5_artifacts import load_bundle, output_dir, provenance, save_bundle, write_csv, write_json

CANDIDATE_K = (2, 3, 4)
SEEDS = (0, 1, 2, 3, 42)
PRIMARY_SEED, N_INIT, FEATURE_VERSION = 42, 10, "user_clusters-v1"
ASSIGNMENT_FIELDS = ("user_key", "cutoff", "cluster_id", "distance", "status")
DEFAULT_CUTOFFS = {"team_test": "2026-09-17T00:00:00Z", "synthetic": "2026-08-01T00:00:00Z"}
STATUS_INSUFFICIENT_DATA = "insufficient_data"


def _fit_kmeans(rows, k, seed):
    model = KMeans(n_clusters=k, init="k-means++", n_init=N_INIT, random_state=seed)
    with threadpool_limits(limits=1):
        return model, model.fit_predict(rows)


def _silhouette(rows, labels):
    distinct = len(set(labels))
    return None if distinct < 2 or distinct >= len(rows) else float(silhouette_score(rows, labels))


def _median(values):
    return float(median(values)) if values else None


def _pairwise_aris(partitions):
    return {(SEEDS[left], SEEDS[right]): float(adjusted_rand_score(partitions[left], partitions[right]))
            for left in range(len(partitions)) for right in range(left + 1, len(partitions))}


def _seed_medians(pairwise):
    return {str(seed): _median([score for (left, right), score in pairwise.items() if seed in (left, right)])
            for seed in SEEDS}


def _profiles(rows, labels, feature_names):
    counts = [0] * len(set(labels))
    sums = [[0.0] * len(feature_names) for _ in counts]
    for row, label in zip(rows, labels):
        counts[label] += 1
        for index, value in enumerate(row):
            sums[label][index] += math.expm1(value) if feature_names[index].startswith("log1p_") else float(value)
    return counts, {str(c): {name.removeprefix("log1p_"): float(sums[c][i] / (counts[c] or 1)) for i, name in enumerate(feature_names)}
                    for c in range(len(counts))}


def _dominant_genre(profiles):
    output = {}
    for cluster, values in profiles.items():
        genres = {name: value for name, value in values.items() if name.startswith("genre_share__")}
        output[cluster] = max(sorted(genres), key=genres.get) if genres else None
    return output


def _zero_variance(rows, feature_names):
    if not rows:
        return list(feature_names)
    array = np.asarray(rows, dtype=float)
    return [name for index, name in enumerate(feature_names)
            if float(array[:, index].max() - array[:, index].min()) == 0.0]


def _style_gate(user_keys, labels, profiles, expected_styles):
    lookup = set(user_keys)
    expected = {user: style for user, style in (expected_styles or {}).items() if user in lookup}
    if set(expected) != lookup:
        return {"available": False, "passed": False, "reason": "expected_style_by_user unavailable"}
    styles = sorted(set(expected.values()))
    label_by_user = dict(zip(user_keys, labels))
    by_cluster = defaultdict(set)
    for user, style in expected.items():
        by_cluster[label_by_user[user]].add(style)
    partition_match = len(by_cluster) == len(styles) and all(len(values) == 1 for values in by_cluster.values())
    dominant, profile_match = _dominant_genre(profiles), True
    for style in styles:
        clusters = {label_by_user[user] for user, value in expected.items() if value == style}
        if len(clusters) != 1 or dominant.get(str(clusters.pop())) != f"genre_share__{style}":
            profile_match = False
            break
    return {"available": True, "partition_match": bool(partition_match), "profile_match": bool(profile_match)}


def _seed_partitions(scaled, k, primary):
    return [primary if seed == PRIMARY_SEED else _fit_kmeans(scaled, k, seed)[1] for seed in SEEDS]


def _candidate(k, rows, scaled, feature_names, distinct):
    entry = {"k": k, "feasible": False, "reason": None, "actual_clusters": None, "inertia": None,
             "silhouette": None, "cluster_counts": None, "singleton_count": None, "raw_profiles": None,
             "seed_median_ari": None, "median_pairwise_ari": None, "selected": False}
    if k >= len(rows):
        entry["reason"] = "k_not_less_than_ready_users"
        return entry, None, None
    if k > distinct:
        entry["reason"] = "k_exceeds_distinct_vectors"
        return entry, None, None
    model, labels = _fit_kmeans(scaled, k, PRIMARY_SEED)
    entry["actual_clusters"] = len(set(labels))
    if entry["actual_clusters"] != k:
        entry["reason"] = "actual_cluster_count_mismatch"
        return entry, None, None
    counts, profiles = _profiles(rows, labels, feature_names)
    pairwise = _pairwise_aris(_seed_partitions(scaled, k, labels))
    entry.update({"feasible": True, "inertia": round(float(model.inertia_), 12), "silhouette": _silhouette(scaled, labels),
                  "cluster_counts": [int(value) for value in counts],
                  "singleton_count": int(sum(value == 1 for value in counts)), "raw_profiles": profiles,
                  "seed_median_ari": _seed_medians(pairwise),
                  "median_pairwise_ari": _median(list(pairwise.values()))})
    return entry, model, labels


def _select(feasible, cohort):
    if cohort == "synthetic":
        return max(feasible, key=lambda item: (item["silhouette"] if item["silhouette"] is not None else -1.0,
                                               -item["k"]))
    return min(feasible, key=lambda item: item["k"])


def _gate(selected, user_keys, labels, expected_styles):
    gate = {"no_singleton": selected["singleton_count"] == 0,
            "positive_silhouette": selected["silhouette"] is not None and selected["silhouette"] > 0.0,
            "median_pairwise_ari_at_least_0_8": (selected["median_pairwise_ari"] is not None
                                                 and selected["median_pairwise_ari"] >= 0.8)}
    gate.update(_style_gate(user_keys, labels, selected["raw_profiles"], expected_styles))
    gate["passed"] = bool(gate.get("available") and gate["no_singleton"] and gate["positive_silhouette"]
                          and gate["median_pairwise_ari_at_least_0_8"] and gate.get("partition_match")
                          and gate.get("profile_match"))
    return gate


def _empty_report(snapshot, feature_names, ready):
    return {"feature_version": FEATURE_VERSION, "cohort": snapshot.get("cohort"), "cutoff": snapshot.get("cutoff"),
            "status": STATUS_INSUFFICIENT_DATA, "users_total": len(snapshot.get("user_keys", [])),
            "ready_users": ready, "feature_order": list(feature_names), "candidate_k": list(CANDIDATE_K),
            "feasible_k": [], "selected_k": None, "selection_detail": None, "signal_eligible": False,
            "style_gate": None, "zero_variance_features": [], "candidates": {}, "all_null": True,
            "selection_metric": "smallest_feasible_k" if snapshot.get("cohort") == "team_test" else "highest_defined_silhouette_ties_smaller_k"}


def _make_bundle(snapshot, scaler, model, k, feature_names, selected, report):
    return {"kind": "user_clusters", "status": report["status"], "cohort": snapshot.get("cohort"),
            "cutoff": snapshot.get("cutoff"), "k": int(k), "scaler": scaler, "model": model,
            "feature_order": list(feature_names), "signal_eligible": report["signal_eligible"],
            "raw_profiles": selected["raw_profiles"], "cluster_counts": selected["cluster_counts"],
            "metrics": {"inertia": selected["inertia"], "silhouette": selected["silhouette"],
                        "median_pairwise_ari": selected["median_pairwise_ari"],
                        "seed_median_ari": selected["seed_median_ari"]}}


def fit_clusters(snapshot, expected_styles=None):
    """Fit scaler plus k-means on ready users; return (bundle_or_None, report)."""
    matrix = build_user_matrix(snapshot)
    user_keys, rows, feature_names = matrix["user_keys"], matrix["rows"], matrix["feature_names"]
    report = _empty_report(snapshot, feature_names, len(user_keys))
    if len(rows) < 2:
        report["reason"] = "fewer than two ready users"
        return None, report
    report["zero_variance_features"] = _zero_variance(rows, feature_names)
    distinct = len({tuple(row) for row in rows})
    report["distinct_vectors"] = distinct
    scaler = StandardScaler().fit(rows)
    scaled = scaler.transform(rows)
    models, labels_by_k, feasible = {}, {}, []
    for k in CANDIDATE_K:
        entry, model, labels = _candidate(k, rows, scaled, feature_names, distinct)
        report["candidates"][str(k)] = entry
        if entry["feasible"]:
            report["feasible_k"].append(k)
            models[k], labels_by_k[k] = model, labels
            feasible.append(entry)
    if not feasible:
        report["reason"] = "no feasible k in candidates"
        return None, report
    selected = _select(feasible, snapshot.get("cohort"))
    selected["selected"] = True
    k = selected["k"]
    report.update({"selected_k": k, "all_null": False, "selected_raw_profiles": selected["raw_profiles"],
                   "selection_detail": {key: selected[key] for key in
                                        ("k", "silhouette", "inertia", "median_pairwise_ari", "cluster_counts")}})
    report["style_gate"] = _gate(selected, user_keys, labels_by_k[k], expected_styles)
    report["signal_eligible"] = bool(snapshot.get("cohort") == "synthetic" and report["style_gate"]["passed"])
    report["status"] = ("synthetic_demo" if report["signal_eligible"]
                        else "provisional" if snapshot.get("cohort") != "synthetic" else "synthetic_ungated")
    return _make_bundle(snapshot, scaler, models[k], k, feature_names, selected, report), report


def _user_vector(user, feature_order):
    values = []
    for name in feature_order:
        if name.startswith("genre_share__"):
            values.append(float(user["genre_shares"][name[len("genre_share__"):]]))
        elif name == "log1p_unique_watched_titles_30d":
            values.append(math.log1p(user["unique_watched_titles_30d"]))
        elif name == "log1p_watch_event_rows_7d":
            values.append(math.log1p(user["watch_event_rows_7d"]))
        else:
            raise ValueError(f"unknown user-cluster feature {name!r}")
    return values


def assign_clusters(snapshot, bundle):
    """Transform and predict only; never fits. Returns one row per roster user."""
    assignments = []
    for user_key in snapshot.get("user_keys", sorted(snapshot.get("users", {}))):
        user = snapshot["users"][user_key]
        row = {"user_key": user_key, "cutoff": snapshot.get("cutoff"), "cluster_id": None,
               "distance": None, "status": STATUS_INSUFFICIENT_DATA}
        if bundle is not None and user.get("status") == READY:
            scaled = bundle["scaler"].transform(np.asarray([_user_vector(user, bundle["feature_order"])], dtype=float))
            label = int(bundle["model"].predict(scaled)[0])
            row.update({"cluster_id": label, "distance": round(float(bundle["model"].transform(scaled)[0][label]), 12),
                        "status": "assigned"})
        elif bundle is not None:
            row["status"] = INSUFFICIENT
        assignments.append(row)
    return assignments


def _snapshot_manifest(snapshot, matrix, report):
    ready, keys = set(matrix["user_keys"]), snapshot.get("user_keys", [])
    return {"snapshot_version": snapshot.get("snapshot_version"), "cohort": snapshot.get("cohort"),
            "cutoff": snapshot.get("cutoff"), "history_days": snapshot.get("history_days"),
            "recent_days": snapshot.get("recent_days"), "counts": snapshot.get("counts", {}),
            "coverage": snapshot.get("coverage", {}), "users_total": len(keys),
            "ready_user_keys": matrix["user_keys"], "insufficient_user_keys": [k for k in keys if k not in ready],
            "genre_universe": snapshot.get("genre_universe", []), "feature_order": matrix["feature_names"],
            "cluster_status": report["status"], "selected_k": report["selected_k"],
            "signal_eligible": report["signal_eligible"]}


def _bundle_metadata(source, snapshot, matrix, report):
    cutoff = snapshot["cutoff"]
    return {**provenance(source, snapshot["cohort"]), "feature_version": FEATURE_VERSION,
            "feature_order": list(matrix["feature_names"]), "fit_cutoff": cutoff,
            "transform_spec": {"genres": "identity", "activity_counts": "log1p", "scaler": "StandardScaler fit at train cutoff only"},
            "trained_through": cutoff, "selected_through": cutoff, "k": report["selected_k"],
            "signal_eligible": report["signal_eligible"], "status": report["status"]}


def _fixture_user(user_key, shares, status=READY):
    return {"user_key": user_key, "cohort": "synthetic", "status": status, "liked_ids": [], "genre_shares": shares,
            "seen": [], "unique_watched_titles_30d": 0, "watch_event_rows_7d": 0, "liked_titles_30d": 0,
            "days_since_last_interaction": None}


def _fixture_snapshot(users):
    universe = sorted({genre for user in users.values() for genre, value in user["genre_shares"].items() if value > 0})
    return {"snapshot_version": "fixture", "cohort": "synthetic", "cutoff": "2026-08-01T00:00:00+00:00",
            "genre_universe": universe, "catalog_genres": {}, "users": users,
            "user_keys": sorted(users), "counts": {}, "coverage": {}}

class _NoFit:
    def __init__(self, wrapped):
        self._wrapped = wrapped
    def transform(self, values):
        return self._wrapped.transform(values)
    def predict(self, values):
        return self._wrapped.predict(values)
    def fit(self, *args, **kwargs):
        raise AssertionError("assign must not fit")


def _check_degenerate():
    same = {genre: 1.0 / 3.0 for genre in ("Action", "Comedy", "Drama")}
    snapshot = _fixture_snapshot({f"u{index}": _fixture_user(f"u{index}", same) for index in range(4)})
    bundle, report = fit_clusters(snapshot)
    assert bundle is None and report["status"] == STATUS_INSUFFICIENT_DATA and report["all_null"]
    assert all(row["cluster_id"] is None and row["distance"] is None and row["status"] == STATUS_INSUFFICIENT_DATA
               for row in assign_clusters(snapshot, bundle))


def _check_onehot_and_assign():
    universe = ["Action", "Comedy", "Drama"]
    users, expected = {}, {}
    for style, prefix in (("Action", "a"), ("Comedy", "c"), ("Drama", "d")):
        for member in range(2):
            key = f"{prefix}{member}"
            users[key] = _fixture_user(key, {genre: float(genre == style) for genre in universe})
            expected[key] = style
    snapshot = _fixture_snapshot(users)
    bundle, report = fit_clusters(snapshot, expected_styles=expected)
    assert bundle is not None and report["selected_k"] == 3 and report["signal_eligible"]
    assert report["style_gate"]["passed"] and report["style_gate"]["partition_match"]
    assert report["style_gate"]["profile_match"] and report["style_gate"]["no_singleton"]
    assert sorted(report["zero_variance_features"]) == ["log1p_unique_watched_titles_30d",
                                                        "log1p_watch_event_rows_7d"]
    _, plain = fit_clusters(snapshot)
    assert plain["selected_k"] == report["selected_k"]
    assert plain["candidates"]["3"]["silhouette"] == report["candidates"]["3"]["silhouette"]
    assert not plain["signal_eligible"]
    guarded = dict(bundle)
    guarded["scaler"], guarded["model"] = _NoFit(bundle["scaler"]), _NoFit(bundle["model"])
    first = assign_clusters(snapshot, guarded)
    assert first == assign_clusters(snapshot, guarded)
    assert all(row["status"] == "assigned" and row["cluster_id"] in range(bundle["k"]) for row in first)
    cold = _fixture_user("cold", {genre: 0.0 for genre in universe}, status=INSUFFICIENT)
    rows = {row["user_key"]: row
            for row in assign_clusters(_fixture_snapshot({**users, "cold": cold}), bundle)}
    assert rows["cold"]["cluster_id"] is None and rows["cold"]["status"] == INSUFFICIENT


def self_check():
    _check_degenerate()
    _check_onehot_and_assign()
    assert adjusted_rand_score([0, 0, 1, 1], [1, 1, 0, 0]) == 1.0
    pairwise = _pairwise_aris([[0, 0, 1, 1], [1, 1, 0, 0], [0, 0, 1, 1]])
    assert all(value == 1.0 for value in pairwise.values())
    assert _median(list(pairwise.values())) == 1.0 and _median([0.5, 1.0, 1.0]) == 1.0
    print("self-check ok: degenerate K, constant/zero-var, train-only roundtrip, ARI permutation")


def _fit(args, source, snapshot, matrix):
    directory = output_dir(args.output_dir)
    expected = source["manifest"].get("expected_style_by_user") if args.cohort == "synthetic" else None
    bundle, report = fit_clusters(snapshot, expected_styles=expected)
    report.update(_bundle_metadata(source, snapshot, matrix, report))
    write_user_features(directory / "user_behavior_features.csv", snapshot, matrix)
    write_json(directory / "snapshot_manifest.json", {**provenance(source, args.cohort), **_snapshot_manifest(snapshot, matrix, report), "source_exclusions": dict(source["exclusions"])})
    write_csv(directory / "cluster_assignments.csv", assign_clusters(snapshot, bundle), ASSIGNMENT_FIELDS)
    write_json(directory / "cluster_report.json", report)
    (directory / "cluster_report.md").write_text(
        f"# User clusters ({report['cohort']})\n\n- status: {report['status']}\n"
        f"- cutoff: {report['cutoff']}\n- selected K: {report['selected_k']}\n"
        f"- signal eligible: {report['signal_eligible']}\n"
        f"- selection metric: {report['selection_metric']}\n"
        f"- zero-variance features: {report['zero_variance_features']}\n\n## Candidates\n"
        + "\n".join(f"- K={k}: {report['candidates'].get(str(k), report.get('reason'))}" for k in report["candidate_k"]) + "\n",
        encoding="utf-8")
    if bundle is not None:
        save_bundle(directory, "user_clusters", bundle, _bundle_metadata(source, snapshot, matrix, report))
    else:
        for suffix in (".json", ".joblib"):
            (directory / ("user_clusters" + suffix)).unlink(missing_ok=True)
    print(f"status={report['status']}; k={report['selected_k']}; "
          f"signal_eligible={report['signal_eligible']}; output={directory}")


def _assign(args, source, snapshot):
    model_dir = args.model or args.cluster_run
    if model_dir is None:
        raise SystemExit("assign mode requires --model or --cluster-run")
    directory = output_dir(args.output_dir)
    bundle, metadata = load_bundle(model_dir, "user_clusters", source, args.cohort, args.cutoff, args.trusted_models)
    assignments = assign_clusters(snapshot, bundle)
    write_csv(directory / "cluster_assignments.csv", assignments, ASSIGNMENT_FIELDS)
    write_json(directory / "cluster_report.json", {
        **{key: metadata.get(key) for key in ("schema_version", "cohort", "feature_version", "fit_cutoff",
                                              "trained_through", "selected_through", "k", "signal_eligible")},
        "mode": "assign", "cutoff": snapshot["cutoff"], "users_total": len(snapshot["user_keys"]),
        "assigned": sum(row["status"] == "assigned" for row in assignments),
        "insufficient_history": sum(row["status"] == INSUFFICIENT for row in assignments)})
    print(f"mode=assign; users={len(assignments)}; output={directory}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path)
    parser.add_argument("--cohort", choices=("team_test", "synthetic"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--cutoff")
    parser.add_argument("--mode", choices=("fit", "assign"), default="fit")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--cluster-run", type=Path, help="directory alias for --model")
    parser.add_argument("--trusted-models", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if not all((args.source_manifest, args.cohort, args.output_dir)):
        parser.error("--source-manifest, --cohort and --output-dir are required")
    args.cutoff = args.cutoff or DEFAULT_CUTOFFS.get(args.cohort)
    if not args.cutoff:
        parser.error(f"--cutoff is required for cohort {args.cohort}")
    source = load_source(args.source_manifest)
    snapshot = build_snapshot(source, args.cohort, args.cutoff)
    if args.mode == "fit":
        _fit(args, source, snapshot, build_user_matrix(snapshot))
    else:
        _assign(args, source, snapshot)

if __name__ == "__main__":
    main()
