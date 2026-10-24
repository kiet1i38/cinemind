from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest

from cinemind.recommendations.artifacts import RecommendationArtifactStore
from cinemind.recommendations.prepare import PrepareError, prepare_recommendation_artifact


HEADERS = {
    "week6_export_context.csv": ["export_cutoff", "cohort", "watch_mining_view"],
    "ratings.csv": ["user_key", "target_key", "cohort", "show_id", "rating_value", "rated_at"],
    "watches_for_mining.csv": [
        "watch_key", "user_key", "cohort", "show_id", "watch_seconds",
        "completion_rate", "duration_basis", "recorded_at",
    ],
    "searches.csv": ["search_key", "user_key", "cohort", "occurred_at"],
    "week6_cohort_map.csv": ["user_key", "cohort", "favorite_group"],
}
EXPORT_CUTOFF = "2026-10-16T12:00:00+00:00"


def _digest(label: str) -> str:
    return hashlib.md5(label.encode("utf-8")).hexdigest()


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=HEADERS[path.name])
        writer.writeheader()
        writer.writerows(rows)


@pytest.fixture
def week6_bundle(tmp_path: Path) -> tuple[Path, Path, Path]:
    seed_dir = tmp_path / "seed"
    seed_dir.mkdir()
    catalog_path = tmp_path / "catalog.json"
    artifact_path = tmp_path / "artifact.json"
    catalog_path.write_text(
        json.dumps(
            [
                {"id": "s1", "title": "Quiet Harbor", "description": "A quiet harbor at night.", "listedIn": "Drama"},
                {"id": "s2", "title": "Bright City", "description": "A lively city adventure.", "listedIn": "Action"},
                {"id": "s3", "title": "Harbor Lights", "description": "Friends solve a mystery.", "listedIn": "Drama, Mystery"},
            ]
        ),
        encoding="utf-8",
    )
    _write_csv(seed_dir / "week6_export_context.csv", [{
        "export_cutoff": EXPORT_CUTOFF,
        "cohort": "unknown",
        "watch_mining_view": "interaction.watch_sessions_for_mining",
    }])

    mapped_user = _digest("synthetic-a")
    unknown_user = _digest("unknown-z")
    _write_csv(seed_dir / "week6_cohort_map.csv", [{
        "user_key": mapped_user,
        "cohort": "synthetic",
        "favorite_group": "breaking_bad",
    }])
    _write_csv(seed_dir / "ratings.csv", [
        {
            "user_key": mapped_user,
            "target_key": _digest("rating-a-1"),
            "cohort": "unknown",
            "show_id": "s1",
            "rating_value": "9",
            "rated_at": "2026-10-16T10:00:00+00:00",
        },
        {
            "user_key": mapped_user,
            "target_key": _digest("rating-a-2"),
            "cohort": "unknown",
            "show_id": "s1",
            "rating_value": "5",
            "rated_at": "2026-10-16T10:10:00+00:00",
        },
        {
            "user_key": mapped_user,
            "target_key": _digest("rating-a-3"),
            "cohort": "unknown",
            "show_id": "s2",
            "rating_value": "8",
            "rated_at": "2026-10-16T10:20:00+00:00",
        },
        {
            "user_key": unknown_user,
            "target_key": _digest("rating-z-1"),
            "cohort": "unknown",
            "show_id": "s1",
            "rating_value": "10",
            "rated_at": "2026-10-16T10:30:00+00:00",
        },
    ])
    _write_csv(seed_dir / "watches_for_mining.csv", [{
        "watch_key": _digest("watch-a-1"),
        "user_key": mapped_user,
        "cohort": "unknown",
        "show_id": "s2",
        "watch_seconds": "1200",
        "completion_rate": "0.75",
        "duration_basis": "movie_runtime",
        "recorded_at": "2026-10-16T11:00:00+00:00",
    }])
    _write_csv(seed_dir / "searches.csv", [{
        "search_key": _digest("search-a-1"),
        "user_key": mapped_user,
        "cohort": "unknown",
        "occurred_at": "2026-10-16T11:30:00+00:00",
    }])
    return seed_dir, catalog_path, artifact_path


