"""Prior-only feature construction for the offline Week 4 baseline."""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import math

from sklearn.preprocessing import normalize

from build_baseline import build_baseline_rows, fit_tfidf

COHORTS = {"team_test", "public_user", "synthetic", "unknown"}
LABELS = ("disliked", "neutral", "liked")
BASIC_FEATURES = (
    "completion_ratio", "play_count", "repeat_watch_flag",
    "total_watch_seconds", "days_since_last_interaction",
)
ADVANCED_FEATURES = (
    "genre_affinity", "genre_avg_completion", "recent_activity_7d",
    "recency_weighted_genre_affinity", "content_profile_similarity",
)
ALL_FEATURES = BASIC_FEATURES + ADVANCED_FEATURES
FEATURE_DESCRIPTIONS = {
    "completion_ratio": "Maximum prior completion_rate for the same Movie; missing without prior Movie watch.",
    "play_count": "Count of prior canonical watch rows for the same title; proxy, not proven playback starts.",
    "repeat_watch_flag": "1 when prior same-title watch-row count exceeds one; missing without prior watch.",
    "total_watch_seconds": "Sum of prior canonical watch seconds for the same title; missing without prior watch.",
    "days_since_last_interaction": "Days since latest owned prior rating, watch, or search; missing without history.",
    "genre_affinity": "Share of prior liked rating events whose title shares a target genre; missing without prior likes.",
    "genre_avg_completion": "Mean prior Movie completion_rate for watched titles sharing a target genre.",
    "recent_activity_7d": "Count of prior canonical watch rows in [t-7d, t); zero when none.",
    "recency_weighted_genre_affinity": "Prior-liked genre affinity with a 30-day half-life.",
    "content_profile_similarity": "True cosine of the L2-normalized mean TF-IDF vector of unique prior-liked titles to the target title.",
}
FEATURE_VERSION = "preference-v0.1"
GENRE_HALF_LIFE_DAYS = 30


def parse_time(value, context):
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise ValueError(f"{context}: expected ISO-8601 timestamp with timezone") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{context}: timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def label_for(value, context):
    try:
        rating = Decimal(value)
    except (InvalidOperation, TypeError) as error:
        raise ValueError(f"{context}: invalid rating {value!r}") from error
    if not rating.is_finite() or rating < 0 or rating > 10:
        raise ValueError(f"{context}: rating must be between 0 and 10")
    if rating * 2 != (rating * 2).to_integral_value():
        raise ValueError(f"{context}: rating must use half-star increments")
    if rating <= 3:
        return "disliked"
    if rating < 4:
        raise ValueError(f"{context}: rating 3.5 has no frozen label")
    if rating <= 6:
        return "neutral"
    if rating < 7:
        raise ValueError(f"{context}: rating 6.5 has no frozen label")
    return "liked"


def validate_cohort(row, context):
    cohort = (row.get("cohort") or "").strip()
    if cohort not in COHORTS:
        raise ValueError(f"{context}: cohort must be one of {', '.join(sorted(COHORTS))}")
    return cohort


def split_genres(value):
    return {part.strip() for part in (value or "").split(",") if part.strip()}


def optional_float(value):
    text = (value or "").strip()
    return None if text.lower() in {"", "null", r"\n"} else float(text)


def register_owner(row, context, cohort_by_user, counts):
    user_key = (row.get("user_key") or "").strip()
    if not user_key:
        counts["unowned_events_excluded"] += 1
        return None, None
    cohort = validate_cohort(row, context)
    previous = cohort_by_user.setdefault(user_key, cohort)
    if previous != cohort:
        raise ValueError(f"{context}: a user_key appears in multiple cohorts")
    return user_key, cohort


