#!/usr/bin/env python3
"""Compare Week 4 Decision Tree baselines on one cohort's chronological split."""

import argparse
import csv
import hashlib
import json
import math
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sklearn.metrics import confusion_matrix, f1_score, precision_recall_fscore_support
from sklearn.tree import DecisionTreeClassifier, export_text

from preference_features import (
    ADVANCED_FEATURES,
    BASIC_FEATURES,
    COHORTS,
    FEATURE_VERSION,
    LABELS,
    parse_time,
)
from week4_report import private_output_path, write_report

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "tmp/week4_preference_features.csv"
DEFAULT_MANIFEST = ROOT / "tmp/week4_preference_manifest.json"
DEFAULT_REPORT = ROOT / "tmp/week4_preference_report"
RANDOM_SEED = 42
MIN_TEST_SUPPORT = 5
MIN_SAMPLES_SPLIT = 4
MIN_SAMPLES_LEAF = 2


def read_rows(path, cohort):
    required = {"cohort", "rated_at", "label", *BASIC_FEATURES, *ADVANCED_FEATURES}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise ValueError(f"{path}: missing columns: {', '.join(sorted(missing))}")
        rows = []
        for index, raw in enumerate(reader, start=2):
            if raw["cohort"] != cohort:
                continue
            if raw["label"] not in LABELS:
                raise ValueError(f"{path}:{index}: unknown label {raw['label']!r}")
            row = {"label": raw["label"], "rated_at": parse_time(raw["rated_at"], f"{path}:{index}")}
            for feature in (*BASIC_FEATURES, *ADVANCED_FEATURES):
                value = raw.get(feature, "").strip()
                number = None if not value else float(value)
                if number is not None and not math.isfinite(number):
                    raise ValueError(f"{path}:{index}: {feature} must be finite")
                row[feature] = number
            rows.append(row)
    return rows


def chronological_split(rows):
    times = sorted({row["rated_at"] for row in rows})
    if len(times) < 3:
        return None
    train_end = max(1, int(len(times) * 0.6))
    validation_end = max(train_end + 1, int(len(times) * 0.8))
    if validation_end >= len(times):
        validation_end = len(times) - 1
    if train_end >= validation_end:
        return None
    train_cutoff, validation_cutoff = times[train_end], times[validation_end]
    return (
        [r for r in rows if r["rated_at"] < train_cutoff],
        [r for r in rows if train_cutoff <= r["rated_at"] < validation_cutoff],
        [r for r in rows if r["rated_at"] >= validation_cutoff],
    )


def class_counts(rows):
    counts = Counter(row["label"] for row in rows)
    return {label: counts.get(label, 0) for label in LABELS}


def evaluation_status(cohort, splits, readiness_status):
    reasons = []
    if cohort != "public_user":
        reasons.append(f"cohort is {cohort}, not confirmed public-user data")
    if readiness_status != "passed":
        reasons.append(f"database readiness is {readiness_status}")
    if splits is None:
        reasons.append("fewer than three distinct target timestamps")
    else:
        for name, rows in zip(("train", "validation", "test"), splits):
            absent = [label for label, count in class_counts(rows).items() if count == 0]
            if absent:
                reasons.append(f"{name} lacks classes: {', '.join(absent)}")
        low_test = [label for label, count in class_counts(splits[2]).items() if count < MIN_TEST_SUPPORT]
        if low_test:
            reasons.append(f"test support below {MIN_TEST_SUPPORT} for: {', '.join(low_test)}")
    if reasons:
        return "smoke_test_only", "; ".join(reasons)
    return "provisional_holdout", f"readiness passed; test support is at least {MIN_TEST_SUPPORT} per class; still exploratory"


