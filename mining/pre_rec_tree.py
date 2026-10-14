#!/usr/bin/env python3
"""Pure pre-recommendation decision-tree helpers for the Week 5 ranking stage.

No file or model IO lives here; the evaluator owns bundle persistence.
"""

from collections import Counter

import numpy as np
from sklearn.metrics import f1_score

from evaluate_preference_tree import (
    classification_metrics,
    fit_medians,
    fit_tree,
    matrix,
    tree_config,
    tree_summary,
)
from preference_features import LABELS
from week5_artifacts import TREE_FEATURES

FEATURE_VERSION = "preference_ranker-v1"
LIKED = "liked"


def _class_counts(rows):
    counts = Counter(row["label"] for row in rows)
    return {label: counts.get(label, 0) for label in LABELS}


def _candidate_configs(x_train, train_labels):
    configs = [("max_depth_1", tree_config(max_depth=1)), ("max_depth_3", tree_config(max_depth=3))]
    path_tree = fit_tree(x_train, train_labels, tree_config())
    path = path_tree.cost_complexity_pruning_path(x_train, train_labels)
    alphas = sorted({float(alpha) for alpha in path.ccp_alphas if float(alpha) > 0})
    configs.extend((f"ccp_alpha_{alpha:.8g}", tree_config(ccp_alpha=alpha)) for alpha in alphas)
    return configs


def _evaluate_candidates(x_train, train_labels, x_val, val_labels, model_features):
    candidates, best = [], None
    for name, config in _candidate_configs(x_train, train_labels):
        tree = fit_tree(x_train, train_labels, config)
        summary = tree_summary(tree, config, model_features)
        score = (float(f1_score(val_labels, tree.predict(x_val), labels=LABELS, average="macro", zero_division=0))
                 if val_labels else None)
        summary["name"] = name
        summary["validation_macro_f1"] = round(score, 6) if score is not None else None
        candidates.append(summary)
        key = (score if score is not None else -1.0, -summary["leaves"], -summary["depth"],
               float(config["ccp_alpha"]), name)
        if best is None or key > best[0]:
            best = (key, name, tree, summary)
    return candidates, best


def _top_candidates(candidates):
    ordered = sorted(candidates, key=lambda item: (
        -(item["validation_macro_f1"] if item["validation_macro_f1"] is not None else -1),
        item["leaves"], item["depth"], -item["parameters"]["ccp_alpha"], item["name"]))
    return [{key: item[key] for key in ("name", "parameters", "leaves", "depth", "validation_macro_f1")}
            for item in ordered[:5]]


def _build_report(feature_order, model_features, train_rows, val_rows, candidates,
                  selected_tree, selected_summary, x_val, val_labels):
    classes = [str(value) for value in selected_tree.classes_]
    return {
        "feature_version": FEATURE_VERSION,
        "feature_order": feature_order,
        "missing_indicator_order": model_features[len(feature_order):],
        "preprocessing": "train medians and missing indicators; validation/test are never fit",
        "criterion": "entropy",
        "random_state": 42,
        "min_samples_split": 4,
        "min_samples_leaf": 2,
        "selection_metric": "validation_macro_f1; ties prefer fewer leaves, then shallower, then more pruning, then name",
        "train_rows": len(train_rows),
        "validation_rows": len(val_rows),
        "train_class_counts": _class_counts(train_rows),
        "validation_class_counts": _class_counts(val_rows) if val_rows else {},
        "candidate_count": len(candidates),
        "ccp_candidate_count": sum(1 for item in candidates if item["name"].startswith("ccp_alpha_")),
        "validation_candidates_top5": _top_candidates(candidates),
        "validation_candidates": candidates,
        "selected": selected_summary,
        "classes": classes,
        "liked_class_index": classes.index(LIKED) if LIKED in classes else None,
        "validation_metrics": classification_metrics(val_labels, selected_tree.predict(x_val)) if val_rows else None,
    }


def _build_bundle(selected_tree, selected_name, selected_summary, medians, feature_order, model_features):
    return {"tree": selected_tree, "medians": medians, "feature_order": feature_order,
            "missing_indicator_order": model_features[len(feature_order):],
            "model_feature_order": model_features,
            "classes": [str(value) for value in selected_tree.classes_],
            "selected_name": selected_name, "validation_macro_f1": selected_summary["validation_macro_f1"],
            "feature_version": FEATURE_VERSION}


