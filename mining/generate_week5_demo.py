#!/usr/bin/env python3
"""Generate the deterministic Week 5 synthetic demo export under tmp/week5/.

Test-only fixture: three single-genre style groups with prior history and
train/validation/test future windows.  Row-level output stays under tmp/week5/.
"""

import argparse
import csv
import json
import platform
import shlex
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from build_preference_dataset import read_csv, sha256_file
from preference_features import COHORTS, prepare_events, split_genres
from user_behavior_features import DEFAULT_COHORT, ROOT, WEEK5_ROOT, group_by_user, is_null_like, week5_output_path

SEED = 42
STYLES = ("Action & Adventure", "Comedies", "Dramas")
TITLES_PER_STYLE, WARM_MEMBERS = 9, 4
PRIOR_DATES = ("2026-07-29", "2026-07-30", "2026-07-31")
OVERRIDE_EARLY, OVERRIDE_LATE = "2026-07-25", "2026-07-28"
STAGE_INDICES, STAGE_DATES = (6, 7, 8), ("2026-08-03", "2026-08-10", "2026-08-17")
COLD_SEARCH_DATE, COLD_NEUTRAL_DATE = "2026-07-20", "2026-07-30"
COVERAGE_FROM, COVERAGE_TO = "2026-07-01T00:00:00+00:00", "2026-08-22T00:00:00+00:00"
CUTOFFS = {"train": "2026-08-01T00:00:00+00:00", "validation": "2026-08-08T00:00:00+00:00",
           "test": "2026-08-15T00:00:00+00:00", "demo": "2026-08-22T00:00:00+00:00"}
EXPECTED_COUNTS = {"users": 14, "ratings": 147, "watches": 73, "searches": 1, "distinct_titles": 27}
SOURCE_MANIFEST_VERSION = "week5-demo-source-v0.1"
CATALOG_COLUMNS = ("show_id", "type", "title_clean", "description_clean", "genres_clean", "movie_duration_min", "cleaning_status")
RATING_FIELDS = ["target_key", "user_key", "cohort", "show_id", "rating_value", "rated_at"]
WATCH_FIELDS = ["watch_key", "user_key", "cohort", "show_id", "watch_seconds", "completion_rate", "duration_basis", "recorded_at"]
SEARCH_FIELDS = ["search_key", "user_key", "cohort", "occurred_at"]

def _utc(date_text, hour=12):
    year, month, day = (int(part) for part in date_text.split("-"))
    return datetime(year, month, day, hour, tzinfo=timezone.utc)

def parse_duration(value):
    text = (value or "").strip()
    return int(text) if text.isdigit() else None

def select_style_titles(catalog_rows):
    """Seed-42 pick of 9 lex-ordered single-genre positive-runtime Movies per style."""
    eligible = {style: [] for style in STYLES}
    for row in catalog_rows:
        if row.get("cleaning_status") == "quarantine" or (row.get("type") or "").strip() != "Movie":
            continue
        genres = split_genres(row.get("genres_clean"))
        if len(genres) != 1:
            continue
        genre = next(iter(genres))
        duration = parse_duration(row.get("movie_duration_min"))
        if genre not in eligible or duration is None or duration <= 0:
            continue
        eligible[genre].append(row["show_id"].strip())
    selection = {}
    for style in STYLES:
        candidates = sorted(set(eligible[style]))
        if len(candidates) < TITLES_PER_STYLE:
            raise ValueError(f"catalog has fewer than {TITLES_PER_STYLE} single-genre Movies for {style}")
        selection[style] = candidates[:TITLES_PER_STYLE]
    if len({show_id for ids in selection.values() for show_id in ids}) != len(STYLES) * TITLES_PER_STYLE:
        raise ValueError("style title selections must be distinct")
    return selection

