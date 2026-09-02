"""Unit tests for the catalog JSON boundary."""

import json
from pathlib import Path
import tempfile
import unittest

from cinemind.catalog.loader import load_catalog


class CatalogLoaderTests(unittest.TestCase):
    """Protect duration, poster and normalization rules."""

    def write_catalog(self, records: list[dict]) -> Path:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        path = Path(temporary_directory.name) / "catalog.json"
        path.write_text(json.dumps(records), encoding="utf-8")
        return path

    def test_movie_keeps_minutes_and_public_poster(self) -> None:
        path = self.write_catalog([
            {
                "id": "s1",
                "type": "Movie",
                "title": "A Movie",
                "runtimeMinutes": 120,
                "seasons": None,
                "dateAdded": "2021-09-25",
                "posterUrl": "https://image.example/movie.jpg",
                "posterFallbackUrl": "data/posters/s1.svg",
                "posterKind": "public",
                "listedIn": ["Drama", "Drama"],
            }
        ])

        result = load_catalog(path)

        self.assertEqual(len(result.records), 1)
        record = result.records[0]
        self.assertEqual(record.movie_duration_min, 120)
        self.assertIsNone(record.season_count)
        self.assertEqual(record.duration_basis, "movie_minutes")
        self.assertEqual(record.poster_status, "available")
        self.assertEqual(record.genres, ("Drama",))

    def test_tv_show_uses_seasons_not_runtime_minutes(self) -> None:
        path = self.write_catalog([
            {
                "id": "s2",
                "type": "TV Show",
                "title": "A Show",
                "runtimeMinutes": 45,
                "seasons": 3,
                "posterUrl": "data/posters/s2.svg",
                "posterKind": "generated",
            }
        ])

        record = load_catalog(path).records[0]

        self.assertIsNone(record.movie_duration_min)
        self.assertEqual(record.season_count, 3)
        self.assertEqual(record.duration_basis, "tv_seasons")
        self.assertIsNone(record.poster_url)
        self.assertEqual(record.poster_path, "data/posters/s2.svg")
        self.assertEqual(record.poster_status, "fallback")

    def test_invalid_record_is_reported_without_stopping_valid_rows(self) -> None:
        path = self.write_catalog([
            {"id": "valid", "type": "Movie", "title": "Valid"},
            {"id": "invalid", "type": "Unknown", "title": "Invalid"},
        ])

        result = load_catalog(path)

        self.assertEqual(result.rows_read, 2)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.issues[0].issue_type, "invalid_record")
        self.assertEqual(result.issues[0].severity, "error")

    def test_duplicate_id_is_reported_and_first_row_is_kept(self) -> None:
        path = self.write_catalog([
            {"id": "duplicate", "type": "Movie", "title": "First"},
            {"id": "duplicate", "type": "Movie", "title": "Second"},
        ])

        result = load_catalog(path)

        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.records[0].title, "First")
        self.assertEqual(result.issues[0].issue_type, "duplicate_show_id")
        self.assertEqual(result.issues[0].severity, "error")


if __name__ == "__main__":
    unittest.main()
