#!/usr/bin/env python3
"""Content, popularity, hybrid ranking, and deterministic ranking metrics.

Scoring module for the Week 5 ranking CLI.  Every component score is a finite
float in [0, 1] or None, so callers can serialize results without special cases.
"""

import math
from collections.abc import Mapping

import numpy
from sklearn.preprocessing import normalize

from build_baseline import build_baseline_rows, fit_tfidf

KEYS = ("C", "P", "T", "K")
NAMES = {"C": "content", "P": "popularity", "T": "tree", "K": "cluster"}
TOLERANCE = 1e-9


def build_content_context(source):
    """Catalog TF-IDF matrix plus a show_id index for cosine content scoring."""
    rows = build_baseline_rows(source["catalog_rows"])
    vectorizer, matrix = fit_tfidf(rows)
    matrix = normalize(matrix)
    show_ids = [row["show_id"] for row in rows]
    return {
        "vectorizer": vectorizer,
        "matrix": matrix,
        "show_ids": show_ids,
        "index": {show_id: position for position, show_id in enumerate(show_ids)},
        "catalog": source.get("catalog") or {},
        "hashes": dict(source.get("hashes") or {}),
        "genre_universe": list(source.get("genre_universe") or []),
        "manifest": source.get("manifest") or {},
        "row_count": len(rows),
    }


def candidate_pool(snapshot, user):
    """Every valid catalog title not already in the user's full prior seen set."""
    seen = {str(show_id) for show_id in snapshot["users"][user].get("seen", [])}
    return sorted(show_id for show_id in snapshot["catalog_genres"] if show_id not in seen)


def content_scores(snapshot, user, context):
    """True cosine of the L2-normalized mean unique liked-title vector to each title."""
    liked = sorted({str(show_id) for show_id in snapshot["users"][user].get("liked_ids", [])})
    positions = [context["index"][show_id] for show_id in liked if show_id in context["index"]]
    if not positions:
        return None
    mean = numpy.asarray(context["matrix"][positions].mean(axis=0)).ravel()
    norm = float(numpy.linalg.norm(mean))
    if not math.isfinite(norm) or norm <= 0.0:
        return None
    scores = numpy.asarray(context["matrix"].dot(mean / norm)).ravel()
    return {show_id: float(scores[context["index"][show_id]]) for show_id in context["show_ids"]}


def popularity_scores(snapshot, members=None):
    """Distinct-user latest-liked counts over the whole valid catalog, log1p normalized."""
    counts = {show_id: 0 for show_id in snapshot["catalog_genres"]}
    for user in sorted(set(snapshot["user_keys"] if members is None else members)):
        record = snapshot["users"].get(user)
        if record is None:
            continue
        for show_id in set(record.get("liked_ids", [])):
            if show_id in counts:
                counts[show_id] += 1
    maximum = max(counts.values()) if counts else 0
    if maximum <= 0:
        return None
    denominator = math.log1p(maximum)
    return {show_id: math.log1p(count) / denominator for show_id, count in counts.items()}


def _component(name, values):
    if values is None:
        return None
    if not isinstance(values, Mapping):
        raise ValueError(f"{name} component must be a mapping or None")
    cleaned = {}
    for key, value in values.items():
        if value is None:
            cleaned[str(key)] = None
            continue
        score = float(value)
        if not math.isfinite(score) or score < -TOLERANCE or score > 1.0 + TOLERANCE:
            raise ValueError(f"{name} score for {key} is outside finite [0, 1]")
        cleaned[str(key)] = min(1.0, max(0.0, score))
    return cleaned


def _weights(weights):
    if not isinstance(weights, Mapping):
        raise ValueError("weights must be a mapping")
    values = {key: float(weights.get(key, 0.0)) for key in KEYS}
    if any(not math.isfinite(value) or value < 0.0 for value in values.values()):
        raise ValueError("weights must be non-negative")
    if abs(sum(values.values()) - 1.0) > 1e-6:
        raise ValueError("weights must sum to 1")
    return values


def _row(show_id, final_score, values, active_weights, mode, reasons):
    return {
        "show_id": show_id,
        "final_score": None if final_score is None else float(final_score),
        "content_score": None if values["C"] is None else values["C"].get(show_id),
        "popularity_score": None if values["P"] is None else values["P"].get(show_id),
        "P_like": None if values["T"] is None else values["T"].get(show_id),
        "cluster_score": None if values["K"] is None else values["K"].get(show_id),
        "active_weights": {key: float(value) for key, value in active_weights.items()},
        "reason_codes": list(reasons),
        "mode": mode,
    }


