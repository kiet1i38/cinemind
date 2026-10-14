"""Private Week 5 output primitives and guards before trusted joblib loading."""

import csv
import json
import platform
from pathlib import Path

import joblib
import numpy
import scipy
import sklearn

from build_preference_dataset import ROOT, sha256_file
from preference_features import parse_time

VERSION = "week5-v1"
TREE_FEATURES = ["content_profile_similarity", "genre_affinity", "watch_event_rows_7d",
                 "unique_watched_titles_30d", "liked_titles_30d", "days_since_last_interaction"]


def output_dir(path):
    path = Path(path).resolve()
    try:
        path.relative_to((ROOT / "tmp/week5").resolve())
    except ValueError as error:
        raise ValueError("Week 5 outputs must remain under ignored tmp/week5") from error
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path, payload):
    Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True, default=str, allow_nan=False) + "\n")


def write_csv(path, rows, fields=None):
    rows = list(rows)
    fields = fields or (list(rows[0]) if rows else [])
    with Path(path).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def runtime():
    return {"python": platform.python_version(), "sklearn": sklearn.__version__,
            "numpy": numpy.__version__, "scipy": scipy.__version__, "joblib": joblib.__version__}


def provenance(source, cohort):
    return {"schema_version": VERSION, "cohort": cohort, "input_sha256": source["hashes"],
            "runtime": runtime(), "evidence_status": "synthetic_demo" if cohort == "synthetic" else "team_test_smoke"}


def save_bundle(directory, name, bundle, metadata):
    directory = output_dir(directory)
    path = directory / (name + ".joblib")
    joblib.dump(bundle, path)
    write_json(directory / (name + ".json"), {**metadata, "bundle_sha256": sha256_file(path)})


def validate_metadata(metadata, source, cohort, cutoff):
    expected = provenance(source, cohort)
    for key in ("schema_version", "cohort", "input_sha256", "runtime"):
        if metadata.get(key) != expected[key]:
            raise ValueError(f"artifact {key} mismatch")
    query = parse_time(cutoff, "query cutoff") if isinstance(cutoff, str) else cutoff
    for key in ("trained_through", "selected_through"):
        if key not in metadata or parse_time(metadata[key], key) > query:
            raise ValueError(f"artifact {key} exceeds query cutoff or is missing")
    return metadata


def load_bundle(directory, name, source, cohort, cutoff, trusted=False):
    directory = Path(directory).resolve()
    # A local path alone cannot make a pickle safe; callers explicitly trust this pipeline's outputs.
    if not trusted:
        raise ValueError("joblib requires explicit --trusted-models for locally produced artifacts")
    try:
        directory.relative_to((ROOT / "tmp/week5").resolve())
    except ValueError as error:
        raise ValueError("model must be a local Week 5 artifact") from error
    path = directory / (name + ".joblib")
    metadata = json.loads((directory / (name + ".json")).read_text())
    validate_metadata(metadata, source, cohort, cutoff)
    expected_features = TREE_FEATURES if name == "preference_ranker" else [
        *(f"genre_share__{genre}" for genre in source["genre_universe"]),
        "log1p_unique_watched_titles_30d", "log1p_watch_event_rows_7d"]
    if metadata.get("feature_order") != expected_features or metadata.get("feature_version") != name + "-v1":
        raise ValueError("artifact feature version/order mismatch")
    if name == "preference_ranker":
        missing = [feature + "__missing" for feature in TREE_FEATURES]
        if metadata.get("missing_indicator_order") != missing or metadata.get("model_feature_order") != TREE_FEATURES + missing:
            raise ValueError("artifact preprocessing order mismatch")
        if set(metadata.get("medians", {})) != set(TREE_FEATURES) or not set(metadata.get("classes", [])) <= {"liked", "neutral", "disliked"}:
            raise ValueError("artifact preprocessing/classes mismatch")
    if sha256_file(path) != metadata.get("bundle_sha256"):
        raise ValueError("model checksum mismatch")
    return joblib.load(path), metadata


def self_check():
    source = {"hashes": {"catalog": "fixture"}}
    metadata = {**provenance(source, "synthetic"),
                "trained_through": "2026-08-08T00:00:00Z",
                "selected_through": "2026-08-15T00:00:00Z"}
    validate_metadata(metadata, source, "synthetic", "2026-08-15T00:00:00Z")
    bad = [({**metadata, "cohort": "team_test"}, "2026-08-22T00:00:00Z"),
           ({**metadata, "schema_version": "old"}, "2026-08-22T00:00:00Z"),
           ({**metadata, "input_sha256": {}}, "2026-08-22T00:00:00Z"),
           ({**metadata, "runtime": {}}, "2026-08-22T00:00:00Z"),
           (metadata, "2026-08-14T23:59:59Z")]
    for value, cutoff in bad:
        try:
            validate_metadata(value, source, "synthetic", cutoff)
        except ValueError:
            continue
        raise AssertionError("mismatched artifact accepted")
    print("self-check ok: artifact cohort/hash/version/runtime/time guards")
