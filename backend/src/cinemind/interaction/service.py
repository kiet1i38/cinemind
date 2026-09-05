"""Application services for anonymous session and preference interactions."""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import re
from uuid import UUID, uuid4

from cinemind.config import Settings
from cinemind.interaction.models import WatchMetrics
from cinemind.interaction.repository import InteractionRepository


class InteractionValidationError(ValueError):
    """Raised when an interaction violates an application rule."""


class InteractionNotFoundError(LookupError):
    """Raised when a session or catalog title cannot be found."""


class InteractionService:
    """Coordinate interaction use cases and keep database writes atomic."""

    def __init__(self, repository: InteractionRepository, settings: Settings):
        self.repository = repository
        self.settings = settings

    def create_session(self, locale: str | None, platform: str | None) -> dict:
        now = datetime.now(timezone.utc)
        session_id = uuid4()
        with self.repository.transaction():
            return self.repository.create_session(session_id, now, locale, platform)

    def record_search_event(
        self,
        session_id: UUID,
        query: str,
        result_count: int,
        filters: dict[str, str],
    ) -> dict:
        query_text = self._normalize_text(query, "query")
        normalized_query = self.normalize_query(query_text)
        if result_count < 0:
            raise InteractionValidationError("result_count must be greater than or equal to zero")
        with self.repository.transaction():
            self._require_session(session_id)
            self.repository.touch_session(session_id)
            return self.repository.create_search_event(
                session_id,
                query_text,
                normalized_query,
                result_count,
                filters,
            )

    def record_watch_session(
        self,
        session_id: UUID,
        show_id: str,
        watch_minutes: int,
    ) -> dict:
        watch_session_id = uuid4()
        with self.repository.transaction():
            title, metrics = self._prepare_watch(session_id, show_id, watch_minutes)
            watch_session = self.repository.create_watch_session(
                watch_session_id,
                session_id,
                title["title_id"],
                metrics.watch_seconds,
                metrics.runtime_seconds,
                metrics.completion_rate,
                metrics.duration_basis,
            )
            self.repository.touch_session(session_id)
        return watch_session | {"show_id": title["show_id"]}

    def record_rating(
        self,
        session_id: UUID,
        show_id: str,
        rating: Decimal,
        watch_session_id: UUID | None = None,
    ) -> dict:
        rating_value = self._normalize_rating(rating)
        with self.repository.transaction():
            self._require_session(session_id)
            title = self._require_title(show_id)
            if watch_session_id is not None:
                linked_watch = self.repository.get_watch_session(watch_session_id)
                if linked_watch is None or (
                    linked_watch["session_id"] != session_id
                    or linked_watch["title_id"] != title["title_id"]
                ):
                    raise InteractionValidationError(
                        "watch_session_id must belong to the same session and title"
                    )
            self.repository.touch_session(session_id)
            return self.repository.create_rating(
                session_id,
                title["title_id"],
                rating_value,
                watch_session_id,
            ) | {"show_id": title["show_id"], "rating": rating_value}

    def record_signal(
        self,
        session_id: UUID,
        show_id: str,
        rating: Decimal,
        watch_minutes: int,
    ) -> dict:
        rating_value = self._normalize_rating(rating)
        watch_session_id = uuid4()
        with self.repository.transaction():
            title, metrics = self._prepare_watch(session_id, show_id, watch_minutes)
            watch_session = self.repository.create_watch_session(
                watch_session_id,
                session_id,
                title["title_id"],
                metrics.watch_seconds,
                metrics.runtime_seconds,
                metrics.completion_rate,
                metrics.duration_basis,
            )
            rating_row = self.repository.create_rating(
                session_id,
                title["title_id"],
                rating_value,
                watch_session_id,
            )
            self.repository.touch_session(session_id)
        return {
            "watch_session": watch_session | {"show_id": title["show_id"]},
            "rating": rating_row | {"show_id": title["show_id"], "rating": rating_value},
        }

    def add_preference(self, table_name: str, session_id: UUID, show_id: str) -> dict:
        with self.repository.transaction():
            self._require_session(session_id)
            title = self._require_title(show_id)
            self.repository.touch_session(session_id)
            row = self.repository.add_preference(table_name, session_id, title["title_id"])
        return row | {"show_id": title["show_id"], "active": True}

    def remove_preference(self, table_name: str, session_id: UUID, show_id: str) -> dict:
        with self.repository.transaction():
            self._require_session(session_id)
            title = self._require_title(show_id)
            self.repository.touch_session(session_id)
            row = self.repository.remove_preference(table_name, session_id, title["title_id"])
        changed_at = row["changed_at"] if row else datetime.now(timezone.utc)
        return {
            "session_id": session_id,
            "show_id": title["show_id"],
            "active": False,
            "changed_at": changed_at,
        }

    def get_state(self, session_id: UUID) -> dict:
        self._require_session(session_id)
        state = self.repository.interaction_state(session_id)
        return {
            "session_id": session_id,
            "ratings": tuple(
                {
                    "show_id": row["show_id"],
                    "rating": row["rating"],
                    "watch_minutes": (
                        int(row["watch_seconds"] // 60)
                        if row["watch_seconds"] is not None
                        else None
                    ),
                    "rated_at": row["rated_at"],
                }
                for row in state["ratings"]
            ),
            "favorites": state["favorites"],
            "watchlist_items": state["watchlist_items"],
        }

    def _prepare_watch(self, session_id: UUID, show_id: str, watch_minutes: int) -> tuple[dict, WatchMetrics]:
        if watch_minutes < 0:
            raise InteractionValidationError("watch_minutes must be greater than or equal to zero")
        if watch_minutes > self.settings.max_watch_minutes:
            raise InteractionValidationError(
                f"watch_minutes must be less than or equal to {self.settings.max_watch_minutes}"
            )
        title = self._require_title(show_id)
        self._require_session(session_id)
        runtime_seconds = None
        completion_rate = None
        if title["content_type"] == "Movie" and title["movie_duration_min"]:
            runtime_seconds = int(title["movie_duration_min"]) * 60
            completion_rate = min(
                Decimal(watch_minutes * 60) / Decimal(runtime_seconds),
                Decimal("1"),
            ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
            duration_basis = "movie_minutes"
        elif title["content_type"] == "TV Show":
            duration_basis = "tv_seasons"
        else:
            duration_basis = "unknown"
        return title, WatchMetrics(
            watch_seconds=watch_minutes * 60,
            runtime_seconds=runtime_seconds,
            completion_rate=completion_rate,
            duration_basis=duration_basis,
        )

    def _require_session(self, session_id: UUID) -> dict:
        session = self.repository.get_session(session_id)
        if session is None or session.get("ended_at") is not None:
            raise InteractionNotFoundError(f"Interaction session not found: {session_id}")
        return session

    def _require_title(self, show_id: str) -> dict:
        normalized = self._normalize_text(show_id, "show_id")
        title = self.repository.get_title(normalized)
        if title is None:
            raise InteractionNotFoundError(f"Catalog title not found: {normalized}")
        return title

    @staticmethod
    def normalize_query(value: str) -> str:
        """Normalize a search term without changing its user-visible form."""

        return re.sub(r"\s+", " ", value.casefold()).strip()

    @staticmethod
    def _normalize_text(value: str, field_name: str) -> str:
        normalized = str(value).strip()
        if not normalized:
            raise InteractionValidationError(f"{field_name} must not be blank")
        return normalized

    @staticmethod
    def _normalize_rating(value: Decimal) -> Decimal:
        rating = Decimal(value)
        if rating < 0 or rating > 10:
            raise InteractionValidationError("rating must be between 0 and 10")
        if (rating * 2) != (rating * 2).to_integral_value():
            raise InteractionValidationError("rating must use increments of 0.5")
        return rating.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
