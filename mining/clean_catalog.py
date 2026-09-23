#!/usr/bin/env python3
"""Standalone cleaner for the raw Netflix CSV.

Reads the frozen raw snapshot, applies the approved v0.1 cleaning rules, and
writes one deterministic cleaned CSV plus one JSON manifest. Standard library
only; no backend imports.
"""

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FIELDS = [
    "show_id",
    "type",
    "title_clean",
    "description_clean",
    "genres_clean",
    "description_missing",
    "genres_missing",
    "movie_duration_min",
    "season_count",
    "content_rating_clean",
    "cleaning_status",
    "cleaning_issues",
]

STATUS_VALID = "valid"
STATUS_WARNING = "valid_with_warning"
STATUS_QUARANTINE = "quarantine"
STATUSES = (STATUS_VALID, STATUS_WARNING, STATUS_QUARANTINE)

FATAL_ISSUES = {"missing_show_id", "duplicate_show_id", "missing_title", "unsupported_type"}

CLEANING_RULES_VERSION = "cleaning-v0.1"
BASELINE_VERSION = "baseline-v0.1"
BASELINE_FEATURES = ["title_clean", "description_clean", "genres_clean"]
EXPECTED_INPUT_ROWS = 8807

MIN_RE = re.compile(r"(\d+)\s*min", re.IGNORECASE)
SEASON_RE = re.compile(r"(\d+)\s*seasons?", re.IGNORECASE)
RATING_AS_MIN_RE = re.compile(r"\d+\s*min", re.IGNORECASE)


def normalize(value):
    """Trim and collapse whitespace; never invent content."""
    return " ".join((value or "").split())


def clean_genres(listed_in):
    parts = [g for g in (normalize(p) for p in (listed_in or "").split(",")) if g]
    genres = list(dict.fromkeys(parts))  # deduplicate, preserving order
    return ", ".join(genres), not genres


def clean_row(row, duplicate_ids=frozenset()):
    issues = []
    show_id = normalize(row.get("show_id"))
    content_type = normalize(row.get("type"))
    title = normalize(row.get("title"))
    description = normalize(row.get("description"))
    rating = normalize(row.get("rating"))
    duration = normalize(row.get("duration"))

    if not show_id:
        issues.append("missing_show_id")
    elif show_id in duplicate_ids:
        issues.append("duplicate_show_id")
    if not title:
        issues.append("missing_title")
    if content_type not in ("Movie", "TV Show"):
        issues.append("unsupported_type")

    description_missing = not description
    if description_missing:
        issues.append("missing_description")

    genres, genres_missing = clean_genres(row.get("listed_in"))
    if genres_missing:
        issues.append("missing_genres")

    movie_duration_min = ""
    season_count = ""
    if content_type == "Movie":
        match = MIN_RE.fullmatch(duration)
        if match:
            movie_duration_min = int(match.group(1))
        else:
            issues.append("missing_movie_duration" if not duration else "invalid_movie_duration")
    elif content_type == "TV Show":
        match = SEASON_RE.fullmatch(duration)
        if match:
            season_count = int(match.group(1))
        else:
            issues.append("missing_season_count" if not duration else "invalid_season_count")

    # A rating of "N min" is a shifted duration column: drop it, never infer minutes from it.
    content_rating_clean = rating
    if RATING_AS_MIN_RE.fullmatch(rating):
        content_rating_clean = ""
        issues.append("malformed_content_rating")

    if any(issue in FATAL_ISSUES for issue in issues):
        status = STATUS_QUARANTINE
    elif issues:
        status = STATUS_WARNING
    else:
        status = STATUS_VALID

    return {
        "show_id": show_id,
        "type": content_type,
        "title_clean": title,
        "description_clean": description,
        "genres_clean": genres,
        "description_missing": "true" if description_missing else "false",
        "genres_missing": "true" if genres_missing else "false",
        "movie_duration_min": movie_duration_min,
        "season_count": season_count,
        "content_rating_clean": content_rating_clean,
        "cleaning_status": status,
        "cleaning_issues": "; ".join(issues),
    }


