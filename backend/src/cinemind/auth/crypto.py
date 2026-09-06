"""Small, dependency-free cryptographic helpers for account sessions."""

import base64
import hashlib
import hmac
from functools import lru_cache
import secrets


PASSWORD_SCHEME = "pbkdf2_sha256"
PASSWORD_SALT_BYTES = 16
_DUMMY_PASSWORD = b"CineMind authentication sentinel"
_DUMMY_PASSWORD_SALT = b"CineMindDummySalt"


def hash_password(password: str, iterations: int) -> str:
    """Hash a password with a per-account salt and explicit work factor."""

    salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
    )
    encoded_salt = base64.urlsafe_b64encode(salt).decode("ascii")
    return f"{PASSWORD_SCHEME}${iterations}${encoded_salt}${digest.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    """Verify a password without revealing whether the account exists."""

    try:
        scheme, raw_iterations, encoded_salt, expected_hex = encoded_hash.split("$", 3)
        iterations = int(raw_iterations)
        salt = base64.urlsafe_b64decode(encoded_salt.encode("ascii"))
        expected = bytes.fromhex(expected_hex)
    except (AttributeError, ValueError, TypeError):
        return False

    if scheme != PASSWORD_SCHEME or iterations <= 0 or not expected:
        return False

    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


@lru_cache(maxsize=8)
def dummy_password_hash(iterations: int) -> str:
    """Create a valid dummy hash so unknown-user login takes the same work path."""

    if iterations <= 0:
        raise ValueError("Password iterations must be positive")
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        _DUMMY_PASSWORD,
        _DUMMY_PASSWORD_SALT,
        iterations,
    )
    encoded_salt = base64.urlsafe_b64encode(_DUMMY_PASSWORD_SALT).decode("ascii")
    return f"{PASSWORD_SCHEME}${iterations}${encoded_salt}${digest.hex()}"


def hash_session_token(token: str) -> str:
    """Store only a one-way digest of a browser session token."""

    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_token() -> str:
    """Create a high-entropy opaque cookie value."""

    return secrets.token_urlsafe(48)
