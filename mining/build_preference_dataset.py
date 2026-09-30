#!/usr/bin/env python3
"""Build a private, prior-only Week 4 feature table from pseudonymous CSV exports.

Expected inputs (keys must be salted pseudonyms, never raw DB/user identifiers):
  ratings: target_key,user_key,cohort,show_id,rating_value,rated_at
  watches: watch_key,user_key,cohort,show_id,watch_seconds,completion_rate,
           duration_basis,recorded_at[,is_repair]
  searches (optional): search_key,user_key,cohort,occurred_at
  catalog: output of clean_catalog.py; build_baseline.py supplies reusable TF-IDF.

Use interaction.watch_sessions_for_mining for watches and join each event's
session to its authenticated user before pseudonymizing. Do not export queries.
"""

import argparse
import csv
import hashlib
import json
import platform
import shlex
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import sklearn

from preference_features import (
    ADVANCED_FEATURES, ALL_FEATURES, BASIC_FEATURES, FEATURE_DESCRIPTIONS, FEATURE_VERSION,
    GENRE_HALF_LIFE_DAYS, build_rows, prepare_events, self_check as feature_self_check,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RATINGS = ROOT / "tmp/ratings.csv"
DEFAULT_WATCHES = ROOT / "tmp/watches_for_mining.csv"
DEFAULT_SEARCHES = ROOT / "tmp/searches.csv"
DEFAULT_CATALOG = ROOT / "tmp/catalog_clean.csv"
DEFAULT_READINESS = ROOT / "tmp/week4_readiness.csv"
DEFAULT_OUTPUT = ROOT / "tmp/week4_preference_features.csv"
DEFAULT_MANIFEST = ROOT / "tmp/week4_preference_manifest.json"
REQUIRED_ZERO_CHECKS = (
    "ratings_owner_missing",
    "ratings_title_missing",
    "ratings_unmapped_labels",
    "ratings_duplicate_mutations",
    "watches_owner_missing",
    "watches_title_missing",
    "watches_duplicate_mutations",
    "watches_invalid_values",
    "searches_duplicate_mutations",
)

def detect_delimiter(header):
    return max((",", ";", "\t"), key=header.count)


def read_csv(path, required):
    with path.open(newline="", encoding="utf-8-sig") as handle:
        header = handle.readline()
        delimiter = detect_delimiter(header)
        handle.seek(0)
        reader = csv.DictReader(handle, delimiter=delimiter)
        missing = set(required) - set(reader.fieldnames or ())
        if missing:
            raise ValueError(f"{path}: missing columns: {', '.join(sorted(missing))}")
        return list(reader)


def readiness_summary(checks):
    missing = [name for name in REQUIRED_ZERO_CHECKS if name not in checks]
    failed = []
    for name in REQUIRED_ZERO_CHECKS:
        if name in checks:
            try:
                passed = float(checks[name]) == 0
            except ValueError:
                passed = False
            if not passed:
                failed.append(name)
    status = "incomplete" if missing else "failed" if failed else "passed"
    return {"status": status, "checks": checks, "missing_checks": missing, "failed_checks": failed}


def read_readiness(path):
    if not path.exists():
        return {"status": "not_provided", "checks": {}, "missing_checks": list(REQUIRED_ZERO_CHECKS), "failed_checks": []}
    rows = read_csv(path, ("check_name", "observed_value"))
    checks = {}
    for row in rows:
        name, value = row["check_name"].strip(), row["observed_value"].strip()
        if not name or name in checks:
            raise ValueError(f"{path}: check_name must be present and unique")
        checks[name] = value
    return readiness_summary(checks)


def self_check():
    assert detect_delimiter("a,b,c") == ","
    assert detect_delimiter("a;b;c") == ";"
    passing = {name: "0" for name in REQUIRED_ZERO_CHECKS}
    failing = {**passing, "watches_invalid_values": "2"}
    assert readiness_summary(passing)["status"] == "passed"
    assert readiness_summary(failing)["status"] == "failed"
    assert readiness_summary({})["status"] == "incomplete"
    feature_self_check()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def code_revision():
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
        return f"{head}{'+dirty' if dirty else ''}"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def private_output_path(path):
    resolved = path.resolve()
    try:
        resolved.relative_to((ROOT / "tmp").resolve())
    except ValueError as error:
        raise ValueError("row-level data and manifests must remain under the ignored tmp/ directory") from error
    return resolved


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["target_key", "user_key", "cohort", "show_id", "rated_at", "rating_value", "label", *ALL_FEATURES]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def event_time_ranges(events):
    return {
        name: {
            "min": min(row["event_time"] for row in source).isoformat() if source else None,
            "max": max(row["event_time"] for row in source).isoformat() if source else None,
        }
        for name, source in events.items()
    }


def build_manifest(args, input_counts, events, rows, exclusions, readiness):
    rating_values = Counter(row["rating_value"] for row in events["ratings"])
    return {
        "feature_version": FEATURE_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "code_revision": code_revision(),
        "builder_command": shlex.join([sys.executable, *sys.argv]),
        "software_versions": {"python": platform.python_version(), "scikit_learn": sklearn.__version__},
        "label_policy": {"disliked": "0-3", "neutral": "4-6", "liked": "7-10"},
        "prediction_time": "immediately_before_rating",
        "event_time_policy": "server rated_at, recorded_at, and occurred_at timestamps",
        "identity_policy": "user_key is an exporter-supplied salted pseudonym; historical session ownership cannot be reconstructed if account ownership changed",
        "cohort_policy": "cohort is exporter-supplied from a private manifest; never inferred from identifiers or user-agent",
        "cutoff": "event_time < rated_at; equal timestamps excluded",
        "days_since_last_interaction": "prior owned watch, rating, or search event",
        "recent_activity_7d": "count of prior watch rows in [rated_at - 7 days, rated_at)",
        "watch_source": "interaction.watch_sessions_for_mining; play_count counts watch rows, not proven playback starts",
        "positive_history": "prior rating label liked (>=7)",
        "genre_half_life_days": GENRE_HALF_LIFE_DAYS,
        "content_profile_scope": "TF-IDF fit on cleaned catalog text only; user profile uses unique prior-liked titles",
        "features": {"basic": list(BASIC_FEATURES), "advanced": list(ADVANCED_FEATURES)},
        "feature_definitions": FEATURE_DESCRIPTIONS,
        "input_sha256": {name: sha256_file(path) for name, path in (("ratings", args.ratings), ("watches", args.watches), ("catalog", args.catalog))},
        "searches_sha256": sha256_file(args.searches) if args.searches.exists() else None,
        "readiness_sha256": sha256_file(args.readiness) if args.readiness.exists() else None,
        "input_counts": input_counts,
        "input_paths": {
            "ratings": str(args.ratings), "watches": str(args.watches),
            "searches": str(args.searches) if args.searches.exists() else None,
            "catalog": str(args.catalog), "readiness": str(args.readiness) if args.readiness.exists() else None,
        },
        "event_time_ranges": event_time_ranges(events),
        "output_rows": len(rows),
        "unique_users": len({row["user_key"] for row in rows}),
        "unique_titles": len({row["show_id"] for row in rows}),
        "cohort_counts": dict(Counter(row["cohort"] for row in rows)),
        "label_counts": dict(Counter(row["label"] for row in rows)),
        "rating_value_counts": dict(rating_values),
        "feature_missingness": {name: sum(row[name] is None for row in rows) for name in ALL_FEATURES},
        "database_readiness": readiness,
        "excluded": dict(exclusions),
        "private_row_level_output": str(args.output),
    }


def run(args):
    args.output = private_output_path(args.output)
    args.manifest = private_output_path(args.manifest)
    rating_rows = read_csv(args.ratings, ("target_key", "user_key", "cohort", "show_id", "rating_value", "rated_at"))
    watch_rows = read_csv(args.watches, ("watch_key", "user_key", "cohort", "show_id", "watch_seconds", "completion_rate", "duration_basis", "recorded_at"))
    search_rows = read_csv(args.searches, ("search_key", "user_key", "cohort", "occurred_at")) if args.searches.exists() else []
    catalog_rows = read_csv(args.catalog, ("show_id", "title_clean", "description_clean", "genres_clean", "cleaning_status"))
    readiness = read_readiness(args.readiness)
    ratings, watches, searches, exclusions = prepare_events(rating_rows, watch_rows, search_rows)
    rows = build_rows(ratings, watches, searches, catalog_rows)
    write_csv(args.output, rows)
    events = {"ratings": ratings, "watches": watches, "searches": searches}
    manifest = build_manifest(
        args,
        {"ratings": len(rating_rows), "watches": len(watch_rows), "searches": len(search_rows)},
        events, rows, exclusions, readiness,
    )
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} private target rows to {args.output}")
    print(f"label_counts: {manifest['label_counts']}; excluded: {dict(exclusions)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ratings", type=Path, default=DEFAULT_RATINGS)
    parser.add_argument("--watches", type=Path, default=DEFAULT_WATCHES)
    parser.add_argument("--searches", type=Path, default=DEFAULT_SEARCHES)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--readiness", type=Path, default=ROOT / "tmp/week4_readiness.csv")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
    else:
        run(args)


if __name__ == "__main__":
    main()
