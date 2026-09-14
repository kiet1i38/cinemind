"""Shared validation limits for interaction ingestion."""

import json
from collections.abc import Mapping


MAX_SEARCH_QUERY_LENGTH = 200
MAX_FILTER_COUNT = 8
MAX_FILTER_KEY_LENGTH = 32
MAX_FILTER_VALUE_LENGTH = 64
MAX_FILTER_JSON_BYTES = 1024
SEARCH_FILTER_KEYS = frozenset({"type", "genre", "year"})
SEARCH_FILTER_TYPES = frozenset({"all", "Movie", "TV Show"})
SEARCH_FILTER_YEARS = frozenset({"all", "2020s", "2010s", "before2010"})


def normalize_filters(filters: Mapping[str, str] | None) -> dict[str, str]:
    """Validate and normalize a bounded filter object without truncation."""

    if filters is None:
        return {}
    if not isinstance(filters, Mapping):
        raise ValueError("filters must be an object")
    if len(filters) > MAX_FILTER_COUNT:
        raise ValueError(f"filters must contain at most {MAX_FILTER_COUNT} entries")

    normalized: dict[str, str] = {}
    for key, value in filters.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("filter keys must be non-empty strings")
        if not isinstance(value, str):
            raise ValueError("filter values must be strings")
        normalized_key = key.strip()
        normalized_value = value.strip()
        if len(normalized_key) > MAX_FILTER_KEY_LENGTH:
            raise ValueError(
                f"filter keys must be at most {MAX_FILTER_KEY_LENGTH} characters"
            )
        if len(normalized_value) > MAX_FILTER_VALUE_LENGTH:
            raise ValueError(
                f"filter values must be at most {MAX_FILTER_VALUE_LENGTH} characters"
            )
        normalized[normalized_key] = normalized_value

    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_FILTER_JSON_BYTES:
        raise ValueError(
            f"filters must be at most {MAX_FILTER_JSON_BYTES} bytes when encoded"
        )
    return normalized


def normalize_search_filters(filters: Mapping[str, str] | None) -> dict[str, str]:
    """Validate the exact filter contract used by the catalog UI."""

    normalized = normalize_filters(filters)
    unknown = set(normalized) - SEARCH_FILTER_KEYS
    if unknown:
        raise ValueError("search filters contain unsupported keys")

    result = {
        "type": normalized.get("type", "all"),
        "genre": normalized.get("genre", "all"),
        "year": normalized.get("year", "all"),
    }
    if result["type"] not in SEARCH_FILTER_TYPES:
        raise ValueError("type filter is not supported")
    if result["year"] not in SEARCH_FILTER_YEARS:
        raise ValueError("year filter is not supported")
    if not result["genre"]:
        raise ValueError("genre filter must not be blank")
    return result
