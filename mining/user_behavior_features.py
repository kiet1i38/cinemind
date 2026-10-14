#!/usr/bin/env python3
"""Week 5 prior-only snapshot, user-matrix, and candidate feature builders.

Shared owner of snapshot/ownership/cutoff/latest-rating semantics for the Week 5
clustering, scoring, and replay stages; row-level data stays under tmp/week5/.
"""

import csv
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from build_preference_dataset import read_csv, sha256_file
from build_baseline import build_baseline_rows
from preference_features import label_for, parse_time, prepare_events, split_genres, validate_cohort

ROOT = Path(__file__).resolve().parents[1]
WEEK5_ROOT = ROOT / "tmp" / "week5"
DEFAULT_COHORT = "synthetic"
DEFAULT_SOURCE_MANIFEST = WEEK5_ROOT / DEFAULT_COHORT / "input" / "source_manifest.json"
HISTORY_DAYS, RECENT_DAYS = 30, 7
NULL_LIKE = {"", "null", "none", "nan", "nat", "n/a", "\\n"}
READY, INSUFFICIENT = "ready", "insufficient_history"
SNAPSHOT_VERSION = "week5-user-snapshot-v0.1"
RATING_COLUMNS = ("target_key", "user_key", "cohort", "show_id", "rating_value", "rated_at")
WATCH_COLUMNS = ("watch_key", "user_key", "cohort", "show_id", "watch_seconds", "completion_rate", "duration_basis", "recorded_at")
SEARCH_COLUMNS = ("search_key", "user_key", "cohort", "occurred_at")
CATALOG_COLUMNS = ("show_id", "type", "title_clean", "description_clean", "genres_clean", "movie_duration_min", "cleaning_status")
CANDIDATE_FEATURE_ORDER = (
    "content_profile_similarity", "genre_affinity", "watch_event_rows_7d",
    "unique_watched_titles_30d", "liked_titles_30d", "days_since_last_interaction",
)

def is_null_like(value):
    return value is None or str(value).strip().lower() in NULL_LIKE

def week5_output_path(path):
    resolved = Path(path)
    if not resolved.is_absolute():
        resolved = ROOT / resolved
    resolved = resolved.resolve()
    try:
        resolved.relative_to(WEEK5_ROOT.resolve())
    except ValueError as error:
        raise ValueError("Week 5 artifacts must remain under the ignored tmp/week5/ tree") from error
    return resolved

def _resolve(raw, repo_root):
    path = Path(raw)
    return path if path.is_absolute() else Path(repo_root) / path

def _as_time(value, context="cutoff"):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError(f"{context}: timestamp must include a timezone")
        return value.astimezone(timezone.utc)
    return parse_time(value, context)

def group_by_user(events):
    grouped = defaultdict(list)
    for event in events:
        grouped[event["user_key"]].append(event)
    return dict(grouped)

def _validate_hashes(manifest, paths):
    recorded = manifest.get("input_sha256") or {}
    for name, path in paths.items():
        expected = recorded.get(name) or manifest.get(f"{name}_sha256")
        if expected is None:
            raise ValueError(f"source manifest: missing sha256 for {name}")
        if sha256_file(path).lower() != str(expected).strip().lower():
            raise ValueError(f"source manifest: sha256 mismatch for {name}")

def _owned_rows(rows, name, exclusions):
    kept = []
    for row in rows:
        if is_null_like(row.get("user_key")):
            exclusions[f"{name}_null_owner_rows_excluded"] += 1
            continue
        kept.append(row)
    return kept

