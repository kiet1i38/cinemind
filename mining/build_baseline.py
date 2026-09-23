#!/usr/bin/env python3
"""Build the v0.1 TF-IDF content-similarity baseline."""

import argparse
import csv
import json
from pathlib import Path

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
except ModuleNotFoundError as error:  # pragma: no cover - environment guidance
    raise SystemExit(
        "scikit-learn is required; activate mining/.venv and install it with "
        "python -m pip install -U scikit-learn"
    ) from error


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "tmp/catalog_clean.csv"
DEFAULT_CLEAN_MANIFEST = ROOT / "tmp/catalog_clean_manifest.json"
DEFAULT_BASELINE_OUTPUT = ROOT / "tmp/baseline_catalog.csv"
DEFAULT_SIMILARITY_OUTPUT = ROOT / "tmp/content_similarity_examples.csv"
DEFAULT_MANIFEST_OUTPUT = ROOT / "tmp/tfidf_manifest.json"

BASELINE_VERSION = "baseline-v0.1"
BASELINE_FIELDS = ["show_id", "title_clean", "baseline_text", "cleaning_status"]
SIMILARITY_FIELDS = [
    "query_show_id",
    "query_title",
    "rank",
    "candidate_show_id",
    "candidate_title",
    "similarity",
]
VECTOR_CONFIG = {
    "lowercase": True,
    "stop_words": None,
    "ngram_range": (1, 1),
}
SAMPLE_QUERY_IDS = ("s1", "s8", "s32", "s5542")


def read_csv(path):
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def read_json(path):
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def build_baseline_rows(rows):
    result = []
    seen_ids = set()
    for row in rows:
        show_id = row.get("show_id", "").strip()
        if not show_id or show_id in seen_ids:
            raise ValueError(f"Invalid or duplicate show_id: {show_id!r}")
        seen_ids.add(show_id)
        if row.get("cleaning_status") == "quarantine":
            continue

        text_parts = [
            row.get("title_clean", "").strip(),
            row.get("description_clean", "").strip(),
            row.get("genres_clean", "").strip(),
        ]
        baseline_text = " ".join(part for part in text_parts if part)
        if not baseline_text:
            raise ValueError(f"Empty baseline_text for {show_id}")
        result.append(
            {
                "show_id": show_id,
                "title_clean": row.get("title_clean", "").strip(),
                "baseline_text": baseline_text,
                "cleaning_status": row.get("cleaning_status", ""),
            }
        )
    return result


def fit_tfidf(rows):
    vectorizer = TfidfVectorizer(**VECTOR_CONFIG)
    matrix = vectorizer.fit_transform(row["baseline_text"] for row in rows)
    return vectorizer, matrix


def choose_query_ids(rows):
    available = {row["show_id"] for row in rows}
    selected = [show_id for show_id in SAMPLE_QUERY_IDS if show_id in available]
    return selected or [row["show_id"] for row in rows[:4]]


def similarity_rows(rows, matrix, query_ids, top_k):
    by_id = {row["show_id"]: index for index, row in enumerate(rows)}
    output = []
    for query_id in query_ids:
        query_index = by_id[query_id]
        scores = cosine_similarity(matrix[query_index], matrix).ravel().tolist()
        candidates = sorted(
            (
                (score, row["show_id"], index)
                for index, (score, row) in enumerate(zip(scores, rows))
                if index != query_index
            ),
            key=lambda item: (-item[0], item[1]),
        )[:top_k]
        for rank, (score, candidate_id, candidate_index) in enumerate(candidates, start=1):
            output.append(
                {
                    "query_show_id": query_id,
                    "query_title": rows[query_index]["title_clean"],
                    "rank": rank,
                    "candidate_show_id": candidate_id,
                    "candidate_title": rows[candidate_index]["title_clean"],
                    "similarity": f"{score:.6f}",
                }
            )
    return output


def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run(input_path, clean_manifest_path, baseline_path, similarity_path, manifest_path, top_k):
    source_rows = read_csv(input_path)
    baseline_rows = build_baseline_rows(source_rows)
    vectorizer, matrix = fit_tfidf(baseline_rows)
    query_ids = choose_query_ids(baseline_rows)
    similarity = similarity_rows(baseline_rows, matrix, query_ids, top_k)
    clean_manifest = read_json(clean_manifest_path)

    write_csv(baseline_path, BASELINE_FIELDS, baseline_rows)
    write_csv(similarity_path, SIMILARITY_FIELDS, similarity)
    write_json(
        manifest_path,
        {
            "baseline_version": BASELINE_VERSION,
            "input_rows": len(source_rows),
            "used_rows": len(baseline_rows),
            "excluded_quarantine_rows": len(source_rows) - len(baseline_rows),
            "input_raw_sha256": clean_manifest.get("raw_sha256"),
            "vectorizer": VECTOR_CONFIG,
            "matrix_shape": list(matrix.shape),
            "vocabulary_size": len(vectorizer.vocabulary_),
            "top_k": top_k,
            "sample_query_ids": query_ids,
        },
    )
    print(f"baseline rows: {len(baseline_rows)}; matrix shape: {matrix.shape}")
    print(f"wrote {baseline_path}, {similarity_path}, and {manifest_path}")


def self_check():
    rows = build_baseline_rows(
        [
            {
                "show_id": "x1",
                "title_clean": "Space Ocean",
                "description_clean": "A family explores an ocean planet.",
                "genres_clean": "Documentaries",
                "cleaning_status": "valid",
            },
            {
                "show_id": "x2",
                "title_clean": "Ocean Family",
                "description_clean": "A family discovers life under the sea.",
                "genres_clean": "Documentaries",
                "cleaning_status": "valid",
            },
            {
                "show_id": "x3",
                "title_clean": "City Comedy",
                "description_clean": "Friends laugh together in a city.",
                "genres_clean": "Comedies",
                "cleaning_status": "valid",
            },
        ]
    )
    vectorizer, matrix = fit_tfidf(rows)
    assert len(rows) == 3
    assert matrix.shape[0] == 3 and matrix.shape[1] == len(vectorizer.vocabulary_)
    assert matrix[0].nnz > 0
    assert abs(float(cosine_similarity(matrix[0], matrix[0])[0, 0]) - 1) < 1e-9
    assert rows[0]["baseline_text"] == "Space Ocean A family explores an ocean planet. Documentaries"
    assert len(similarity_rows(rows, matrix, ["x1"], top_k=2)) == 2
    print("self-check ok: baseline_text, TF-IDF shape, self-similarity, Top-K")


def main():
    parser = argparse.ArgumentParser(description="Build the CineMind TF-IDF content baseline.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--clean-manifest", type=Path, default=DEFAULT_CLEAN_MANIFEST)
    parser.add_argument("--baseline-output", type=Path, default=DEFAULT_BASELINE_OUTPUT)
    parser.add_argument("--similarity-output", type=Path, default=DEFAULT_SIMILARITY_OUTPUT)
    parser.add_argument("--manifest-output", type=Path, default=DEFAULT_MANIFEST_OUTPUT)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--self-check", action="store_true", help="run assertions and write nothing")
    args = parser.parse_args()

    if args.top_k < 1:
        parser.error("--top-k must be positive")
    if args.self_check:
        self_check()
        return
    run(
        args.input,
        args.clean_manifest,
        args.baseline_output,
        args.similarity_output,
        args.manifest_output,
        args.top_k,
    )


if __name__ == "__main__":
    main()
