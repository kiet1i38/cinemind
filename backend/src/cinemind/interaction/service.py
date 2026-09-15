"""Application services for anonymous sessions and rating interactions."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import hmac
import re
from uuid import UUID, uuid4

from cinemind.auth.crypto import hash_session_token, new_session_token
from cinemind.config import Settings
from cinemind.interaction.limits import MAX_SEARCH_QUERY_LENGTH, normalize_search_filters
from cinemind.interaction.models import WatchMetrics
from cinemind.interaction.repository import InteractionRepository


class InteractionValidationError(ValueError):
    """Raised when an interaction violates an application rule."""


class InteractionConflictError(InteractionValidationError):
    """Raised when a mutation id is replayed with a different payload."""


class InteractionNotFoundError(LookupError):
    """Raised when an interaction resource cannot be found."""

    code = "INTERACTION_NOT_FOUND"


class InteractionSessionNotFoundError(InteractionNotFoundError):
    """Raised when the browser interaction session is missing or expired."""

    code = "SESSION_NOT_FOUND"


class InteractionTitleNotFoundError(InteractionNotFoundError):
    """Raised when a title is missing or no longer active in the catalog."""

    code = "TITLE_NOT_FOUND"


class InteractionUnauthorizedError(PermissionError):
    """Raised when an account attempts to use another session."""


class InteractionService:
    """Coordinate interaction use cases and keep database writes atomic."""

    client_event_clock_skew = timedelta(days=7)

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
        expires_at = now + timedelta(days=self._session_ttl_days())
        session_id = uuid4()
        raw_session_token = new_session_token()
        with self.repository.transaction():
            self._acquire_write_lock()
            created = self.repository.create_session(
                session_id,
                now,
                expires_at,
                locale,
                platform,
                user_id,
                hash_session_token(raw_session_token),
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
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        client_event_time = self._normalize_client_occurred_at(client_occurred_at)
        client_device_id, client_event_sequence = self._normalize_client_event_metadata(
            client_device_id, client_event_sequence
        )
        query_text = self._normalize_text(query, "query")
        if len(query_text) > MAX_SEARCH_QUERY_LENGTH:
            raise InteractionValidationError(
                f"query must be at most {MAX_SEARCH_QUERY_LENGTH} characters"
            )
        normalized_query = self.normalize_query(query_text)
        if result_count < 0:
            raise InteractionValidationError("result_count must be greater than or equal to zero")
        try:
            normalized_filters = normalize_search_filters(filters)
        except ValueError as error:
            raise InteractionValidationError(str(error)) from error
        with self.repository.transaction():
            self._acquire_write_lock()
            self._require_session(session_id, user_id, session_token)
            if client_mutation_id is not None:
                existing = self.repository.get_search_event_by_mutation(client_mutation_id)
                if existing is not None:
                    self._require_existing_mutation_owner(existing, session_id, user_id)
                    self._require_idempotent_match(
                        existing,
                        query_text=query_text,
                        normalized_query=normalized_query,
                        filters=normalized_filters,
                        client_device_id=client_device_id,
                        client_event_sequence=client_event_sequence,
                    )
                    self._touch_session(session_id)
                    return existing
            self._touch_session(session_id)
            if (
                normalized_filters["genre"] != "all"
                and not self.repository.catalog_genre_exists(normalized_filters["genre"])
            ):
                raise InteractionValidationError("genre filter is not available")
            authoritative_result_count = self.repository.count_catalog_results(
                normalized_query, normalized_filters
            )
            if client_mutation_id is None:
                row = self.repository.create_search_event(
                    session_id,
                    query_text,
                    normalized_query,
                    authoritative_result_count,
                    normalized_filters,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            else:
                row = self.repository.create_search_event(
                    session_id,
                    query_text,
                    normalized_query,
                    authoritative_result_count,
                    normalized_filters,
                    client_mutation_id,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
                self._require_existing_mutation_owner(row, session_id, user_id)
                self._require_idempotent_match(
                    row,
                    query_text=query_text,
                    normalized_query=normalized_query,
                    filters=normalized_filters,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
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
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        client_event_time = self._normalize_client_occurred_at(client_occurred_at)
        client_device_id, client_event_sequence = self._normalize_client_event_metadata(
            client_device_id, client_event_sequence
        )
        watch_session_id = uuid4()
        normalized_show_id = self._normalize_show_id(show_id)
        self._validate_watch_minutes(watch_minutes)
        with self.repository.transaction():
            self._acquire_write_lock()
            self._require_session(session_id, user_id, session_token)
            if client_mutation_id is not None:
                existing = self.repository.get_watch_session_by_mutation(client_mutation_id)
                if existing is not None:
                    self._require_existing_mutation_owner(existing, session_id, user_id)
                    self._require_idempotent_match(
                        existing,
                        show_id=normalized_show_id,
                        watch_seconds=watch_minutes * 60,
                        client_device_id=client_device_id,
                        client_event_sequence=client_event_sequence,
                    )
                    self._touch_session(session_id)
                    return existing | {"show_id": existing.get("show_id") or normalized_show_id}
            title, metrics = self._prepare_watch(
                session_id, normalized_show_id, watch_minutes, user_id, session_token
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
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
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
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
                self._require_existing_mutation_owner(watch_session, session_id, user_id)
                self._require_idempotent_match(
                    watch_session,
                    title_id=title["title_id"],
                    watch_seconds=metrics.watch_seconds,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            self._touch_session(session_id)
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
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        client_event_time = self._normalize_client_occurred_at(client_occurred_at)
        client_device_id, client_event_sequence = self._normalize_client_event_metadata(
            client_device_id, client_event_sequence
        )
        rating_value = self._normalize_rating(rating)
        normalized_show_id = self._normalize_show_id(show_id)
        with self.repository.transaction():
            self._acquire_write_lock()
            self._require_session(session_id, user_id, session_token)
            if client_mutation_id is not None:
                existing = self.repository.get_rating_by_mutation(client_mutation_id)
                if existing is not None:
                    self._require_existing_mutation_owner(existing, session_id, user_id)
                    self._require_idempotent_match(
                        existing,
                        show_id=normalized_show_id,
                        rating_value=rating_value,
                        watch_session_id=watch_session_id,
                        client_device_id=client_device_id,
                        client_event_sequence=client_event_sequence,
                    )
                    self._touch_session(session_id)
                    return existing | {
                        "show_id": existing.get("show_id") or normalized_show_id,
                        "rating": rating_value,
                    }
            title = self._require_title(normalized_show_id)
            if watch_session_id is not None:
                linked_watch = self.repository.get_watch_session(watch_session_id)
                if linked_watch is None or (
                    linked_watch["session_id"] != session_id
                    or linked_watch["title_id"] != title["title_id"]
                ):
                    raise InteractionValidationError(
                        "watch_session_id must belong to the same session and title"
                    )
            self._touch_session(session_id)
            if client_mutation_id is None:
                row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            else:
                row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_mutation_id,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
                self._require_existing_mutation_owner(row, session_id, user_id)
                self._require_idempotent_match(
                    row,
                    title_id=title["title_id"],
                    rating_value=rating_value,
                    watch_session_id=watch_session_id,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
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
        client_occurred_at: datetime | None = None,
        client_device_id: UUID | None = None,
        client_event_sequence: int | None = None,
    ) -> dict:
        client_event_time = self._normalize_client_occurred_at(client_occurred_at)
        client_device_id, client_event_sequence = self._normalize_client_event_metadata(
            client_device_id, client_event_sequence
        )
        rating_value = self._normalize_rating(rating)
        watch_session_id = uuid4()
        normalized_show_id = self._normalize_show_id(show_id)
        self._validate_watch_minutes(watch_minutes)
        with self.repository.transaction():
            self._acquire_write_lock()
            self._require_session(session_id, user_id, session_token)
            if client_mutation_id is not None:
                existing_watch = self.repository.get_watch_session_by_mutation(client_mutation_id)
                existing_rating = self.repository.get_rating_by_mutation(client_mutation_id)
                if existing_watch is not None:
                    self._require_existing_mutation_owner(existing_watch, session_id, user_id)
                    self._require_idempotent_match(
                        existing_watch,
                        show_id=normalized_show_id,
                        watch_seconds=watch_minutes * 60,
                        client_device_id=client_device_id,
                        client_event_sequence=client_event_sequence,
                    )
                    if existing_rating is not None:
                        self._require_existing_mutation_owner(existing_rating, session_id, user_id)
                        self._require_idempotent_match(
                            existing_rating,
                            show_id=normalized_show_id,
                            rating_value=rating_value,
                            watch_session_id=existing_watch["watch_session_id"],
                            client_device_id=client_device_id,
                            client_event_sequence=client_event_sequence,
                        )
                        rating_row = existing_rating
                    else:
                        # A historical partial write can contain the watch
                        # row without its paired rating. Complete that pair
                        # using the retained title id without consulting the
                        # current active catalog.
                        rating_row = self.repository.create_rating(
                            existing_watch["session_id"],
                            existing_watch["title_id"],
                            rating_value,
                            existing_watch["watch_session_id"],
                            client_mutation_id,
                            client_occurred_at=client_event_time,
                            client_device_id=client_device_id,
                            client_event_sequence=client_event_sequence,
                        )
                        self._require_existing_mutation_owner(rating_row, session_id, user_id)
                        self._require_idempotent_match(
                            rating_row,
                            show_id=normalized_show_id,
                            rating_value=rating_value,
                            watch_session_id=existing_watch["watch_session_id"],
                            client_device_id=client_device_id,
                            client_event_sequence=client_event_sequence,
                        )
                    self._touch_session(session_id)
                    response_show_id = existing_watch.get("show_id") or normalized_show_id
                    return {
                        "watch_session": existing_watch | {"show_id": response_show_id},
                        "rating": rating_row | {
                            "show_id": response_show_id,
                            "rating": rating_value,
                        },
                    }
                elif existing_rating is not None:
                    # A partial historical write may contain only the rating.
                    # It still belongs to the original account and must not be
                    # used as an oracle or completed by another account.
                    self._require_existing_mutation_owner(existing_rating, session_id, user_id)
            title, metrics = self._prepare_watch(
                session_id, normalized_show_id, watch_minutes, user_id, session_token
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
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
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
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
                self._require_existing_mutation_owner(watch_session, session_id, user_id)
                self._require_idempotent_match(
                    watch_session,
                    title_id=title["title_id"],
                    watch_seconds=metrics.watch_seconds,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            watch_session_id = watch_session["watch_session_id"]
            if client_mutation_id is None:
                rating_row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            else:
                rating_row = self.repository.create_rating(
                    session_id,
                    title["title_id"],
                    rating_value,
                    watch_session_id,
                    client_mutation_id,
                    client_occurred_at=client_event_time,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
                self._require_existing_mutation_owner(rating_row, session_id, user_id)
                self._require_idempotent_match(
                    rating_row,
                    title_id=title["title_id"],
                    rating_value=rating_value,
                    watch_session_id=watch_session_id,
                    client_device_id=client_device_id,
                    client_event_sequence=client_event_sequence,
                )
            self._touch_session(session_id)
        return {
            "watch_session": watch_session | {"show_id": title["show_id"]},
            "rating": rating_row | {"show_id": title["show_id"], "rating": rating_value},
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
                    # The projection already resolves same-device retries by
                    # client sequence and cross-device conflicts by server
                    # receipt order. Expose that resolved server time to the
                    # UI so recommendations do not re-interpret a raw client
                    # clock differently from the backend.
                    "event_at": row.get("event_at") or row["rated_at"],
                    "client_occurred_at": row.get("client_occurred_at"),
                    "client_device_id": row.get("client_device_id"),
                    "client_event_sequence": row.get("client_event_sequence"),
                }
                for row in state["ratings"]
            ),
        }

    @staticmethod
    def _require_idempotent_match(row: dict, **expected) -> None:
        """Reject reuse of one mutation id for a different client intent.

        Callers deliberately pass only fields supplied by the client (plus
        stable normalized intent). Catalog-derived metrics such as search
        counts and movie runtime can legitimately change between the original
        commit and a delayed retry, so they must never turn an acknowledged
        mutation into a conflict.
        """

        for field_name, expected_value in expected.items():
            actual_value = row.get(field_name)
            if field_name == "rating_value" and actual_value is None:
                actual_value = row.get("rating")
            if field_name == "client_occurred_at":
                # This is observational metadata, not client intent. A retry
                # can arrive outside the clock-skew window even though the
                # original mutation was accepted, so never make it part of
                # the idempotency conflict key.
                continue
            if field_name in {"client_device_id", "client_event_sequence"} and actual_value is None:
                # Metadata was introduced after the first event-log release;
                # a replay must remain idempotent for legacy rows.
                continue
            if actual_value != expected_value:
                raise InteractionConflictError(
                    "client_mutation_id was already used with a different payload"
                )

    def _require_existing_mutation_owner(
        self,
        existing: dict,
        current_session_id: UUID,
        current_user_id: UUID | None,
    ) -> None:
        """Keep global idempotency lookups inside the current account boundary.

        Mutation ids are retry identifiers, not authorization credentials. An
        authenticated request may replay an event from a rotated interaction
        session only when that original session is owned by the same account.
        Anonymous rotation retains the historical global-idempotency behavior;
        protected routes always supply ``current_user_id``.
        """

        if current_user_id is None:
            return
        existing_session_id = existing.get("session_id")
        if existing_session_id is None:
            raise InteractionUnauthorizedError("Interaction mutation ownership cannot be verified")
        if str(existing_session_id).casefold() == str(current_session_id).casefold():
            return
        original_session = self.repository.get_session(existing_session_id)
        if (
            original_session is None
            or original_session.get("user_id") is None
            or str(original_session.get("user_id")).casefold() != str(current_user_id).casefold()
        ):
            raise InteractionUnauthorizedError("Interaction mutation does not belong to this account")

    def _prepare_watch(
        self,
        session_id: UUID,
        show_id: str,
        watch_minutes: int,
        user_id: UUID | None = None,
        session_token: str | None = None,
    ) -> tuple[dict, WatchMetrics]:
        self._validate_watch_minutes(watch_minutes)
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

    def _validate_watch_minutes(self, watch_minutes: int) -> None:
        if not isinstance(watch_minutes, int) or isinstance(watch_minutes, bool):
            raise InteractionValidationError("watch_minutes must be an integer")
        if watch_minutes < 0:
            raise InteractionValidationError("watch_minutes must be greater than or equal to zero")
        if watch_minutes > self.settings.max_watch_minutes:
            raise InteractionValidationError(
                f"watch_minutes must be less than or equal to {self.settings.max_watch_minutes}"
            )

    def _require_session(
        self,
        session_id: UUID,
        user_id: UUID | None = None,
        session_token: str | None = None,
    ) -> dict:
        session = self.repository.get_session(session_id)
        if session is None or session.get("ended_at") is not None:
            raise InteractionSessionNotFoundError(f"Interaction session not found: {session_id}")
        expires_at = session.get("expires_at")
        if expires_at is not None and expires_at <= datetime.now(timezone.utc):
            raise InteractionSessionNotFoundError(f"Interaction session expired: {session_id}")
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
        normalized = self._normalize_show_id(show_id)
        title = self.repository.get_title(normalized)
        if title is None:
            raise InteractionTitleNotFoundError(f"Catalog title not found: {normalized}")
        return title

    @classmethod
    def _normalize_show_id(cls, show_id: str) -> str:
        normalized = cls._normalize_text(show_id, "show_id")
        if len(normalized) > 32:
            raise InteractionValidationError("show_id must be at most 32 characters")
        return normalized

    def _acquire_write_lock(self) -> None:
        lock = getattr(self.repository, "acquire_write_lock", None)
        if lock is not None:
            lock()

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
    def _normalize_client_event_metadata(
        device_id: UUID | None,
        sequence: int | None,
    ) -> tuple[UUID | None, int | None]:
        if device_id is None and sequence is None:
            return None, None
        if device_id is None or sequence is None or int(sequence) < 1:
            raise InteractionValidationError(
                "client_device_id and client_event_sequence must be provided together"
            )
        return device_id, int(sequence)

    @staticmethod
    def _normalize_rating(value: Decimal) -> Decimal:
        rating = Decimal(value)
        if not rating.is_finite() or rating < Decimal("0.5") or rating > 10:
            raise InteractionValidationError("rating must be between 0.5 and 10")
        if (rating * 2) != (rating * 2).to_integral_value():
            raise InteractionValidationError("rating must use increments of 0.5")
        return rating.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)

    def _touch_session(self, session_id: UUID) -> None:
        try:
            self.repository.touch_session(session_id)
        except LookupError as error:
            raise InteractionSessionNotFoundError(f"Interaction session expired: {session_id}") from error

    @classmethod
    def _normalize_client_occurred_at(cls, value: datetime | None) -> datetime | None:
        """Keep a bounded, timezone-aware browser timestamp for mining.

        The server's receipt columns remain authoritative. A client clock can
        be wrong or malicious, so timestamps outside the seven-day tolerance
        are discarded rather than allowed to reorder server state.
        """

        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise InteractionValidationError("client_occurred_at must include a timezone")
        normalized = value.astimezone(timezone.utc)
        now = datetime.now(timezone.utc)
        if abs(now - normalized) > cls.client_event_clock_skew:
            return None
        return normalized

    def _session_ttl_days(self) -> int:
        value = int(getattr(self.settings, "interaction_session_ttl_days", 30))
        if value < 1 or value > 365:
            raise InteractionValidationError("Interaction session lifetime must be between 1 and 365 days")
        return value
