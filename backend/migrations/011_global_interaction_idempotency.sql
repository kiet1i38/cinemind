-- Keep mutation lookup global so a retry after interaction-session rotation
-- resolves to the original event instead of creating a second event.
-- The application write path holds the global interaction write lock while it
-- performs the lookup and insert; these indexes make that lookup bounded.
CREATE INDEX IF NOT EXISTS search_events_mutation_lookup_idx
    ON interaction.search_events (client_mutation_id, search_event_id DESC)
    WHERE client_mutation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS watch_sessions_mutation_lookup_idx
    ON interaction.watch_sessions (client_mutation_id, recorded_at DESC)
    WHERE client_mutation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ratings_mutation_lookup_idx
    ON interaction.ratings (client_mutation_id, rating_id DESC)
    WHERE client_mutation_id IS NOT NULL;

-- A browser device id and monotonic sequence let state projection order
-- retries from one browser without trusting a wall-clock that may be wrong.
ALTER TABLE interaction.search_events
    ADD COLUMN IF NOT EXISTS client_device_id UUID;

ALTER TABLE interaction.search_events
    ADD COLUMN IF NOT EXISTS client_event_sequence BIGINT;

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS client_device_id UUID;

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS client_event_sequence BIGINT;

ALTER TABLE interaction.ratings
    ADD COLUMN IF NOT EXISTS client_device_id UUID;

ALTER TABLE interaction.ratings
    ADD COLUMN IF NOT EXISTS client_event_sequence BIGINT;

ALTER TABLE interaction.search_events
    ADD CONSTRAINT search_events_client_sequence_ck
    CHECK (client_event_sequence IS NULL OR client_event_sequence > 0);

ALTER TABLE interaction.watch_sessions
    ADD CONSTRAINT watch_sessions_client_sequence_ck
    CHECK (client_event_sequence IS NULL OR client_event_sequence > 0);

ALTER TABLE interaction.ratings
    ADD CONSTRAINT ratings_client_sequence_ck
    CHECK (client_event_sequence IS NULL OR client_event_sequence > 0);

CREATE INDEX IF NOT EXISTS ratings_device_sequence_idx
    ON interaction.ratings (title_id, client_device_id, client_event_sequence DESC)
    WHERE client_event_sequence IS NOT NULL;
