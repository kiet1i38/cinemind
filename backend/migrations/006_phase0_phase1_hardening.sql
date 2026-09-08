-- Phase 0/1 hardening: bind browser sessions, make writes replay-safe, and
-- preserve catalog/source history without serving titles removed from source.

ALTER TABLE interaction.sessions
    ADD COLUMN IF NOT EXISTS session_token_hash CHAR(64);

UPDATE interaction.sessions
SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
WHERE session_token_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS interaction_sessions_token_hash_uidx
    ON interaction.sessions (session_token_hash)
    WHERE session_token_hash IS NOT NULL;

ALTER TABLE interaction.search_events
    ADD COLUMN IF NOT EXISTS client_mutation_id UUID;

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS client_mutation_id UUID;

ALTER TABLE interaction.ratings
    ADD COLUMN IF NOT EXISTS client_mutation_id UUID;

ALTER TABLE interaction.favorites
    ADD COLUMN IF NOT EXISTS client_mutation_id UUID;

ALTER TABLE interaction.watchlist_items
    ADD COLUMN IF NOT EXISTS client_mutation_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS search_events_mutation_uidx
    ON interaction.search_events (session_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS watch_sessions_mutation_uidx
    ON interaction.watch_sessions (session_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ratings_mutation_uidx
    ON interaction.ratings (session_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS favorites_mutation_uidx
    ON interaction.favorites (session_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS watchlist_items_mutation_uidx
    ON interaction.watchlist_items (session_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

ALTER TABLE interaction.watch_sessions
    ADD CONSTRAINT watch_sessions_scope_uq
    UNIQUE (watch_session_id, session_id, title_id);

UPDATE interaction.ratings AS r
SET watch_session_id = NULL
WHERE r.watch_session_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM interaction.watch_sessions AS ws
      WHERE ws.watch_session_id = r.watch_session_id
        AND ws.session_id = r.session_id
        AND ws.title_id = r.title_id
  );

ALTER TABLE interaction.ratings
    ADD CONSTRAINT ratings_watch_session_scope_fk
    FOREIGN KEY (watch_session_id, session_id, title_id)
    REFERENCES interaction.watch_sessions (watch_session_id, session_id, title_id);

ALTER TABLE catalog.titles
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE catalog.titles
    ADD COLUMN IF NOT EXISTS source_checksum_sha256 CHAR(64);

CREATE INDEX IF NOT EXISTS titles_active_type_year_idx
    ON catalog.titles (is_active, content_type, release_year DESC);