def load_source(manifest_path, repo_root=ROOT):
    """Resolve the source manifest, verify sha256, and prepare owned events."""
    manifest_path = _resolve(manifest_path, repo_root)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    input_paths = manifest.get("input_paths") or {}
    missing = [name for name in ("catalog", "ratings", "watches") if not input_paths.get(name)]
    if missing:
        raise ValueError(f"source manifest: missing input_paths for {', '.join(missing)}")
    paths = {name: _resolve(raw, repo_root) for name, raw in input_paths.items() if raw and name in {"catalog", "ratings", "watches", "searches", "readiness"}}
    _validate_hashes(manifest, paths)
    exclusions = Counter()
    catalog_rows = [row for row in read_csv(paths["catalog"], CATALOG_COLUMNS) if row.get("cleaning_status") != "quarantine"]
    build_baseline_rows(catalog_rows)
    ratings = _owned_rows(read_csv(paths["ratings"], RATING_COLUMNS), "ratings", exclusions)
    watches = _owned_rows(read_csv(paths["watches"], WATCH_COLUMNS), "watches", exclusions)
    searches = _owned_rows(read_csv(paths["searches"], SEARCH_COLUMNS), "searches", exclusions) if "searches" in paths else []
    prepared_ratings, prepared_watches, prepared_searches, prep_counts = prepare_events(ratings, watches, searches)
    catalog = {row["show_id"]: row for row in catalog_rows}
    if any(row["show_id"] not in catalog for row in (*prepared_ratings, *prepared_watches)):
        raise ValueError("event canonical show_id absent from valid catalog")
    values = {}
    for row in prepared_ratings:
        key = (row["user_key"], row["show_id"], row["event_time"])
        value = Decimal(row["rating_value"])
        if values.setdefault(key, value) != value:
            raise ValueError("conflicting ratings at equal timestamp")
    exclusions.update(prep_counts)
    catalog_genres = {row["show_id"]: split_genres(row.get("genres_clean")) for row in catalog_rows}
    cohorts = {row["cohort"] for row in (*prepared_ratings, *prepared_watches, *prepared_searches)}
    if manifest.get("cohort") and cohorts != {manifest["cohort"]}:
        raise ValueError("source manifest/event cohort mismatch")
    return {
        "manifest": manifest, "catalog": catalog, "catalog_rows": catalog_rows,
        "hashes": {name: sha256_file(path) for name, path in paths.items()},
        "manifest_path": str(manifest_path), "catalog_genres": catalog_genres,
        "genre_universe": sorted({genre for genres in catalog_genres.values() for genre in genres}),
        "ratings": prepared_ratings, "watches": prepared_watches, "searches": prepared_searches,
        "ratings_by_user": group_by_user(prepared_ratings),
        "watches_by_user": group_by_user(prepared_watches),
        "searches_by_user": group_by_user(prepared_searches),
        "cohort": manifest.get("cohort") or (next(iter(cohorts)) if len(cohorts) == 1 else "unknown"),
        "cutoffs": manifest.get("cutoffs") or {}, "coverage": manifest.get("coverage") or {"observation_start": None, "observation_end": None},
        "exclusions": exclusions,
    }

def latest_prior_rating(events, context):
    """Newest prior rating per title; equal values collapse, equal conflicts error."""
    by_title = defaultdict(list)
    for event in events:
        by_title[event["show_id"]].append(event)
    latest = {}
    for show_id in sorted(by_title):
        newest = max(event["event_time"] for event in by_title[show_id])
        top = [event for event in by_title[show_id] if event["event_time"] == newest]
        if len({Decimal(event["rating_value"]) for event in top}) > 1:
            raise ValueError(f"{context}: conflicting ratings for {show_id} at {newest.isoformat()}")
        latest[show_id] = min(top, key=lambda row: row.get("target_key", ""))
    return latest

def genre_shares(liked_ids, catalog_genres, genre_universe):
    """Fractional unique-latest-liked genre mass, normalized by titles with a genre."""
    totals = {genre: 0.0 for genre in genre_universe}
    with_genre, missing = 0, 0
    for show_id in liked_ids:
        genres = catalog_genres.get(show_id, set())
        if not genres:
            missing += 1
            continue
        with_genre += 1
        for genre in genres:
            totals[genre] += 1.0 / len(genres)
    if not with_genre:
        return {genre: 0.0 for genre in genre_universe}, 0, missing
    return {genre: totals[genre] / with_genre for genre in genre_universe}, with_genre, missing

def _prior(source, user_key, cutoff_time, cohort, events_key):
    return [event for event in source[events_key].get(user_key, [])
            if event["cohort"] == cohort and event["event_time"] < cutoff_time]

