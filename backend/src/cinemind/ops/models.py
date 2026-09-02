"""Domain models for the operational schema."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID


@dataclass(frozen=True)
class DatasetSource:
    """A registered external or application-generated data source."""

    source_id: UUID
    source_name: str
    source_type: str
    source_uri: str
    schema_version: str
    collected_at: datetime
    checksum_sha256: str


@dataclass(frozen=True)
class DataQualityIssue:
    """A quality issue found while loading a source."""

    table_name: str
    record_key: str | None
    issue_type: str
    severity: str
    details: dict[str, Any]
