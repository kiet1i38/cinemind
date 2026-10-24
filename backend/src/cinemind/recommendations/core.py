"""Pure recommendation ranking helpers shared by routes and tests."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any


COMPONENT_WEIGHTS = {
    "popularity": 0.50,
    "content": 0.15,
    "cluster": 0.25,
    "p_like": 0.10,
}


def _finite(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def normalize_component(values: dict[str, float]) -> dict[str, float]:
    finite = {key: number for key, value in values.items() if (number := _finite(value)) is not None}
    if not finite:
        return {}
    low = min(finite.values())
    high = max(finite.values())
    if high <= low:
        return {key: 1.0 if high > 0 else 0.0 for key in finite}
    return {key: (value - low) / (high - low) for key, value in finite.items()}


def content_similarity_scores(
    ratings: list[dict[str, Any]],
    content_vectors: dict[str, dict[str, float]],
    *,
    now: datetime | None = None,
) -> dict[str, float]:
    """Score catalog vectors against a recency-weighted profile of liked titles."""

    if not content_vectors:
        return {}
    current_time = now or datetime.now(timezone.utc)
    profile: dict[str, float] = defaultdict(float)
    for event in ratings:
        rating = _finite(event.get("rating"))
        show_id = str(event.get("show_id") or "")
        if rating is None or rating < 7.0:
            continue
        vector = content_vectors.get(show_id)
        if not isinstance(vector, Mapping):
            continue
        event_time = _parse_event_time(event.get("event_at") or event.get("rated_at"))
        age_days = max(0.0, (current_time - event_time).total_seconds() / 86400) if event_time else 0.0
        weight = math.exp(-age_days / 30.0) * ((rating - 5.0) / 5.0)
        for token, value in vector.items():
            number = _finite(value)
            if number is not None and number > 0:
                profile[str(token)] += number * weight

    profile_norm = math.sqrt(math.fsum(value * value for value in profile.values()))
    if profile_norm <= 0.0:
        return {}
    normalized_profile = {token: value / profile_norm for token, value in profile.items()}
    scores: dict[str, float] = {}
    for show_id, vector in content_vectors.items():
        if not isinstance(vector, Mapping):
            continue
        safe_vector = {
            str(token): number
            for token, value in vector.items()
            if (number := _finite(value)) is not None and number > 0
        }
        norm = math.sqrt(math.fsum(value * value for value in safe_vector.values()))
        if norm <= 0.0:
            continue
        dot = math.fsum(
            value * normalized_profile.get(token, 0.0)
            for token, value in safe_vector.items()
        )
        scores[str(show_id)] = max(0.0, min(1.0, dot / norm))
    return scores


def _parse_event_time(value: Any) -> datetime | None:
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


def _user_genre_profile(
    ratings: list[dict[str, Any]],
    catalog_by_id: dict[str, dict[str, Any]],
    *,
    now: datetime,
) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    weights: dict[str, float] = defaultdict(float)
    for event in ratings:
        rating = _finite(event.get("rating"))
        show_id = str(event.get("show_id") or "")
        title = catalog_by_id.get(show_id)
        if rating is None or title is None:
            continue
        event_time = _parse_event_time(event.get("event_at") or event.get("rated_at"))
        age_days = max(0.0, (now - event_time).total_seconds() / 86400) if event_time else 0.0
        recency = math.exp(-age_days / 30.0)
        value = (rating - 5.0) / 5.0
        for genre in title.get("genres", ()) or ():
            normalized_genre = str(genre).strip()
            if not normalized_genre:
                continue
            totals[normalized_genre] += value * recency
            weights[normalized_genre] += recency
    return {
        genre: max(-1.0, min(1.0, total / weights[genre]))
        for genre, total in totals.items()
        if weights[genre] > 0
    }


def _cluster_for_profile(profile: dict[str, float], model: dict[str, Any] | None) -> int | None:
    if not profile or not isinstance(model, dict) or model.get("status") != "ready":
        return None
    features = model.get("features")
    centroids = model.get("centroids")
    if not isinstance(features, list) or not isinstance(centroids, list) or not centroids:
        return None
    vector = [profile.get(str(feature), 0.0) for feature in features]
    scored: list[tuple[float, int]] = []
    for index, centroid in enumerate(centroids):
        if not isinstance(centroid, list) or len(centroid) != len(vector):
            continue
        distance = sum((left - float(right)) ** 2 for left, right in zip(vector, centroid))
        scored.append((distance, index))
    return min(scored)[1] if scored else None


def _tree_probability(features: list[float | None], model: dict[str, Any] | None) -> float | None:
    if not isinstance(model, dict) or model.get("status") != "ready":
        return None
    feature_names = model.get("features")
    medians = model.get("medians")
    nodes = model.get("nodes")
    classes = model.get("classes")
    if not all(isinstance(value, list) for value in (feature_names, medians, nodes, classes)):
        return None
    if len(features) != len(feature_names) or len(medians) != len(features) or not nodes:
        return None
    safe_values = [
        float(value) if _finite(value) is not None else float(medians[index])
        for index, value in enumerate(features)
    ]
    node_index = 0
    for _ in range(len(nodes) + 1):
        node = nodes[node_index]
        feature_index = int(node.get("feature", -1))
        if feature_index < 0:
            break
        branch = "left" if safe_values[feature_index] <= float(node["threshold"]) else "right"
        node_index = int(node[branch])
        if node_index < 0 or node_index >= len(nodes):
            return None
    else:
        return None
    counts = nodes[node_index].get("values")
    if not isinstance(counts, list) or len(counts) != len(classes):
        return None
    total = sum(float(value) for value in counts)
    if total <= 0:
        return None
    liked = sum(float(count) for label, count in zip(classes, counts) if label == "liked")
    return liked / total


def rank_recommendations(
    *,
    catalog: list[dict[str, Any]],
    ratings: list[dict[str, Any]],
    seen_show_ids: set[str],
    artifact: dict[str, Any] | None,
    algorithm: str,
    limit: int,
    content_similarity: dict[str, float] | None = None,
    tree_features_by_show: dict[str, list[float | None]] | None = None,
) -> dict[str, Any]:
    """Rank unseen catalog records without consulting any client-supplied identity."""

    now = datetime.now(timezone.utc)
    catalog_by_id = {str(item.get("show_id") or item.get("id")): item for item in catalog}
    available = [
        item for item in catalog
        if str(item.get("show_id") or item.get("id")) not in seen_show_ids
    ]
    if not available:
        return {
            "items": [],
            "mode": "empty_history",
            "evidence_status": "demo_only",
            "model_version": (artifact or {}).get("model_version"),
            "active_weights": {},
        }

    popularity_source = (artifact or {}).get("popularity", {})
    popularity_raw: dict[str, float] = {}
    if isinstance(popularity_source, Mapping):
        for item in available:
            show_id = str(item.get("show_id") or item.get("id"))
            value = _finite(popularity_source.get(show_id))
            if value is not None:
                popularity_raw[show_id] = value
    popularity = normalize_component(popularity_raw) if popularity_raw else {}

    profile = _user_genre_profile(ratings, catalog_by_id, now=now)
    liked = [event for event in ratings if (_finite(event.get("rating")) or 0.0) >= 7.0]
    content_raw: dict[str, float] = {}
    similarity = content_similarity or {}
    for item in available:
        show_id = str(item.get("show_id") or item.get("id"))
        candidate_genres = {str(value) for value in item.get("genres", ()) or ()}
        genre_score = sum(max(0.0, profile.get(genre, 0.0)) for genre in candidate_genres)
        if candidate_genres:
            genre_score /= len(candidate_genres)
        content_raw[show_id] = 0.8 * max(0.0, float(similarity.get(show_id, 0.0))) + 0.2 * genre_score
    content = normalize_component(content_raw) if liked else {}

    model = (artifact or {}).get("cluster_model")
    cluster_id = _cluster_for_profile(profile, model)
    cluster_source = (model or {}).get("item_scores", {}) if cluster_id is not None else {}
    cluster_raw = {
        str(item.get("show_id") or item.get("id")): float(cluster_source.get(str(cluster_id), {}).get(str(item.get("show_id") or item.get("id")), 0.0))
        for item in available
    }
    cluster = normalize_component(cluster_raw) if cluster_id is not None else {}

    tree_model = (artifact or {}).get("tree_model")
    tree_features_by_show = tree_features_by_show or {}
    p_like_raw = {
        show_id: probability
        for show_id, values in tree_features_by_show.items()
        if (probability := _tree_probability(values, tree_model)) is not None
    }
    p_like = normalize_component(p_like_raw) if liked else {}

    component_maps = {
        "popularity": popularity,
        "content": content,
        "cluster": cluster,
        "p_like": p_like,
    }
    configured = {
        "popularity": {"popularity": 1.0},
        "content": {"content": 1.0},
        "hybrid": COMPONENT_WEIGHTS,
    }.get(algorithm, COMPONENT_WEIGHTS)
    active = {
        name: weight
        for name, weight in configured.items()
        if component_maps[name]
    }
    total_weight = sum(active.values())
    active_weights = {name: weight / total_weight for name, weight in active.items()} if total_weight else {}

    ranked = []
    for item in available:
        show_id = str(item.get("show_id") or item.get("id"))
        scores = {
            name: component_maps[name].get(show_id)
            for name in COMPONENT_WEIGHTS
        }
        score = sum(active_weights[name] * float(scores[name] or 0.0) for name in active_weights)
        reasons = []
        if scores["content"] is not None and scores["content"] >= 0.65:
            reasons.append("Similar to titles you rated highly")
        if scores["cluster"] is not None and scores["cluster"] >= 0.65:
            reasons.append("Popular in a similar preference group")
        if scores["popularity"] is not None and scores["popularity"] >= 0.75:
            reasons.append("Popular across the demo cohort")
        if scores["p_like"] is not None:
            reasons.append("Estimated likely match from the validated demo model")
        if not reasons:
            reasons.append("A catalog pick based on the available demo signals")
        ranked.append({
            "title": item,
            "score": round(max(0.0, min(1.0, score)), 6),
            "component_scores": {
                name: round(value, 6) if value is not None else None
                for name, value in scores.items()
            },
            "reasons": reasons,
        })
    ranked.sort(key=lambda row: (
        -row["score"],
        -(_finite(row["title"].get("release_year")) or 0.0),
        str(row["title"].get("title") or "").casefold(),
        str(row["title"].get("show_id") or row["title"].get("id") or ""),
    ))

    rated_count = len(ratings)
    mode = "cold_start" if rated_count == 0 else "personalized"
    if not (artifact or {}).get("seed_status") == "ready":
        mode = "degraded_catalog_fallback" if rated_count == 0 else "degraded_personalized"
    return {
        "items": ranked[:limit],
        "mode": mode,
        "evidence_status": "demo_only",
        "model_version": (artifact or {}).get("model_version"),
        "active_weights": active_weights,
    }
