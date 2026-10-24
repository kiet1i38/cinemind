"""Validate the Week 6 export bundle and build a privacy-minimized artifact."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from cinemind.recommendations.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    MAX_ARTIFACT_BYTES,
    _validate_artifact,
    seal_artifact,
)


BUILDER_VERSION = "week6-tfidf-popularity-v2"
MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024
MAX_ROWS_PER_FILE = 250_000
HASH_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TOKEN_PATTERN = re.compile(r"(?u)\b\w\w+\b")
EXPECTED_HEADERS = {
    "week6_export_context.csv": ("export_cutoff", "cohort", "watch_mining_view"),
    "ratings.csv": ("user_key", "target_key", "cohort", "show_id", "rating_value", "rated_at"),
    "watches_for_mining.csv": (
        "watch_key", "user_key", "cohort", "show_id", "watch_seconds",
        "completion_rate", "duration_basis", "recorded_at",
    ),
    "searches.csv": ("search_key", "user_key", "cohort", "occurred_at"),
    "week6_cohort_map.csv": ("user_key", "cohort", "favorite_group"),
}
OPTIONAL_FIELDS = {"watches_for_mining.csv": frozenset({"completion_rate"})}
FAVORITE_GROUPS = ("breaking_bad", "stranger_things", "friends", "squid_game")
TARGET_SYNTHETIC_USERS = 100
TARGET_GROUP_SIZE = 25
MAX_WATCH_SECONDS = 604_800


class PrepareError(ValueError):
    """A safe-to-log input validation error, without echoing row contents."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PrepareResult:
    status: str
    artifact_bytes: int = 0
    dataset_counts: dict[str, int] | None = None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_csv(path: Path, expected_header: tuple[str, ...]) -> list[dict[str, str]]:
    try:
        if path.stat().st_size > MAX_INPUT_FILE_BYTES:
            raise PrepareError("input_file_too_large")
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.DictReader(source)
            if tuple(reader.fieldnames or ()) != expected_header:
                raise PrepareError("input_header_mismatch")
            rows: list[dict[str, str]] = []
            for index, row in enumerate(reader, start=1):
                if index > MAX_ROWS_PER_FILE:
                    raise PrepareError("input_row_limit_exceeded")
                if None in row or any(row.get(name) is None for name in expected_header):
                    raise PrepareError("malformed_csv_row")
                normalized = {name: row[name].strip() for name in expected_header}
                optional_fields = OPTIONAL_FIELDS.get(path.name, frozenset())
                for name in optional_fields:
                    if normalized[name].casefold() == "null":
                        normalized[name] = ""
                if any(not value and name not in optional_fields for name, value in normalized.items()):
                    raise PrepareError("blank_csv_value")
                rows.append(normalized)
            return rows
    except OSError as error:
        raise PrepareError("input_file_unavailable") from error
    except UnicodeError as error:
        raise PrepareError("input_encoding_invalid") from error
    except csv.Error as error:
        raise PrepareError("input_csv_invalid") from error


