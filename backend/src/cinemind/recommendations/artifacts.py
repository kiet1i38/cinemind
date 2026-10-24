"""Versioned, checksummed recommendation artifact loading."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)
ARTIFACT_SCHEMA_VERSION = 1
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_IDENTITY_KEYS = frozenset({"email", "username", "password", "user_id", "user_key", "user_keys"})


@dataclass(frozen=True)
class ArtifactSnapshot:
    artifact: dict[str, Any] | None
    status: str
    reason: str | None = None


def _canonical_artifact(artifact: dict[str, Any]) -> bytes:
    return json.dumps(
        artifact,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def seal_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    """Wrap a data-mining artifact with a stable integrity checksum."""

    digest = hashlib.sha256(_canonical_artifact(artifact)).hexdigest()
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "sha256": digest,
        "artifact": artifact,
    }


def _contains_identity_key(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            str(key).strip().lower() in _IDENTITY_KEYS or _contains_identity_key(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_identity_key(item) for item in value)
    return False


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, TypeError, ValueError):
        return False


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_tree_model(tree_model: Any) -> str | None:
    if tree_model is None:
        return None
    if not isinstance(tree_model, dict):
        return "tree_model must be an object or null"
    if tree_model.get("status") != "ready":
        return None
    features = tree_model.get("features")
    if not isinstance(features, list) or not features or any(not isinstance(name, str) for name in features):
        return "tree_model features must be a non-empty list of strings"
    classes = tree_model.get("classes")
    if (
        not isinstance(classes, list)
        or not classes
        or any(not isinstance(label, str) for label in classes)
        or len(set(classes)) != len(classes)
        or "liked" not in classes
    ):
        return "tree_model classes must be unique strings including 'liked'"
    indicator_count = tree_model.get("missing_indicator_count", 0)
    if not _is_int(indicator_count) or indicator_count < 0:
        return "tree_model missing_indicator_count must be a non-negative integer"
    medians = tree_model.get("medians")
    if (
        not isinstance(medians, list)
        or len(medians) != len(features)
        or any(not _is_finite_number(value) for value in medians)
    ):
        return "tree_model medians must be finite numbers aligned with features"
    return _validate_tree_nodes(tree_model.get("nodes"), features, classes)


def _validate_tree_nodes(nodes: Any, features: list[str], classes: list[str]) -> str | None:
    if not isinstance(nodes, list) or not nodes or any(not isinstance(node, dict) for node in nodes):
        return "tree_model nodes must be a non-empty list of objects"
    for node in nodes:
        feature = node.get("feature")
        if not _is_int(feature):
            return "tree_model node feature must be an integer"
        if feature < 0:
            error = _validate_tree_leaf(node, classes)
        else:
            error = _validate_internal_tree_node(node, feature, len(features), len(nodes))
        if error:
            return error
    return None


def _validate_tree_leaf(node: dict[str, Any], classes: list[str]) -> str | None:
    values = node.get("values")
    if (
        not isinstance(values, list)
        or len(values) != len(classes)
        or any(not _is_finite_number(value) or float(value) < 0 for value in values)
        or sum(float(value) for value in values) <= 0
    ):
        return "tree_model leaf values must be finite non-negative counts with a positive total"
    return None


def _validate_internal_tree_node(
    node: dict[str, Any], feature: int, feature_count: int, node_count: int
) -> str | None:
    # A non-leaf node must branch on a real feature; feature < 0 marks a leaf.
    if feature >= feature_count:
        return "tree_model node feature index is out of range"
    if not _is_finite_number(node.get("threshold")):
        return "tree_model node threshold must be a finite number"
    for branch in ("left", "right"):
        child = node.get(branch)
        if not _is_int(child) or child < 0 or child >= node_count:
            return "tree_model node children must be integer indices into nodes"
    return None


def _validate_tree_feature_rows(tree_model: Any, tree_features_by_show: dict[str, Any]) -> str | None:
    if not isinstance(tree_model, dict) or tree_model.get("status") != "ready":
        return None
    features = tree_model.get("features")
    indicator_count = tree_model.get("missing_indicator_count", 0)
    expected_width = len(features) - indicator_count
    for row in tree_features_by_show.values():
        if not isinstance(row, list) or len(row) != expected_width:
            return "tree_features_by_show rows must align with the tree model feature width"
        if any(value is not None and not _is_finite_number(value) for value in row):
            return "tree_features_by_show rows must contain finite numbers or null"
    return None


def _validate_artifact(artifact: Any) -> str | None:
    if not isinstance(artifact, dict):
        return "artifact payload must be an object"
    if artifact.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        return "unsupported artifact schema"
    # Sparse content-vector keys are catalog vocabulary tokens, not payload
    # field names; a title description can legitimately contain "email" or
    # another word that overlaps the identity denylist.
    identity_payload = {
        key: value for key, value in artifact.items() if key != "content_vectors"
    }
    if _contains_identity_key(identity_payload):
        return "artifact contains prohibited identity fields"
    for field in ("popularity", "content_vectors", "tree_features_by_show"):
        value = artifact.get(field, {})
        if not isinstance(value, dict):
            return f"{field} must be an object"
    popularity = artifact.get("popularity", {})
    if any(not isinstance(key, str) or not _is_finite_number(value) for key, value in popularity.items()):
        return "popularity scores must be finite numeric values keyed by title"
    vectors = artifact.get("content_vectors", {})
    if len(vectors) > 100_000:
        return "content vector title limit exceeded"
    for show_id, vector in vectors.items():
        if not isinstance(show_id, str) or not isinstance(vector, dict):
            return "content vectors must map title IDs to sparse objects"
        if any(not isinstance(token, str) or not _is_finite_number(weight) for token, weight in vector.items()):
            return "content vectors must contain finite numeric weights"
    cluster_model = artifact.get("cluster_model")
    if cluster_model is not None and not isinstance(cluster_model, dict):
        return "cluster_model must be an object or null"
    tree_error = _validate_tree_model(artifact.get("tree_model"))
    if tree_error:
        return tree_error
    row_error = _validate_tree_feature_rows(
        artifact.get("tree_model"), artifact.get("tree_features_by_show", {})
    )
    if row_error:
        return row_error
    if not isinstance(artifact.get("model_version", ""), str):
        return "model_version must be a string"
    return None


class RecommendationArtifactStore:
    """Load immutable JSON artifacts and cache them by file metadata."""

    def __init__(self, path: str | Path | None = None):
        configured_path = path or os.environ.get(
            "CINEMIND_RECOMMENDATION_ARTIFACT_PATH",
            "/app/data/week6/recommendation_artifact.json",
        )
        self.path = Path(configured_path)
        self._cached_signature: tuple[int, int] | str | None = None
        self._cached_snapshot: ArtifactSnapshot | None = None

    def load(self) -> ArtifactSnapshot:
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return self._cache("missing", ArtifactSnapshot(None, "missing", "artifact not built"))
        except OSError:
            logger.warning("Recommendation artifact cannot be inspected")
            return ArtifactSnapshot(None, "unavailable", "artifact cannot be inspected")

        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._cached_signature and self._cached_snapshot is not None:
            return self._cached_snapshot
        if stat.st_size > MAX_ARTIFACT_BYTES:
            return self._cache(signature, ArtifactSnapshot(None, "invalid", "artifact exceeds size limit"))

        try:
            envelope = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(envelope, dict) or envelope.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
                raise ValueError("unsupported envelope schema")
            artifact = envelope.get("artifact")
            if not isinstance(artifact, dict):
                raise ValueError("missing artifact payload")
            expected = envelope.get("sha256")
            actual = hashlib.sha256(_canonical_artifact(artifact)).hexdigest()
            if not isinstance(expected, str) or not hmac.compare_digest(expected, actual):
                raise ValueError("artifact checksum mismatch")
            invalid_reason = _validate_artifact(artifact)
            if invalid_reason:
                raise ValueError(invalid_reason)
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as error:
            logger.warning("Recommendation artifact is invalid: %s", error)
            return self._cache(signature, ArtifactSnapshot(None, "invalid", str(error)))

        status = "ready" if artifact.get("seed_status") == "ready" else "degraded"
        return self._cache(signature, ArtifactSnapshot(artifact, status))

    def _cache(self, signature: tuple[int, int] | str, snapshot: ArtifactSnapshot) -> ArtifactSnapshot:
        self._cached_signature = signature
        self._cached_snapshot = snapshot
        return snapshot
