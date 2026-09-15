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
    """Small SQL spy that models the device and server-time projection."""

    def __init__(self, rows):
        self.rows = list(rows)
        self.statements = []

    def execute(self, statement, params=()):
        self.statements.append((statement, params))
        session_id = params[0]
        candidates = [row for row in self.rows if row["session_id"] == session_id]
        latest_by_device = {}
        for row in candidates:
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
            server_sort_key = (row["rated_at"], row["rating_id"])
            current = latest_by_title.get(row["title_id"])
            if current is None or server_sort_key > current[0]:
                latest_by_title[row["title_id"]] = (server_sort_key, row)
        rows = [
            row
            for _sort_key, row in sorted(
                latest_by_title.values(), key=lambda item: item[1]["title_id"]
            )
        ]
        return _Result(rows)


class InteractionRepositoryTests(unittest.TestCase):
    def test_state_uses_device_sequence_before_client_clock_for_retried_rating(self):
        session_id = uuid4()
        device_id = uuid4()
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
                    "client_device_id": device_id,
                    "client_event_sequence": 1,
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
                    "client_device_id": device_id,
                    "client_event_sequence": 2,
                },
            ]
        )

        state = InteractionRepository(connection).interaction_state(session_id)

        self.assertEqual(state["ratings"][0]["rating"], Decimal("8.0"))
        query = connection.statements[0][0]
        self.assertIn("r.client_event_sequence DESC NULLS LAST", query)
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
