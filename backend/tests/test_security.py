"""Focused tests for bounded request and runtime security primitives."""

from types import SimpleNamespace
import unittest

from cinemind.config import Settings
from cinemind.interaction.limits import normalize_filters
from cinemind.middleware import _interaction_principal
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


if __name__ == "__main__":
    unittest.main()