def test_builds_checksummed_privacy_minimized_artifact(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle

    result = prepare_recommendation_artifact(
        input_dir=seed_dir,
        catalog_path=catalog_path,
        output_path=artifact_path,
    )

    assert result.status == "degraded"  # This fixture intentionally is not the full 100-user cohort.
    snapshot = RecommendationArtifactStore(artifact_path).load()
    assert snapshot.status == "degraded"
    assert snapshot.artifact["popularity"] == {"s1": 0.0, "s2": 1.0, "s3": 0.0}
    assert snapshot.artifact["dataset_counts"]["users_synthetic"] == 1
    assert snapshot.artifact["dataset_counts"]["users_unknown"] == 1
    assert snapshot.artifact["dataset_counts"]["searches_synthetic"] == 1
    assert snapshot.artifact["seed_reference_cutoff"] == "2026-10-16T11:30:00.000001+00:00"
    assert snapshot.artifact["cluster_model"] is None
    assert snapshot.artifact["tree_model"] is None
    assert snapshot.artifact["content_vectors"]["s1"]
    serialized = artifact_path.read_text(encoding="utf-8")
    assert "synthetic-a" not in serialized
    assert "unknown-z" not in serialized
    assert "email" not in serialized.casefold()
    assert "user_key" not in serialized.casefold()


def test_invalid_new_bundle_does_not_overwrite_last_good_artifact(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)
    previous = artifact_path.read_bytes()
    ratings_path = seed_dir / "ratings.csv"
    ratings_path.write_text("user_key,target_key\n", encoding="utf-8")

    with pytest.raises(PrepareError, match="input_header_mismatch"):
        prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)

    assert artifact_path.read_bytes() == previous


def test_rejects_timezone_less_events(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "searches.csv").open(encoding="utf-8")))
    rows[0]["occurred_at"] = "2026-10-16T13:00:00"  # Naive and beyond cutoff.
    _write_csv(seed_dir / "searches.csv", rows)

    with pytest.raises(PrepareError, match="event_timestamp_timezone_missing"):
        prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)


def test_rejects_events_at_or_after_export_cutoff(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "searches.csv").open(encoding="utf-8")))
    rows[0]["occurred_at"] = "2026-10-16T12:00:00+00:00"
    _write_csv(seed_dir / "searches.csv", rows)

    with pytest.raises(PrepareError, match="search_after_export_cutoff"):
        prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)


def test_accepts_half_step_ratings_and_uses_latest_synthetic_state(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "ratings.csv").open(encoding="utf-8")))
    rows[1]["rating_value"] = "6.5"
    rows.append({
        "user_key": _digest("synthetic-a"),
        "target_key": _digest("rating-a-half-step"),
        "cohort": "unknown",
        "show_id": "s3",
        "rating_value": "3.5",
        "rated_at": "2026-10-16T10:40:00+00:00",
    })
    _write_csv(seed_dir / "ratings.csv", rows)

    prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)

    snapshot = RecommendationArtifactStore(artifact_path).load()
    assert snapshot.artifact["popularity"] == {"s1": 0.0, "s2": 1.0, "s3": 0.0}


def test_excludes_legacy_zero_no_rating_from_preference_model(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "ratings.csv").open(encoding="utf-8")))
    rows.append({
        "user_key": _digest("synthetic-a"),
        "target_key": _digest("rating-a-no-rating"),
        "cohort": "unknown",
        "show_id": "s3",
        "rating_value": "0",
        "rated_at": "2026-10-16T10:40:00+00:00",
    })
    _write_csv(seed_dir / "ratings.csv", rows)

    result = prepare_recommendation_artifact(
        input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path
    )

    assert result.dataset_counts["ratings_excluded_no_rating"] == 1
    assert result.dataset_counts["ratings_excluded_no_rating_synthetic"] == 1
    assert result.dataset_counts["ratings_synthetic"] == 3
    snapshot = RecommendationArtifactStore(artifact_path).load()
    assert snapshot.artifact["popularity"] == {"s1": 0.0, "s2": 1.0, "s3": 0.0}


