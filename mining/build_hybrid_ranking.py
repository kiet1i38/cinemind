#!/usr/bin/env python3
"""Build Week 5 popularity, component, Top-K and hybrid ranking reports.

Owns popularity_scores.csv, component_scores.csv, topk.csv/.json and
ranking_report.json/.md under ignored tmp/week5.  No model fitting happens
here: synthetic runs only load already-validated cluster/preference bundles.
"""

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

from build_preference_dataset import ROOT
from ranking_scores import KEYS, NAMES, build_content_context, popularity_scores
from user_behavior_features import build_snapshot, load_source
from week5_artifacts import load_bundle, output_dir, provenance, validate_metadata, write_csv, write_json
from week5_pipeline import query_components, rank_queries

SYNTHETIC_CUTOFF = "2026-08-22T00:00:00+00:00"
TEAM_CUTOFF = "2026-09-17T00:00:00+00:00"
MANUAL_WEIGHTS = {
    "synthetic": {"C": 0.5, "P": 0.15, "T": 0.25, "K": 0.1},
    "team_test": {"C": 0.7, "P": 0.3, "T": 0.0, "K": 0.0},
}
ALGORITHMS = ("popularity", "content", "hybrid")
TOP_K = (5, 10)
COMPONENT_FIELDS = ["cohort", "cutoff", "evidence_status", "user_key", "show_id", "content_score", "popularity_score", "tree_score",
                    "cluster_score", "final_score", "mode", "active_weights", "reason_codes"]
TOPK_FIELDS = ["cohort", "cutoff", "evidence_status", "user_key", "algorithm", "top_k", "rank", "show_id", "final_score", "content_score",
               "popularity_score", "tree_score", "cluster_score", "mode", "active_weights", "reason_codes"]


def default_cutoff(cohort):
    return SYNTHETIC_CUTOFF if cohort == "synthetic" else TEAM_CUTOFF


def _fmt(value):
    return "" if value is None else f"{float(value):.6f}"


def _json_cell(value):
    return json.dumps(value, sort_keys=True)


def _weights_key(active_weights):
    return json.dumps(active_weights, sort_keys=True)


