"""Render the private aggregate Week 4 Markdown and JSON report."""

import json
from pathlib import Path

from preference_features import ADVANCED_FEATURES, BASIC_FEATURES, FEATURE_DESCRIPTIONS, LABELS

ROOT = Path(__file__).resolve().parents[1]


def private_output_path(path):
    resolved = path.resolve()
    try:
        resolved.relative_to((ROOT / "tmp").resolve())
    except ValueError as error:
        raise ValueError("reports must remain under the ignored tmp/ directory") from error
    return resolved


def _counts_table(splits):
    lines = ["| Split | Rows | Disliked | Neutral | Liked |", "|---|---:|---:|---:|---:|"]
    for name, data in splits.items():
        counts = data["class_counts"]
        lines.append(f"| {name} | {data['rows']} | {counts['disliked']} | {counts['neutral']} | {counts['liked']} |")
    return lines


def _metric_lines(result):
    metrics = result.get("test_metrics")
    if not metrics:
        return ["- Test metrics: `N/A`"]
    lines = [f"- Macro-F1 `{metrics['macro_f1']}`; accuracy `{metrics['accuracy']}` (secondary)."]
    lines.append("- Per-class (precision / recall / F1 / support):")
    for label in LABELS:
        values = metrics["per_class"][label]
        lines.append(f"  - {label}: {values['precision']} / {values['recall']} / {values['f1']} / {values['support']}")
    lines.append(f"- Confusion matrix (actual rows; labels {', '.join(LABELS)}): `{result['confusion_matrix']}`")
    return lines


def _feature_lines(features):
    return [f"- `{name}` — {FEATURE_DESCRIPTIONS[name]}" for name in features]


def _key_value_lines(values):
    return [f"- `{key}`: `{value}`" for key, value in values.items()]


def summary_section(report, manifest):
    return [
        "## 1. Summary", "", "- Question: predict the rating class immediately before the rating event.",
        f"- Cohort/status: `{report['cohort']}` / **{report['evaluation_status']}** — {report['status_reason']}.",
        f"- Target rows: {manifest.get('output_rows', 'N/A')}; labels: `{manifest.get('label_counts', {})}`.",
        "- Team-test/synthetic/unknown runs are smoke-test evidence; no generalization claim.", "",
    ]


def provenance_section(report, manifest):
    return [
        "## 2. Source and provenance", "",
        f"- Feature version `{report['feature_version']}`; code revision `{manifest.get('code_revision', 'N/A')}`.",
        f"- Build time `{manifest.get('generated_at_utc', 'N/A')}`; source export time was not supplied; Python/scikit-learn `{manifest.get('software_versions', {})}`.",
        f"- Input files `{manifest.get('input_paths', {})}`.",
        f"- Builder command: `{manifest.get('builder_command', 'N/A')}`; feature table SHA-256 `{report.get('feature_input_sha256', 'N/A')}`.",
        f"- Input row counts `{manifest.get('input_counts', {})}`; unique users/titles `{manifest.get('unique_users', 'N/A')}/{manifest.get('unique_titles', 'N/A')}`.",
        f"- Event time ranges `{manifest.get('event_time_ranges', {})}`.",
        f"- Input SHA-256 `{manifest.get('input_sha256', {})}`; search SHA-256 `{manifest.get('searches_sha256', 'N/A')}`.",
        f"- Cohort counts `{manifest.get('cohort_counts', {})}`; exclusions `{manifest.get('excluded', {})}`.",
        "- User, session, device identifiers and raw search text are omitted from this report.", "",
    ]


def readiness_section(manifest):
    readiness = manifest.get("database_readiness", {})
    return [
        "## 4. Data quality and readiness", "",
        f"- Database preflight: **{readiness.get('status', 'not_provided')}**; missing `{readiness.get('missing_checks', [])}`; failed `{readiness.get('failed_checks', [])}`.",
        "- SQL aggregate checks:", *_key_value_lines(readiness.get("checks", {})),
        f"- Builder exclusions `{manifest.get('excluded', {})}`.",
        "- Feature missing counts:", *_key_value_lines(manifest.get("feature_missingness", {})),
        "- Canonical watch view excludes repair rows; owner/title coverage is summarized by SQL preflight.", "",
    ]