def fit_medians(rows, feature_names):
    medians = {}
    for name in feature_names:
        values = sorted(row[name] for row in rows if row[name] is not None)
        if not values:
            medians[name] = -1.0
        elif len(values) % 2:
            medians[name] = values[len(values) // 2]
        else:
            mid = len(values) // 2
            medians[name] = (values[mid - 1] + values[mid]) / 2
    return medians


def matrix(rows, feature_names, medians):
    names = list(feature_names) + [f"{name}__missing" for name in feature_names]
    values = []
    for row in rows:
        values.append(
            [medians[name] if row[name] is None else row[name] for name in feature_names]
            + [int(row[name] is None) for name in feature_names]
        )
    return names, values


def classification_metrics(actual, predicted):
    precision, recall, f1, support = precision_recall_fscore_support(
        actual, predicted, labels=LABELS, zero_division=0
    )
    per_class = {
        label: {
            "precision": round(float(p), 6) if n else None,
            "recall": round(float(r), 6) if n else None,
            "f1": round(float(score), 6) if n else None,
            "support": int(n),
        }
        for label, p, r, score, n in zip(LABELS, precision, recall, f1, support)
    }
    return {
        "test_metrics": {
            "macro_f1": round(float(f1_score(actual, predicted, labels=LABELS, average="macro", zero_division=0)), 6),
            "accuracy": round(float(sum(a == b for a, b in zip(actual, predicted)) / len(actual)), 6),
            "per_class": per_class,
        },
        "confusion_matrix": confusion_matrix(actual, predicted, labels=LABELS).tolist(),
    }


def tree_config(max_depth=None, ccp_alpha=0.0):
    return {
        "criterion": "entropy",
        "max_depth": max_depth,
        "min_samples_split": MIN_SAMPLES_SPLIT,
        "min_samples_leaf": MIN_SAMPLES_LEAF,
        "ccp_alpha": ccp_alpha,
        "random_state": RANDOM_SEED,
    }


def fit_tree(x_train, train_labels, config):
    tree = DecisionTreeClassifier(**config)
    tree.fit(x_train, train_labels)
    return tree


def tree_summary(tree, config, feature_names):
    return {
        "parameters": config,
        "leaves": int(tree.tree_.n_leaves),
        "depth": int(tree.tree_.max_depth),
        "tree_rules": export_text(tree, feature_names=feature_names).strip(),
        "feature_importance": {
            name: round(float(value), 6)
            for name, value in zip(feature_names, tree.feature_importances_)
            if value > 0
        },
    }


def validation_candidates(x_train, train_labels, x_validation, validation_labels, feature_names, status):
    candidates = []
    ccp_count = 0
    candidate_configs = [(f"max_depth_{depth}", tree_config(max_depth=depth)) for depth in (1, 3)]
    if status == "provisional_holdout":
        path_tree = fit_tree(x_train, train_labels, tree_config())
        path = path_tree.cost_complexity_pruning_path(x_train, train_labels)
        alphas = sorted({float(alpha) for alpha in path.ccp_alphas if alpha > 0})
        ccp_count = len(alphas)
        candidate_configs.extend((f"ccp_alpha_{alpha:.8g}", tree_config(ccp_alpha=alpha)) for alpha in alphas)
    for name, config in candidate_configs:
        tree = fit_tree(x_train, train_labels, config)
        result = {"name": name, **tree_summary(tree, config, feature_names), "validation_macro_f1": None}
        if status == "provisional_holdout":
            result["validation_macro_f1"] = round(
                float(f1_score(validation_labels, tree.predict(x_validation), labels=LABELS, average="macro", zero_division=0)),
                6,
            )
        candidates.append((result, tree))
    return candidates, ccp_count


def feature_set_result(train, validation, test, feature_names, status):
    train_labels = [row["label"] for row in train]
    validation_labels = [row["label"] for row in validation]
    test_labels = [row["label"] for row in test]
    medians = fit_medians(train, feature_names)
    model_features, x_train = matrix(train, feature_names, medians)
    _, x_validation = matrix(validation, feature_names, medians)
    _, x_test = matrix(test, feature_names, medians)
    candidates, ccp_candidate_count = validation_candidates(
        x_train, train_labels, x_validation, validation_labels, model_features, status
    )
    selected, selected_tree = max(
        candidates,
        key=lambda pair: (
            pair[0]["validation_macro_f1"] if pair[0]["validation_macro_f1"] is not None else 0,
            -pair[0]["leaves"],
            -pair[0]["depth"],
            pair[0]["parameters"]["ccp_alpha"],
        ),
    )
    candidate_summaries = [
        {key: summary[key] for key in ("name", "parameters", "leaves", "depth", "validation_macro_f1")}
        for summary, _ in candidates
    ]
    candidate_summaries.sort(key=lambda item: (
        -(item["validation_macro_f1"] if item["validation_macro_f1"] is not None else -1),
        item["leaves"], item["depth"], -item["parameters"]["ccp_alpha"],
    ))
    ccp_candidates = [item for item in candidate_summaries if item["name"].startswith("ccp_alpha_")]
    result = {
        "selection_metric": "validation_macro_f1; ties prefer fewer leaves, then shallower tree, then greater pruning",
        "validation_rows": len(validation),
        "test_rows": len(test),
        "candidate_count": len(candidates),
        "validation_candidates_top5": candidate_summaries[:5],
        "ccp_best_validation_candidate": ccp_candidates[0] if ccp_candidates else None,
        "selected": selected,
        "ccp_alpha_selected": selected["parameters"]["ccp_alpha"] if status == "provisional_holdout" and selected["name"].startswith("ccp_alpha_") else None,
        "ccp_candidate_count": ccp_candidate_count,
        "train_macro_f1": None,
        "test_metrics": None,
        "confusion_matrix": None,
    }
    if status == "provisional_holdout":
        result["train_macro_f1"] = round(
            float(f1_score(train_labels, selected_tree.predict(x_train), labels=LABELS, average="macro", zero_division=0)),
            6,
        )
        result.update(classification_metrics(test_labels, selected_tree.predict(x_test)))
    return result


def majority_result(train, test, status):
    train_labels = [row["label"] for row in train]
    test_labels = [row["label"] for row in test]
    majority = Counter(train_labels).most_common(1)[0][0] if train_labels else None
    result = {"majority_class_from_train": majority, "test_metrics": None, "confusion_matrix": None}
    if status == "provisional_holdout" and majority is not None:
        predicted = [majority] * len(test_labels)
        result.update(classification_metrics(test_labels, predicted))
    return result


def evaluate(rows, cohort, manifest):
    rows.sort(key=lambda row: row["rated_at"])
    splits = chronological_split(rows)
    readiness_status = manifest.get("database_readiness", {}).get("status", "not_provided")
    status, reason = evaluation_status(cohort, splits, readiness_status)
    if splits is None:
        train, validation, test = [], [], []
    else:
        train, validation, test = splits
    report = {
        "feature_version": FEATURE_VERSION,
        "cohort": cohort,
        "evaluation_status": status,
        "status_reason": reason,
        "prediction_time": "immediately_before_rating",
        "tree_parameters": {
            "criterion": "entropy",
            "max_depth_candidates": [1, 3],
            "min_samples_split": MIN_SAMPLES_SPLIT,
            "min_samples_leaf": MIN_SAMPLES_LEAF,
            "ccp_alpha": "training pruning path; validation Macro-F1 selects, ties prefer simpler tree",
            "random_state": RANDOM_SEED,
        },
        "preprocessing": "numeric missing values imputed with train medians and missing indicators; no fit on validation/test",
        "manifest": manifest,
        "split_timestamps": {
            name: {"first": part[0]["rated_at"].isoformat(), "last": part[-1]["rated_at"].isoformat()} if part else None
            for name, part in zip(("train", "validation", "test"), (train, validation, test))
        },
        "split": {
            name: {"rows": len(part), "class_counts": class_counts(part)}
            for name, part in zip(("train", "validation", "test"), (train, validation, test))
        },
        "majority_baseline": majority_result(train, test, status),
        "models": {},
        "interpretation": "Tree rules and importance are descriptive, not causal; test metrics are N/A unless all classes occur in every chronological split and cohort is public_user.",
    }
    if train:
        for feature_set, features in (("basic", BASIC_FEATURES), ("basic_plus_advanced", BASIC_FEATURES + ADVANCED_FEATURES)):
            report["models"][feature_set] = feature_set_result(train, validation, test, features, status)
    return report


def self_check():
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = [
        {"rated_at": base + timedelta(days=i), "label": label, **{name: 0.5 for name in (*BASIC_FEATURES, *ADVANCED_FEATURES)}}
        for i, label in enumerate(("disliked", "liked", "neutral", "liked", "disliked", "liked", "neutral", "liked", "disliked", "liked"))
    ]
    splits = chronological_split(rows)
    assert splits is not None and len(splits) == 3
    assert all(left[-1]["rated_at"] < right[0]["rated_at"] for left, right in zip(splits, splits[1:]))
    status, _ = evaluation_status("team_test", splits, "passed")
    assert status == "smoke_test_only", "team-test cohort must not be treated as generalization evidence"
    status, reason = evaluation_status("public_user", splits, "passed")
    assert status == "smoke_test_only" and ("lacks classes" in reason or "support below" in reason), "class support must suppress holdout metrics"
    assert evaluation_status("public_user", splits, "not_provided")[0] == "smoke_test_only"
    smoke_report = evaluate(rows, "team_test", {"database_readiness": {"status": "passed"}})
    assert smoke_report["majority_baseline"]["test_metrics"] is None
    assert smoke_report["models"]["basic"]["test_metrics"] is None
    no_split = chronological_split(rows[:2])
    assert evaluation_status("public_user", no_split, "passed")[0] == "smoke_test_only"

    balanced = []
    signals = {"disliked": 0.1, "neutral": 0.5, "liked": 0.9}
    for i, label in enumerate(("disliked", "neutral", "liked") * 25):
        features = {name: 0.5 for name in (*BASIC_FEATURES, *ADVANCED_FEATURES)}
        features["recent_activity_7d"] = signals[label]
        balanced.append({"rated_at": base + timedelta(days=i), "label": label, **features})
    balanced[0]["completion_ratio"] = None
    valid_report = evaluate(balanced, "public_user", {"database_readiness": {"status": "passed"}})
    assert valid_report["evaluation_status"] == "provisional_holdout"
    assert valid_report["majority_baseline"]["test_metrics"] is not None
    assert valid_report["models"]["basic"]["test_metrics"] is not None
    assert valid_report["models"]["basic_plus_advanced"]["ccp_candidate_count"] > 0
    assert valid_report["models"]["basic_plus_advanced"]["ccp_best_validation_candidate"] is not None
    print("self-check ok: support gate, validation pruning selection, tree, and majority metrics")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cohort", choices=sorted(COHORTS), required=False)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="output path prefix for .json and .md")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if not args.cohort:
        parser.error("--cohort is required so cohorts are never mixed")
    args.report = private_output_path(args.report)
    rows = read_rows(args.input, args.cohort)
    if not args.manifest.exists():
        raise SystemExit(f"Missing builder manifest: {args.manifest}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    report = evaluate(rows, args.cohort, manifest)
    digest = hashlib.sha256(args.input.read_bytes()).hexdigest()
    report["feature_input_sha256"] = digest
    report["feature_input_path"] = str(args.input)
    report["manifest_path"] = str(args.manifest)
    report["command"] = f"python mining/evaluate_preference_tree.py --input {args.input} --manifest {args.manifest} --cohort {args.cohort}"
    write_report(args.report, report)
    print(f"status={report['evaluation_status']}; cohort={args.cohort}; report={args.report.with_suffix('.md')}")


if __name__ == "__main__":
    main()
