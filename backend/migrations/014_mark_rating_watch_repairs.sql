-- Give the historical rating/watch repair rows explicit provenance.
--
-- Migration 013 had to preserve watch minutes while repairing a cross-scope
-- foreign-key link, so it copied the watch metrics into a second row. Those
-- rows are useful for reconstructing the rating, but they are not additional
-- user watch events. Mark them and expose a canonical mining projection that
-- excludes them from event counts and aggregates.

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS is_repair BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE interaction.watch_sessions
    ADD COLUMN IF NOT EXISTS repair_source_watch_session_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'interaction.watch_sessions'::regclass
          AND conname = 'watch_sessions_repair_source_fk'
    ) THEN
        ALTER TABLE interaction.watch_sessions
            ADD CONSTRAINT watch_sessions_repair_source_fk
            FOREIGN KEY (repair_source_watch_session_id)
            REFERENCES interaction.watch_sessions (watch_session_id)
            ON DELETE SET NULL;
    END IF;
END
$$;

-- Migration 013 generated repair ids deterministically from the retained
-- rating and source watch ids. Use the same formula to backfill provenance on
-- databases that already ran that migration.
UPDATE interaction.watch_sessions AS repair
SET is_repair = TRUE,
    repair_source_watch_session_id = source.watch_session_id
FROM interaction.ratings AS rating
JOIN interaction.watch_sessions AS source
  ON source.client_mutation_id = rating.client_mutation_id
WHERE rating.watch_session_id = repair.watch_session_id
  AND rating.client_mutation_id IS NOT NULL
  AND repair.client_mutation_id IS NULL
  AND repair.watch_session_id = (
      md5('rating-watch-repair:' || rating.rating_id::text || ':' || source.watch_session_id::text)
  )::uuid
  AND (source.session_id <> rating.session_id OR source.title_id <> rating.title_id);

CREATE INDEX IF NOT EXISTS watch_sessions_mining_idx
    ON interaction.watch_sessions (session_id, recorded_at DESC)
    WHERE is_repair = FALSE;

CREATE OR REPLACE VIEW interaction.watch_sessions_for_mining AS
SELECT
    watch_session_id,
    session_id,
    title_id,
    watch_seconds,
    runtime_seconds,
    completion_rate,
    duration_basis,
    started_at,
    ended_at,
    recorded_at,
    client_occurred_at,
    client_mutation_id,
    client_device_id,
    client_event_sequence
FROM interaction.watch_sessions
WHERE is_repair = FALSE;
