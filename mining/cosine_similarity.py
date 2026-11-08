#!/usr/bin/env python3
"""Offline cosine content scores for the Week 5 ranking stage.

Previously mining/ranking_scores.py. Serving cosine stays in the backend.
"""

import math

import numpy
from sklearn.preprocessing import normalize

from tfidf import build_baseline_rows, fit_tfidf


# Previously: mining/ranking_scores.py
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


# Previously: mining/ranking_scores.py
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


# Previously: mining/ranking_scores.py
def _fixture_context():
    matrix = numpy.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.6, 0.8, 0.0]])
    show_ids = ["a", "b", "c", "e"]
    return {"matrix": matrix, "show_ids": show_ids, "index": {s: i for i, s in enumerate(show_ids)},
            "catalog": {}, "hashes": {}, "genre_universe": [], "manifest": {}}


# Previously: mining/ranking_scores.py
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