def clean_rows(rows):
    # Ceiling: v0.1 covers only the approved cases; new anomaly classes need a rules version bump.
    duplicate_ids = {sid for sid, count in Counter(normalize(r.get("show_id")) for r in rows).items() if count > 1}
    cleaned = [clean_row(row, duplicate_ids) for row in rows]
    return cleaned, Counter(record["cleaning_status"] for record in cleaned)


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(input_path, output_path, manifest_path):
    rows = read_rows(input_path)
    if len(rows) != EXPECTED_INPUT_ROWS:
        print(f"warning: expected {EXPECTED_INPUT_ROWS} input rows, found {len(rows)}")
    cleaned, status_counts = clean_rows(rows)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(cleaned)

    manifest = {
        "raw_sha256": sha256_file(input_path),
        "input_rows": len(rows),
        "output_rows": len(cleaned),
        "status_counts": {status: status_counts.get(status, 0) for status in STATUSES},
        "cleaning_rules_version": CLEANING_RULES_VERSION,
        "baseline_version": BASELINE_VERSION,
        "baseline_features": BASELINE_FEATURES,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    print(f"wrote {output_path} ({len(cleaned)} rows) and {manifest_path}")
    print(f"status_counts: {manifest['status_counts']}")
    return manifest


def self_check(input_path):
    """Assert the six approved cases; the missing-description row stays in memory."""
    by_id = {normalize(row.get("show_id")): clean_row(row) for row in read_rows(input_path)}

    s1 = by_id["s1"]
    assert s1["type"] == "Movie" and s1["title_clean"] == "Dick Johnson Is Dead", "s1 title/type"
    assert s1["movie_duration_min"] == 90 and s1["season_count"] == "", "s1 duration as minutes"
    assert s1["genres_clean"] == "Documentaries" and s1["cleaning_status"] == STATUS_VALID, "s1 clean"

    s32 = by_id["s32"]
    assert s32["type"] == "TV Show" and s32["season_count"] == 1, "s32 season count"
    assert s32["movie_duration_min"] == "" and s32["cleaning_status"] == STATUS_VALID, "s32 not minutes"

    s8 = by_id["s8"]
    assert s8["genres_clean"] == "Dramas, Independent Movies, International Movies", "s8 multi-genre"
    assert s8["movie_duration_min"] == 125 and s8["cleaning_status"] == STATUS_VALID, "s8 duration"

    s5542 = by_id["s5542"]
    assert s5542["content_rating_clean"] == "" and s5542["movie_duration_min"] == "", "s5542 no inference"
    assert "malformed_content_rating" in s5542["cleaning_issues"], "s5542 rating issue"
    assert s5542["cleaning_status"] == STATUS_WARNING, "s5542 duration anomaly"

    s5795 = by_id["s5795"]
    assert s5795["content_rating_clean"] == "" and "malformed_content_rating" in s5795["cleaning_issues"], "s5795"
    assert s5795["movie_duration_min"] == "" and s5795["cleaning_status"] == STATUS_WARNING, "s5795 no minutes"

    fixture = {
        "show_id": "s999999",
        "type": "Movie",
        "title": "  Synthetic Fixture  ",
        "description": "   ",
        "rating": "PG",
        "duration": "100 min",
        "listed_in": "Dramas, Dramas , , Comedies",
    }
    synthetic = clean_row(fixture)
    assert synthetic["title_clean"] == "Synthetic Fixture", "fixture trimming"
    assert synthetic["description_clean"] == "" and synthetic["description_missing"] == "true", "fixture missing"
    assert "missing_description" in synthetic["cleaning_issues"], "fixture issue"
    assert synthetic["cleaning_status"] == STATUS_WARNING, "fixture status"
    assert synthetic["genres_clean"] == "Dramas, Comedies" and synthetic["genres_missing"] == "false", "fixture dedupe"

    quarantine, _ = clean_rows([
        dict(fixture, show_id=""),
        dict(fixture, show_id="s999998", title=" "),
        dict(fixture, show_id="s999998", type="Audio"),
    ])
    assert {record["cleaning_status"] for record in quarantine} == {STATUS_QUARANTINE}, "quarantine rules"

    print("self-check ok: s1, s32, s8, s5542, s5795, synthetic fixtures (missing description, quarantine)")


def main():
    parser = argparse.ArgumentParser(description="Clean the raw Netflix catalog CSV into mining artifacts.")
    parser.add_argument("--input", type=Path, default=ROOT / "frontend/public/data/raw/netflix_titles.csv")
    parser.add_argument("--output", type=Path, default=ROOT / "mining/catalog_clean.csv")
    parser.add_argument("--manifest", type=Path, default=ROOT / "mining/catalog_clean_manifest.json")
    parser.add_argument("--self-check", action="store_true", help="run built-in assertions and write nothing")
    args = parser.parse_args()

    if args.self_check:
        self_check(args.input)
        return
    run(args.input, args.output, args.manifest)


if __name__ == "__main__":
    main()
