#!/usr/bin/env python3
"""Fixed train/validation/test Week 5 replay; metrics are synthetic demo evidence."""

import argparse
from collections import Counter
from pathlib import Path

from pre_rec_tree import fit_preference_model, predict_liked
from ranking_scores import build_content_context, ranking_metrics
from user_behavior_features import load_source, build_snapshot, build_future_targets
from week5_artifacts import output_dir, provenance, write_csv, write_json, save_bundle, load_bundle, TREE_FEATURES
from week5_evaluation import window_contract, weight_grid, select_weights
from week5_pipeline import query_components, rank_queries, target_features

DATES = ("2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z", "2026-08-15T00:00:00Z")


def metric_rows(rankings, targets, split, algorithm):
    positives = {}
    for row in targets:
        if row["label"] == "liked":
            positives.setdefault(row["user_key"], set()).add(row["show_id"])
    return [{"split": split, "algorithm": algorithm, "user_key": user, "top_k": k,
             **ranking_metrics(ranked, positives.get(user, set()), k)}
            for user, ranked in rankings.items() for k in (5, 10)]


def averages(rows):
    output = []
    for algorithm in ("popularity", "content", "hybrid"):
        for k in (5, 10):
            group = [row for row in rows if row["algorithm"] == algorithm and row["top_k"] == k]
            summary = {"algorithm": algorithm, "top_k": k, "queries": len(group)}
            for name in ("precision", "recall", "ndcg"):
                defined = [row[name] for row in group if row[name] is not None]
                summary[name] = sum(defined) / len(defined) if defined else None
                summary[name + "_defined_queries"] = len(defined)
            output.append(summary)
    return output


def prepare_splits(source, cohort, times, ends, context):
    splits = []
    for name, cutoff, end in zip(("train", "validation", "test"), times, ends):
        snapshot = build_snapshot(source, cohort, cutoff)
        from ranking_scores import candidate_pool
        pools = {user: candidate_pool(snapshot, user) for user in snapshot["users"]}
        targets = build_future_targets(source, cutoff, end, pools)
        splits.append((name, snapshot, targets, target_features(snapshot, targets, context)))
    return splits


def train_and_select(directory, source, args, splits, times, ends, context, cluster, base):
    tree, tree_report = fit_preference_model(splits[0][3], splits[1][3])
    tree_metadata = {**base, "feature_order": TREE_FEATURES, "feature_version": "preference_ranker-v1",
                     "trained_through": ends[0].isoformat(), "selected_through": ends[1].isoformat(),
                     "fit_cutoff": times[0].isoformat(), "selection_role": "validation_selection"}
    tree_metadata.update({key: tree[key] for key in ("classes", "medians", "missing_indicator_order", "model_feature_order")})
    save_bundle(directory, "preference_ranker", tree, tree_metadata)
    for name, snapshot, targets, features in splits:
        write_csv(directory / (name + "_targets.csv"), features)
    queries = [{"split": name, "user_key": user, "cutoff": snapshot["cutoff"], "cohort": snapshot["cohort"],
                "candidate_count": len(snapshot["catalog_genres"]) - len(set(record["seen"])),
                "status": record["status"], "observed_positive_count": sum(row["label"] == "liked" and row["user_key"] == user for row in targets)}
               for name, snapshot, targets, _ in splits for user, record in snapshot["users"].items()]
    write_csv(directory / "query_manifest.csv", queries)
    val_snapshot, val_targets = splits[1][1:3]
    components = query_components(val_snapshot, context, cluster, tree)
    results = []
    for weights in weight_grid():
        ranked = rank_queries(val_snapshot, components, weights)
        rows = metric_rows(ranked, val_targets, "validation_selection", "hybrid")
        values = [row["ndcg"] for row in rows if row["top_k"] == 10 and row["ndcg"] is not None]
        results.append({"weights": weights, "mean_ndcg10": sum(values) / len(values) if values else None})
    selected = select_weights(results)
    if selected is None:
        raise ValueError("validation has no observed positives for weight selection")
    write_json(directory / "validation_weights.json", {**base, **selected,
               "trained_through": ends[0].isoformat(), "selected_through": ends[1].isoformat(), "selection_role": "validation_selection"})
    write_csv(directory / "validation_weight_grid.csv", [{**row["weights"], "mean_ndcg10": row["mean_ndcg10"]} for row in results])
    write_json(directory / "preference_report.json", tree_report)
    write_csv(directory / "validation_tree_candidates.csv", [{key: row[key] for key in ("name", "leaves", "depth", "validation_macro_f1")} for row in tree_report["validation_candidates"]])
    return tree, tree_report, selected