def feature_section():
    return [
        "## 5. Features and leakage controls", "",
        "- Every behavioral feature uses server event time strictly before `rated_at`; equal timestamps are excluded.",
        "- Missing numeric values use train medians plus missing indicators; preprocessing is fitted on train only.",
        "- Basic features:", *_feature_lines(BASIC_FEATURES),
        "- Advanced features:", *_feature_lines(ADVANCED_FEATURES),
        "- IDs/cohort are grouping/filtering fields, never predictors. Search is activity only, not a title click.", "",
    ]


def split_model_section(report):
    return [
        "## 6. Split, model and baseline", "",
        "- Chronological split class counts:", "", *_counts_table(report["split"]), "",
        f"- Split time ranges: `{report['split_timestamps']}`.",
        f"- Model settings: `{report['tree_parameters']}`; preprocessing: `{report['preprocessing']}`.",
        f"- Majority baseline is fitted from train labels only; train majority `{report['majority_baseline']['majority_class_from_train']}`.", "",
    ]


def evaluation_section(report):
    lines = ["## 7. Evaluation and interpretation", "", "- Majority baseline:", *_metric_lines(report["majority_baseline"])]
    for feature_set, result in report["models"].items():
        selected = result.get("selected", {})
        lines.extend([
            "", f"### {feature_set}", "",
            f"- Validation candidate count: `{result.get('candidate_count', 0)}`; top candidates: `{result.get('validation_candidates_top5', [])}`.",
            f"- Best CCP-pruned candidate by validation: `{result.get('ccp_best_validation_candidate')}`.",
            f"- Final selected config: `{selected.get('parameters', 'smoke-test illustrative tree')}`.",
            f"- Selected train/validation Macro-F1: `{result.get('train_macro_f1')}` / `{selected.get('validation_macro_f1')}`.",
        ])
        alpha = result.get("ccp_alpha_selected")
        lines.append(f"- Final selected CCP alpha: `{alpha}`." if alpha is not None else "- Final selected model did not use a CCP-pruned candidate.")
        lines.extend(_metric_lines(result))
        if selected.get("feature_importance"):
            lines.append(f"- Feature importance: `{selected['feature_importance']}`.")
            lines.extend(["- Tree rules:", "", "```text", selected["tree_rules"], "```"])
    lines.extend(["", "- Macro-F1 is primary; accuracy is secondary. Tree rules/importance are descriptive, not causal.", ""])
    return lines


def reproducibility_section(report):
    return [
        "## 8. Reproducibility, limitations and next step", "",
        f"- Builder manifest: `{report.get('manifest_path', 'N/A')}`; feature dataset: `{report.get('feature_input_path', 'N/A')}`; evaluator command: `{report.get('command', 'N/A')}`.",
        "- A valid report requires a verified `public_user` cohort, passed SQL readiness checks, all classes in train/validation/test, and at least 5 test examples per class.",
        "- Migration 009 reconciliation is deferred for this offline workflow per user request; it remains an operational risk before deploy/migration.",
        "- Next step: gather a separately verified public-user cohort with adequate class support, then rerun the same snapshot pipeline.", "",
    ]


def write_report(path, report):
    resolved = private_output_path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.with_suffix(".json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest = report.get("manifest", {})
    sections = [
        ["# Week 4 Preference Classification", ""],
        summary_section(report, manifest),
        provenance_section(report, manifest),
        ["## 3. Target and label policy", "", "- Grain: one row per rating event; `y` is the user-entered rating class. Rating/target IDs are not predictors.",
         f"- Mapping: `{manifest.get('label_policy', 'N/A')}`; raw value counts `{manifest.get('rating_value_counts', {})}`.",
         "- Rating 0 maps to disliked; retain its source provenance. 3.5/6.5 stop label construction.", ""],
        readiness_section(manifest), feature_section(), split_model_section(report),
        evaluation_section(report), reproducibility_section(report),
    ]
    resolved.with_suffix(".md").write_text("\n".join(line for section in sections for line in section), encoding="utf-8")