def build_snapshot(source, cohort, cutoff):
    """Prior-only snapshot: one entry per user with owned history before cutoff."""
    validate_cohort({"cohort": cohort}, "snapshot")
    if source.get("cohort") not in (None, "unknown", cohort):
        raise ValueError("snapshot/source cohort mismatch")
    cutoff_time = _as_time(cutoff)
    history_start = cutoff_time - timedelta(days=HISTORY_DAYS)
    recent_start = cutoff_time - timedelta(days=RECENT_DAYS)
    catalog_genres, universe = source["catalog_genres"], source["genre_universe"]
    roster = {event["user_key"] for key in ("ratings", "watches", "searches") for event in source[key]
              if event["cohort"] == cohort and event["event_time"] < cutoff_time}
    users, counts = {}, Counter()
    for user_key in sorted(roster):
        prior_ratings = _prior(source, user_key, cutoff_time, cohort, "ratings_by_user")
        prior_watches = _prior(source, user_key, cutoff_time, cohort, "watches_by_user")
        prior_searches = _prior(source, user_key, cutoff_time, cohort, "searches_by_user")
        latest = latest_prior_rating(prior_ratings, f"snapshot {user_key}")
        liked_ids = sorted(show_id for show_id, event in latest.items()
                           if event["label"] == "liked" and event["event_time"] >= history_start
                           and show_id in catalog_genres)
        shares, with_genre, missing = genre_shares(liked_ids, catalog_genres, universe)
        watched_30d = {event["show_id"] for event in prior_watches
                       if event["event_time"] >= history_start and event["show_id"] in catalog_genres}
        last = max((event["event_time"] for event in (*prior_ratings, *prior_watches, *prior_searches)), default=None)
        status = READY if with_genre else INSUFFICIENT
        users[user_key] = {
            "user_key": user_key, "cohort": cohort, "status": status,
            "liked_ids": liked_ids, "genre_shares": shares,
            "seen": sorted({event["show_id"] for event in (*prior_ratings, *prior_watches)}),
            "unique_watched_titles_30d": len(watched_30d),
            "watch_event_rows_7d": sum(event["event_time"] >= recent_start for event in prior_watches),
            "liked_titles_30d": len(liked_ids),
            "days_since_last_interaction": None if last is None else (cutoff_time - last).total_seconds() / 86400,
            "last_interaction_at": last.isoformat() if last else None,
        }
        counts["users_total"] += 1
        counts[f"users_{status}"] += 1
        counts["liked_titles_missing_genre"] += missing
    return {
        "snapshot_version": SNAPSHOT_VERSION, "cohort": cohort, "cutoff": cutoff_time.isoformat(),
        "history_days": HISTORY_DAYS, "recent_days": RECENT_DAYS,
        "genre_universe": list(universe), "catalog_genres": catalog_genres,
        "user_keys": sorted(users), "users": users, "counts": dict(counts),
        "coverage": source.get("coverage", {}),
    }

def build_user_matrix(snapshot):
    """K-means matrix X: sorted genre-share columns then log1p activity counts."""
    feature_names = [f"genre_share__{genre}" for genre in snapshot["genre_universe"]]
    feature_names += ["log1p_unique_watched_titles_30d", "log1p_watch_event_rows_7d"]
    user_keys, rows = [], []
    for user_key in snapshot["user_keys"]:
        user = snapshot["users"][user_key]
        if user["status"] != READY:
            continue
        vector = [user["genre_shares"][genre] for genre in snapshot["genre_universe"]]
        vector += [math.log1p(user["unique_watched_titles_30d"]), math.log1p(user["watch_event_rows_7d"])]
        user_keys.append(user_key)
        rows.append(vector)
    return {"snapshot_version": snapshot["snapshot_version"], "cohort": snapshot["cohort"], "cutoff": snapshot["cutoff"],
            "feature_names": feature_names, "user_keys": user_keys, "rows": rows}

def build_future_targets(source, cutoff, end, candidates_by_user):
    """Latest observed rating in [cutoff, end) per eligible user/title candidate."""
    cutoff_time, end_time = _as_time(cutoff), _as_time(end, "future end")
    if end_time <= cutoff_time:
        raise ValueError("future window end must be after cutoff")
    targets = []
    for user_key in sorted(candidates_by_user):
        candidates = {str(show_id) for show_id in candidates_by_user[user_key]}
        latest = {}
        for event in source["ratings_by_user"].get(user_key, []):
            if event["show_id"] not in candidates or not (cutoff_time <= event["event_time"] < end_time):
                continue
            previous = latest.get(event["show_id"])
            if previous is None or event["event_time"] > previous["event_time"]:
                latest[event["show_id"]] = event
            elif event["event_time"] == previous["event_time"] and Decimal(event["rating_value"]) != Decimal(previous["rating_value"]):
                raise ValueError(f"future targets {user_key}/{event['show_id']}: conflicting ratings")
            elif event["event_time"] == previous["event_time"]:
                latest[event["show_id"]] = min((event, previous), key=lambda row: row["target_key"])
        for show_id in sorted(latest):
            event = latest[show_id]
            targets.append({"user_key": user_key, "show_id": show_id, "target_key": event["target_key"],
                            "cohort": event["cohort"], "cutoff": cutoff_time.isoformat(),
                            "rated_at": event["event_time"].isoformat(), "rating_value": event["rating_value"],
                            "label": event["label"]})
    return sorted(targets, key=lambda row: (row["user_key"], row["show_id"]))

