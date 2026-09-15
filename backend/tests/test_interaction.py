"""Unit and HTTP-contract tests for the interaction milestone."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import copy
from types import SimpleNamespace
from uuid import uuid4
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from cinemind.interaction.schemas import RatingCreateRequest, SearchEventCreateRequest, SessionCreateRequest, SignalCreateRequest
from cinemind.interaction.service import (
    InteractionConflictError,
    InteractionNotFoundError,
    InteractionService,
    InteractionValidationError,
    InteractionUnauthorizedError,
)


class FakeTransaction:
    """Small transaction spy that makes rollback behavior observable."""

    def __init__(self, repository):
        self.repository = repository

    def __enter__(self):
        self.repository.transactions_started += 1
        self.snapshot = (
            copy.deepcopy(self.repository.search_events),
            copy.deepcopy(self.repository.watch_sessions),
            copy.deepcopy(self.repository.ratings),
            copy.deepcopy(self.repository.watch_mutations),
            copy.deepcopy(self.repository.rating_mutations),
            copy.deepcopy(self.repository.search_mutations),
        )
        return self

    def __exit__(self, error_type, _error, _traceback):
        if error_type:
            self.repository.transactions_rolled_back += 1
            (
                self.repository.search_events,
                self.repository.watch_sessions,
                self.repository.ratings,
                self.repository.watch_mutations,
                self.repository.rating_mutations,
                self.repository.search_mutations,
            ) = self.snapshot
        else:
            self.repository.transactions_committed += 1
        return False


class FakeInteractionRepository:
    """In-memory repository for service tests; no PostgreSQL is required."""

    def __init__(self):
        self.sessions = {}
        self.titles = {
            "movie-1": {
                "title_id": 1,
                "show_id": "movie-1",
                "content_type": "Movie",
                "movie_duration_min": 120,
                "season_count": None,
            },
            "show-1": {
                "title_id": 2,
                "show_id": "show-1",
                "content_type": "TV Show",
                "movie_duration_min": None,
                "season_count": 3,
            },
        }
        self.watch_sessions = {}
        self.search_events = []
        self.ratings = []
        self.transactions_started = 0
        self.transactions_committed = 0
        self.transactions_rolled_back = 0
        self.fail_rating = False
        self.watch_mutations = {}
        self.rating_mutations = {}
        self.search_mutations = {}
        self.search_result_count = 17

    def transaction(self):
        return FakeTransaction(self)

    def acquire_write_lock(self):
        return None

    def create_session(self, session_id, started_at, expires_at, locale, platform, user_id=None, session_token_hash=None):
        row = {
            "session_id": session_id,
            "started_at": started_at,
            "last_seen_at": started_at,
            "expires_at": expires_at,
        }
        self.sessions[session_id] = {
            **row,
            "ended_at": None,
            "locale": locale,
            "platform": platform,
            "user_id": user_id,
            "session_token_hash": session_token_hash,
        }
        return row

    def get_session(self, session_id):
        return self.sessions.get(session_id)

    def touch_session(self, session_id):
        if session_id not in self.sessions:
            raise LookupError(session_id)
        self.sessions[session_id]["last_seen_at"] = datetime.now(timezone.utc)

    def get_title(self, show_id):
        return self.titles.get(show_id)

    def count_catalog_results(self, _normalized_query, _filters):
        return self.search_result_count

    def catalog_genre_exists(self, _genre):
        return True

    def create_search_event(self, session_id, query_text, normalized_query, result_count, filters, client_mutation_id=None, client_occurred_at=None, client_device_id=None, client_event_sequence=None):
        if client_mutation_id is not None and client_mutation_id in self.search_mutations:
            return self.search_mutations[client_mutation_id]
        row = {
            "search_event_id": len(self.search_events) + 1,
            "session_id": session_id,
            "query_text": query_text,
            "normalized_query": normalized_query,
            "result_count": result_count,
            "filters": filters,
            "client_mutation_id": client_mutation_id,
            "occurred_at": datetime.now(timezone.utc),
            "client_occurred_at": client_occurred_at,
            "client_device_id": client_device_id,
            "client_event_sequence": client_event_sequence,
        }
        self.search_events.append(row)
        if client_mutation_id is not None:
            self.search_mutations[client_mutation_id] = row
        return row

    def get_search_event_by_mutation(self, client_mutation_id):
        return self.search_mutations.get(client_mutation_id)

    def create_watch_session(self, watch_session_id, session_id, title_id, watch_seconds, runtime_seconds, completion_rate, duration_basis, client_mutation_id=None, client_occurred_at=None, client_device_id=None, client_event_sequence=None):
        mutation_key = client_mutation_id
        if client_mutation_id is not None and mutation_key in self.watch_mutations:
            return self.watch_mutations[mutation_key]
        row = {
            "watch_session_id": watch_session_id,
            "session_id": session_id,
            "title_id": title_id,
            "show_id": next(
                title["show_id"]
                for title in self.titles.values()
                if title["title_id"] == title_id
            ),
            "watch_seconds": watch_seconds,
            "runtime_seconds": runtime_seconds,
            "completion_rate": completion_rate,
            "duration_basis": duration_basis,
            "recorded_at": datetime.now(timezone.utc),
            "client_occurred_at": client_occurred_at,
            "client_device_id": client_device_id,
            "client_event_sequence": client_event_sequence,
        }
        self.watch_sessions[watch_session_id] = row
        if client_mutation_id is not None:
            self.watch_mutations[mutation_key] = row
        return row

    def get_watch_session_by_mutation(self, client_mutation_id):
        return self.watch_mutations.get(client_mutation_id)

    def get_watch_session(self, watch_session_id):
        return self.watch_sessions.get(watch_session_id)

    def get_rating_by_mutation(self, client_mutation_id):
        return self.rating_mutations.get(client_mutation_id)

    def create_rating(self, session_id, title_id, rating, watch_session_id, client_mutation_id=None, client_occurred_at=None, client_device_id=None, client_event_sequence=None):
        if self.fail_rating:
            raise RuntimeError("simulated rating failure")
        mutation_key = client_mutation_id
        if client_mutation_id is not None and mutation_key in self.rating_mutations:
            return self.rating_mutations[mutation_key]
        row = {
            "rating_id": len(self.ratings) + 1,
            "session_id": session_id,
            "title_id": title_id,
            "show_id": next(
                title["show_id"]
                for title in self.titles.values()
                if title["title_id"] == title_id
            ),
            "rating": rating,
            "rating_value": rating,
            "watch_session_id": watch_session_id,
            "watch_seconds": (
                self.watch_sessions[watch_session_id]["watch_seconds"]
                if watch_session_id is not None
                else None
            ),
            "rated_at": datetime.now(timezone.utc),
            "client_occurred_at": client_occurred_at,
            "client_device_id": client_device_id,
            "client_event_sequence": client_event_sequence,
            "client_mutation_id": client_mutation_id,
        }
        self.ratings.append(row)
        if client_mutation_id is not None:
            self.rating_mutations[mutation_key] = row
        return row

    def interaction_state(self, session_id, _user_id=None):
        latest_by_device = {}
        for row in self.ratings:
            if row["session_id"] != session_id:
                continue
            device_key = (row["title_id"], row.get("client_device_id") or row["session_id"])
            sort_key = (
                row.get("client_event_sequence") or 0,
                row["rated_at"],
                row["rating_id"],
            )
            current = latest_by_device.get(device_key)
            if current is None or sort_key > current[0]:
                latest_by_device[device_key] = (sort_key, row)
        latest_by_title = {}
        for _sort_key, row in latest_by_device.values():
            current = latest_by_title.get(row["title_id"])
            server_sort_key = (row["rated_at"], row["rating_id"])
            if current is None or server_sort_key > current[0]:
                latest_by_title[row["title_id"]] = (server_sort_key, row)
        return {
            "ratings": tuple(
                row
                for _sort_key, row in sorted(
                    latest_by_title.values(), key=lambda item: item[1]["title_id"]
                )
            )
        }


class InteractionServiceTests(unittest.TestCase):
    """Protect normalization, duration semantics, ownership, and atomicity."""

    def setUp(self):
        self.repository = FakeInteractionRepository()
        self.session_id = uuid4()
        now = datetime.now(timezone.utc)
        self.repository.sessions[self.session_id] = {
            "session_id": self.session_id,
            "started_at": now,
            "last_seen_at": now,
            "ended_at": None,
        }
        self.service = InteractionService(
            self.repository,
            SimpleNamespace(max_watch_minutes=10080),
        )

    def _add_account_session(self, user_id):
        session_id = uuid4()
        now = datetime.now(timezone.utc)
        self.repository.sessions[session_id] = {
            "session_id": session_id,
            "started_at": now,
            "last_seen_at": now,
            "ended_at": None,
            "user_id": user_id,
            "session_token_hash": None,
        }
        return session_id

    def _add_anonymous_session(self):
        session_id = uuid4()
        now = datetime.now(timezone.utc)
        self.repository.sessions[session_id] = {
            "session_id": session_id,
            "started_at": now,
            "last_seen_at": now,
            "ended_at": None,
            "user_id": None,
            "session_token_hash": None,
        }
        return session_id

    def test_search_normalizes_whitespace_and_case(self):
        result = self.service.record_search_event(
            self.session_id,
            "  Stranger   Things ",
            4,
            {"type": "all", "genre": "all", "year": "all"},
        )

        self.assertEqual(result["query_text"], "Stranger   Things")
        self.assertEqual(result["normalized_query"], "stranger things")
        self.assertEqual(result["result_count"], 17)
        self.assertEqual(self.repository.transactions_committed, 1)

    def test_search_telemetry_uses_server_count_not_client_claim(self):
        result = self.service.record_search_event(
            self.session_id,
            "Drama",
            2_147_483_647,
            {"type": "Movie", "genre": "Drama", "year": "2020s"},
        )

        self.assertEqual(result["result_count"], self.repository.search_result_count)

    def test_search_replay_survives_catalog_count_change(self):
        mutation_id = uuid4()
        filters = {"type": "all", "genre": "all", "year": "all"}
        self.service.record_search_event(
            self.session_id,
            "Drama",
            2,
            filters,
            client_mutation_id=mutation_id,
        )
        self.repository.search_result_count += 1

        replay = self.service.record_search_event(
            self.session_id,
            "Drama",
            2,
            filters,
            client_mutation_id=mutation_id,
        )

        self.assertEqual(replay["result_count"], 17)

    def test_search_replay_does_not_revalidate_removed_genre(self):
        mutation_id = uuid4()
        filters = {"type": "all", "genre": "Drama", "year": "all"}
        self.service.record_search_event(
            self.session_id,
            "Drama",
            2,
            filters,
            client_mutation_id=mutation_id,
        )
        self.repository.catalog_genre_exists = lambda _genre: False

        replay = self.service.record_search_event(
            self.session_id,
            "Drama",
            2,
            filters,
            client_mutation_id=mutation_id,
        )

        self.assertEqual(replay["search_event_id"], 1)

    def test_replay_does_not_conflict_when_client_timestamp_leaves_skew_window(self):
        mutation_id = uuid4()
        first_now = datetime(2026, 9, 15, 12, tzinfo=timezone.utc)
        occurred_at = first_now - timedelta(days=6)
        with patch("cinemind.interaction.service.datetime") as clock:
            clock.now.return_value = first_now
            self.service.record_search_event(
                self.session_id,
                "Drama",
                0,
                {},
                client_mutation_id=mutation_id,
                client_occurred_at=occurred_at,
            )
            clock.now.return_value = first_now + timedelta(days=2)
            replay = self.service.record_search_event(
                self.session_id,
                "Drama",
                0,
                {},
                client_mutation_id=mutation_id,
                client_occurred_at=occurred_at,
            )

        self.assertEqual(replay["search_event_id"], 1)

    def test_watch_replay_survives_title_deactivation(self):
        mutation_id = uuid4()
        first = self.service.record_watch_session(
            self.session_id, "movie-1", 30, client_mutation_id=mutation_id
        )
        self.repository.titles.pop("movie-1")

        replay = self.service.record_watch_session(
            self.session_id, "movie-1", 30, client_mutation_id=mutation_id
        )

        self.assertEqual(replay["watch_session_id"], first["watch_session_id"])

    def test_rating_replay_survives_title_deactivation(self):
        mutation_id = uuid4()
        first = self.service.record_rating(
            self.session_id, "movie-1", Decimal("8.5"), client_mutation_id=mutation_id
        )
        self.repository.titles.pop("movie-1")

        replay = self.service.record_rating(
            self.session_id, "movie-1", Decimal("8.5"), client_mutation_id=mutation_id
        )

        self.assertEqual(replay["rating_id"], first["rating_id"])

    def test_signal_replay_survives_title_deactivation(self):
        mutation_id = uuid4()
        first = self.service.record_signal(
            self.session_id, "movie-1", Decimal("8.5"), 30,
            client_mutation_id=mutation_id,
        )
        self.repository.titles.pop("movie-1")

        replay = self.service.record_signal(
            self.session_id, "movie-1", Decimal("8.5"), 30,
            client_mutation_id=mutation_id,
        )

        self.assertEqual(
            replay["watch_session"]["watch_session_id"],
            first["watch_session"]["watch_session_id"],
        )

    def test_client_event_time_is_preserved_when_clock_skew_is_bounded(self):
        occurred_at = datetime.now(timezone.utc) - timedelta(hours=2)

        result = self.service.record_signal(
            self.session_id,
            "movie-1",
            Decimal("8.5"),
            30,
            client_occurred_at=occurred_at,
        )

        self.assertEqual(result["watch_session"]["client_occurred_at"], occurred_at)
        self.assertEqual(result["rating"]["client_occurred_at"], occurred_at)

    def test_client_event_time_without_timezone_is_rejected(self):
        with self.assertRaises(InteractionValidationError):
            self.service.record_search_event(
                self.session_id,
                "Drama",
                0,
                {},
                client_occurred_at=datetime.now(),
            )

    def test_client_event_time_with_excessive_skew_is_discarded(self):
        result = self.service.record_search_event(
            self.session_id,
            "Drama",
            0,
            {},
            client_occurred_at=datetime.now(timezone.utc) - timedelta(days=8),
        )

        self.assertIsNone(result["client_occurred_at"])

    def test_state_keeps_newer_client_event_when_older_retry_arrives_later(self):
        newer_event_time = datetime.now(timezone.utc) - timedelta(hours=2)
        device_id = uuid4()

        self.service.record_rating(
            self.session_id,
            "movie-1",
            Decimal("8"),
            client_occurred_at=newer_event_time,
            client_device_id=device_id,
            client_event_sequence=2,
        )
        self.service.record_rating(
            self.session_id,
            "movie-1",
            Decimal("2"),
            client_occurred_at=newer_event_time - timedelta(hours=1),
            client_device_id=device_id,
            client_event_sequence=1,
        )

        state = self.service.get_state(self.session_id)

        self.assertEqual(state["ratings"][0]["show_id"], "movie-1")
        self.assertEqual(state["ratings"][0]["rating"], Decimal("8.0"))

    def test_search_telemetry_rejects_unknown_catalog_genres(self):
        self.repository.catalog_genre_exists = lambda _genre: False

        with self.assertRaises(InteractionValidationError):
            self.service.record_search_event(
                self.session_id,
                "Drama",
                0,
                {"type": "all", "genre": "Not a catalog genre", "year": "all"},
            )

    def test_movie_duration_is_converted_to_seconds_and_completion_rate(self):
        result = self.service.record_watch_session(self.session_id, "movie-1", 60)

        self.assertEqual(result["watch_seconds"], 3600)
        self.assertEqual(result["runtime_seconds"], 7200)
        self.assertEqual(result["completion_rate"], Decimal("0.5000"))
        self.assertEqual(result["duration_basis"], "movie_minutes")

    def test_tv_duration_does_not_invent_a_total_runtime(self):
        result = self.service.record_watch_session(self.session_id, "show-1", 90)

        self.assertEqual(result["watch_seconds"], 5400)
        self.assertIsNone(result["runtime_seconds"])
        self.assertIsNone(result["completion_rate"])
        self.assertEqual(result["duration_basis"], "tv_seasons")

    def test_signal_writes_watch_and_rating_in_one_transaction(self):
        result = self.service.record_signal(self.session_id, "movie-1", Decimal("8.5"), 30)

        self.assertEqual(result["rating"]["rating"], Decimal("8.5"))
        self.assertEqual(result["rating"]["watch_session_id"], result["watch_session"]["watch_session_id"])
        self.assertEqual(self.repository.transactions_committed, 1)

    def test_signal_replay_rejects_a_different_payload(self):
        mutation_id = uuid4()
        first = self.service.record_signal(
            self.session_id, "movie-1", Decimal("8.5"), 30,
            client_mutation_id=mutation_id,
        )
        replay = self.service.record_signal(
            self.session_id, "movie-1", Decimal("8.5"), 30,
            client_mutation_id=mutation_id,
        )

        self.assertEqual(
            replay["watch_session"]["watch_session_id"],
            first["watch_session"]["watch_session_id"],
        )
        with self.assertRaises(InteractionConflictError):
            self.service.record_signal(
                self.session_id, "movie-1", Decimal("2"), 30,
                client_mutation_id=mutation_id,
            )
        with self.assertRaises(InteractionConflictError):
            self.service.record_signal(
                self.session_id, "show-1", Decimal("8.5"), 30,
                client_mutation_id=mutation_id,
            )

    def test_watch_replay_ignores_catalog_derived_duration_changes(self):
        mutation_id = uuid4()
        first = self.service.record_watch_session(
            self.session_id,
            "movie-1",
            30,
            client_mutation_id=mutation_id,
        )
        self.repository.titles["movie-1"]["movie_duration_min"] = 90

        replay = self.service.record_watch_session(
            self.session_id,
            "movie-1",
            30,
            client_mutation_id=mutation_id,
        )

        self.assertEqual(replay["watch_session_id"], first["watch_session_id"])
        self.assertEqual(replay["runtime_seconds"], 7200)

    def test_signal_replay_after_session_rotation_reuses_the_original_event(self):
        mutation_id = uuid4()
        device_id = uuid4()
        first = self.service.record_signal(
            self.session_id,
            "movie-1",
            Decimal("8.5"),
            30,
            client_mutation_id=mutation_id,
            client_device_id=device_id,
            client_event_sequence=1,
        )
        rotated_session = uuid4()
        now = datetime.now(timezone.utc)
        self.repository.sessions[rotated_session] = {
            "session_id": rotated_session,
            "started_at": now,
            "last_seen_at": now,
            "ended_at": None,
        }
        replay = self.service.record_signal(
            rotated_session,
            "movie-1",
            Decimal("8.5"),
            30,
            client_mutation_id=mutation_id,
            client_device_id=device_id,
            client_event_sequence=1,
        )

        self.assertEqual(replay["watch_session"]["watch_session_id"], first["watch_session"]["watch_session_id"])
        self.assertEqual(replay["rating"]["rating_id"], first["rating"]["rating_id"])
        self.assertEqual(len(self.repository.watch_sessions), 1)
        self.assertEqual(len(self.repository.ratings), 1)

    def test_authenticated_mutation_replay_cannot_cross_account_boundaries(self):
        account_a = uuid4()
        account_b = uuid4()
        self.repository.sessions[self.session_id]["user_id"] = account_a
        other_session = self._add_account_session(account_b)

        cases = (
            (
                self.service.record_search_event,
                (self.session_id, "Drama", 0, {}),
                (other_session, "Drama", 0, {}),
            ),
            (
                self.service.record_watch_session,
                (self.session_id, "movie-1", 30),
                (other_session, "movie-1", 30),
            ),
            (
                self.service.record_rating,
                (self.session_id, "movie-1", Decimal("8.5")),
                (other_session, "movie-1", Decimal("8.5")),
            ),
            (
                self.service.record_signal,
                (self.session_id, "movie-1", Decimal("8.5"), 30),
                (other_session, "movie-1", Decimal("8.5"), 30),
            ),
        )

        for record, first_args, replay_args in cases:
            with self.subTest(endpoint=record.__name__):
                mutation_id = uuid4()
                record(*first_args, user_id=account_a, client_mutation_id=mutation_id)
                with self.assertRaises(InteractionUnauthorizedError):
                    record(*replay_args, user_id=account_b, client_mutation_id=mutation_id)

        self.assertEqual(len(self.repository.search_events), 1)
        self.assertEqual(len(self.repository.watch_sessions), 2)
        self.assertEqual(len(self.repository.ratings), 2)

    def test_partial_signal_cannot_attach_a_foreign_watch_to_current_account(self):
        account_a = uuid4()
        account_b = uuid4()
        self.repository.sessions[self.session_id]["user_id"] = account_a
        other_session = self._add_account_session(account_b)
        mutation_id = uuid4()
        self.service.record_watch_session(
            self.session_id,
            "movie-1",
            30,
            user_id=account_a,
            client_mutation_id=mutation_id,
        )

        with self.assertRaises(InteractionUnauthorizedError):
            self.service.record_signal(
                other_session,
                "movie-1",
                Decimal("8.5"),
                30,
                user_id=account_b,
                client_mutation_id=mutation_id,
            )

        self.assertEqual(len(self.repository.watch_sessions), 1)
        self.assertEqual(len(self.repository.ratings), 0)

    def test_anonymous_replay_cannot_reuse_an_authenticated_search_mutation(self):
        account_id = uuid4()
        anonymous_session = self._add_anonymous_session()
        self.repository.sessions[self.session_id]["user_id"] = account_id
        mutation_id = uuid4()

        self.service.record_search_event(
            self.session_id,
            "Drama",
            0,
            {},
            user_id=account_id,
            client_mutation_id=mutation_id,
        )

        with self.assertRaises(InteractionUnauthorizedError):
            self.service.record_search_event(
                anonymous_session,
                "Drama",
                0,
                {},
                client_mutation_id=mutation_id,
            )

    def test_anonymous_replay_can_follow_a_rotated_anonymous_session(self):
        rotated_session = self._add_anonymous_session()
        mutation_id = uuid4()
        first = self.service.record_search_event(
            self.session_id,
            "Drama",
            0,
            {},
            client_mutation_id=mutation_id,
        )

        replay = self.service.record_search_event(
            rotated_session,
            "Drama",
            0,
            {},
            client_mutation_id=mutation_id,
        )

        self.assertEqual(replay["search_event_id"], first["search_event_id"])

    def test_rating_replay_after_session_rotation_reuses_linked_watch(self):
        mutation_id = uuid4()
        watch = self.service.record_watch_session(self.session_id, "movie-1", 30)
        first = self.service.record_rating(
            self.session_id,
            "movie-1",
            Decimal("8.5"),
            watch["watch_session_id"],
            client_mutation_id=mutation_id,
        )
        rotated_session = uuid4()
        now = datetime.now(timezone.utc)
        self.repository.sessions[rotated_session] = {
            "session_id": rotated_session,
            "started_at": now,
            "last_seen_at": now,
            "ended_at": None,
        }

        replay = self.service.record_rating(
            rotated_session,
            "movie-1",
            Decimal("8.5"),
            watch["watch_session_id"],
            client_mutation_id=mutation_id,
        )

        self.assertEqual(replay["rating_id"], first["rating_id"])
        self.assertEqual(len(self.repository.ratings), 1)

    def test_same_device_sequence_wins_over_a_wrong_client_clock(self):
        device_id = uuid4()
        self.service.record_rating(
            self.session_id,
            "movie-1",
            Decimal("8"),
            client_device_id=device_id,
            client_event_sequence=2,
            client_occurred_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        self.service.record_rating(
            self.session_id,
            "movie-1",
            Decimal("2"),
            client_device_id=device_id,
            client_event_sequence=1,
            client_occurred_at=datetime.now(timezone.utc),
        )

        state = self.service.get_state(self.session_id)

        self.assertEqual(state["ratings"][0]["rating"], Decimal("8.0"))

    def test_signal_rolls_back_when_rating_write_fails(self):
        self.repository.fail_rating = True

        with self.assertRaises(RuntimeError):
            self.service.record_signal(self.session_id, "movie-1", Decimal("8.5"), 30)

        self.assertEqual(self.repository.transactions_committed, 0)
        self.assertEqual(self.repository.transactions_rolled_back, 1)
        self.assertEqual(self.repository.watch_sessions, {})

    def test_invalid_duration_and_unknown_title_are_rejected(self):
        with self.assertRaises(InteractionValidationError):
            self.service.record_watch_session(self.session_id, "movie-1", 10081)
        with self.assertRaises(InteractionNotFoundError):
            self.service.record_watch_session(self.session_id, "missing", 10)
        with self.assertRaises(InteractionValidationError):
            self.service.record_search_event(self.session_id, "   ", 0, {})

    def test_account_owned_session_rejects_anonymous_and_other_account_access(self):
        account_id = uuid4()
        other_account_id = uuid4()
        self.repository.sessions[self.session_id]["user_id"] = account_id

        with self.assertRaises(InteractionUnauthorizedError):
            self.service.get_state(self.session_id)
        with self.assertRaises(InteractionUnauthorizedError):
            self.service.get_state(self.session_id, other_account_id)

        state = self.service.get_state(self.session_id, account_id)
        self.assertEqual(state["session_id"], self.session_id)

    def test_rating_must_use_half_point_steps(self):
        with self.assertRaises(InteractionValidationError):
            self.service.record_rating(self.session_id, "movie-1", Decimal("8.25"))
        self.assertEqual(
            self.service.record_rating(self.session_id, "movie-1", Decimal("10"))["rating"],
            Decimal("10.0"),
        )

    def test_linked_watch_session_must_belong_to_same_title_and_session(self):
        watch = self.service.record_watch_session(self.session_id, "movie-1", 10)
        other_session = uuid4()
        self.repository.sessions[other_session] = {"session_id": other_session, "ended_at": None}

        with self.assertRaises(InteractionValidationError):
            self.service.record_rating(other_session, "movie-1", Decimal("7"), watch["watch_session_id"])

    def test_non_finite_rating_is_rejected(self):
        with self.assertRaises(InteractionValidationError):
            self.service.record_rating(self.session_id, "movie-1", Decimal("NaN"))


class InteractionSchemaTests(unittest.TestCase):
    """Verify request validation before the routes reach the database."""

    def test_rating_schema_rejects_out_of_range_and_non_half_point_values(self):
        with self.assertRaises(ValidationError):
            RatingCreateRequest(session_id=uuid4(), show_id="movie-1", rating=10.25)

    def test_signal_schema_requires_non_negative_watch_minutes(self):
        with self.assertRaises(ValidationError):
            SignalCreateRequest(
                session_id=uuid4(),
                show_id="movie-1",
                rating=8,
                watch_minutes=-1,
            )

    def test_session_schema_rejects_blank_metadata(self):
        with self.assertRaises(ValidationError):
            SessionCreateRequest(locale="   ")

    def test_search_schema_rejects_unknown_or_invalid_filter_values(self):
        base = {"session_id": uuid4(), "query": "drama", "result_count": 0}
        with self.assertRaises(ValidationError):
            SearchEventCreateRequest(**base, filters={"sort": "new"})
        with self.assertRaises(ValidationError):
            SearchEventCreateRequest(**base, filters={"type": "Documentary"})
        with self.assertRaises(ValidationError):
            SearchEventCreateRequest(**base, filters={"year": "future"})


if __name__ == "__main__":
    unittest.main()
