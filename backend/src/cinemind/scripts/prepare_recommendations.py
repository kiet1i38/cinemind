"""Build the optional Week 6 recommendation artifact before serving requests."""

from __future__ import annotations

import os

from cinemind.config import get_settings
from cinemind.recommendations.prepare import PrepareError, prepare_recommendation_artifact


def main() -> int:
    settings = get_settings()
    input_dir = os.environ.get("CINEMIND_WEEK6_SEED_DIR", "/app/data/week6/seed")
    output_path = os.environ.get(
        "CINEMIND_RECOMMENDATION_ARTIFACT_PATH",
        "/app/data/week6/artifacts/recommendation_artifact.json",
    )
    tree_fragment_path = os.environ.get("CINEMIND_WEEK6_TREE_FRAGMENT") or None
    try:
        result = prepare_recommendation_artifact(
            input_dir=input_dir,
            catalog_path=settings.catalog_seed_path,
            output_path=output_path,
            tree_fragment_path=tree_fragment_path,
        )
    except PrepareError as error:
        # Validation failures must not take the catalog/auth API offline or
        # overwrite the last validated artifact. Keep this log free of row data.
        print(f"RECOMMENDATION_PREP status=skipped code={error.code}")
        return 0

    counts = result.dataset_counts or {}
    print(
        "RECOMMENDATION_PREP "
        f"status={result.status} bytes={result.artifact_bytes} "
        f"users={counts.get('users_total', 0)} "
        f"synthetic={counts.get('users_synthetic', 0)} "
        f"ratings={counts.get('ratings_synthetic', 0)} "
        f"excluded_no_rating={counts.get('ratings_excluded_no_rating', 0)} "
        f"missing_completion={counts.get('watches_missing_completion_rate', 0)} "
        f"searches={counts.get('searches_synthetic', 0)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
