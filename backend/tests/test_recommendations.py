import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from fastapi import FastAPI, HTTPException, Response

from cinemind.auth.dependencies import require_auth_context
from cinemind.interaction.repository import InteractionRepository
from cinemind.recommendations.artifacts import (
    RecommendationArtifactStore,
    seal_artifact,
)
from cinemind.recommendations.core import (
    content_similarity_scores,
    rank_recommendations,
)
from cinemind.recommendations.routes import get_recommendations, get_recommendation_service, router
from cinemind.recommendations.service import RecommendationService


def title(show_id, name, year, genres):
    return {
        "title_id": len(show_id),
        "show_id": show_id,
        "content_type": "Movie",
        "title": name,
        "description": None,
        "date_added": None,
        "release_year": year,
        "content_rating": None,
        "movie_duration_min": 100,
        "season_count": None,
        "duration_basis": "movie_runtime",
        "poster_provider": None,
        "poster_path": None,
        "poster_url": None,
        "poster_status": "missing",
        "genres": genres,
        "cast": [],
        "countries": [],
        "directors": [],
    }


class FakeCatalogRepository:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def list_titles(self, *, limit, offset):
        self.calls.append((limit, offset))
        return self.rows[offset : offset + limit]


class FakeInteractionRepository:
    def __init__(self, ratings=(), seen=()):
        self.ratings = tuple(ratings)
        self.seen = frozenset(seen)
        self.requested_user = None

    def interaction_state(self, session_id, user_id):
        self.requested_user = user_id
        return {"ratings": self.ratings}

    def seen_show_ids(self, user_id):
        self.requested_user = user_id
        return self.seen


class RecommendationCoreTests(unittest.TestCase):
    def test_content_similarity_uses_only_positive_liked_history(self):
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)
        scores = content_similarity_scores(
            [
                {"show_id": "liked", "rating": 9, "event_at": now.isoformat()},
                {"show_id": "disliked", "rating": 3, "event_at": now.isoformat()},
            ],
            {
                "liked": {"space": 1.0, "future": 1.0},
                "close": {"space": 1.0},
                "unrelated": {"crime": 1.0},
            },
            now=now,
        )

        self.assertGreater(scores["close"], scores["unrelated"])
        self.assertGreater(scores["liked"], scores["unrelated"])

    def test_missing_artifact_falls_back_to_deterministic_newest_catalog_titles(self):
        result = rank_recommendations(
            catalog=[
                title("older", "Older", 2001, ["Drama"]),
                title("newer", "Newer", 2025, ["Drama"]),
                title("seen", "Already seen", 2026, ["Drama"]),
            ],
            ratings=[],
            seen_show_ids={"seen"},
            artifact=None,
            algorithm="hybrid",
            limit=5,
        )

        self.assertEqual([row["title"]["show_id"] for row in result["items"]], ["newer", "older"])
        self.assertEqual(result["mode"], "degraded_catalog_fallback")
        self.assertEqual(result["evidence_status"], "demo_only")

    def test_service_reads_only_authenticated_owner_and_excludes_all_seen_titles(self):
        user_id = UUID("11111111-1111-4111-8111-111111111111")
        catalog = FakeCatalogRepository([
            title("rated", "Rated", 2024, ["Drama"]),
            title("watched", "Watched", 2025, ["Drama"]),
            title("unseen", "Unseen", 2022, ["Drama"]),
        ])
        interactions = FakeInteractionRepository(
            ratings=[{"show_id": "rated", "rating": 9, "rated_at": None}],
            seen={"rated", "watched"},
        )
        with tempfile.TemporaryDirectory() as temporary:
            store = RecommendationArtifactStore(Path(temporary) / "missing.json")
            result = RecommendationService(catalog, interactions, store).recommend(
                user_id=user_id,
                algorithm="hybrid",
                limit=5,
            )

        self.assertEqual(interactions.requested_user, user_id)
        self.assertEqual([row["title"]["show_id"] for row in result["items"]], ["unseen"])
        self.assertEqual(result["artifact_status"], "missing")
        self.assertEqual(catalog.calls, [(1000, 0)])


