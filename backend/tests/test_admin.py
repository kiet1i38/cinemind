"""Unit tests for protected reset scopes and the public OpenAPI boundary."""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from fastapi.security import HTTPBasicCredentials

from cinemind.admin.routes import _require_admin
from cinemind.admin.schemas import ResetRequest, ResetScope
from cinemind.admin.service import ResetService, ResetValidationError
from cinemind.main import app


class FakeTransaction:
    """Transaction spy for reset service tests."""

    def __init__(self, repository):
        self.repository = repository

    def __enter__(self):
        self.repository.transactions_started += 1
        return self

    def __exit__(self, error_type, _error, _traceback):
        if error_type:
            self.repository.transactions_rolled_back += 1
        else:
            self.repository.transactions_committed += 1
        return False


class FakeResetRepository:
    """In-memory repository that records which reset scope was requested."""

    def __init__(self):
        self.transactions_started = 0
        self.transactions_committed = 0
        self.transactions_rolled_back = 0
        self.calls = []

    def transaction(self):
        return FakeTransaction(self)

    def delete_session_interactions(self, session_id):
        self.calls.append(("session", session_id))
        return {"interaction.sessions": 1, "interaction.ratings": 2}

    def delete_all_interactions(self):
        self.calls.append(("interaction",))
        return {"interaction.sessions": 3, "interaction.ratings": 4}

    def delete_all_application_data(self):
        self.calls.append(("full",))
        return {"interaction.sessions": 3, "catalog.titles": 8}


class ResetServiceTests(TestCase):
    """Protect confirmation, scope mapping, and full reseed behavior."""

    def setUp(self):
        self.repository = FakeResetRepository()
        self.settings = SimpleNamespace(full_reset_enabled=True)
        self.service = ResetService(self.repository, self.settings)

    def test_interaction_scope_requires_session_and_clears_only_that_session(self):
        session_id = uuid4()
        result = self.service.reset(ResetRequest(
            scope=ResetScope.INTERACTION,
            session_id=session_id,
            confirmation="RESET CURRENT SESSION",
        ))

        self.assertEqual(self.repository.calls, [("session", session_id)])
        self.assertEqual(result["scope"], ResetScope.INTERACTION)
        self.assertFalse(result["catalog_reseeded"])
        self.assertEqual(self.repository.transactions_committed, 1)

    def test_demo_scope_preserves_catalog_and_clears_all_interactions(self):
        result = self.service.reset(ResetRequest(
            scope=ResetScope.DEMO,
            confirmation="RESET DEMO DATA",
        ))

        self.assertEqual(self.repository.calls, [("interaction",)])
        self.assertEqual(result["scope"], ResetScope.DEMO)
        self.assertIsNone(result["catalog_summary"])

    def test_full_scope_reseeds_the_catalog_after_clearing_data(self):
        bootstrap_result = {
            "rows_loaded": 8807,
            "catalog_summary": {"total": 8807, "movies": 6131},
        }
        with patch("cinemind.admin.service.bootstrap_catalog", return_value=bootstrap_result):
            result = self.service.reset(ResetRequest(
                scope=ResetScope.FULL,
                confirmation="RESET FULL DATABASE",
            ))

        self.assertEqual(self.repository.calls, [("full",)])
        self.assertTrue(result["catalog_reseeded"])
        self.assertEqual(result["seeded_catalog_rows"], 8807)
        self.assertEqual(result["catalog_summary"]["total"], 8807)

    def test_wrong_confirmation_is_rejected_before_a_transaction(self):
        with self.assertRaises(ResetValidationError):
            self.service.reset(ResetRequest(
                scope=ResetScope.DEMO,
                confirmation="RESET FULL DATABASE",
            ))
        self.assertEqual(self.repository.transactions_started, 0)

    def test_interaction_scope_without_session_is_rejected(self):
        with self.assertRaises(ResetValidationError):
            self.service.reset(ResetRequest(
                scope=ResetScope.INTERACTION,
                confirmation="RESET CURRENT SESSION",
            ))


class AdminBoundaryTests(TestCase):
    """Ensure credentials are server-side and the reset route stays out of docs."""

    def setUp(self):
        self.settings = SimpleNamespace(
            reset_enabled=True,
            admin_reset_username="maintainer",
            admin_reset_password="long-local-secret",
        )

    def test_valid_basic_auth_is_accepted(self):
        _require_admin(
            HTTPBasicCredentials(username="maintainer", password="long-local-secret"),
            self.settings,
        )

    def test_invalid_basic_auth_is_rejected(self):
        with self.assertRaises(HTTPException) as context:
            _require_admin(
                HTTPBasicCredentials(username="maintainer", password="wrong"),
                self.settings,
            )
        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.headers["WWW-Authenticate"], "Basic")

    def test_missing_credentials_are_rejected(self):
        with self.assertRaises(HTTPException) as context:
            _require_admin(None, self.settings)
        self.assertEqual(context.exception.status_code, 401)

    def test_reset_route_is_not_exposed_in_openapi(self):
        self.assertNotIn("/api/admin/reset", app.openapi()["paths"])