def _parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PrepareError("event_timestamp_invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PrepareError("event_timestamp_timezone_missing")
    return parsed.astimezone(timezone.utc)


def _parse_decimal(value: str, *, low: Decimal, high: Decimal, code: str) -> Decimal:
    try:
        number = Decimal(value)
    except InvalidOperation as error:
        raise PrepareError(code) from error
    if not number.is_finite() or number < low or number > high:
        raise PrepareError(code)
    return number


def _require_hash(value: str) -> None:
    if not HASH_PATTERN.fullmatch(value):
        raise PrepareError("pseudonymous_key_invalid")


def _load_catalog(path: Path) -> tuple[dict[str, dict[str, Any]], str]:
    try:
        if path.stat().st_size > MAX_INPUT_FILE_BYTES:
            raise PrepareError("catalog_file_too_large")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except PrepareError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PrepareError("catalog_file_invalid") from error
    if not isinstance(payload, list) or not payload:
        raise PrepareError("catalog_shape_invalid")

    catalog: dict[str, dict[str, Any]] = {}
    for record in payload:
        if not isinstance(record, dict):
            raise PrepareError("catalog_record_invalid")
        show_id = record.get("id")
        title = record.get("title")
        if not isinstance(show_id, str) or not show_id.strip() or not isinstance(title, str) or not title.strip():
            raise PrepareError("catalog_identity_invalid")
        show_id = show_id.strip()
        if show_id in catalog:
            raise PrepareError("catalog_show_id_duplicate")
        catalog[show_id] = record
    return catalog, _sha256(path)


def _read_context(input_dir: Path) -> tuple[datetime, dict[str, str]]:
    rows = _read_csv(input_dir / "week6_export_context.csv", EXPECTED_HEADERS["week6_export_context.csv"])
    if len(rows) != 1 or rows[0]["cohort"] != "unknown":
        raise PrepareError("export_context_invalid")
    if rows[0]["watch_mining_view"] != "interaction.watch_sessions_for_mining":
        raise PrepareError("watch_mining_view_unavailable")
    return _parse_time(rows[0]["export_cutoff"]), {"context": _sha256(input_dir / "week6_export_context.csv")}


def _load_cohort_map(rows: list[dict[str, str]]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for row in rows:
        key = row["user_key"]
        _require_hash(key)
        group = row["favorite_group"]
        if row["cohort"] != "synthetic" or group not in FAVORITE_GROUPS or key in mapping:
            raise PrepareError("cohort_map_invalid")
        mapping[key] = group
    return mapping


def _validated_events(
    input_dir: Path,
    catalog_ids: set[str],
    cohort_map: dict[str, str],
    export_cutoff: datetime,
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, int], datetime | None]:
    latest_ratings: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    per_user_counts: dict[str, Counter[str]] = defaultdict(Counter)
    all_users: set[str] = set()
    event_counts: Counter[str] = Counter()
    event_times: list[datetime] = []

    rating_rows = _read_csv(input_dir / "ratings.csv", EXPECTED_HEADERS["ratings.csv"])
    rating_keys: set[str] = set()
    timestamp_values: dict[tuple[str, str, datetime], Decimal] = {}
    for row in rating_rows:
        user_key, target_key, show_id = row["user_key"], row["target_key"], row["show_id"]
        _require_hash(user_key)
        _require_hash(target_key)
        if target_key in rating_keys:
            raise PrepareError("rating_event_duplicate")
        rating_keys.add(target_key)
        if row["cohort"] != "unknown" or show_id not in catalog_ids:
            raise PrepareError("rating_owner_or_title_invalid")
        rated_at = _parse_time(row["rated_at"])
        if rated_at >= export_cutoff:
            raise PrepareError("rating_after_export_cutoff")
        event_times.append(rated_at)
        # Older app versions persisted the UI's "No rating" choice as 0. Keep
        # that source row auditable, but never treat it as a preference label.
        rating = _parse_decimal(row["rating_value"], low=Decimal("0"), high=Decimal("10"), code="rating_value_invalid")
        if rating != 0 and rating < Decimal("0.5"):
            raise PrepareError("rating_value_invalid")
        if rating != 0 and rating * 2 != (rating * 2).to_integral_value():
            raise PrepareError("rating_increment_invalid")
        tie_key = (user_key, show_id, rated_at)
        previous = timestamp_values.setdefault(tie_key, rating)
        if previous != rating:
            raise PrepareError("rating_timestamp_conflict")
        all_users.add(user_key)
        cohort_name = "synthetic" if user_key in cohort_map else "unknown"
        if rating == 0:
            event_counts["ratings_excluded_no_rating"] += 1
            event_counts[f"ratings_excluded_no_rating_{cohort_name}"] += 1
            continue
        per_user_counts[user_key]["ratings"] += 1
        event_counts[f"ratings_{cohort_name}"] += 1
        existing = latest_ratings[user_key].get(show_id)
        if existing is None or rated_at > existing["rated_at"]:
            latest_ratings[user_key][show_id] = {"rating": rating, "rated_at": rated_at}

    watch_rows = _read_csv(input_dir / "watches_for_mining.csv", EXPECTED_HEADERS["watches_for_mining.csv"])
    watch_keys: set[str] = set()
    for row in watch_rows:
        watch_key, user_key, show_id = row["watch_key"], row["user_key"], row["show_id"]
        _require_hash(watch_key)
        _require_hash(user_key)
        if watch_key in watch_keys:
            raise PrepareError("watch_event_duplicate")
        watch_keys.add(watch_key)
        if row["cohort"] != "unknown" or show_id not in catalog_ids or not row["duration_basis"]:
            raise PrepareError("watch_owner_or_title_invalid")
        watch_at = _parse_time(row["recorded_at"])
        if watch_at >= export_cutoff:
            raise PrepareError("watch_after_export_cutoff")
        event_times.append(watch_at)
        _parse_decimal(row["watch_seconds"], low=Decimal("0"), high=Decimal(MAX_WATCH_SECONDS), code="watch_duration_invalid")
        cohort_name = "synthetic" if user_key in cohort_map else "unknown"
        completion_rate = row["completion_rate"].strip()
        if completion_rate:
            _parse_decimal(completion_rate, low=Decimal("0"), high=Decimal("1"), code="watch_completion_invalid")
        else:
            # The source schema permits NULL (notably for TV-season progress,
            # where no total runtime exists); preserve it as missing evidence.
            event_counts["watches_missing_completion_rate"] += 1
            event_counts[f"watches_missing_completion_rate_{cohort_name}"] += 1
        all_users.add(user_key)
        per_user_counts[user_key]["watches"] += 1
        event_counts[f"watches_{cohort_name}"] += 1

    search_rows = _read_csv(input_dir / "searches.csv", EXPECTED_HEADERS["searches.csv"])
    search_keys: set[str] = set()
    for row in search_rows:
        search_key, user_key = row["search_key"], row["user_key"]
        _require_hash(search_key)
        _require_hash(user_key)
        if search_key in search_keys:
            raise PrepareError("search_event_duplicate")
        search_keys.add(search_key)
        if row["cohort"] != "unknown":
            raise PrepareError("search_owner_invalid")
        occurred_at = _parse_time(row["occurred_at"])
        if occurred_at >= export_cutoff:
            raise PrepareError("search_after_export_cutoff")
        event_times.append(occurred_at)
        all_users.add(user_key)
        per_user_counts[user_key]["searches"] += 1
        cohort_name = "synthetic" if user_key in cohort_map else "unknown"
        event_counts[f"searches_{cohort_name}"] += 1

    group_counts = Counter(cohort_map.values())
    event_counts.update({f"favorite_group_{group}": int(group_counts.get(group, 0)) for group in FAVORITE_GROUPS})
    event_counts["users_synthetic"] = len(cohort_map)
    event_counts["users_unknown"] = len(all_users - set(cohort_map))
    event_counts["users_total"] = len(all_users | set(cohort_map))
    complete_roster = (
        len(cohort_map) == TARGET_SYNTHETIC_USERS
        and all(group_counts.get(group, 0) == TARGET_GROUP_SIZE for group in FAVORITE_GROUPS)
        and all(per_user_counts[key]["ratings"] >= 20 and per_user_counts[key]["searches"] >= 5 for key in cohort_map)
    )
    event_counts["synthetic_roster_complete"] = int(complete_roster)
    return latest_ratings, dict(event_counts), max(event_times, default=None)


def _content_vectors(catalog: dict[str, dict[str, Any]]) -> dict[str, dict[str, float]]:
    documents: dict[str, Counter[str]] = {}
    document_frequency: Counter[str] = Counter()
    for show_id, record in catalog.items():
        text = " ".join(str(record.get(field) or "") for field in ("title", "description", "listedIn"))
        counts = Counter(TOKEN_PATTERN.findall(text.lower()))
        documents[show_id] = counts
        document_frequency.update(counts.keys())

    total_documents = len(documents)
    vectors: dict[str, dict[str, float]] = {}
    for show_id, counts in documents.items():
        weights = {
            token: count * (math.log((1 + total_documents) / (1 + document_frequency[token])) + 1.0)
            for token, count in counts.items()
        }
        norm = math.sqrt(math.fsum(value * value for value in weights.values()))
        if norm > 0:
            vectors[show_id] = {token: value / norm for token, value in weights.items()}
    return vectors


def _build_popularity(
    catalog_ids: set[str],
    latest_ratings: dict[str, dict[str, dict[str, Any]]],
    cohort_map: dict[str, str],
) -> dict[str, float]:
    counts: Counter[str] = Counter()
    for user_key in cohort_map:
        for show_id, event in latest_ratings.get(user_key, {}).items():
            if event["rating"] >= Decimal("7") and show_id in catalog_ids:
                counts[show_id] += 1
    maximum = max(counts.values(), default=0)
    if maximum <= 0:
        return {}
    denominator = math.log1p(maximum)
    return {show_id: math.log1p(counts[show_id]) / denominator for show_id in sorted(catalog_ids)}


def prepare_recommendation_artifact(
    *, input_dir: str | Path, catalog_path: str | Path, output_path: str | Path
) -> PrepareResult:
    """Build a deterministic artifact, replacing the old one only after validation."""

    seed_dir, catalog_file, target = Path(input_dir), Path(catalog_path), Path(output_path)
    try:
        export_cutoff, input_hashes = _read_context(seed_dir)
        cohort_rows = _read_csv(seed_dir / "week6_cohort_map.csv", EXPECTED_HEADERS["week6_cohort_map.csv"])
        cohort_map = _load_cohort_map(cohort_rows)
        catalog, catalog_hash = _load_catalog(catalog_file)
        latest_ratings, dataset_counts, latest_event_time = _validated_events(
            seed_dir, set(catalog), cohort_map, export_cutoff
        )
        input_hashes["catalog"] = catalog_hash
        for filename in ("ratings.csv", "watches_for_mining.csv", "searches.csv", "week6_cohort_map.csv"):
            input_hashes[filename.removesuffix(".csv")] = _sha256(seed_dir / filename)

        reference_cutoff = min(
            (latest_event_time or export_cutoff - timedelta(microseconds=1)) + timedelta(microseconds=1),
            export_cutoff,
        )
        artifact = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "model_version": BUILDER_VERSION,
            "seed_status": "ready" if dataset_counts["synthetic_roster_complete"] else "degraded",
            "evidence_status": "demo_only",
            "export_cutoff": export_cutoff.isoformat(),
            "seed_reference_cutoff": reference_cutoff.isoformat(),
            "builder_runtime": "python-standard-library",
            "input_sha256": dict(sorted(input_hashes.items())),
            "dataset_counts": dataset_counts,
            "popularity": _build_popularity(set(catalog), latest_ratings, cohort_map),
            "content_vectors": _content_vectors(catalog),
            "cluster_model": None,
            "tree_model": None,
            "tree_features_by_show": {},
            "disabled_components": {
                "cluster": "not_enabled_without_validated_week5_cluster_artifact",
                "p_like": "not_enabled_without_chronological_holdout",
            },
        }
        invalid_reason = _validate_artifact(artifact)
        if invalid_reason:
            raise PrepareError("generated_artifact_invalid")
        envelope = seal_artifact(artifact)
        encoded = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_ARTIFACT_BYTES:
            raise PrepareError("artifact_size_limit_exceeded")

        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            if target.is_file():
                existing = json.loads(target.read_text(encoding="utf-8"))
                if isinstance(existing, dict) and existing.get("sha256") == envelope["sha256"]:
                    return PrepareResult(artifact["seed_status"], len(encoded), dataset_counts)
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass

        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as output:
                temporary_path = Path(output.name)
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, target)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
        return PrepareResult(artifact["seed_status"], len(encoded), dataset_counts)
    except PrepareError:
        raise
    except OSError as error:
        raise PrepareError("artifact_io_failed") from error