class RecommendationArtifactTests(unittest.TestCase):
    def test_loads_a_valid_checksummed_artifact(self):
        artifact = {
            "schema_version": 1,
            "seed_status": "ready",
            "model_version": "week6-test",
            "popularity": {"show-1": 1.0},
            "content_vectors": {"show-1": {"space": 1.0}},
            "tree_features_by_show": {},
            "cluster_model": None,
            "tree_model": None,
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact.json"
            path.write_text(json.dumps(seal_artifact(artifact)), encoding="utf-8")
            snapshot = RecommendationArtifactStore(path).load()

        self.assertEqual(snapshot.status, "ready")
        self.assertEqual(snapshot.artifact["model_version"], "week6-test")

    def test_content_vocabulary_may_overlap_identity_field_names(self):
        artifact = {
            "schema_version": 1,
            "seed_status": "ready",
            "model_version": "week6-test",
            "popularity": {"show-1": 1.0},
            "content_vectors": {"show-1": {"email": 1.0}},
            "tree_features_by_show": {},
            "cluster_model": None,
            "tree_model": None,
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact.json"
            path.write_text(json.dumps(seal_artifact(artifact)), encoding="utf-8")
            snapshot = RecommendationArtifactStore(path).load()

        self.assertEqual(snapshot.status, "ready")

    def test_rejects_corruption_and_identity_keys(self):
        identity_artifact = {
            "schema_version": 1,
            "seed_status": "ready",
            "model_version": "week6-test",
            "popularity": {},
            "content_vectors": {},
            "tree_features_by_show": {},
            "cluster_model": None,
            "tree_model": None,
            "user_key": "must-not-be-in-artifact",
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "artifact.json"
            path.write_text(json.dumps(seal_artifact(identity_artifact)), encoding="utf-8")
            snapshot = RecommendationArtifactStore(path).load()

        self.assertEqual(snapshot.status, "invalid")
        self.assertIsNone(snapshot.artifact)


class RecommendationRouteTests(unittest.TestCase):
    def test_authenticated_route_is_private_and_publishes_bounded_algorithm_schema(self):
        user_id = UUID("22222222-2222-4222-8222-222222222222")
        catalog = FakeCatalogRepository([title("candidate", "Candidate", 2025, ["Drama"])])
        interactions = FakeInteractionRepository()
        with tempfile.TemporaryDirectory() as temporary:
            service = RecommendationService(
                catalog,
                interactions,
                RecommendationArtifactStore(Path(temporary) / "missing.json"),
            )
            app = FastAPI()
            app.include_router(router)
            app.dependency_overrides[get_recommendation_service] = lambda: service
            app.dependency_overrides[require_auth_context] = lambda: SimpleNamespace(user_id=user_id)
            response = Response()
            payload = get_recommendations(
                response=response,
                algorithm="hybrid",
                limit=5,
                context=SimpleNamespace(user_id=user_id),
                service=service,
            )
            endpoint_schema = app.openapi()["paths"]["/api/recommendations"]["get"]
            algorithm_schema = next(
                parameter["schema"]
                for parameter in endpoint_schema["parameters"]
                if parameter["name"] == "algorithm"
            )
            limit_schema = next(
                parameter["schema"]
                for parameter in endpoint_schema["parameters"]
                if parameter["name"] == "limit"
            )
            route = next(route for route in router.routes if getattr(route, "path", None) == "/api/recommendations")

        self.assertTrue(any(dependency.call is require_auth_context for dependency in route.dependant.dependencies))
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["vary"], "Cookie")
        self.assertEqual(payload["items"][0]["title"]["show_id"], "candidate")
        self.assertEqual(algorithm_schema["enum"], ["popularity", "content", "hybrid"])
        self.assertEqual(limit_schema["type"], "integer")
        self.assertEqual((limit_schema["minimum"], limit_schema["maximum"]), (5, 10))

    def test_recommendation_route_rejects_unsupported_page_size(self):
        user_id = UUID("22222222-2222-4222-8222-222222222222")
        service = RecommendationService(
            FakeCatalogRepository([title("candidate", "Candidate", 2025, ["Drama"])]),
            FakeInteractionRepository(),
            RecommendationArtifactStore(Path("missing-recommendation-artifact.json")),
        )

        with self.assertRaises(HTTPException) as raised:
            get_recommendations(
                response=Response(),
                algorithm="hybrid",
                limit=6,
                context=SimpleNamespace(user_id=user_id),
                service=service,
            )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.detail, "Limit must be 5 or 10")

    def test_http_query_accepts_supported_numeric_limits(self):
        user_id = UUID("22222222-2222-4222-8222-222222222222")
        catalog = FakeCatalogRepository([
            title(f"candidate-{index}", f"Candidate {index}", 2025 - index, ["Drama"])
            for index in range(12)
        ])
        service = RecommendationService(
            catalog,
            FakeInteractionRepository(),
            RecommendationArtifactStore(Path("missing-recommendation-artifact.json")),
        )
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_recommendation_service] = lambda: service
        app.dependency_overrides[require_auth_context] = lambda: SimpleNamespace(user_id=user_id)

        async def request(limit):
            messages = []
            request_sent = False

            async def receive():
                nonlocal request_sent
                if not request_sent:
                    request_sent = True
                    return {"type": "http.request", "body": b"", "more_body": False}
                return {"type": "http.disconnect"}

            async def send(message):
                messages.append(message)

            query = f"algorithm=hybrid&limit={limit}".encode("ascii")
            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/recommendations",
                "raw_path": b"/api/recommendations",
                "query_string": query,
                "root_path": "",
                "headers": [(b"host", b"testserver")],
                "client": ("127.0.0.1", 1234),
                "server": ("testserver", 80),
                "app": app,
            }
            await app(scope, receive, send)
            start = next(message for message in messages if message["type"] == "http.response.start")
            body = b"".join(
                message.get("body", b"")
                for message in messages
                if message["type"] == "http.response.body"
            )
            return start["status"], json.loads(body)

        for limit in ("5", "10"):
            status, body = asyncio.run(request(limit))
            self.assertEqual(status, 200)
            self.assertEqual(len(body["items"]), int(limit))

        status, body = asyncio.run(request("6"))
        self.assertEqual(status, 422)
        self.assertEqual(body["detail"], "Limit must be 5 or 10")


class InteractionSeenTitleTests(unittest.TestCase):
    def test_seen_title_query_covers_rating_and_watch_events_by_owner(self):
        class Result:
            def fetchall(self):
                return [{"show_id": "rated"}, {"show_id": "watched"}]

        class Connection:
            def __init__(self):
                self.statement = ""
                self.parameters = None

            def execute(self, statement, parameters=()):
                self.statement = statement
                self.parameters = parameters
                return Result()

        connection = Connection()
        user_id = UUID("33333333-3333-4333-8333-333333333333")
        seen = InteractionRepository(connection).seen_show_ids(user_id)

        self.assertEqual(seen, frozenset({"rated", "watched"}))
        self.assertIn("UNION", connection.statement)
        self.assertIn("WHERE s.user_id = %s", connection.statement)
        self.assertEqual(connection.parameters, (user_id,))


if __name__ == "__main__":
    unittest.main()
