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
from cosine_similarity import build_content_context
from user_behavior_features import build_snapshot, load_source
from week5_artifacts import load_bundle, output_dir, provenance, validate_metadata, write_csv, write_json

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


# Previously: mining/build_hybrid_ranking.py
def default_cutoff(cohort):
    return SYNTHETIC_CUTOFF if cohort == "synthetic" else TEAM_CUTOFF


# Previously: mining/build_hybrid_ranking.py
def _fmt(value):
    return "" if value is None else f"{float(value):.6f}"


# Previously: mining/build_hybrid_ranking.py
def _json_cell(value):
    return json.dumps(value, sort_keys=True)


# Previously: mining/build_hybrid_ranking.py
def _weights_key(active_weights):
    return json.dumps(active_weights, sort_keys=True)


# Previously: mining/build_hybrid_ranking.py
def _ids_hash(show_ids):
    payload = "\n".join(sorted(str(show_id) for show_id in show_ids)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


# Previously: mining/build_hybrid_ranking.py
def _checked_weights(weights):
    values = {key: float(weights.get(key, 0.0)) for key in KEYS}
    if any(not math.isfinite(value) or value < 0.0 for value in values.values()) or abs(sum(values.values()) - 1.0) > 1e-6:
        raise ValueError("weights must be non-negative and sum to 1")
    return values


# Previously: mining/build_hybrid_ranking.py
# Manual demo weights, or the weights chosen by validation NDCG.
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
def write_popularity(path, snapshot, scores):
    rows = [{"show_id": show_id, "score": _fmt(None if scores is None else scores[show_id])}
            for show_id in sorted(snapshot["catalog_genres"])]
    write_csv(path, rows, ["show_id", "score"])
    return len(rows)


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
def write_topk(csv_path, json_path, rows):
    write_csv(csv_path, [{**row, "active_weights": _json_cell(row["active_weights"]),
                          "reason_codes": _json_cell(row["reason_codes"])} for row in rows], TOPK_FIELDS)
    write_json(json_path, {"algorithm_count": len(ALGORITHMS), "top_k": list(TOP_K), "rows": rows})


# Previously: mining/build_hybrid_ranking.py
def _query_coverage(snapshot):
    with_profile = sum(1 for user in snapshot["user_keys"] if snapshot["users"][user]["liked_ids"])
    return {"users": len(snapshot["user_keys"]), "with_profile": with_profile,
            "cold": len(snapshot["user_keys"]) - with_profile,
            "insufficient_status": sum(1 for user in snapshot["user_keys"]
                                       if snapshot["users"][user]["status"] != "ready")}


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
# Build popularity, component scores, and Top-K lists for one cutoff.
def run(args):
    from week5_pipeline import query_components, rank_queries
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


# Previously: mining/build_hybrid_ranking.py
def self_check():
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


# Previously: mining/build_hybrid_ranking.py
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


# Previously: mining/build_hybrid_ranking.py
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

import math
from collections.abc import Mapping

import numpy

from cosine_similarity import _check_content, _fixture_context

KEYS = ("C", "P", "T", "K")
NAMES = {"C": "content", "P": "popularity", "T": "tree", "K": "cluster"}
TOLERANCE = 1e-9

# Previously: mining/ranking_scores.py
def candidate_pool(snapshot, user):
    """Every valid catalog title not already in the user's full prior seen set."""
    seen = {str(show_id) for show_id in snapshot["users"][user].get("seen", [])}
    return sorted(show_id for show_id in snapshot["catalog_genres"] if show_id not in seen)

# Previously: mining/ranking_scores.py
def popularity_scores(snapshot, members=None):
    """Distinct-user latest-liked counts over the whole valid catalog, log1p normalized."""
    counts = {show_id: 0 for show_id in snapshot["catalog_genres"]}
    for user in sorted(set(snapshot["user_keys"] if members is None else members)):
        record = snapshot["users"].get(user)
        if record is None:
            continue
        for show_id in set(record.get("liked_ids", [])):
            if show_id in counts:
                counts[show_id] += 1
    maximum = max(counts.values()) if counts else 0
    if maximum <= 0:
        return None
    denominator = math.log1p(maximum)
    return {show_id: math.log1p(count) / denominator for show_id, count in counts.items()}


# Previously: mining/ranking_scores.py
def _component(name, values):
    if values is None:
        return None
    if not isinstance(values, Mapping):
        raise ValueError(f"{name} component must be a mapping or None")
    cleaned = {}
    for key, value in values.items():
        if value is None:
            cleaned[str(key)] = None
            continue
        score = float(value)
        if not math.isfinite(score) or score < -TOLERANCE or score > 1.0 + TOLERANCE:
            raise ValueError(f"{name} score for {key} is outside finite [0, 1]")
        cleaned[str(key)] = min(1.0, max(0.0, score))
    return cleaned


# Previously: mining/ranking_scores.py
def _weights(weights):
    if not isinstance(weights, Mapping):
        raise ValueError("weights must be a mapping")
    values = {key: float(weights.get(key, 0.0)) for key in KEYS}
    if any(not math.isfinite(value) or value < 0.0 for value in values.values()):
        raise ValueError("weights must be non-negative")
    if abs(sum(values.values()) - 1.0) > 1e-6:
        raise ValueError("weights must sum to 1")
    return values


# Previously: mining/ranking_scores.py
def _row(show_id, final_score, values, active_weights, mode, reasons):
    return {
        "show_id": show_id,
        "final_score": None if final_score is None else float(final_score),
        "content_score": None if values["C"] is None else values["C"].get(show_id),
        "popularity_score": None if values["P"] is None else values["P"].get(show_id),
        "P_like": None if values["T"] is None else values["T"].get(show_id),
        "cluster_score": None if values["K"] is None else values["K"].get(show_id),
        "active_weights": {key: float(value) for key, value in active_weights.items()},
        "reason_codes": list(reasons),
        "mode": mode,
    }


# Previously: mining/ranking_scores.py
def rank_candidates(candidate_ids, components, weights, has_profile):
    """Weighted hybrid over available components with popularity/catalog fallbacks."""
    pool = sorted({str(show_id) for show_id in candidate_ids})
    values = {key: _component(key, components.get(key)) for key in KEYS}
    base = _weights(weights)
    requested = [key for key in KEYS if base[key] > 0.0]
    usable = [key for key in requested if values[key] is not None] if has_profile else []
    rows = []
    for show_id in pool:
        chosen = [key for key in usable if values[key].get(show_id) is not None]
        if not chosen:
            fallback = values["P"] is not None and values["P"].get(show_id) is not None
            reasons = ["cold_user_no_profile"] if not has_profile else ["no_available_signal"]
            if fallback:
                rows.append(_row(show_id, values["P"][show_id], values, {"P": 1.0}, "popularity_fallback", reasons))
            else:
                rows.append(_row(show_id, None, values, {}, "catalog_fallback", reasons + ["catalog_fallback"]))
            continue
        dropped = [key for key in requested if values[key] is None or values[key].get(show_id) is None]
        reasons = ["missing_values:" + ",".join(dropped)] if dropped else []
        if len(chosen) < len(requested):
            reasons.append("partial_component_availability")
        total = sum(base[key] for key in chosen)
        final = sum(base[key] * values[key][show_id] for key in chosen) / total
        active = {key: base[key] / total for key in chosen}
        mode = "hybrid" if len(chosen) > 1 else NAMES[chosen[0]]
        rows.append(_row(show_id, final, values, active, mode, reasons))
    rows.sort(key=lambda row: (row["final_score"] is None, -(row["final_score"] or 0.0), row["show_id"]))
    return rows


# Previously: mining/ranking_scores.py
def _ordered_ids(ranking):
    return [str(row["show_id"]) if isinstance(row, Mapping) else str(row) for row in ranking]


# Previously: mining/ranking_scores.py
def ranking_metrics(ranking, relevant, k):
    """Actual-order precision@k (fixed K), recall and binary NDCG; null without positives."""
    if int(k) < 1:
        raise ValueError("k must be a positive integer")
    k = int(k)
    positives = {str(show_id) for show_id in (relevant or [])}
    ordered = _ordered_ids(ranking)
    top = ordered[:k]
    hits = sum(1 for show_id in top if show_id in positives)
    count = len(positives)
    precision = hits / k
    recall = hits / count if count else None
    ndcg = None
    if count:
        dcg = sum(1.0 / math.log2(position + 1)
                  for position, show_id in enumerate(top, start=1) if show_id in positives)
        idcg = sum(1.0 / math.log2(position + 1) for position in range(1, min(count, k) + 1))
        ndcg = dcg / idcg if idcg > 0 else None
    return {"precision": precision, "recall": recall, "ndcg": ndcg,
            "returned": len(top), "eligible_count": len(ordered), "positives": count, "hits": hits}


# Previously: mining/ranking_scores.py
def _fixture_snapshot(users, catalog):
    return {"cohort": "synthetic", "cutoff": "2026-08-22T00:00:00+00:00", "user_keys": sorted(users),
            "users": users, "catalog_genres": catalog,
            "genre_universe": sorted({genre for genres in catalog.values() for genre in genres})}


# Previously: mining/ranking_scores.py
def _check_ranking(snapshot):
    catalog = snapshot["catalog_genres"]
    for user in ("u", "v", "cold"):
        assert candidate_pool(snapshot, user) == sorted(set(catalog) - set(snapshot["users"][user]["seen"]))
    popularity = popularity_scores(snapshot)
    assert abs(popularity["a"] - 1.0) < 1e-12
    assert abs(popularity["e"] - math.log1p(1) / math.log1p(2)) < 1e-12
    assert popularity["b"] == 0.0 and popularity_scores(snapshot, []) is None
    assert popularity_scores(_fixture_snapshot({"x": {"liked_ids": [], "seen": []}}, catalog)) is None
    rows = rank_candidates(["a"], {"C": {"a": 1.0}, "P": {"a": 0.0}, "T": None, "K": None},
                           {"C": 0.5, "P": 0.15, "T": 0.25, "K": 0.1}, True)
    assert abs(rows[0]["final_score"] - (0.5 * 1.0 + 0.15 * 0.0) / 0.65) < 1e-12
    assert abs(sum(rows[0]["active_weights"].values()) - 1.0) < 1e-12
    assert set(rows[0]["active_weights"]) == {"C", "P"}
    zero = rank_candidates(["a"], {"C": {"a": 0.0}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert zero[0]["final_score"] == 0.0 and zero[0]["mode"] == "content"
    tied = rank_candidates(["b", "a"], {"C": {"a": 0.5, "b": 0.5}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert [row["show_id"] for row in tied] == ["a", "b"]
    cold = rank_candidates(["a"], {"C": {"a": 0.9}, "P": {"a": 0.3}, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, False)
    assert cold[0]["mode"] == "popularity_fallback" and abs(cold[0]["final_score"] - 0.3) < 1e-12
    empty = rank_candidates(["a"], {"C": None, "P": None, "T": None, "K": None},
                            {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert empty[0]["mode"] == "catalog_fallback" and empty[0]["final_score"] is None
    pop_fallback = rank_candidates(["a"], {"C": None, "P": {"a": 0.4}, "T": None, "K": None},
                                   {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert pop_fallback[0]["mode"] == "popularity_fallback" and abs(pop_fallback[0]["final_score"] - 0.4) < 1e-12
    blank = {"C": None, "P": None, "T": None, "K": None}
    for bad in ({"C": {"a": 1.5}}, {"C": {"a": -0.1}}, {"C": {"a": float("nan")}}):
        try:
            rank_candidates(["a"], {**blank, **bad}, {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
            raise AssertionError("invalid component value accepted")
        except ValueError:
            pass


# Previously: mining/ranking_scores.py
def _check_metrics(rows):
    fewer = ranking_metrics(rows, {"a", "b"}, 5)
    assert fewer["returned"] == 1 and fewer["hits"] == 1 and abs(fewer["precision"] - 0.2) < 1e-12
    assert abs(fewer["recall"] - 0.5) < 1e-12 and fewer["positives"] == 2
    idcg = 1.0 + 1.0 / math.log2(3)
    assert abs(fewer["ndcg"] - 1.0 / idcg) < 1e-12
    first = ranking_metrics(["a", "b"], {"a"}, 2)
    second = ranking_metrics(["b", "a"], {"a"}, 2)
    assert first["ndcg"] == 1.0 and second["ndcg"] < first["ndcg"]
    no_pos = ranking_metrics(["a"], set(), 2)
    assert no_pos["ndcg"] is None and no_pos["recall"] is None and no_pos["positives"] == 0
    try:
        ranking_metrics(["a"], {"a"}, 0)
        raise AssertionError("non-positive k accepted")
    except ValueError:
        pass


# Previously: mining/ranking_scores.py
def scores_self_check():
    catalog = {"a": {"Drama"}, "b": {"Comedies"}, "c": {"Action"}, "e": {"Drama"}}
    snapshot = _fixture_snapshot({
        "u": {"liked_ids": ["a", "e"], "seen": ["a", "e", "zz"]},
        "v": {"liked_ids": ["a", "a"], "seen": ["a", "b"]},
        "cold": {"liked_ids": [], "seen": ["c"]},
    }, catalog)
    _check_content(snapshot, _fixture_context())
    _check_ranking(snapshot)
    rows = rank_candidates(["a"], {"C": {"a": 1.0}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    _check_metrics(rows)
    try:
        rank_candidates(["a"], {"C": {"a": 1.0}}, {"C": 0.5, "P": 0.6, "T": 0.0, "K": 0.0}, True)
        raise AssertionError("weight sum accepted")
    except ValueError:
        pass
    print("self-check ok: content normalization, distinct/cmax0 popularity, seen pool, "
          "renormalization, real-zero, ties, cold/empty fallbacks, metrics order")


if __name__ == "__main__":
    main()