def _ids_hash(show_ids):
    payload = "\n".join(sorted(str(show_id) for show_id in show_ids)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _checked_weights(weights):
    values = {key: float(weights.get(key, 0.0)) for key in KEYS}
    if any(not math.isfinite(value) or value < 0.0 for value in values.values()) or abs(sum(values.values()) - 1.0) > 1e-6:
        raise ValueError("weights must be non-negative and sum to 1")
    return values


def resolve_weights(source, cohort, cutoff, weight_source, preference_run):
    if weight_source == "manual_demo":
        return _checked_weights(MANUAL_WEIGHTS[cohort]), "manual_demo"
    if cohort != "synthetic":
        raise ValueError("validation-selected weights are synthetic demo evidence only")
    if not preference_run:
        raise ValueError("validation_selected weights require --preference-run")
    metadata = json.loads((Path(preference_run) / "validation_weights.json").read_text(encoding="utf-8"))
    validate_metadata(metadata, source, cohort, cutoff)
    weights = metadata.get("weights")
    if not isinstance(weights, dict):
        raise ValueError("validation weights artifact is missing a weights mapping")
    return _checked_weights(weights), metadata.get("selection_role") or "validation_selection"


def load_signals(args, source, cohort, cutoff):
    """Synthetic only: team runs never load tree/cluster signals, even if paths exist."""
    if cohort != "synthetic":
        return None, None, {}
    cluster, tree, metadata = None, None, {}
    if args.cluster_run:
        if not (Path(args.cluster_run) / "user_clusters.joblib").exists():
            report = json.loads((Path(args.cluster_run) / "cluster_report.json").read_text())
            validate_metadata(report, source, cohort, cutoff)
            if report.get("status") != "insufficient_data":
                raise ValueError("partial cluster run: expected trusted model bundle")
            metadata["user_clusters"] = report
        else:
            cluster, metadata["user_clusters"] = load_bundle(args.cluster_run, "user_clusters", source, cohort, cutoff, args.trusted_models)
    if args.preference_run:
        tree, metadata["preference_ranker"] = load_bundle(args.preference_run, "preference_ranker", source, cohort, cutoff, args.trusted_models)
    return cluster, tree, metadata


def write_popularity(path, snapshot, scores):
    rows = [{"show_id": show_id, "score": _fmt(None if scores is None else scores[show_id])}
            for show_id in sorted(snapshot["catalog_genres"])]
    write_csv(path, rows, ["show_id", "score"])
    return len(rows)


def write_component_scores(path, snapshot, components, hybrid):
    rows = []
    for user in sorted(snapshot["user_keys"]):
        chosen = {row["show_id"]: row for row in hybrid[user]}
        for show_id in components[user]["candidate_ids"]:
            row = chosen[show_id]
            rows.append({"cohort": snapshot["cohort"], "cutoff": snapshot["cutoff"], "evidence_status": "synthetic_demo" if snapshot["cohort"] == "synthetic" else "team_test_smoke", "user_key": user, "show_id": show_id,
                         "content_score": _fmt(row["content_score"]),
                         "popularity_score": _fmt(row["popularity_score"]),
                         "tree_score": _fmt(row["P_like"]),
                         "cluster_score": _fmt(row["cluster_score"]),
                         "final_score": _fmt(row["final_score"]),
                         "mode": row["mode"],
                         "active_weights": _json_cell(row["active_weights"]),
                         "reason_codes": _json_cell(row["reason_codes"])})
    write_csv(path, rows, COMPONENT_FIELDS)
    return len(rows)


def topk_rows(snapshot, rankings):
    rows = []
    for user in sorted(snapshot["user_keys"]):
        for algorithm in ALGORITHMS:
            for k in TOP_K:
                for rank, row in enumerate(rankings[algorithm][user][:k], start=1):
                    rows.append({"cohort": snapshot["cohort"], "cutoff": snapshot["cutoff"], "evidence_status": "synthetic_demo" if snapshot["cohort"] == "synthetic" else "team_test_smoke", "user_key": user, "algorithm": algorithm, "top_k": k, "rank": rank,
                                 "show_id": row["show_id"], "final_score": row["final_score"],
                                 "content_score": row["content_score"], "popularity_score": row["popularity_score"],
                                 "tree_score": row["P_like"], "cluster_score": row["cluster_score"],
                                 "mode": row["mode"], "active_weights": row["active_weights"],
                                 "reason_codes": row["reason_codes"]})
    return rows


def write_topk(csv_path, json_path, rows):
    write_csv(csv_path, [{**row, "active_weights": _json_cell(row["active_weights"]),
                          "reason_codes": _json_cell(row["reason_codes"])} for row in rows], TOPK_FIELDS)
    write_json(json_path, {"algorithm_count": len(ALGORITHMS), "top_k": list(TOP_K), "rows": rows})


def _query_coverage(snapshot):
    with_profile = sum(1 for user in snapshot["user_keys"] if snapshot["users"][user]["liked_ids"])
    return {"users": len(snapshot["user_keys"]), "with_profile": with_profile,
            "cold": len(snapshot["user_keys"]) - with_profile,
            "insufficient_status": sum(1 for user in snapshot["user_keys"]
                                       if snapshot["users"][user]["status"] != "ready")}


def _coverage(snapshot, components, rankings):
    catalog = set(snapshot["catalog_genres"])
    pools, top10 = set(), set()
    returned = {"users": len(snapshot["user_keys"]), "candidate_pool_total": 0, "returned_total": 0, "top10_total": 0}
    for user in snapshot["user_keys"]:
        pool = components[user]["candidate_ids"]
        rows = rankings["hybrid"][user]
        pools.update(pool)
        top10.update(row["show_id"] for row in rows[:10])
        returned["candidate_pool_total"] += len(pool)
        returned["returned_total"] += len(rows)
        returned["top10_total"] += min(10, len(rows))
    users = len(snapshot["user_keys"]) or 1
    return {
        "catalog_coverage": {"catalog_titles": len(catalog), "in_pools": len(pools), "in_top10": len(top10),
                             "pool_fraction": len(pools) / len(catalog) if catalog else None,
                             "top10_fraction": len(top10) / len(catalog) if catalog else None},
        "result_coverage": {**returned, "mean_returned": returned["returned_total"] / users,
                            "mean_top10_returned": returned["top10_total"] / users},
    }


def _usage(snapshot, components, rankings, weights):
    modes, reasons, weights_seen = Counter(), Counter(), Counter()
    fallback_users, catalog_fallback_users = 0, 0
    component_usage = {}
    for key in KEYS:
        component_usage[NAMES[key]] = {
            "users_available": sum(1 for user in snapshot["user_keys"] if components[user][key] is not None),
            "candidate_values": sum(1 for user in snapshot["user_keys"] if components[user][key] is not None
                                    for show_id in components[user]["candidate_ids"]
                                    if show_id in components[user][key]),
            "weight": weights[key]}
    for user in snapshot["user_keys"]:
        rows = rankings["hybrid"][user]
        user_modes = {row["mode"] for row in rows}
        for row in rows:
            modes[row["mode"]] += 1
            weights_seen[_weights_key(row["active_weights"])] += 1
            for reason in row["reason_codes"]:
                reasons[reason] += 1
        fallback_users += int("popularity_fallback" in user_modes or "catalog_fallback" in user_modes)
        catalog_fallback_users += int("catalog_fallback" in user_modes)
    total_rows = sum(modes.values())
    return {
        "modes": dict(modes),
        "reason_codes": dict(reasons),
        "component_usage": component_usage,
        "active_weights": [{"active_weights": json.loads(key), "rows": count}
                           for key, count in sorted(weights_seen.items())],
        "fallback_usage": {
            "candidate_rows": total_rows,
            "popularity_fallback_rows": modes.get("popularity_fallback", 0),
            "catalog_fallback_rows": modes.get("catalog_fallback", 0),
            "popularity_fallback_fraction": modes.get("popularity_fallback", 0) / total_rows if total_rows else None,
            "users_with_fallback": fallback_users,
            "catalog_fallback_users": catalog_fallback_users,
        },
    }


def candidates_manifest(snapshot, components, context, cutoff):
    catalog_ids = sorted(snapshot["catalog_genres"])
    per_user, total = {}, 0
    for user in sorted(snapshot["user_keys"]):
        pool = components[user]["candidate_ids"]
        total += len(pool)
        per_user[user] = {"count": len(pool), "sha256": _ids_hash(pool)}
    return {"cohort": snapshot["cohort"], "cutoff": cutoff, "catalog_count": len(catalog_ids),
            "catalog_sha256": _ids_hash(catalog_ids), "content_rows": context["row_count"],
            "candidate_total": total, "per_user": per_user}


def write_markdown(path, report):
    lines = [
        "# Week 5 hybrid ranking",
        "",
        f"- Evidence: {report['evidence_status']}",
        f"- Cohort/cutoff: {report['cohort']} @ {report['cutoff']}",
        f"- Weight source: {report['weight_source']} ({report['weight_label']})",
        f"- Active weights: {json.dumps(report['weights'], sort_keys=True)}",
        f"- Users: {report['query_coverage']['users']} (cold {report['query_coverage']['cold']})",
        f"- Candidates: {report['candidates']['candidate_total']} across {report['candidates']['catalog_count']} catalog titles",
        f"- Popularity available: {report['popularity_available']}",
        f"- Fallback rows: {report['fallback_usage']['popularity_fallback_rows']} popularity, "
        f"{report['fallback_usage']['catalog_fallback_rows']} catalog",
        f"- Modes: {json.dumps(report['modes'], sort_keys=True)}",
        "",
        "Synthetic rows describe the deterministic fixture only; team rows are smoke evidence.",
    ]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(args):
    source = load_source(args.source_manifest)
    cohort = args.cohort
    cutoff = args.cutoff or default_cutoff(cohort)
    snapshot = build_snapshot(source, cohort, cutoff)
    context = build_content_context(source)
    cluster, tree, model_meta = load_signals(args, source, cohort, cutoff)
    weights, weight_label = resolve_weights(source, cohort, cutoff, args.weight_source, args.preference_run)
    components = query_components(snapshot, context, cluster, tree)
    global_popularity = popularity_scores(snapshot)
    rankings = {algorithm: rank_queries(snapshot, components, weights, algorithm) for algorithm in ALGORITHMS}
    directory = output_dir(args.output_dir or (ROOT / "tmp" / "week5" / cohort / "ranking"))
    manifest = candidates_manifest(snapshot, components, context, cutoff)
    write_json(directory / "candidates_manifest.json", manifest)
    popularity_rows = write_popularity(directory / "popularity_scores.csv", snapshot, global_popularity)
    component_rows = write_component_scores(directory / "component_scores.csv", snapshot, components,
                                            rankings["hybrid"])
    topk = topk_rows(snapshot, rankings)
    write_topk(directory / "topk.csv", directory / "topk.json", topk)
    report = {**provenance(source, cohort), "cutoff": cutoff, "weight_source": args.weight_source,
              "weight_label": weight_label, "weights": weights, "algorithms": list(ALGORITHMS),
              "top_k": list(TOP_K), "popularity_available": global_popularity is not None,
              "counts": {"popularity_rows": popularity_rows, "component_rows": component_rows,
                         "topk_rows": len(topk), "candidate_total": manifest["candidate_total"]},
              "query_coverage": _query_coverage(snapshot),
              "candidates": {"catalog_count": manifest["catalog_count"],
                             "candidate_total": manifest["candidate_total"],
                             "manifest": "candidates_manifest.json"},
              "models": model_meta}
    report.update(_coverage(snapshot, components, rankings))
    report.update(_usage(snapshot, components, rankings, weights))
    write_json(directory / "ranking_report.json", report)
    write_markdown(directory / "ranking_report.md", report)
    print(f"ranking rows: popularity={popularity_rows}, components={component_rows}, topk={len(topk)}")
    return report


def self_check():
    from ranking_scores import self_check as scores_self_check
    scores_self_check()
    assert default_cutoff("synthetic").startswith("2026-08-22")
    assert default_cutoff("team_test").startswith("2026-09-17")
    for expected in MANUAL_WEIGHTS.values():
        values = _checked_weights(expected)
        assert values == {key: float(expected[key]) for key in KEYS} and abs(sum(values.values()) - 1.0) < 1e-12
    assert _ids_hash(["b", "a"]) == _ids_hash(["a", "b"]) and _ids_hash(["a"]) != _ids_hash(["b"])
    try:
        _checked_weights({"C": 0.7, "P": 0.3, "T": 0.1, "K": 0.0})
        raise AssertionError("invalid manual weights accepted")
    except ValueError:
        pass
    print("self-check ok: manual weights, cohort cutoffs, candidate hashing")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path)
    parser.add_argument("--cohort", choices=("team_test", "synthetic"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--cutoff", default=None)
    parser.add_argument("--cluster-run", type=Path)
    parser.add_argument("--preference-run", type=Path)
    parser.add_argument("--weight-source", choices=("manual_demo", "validation_selected"), default="manual_demo")
    parser.add_argument("--trusted-models", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if not all((args.source_manifest, args.cohort, args.output_dir)):
        parser.error("--source-manifest, --cohort and --output-dir are required")
    report = run(args)
    print(f"ranking status: {report['evidence_status']}")


if __name__ == "__main__":
    main()
