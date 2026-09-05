CREATE SCHEMA IF NOT EXISTS interaction;

CREATE TABLE IF NOT EXISTS interaction.sessions (
    session_id UUID PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMPTZ,
    locale VARCHAR(16),
    platform VARCHAR(32),
    CONSTRAINT sessions_time_order_ck CHECK (
        ended_at IS NULL OR ended_at >= started_at
    ),
    CONSTRAINT sessions_locale_ck CHECK (
        locale IS NULL OR length(trim(locale)) > 0
    ),
    CONSTRAINT sessions_platform_ck CHECK (
        platform IS NULL OR length(trim(platform)) > 0
    )
);

CREATE TABLE IF NOT EXISTS interaction.search_events (
    search_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interaction.sessions(session_id) ON DELETE CASCADE,
    query_text VARCHAR(200) NOT NULL,
    normalized_query VARCHAR(200) NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT search_events_query_ck CHECK (length(trim(query_text)) > 0),
    CONSTRAINT search_events_normalized_query_ck CHECK (length(trim(normalized_query)) > 0),
    CONSTRAINT search_events_result_count_ck CHECK (result_count >= 0),
    CONSTRAINT search_events_filters_ck CHECK (jsonb_typeof(filters) = 'object')
);

CREATE TABLE IF NOT EXISTS interaction.watch_sessions (
    watch_session_id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interaction.sessions(session_id) ON DELETE CASCADE,
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE RESTRICT,
    watch_seconds INTEGER NOT NULL,
    runtime_seconds INTEGER,
    completion_rate NUMERIC(8, 4),
    duration_basis VARCHAR(32) NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT watch_sessions_watch_seconds_ck CHECK (watch_seconds >= 0),
    CONSTRAINT watch_sessions_runtime_ck CHECK (
        runtime_seconds IS NULL OR runtime_seconds > 0
    ),
    CONSTRAINT watch_sessions_completion_ck CHECK (
        completion_rate IS NULL OR completion_rate BETWEEN 0 AND 1
    ),
    CONSTRAINT watch_sessions_duration_basis_ck CHECK (
        duration_basis IN ('movie_minutes', 'tv_seasons', 'episode_progress', 'unknown')
    ),
    CONSTRAINT watch_sessions_time_order_ck CHECK (
        ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at
    )
);

CREATE TABLE IF NOT EXISTS interaction.ratings (
    rating_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interaction.sessions(session_id) ON DELETE CASCADE,
    watch_session_id UUID REFERENCES interaction.watch_sessions(watch_session_id) ON DELETE SET NULL,
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE RESTRICT,
    rating_value NUMERIC(3, 1) NOT NULL,
    rated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ratings_value_ck CHECK (rating_value BETWEEN 0 AND 10),
    CONSTRAINT ratings_session_watch_ck CHECK (
        watch_session_id IS NULL OR session_id IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS interaction.favorites (
    favorite_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interaction.sessions(session_id) ON DELETE CASCADE,
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE RESTRICT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS interaction.watchlist_items (
    watchlist_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES interaction.sessions(session_id) ON DELETE CASCADE,
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE RESTRICT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS favorites_active_uidx
    ON interaction.favorites (session_id, title_id)
    WHERE removed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS watchlist_items_active_uidx
    ON interaction.watchlist_items (session_id, title_id)
    WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS search_events_session_time_idx
    ON interaction.search_events (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS search_events_normalized_query_idx
    ON interaction.search_events (normalized_query);

CREATE INDEX IF NOT EXISTS watch_sessions_session_time_idx
    ON interaction.watch_sessions (session_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS watch_sessions_title_idx
    ON interaction.watch_sessions (title_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS ratings_session_time_idx
    ON interaction.ratings (session_id, rated_at DESC);

CREATE INDEX IF NOT EXISTS ratings_session_title_time_idx
    ON interaction.ratings (session_id, title_id, rated_at DESC);

CREATE INDEX IF NOT EXISTS favorites_session_active_idx
    ON interaction.favorites (session_id, added_at DESC)
    WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS watchlist_session_active_idx
    ON interaction.watchlist_items (session_id, added_at DESC)
    WHERE removed_at IS NULL;
