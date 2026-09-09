"""Focused tests for bounded request and runtime security primitives."""

from types import SimpleNamespace
from dataclasses import replace
import unittest

from fastapi import HTTPException

from cinemind.config import Settings
from cinemind.config import get_settings
from cinemind.auth import routes as auth_routes
from cinemind.interaction.limits import normalize_filters
from cinemind.middleware import _interaction_principal
from cinemind.middleware import InteractionRateLimitMiddleware
from cinemind.security import SlidingWindowRateLimiter


class SecurityPrimitiveTests(unittest.TestCase):
    def test_sliding_window_limiter_blocks_and_expires_attempts(self):
        limiter = SlidingWindowRateLimiter(max_attempts=2, window_seconds=10)

        self.assertTrue(limiter.check("client", now=100).allowed)
        limiter.record_failure("client", now=100)
        limiter.record_failure("client", now=101)
        blocked = limiter.check("client", now=101)
        self.assertFalse(blocked.allowed)
        self.assertGreaterEqual(blocked.retry_after_seconds, 1)
        self.assertTrue(limiter.check("client", now=111).allowed)

    def test_success_clears_only_the_requested_bucket(self):
        limiter = SlidingWindowRateLimiter(max_attempts=1, window_seconds=60)
        limiter.record_failure("one", now=10)
        limiter.record_failure("two", now=10)
        limiter.record_success("one")

        self.assertTrue(limiter.check("one", now=10).allowed)
        self.assertFalse(limiter.check("two", now=10).allowed)

    def test_interaction_principal_uses_the_configured_auth_cookie_name(self):
        custom_headers = {"cookie": "custom_auth=secret-token"}
        configured = _interaction_principal(
            custom_headers,
            "10.0.0.1",
            auth_cookie_name="custom_auth",
        )

        self.assertNotEqual(configured, "10.0.0.1")
        self.assertEqual(
            _interaction_principal(
                {"cookie": "cinemind_auth=secret-token"},
                "10.0.0.1",
                auth_cookie_name="custom_auth",
            ),
            "10.0.0.1",
        )

    def test_filter_normalization_rejects_oversized_or_non_string_values(self):
        with self.assertRaises(ValueError):
            normalize_filters({str(index): "value" for index in range(9)})
        with self.assertRaises(ValueError):
            normalize_filters({"genre": "x" * 65})
        with self.assertRaises(ValueError):
            normalize_filters({"genre": 2026})

        self.assertEqual(
            normalize_filters({"  genre ": "  Drama  "}),
            {"genre": "Drama"},
        )

    def test_runtime_settings_do_not_embed_a_development_password(self):
        settings = Settings(
            environment="development",
            database_url="postgresql:///cinemind",
            catalog_seed_path=SimpleNamespace(),
            migrations_path=SimpleNamespace(),
            catalog_source_name="catalog",
            catalog_source_type="test",
            catalog_source_uri="test://catalog",
            catalog_schema_version="test-v1",
            db_connect_retries=1,
            db_connect_retry_delay_seconds=1,
            db_connect_timeout_seconds=1,
            db_pool_min_size=1,
            db_pool_max_size=2,
            db_pool_timeout_seconds=1,
            max_request_body_bytes=32768,
            max_watch_minutes=10080,
            cors_allowed_origins=("http://localhost:5173",),
            trust_proxy_headers=False,
            require_https=False,
            auth_cookie_name="cinemind_auth",
            auth_session_ttl_days=30,
            auth_password_iterations=10000,
            auth_rate_limit_window_seconds=60,
            auth_rate_limit_max_attempts=5,
            interaction_rate_limit_window_seconds=60,
            interaction_rate_limit_max_attempts=10,
            admin_reset_username="",
            admin_reset_password="",
            reset_enabled=False,
            full_reset_enabled=False,
        )

        self.assertNotIn("cinemind_dev", settings.database_url)

    def test_runtime_settings_reject_an_unbounded_pool(self):
        with self.assertRaises(ValueError):
            Settings(
                environment="test",
                database_url="postgresql:///cinemind",
                catalog_seed_path=SimpleNamespace(),
                migrations_path=SimpleNamespace(),
                catalog_source_name="catalog",
                catalog_source_type="test",
                catalog_source_uri="test://catalog",
                catalog_schema_version="test-v1",
                db_connect_retries=1,
                db_connect_retry_delay_seconds=1,
                db_connect_timeout_seconds=1,
                db_pool_min_size=3,
                db_pool_max_size=2,
                db_pool_timeout_seconds=1,
                max_request_body_bytes=32768,
                max_watch_minutes=10080,
                cors_allowed_origins=(),
                trust_proxy_headers=False,
                require_https=False,
                auth_cookie_name="cinemind_auth",
                auth_session_ttl_days=30,
                auth_password_iterations=10000,
                auth_rate_limit_window_seconds=60,
                auth_rate_limit_max_attempts=5,
                interaction_rate_limit_window_seconds=60,
                interaction_rate_limit_max_attempts=10,
                admin_reset_username="",
                admin_reset_password="",
                reset_enabled=False,
                full_reset_enabled=False,
            )

    def test_runtime_settings_reject_session_ttl_over_one_year(self):
        with self.assertRaisesRegex(ValueError, "must not exceed 365"):
            Settings(
                environment="test",
                database_url="postgresql:///cinemind",
                catalog_seed_path=SimpleNamespace(),
                migrations_path=SimpleNamespace(),
                catalog_source_name="catalog",
                catalog_source_type="test",
                catalog_source_uri="test://catalog",
                catalog_schema_version="test-v1",
                db_connect_retries=1,
                db_connect_retry_delay_seconds=1,
                db_connect_timeout_seconds=1,
                db_pool_min_size=1,
                db_pool_max_size=2,
                db_pool_timeout_seconds=1,
                max_request_body_bytes=32768,
                max_watch_minutes=10080,
                cors_allowed_origins=(),
                trust_proxy_headers=False,
                require_https=False,
                auth_cookie_name="cinemind_auth",
                auth_session_ttl_days=366,
                auth_password_iterations=10000,
                auth_rate_limit_window_seconds=60,
                auth_rate_limit_max_attempts=5,
                interaction_rate_limit_window_seconds=60,
                interaction_rate_limit_max_attempts=10,
                admin_reset_username="",
                admin_reset_password="",
                reset_enabled=False,
                full_reset_enabled=False,
            )

    def test_runtime_settings_reject_invalid_database_connect_limits(self):
        for field_name, value in (
            ("db_connect_retries", 0),
            ("db_connect_timeout_seconds", 0),
        ):
            with self.subTest(field=field_name):
                with self.assertRaisesRegex(ValueError, field_name):
                    replace(get_settings(), **{field_name: value})

        with self.assertRaisesRegex(ValueError, "db_connect_retry_delay_seconds"):
            replace(get_settings(), db_connect_retry_delay_seconds=-1)

    def test_auth_success_does_not_clear_ip_failure_bucket(self):
        request = SimpleNamespace(
            client=SimpleNamespace(host="203.0.113.40"),
            headers={},
        )
        auth_routes.auth_rate_limiter.clear()
        auth_routes.auth_ip_rate_limiter.clear()
        identifier_key = auth_routes._auth_rate_limit_key(request, "user@example.com", "login")
        ip_key = auth_routes._auth_ip_key(request, "login")
        for _ in range(auth_routes.auth_ip_rate_limiter.max_attempts):
            auth_routes.auth_ip_rate_limiter.record_failure(ip_key)

        auth_routes._record_auth_success(request, identifier_key)

        self.assertFalse(auth_routes.auth_ip_rate_limiter.check(ip_key).allowed)
        self.assertTrue(auth_routes.auth_rate_limiter.check(identifier_key).allowed)

    def test_registration_attempts_consume_a_success_independent_bucket(self):
        request = SimpleNamespace(
            client=SimpleNamespace(host="203.0.113.41"),
            headers={},
        )
        auth_routes.auth_registration_rate_limiter.clear()
        for _ in range(auth_routes.auth_registration_rate_limiter.max_attempts):
            auth_routes._record_registration_attempt(request)

        with self.assertRaises(HTTPException) as context:
            auth_routes._enforce_registration_rate_limit(request)
        self.assertEqual(context.exception.status_code, 429)


class InteractionRateLimitMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.status = 201

        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": self.status, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        self.middleware = InteractionRateLimitMiddleware(app, max_attempts=2, window_seconds=60)

    async def request(self, path):
        response_status = None

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            nonlocal response_status
            if message["type"] == "http.response.start":
                response_status = message["status"]

        await self.middleware(
            {
                "type": "http",
                "method": "POST",
                "path": path,
                "headers": [],
                "client": ("203.0.113.10", 1234),
            },
            receive,
            send,
        )
        return response_status

    async def test_success_does_not_clear_previous_failures(self):
        self.status = 400
        self.assertEqual(await self.request("/api/interaction/search-events"), 400)
        self.status = 201
        self.assertEqual(await self.request("/api/interaction/search-events"), 201)
        self.status = 400
        self.assertEqual(await self.request("/api/interaction/search-events"), 400)
        self.assertEqual(await self.request("/api/interaction/search-events"), 429)

    async def test_successful_session_creation_is_bounded(self):
        self.assertEqual(await self.request("/api/interaction/sessions"), 201)
        self.assertEqual(await self.request("/api/interaction/sessions"), 201)
        self.assertEqual(await self.request("/api/interaction/sessions"), 429)


if __name__ == "__main__":
    unittest.main()