def build_candidate_features(snapshot, user, candidate_ids, content_map):
    """Six ordered pre-recommendation features per candidate show_id."""
    record = snapshot["users"][user] if isinstance(user, str) else user
    catalog_genres = snapshot["catalog_genres"]
    features = {}
    for show_id in candidate_ids:
        show_id = str(show_id)
        if show_id not in catalog_genres:
            raise ValueError(f"candidate {show_id} is absent from the cleaned catalog")
        features[show_id] = {
            "content_profile_similarity": content_map.get(show_id),
            "genre_affinity": sum(record["genre_shares"].get(genre, 0.0) for genre in catalog_genres[show_id]),
            "watch_event_rows_7d": record["watch_event_rows_7d"],
            "unique_watched_titles_30d": record["unique_watched_titles_30d"],
            "liked_titles_30d": record["liked_titles_30d"],
            "days_since_last_interaction": record["days_since_last_interaction"],
        }
    return features

def write_user_features(path, snapshot, matrix):
    """One row per snapshot user; X columns stay blank when insufficient history."""
    path = week5_output_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    x_columns = [f"genre_share__{genre}" for genre in snapshot["genre_universe"]]
    x_columns += ["log1p_unique_watched_titles_30d", "log1p_watch_event_rows_7d"]
    fields = ["user_key", "cohort", "cutoff", "status", "liked_titles_30d", "unique_watched_titles_30d",
              "watch_event_rows_7d", "days_since_last_interaction", "last_interaction_at", "liked_ids", "seen", *x_columns]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for user_key in snapshot["user_keys"]:
            user = snapshot["users"][user_key]
            included = user["status"] == READY
            row = {name: "" for name in x_columns}
            row.update({
                "user_key": user_key, "cohort": user["cohort"], "cutoff": snapshot["cutoff"],
                "status": user["status"], "liked_titles_30d": user["liked_titles_30d"],
                "unique_watched_titles_30d": user["unique_watched_titles_30d"],
                "watch_event_rows_7d": user["watch_event_rows_7d"],
                "days_since_last_interaction": "" if user["days_since_last_interaction"] is None else f"{user['days_since_last_interaction']:.6f}",
                "last_interaction_at": user.get("last_interaction_at"),
                "liked_ids": "|".join(user["liked_ids"]), "seen": "|".join(user["seen"]),
            })
            if included:
                row.update({f"genre_share__{genre}": f"{user['genre_shares'][genre]:.6f}" for genre in snapshot["genre_universe"]})
                row["log1p_unique_watched_titles_30d"] = f"{math.log1p(user['unique_watched_titles_30d']):.6f}"
                row["log1p_watch_event_rows_7d"] = f"{math.log1p(user['watch_event_rows_7d']):.6f}"
            writer.writerow(row)

def _fixture_source():
    genres = {"a": {"Action", "Drama"}, "b": {"Drama"}, "c": {"Comedies"}, "d": {"Action"}, "m": set()}

    def rating(user, show, value, when):
        return {"target_key": f"{user}{show}{when}", "user_key": user, "cohort": "synthetic", "show_id": show,
                "event_time": _as_time(when), "rating_value": value, "label": label_for(value, "fixture")}

    def watch(user, show, when):
        return {"watch_key": f"{user}{show}{when}", "user_key": user, "cohort": "synthetic", "show_id": show,
                "event_time": _as_time(when), "watch_seconds": 60.0, "completion_rate": 1.0, "duration_basis": "movie_minutes"}

    ratings = [rating("u1", "a", "9", "2026-02-01T00:00:00+00:00"), rating("u1", "b", "4", "2026-02-02T00:00:00+00:00"),
               rating("u1", "b", "4", "2026-02-02T00:00:00+00:00"), rating("u1", "d", "8", "2026-01-01T00:00:00+00:00"),
               rating("u1", "c", "8", "2026-03-03T00:00:00+00:00"), rating("u2", "a", "2", "2026-02-03T00:00:00+00:00"),
               rating("u2", "c", "8", "2026-03-04T00:00:00+00:00")]
    watches = [watch("u1", "a", "2026-02-05T00:00:00+00:00"), watch("u2", "b", "2026-02-25T00:00:00+00:00")]
    searches = [{"search_key": "u3", "user_key": "u3", "cohort": "synthetic", "event_time": _as_time("2026-02-20T00:00:00+00:00")}]
    return {"catalog_genres": genres, "genre_universe": ["Action", "Comedies", "Drama"],
            "ratings": ratings, "watches": watches, "searches": searches, "ratings_by_user": group_by_user(ratings),
            "watches_by_user": group_by_user(watches), "searches_by_user": group_by_user(searches),
            "coverage": {}, "cutoffs": {}, "exclusions": Counter()}