def evaluation_run(args):
    source = load_source(args.source_manifest)
    directory = output_dir(args.output_dir)
    times, ends, guard = window_contract(source, args.train_cutoff, args.validation_cutoff, args.test_cutoff)
    base = provenance(source, args.cohort)
    if args.cohort != "synthetic" or not guard["complete_outcomes"]:
        report = {**base, **guard, "status": "team_test_smoke" if args.cohort == "team_test" else "incomplete_coverage",
                  "quality_metrics": None, "reason": "confirmed complete outcomes required for numerical benchmark"}
        write_json(directory / "ranking_report.json", report)
        (directory / "ranking_report.md").write_text("# Week 5 replay\n\nQuality metrics: N/A. Complete observation coverage is unavailable.\n")
        return report
    cluster, cluster_meta = load_bundle(args.cluster_run, "user_clusters", source, args.cohort, times[0], args.trusted_models)
    if cluster_meta["fit_cutoff"] != times[0].isoformat():
        raise ValueError("benchmark requires the train-cutoff cluster model")
    context = build_content_context(source)
    splits = prepare_splits(source, args.cohort, times, ends, context)
    tree, tree_report, selected = train_and_select(directory, source, args, splits, times, ends, context, cluster, base)
    test_snapshot, test_targets = splits[2][1:3]
    test_components = query_components(test_snapshot, context, cluster, tree)
    metrics = []
    rankings = {}
    for algorithm in ("popularity", "content", "hybrid"):
        ranked = rank_queries(test_snapshot, test_components, selected["weights"], algorithm)
        rankings[algorithm] = ranked
        metrics.extend(metric_rows(ranked, test_targets, "test", algorithm))
    summary = averages(metrics)
    write_csv(directory / "benchmark_queries.csv", metrics)
    write_csv(directory / "benchmark.csv", summary)
    from evaluate_preference_tree import classification_metrics
    classification = classification_metrics([row["label"] for row in splits[2][3]],
                                            tree["tree"].predict(__import__("pre_rec_tree").feature_matrix(tree, splits[2][3])))
    report = {**base, **guard, "status": "synthetic_demo", "weights": selected["weights"],
              "metrics": summary, "test_preference": classification,
              "query_coverage": {"owned": len(test_snapshot["users"]), "with_positives": len({r["user_key"] for r in test_targets if r["label"] == "liked"})},
              "split_support": {name: dict(Counter(row["label"] for row in targets)) for name, _, targets, _ in splits},
              "fixed_train_cluster_run": str(Path(args.cluster_run).resolve()), "tree": tree_report}
    from build_hybrid_ranking import _coverage, _usage
    report.update(_coverage(test_snapshot, test_components, rankings))
    report.update(_usage(test_snapshot, test_components, rankings, selected["weights"]))
    write_json(directory / "ranking_report.json", report)
    (directory / "ranking_report.md").write_text("# Week 5 synthetic demo benchmark\n\nSynthetic computed metrics; not public-user evidence.\n\n" +
        "\n".join(f"- {row['algorithm']} @{row['top_k']}: P={row['precision']:.6f}, R={row['recall']:.6f}, NDCG={row['ndcg']:.6f}" for row in summary) + "\n")
    write_json(directory / "split_manifest.json", {**base, **guard, "cutoffs": [time.isoformat() for time in times],
               "ends": [end.isoformat() for end in ends], "selection_results_not_unbiased_validation_serving": True})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path)
    parser.add_argument("--cohort", choices=("team_test", "synthetic"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--train-cutoff", default=DATES[0])
    parser.add_argument("--validation-cutoff", default=DATES[1])
    parser.add_argument("--test-cutoff", default=DATES[2])
    parser.add_argument("--cluster-run", type=Path)
    parser.add_argument("--trusted-models", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        from week5_evaluation import self_check
        self_check()
        return
    if not all((args.source_manifest, args.cohort, args.output_dir)):
        parser.error("--source-manifest, --cohort and --output-dir are required")
    if args.cohort == "synthetic" and not args.cluster_run:
        parser.error("synthetic benchmark requires --cluster-run")
    report = evaluation_run(args)
    print("evaluation:", report["status"])


if __name__ == "__main__":
    main()
