-- Repair rating/watch links after the pre-global-idempotency cleanup.
--
-- Migration 012 retained ratings and watches independently. A raced signal
-- could therefore leave a retained rating detached even though the retained
-- watch row with the same mutation id still exists under the other session
-- scope. Restore same-scope links first; for a cross-scope survivor, clone
-- the retained watch metrics into the rating's scope before linking it. The
-- clone deliberately has no mutation id so the global idempotency invariant
-- remains one event per client mutation while historical watch minutes stay
-- attached to the rating.

UPDATE interaction.ratings AS rating
SET watch_session_id = watch.watch_session_id
FROM interaction.watch_sessions AS watch
WHERE rating.watch_session_id IS NULL
  AND rating.client_mutation_id IS NOT NULL
  AND watch.client_mutation_id = rating.client_mutation_id
  AND watch.session_id = rating.session_id
  AND watch.title_id = rating.title_id;

CREATE TEMP TABLE interaction_rating_watch_repairs ON COMMIT DROP AS
SELECT
    rating.rating_id,
    rating.session_id AS target_session_id,
    rating.title_id AS target_title_id,
    (md5('rating-watch-repair:' || rating.rating_id::text || ':' || watch.watch_session_id::text))::uuid
        AS repaired_watch_session_id,
    watch.watch_seconds,
    watch.runtime_seconds,
    watch.completion_rate,
    watch.duration_basis,
    watch.started_at,
    watch.ended_at,
    watch.recorded_at,
    watch.client_occurred_at,
    watch.client_device_id,
    watch.client_event_sequence
FROM interaction.ratings AS rating
JOIN interaction.watch_sessions AS watch
  ON watch.client_mutation_id = rating.client_mutation_id
WHERE rating.watch_session_id IS NULL
  AND rating.client_mutation_id IS NOT NULL
  AND (watch.session_id <> rating.session_id OR watch.title_id <> rating.title_id);

INSERT INTO interaction.watch_sessions (
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
)
SELECT
    repaired_watch_session_id,
    target_session_id,
    target_title_id,
    watch_seconds,
    runtime_seconds,
    completion_rate,
    duration_basis,
    started_at,
    ended_at,
    recorded_at,
    client_occurred_at,
    NULL,
    client_device_id,
    client_event_sequence
FROM interaction_rating_watch_repairs
ON CONFLICT (watch_session_id) DO NOTHING;

UPDATE interaction.ratings AS rating
SET watch_session_id = repair.repaired_watch_session_id
FROM interaction_rating_watch_repairs AS repair
WHERE rating.rating_id = repair.rating_id
  AND rating.watch_session_id IS NULL;
