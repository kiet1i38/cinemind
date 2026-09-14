-- Runtime integrity indexes and the non-zero rating contract.
-- Applied migrations are immutable; future changes require another file.

CREATE INDEX IF NOT EXISTS auth_sessions_user_created_idx
    ON auth.sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_sessions_retention_idx
    ON auth.sessions (revoked_at, expires_at);
