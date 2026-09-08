"""Small process-local security primitives shared by HTTP boundaries."""

from collections import deque
from dataclasses import dataclass
import ipaddress
from math import ceil
from threading import Lock
import time


@dataclass(frozen=True)
class RateLimitDecision:
    """Result of checking one sliding-window bucket."""

    allowed: bool
    retry_after_seconds: int = 0


class SlidingWindowRateLimiter:
    """Bounded, thread-safe limiter for one application process.

    A shared gateway should still enforce a distributed limit in a multi-worker
    deployment. This limiter protects the single-process Docker and WSGI
    deployments and keeps the application safe when that outer control is absent.
    """

    def __init__(self, max_attempts: int, window_seconds: int, max_keys: int = 10_000):
        if max_attempts < 1 or window_seconds < 1 or max_keys < 1:
            raise ValueError("Rate limiter settings must be positive")
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._events: dict[str, deque[float]] = {}
        self._lock = Lock()

    def check(self, key: str, now: float | None = None) -> RateLimitDecision:
        """Check a key without consuming a failure slot."""

        timestamp = time.monotonic() if now is None else now
        with self._lock:
            events = self._events.get(key)
            if events is None:
                return RateLimitDecision(allowed=True)
            self._prune(events, timestamp)
            if not events:
                self._events.pop(key, None)
                return RateLimitDecision(allowed=True)
            if len(events) < self.max_attempts:
                return RateLimitDecision(allowed=True)
            retry_after = max(1, ceil(self.window_seconds - (timestamp - events[0])))
            return RateLimitDecision(allowed=False, retry_after_seconds=retry_after)

    def record_failure(self, key: str, now: float | None = None) -> None:
        """Consume one failure slot and keep the bucket collection bounded."""

        timestamp = time.monotonic() if now is None else now
        with self._lock:
            events = self._events.get(key)
            if events is None:
                if len(self._events) >= self.max_keys:
                    self._evict_oldest()
                events = deque()
                self._events[key] = events
            self._prune(events, timestamp)
            events.append(timestamp)

    def record_success(self, key: str) -> None:
        """Reset failures after a successful authentication attempt."""

        with self._lock:
            self._events.pop(key, None)

    def clear(self) -> None:
        """Clear buckets for deterministic tests and controlled maintenance."""

        with self._lock:
            self._events.clear()

    def _evict_oldest(self) -> None:
        oldest_key = min(
            self._events,
            key=lambda candidate: self._events[candidate][-1]
            if self._events[candidate]
            else float("inf"),
        )
        self._events.pop(oldest_key, None)

    def _prune(self, events: deque[float], now: float) -> None:
        cutoff = now - self.window_seconds
        while events and events[0] <= cutoff:
            events.popleft()


def client_address_from_headers(
    direct_address: str | None,
    headers: dict[str, str],
    *,
    trust_proxy_headers: bool,
) -> str:
    """Return a stable, validated client address for request-scoped limits.

    Forwarded headers are attacker-controlled unless the deployment explicitly
    opts in.  Even when enabled, only the first valid address is accepted so a
    malformed header cannot collapse all traffic into one shared bucket.
    """

    if trust_proxy_headers:
        forwarded = headers.get("x-forwarded-for", "")
        for candidate in forwarded.split(","):
            normalized = _normalize_ip(candidate.strip())
            if normalized:
                return normalized

        forwarded_for = _normalize_ip(headers.get("x-real-ip", ""))
        if forwarded_for:
            return forwarded_for

    return _normalize_ip(direct_address or "") or "unknown"


def _normalize_ip(value: str) -> str | None:
    """Normalize IPv4/IPv6 text without accepting arbitrary bucket keys."""

    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None