def build_events(selection):
    """Build prior + override + cold + future events with exact expected totals."""
    ratings, watches, searches = [], [], []
    cohort = DEFAULT_COHORT

    def add_rating(user, show_id, value, when):
        ratings.append({"target_key": f"r{len(ratings):04d}", "user_key": user, "cohort": cohort,
                        "show_id": show_id, "rating_value": value, "rated_at": when.isoformat()})

    def add_watch(user, show_id, when):
        watches.append({"watch_key": f"w{len(watches):04d}", "user_key": user, "cohort": cohort,
                        "show_id": show_id, "watch_seconds": 60, "completion_rate": "",
                        "duration_basis": "movie_minutes", "recorded_at": when.isoformat()})

    for s_index, style in enumerate(STYLES):
        for member in range(WARM_MEMBERS):
            user = f"warm_s{s_index}_m{member}"
            for offset, date_text in enumerate(PRIOR_DATES):
                add_rating(user, selection[style][member + offset], "8", _utc(date_text))
                add_watch(user, selection[style][member + offset], _utc(date_text))
        for stage, title_index in enumerate(STAGE_INDICES):
            when = _utc(STAGE_DATES[stage])
            for member in range(WARM_MEMBERS):
                user = f"warm_s{s_index}_m{member}"
                add_rating(user, selection[style][title_index], "8", when)
                add_rating(user, selection[STYLES[(s_index + 1) % len(STYLES)]][title_index], "5", when)
                add_rating(user, selection[STYLES[(s_index + 2) % len(STYLES)]][title_index], "2", when)
                add_watch(user, selection[style][title_index], when)
    add_rating("warm_s0_m0", selection[STYLES[0]][5], "8", _utc(OVERRIDE_EARLY))
    add_rating("warm_s0_m0", selection[STYLES[0]][5], "2", _utc(OVERRIDE_LATE))
    searches.append({"search_key": "s0000", "user_key": "cold_0", "cohort": cohort,
                     "occurred_at": _utc(COLD_SEARCH_DATE).isoformat()})
    add_rating("cold_1", selection[STYLES[0]][0], "5", _utc(COLD_NEUTRAL_DATE))
    add_watch("cold_1", selection[STYLES[0]][0], _utc(COLD_NEUTRAL_DATE))
    return ratings, watches, searches

def count_rows(ratings, watches, searches):
    users = {row["user_key"] for row in (*ratings, *watches, *searches)}
    titles = {row["show_id"] for row in (*ratings, *watches)}
    return {"users": len(users), "ratings": len(ratings), "watches": len(watches),
            "searches": len(searches), "distinct_titles": len(titles)}

def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

def _relative(path):
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return str(path)

def run(args):
    cohort = args.cohort or DEFAULT_COHORT
    if cohort != "synthetic":
        raise ValueError(f"cohort must be one of {', '.join(sorted(COHORTS))}")
    output_dir = week5_output_path(args.output_dir or (WEEK5_ROOT / cohort / "input"))
    catalog_path = Path(args.catalog)
    if not catalog_path.is_absolute():
        catalog_path = ROOT / catalog_path
    catalog = read_csv(catalog_path, CATALOG_COLUMNS)
    selection = select_style_titles(catalog)
    ratings, watches, searches = build_events(selection)
    durations = {row["show_id"]: int(row["movie_duration_min"]) * 60 for row in catalog if row["show_id"] in {sid for ids in selection.values() for sid in ids}}
    for row in watches:
        seconds = min(60, durations[row["show_id"]])
        row.update(watch_seconds=seconds, completion_rate=seconds / durations[row["show_id"]])
    counts = count_rows(ratings, watches, searches)
    if counts != EXPECTED_COUNTS:
        raise ValueError(f"demo counts {counts} do not match expected {EXPECTED_COUNTS}")
    paths = {"catalog": catalog_path, "ratings": output_dir / "ratings.csv",
             "watches": output_dir / "watches.csv", "searches": output_dir / "searches.csv"}
    write_csv(paths["ratings"], RATING_FIELDS, ratings)
    write_csv(paths["watches"], WATCH_FIELDS, watches)
    write_csv(paths["searches"], SEARCH_FIELDS, searches)
    manifest = {
        "source_manifest_version": SOURCE_MANIFEST_VERSION, "purpose": "test_only", "test_only": True,
        "cohort": cohort, "seed": SEED, "expected_styles": list(STYLES),
        "style_titles": {style: selection[style] for style in STYLES},
        "cutoffs": CUTOFFS, "coverage": {"observation_start": COVERAGE_FROM, "observation_end": COVERAGE_TO},
        "expected_style_by_user": {f"warm_s{index}_m{member}": style for index, style in enumerate(STYLES) for member in range(4)},
        "input_paths": {name: _relative(path) for name, path in paths.items()},
        "input_sha256": {name: sha256_file(path) for name, path in paths.items()},
        "expected_counts": EXPECTED_COUNTS, "observed_counts": counts,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "software_versions": {"python": platform.python_version()},
        "generator_command": shlex.join([sys.executable, *sys.argv]),
    }
    manifest_path = week5_output_path(args.source_manifest or (output_dir / "source_manifest.json"))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {counts} demo rows and source manifest under {output_dir}")