def prepare_ratings(rows, cohort_by_user, counts, seen):
    result = []
    for index, row in enumerate(rows, start=2):
        context = f"ratings.csv:{index}"
        user_key, cohort = register_owner(row, context, cohort_by_user, counts)
        if user_key is None:
            continue
        target_key, show_id = (row.get("target_key") or "").strip(), (row.get("show_id") or "").strip()
        if not target_key or not show_id:
            raise ValueError(f"{context}: target_key and show_id are required")
        if ("rating", target_key) in seen:
            raise ValueError(f"{context}: duplicate target_key")
        seen.add(("rating", target_key))
        label = label_for(row.get("rating_value"), context)
        rating_value = str(Decimal(row["rating_value"]))
        result.append({
            "target_key": target_key,
            "user_key": user_key,
            "cohort": cohort,
            "show_id": show_id,
            "event_time": parse_time(row.get("rated_at"), context),
            "rating_value": rating_value,
            "label": label,
        })
    return result


def prepare_watches(rows, cohort_by_user, counts, seen):
    result = []
    for index, row in enumerate(rows, start=2):
        context = f"watches.csv:{index}"
        if (row.get("is_repair") or "").strip().lower() in {"true", "1", "yes"}:
            counts["repair_watch_rows_excluded"] += 1
            continue
        user_key, cohort = register_owner(row, context, cohort_by_user, counts)
        if user_key is None:
            continue
        watch_key, show_id = (row.get("watch_key") or "").strip(), (row.get("show_id") or "").strip()
        if not watch_key or not show_id:
            raise ValueError(f"{context}: watch_key and show_id are required")
        if ("watch", watch_key) in seen:
            raise ValueError(f"{context}: duplicate watch_key")
        seen.add(("watch", watch_key))
        watch_seconds = float(row["watch_seconds"])
        completion = optional_float(row.get("completion_rate"))
        duration_basis = (row.get("duration_basis") or "unknown").strip()
        if not math.isfinite(watch_seconds) or watch_seconds < 0 or completion is not None and not math.isfinite(completion):
            raise ValueError(f"{context}: watch_seconds/completion_rate must be finite")
        if not watch_seconds.is_integer() or duration_basis not in {"movie_minutes", "tv_seasons", "episode_progress", "unknown"}:
            raise ValueError(f"{context}: invalid watch_seconds/duration_basis")
        if completion is not None and not 0 <= completion <= 1:
            raise ValueError(f"{context}: invalid watch_seconds/completion_rate")
        result.append({
            "watch_key": watch_key,
            "user_key": user_key,
            "cohort": cohort,
            "show_id": show_id,
            "event_time": parse_time(row.get("recorded_at"), context),
            "watch_seconds": watch_seconds,
            "completion_rate": completion,
            "duration_basis": duration_basis,
        })
    return result


def prepare_searches(rows, cohort_by_user, counts, seen):
    result = []
    for index, row in enumerate(rows, start=2):
        context = f"searches.csv:{index}"
        user_key, cohort = register_owner(row, context, cohort_by_user, counts)
        if user_key is None:
            continue
        search_key = (row.get("search_key") or "").strip()
        if not search_key or ("search", search_key) in seen:
            raise ValueError(f"{context}: missing or duplicate search_key")
        seen.add(("search", search_key))
        result.append({"user_key": user_key, "cohort": cohort, "event_time": parse_time(row.get("occurred_at"), context)})
    return result


def prepare_events(rating_rows, watch_rows, search_rows):
    cohort_by_user, counts, seen = {}, Counter(), set()
    ratings = prepare_ratings(rating_rows, cohort_by_user, counts, seen)
    watches = prepare_watches(watch_rows, cohort_by_user, counts, seen)
    searches = prepare_searches(search_rows, cohort_by_user, counts, seen)
    return ratings, watches, searches, counts


def prior_events(target, ratings_by_user, watches_by_user, searches_by_user):
    user_key, cutoff = target["user_key"], target["event_time"]
    return (
        [r for r in ratings_by_user[user_key] if r["event_time"] < cutoff],
        [w for w in watches_by_user[user_key] if w["event_time"] < cutoff],
        [s for s in searches_by_user[user_key] if s["event_time"] < cutoff],
    )


