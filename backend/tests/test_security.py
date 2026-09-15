"""Focused tests for bounded request and runtime security primitives."""

from types import SimpleNamespace
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from cinemind.config import Settings
from cinemind.config import _bool_from_environment, get_settings
from cinemind.auth import routes as auth_routes
from cinemind.interaction.limits import normalize_filters
from cinemind.middleware import CSRFMiddleware, _interaction_principal, _scope_origin
from cinemind.middleware import InteractionRateLimitMiddleware
from cinemind.security import SlidingWindowRateLimiter, client_address_from_headers


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

    def test_forwarded_ip_is_ignored_from_an_untrusted_direct_peer(self):
        headers = {"x-forwarded-for": "198.51.100.44", "x-real-ip": "198.51.100.45"}

        self.assertEqual(
            client_address_from_headers(
                "203.0.113.10",
                headers,
                trust_proxy_headers=True,
                trusted_proxy_networks=("10.0.0.0/8",),
            ),
            "203.0.113.10",
        )

    def test_forwarded_ip_is_accepted_only_from_a_configured_proxy_network(self):
        self.assertEqual(
            client_address_from_headers(
                "10.20.30.40",
                {"x-forwarded-for": "198.51.100.44, 10.20.30.40"},
                trust_proxy_headers=True,
                trusted_proxy_networks=("10.0.0.0/8",),
            ),
            "198.51.100.44",
        )

    def test_append_style_forwarded_chain_ignores_client_supplied_leftmost_ip(self):
        self.assertEqual(
            client_address_from_headers(
                "10.20.30.40",
                {"x-forwarded-for": "203.0.113.99, 198.51.100.44"},
                trust_proxy_headers=True,
                trusted_proxy_networks=("10.0.0.0/8",),
            ),
            "198.51.100.44",
        )

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

    def test_interaction_session_header_cannot_rotate_the_principal_bucket(self):
        client = "10.0.0.1"
        first_spoof = _interaction_principal(
            {"x-cinemind-session": "00000000-0000-4000-8000-000000000001"},
            client,
            auth_cookie_name="cinemind_auth",
        )
        second_spoof = _interaction_principal(
            {"x-cinemind-session": "00000000-0000-4000-8000-000000000002"},
            client,
            auth_cookie_name="cinemind_auth",
        )

        self.assertEqual(first_spoof, client)
        self.assertEqual(second_spoof, client)
        self.assertEqual(
            _interaction_principal(
                {
                    "cookie": "cinemind_auth=secret-token",
                    "x-cinemind-session": "00000000-0000-4000-8000-000000000001",
                },
                client,
                auth_cookie_name="cinemind_auth",
            ),
            _interaction_principal(
                {
                    "cookie": "cinemind_auth=secret-token",
                    "x-cinemind-session": "00000000-0000-4000-8000-000000000002",
                },
                client,
                auth_cookie_name="cinemind_auth",
            ),
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

    def test_login_rate_limit_rejection_does_not_poison_the_other_bucket(self):
        request = SimpleNamespace(
            client=SimpleNamespace(host="203.0.113.42"),
            headers={},
        )
        auth_routes.auth_login_attempt_limiter.clear()
        auth_routes.auth_login_ip_attempt_limiter.clear()
        identifier_key = auth_routes._auth_identifier_rate_limit_key(
            "victim@example.com", "login"
        )
        ip_key = auth_routes._auth_ip_key(request, "login")

        for _ in range(auth_routes.auth_login_ip_attempt_limiter.max_attempts):
            auth_routes.auth_login_ip_attempt_limiter.record_attempt(ip_key)
        with self.assertRaises(HTTPException) as blocked_by_ip:
            auth_routes._enforce_login_attempt_rate_limit(request, identifier_key)
        self.assertEqual(blocked_by_ip.exception.status_code, 429)
        self.assertTrue(
            auth_routes.auth_login_attempt_limiter.check(identifier_key).allowed
        )

        auth_routes.auth_login_attempt_limiter.clear()
        auth_routes.auth_login_ip_attempt_limiter.clear()
        for _ in range(auth_routes.auth_login_attempt_limiter.max_attempts):
            auth_routes.auth_login_attempt_limiter.record_attempt(identifier_key)
        with self.assertRaises(HTTPException) as blocked_by_account:
            auth_routes._enforce_login_attempt_rate_limit(request, identifier_key)
        self.assertEqual(blocked_by_account.exception.status_code, 429)
        self.assertTrue(
            auth_routes.auth_login_ip_attempt_limiter.check(ip_key).allowed
        )

    def test_login_failure_reservation_is_atomic_under_concurrency(self):
        request = SimpleNamespace(
            client=SimpleNamespace(host="203.0.113.43"),
            headers={},
        )
        auth_routes.auth_rate_limiter.clear()
        auth_routes.auth_ip_rate_limiter.clear()
        key = auth_routes._auth_rate_limit_key(
            request,
            "victim@example.com",
            "login",
            principal="user:00000000-0000-4000-8000-000000000043",
        )

        with ThreadPoolExecutor(max_workers=20) as executor:
            decisions = list(
                executor.map(
                    lambda _index: auth_routes._record_auth_failure(request, key),
                    range(20),
                )
            )

        self.assertEqual(sum(decisions), auth_routes.auth_rate_limiter.max_attempts)
        self.assertFalse(auth_routes.auth_rate_limiter.check(key).allowed)

    def test_login_aliases_share_one_stable_account_bucket(self):
        user_id = "00000000-0000-4000-8000-000000000044"
        email_key = auth_routes._auth_identifier_rate_limit_key(
            "alice@example.com",
            "login",
            principal=f"user:{user_id}",
        )
        username_key = auth_routes._auth_identifier_rate_limit_key(
            "alice",
            "login",
            principal=f"user:{user_id}",
        )

        self.assertEqual(email_key, username_key)

    def test_unknown_login_aliases_use_one_neutral_principal(self):
        self.assertEqual(
            auth_routes._login_rate_limit_principal("missing@example.com"),
            auth_routes._login_rate_limit_principal("another-missing-user"),
        )

    def test_blank_boolean_environment_uses_the_environment_default(self):
        with patch.dict(os.environ, {"REQUIRE_HTTPS": "", "RESET_ENABLED": ""}):
            self.assertTrue(_bool_from_environment("REQUIRE_HTTPS", True))
            self.assertFalse(_bool_from_environment("RESET_ENABLED", False))

    def test_production_settings_keep_secure_defaults_when_compose_values_are_blank(self):
        with patch.dict(
            os.environ,
            {
                "CINEMIND_ENVIRONMENT": "production",
                "DATABASE_URL": "postgresql://cinemind@database:5432/cinemind",
                "REQUIRE_HTTPS": "",
                "RESET_ENABLED": "",
            },
        ):
            get_settings.cache_clear()
            try:
                settings = get_settings()
            finally:
                get_settings.cache_clear()
        self.assertTrue(settings.require_https)
        self.assertFalse(settings.reset_enabled)

    def test_scope_origin_preserves_custom_port_and_trusted_forwarded_scheme(self):
        lan_scope = {
            "scheme": "http",
            "headers": [
                (b"host", b"192.168.1.10:5173"),
            ],
            "client": ("192.168.1.20", 5000),
        }
        self.assertEqual(_scope_origin(lan_scope), "http://192.168.1.10:5173")

        proxied_scope = {
            "scheme": "http",
            "headers": [
                (b"host", b"app.example.test"),
                (b"x-forwarded-host", b"app.example.test"),
                (b"x-forwarded-proto", b"https"),
            ],
            "client": ("172.20.0.4", 5000),
        }
        self.assertEqual(
            _scope_origin(
                proxied_scope,
                trust_proxy_headers=True,
                trusted_proxy_networks=("172.16.0.0/12",),
            ),
            "https://app.example.test",
        )

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

    async def request(self, path, method="POST"):
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
                "method": method,
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
        self.assertEqual(await self.request("/api/interaction/search-events", "GET"), 400)
        self.status = 201
        self.assertEqual(await self.request("/api/interaction/search-events", "GET"), 201)
        self.status = 400
        self.assertEqual(await self.request("/api/interaction/search-events", "GET"), 400)
        self.assertEqual(await self.request("/api/interaction/search-events", "GET"), 429)

    async def test_successful_session_creation_is_bounded(self):
        self.assertEqual(await self.request("/api/interaction/sessions"), 201)
        self.assertEqual(await self.request("/api/interaction/sessions"), 201)
        self.assertEqual(await self.request("/api/interaction/sessions"), 429)

    async def test_successful_writes_are_bounded_before_route_execution(self):
        self.assertEqual(await self.request("/api/interaction/search-events"), 201)
        self.assertEqual(await self.request("/api/interaction/search-events"), 201)
        self.assertEqual(await self.request("/api/interaction/search-events"), 429)

    async def test_denied_principal_does_not_poison_client_or_endpoint_buckets(self):
        principal_key = "interaction-principal:203.0.113.10"
        client_key = "interaction-client:203.0.113.10"
        endpoint_key = "interaction-write-endpoint:POST:/api/interaction/search-events:203.0.113.10"
        for _ in range(self.middleware.write_principal_limiter.max_attempts):
            self.middleware.write_principal_limiter.record_attempt(principal_key)

        status = await self.request(
            "/api/interaction/search-events",
            "POST",
        )
        self.assertEqual(status, 429)
        self.assertTrue(self.middleware.write_client_limiter.check(client_key).allowed)
        self.assertTrue(self.middleware.write_endpoint_limiter.check(endpoint_key).allowed)


class CSRFMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_origin_lan_request_with_port_is_allowed(self):
        async def app(_scope, _receive, send):
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        middleware = CSRFMiddleware(app, allowed_origins=())
        status = None

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]

        await middleware(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/auth/login",
                "scheme": "http",
                "headers": [
                    (b"host", b"192.168.1.10:5173"),
                    (b"origin", b"http://192.168.1.10:5173"),
                ],
                "client": ("192.168.1.20", 1234),
            },
            receive,
            send,
        )
        self.assertEqual(status, 204)


if __name__ == "__main__":
    unittest.main()