def fit_preference_model(train_rows, val_rows):
    """Fit train-median imputation plus entropy trees; select on validation macro-F1."""
    train_rows, val_rows = list(train_rows), list(val_rows)
    if not train_rows:
        raise ValueError("fit_preference_model requires training rows")
    feature_order = list(TREE_FEATURES)
    medians = fit_medians(train_rows, feature_order)
    model_features, x_train = matrix(train_rows, feature_order, medians)
    x_val = matrix(val_rows, feature_order, medians)[1] if val_rows else []
    train_labels = [row["label"] for row in train_rows]
    val_labels = [row["label"] for row in val_rows]
    candidates, best = _evaluate_candidates(x_train, train_labels, x_val, val_labels, model_features)
    _, selected_name, selected_tree, selected_summary = best
    report = _build_report(feature_order, model_features, train_rows, val_rows, candidates,
                           selected_tree, selected_summary, x_val, val_labels)
    bundle = _build_bundle(selected_tree, selected_name, selected_summary, medians, feature_order, model_features)
    return bundle, report


def feature_matrix(bundle, rows):
    """Return the trained imputation/missing-indicator matrix for raw rows."""
    rows = list(rows)
    if not rows:
        return np.empty((0, len(bundle["feature_order"]) * 2), dtype=float)
    names, values = matrix(rows, bundle["feature_order"], bundle["medians"])
    if names != list(bundle["model_feature_order"]):
        raise ValueError("tree bundle feature/missing-indicator order mismatch")
    return np.asarray(values, dtype=float)


def predict_liked(bundle, rows):
    """Return P(liked) per row, [] for no rows, or None when liked was absent in training."""
    rows = list(rows)
    if not rows:
        return []
    tree = bundle["tree"]
    classes = [str(value) for value in getattr(tree, "classes_", [])]
    if LIKED not in classes:
        return None
    probabilities = tree.predict_proba(feature_matrix(bundle, rows))
    return [float(value) for value in probabilities[:, classes.index(LIKED)]]


def _row(label, **overrides):
    row = {name: 0.5 for name in TREE_FEATURES}
    row.update(overrides)
    row["label"] = label
    return row


def _signal_rows(signals, count=30):
    return [_row(LABELS[index % len(LABELS)], content_profile_similarity=signals[LABELS[index % len(LABELS)]])
            for index in range(count)]


def self_check():
    signals = {"disliked": 0.1, "neutral": 0.5, "liked": 0.9}
    train = _signal_rows(signals)
    train[0]["content_profile_similarity"] = None
    train[3]["genre_affinity"] = None
    validation = _signal_rows(signals, count=15)
    bundle, report = fit_preference_model(train, validation)
    assert bundle["feature_order"] == list(TREE_FEATURES)
    assert report["missing_indicator_order"] == [f"{name}__missing" for name in TREE_FEATURES]
    assert report["selected"]["name"] and report["candidate_count"] >= 2
    assert len(bundle["classes"]) == 3 and report["liked_class_index"] == bundle["classes"].index(LIKED)

    # Medians come from train only; extreme validation values cannot move them.
    extreme = [dict(row, content_profile_similarity=1e9) for row in validation]
    other, _ = fit_preference_model(train, extreme)
    assert other["medians"] == bundle["medians"] == fit_medians(train, TREE_FEATURES)

    # Trained preprocessing produces the raw-plus-missing width and honest probabilities.
    x_train = feature_matrix(bundle, train)
    assert x_train.shape == (len(train), 2 * len(TREE_FEATURES))
    probabilities = predict_liked(bundle, validation)
    assert probabilities is not None and len(probabilities) == len(validation)
    native = bundle["tree"].predict_proba(x_train)
    assert all(abs(value - native[index][bundle["classes"].index(LIKED)]) < 1e-12
               for index, value in enumerate(predict_liked(bundle, train)))

    # Liked index is looked up, never assumed: a two-class tree can put liked first.
    two_class = [_row("liked", content_profile_similarity=0.9), _row("liked", content_profile_similarity=0.8),
                 _row("neutral", content_profile_similarity=0.1), _row("neutral", content_profile_similarity=0.2)]
    small, _ = fit_preference_model(two_class, two_class)
    assert small["classes"][0] == LIKED and small["tree"].classes_[0] == LIKED
    assert predict_liked(small, two_class) == [float(value) for value in small["tree"].predict_proba(
        feature_matrix(small, two_class))[:, 0]]

    # A missing liked class yields None instead of an IndexError.
    no_liked = [_row("disliked", content_profile_similarity=0.1), _row("neutral", content_profile_similarity=0.5)]
    bundle_none, _ = fit_preference_model(no_liked, no_liked)
    assert LIKED not in bundle_none["classes"] and predict_liked(bundle_none, no_liked) is None
    assert predict_liked(bundle, []) == []
    print("self-check ok: liked class lookup, train-only medians, missing-indicator preprocess")


if __name__ == "__main__":
    self_check()