def rank_candidates(candidate_ids, components, weights, has_profile):
    """Weighted hybrid over available components with popularity/catalog fallbacks."""
    pool = sorted({str(show_id) for show_id in candidate_ids})
    values = {key: _component(key, components.get(key)) for key in KEYS}
    base = _weights(weights)
    requested = [key for key in KEYS if base[key] > 0.0]
    usable = [key for key in requested if values[key] is not None] if has_profile else []
    rows = []
    for show_id in pool:
        chosen = [key for key in usable if values[key].get(show_id) is not None]
        if not chosen:
            fallback = values["P"] is not None and values["P"].get(show_id) is not None
            reasons = ["cold_user_no_profile"] if not has_profile else ["no_available_signal"]
            if fallback:
                rows.append(_row(show_id, values["P"][show_id], values, {"P": 1.0}, "popularity_fallback", reasons))
            else:
                rows.append(_row(show_id, None, values, {}, "catalog_fallback", reasons + ["catalog_fallback"]))
            continue
        dropped = [key for key in requested if values[key] is None or values[key].get(show_id) is None]
        reasons = ["missing_values:" + ",".join(dropped)] if dropped else []
        if len(chosen) < len(requested):
            reasons.append("partial_component_availability")
        total = sum(base[key] for key in chosen)
        final = sum(base[key] * values[key][show_id] for key in chosen) / total
        active = {key: base[key] / total for key in chosen}
        mode = "hybrid" if len(chosen) > 1 else NAMES[chosen[0]]
        rows.append(_row(show_id, final, values, active, mode, reasons))
    rows.sort(key=lambda row: (row["final_score"] is None, -(row["final_score"] or 0.0), row["show_id"]))
    return rows


def _ordered_ids(ranking):
    return [str(row["show_id"]) if isinstance(row, Mapping) else str(row) for row in ranking]


def ranking_metrics(ranking, relevant, k):
    """Actual-order precision@k (fixed K), recall and binary NDCG; null without positives."""
    if int(k) < 1:
        raise ValueError("k must be a positive integer")
    k = int(k)
    positives = {str(show_id) for show_id in (relevant or [])}
    ordered = _ordered_ids(ranking)
    top = ordered[:k]
    hits = sum(1 for show_id in top if show_id in positives)
    count = len(positives)
    precision = hits / k
    recall = hits / count if count else None
    ndcg = None
    if count:
        dcg = sum(1.0 / math.log2(position + 1)
                  for position, show_id in enumerate(top, start=1) if show_id in positives)
        idcg = sum(1.0 / math.log2(position + 1) for position in range(1, min(count, k) + 1))
        ndcg = dcg / idcg if idcg > 0 else None
    return {"precision": precision, "recall": recall, "ndcg": ndcg,
            "returned": len(top), "eligible_count": len(ordered), "positives": count, "hits": hits}


def _fixture_snapshot(users, catalog):
    return {"cohort": "synthetic", "cutoff": "2026-08-22T00:00:00+00:00", "user_keys": sorted(users),
            "users": users, "catalog_genres": catalog,
            "genre_universe": sorted({genre for genres in catalog.values() for genre in genres})}


def _fixture_context():
    matrix = numpy.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.6, 0.8, 0.0]])
    show_ids = ["a", "b", "c", "e"]
    return {"matrix": matrix, "show_ids": show_ids, "index": {s: i for i, s in enumerate(show_ids)},
            "catalog": {}, "hashes": {}, "genre_universe": [], "manifest": {}}


def _check_content(snapshot, context):
    scores = content_scores(snapshot, "u", context)
    mean = context["matrix"][[0, 3]].mean(axis=0)
    expected = context["matrix"].dot(mean / numpy.linalg.norm(mean))
    assert all(abs(scores[sid] - float(value)) < 1e-12 for sid, value in zip(context["show_ids"], expected))
    assert not numpy.allclose(context["matrix"].dot(mean), expected)
    assert abs(scores["c"]) < 1e-12 and content_scores(snapshot, "cold", context) is None
    built = build_content_context({"catalog_rows": [
        {"show_id": "x", "title_clean": "Space Ocean", "description_clean": "A family explores an ocean planet.",
         "genres_clean": "Documentaries", "cleaning_status": "valid"},
        {"show_id": "y", "title_clean": "City Comedy", "description_clean": "Friends laugh in a city.",
         "genres_clean": "Comedies", "cleaning_status": "valid"}],
        "catalog": {}, "hashes": {}, "genre_universe": [], "manifest": {}})
    assert built["show_ids"] == ["x", "y"] and built["row_count"] == 2
    norm = numpy.linalg.norm(numpy.asarray(built["matrix"][0].todense()).ravel())
    assert abs(norm - 1.0) < 1e-9


