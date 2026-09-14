-- Preserve the time an interaction happened in the browser separately from
-- the server receipt time. Client timestamps are advisory and are accepted
-- only when they pass the service clock-skew policy.

ALTER TABLE interaction.search_events
    ADD COLUMN IF NOT EXISTS client_occurred_at TIMESTAMPTZ;

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS client_occurred_at TIMESTAMPTZ;

ALTER TABLE interaction.ratings
    ADD COLUMN IF NOT EXISTS client_occurred_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS search_events_client_time_idx
    ON interaction.search_events (session_id, client_occurred_at DESC)
    WHERE client_occurred_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS watch_sessions_client_time_idx
    ON interaction.watch_sessions (session_id, client_occurred_at DESC)
    WHERE client_occurred_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ratings_client_time_idx
    ON interaction.ratings (session_id, title_id, client_occurred_at DESC)
    WHERE client_occurred_at IS NOT NULL;
