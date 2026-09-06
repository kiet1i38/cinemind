CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    user_id UUID PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    username VARCHAR(32) NOT NULL,
    display_name VARCHAR(80) NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    CONSTRAINT users_email_ck CHECK (length(trim(email)) > 0),
    CONSTRAINT users_username_ck CHECK (length(trim(username)) >= 3),
    CONSTRAINT users_display_name_ck CHECK (length(trim(display_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
    ON auth.users (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx
    ON auth.users (lower(username));

CREATE TABLE IF NOT EXISTS auth.sessions (
    auth_session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(user_id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    user_agent VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT auth_sessions_expiry_ck CHECK (expires_at > created_at),
    CONSTRAINT auth_sessions_user_agent_ck CHECK (
        user_agent IS NULL OR length(trim(user_agent)) > 0
    )
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
    ON auth.sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
    ON auth.sessions (expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE interaction.sessions
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS interaction_sessions_user_time_idx
    ON interaction.sessions (user_id, last_seen_at DESC)
    WHERE user_id IS NOT NULL;
