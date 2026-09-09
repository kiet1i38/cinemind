"""Application services for anonymous session and preference interactions."""

from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hmac
import re
from uuid import UUID, uuid4

from cinemind.auth.crypto import hash_session_token, new_session_token
from cinemind.config import Settings
from cinemind.interaction.limits import MAX_SEARCH_QUERY_LENGTH, normalize_filters
from cinemind.interaction.models import WatchMetrics
from cinemind.interaction.repository import InteractionRepository


class InteractionValidationError(ValueError):
    """Raised when an interaction violates an application rule."""


class InteractionConflictError(InteractionValidationError):
    """Raised when a mutation id is replayed with a different payload."""


class InteractionNotFoundError(LookupError):
    """Raised when a session or catalog title cannot be found."""


class InteractionUnauthorizedError(PermissionError):
    """Raised when an account attempts to use another session."""


class InteractionService:
    """Coordinate interaction use cases and keep database writes atomic."""

    def __init__(self, repository: InteractionRepository, settings: Settings):
        self.repository = repository
        self.settings = settings

    def create_session(
        self,
        locale: str | None,
        platform: str | None,
        user_id: UUID | None = None,
    ) -> dict:
        now = datetime.now(timezone.utc)
        session_id = uuid4()
        raw_session_token = new_session_token()
        with self.repository.transaction():
            try:
                created = self.repository.create_session(
                    session_id,
                    now,
                    locale,
                    platform,
                    user_id,
                    hash_session_token(raw_session_token),
                )
            except TypeError:
                # Keep the in-memory service doubles and older integrations
                # usable while deployed databases migrate to session proofs.
                if user_id is None:
                    created = self.repository.create_session(session_id, now, locale, platform)
                else:
                    created = self.repository.create_session(
                        session_id, now, locale, platform, user_id
                    )
        return created | {"session_token": raw_session_token}

    def record_search_event(
        self,
        session_id: UUID,
        query: str,
        result_count: int,
        filters: dict[str, str],
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        query_text = self._normalize_text(query, "query")
        if len(query_text) > MAX_SEARCH_QUERY_LENGTH:
            raise InteractionValidationError(
                f"query must be at most {MAX_SEARCH_QUERY_LENGTH} characters"
            )
        normalized_query = self.normalize_query(query_text)
        if result_count < 0:
            raise InteractionValidationError("result_count must be greater than or equal to zero")
        try:
            normalized_filters = normalize_filters(filters)
        except ValueError as error:
            raise InteractionValidationError(str(error)) from error
        with self.repository.transaction():
            self._require_session(session_id, user_id, session_token)
            self.repository.touch_session(session_id)
            if client_mutation_id is None:
                row = self.repository.create_search_event(
                    session_id,
                    query_text,
                    normalized_query,
                    result_count,
                    normalized_filters,
                )
            else:
                row = self.repository.create_search_event(
                    session_id,
                    query_text,
                    normalized_query,
                    result_count,
                    normalized_filters,
                    client_mutation_id,
                )
                self._require_idempotent_match(
                    row,
                    query_text=query_text,
                    normalized_query=normalized_query,
                    result_count=result_count,
                    filters=normalized_filters,
                )
            return row

    def record_watch_session(
        self,
        session_id: UUID,
        show_id: str,
        watch_minutes: int,
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        watch_session_id = uuid4()
        with self.repository.transaction():
            title, metrics = self._prepare_watch(
                session_id, show_id, watch_minutes, user_id, session_token
            )
            if client_mutation_id is None:
                watch_session = self.repository.create_watch_session(
                    watch_session_id,
                    session_id,
                    title["title_id"],
                    metrics.watch_seconds,
                    metrics.runtime_seconds,
                    metrics.completion_rate,
                    metrics.duration_basis,
                )
            else:
                watch_session = self.repository.create_watch_session(
                    watch_session_id,
                    session_id,
                    title["title_id"],
                    metrics.watch_seconds,
                    metrics.runtime_seconds,
                    metrics.completion_rate,
                    metrics.duration_basis,
                    client_mutation_id,
                )
                self._require_idempotent_match(
                    watch_session,
                    title_id=title["title_id"],
                    watch_seconds=metrics.watch_seconds,
                    runtime_seconds=metrics.runtime_seconds,
                    completion_rate=metrics.completion_rate,
                    duration_basis=metrics.duration_basis,
                )
            self.repository.touch_session(session_id)
        return watch_session | {"show_id": title["show_id"]}

    def record_rating(
        self,
        session_id: UUID,
        show_id: str,
        rating: Decimal,
        watch_session_id: UUID | None = None,
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        rating_value = self._normalize_rating(rating)
        with self.repository.transaction():
            self._require_session(session_id, user_id, session_token)
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
            if client_mutation_id is None:
                row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                )
            else:
                row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_mutation_id,
                )
                self._require_idempotent_match(
                    row,
                    title_id=title["title_id"],
                    rating_value=rating_value,
                    watch_session_id=watch_session_id,
                )
            return row | {"show_id": title["show_id"], "rating": rating_value}

    def record_signal(
        self,
        session_id: UUID,
        show_id: str,
        rating: Decimal,
        watch_minutes: int,
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        rating_value = self._normalize_rating(rating)
        watch_session_id = uuid4()
        with self.repository.transaction():
            title, metrics = self._prepare_watch(
                session_id, show_id, watch_minutes, user_id, session_token
            )
            if client_mutation_id is None:
                watch_session = self.repository.create_watch_session(
                    watch_session_id,
                    session_id,
                    title["title_id"],
                    metrics.watch_seconds,
                    metrics.runtime_seconds,
                    metrics.completion_rate,
                    metrics.duration_basis,
                )
            else:
                watch_session = self.repository.create_watch_session(
                    watch_session_id,
                    session_id,
                    title["title_id"],
                    metrics.watch_seconds,
                    metrics.runtime_seconds,
                    metrics.completion_rate,
                    metrics.duration_basis,
                    client_mutation_id,
                )
                self._require_idempotent_match(
                    watch_session,
                    title_id=title["title_id"],
                    watch_seconds=metrics.watch_seconds,
                    runtime_seconds=metrics.runtime_seconds,
                    completion_rate=metrics.completion_rate,
                    duration_basis=metrics.duration_basis,
                )
            watch_session_id = watch_session["watch_session_id"]
            if client_mutation_id is None:
                rating_row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                )
            else:
                rating_row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_mutation_id,
                )
                self._require_idempotent_match(
                    rating_row,
                    title_id=title["title_id"],
                    rating_value=rating_value,
                    watch_session_id=watch_session_id,
                )
            self.repository.touch_session(session_id)
        return {
            "watch_session": watch_session | {"show_id": title["show_id"]},
            "rating": rating_row | {"show_id": title["show_id"], "rating": rating_value},
        }

    def add_preference(
        self,
        table_name: str,
        session_id: UUID,
        show_id: str,
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        with self.repository.transaction():
            self._require_session(session_id, user_id, session_token)
            title = self._require_title(show_id)
            self.repository.touch_session(session_id)
            if user_id is None and client_mutation_id is None:
                row = self.repository.add_preference(table_name, session_id, title["title_id"])
            else:
                row = self.repository.add_preference(
                    table_name,
                    session_id,
                    title["title_id"],
                    user_id,
                    client_mutation_id,
                )
                self._require_idempotent_match(row, title_id=title["title_id"])
                if row.get("removed_at") is not None:
                    raise InteractionConflictError(
                        "client_mutation_id was already used for a removal"
                    )
        return row | {"show_id": title["show_id"], "active": True}

    def remove_preference(
        self,
        table_name: str,
        session_id: UUID,
        show_id: str,
        user_id: UUID | None = None,
        session_token: str | None = None,
        client_mutation_id: UUID | None = None,
    ) -> dict:
        with self.repository.transaction():
            self._require_session(session_id, user_id, session_token)
            title = self._require_title(show_id)
            self.repository.touch_session(session_id)
            if user_id is None and client_mutation_id is None:
                row = self.repository.remove_preference(table_name, session_id, title["title_id"])
            else:
                row = self.repository.remove_preference(
                    table_name,
                    session_id,
                    title["title_id"],
                    user_id,
                    client_mutation_id,
                )
                if row is not None:
                    self._require_idempotent_match(row, title_id=title["title_id"])
                    if row.get("changed_at") is None:
                        raise InteractionConflictError(
                            "client_mutation_id was already used for an addition"
                        )
        changed_at = row["changed_at"] if row else datetime.now(timezone.utc)
        return {
            "session_id": session_id,
            "show_id": title["show_id"],
            "active": False,
            "changed_at": changed_at,
        }

    def get_state(
        self,
        session_id: UUID,
        user_id: UUID | None = None,
        session_token: str | None = None,
    ) -> dict:
        self._require_session(session_id, user_id, session_token)
        state = self.repository.interaction_state(session_id, user_id)
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

    @staticmethod
    def _require_idempotent_match(row: dict, **expected) -> None:
        """Reject reuse of one mutation id for semantically different input."""

        for field_name, expected_value in expected.items():
            actual_value = row.get(field_name)
            if field_name == "rating_value" and actual_value is None:
                actual_value = row.get("rating")
            if actual_value != expected_value:
                raise InteractionConflictError(
                    "client_mutation_id was already used with a different payload"
                )

    def _prepare_watch(
        self,
        session_id: UUID,
        show_id: str,
        watch_minutes: int,
        user_id: UUID | None = None,
        session_token: str | None = None,
    ) -> tuple[dict, WatchMetrics]:
        if watch_minutes < 0:
            raise InteractionValidationError("watch_minutes must be greater than or equal to zero")
        if watch_minutes > self.settings.max_watch_minutes:
            raise InteractionValidationError(
                f"watch_minutes must be less than or equal to {self.settings.max_watch_minutes}"
            )
        title = self._require_title(show_id)
        self._require_session(session_id, user_id, session_token)
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

    def _require_session(
        self,
        session_id: UUID,
        user_id: UUID | None = None,
        session_token: str | None = None,
    ) -> dict:
        session = self.repository.get_session(session_id)
        if session is None or session.get("ended_at") is not None:
            raise InteractionNotFoundError(f"Interaction session not found: {session_id}")
        session_user_id = session.get("user_id")
        if session_user_id is not None and user_id is None:
            raise InteractionUnauthorizedError("Authentication required")
        if user_id is not None and session_user_id != user_id:
            raise InteractionUnauthorizedError("Interaction session does not belong to this account")
        expected_token_hash = session.get("session_token_hash")
        if expected_token_hash is not None:
            supplied_token = str(session_token or "").strip()
            actual_token_hash = hash_session_token(supplied_token)
            expected_hash = str(expected_token_hash).strip()
            if not hmac.compare_digest(expected_hash, actual_token_hash):
                raise InteractionUnauthorizedError("Interaction session proof is invalid")
        return session

    def _require_title(self, show_id: str) -> dict:
        normalized = self._normalize_text(show_id, "show_id")
        if len(normalized) > 32:
            raise InteractionValidationError("show_id must be at most 32 characters")
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