def _fixture_catalog():
    fixture = [{"show_id": f"{prefix}{index:02d}", "type": "Movie", "genres_clean": style,
                "movie_duration_min": "90", "cleaning_status": "valid"}
               for style, prefix in zip(STYLES, ("a", "c", "d")) for index in range(12)]
    fixture += [{"show_id": "z00", "type": "TV Show", "genres_clean": STYLES[0], "movie_duration_min": "", "cleaning_status": "valid"},
                {"show_id": "z01", "type": "Movie", "genres_clean": f"{STYLES[0]}, {STYLES[1]}", "movie_duration_min": "90", "cleaning_status": "valid"},
                {"show_id": "z02", "type": "Movie", "genres_clean": STYLES[0], "movie_duration_min": "0", "cleaning_status": "valid"},
                {"show_id": "z03", "type": "Movie", "genres_clean": STYLES[0], "movie_duration_min": "90", "cleaning_status": "quarantine"}]
    return fixture

def self_check():
    """Exercise seed selection, exact counts, override semantics, and future windows."""
    assert is_null_like("null") and not is_null_like("u1")
    selection = select_style_titles(_fixture_catalog())
    assert all(len(selection[style]) == TITLES_PER_STYLE for style in STYLES)
    assert all(len(set(selection[style])) == TITLES_PER_STYLE for style in STYLES)
    assert not {"z00", "z01", "z02", "z03"} & set(selection[STYLES[0]])
    ratings, watches, searches = build_events(selection)
    assert count_rows(ratings, watches, searches) == EXPECTED_COUNTS
    override = [row for row in ratings if row["user_key"] == "warm_s0_m0" and row["show_id"] == selection[STYLES[0]][5]]
    assert [(row["rating_value"], row["rated_at"][:10]) for row in override] == [("8", "2026-07-25"), ("2", "2026-07-28")]
    assert not any(row["user_key"] == "warm_s0_m0" and row["show_id"] == selection[STYLES[0]][5] for row in watches)
    warm_future = [row for row in ratings if row["user_key"] == "warm_s0_m0" and row["rated_at"][:10] in set(STAGE_DATES)]
    assert len(warm_future) == len(STAGE_DATES) * len(STYLES)
    by_user = group_by_user(prepare_events(ratings, watches, searches)[0])
    for stage in range(len(STAGE_INDICES)):
        cutoff = _utc(STAGE_DATES[stage]) - timedelta(days=2)
        window = [row for row in by_user["warm_s0_m0"] if cutoff <= row["event_time"] < cutoff + timedelta(days=7)]
        assert len(window) == len(STYLES) and sum(row["label"] == "liked" for row in window) == 1
    print("self-check ok: seed selection, exact demo counts, override, future windows")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=ROOT / "tmp/catalog_clean.csv")
    parser.add_argument("--source-manifest", type=Path, default=None)
    parser.add_argument("--cohort", default=DEFAULT_COHORT)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    run(args)

if __name__ == "__main__":
    main()
