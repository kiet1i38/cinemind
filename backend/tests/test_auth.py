"""Unit tests for account normalization, hashing, and session ownership."""

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4
import unittest

from cinemind.auth.crypto import hash_password, verify_password
from cinemind.auth.service import (
    AuthService,
    AuthValidationError,
    DuplicateAccountError,
    InvalidCredentialsError,
)


class FakeTransaction:
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


class FakeAuthRepository:
    def __init__(self):
        self.users = {}
        self.sessions = []
        self.interaction_sessions = {}
        self.transactions_started = 0
        self.transactions_committed = 0
        self.transactions_rolled_back = 0

    def transaction(self):
        return FakeTransaction(self)

    def get_user_by_identifier(self, identifier):
        normalized = identifier.casefold()
        return next(
            (
                user
                for user in self.users.values()
                if user["email"] == normalized or user["username"] == normalized
            ),
            None,
        )

    def get_user(self, user_id):
        return self.users.get(user_id)

    def create_user(self, user_id, email, username, display_name, password_hash, created_at):
        user = {
            "user_id": user_id,
            "email": email,
            "username": username,
            "display_name": display_name,
            "password_hash": password_hash,
            "is_active": True,
            "created_at": created_at,
            "last_login_at": None,
        }
        self.users[user_id] = user
        return {key: value for key, value in user.items() if key != "password_hash"}

    def set_last_login(self, user_id, logged_in_at):
        self.users[user_id]["last_login_at"] = logged_in_at

    def create_session(self, auth_session_id, user_id, token_hash, created_at, expires_at, user_agent):
        self.sessions.append({"auth_session_id": auth_session_id, "user_id": user_id, "token_hash": token_hash})
        return {"auth_session_id": auth_session_id, "user_id": user_id, "expires_at": expires_at}

    def attach_interaction_session(self, session_id, user_id):
        session = self.interaction_sessions.get(session_id)
        if session is None or session.get("user_id") not in (None, user_id):
            return False
        session["user_id"] = user_id
        return True

    def revoke_session(self, token_hash):
        self.sessions = [session for session in self.sessions if session["token_hash"] != token_hash]

    def revoke_all_sessions(self, user_id):
        self.sessions = [session for session in self.sessions if session["user_id"] != user_id]


class AuthServiceTests(unittest.TestCase):
    def setUp(self):
        self.repository = FakeAuthRepository()
        self.settings = SimpleNamespace(auth_password_iterations=10000, auth_session_ttl_days=30)
        self.service = AuthService(self.repository, self.settings)

    def test_password_hash_is_salted_and_wrong_password_fails(self):
        first = hash_password("a-secure-password", 10000)
        second = hash_password("a-secure-password", 10000)
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("a-secure-password", first))
        self.assertFalse(verify_password("wrong-password", first))

    def test_register_normalizes_account_and_merges_anonymous_session(self):
        session_id = uuid4()
        self.repository.interaction_sessions[session_id] = {"user_id": None}
        result = self.service.register(
            "  Demo@Example.com ",
            " Demo_User ",
            "  Demo   User ",
            "a-secure-password",
            session_id,
            "test-agent",
        )

        user = result["user"]
        self.assertEqual(user["email"], "demo@example.com")
        self.assertEqual(user["username"], "demo_user")
        self.assertEqual(user["display_name"], "Demo User")
        self.assertEqual(self.repository.interaction_sessions[session_id]["user_id"], user["user_id"])
        self.assertNotIn("password_hash", user)
        self.assertTrue(result["token"])

    def test_login_accepts_username_and_rejects_invalid_credentials(self):
        self.service.register("demo@example.com", "demo_user", "Demo", "a-secure-password", None, None)
        result = self.service.login("DEMO_USER", "a-secure-password", None, None)
        self.assertEqual(result["user"]["username"], "demo_user")
        with self.assertRaises(InvalidCredentialsError):
            self.service.login("demo@example.com", "wrong-password", None, None)

    def test_duplicate_and_weak_account_input_are_rejected(self):
        self.service.register("demo@example.com", "demo_user", "Demo", "a-secure-password", None, None)
        with self.assertRaises(DuplicateAccountError):
            self.service.register("DEMO@example.com", "another_user", "Another", "a-secure-password", None, None)
        with self.assertRaises(AuthValidationError):
            self.service.register("new@example.com", "bad name", "New", "short", None, None)


if __name__ == "__main__":
    unittest.main()
