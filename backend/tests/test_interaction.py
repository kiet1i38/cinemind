"""Unit and HTTP-contract tests for the interaction milestone."""

from datetime import datetime, timezone
from decimal import Decimal
import copy
from types import SimpleNamespace
from uuid import uuid4
import unittest

from pydantic import ValidationError

from cinemind.interaction.schemas import RatingCreateRequest, SignalCreateRequest
from cinemind.interaction.service import (
    InteractionNotFoundError,
    InteractionService,
    InteractionValidationError,
)


class FakeTransaction:
    """Small transaction spy that makes rollback behavior observable."""

    def __init__(self, repository):
        self.repository = repository

    def __enter__(self):
        self.repository.transactions_started += 1
        self.snapshot = (
            copy.deepcopy(self.repository.watch_sessions),
            copy.deepcopy(self.repository.ratings),
            copy.deepcopy(self.repository.preferences),
        )
        return self

    def __exit__(self, error_type, _error, _traceback):
        if error_type:
            self.repository.transactions_rolled_back += 1
            (
                self.repository.watch_sessions,
                self.repository.ratings,
                self.repository.preferences,
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
        self.ratings = []
        self.preferences = {"favorites": set(), "watchlist_items": set()}
        self.transactions_started = 0
        self.transactions_committed = 0
        self.transactions_rolled_back = 0
        self.fail_rating = False

    def transaction(self):
        return FakeTransaction(self)

    def create_session(self, session_id, started_at, locale, platform):
        row = {
            "session_id": session_id,
            "started_at": started_at,
            "last_seen_at": started_at,
        }
        self.sessions[session_id] = {**row, "ended_at": None, "locale": locale, "platform": platform}
        return row

    def get_session(self, session_id):
        return self.sessions.get(session_id)

    def touch_session(self, session_id):
        if session_id not in self.sessions:
            raise LookupError(session_id)
        self.sessions[session_id]["last_seen_at"] = datetime.now(timezone.utc)

    def get_title(self, show_id):
        return self.titles.get(show_id)

    def create_search_event(self, session_id, query_text, normalized_query, result_count, filters):
        return {
            "search_event_id": 1,
            "session_id": session_id,
            "query_text": query_text,
            "normalized_query": normalized_query,
            "result_count": result_count,
            "filters": filters,
            "occurred_at": datetime.now(timezone.utc),
        }

    def create_watch_session(self, watch_session_id, session_id, title_id, watch_seconds, runtime_seconds, completion_rate, duration_basis):
        row = {
            "watch_session_id": watch_session_id,
            "session_id": session_id,
            "title_id": title_id,
            "watch_seconds": watch_seconds,
            "runtime_seconds": runtime_seconds,
            "completion_rate": completion_rate,
            "duration_basis": duration_basis,
            "recorded_at": datetime.now(timezone.utc),
        }
        self.watch_sessions[watch_session_id] = row
        return row

    def get_watch_session(self, watch_session_id):
        return self.watch_sessions.get(watch_session_id)

    def create_rating(self, session_id, title_id, rating, watch_session_id):
        if self.fail_rating:
            raise RuntimeError("simulated rating failure")
        row = {
            "rating_id": len(self.ratings) + 1,
            "session_id": session_id,
            "title_id": title_id,
            "rating": rating,
            "watch_session_id": watch_session_id,
            "rated_at": datetime.now(timezone.utc),
        }
        self.ratings.append(row)
        return row

    def add_preference(self, table_name, session_id, title_id):
        self.preferences[table_name].add((session_id, title_id))
        return {
            "session_id": session_id,
            "title_id": title_id,
            "changed_at": datetime.now(timezone.utc),
        }

    def remove_preference(self, table_name, session_id, title_id):
        key = (session_id, title_id)
        if key not in self.preferences[table_name]:
            return None
        self.preferences[table_name].remove(key)
        return {
            "session_id": session_id,
            "title_id": title_id,
            "changed_at": datetime.now(timezone.utc),
        }

    def interaction_state(self, _session_id):
        return {"ratings": tuple(), "favorites": tuple(), "watchlist_items": tuple()}


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

    def test_search_normalizes_whitespace_and_case(self):
        result = self.service.record_search_event(
            self.session_id,
            "  Stranger   Things ",
            4,
            {"type": "all", "genre": "all", "year": "all"},
        )

        self.assertEqual(result["query_text"], "Stranger   Things")
        self.assertEqual(result["normalized_query"], "stranger things")
        self.assertEqual(self.repository.transactions_committed, 1)

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

    def test_preference_add_and_remove_are_idempotent_at_service_boundary(self):
        first = self.service.add_preference("favorites", self.session_id, "movie-1")
        second = self.service.add_preference("favorites", self.session_id, "movie-1")
        removed = self.service.remove_preference("favorites", self.session_id, "movie-1")
        removed_again = self.service.remove_preference("favorites", self.session_id, "movie-1")

        self.assertTrue(first["active"])
        self.assertTrue(second["active"])
        self.assertFalse(removed["active"])
        self.assertFalse(removed_again["active"])


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


if __name__ == "__main__":
    unittest.main()