def self_check():
    assert is_null_like(" NULL ") and not is_null_like("u1")
    shares, with_genre, missing = genre_shares(["a", "b"], {"a": {"Action", "Drama"}, "b": {"Drama"}}, ["Action", "Comedies", "Drama"])
    assert with_genre == 2 and missing == 0 and abs(shares["Action"] - 0.25) < 1e-9 and abs(shares["Drama"] - 0.75) < 1e-9
    shares2, with2, missing2 = genre_shares(["a", "m"], {"a": {"Action", "Drama"}, "m": set()}, ["Action", "Comedies", "Drama"])
    assert with2 == 1 and missing2 == 1 and abs(shares2["Action"] - 0.5) < 1e-9
    source = _fixture_source()
    snapshot = build_snapshot(source, "synthetic", "2026-03-01T00:00:00+00:00")
    u1, u2, u3 = (snapshot["users"][key] for key in ("u1", "u2", "u3"))
    assert set(snapshot["user_keys"]) == {"u1", "u2", "u3"}
    assert u1["liked_ids"] == ["a"] and u1["status"] == READY and abs(sum(u1["genre_shares"].values()) - 1.0) < 1e-9
    assert u1["seen"] == ["a", "b", "d"] and u1["unique_watched_titles_30d"] == 1 and u1["watch_event_rows_7d"] == 0
    assert u2["status"] == INSUFFICIENT and u2["watch_event_rows_7d"] == 1
    assert u3["liked_ids"] == [] and u3["days_since_last_interaction"] is not None
    conflict = [{"show_id": "a", "event_time": _as_time("2026-02-01T00:00:00+00:00"), "rating_value": "8"},
                {"show_id": "a", "event_time": _as_time("2026-02-01T00:00:00+00:00"), "rating_value": "2"}]
    try:
        latest_prior_rating(conflict, "fixture")
        raise AssertionError("conflicting equal-timestamp ratings must fail")
    except ValueError:
        pass
    exclusions = Counter()
    assert _owned_rows([{"user_key": "NULL"}], "ratings", exclusions) == [] and exclusions["ratings_null_owner_rows_excluded"] == 1
    _, kept_watches, _, counts = prepare_events([], [
        {"watch_key": "skip", "user_key": "u", "cohort": "synthetic", "show_id": "a", "watch_seconds": "60", "completion_rate": "1.0", "duration_basis": "movie_minutes", "recorded_at": "2026-02-01T00:00:00+00:00", "is_repair": "true"},
        {"watch_key": "keep", "user_key": "u", "cohort": "synthetic", "show_id": "a", "watch_seconds": "60", "completion_rate": "1.0", "duration_basis": "movie_minutes", "recorded_at": "2026-02-02T00:00:00+00:00"}], [])
    assert len(kept_watches) == 1 and counts["repair_watch_rows_excluded"] == 1
    matrix = build_user_matrix(snapshot)
    assert matrix["user_keys"] == ["u1"] and len(matrix["rows"][0]) == len(matrix["feature_names"]) == 5
    targets = build_future_targets(source, "2026-03-01T00:00:00+00:00", "2026-03-08T00:00:00+00:00", {"u1": ["a", "b", "c"], "u2": ["a", "c"]})
    assert [(t["user_key"], t["show_id"], t["label"]) for t in targets] == [("u1", "c", "liked"), ("u2", "c", "liked")]
    features = build_candidate_features(snapshot, "u1", ["a", "c"], {"a": 0.5, "c": 0.9})
    assert list(features["a"]) == list(CANDIDATE_FEATURE_ORDER) and features["a"]["content_profile_similarity"] == 0.5
    assert abs(features["a"]["genre_affinity"] - 1.0) < 1e-9 and features["c"]["genre_affinity"] == 0.0
    print("self-check ok: cutoff/latest-rating/genre-share, future targets, candidate features")


if __name__ == "__main__":
    self_check()