def basic_features(target, target_genres, prior_ratings, prior_watches, prior_searches):
    target_time, target_show = target["event_time"], target["show_id"]
    same_title = [w for w in prior_watches if w["show_id"] == target_show]
    latest = [e["event_time"] for e in (*prior_ratings, *prior_watches, *prior_searches)]
    feature = {name: None for name in ALL_FEATURES}
    if same_title:
        feature["play_count"] = len(same_title)  # Logged watch rows are a proxy, not playback starts.
        feature["repeat_watch_flag"] = int(len(same_title) > 1)
        feature["total_watch_seconds"] = sum(w["watch_seconds"] for w in same_title)
        rates = [w["completion_rate"] for w in same_title if w["duration_basis"] == "movie_minutes" and w["completion_rate"] is not None]
        if rates:
            feature["completion_ratio"] = max(rates)
    if latest:
        feature["days_since_last_interaction"] = (target_time - max(latest)).total_seconds() / 86400
    return feature, same_title


def genre_features(target, target_genres, prior_ratings, prior_watches, catalog, catalog_genres, title_ids, title_matrix):
    feature = {}
    likes = [r for r in prior_ratings if r["label"] == "liked" and r["show_id"] in catalog]
    if target_genres and likes:
        matching = [bool(target_genres & catalog_genres[r["show_id"]]) for r in likes]
        feature["genre_affinity"] = sum(matching) / len(likes)
        weights = [2 ** (-(target["event_time"] - r["event_time"]).total_seconds() / (86400 * GENRE_HALF_LIFE_DAYS)) for r in likes]
        feature["recency_weighted_genre_affinity"] = sum(w * hit for w, hit in zip(weights, matching)) / sum(weights)
        positive_ids = {r["show_id"] for r in likes if r["show_id"] in title_ids}
        if positive_ids and target["show_id"] in title_ids:
            profile = sum((title_matrix[title_ids[sid]] for sid in sorted(positive_ids)), start=title_matrix[0] * 0) / len(positive_ids)
            # Rows are L2-normalized, but their mean is not; normalize before the dot
            # product so this is a cosine, not the mean of pairwise cosines.
            profile = normalize(profile)
            feature["content_profile_similarity"] = float((profile @ title_matrix[title_ids[target["show_id"]]].T).toarray()[0, 0])
    completions = [
        w["completion_rate"] for w in prior_watches
        if w["completion_rate"] is not None and w["duration_basis"] == "movie_minutes"
        and w["show_id"] in catalog and target_genres & catalog_genres[w["show_id"]]
    ]
    if completions:
        feature["genre_avg_completion"] = sum(completions) / len(completions)
    return feature


def features_for_target(target, ratings_by_user, watches_by_user, searches_by_user, catalog, catalog_genres, title_ids, title_matrix):
    if target["show_id"] not in catalog:
        raise ValueError(f"target {target['target_key']}: show_id absent from cleaned catalog")
    target_genres = catalog_genres[target["show_id"]]
    prior_ratings, prior_watches, prior_searches = prior_events(target, ratings_by_user, watches_by_user, searches_by_user)
    feature, _ = basic_features(target, target_genres, prior_ratings, prior_watches, prior_searches)
    feature.update(genre_features(target, target_genres, prior_ratings, prior_watches, catalog, catalog_genres, title_ids, title_matrix))
    week_ago = target["event_time"] - timedelta(days=7)
    feature["recent_activity_7d"] = sum(week_ago <= w["event_time"] < target["event_time"] for w in watches_by_user[target["user_key"]])
    return feature


def build_rows(ratings, watches, searches, catalog_rows):
    baseline_rows = build_baseline_rows(catalog_rows)
    catalog = {row["show_id"]: row for row in catalog_rows if row.get("cleaning_status") != "quarantine"}
    if len(catalog) != len(baseline_rows):
        raise ValueError("catalog show_id values must be unique")
    catalog_genres = {sid: split_genres(row.get("genres_clean")) for sid, row in catalog.items()}
    title_ids = {row["show_id"]: i for i, row in enumerate(baseline_rows)}
    _, title_matrix = fit_tfidf(baseline_rows)
    groups = (defaultdict(list), defaultdict(list), defaultdict(list))
    for events, group in zip((ratings, watches, searches), groups):
        for event in events:
            group[event["user_key"]].append(event)
    rows = []
    for target in ratings:
        features = features_for_target(target, *groups, catalog, catalog_genres, title_ids, title_matrix)
        rows.append({
            "target_key": target["target_key"], "user_key": target["user_key"],
            "cohort": target["cohort"], "show_id": target["show_id"],
            "rated_at": target["event_time"].isoformat(), "rating_value": target["rating_value"],
            "label": target["label"], **features,
        })
    # ponytail: O(targets × events); index sorted histories if snapshots grow materially.
    return sorted(rows, key=lambda row: (row["rated_at"], row["target_key"]))