def _check_ranking(snapshot):
    catalog = snapshot["catalog_genres"]
    for user in ("u", "v", "cold"):
        assert candidate_pool(snapshot, user) == sorted(set(catalog) - set(snapshot["users"][user]["seen"]))
    popularity = popularity_scores(snapshot)
    assert abs(popularity["a"] - 1.0) < 1e-12
    assert abs(popularity["e"] - math.log1p(1) / math.log1p(2)) < 1e-12
    assert popularity["b"] == 0.0 and popularity_scores(snapshot, []) is None
    assert popularity_scores(_fixture_snapshot({"x": {"liked_ids": [], "seen": []}}, catalog)) is None
    rows = rank_candidates(["a"], {"C": {"a": 1.0}, "P": {"a": 0.0}, "T": None, "K": None},
                           {"C": 0.5, "P": 0.15, "T": 0.25, "K": 0.1}, True)
    assert abs(rows[0]["final_score"] - (0.5 * 1.0 + 0.15 * 0.0) / 0.65) < 1e-12
    assert abs(sum(rows[0]["active_weights"].values()) - 1.0) < 1e-12
    assert set(rows[0]["active_weights"]) == {"C", "P"}
    zero = rank_candidates(["a"], {"C": {"a": 0.0}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert zero[0]["final_score"] == 0.0 and zero[0]["mode"] == "content"
    tied = rank_candidates(["b", "a"], {"C": {"a": 0.5, "b": 0.5}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert [row["show_id"] for row in tied] == ["a", "b"]
    cold = rank_candidates(["a"], {"C": {"a": 0.9}, "P": {"a": 0.3}, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, False)
    assert cold[0]["mode"] == "popularity_fallback" and abs(cold[0]["final_score"] - 0.3) < 1e-12
    empty = rank_candidates(["a"], {"C": None, "P": None, "T": None, "K": None},
                            {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert empty[0]["mode"] == "catalog_fallback" and empty[0]["final_score"] is None
    pop_fallback = rank_candidates(["a"], {"C": None, "P": {"a": 0.4}, "T": None, "K": None},
                                   {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    assert pop_fallback[0]["mode"] == "popularity_fallback" and abs(pop_fallback[0]["final_score"] - 0.4) < 1e-12
    blank = {"C": None, "P": None, "T": None, "K": None}
    for bad in ({"C": {"a": 1.5}}, {"C": {"a": -0.1}}, {"C": {"a": float("nan")}}):
        try:
            rank_candidates(["a"], {**blank, **bad}, {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
            raise AssertionError("invalid component value accepted")
        except ValueError:
            pass


def _check_metrics(rows):
    fewer = ranking_metrics(rows, {"a", "b"}, 5)
    assert fewer["returned"] == 1 and fewer["hits"] == 1 and abs(fewer["precision"] - 0.2) < 1e-12
    assert abs(fewer["recall"] - 0.5) < 1e-12 and fewer["positives"] == 2
    idcg = 1.0 + 1.0 / math.log2(3)
    assert abs(fewer["ndcg"] - 1.0 / idcg) < 1e-12
    first = ranking_metrics(["a", "b"], {"a"}, 2)
    second = ranking_metrics(["b", "a"], {"a"}, 2)
    assert first["ndcg"] == 1.0 and second["ndcg"] < first["ndcg"]
    no_pos = ranking_metrics(["a"], set(), 2)
    assert no_pos["ndcg"] is None and no_pos["recall"] is None and no_pos["positives"] == 0
    try:
        ranking_metrics(["a"], {"a"}, 0)
        raise AssertionError("non-positive k accepted")
    except ValueError:
        pass


def self_check():
    catalog = {"a": {"Drama"}, "b": {"Comedies"}, "c": {"Action"}, "e": {"Drama"}}
    snapshot = _fixture_snapshot({
        "u": {"liked_ids": ["a", "e"], "seen": ["a", "e", "zz"]},
        "v": {"liked_ids": ["a", "a"], "seen": ["a", "b"]},
        "cold": {"liked_ids": [], "seen": ["c"]},
    }, catalog)
    _check_content(snapshot, _fixture_context())
    _check_ranking(snapshot)
    rows = rank_candidates(["a"], {"C": {"a": 1.0}, "P": None, "T": None, "K": None},
                           {"C": 1.0, "P": 0.0, "T": 0.0, "K": 0.0}, True)
    _check_metrics(rows)
    try:
        rank_candidates(["a"], {"C": {"a": 1.0}}, {"C": 0.5, "P": 0.6, "T": 0.0, "K": 0.0}, True)
        raise AssertionError("weight sum accepted")
    except ValueError:
        pass
    print("self-check ok: content normalization, distinct/cmax0 popularity, seen pool, "
          "renormalization, real-zero, ties, cold/empty fallbacks, metrics order")


if __name__ == "__main__":
    self_check()
