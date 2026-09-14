"""Regression tests for interaction-state SQL projections."""

from datetime import datetime, timezone
from decimal import Decimal
import unittest
from uuid import uuid4

from cinemind.interaction.repository import InteractionRepository


class _Result:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchall(self):
        return self.rows


class _StateConnection:
    """Small SQL spy that models DISTINCT ON for the state projection."""

    def __init__(self, rows):
        self.rows = list(rows)
        self.statements = []

    def execute(self, statement, params=()):
        self.statements.append((statement, params))
        session_id = params[0]
        candidates = [row for row in self.rows if row["session_id"] == session_id]
        use_effective_time = "COALESCE(r.client_occurred_at, r.rated_at)" in statement
        latest_by_title = {}
        for row in candidates:
            event_time = row["client_occurred_at"] or row["rated_at"]
            sort_key = (
                event_time,
                row["rated_at"],
                row["rating_id"],
            ) if use_effective_time else (
                row["rated_at"],
                row["rating_id"],
            )
            current = latest_by_title.get(row["title_id"])
            if current is None or sort_key > current[0]:
                latest_by_title[row["title_id"]] = (sort_key, row)
        rows = [
            row
            for _sort_key, row in sorted(
                latest_by_title.values(), key=lambda item: item[1]["title_id"]
            )
        ]
        return _Result(rows)


class InteractionRepositoryTests(unittest.TestCase):
    def test_state_uses_client_time_before_server_receipt_for_retried_rating(self):
        session_id = uuid4()
        client_newer = datetime(2026, 9, 14, 10, tzinfo=timezone.utc)
        received_newer = datetime(2026, 9, 14, 10, 1, tzinfo=timezone.utc)
        client_older = datetime(2026, 9, 14, 9, tzinfo=timezone.utc)
        received_retry = datetime(2026, 9, 14, 11, tzinfo=timezone.utc)
        connection = _StateConnection(
            [
                {
                    "session_id": session_id,
                    "title_id": 7,
                    "rating_id": 2,
                    "show_id": "movie-7",
                    "rating": Decimal("2.0"),
                    "watch_seconds": None,
                    "rated_at": received_retry,
                    "client_occurred_at": client_older,
                },
                {
                    "session_id": session_id,
                    "title_id": 7,
                    "rating_id": 1,
                    "show_id": "movie-7",
                    "rating": Decimal("8.0"),
                    "watch_seconds": None,
                    "rated_at": received_newer,
                    "client_occurred_at": client_newer,
                },
            ]
        )

        state = InteractionRepository(connection).interaction_state(session_id)

        self.assertEqual(state["ratings"][0]["rating"], Decimal("8.0"))
        query = connection.statements[0][0]
        self.assertIn("COALESCE(r.client_occurred_at, r.rated_at) DESC", query)
        self.assertIn("r.rated_at DESC", query)
        self.assertIn("r.rating_id DESC", query)

    def test_state_falls_back_to_server_time_for_legacy_rows(self):
        session_id = uuid4()
        connection = _StateConnection(
            [
                {
                    "session_id": session_id,
                    "title_id": 7,
                    "rating_id": 1,
                    "show_id": "movie-7",
                    "rating": Decimal("6.0"),
                    "watch_seconds": None,
                    "rated_at": datetime(2026, 9, 14, 10, tzinfo=timezone.utc),
                    "client_occurred_at": None,
                },
                {
                    "session_id": session_id,
                    "title_id": 7,
                    "rating_id": 2,
                    "show_id": "movie-7",
                    "rating": Decimal("8.0"),
                    "watch_seconds": None,
                    "rated_at": datetime(2026, 9, 14, 9, tzinfo=timezone.utc),
                    "client_occurred_at": datetime(
                        2026, 9, 14, 8, tzinfo=timezone.utc
                    ),
                },
            ]
        )

        state = InteractionRepository(connection).interaction_state(session_id)

        self.assertEqual(state["ratings"][0]["rating"], Decimal("6.0"))


if __name__ == "__main__":
    unittest.main()
