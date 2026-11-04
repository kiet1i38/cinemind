"""Live Week 6 baseline features shared by serving and the mining exporter.

Cluster vectors use the Week 5 definition: genre shares of unique liked titles
in the history window, then log1p watch activity. The decision-tree row uses
the same six pre-recommendation features. Content similarity inside that row
is the equal-weight cosine of liked title vectors, which is separate from the
recency-weighted content baseline.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping


TREE_BASE_FEATURES = (
    "content_profile_similarity",
    "genre_affinity",
    "watch_event_rows_7d",
    "unique_watched_titles_30d",
    "liked_titles_30d",
    "days_since_last_interaction",
)
CLUSTER_SPACE = "scaled_genre_share_v1"
POPULARITY_VERSION = "week6-tfidf-popularity-v2"
BASELINE_VERSION = "week6-baseline-v1"
HISTORY_DAYS = 30
RECENT_DAYS = 7


def parse_event_time(value: Any) -> datetime | None:
    """Return an aware UTC timestamp, or None when the value cannot be used."""

    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _event_time(event: Mapping[str, Any]) -> datetime | None:
    for key in ("event_at", "client_occurred_at", "rated_at", "recorded_at", "occurred_at"):
        parsed = parse_event_time(event.get(key))
        if parsed is not None:
            return parsed
    return None


def _rating_value(event: Mapping[str, Any]) -> float | None:
    raw = event.get("rating")
    if raw is None:
        raw = event.get("rating_value")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _latest_ratings(ratings: list[Mapping[str, Any]], cutoff: datetime) -> dict[str, Mapping[str, Any]]:
    latest: dict[str, tuple[datetime, Mapping[str, Any]]] = {}
    for event in ratings:
        show_id = str(event.get("show_id") or "")
        event_time = _event_time(event)
        if not show_id or event_time is None or event_time >= cutoff:
            continue
        previous = latest.get(show_id)
        if previous is None or event_time >= previous[0]:
            latest[show_id] = (event_time, event)
    return {show_id: event for show_id, (_, event) in latest.items()}


def genre_shares(liked_ids: list[str], catalog_genres: Mapping[str, set[str]], universe: list[str]) -> dict[str, float]:
    """Fractional unique-latest-liked genre mass, normalized by titles with a genre."""

    totals = {genre: 0.0 for genre in universe}
    with_genre = 0
    for show_id in liked_ids:
        genres = catalog_genres.get(show_id, set())
        if not genres:
            continue
        with_genre += 1
        share = 1.0 / len(genres)
        for genre in genres:
            if genre in totals:
                totals[genre] += share
    if not with_genre:
        return totals
    return {genre: totals[genre] / with_genre for genre in universe}


def _watch_activity(watches, catalog_genres, history_start, recent_start, cutoff):
    watched_30d = {
        str(event.get("show_id") or "")
        for event in watches
        if (event_time := _event_time(event)) is not None
        and history_start <= event_time < cutoff
        and str(event.get("show_id") or "") in catalog_genres
    }
    watch_rows_7d = sum(
        1
        for event in watches
        if (event_time := _event_time(event)) is not None and recent_start <= event_time < cutoff
    )
    return watched_30d, watch_rows_7d


def user_profile(
    ratings: list[Mapping[str, Any]],
    watches: list[Mapping[str, Any]],
    searches: list[Mapping[str, Any]],
    catalog_genres: Mapping[str, set[str]],
    universe: list[str],
    now: datetime,
    *,
    history_days: int = HISTORY_DAYS,
    recent_days: int = RECENT_DAYS,
) -> dict[str, Any]:
    """Prior-only profile at `now`. Events at `now` are excluded."""

    cutoff = parse_event_time(now) or now.astimezone(timezone.utc)
    history_start = cutoff - timedelta(days=history_days)
    recent_start = cutoff - timedelta(days=recent_days)
    latest = _latest_ratings(ratings, cutoff)
    liked_ids = sorted(
        show_id
        for show_id, event in latest.items()
        if (_rating_value(event) or 0.0) >= 7.0
        and (_event_time(event) or cutoff) >= history_start
        and show_id in catalog_genres
    )
    shares = genre_shares(liked_ids, catalog_genres, universe)
    watched_30d, watch_rows_7d = _watch_activity(watches, catalog_genres, history_start, recent_start, cutoff)
    moments = [
        event_time
        for event in (*latest.values(), *watches, *searches)
        if (event_time := _event_time(event)) is not None and event_time < cutoff
    ]
    with_genre = sum(1 for show_id in liked_ids if catalog_genres.get(show_id))
    return {
        "liked_ids": liked_ids,
        "genre_shares": shares,
        "unique_watched_titles_30d": len(watched_30d),
        "watch_event_rows_7d": watch_rows_7d,
        "liked_titles_30d": len(liked_ids),
        "days_since_last_interaction": None if not moments else (cutoff - max(moments)).total_seconds() / 86400,
        "ready": with_genre > 0,
    }


def cluster_vector(profile: Mapping[str, Any], feature_names: list[str]) -> list[float]:
    """One scaled-space input row. Unknown feature names are rejected."""

    shares = profile["genre_shares"]
    values: list[float] = []
    for name in feature_names:
        if name.startswith("genre_share__"):
            values.append(float(shares.get(name[len("genre_share__"):], 0.0)))
        elif name == "log1p_unique_watched_titles_30d":
            values.append(math.log1p(profile["unique_watched_titles_30d"]))
        elif name == "log1p_watch_event_rows_7d":
            values.append(math.log1p(profile["watch_event_rows_7d"]))
        else:
            raise ValueError(f"unknown user-cluster feature {name!r}")
    return values


def assign_scaled_cluster(vector: list[float], model: Mapping[str, Any]) -> int | None:
    """Nearest centroid after the frozen train-only scaler. Ties keep the smaller id."""

    if model.get("space") != CLUSTER_SPACE or model.get("status") != "ready":
        return None
    means, scales = model.get("means"), model.get("scales")
    centroids = model.get("centroids")
    if not isinstance(means, list) or not isinstance(scales, list) or not isinstance(centroids, list):
        return None
    if len(means) != len(vector) or len(scales) != len(vector) or not centroids:
        return None
    scaled = [
        (float(value) - float(mean)) / (float(scale) if float(scale) else 1.0)
        for value, mean, scale in zip(vector, means, scales)
    ]
    best: tuple[float, int] | None = None
    for index, centroid in enumerate(centroids):
        if not isinstance(centroid, list) or len(centroid) != len(scaled):
            continue
        distance = sum((left - float(right)) ** 2 for left, right in zip(scaled, centroid))
        if best is None or distance < best[0]:
            best = (distance, index)
    return None if best is None else best[1]


def equal_weight_similarity(
    liked_ids: list[str], vectors: Mapping[str, Mapping[str, float]]
) -> dict[str, float] | None:
    """Cosine of the mean L2-normalized liked-title vector against every title."""

    accumulator: dict[str, float] = defaultdict(float)
    count = 0
    for show_id in liked_ids:
        vector = vectors.get(show_id)
        if not isinstance(vector, Mapping):
            continue
        count += 1
        for token, value in vector.items():
            number = float(value)
            if math.isfinite(number):
                accumulator[token] += number
    if count == 0:
        return None
    mean = {token: value / count for token, value in accumulator.items()}
    norm = math.sqrt(math.fsum(value * value for value in mean.values()))
    if not math.isfinite(norm) or norm <= 0.0:
        return None
    unit = {token: value / norm for token, value in mean.items()}
    scores: dict[str, float] = {}
    for show_id, vector in vectors.items():
        if not isinstance(vector, Mapping):
            continue
        dot = math.fsum(float(value) * unit.get(str(token), 0.0) for token, value in vector.items())
        if math.isfinite(dot):
            scores[str(show_id)] = dot
    return scores


def tree_feature_rows(
    profile: Mapping[str, Any],
    catalog_genres: Mapping[str, set[str]],
    candidate_ids: list[str],
    content_map: Mapping[str, float] | None,
) -> dict[str, list[float | None]]:
    """Six raw features per candidate. Missing similarity stays None."""

    rows: dict[str, list[float | None]] = {}
    shares = profile["genre_shares"]
    for show_id in candidate_ids:
        genres = catalog_genres.get(show_id, set())
        content = None if content_map is None else content_map.get(show_id)
        rows[show_id] = [
            None if content is None else float(content),
            sum(float(shares.get(genre, 0.0)) for genre in genres),
            int(profile["watch_event_rows_7d"]),
            int(profile["unique_watched_titles_30d"]),
            int(profile["liked_titles_30d"]),
            profile["days_since_last_interaction"],
        ]
    return rows


def baseline_readiness(roster_complete: bool, models_ready: bool) -> tuple[str, str, str]:
    """Seed status, evidence label, and model version for one artifact build."""

    if not models_ready:
        return "degraded", "demo_only", POPULARITY_VERSION
    status = "ready" if roster_complete else "degraded"
    return status, "baseline_not_holdout", BASELINE_VERSION


def uses_live_tree(model: Mapping[str, Any] | None) -> bool:
    """True when the served tree was trained on the six baseline features."""

    if not isinstance(model, dict) or model.get("status") != "ready":
        return False
    features = model.get("features")
    width = len(TREE_BASE_FEATURES)
    return isinstance(features, list) and features[:width] == list(TREE_BASE_FEATURES)


def catalog_genre_index(catalog: list[Mapping[str, Any]]) -> dict[str, set[str]]:
    """Show id to the genre set already stored on each catalog row."""

    index: dict[str, set[str]] = {}
    for item in catalog:
        show_id = str(item.get("show_id") or item.get("id") or "")
        if not show_id:
            continue
        listed = item.get("genres")
        if listed is None:
            listed = item.get("listedIn")
        if isinstance(listed, str):
            index[show_id] = {part.strip() for part in listed.split(",") if part.strip()}
        elif isinstance(listed, (list, tuple)):
            index[show_id] = {str(genre).strip() for genre in listed if str(genre).strip()}
        else:
            index[show_id] = set()
    return index


def live_cluster_id(
    ratings: list[Mapping[str, Any]],
    watches: list[Mapping[str, Any]],
    searches: list[Mapping[str, Any]],
    catalog_genres: Mapping[str, set[str]],
    model: Mapping[str, Any] | None,
    now: datetime,
) -> int | None:
    """Assign the request user. Returns None for a non-baseline model or a cold user."""

    if not isinstance(model, dict) or model.get("space") != CLUSTER_SPACE:
        return None
    features = model.get("features")
    if not isinstance(features, list):
        return None
    universe = [name[len("genre_share__"):] for name in features if str(name).startswith("genre_share__")]
    profile = user_profile(
        ratings, watches, searches, catalog_genres, universe, now,
        history_days=int(model.get("history_days") or HISTORY_DAYS),
        recent_days=int(model.get("recent_days") or RECENT_DAYS),
    )
    if not profile["ready"]:
        return None
    return assign_scaled_cluster(cluster_vector(profile, [str(name) for name in features]), model)


def live_tree_features(
    ratings: list[Mapping[str, Any]],
    watches: list[Mapping[str, Any]],
    searches: list[Mapping[str, Any]],
    catalog_genres: Mapping[str, set[str]],
    vectors: Mapping[str, Mapping[str, float]],
    candidate_ids: list[str],
    now: datetime,
    *,
    history_days: int = HISTORY_DAYS,
    recent_days: int = RECENT_DAYS,
) -> dict[str, list[float | None]]:
    """Per-candidate tree rows for this account at `now`."""

    universe = sorted({genre for genres in catalog_genres.values() for genre in genres})
    profile = user_profile(
        ratings, watches, searches, catalog_genres, universe, now,
        history_days=history_days, recent_days=recent_days,
    )
    content = equal_weight_similarity(profile["liked_ids"], vectors)
    return tree_feature_rows(profile, catalog_genres, candidate_ids, content)