def self_check():
    assert optional_float(" NULL ") is None
    catalog = [
        {"show_id": "a", "title_clean": "Space Ocean", "description_clean": "Ocean planet", "genres_clean": "Sci-Fi", "cleaning_status": "valid"},
        {"show_id": "b", "title_clean": "Deep Ocean", "description_clean": "Ocean voyage", "genres_clean": "Sci-Fi", "cleaning_status": "valid"},
        {"show_id": "c", "title_clean": "Quiet Garden", "description_clean": "Garden story", "genres_clean": "Drama", "cleaning_status": "valid"},
    ]
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ratings = [
        {"target_key": "r0", "user_key": "u1", "cohort": "synthetic", "show_id": "b", "event_time": t0, "rating_value": "8", "label": "liked"},
        {"target_key": "r1", "user_key": "u1", "cohort": "synthetic", "show_id": "a", "event_time": t0 + timedelta(days=2), "rating_value": "7", "label": "liked"},
    ]
    watches = [
        {"watch_key": "w0", "user_key": "u1", "cohort": "synthetic", "show_id": "b", "event_time": t0 + timedelta(days=1), "watch_seconds": 60, "completion_rate": 0.5, "duration_basis": "movie_minutes"},
        {"watch_key": "w-equal", "user_key": "u1", "cohort": "synthetic", "show_id": "a", "event_time": t0 + timedelta(days=2), "watch_seconds": 200, "completion_rate": 1.0, "duration_basis": "movie_minutes"},
        {"watch_key": "w1", "user_key": "u1", "cohort": "synthetic", "show_id": "a", "event_time": t0 + timedelta(days=3), "watch_seconds": 600, "completion_rate": 1.0, "duration_basis": "movie_minutes"},
    ]
    target = build_rows(ratings, watches, [], catalog)[1]
    assert target["completion_ratio"] is None and target["play_count"] is None, "future/equal-time watch leaked"
    assert target["genre_affinity"] == 1 and target["content_profile_similarity"] is not None
    assert "rating_value" not in ALL_FEATURES and "label" not in ALL_FEATURES
    multi_likes = [
        {"target_key": "m1", "user_key": "u2", "cohort": "synthetic", "show_id": "b", "event_time": t0, "rating_value": "9", "label": "liked"},
        {"target_key": "m2", "user_key": "u2", "cohort": "synthetic", "show_id": "c", "event_time": t0 + timedelta(days=1), "rating_value": "8", "label": "liked"},
        {"target_key": "m3", "user_key": "u2", "cohort": "synthetic", "show_id": "a", "event_time": t0 + timedelta(days=2), "rating_value": "7", "label": "liked"},
    ]
    multi = next(row for row in build_rows(multi_likes, [], [], catalog) if row["target_key"] == "m3")
    baseline_rows = build_baseline_rows(catalog)
    _, matrix = fit_tfidf(baseline_rows)
    positions = {row["show_id"]: index for index, row in enumerate(baseline_rows)}
    profile = (matrix[positions["b"]] + matrix[positions["c"]]) / 2
    toward_target = matrix[positions["a"]].T
    expected = float((normalize(profile) @ toward_target).toarray()[0, 0])
    mean_dot = float((profile @ toward_target).toarray()[0, 0])
    assert abs(multi["content_profile_similarity"] - expected) < 1e-12, "profile similarity is not cosine-normalized"
    assert abs(mean_dot - expected) > 1e-6, "fixture cannot separate cosine from an unnormalized mean dot"
    assert label_for("0", "fixture") == "disliked" and label_for("10", "fixture") == "liked"
    for gap in ("3.5", "6.5"):
        try:
            label_for(gap, "fixture")
        except ValueError:
            pass
        else:
            raise AssertionError(f"unmapped rating {gap} accepted")
    print("self-check ok: strict time cutoff, labels, and prior-positive profile")