def test_preserves_nullable_tv_completion_as_missing_evidence(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "watches_for_mining.csv").open(encoding="utf-8")))
    rows[0]["duration_basis"] = "tv_seasons"
    rows[0]["completion_rate"] = "NULL"
    _write_csv(seed_dir / "watches_for_mining.csv", rows)

    result = prepare_recommendation_artifact(
        input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path
    )

    assert result.dataset_counts["watches_missing_completion_rate"] == 1
    assert result.dataset_counts["watches_missing_completion_rate_synthetic"] == 1


def test_accepts_seed_baseline_and_extra_events_with_four_groups_of_25(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    groups = ("breaking_bad", "stranger_things", "friends", "squid_game")
    cohort_rows = []
    rating_rows = []
    search_rows = []
    for serial in range(1, 101):
        user_key = _digest(f"synthetic-roster-{serial:03d}")
        cohort_rows.append({
            "user_key": user_key,
            "cohort": "synthetic",
            "favorite_group": groups[(serial - 1) // 25],
        })
        for index in range(20):
            rating_rows.append({
                "user_key": user_key,
                "target_key": _digest(f"roster-rating-{serial}-{index}"),
                "cohort": "unknown",
                "show_id": ("s1", "s2", "s3")[index % 3],
                "rating_value": "8",
                "rated_at": f"2026-10-16T10:{index:02d}:00+00:00",
            })
        for index in range(5):
            search_rows.append({
                "search_key": _digest(f"roster-search-{serial}-{index}"),
                "user_key": user_key,
                "cohort": "unknown",
                "occurred_at": f"2026-10-16T11:{index:02d}:00+00:00",
            })

    _write_csv(seed_dir / "week6_cohort_map.csv", cohort_rows)
    rating_rows.append({
        "user_key": _digest("synthetic-roster-001"),
        "target_key": _digest("roster-rating-extra"),
        "cohort": "unknown",
        "show_id": "s1",
        "rating_value": "6.5",
        "rated_at": "2026-10-16T11:16:00+00:00",
    })
    search_rows.append({
        "search_key": _digest("roster-search-extra"),
        "user_key": _digest("synthetic-roster-001"),
        "cohort": "unknown",
        "occurred_at": "2026-10-16T11:15:00+00:00",
    })
    _write_csv(seed_dir / "ratings.csv", rating_rows)
    _write_csv(seed_dir / "searches.csv", search_rows)
    _write_csv(seed_dir / "watches_for_mining.csv", [])

    result = prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)

    assert result.status == "ready"
    counts = result.dataset_counts
    assert counts["synthetic_roster_complete"] == 1
    assert counts["users_synthetic"] == 100
    assert counts["ratings_synthetic"] == 2001
    assert counts["searches_synthetic"] == 501
    assert [counts[f"favorite_group_{group}"] for group in groups] == [25, 25, 25, 25]


def test_rejects_invalid_pseudonymous_search_key(week6_bundle):
    seed_dir, catalog_path, artifact_path = week6_bundle
    rows = list(csv.DictReader((seed_dir / "searches.csv").open(encoding="utf-8")))
    rows[0]["search_key"] = "not-a-pseudonymous-hash"
    _write_csv(seed_dir / "searches.csv", rows)

    with pytest.raises(PrepareError, match="pseudonymous_key_invalid"):
        prepare_recommendation_artifact(input_dir=seed_dir, catalog_path=catalog_path, output_path=artifact_path)
