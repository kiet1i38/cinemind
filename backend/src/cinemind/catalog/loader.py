"""Load and validate the normalized catalog JSON contract."""

from datetime import date, datetime
import json
from pathlib import Path
from typing import Any, Mapping

from cinemind.catalog.models import CatalogIssue, CatalogLoadResult, CatalogRecord


MOVIE = "Movie"
TV_SHOW = "TV Show"
CONTENT_TYPES = frozenset({MOVIE, TV_SHOW})


class CatalogFormatError(ValueError):
    """Raised when the catalog file itself has an invalid top-level shape."""


def load_catalog(path: Path) -> CatalogLoadResult:
    """Read a catalog JSON file and keep valid records with audit issues."""

    payload = _read_payload(path)
    if not isinstance(payload, list):
        raise CatalogFormatError("Catalog JSON must contain an array of records")

    records: list[CatalogRecord] = []
    issues: list[CatalogIssue] = []
    seen_show_ids: set[str] = set()
    for index, raw_record in enumerate(payload):
        try:
            record, record_issues = _parse_record(raw_record)
        except ValueError as error:
            record_key = _record_key(raw_record)
            issues.append(
                CatalogIssue(
                    record_key=record_key,
                    issue_type="invalid_record",
                    severity="error",
                    details={"index": index, "message": str(error)},
                )
            )
            continue

        if record.show_id in seen_show_ids:
            issues.append(
                CatalogIssue(
                    record_key=record.show_id,
                    issue_type="duplicate_show_id",
                    severity="error",
                    details={
                        "index": index,
                        "message": "Duplicate catalog id; later row was skipped",
                    },
                )
            )
            continue

        seen_show_ids.add(record.show_id)
        records.append(record)
        issues.extend(record_issues)

    return CatalogLoadResult(
        records=tuple(records),
        issues=tuple(issues),
        rows_read=len(payload),
    )


def _read_payload(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"Catalog seed file does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise CatalogFormatError(f"Catalog JSON is invalid: {path}") from error


def _parse_record(raw_record: Any) -> tuple[CatalogRecord, tuple[CatalogIssue, ...]]:
    if not isinstance(raw_record, Mapping):
        raise ValueError("record must be an object")

    show_id = _required_text(raw_record.get("id"), "id")
    title = _required_text(raw_record.get("title"), "title")
    content_type = _required_text(raw_record.get("type"), "type")
    if content_type not in CONTENT_TYPES:
        raise ValueError(f"unsupported type: {content_type}")

    release_year = _optional_int(raw_record.get("releaseYear"), "releaseYear")
    runtime_minutes = _positive_int_or_none(
        raw_record.get("runtimeMinutes"), "runtimeMinutes"
    )
    seasons = _positive_int_or_none(raw_record.get("seasons"), "seasons")
    if content_type == MOVIE:
        movie_duration_min = runtime_minutes
        season_count = None
        duration_basis = "movie_minutes" if runtime_minutes is not None else "unknown"
    else:
        movie_duration_min = None
        season_count = seasons
        duration_basis = "tv_seasons" if seasons is not None else "unknown"

    date_added, date_issue = _parse_date(raw_record.get("dateAdded"), show_id)
    poster_url, poster_path, poster_status = _parse_poster(raw_record)
    issues = (date_issue,) if date_issue is not None else ()

    return (
        CatalogRecord(
            show_id=show_id,
            content_type=content_type,
            title=title,
            description=_optional_text(raw_record.get("description")),
            date_added=date_added,
            release_year=release_year,
            content_rating=_optional_text(raw_record.get("rating")),
            movie_duration_min=movie_duration_min,
            season_count=season_count,
            duration_basis=duration_basis,
            poster_provider=_optional_text(raw_record.get("posterProvider")),
            poster_path=poster_path,
            poster_url=poster_url,
            poster_status=poster_status,
            genres=_normalize_list(raw_record.get("listedIn")),
            cast=_normalize_list(raw_record.get("cast")),
            countries=_normalize_list(raw_record.get("country")),
            directors=_normalize_list(raw_record.get("director")),
        ),
        issues,
    )


def _required_text(value: Any, field_name: str) -> str:
    text = _optional_text(value)
    if not text:
        raise ValueError(f"{field_name} is required")
    return text


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any, field_name: str) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be an integer") from error


def _positive_int_or_none(value: Any, field_name: str) -> int | None:
    parsed = _optional_int(value, field_name)
    if parsed is not None and parsed <= 0:
        raise ValueError(f"{field_name} must be positive")
    return parsed


def _normalize_list(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    values = value.split(",") if isinstance(value, str) else value
    if not isinstance(values, (list, tuple, set)):
        return ()

    result: list[str] = []
    for item in values:
        text = _optional_text(item)
        if text and text not in result:
            result.append(text)
    return tuple(result)


def _parse_date(
    value: Any, record_key: str
) -> tuple[date | None, CatalogIssue | None]:
    text = _optional_text(value)
    if not text:
        return None, None

    for date_format in ("%B %d, %Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, date_format).date(), None
        except ValueError:
            continue

    return None, CatalogIssue(
        record_key=record_key,
        issue_type="invalid_date",
        severity="warning",
        details={"field": "dateAdded", "value": text},
    )


def _parse_poster(
    raw_record: Mapping[str, Any]
) -> tuple[str | None, str | None, str]:
    poster_kind = _optional_text(raw_record.get("posterKind"))
    raw_url = _optional_text(raw_record.get("posterUrl"))
    fallback_path = _optional_text(raw_record.get("posterFallbackUrl"))

    is_public_url = bool(
        raw_url
        and raw_url.startswith(("https://", "http://"))
        and poster_kind != "generated"
    )
    poster_url = raw_url if is_public_url else None
    poster_path = fallback_path
    if poster_path is None and raw_url and not is_public_url:
        poster_path = raw_url

    if poster_url:
        return poster_url, poster_path, "available"
    if poster_path:
        return None, poster_path, "fallback"
    return None, None, "unavailable"


def _record_key(raw_record: Any) -> str | None:
    if isinstance(raw_record, Mapping):
        return _optional_text(raw_record.get("id"))
    return None
