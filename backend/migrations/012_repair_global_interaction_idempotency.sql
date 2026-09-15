-- Repair any duplicate mutation ids created before global idempotency was
-- enforced, then make the invariant database-backed for concurrent writers.
-- Keep the earliest event for a mutation id; it is the event that could have
-- been acknowledged before a later retry raced in through another session.

WITH ranked AS (
    SELECT
        search_event_id,
        ROW_NUMBER() OVER (
            PARTITION BY client_mutation_id
            ORDER BY search_event_id ASC
        ) AS duplicate_rank
    FROM interaction.search_events
    WHERE client_mutation_id IS NOT NULL
)
DELETE FROM interaction.search_events AS event
USING ranked
WHERE event.search_event_id = ranked.search_event_id
  AND ranked.duplicate_rank > 1;

WITH ranked AS (
    SELECT
        rating_id,
        ROW_NUMBER() OVER (
            PARTITION BY client_mutation_id
            ORDER BY rating_id ASC
        ) AS duplicate_rank
    FROM interaction.ratings
    WHERE client_mutation_id IS NOT NULL
)
DELETE FROM interaction.ratings AS rating
USING ranked
WHERE rating.rating_id = ranked.rating_id
  AND ranked.duplicate_rank > 1;

-- Ratings retain a composite foreign key to their watch session. Repoint a
-- duplicate watch reference to the retained row when its session/title scope
-- still matches; otherwise detach it before deleting the duplicate watch.
WITH ranked AS (
    SELECT
        watch_session_id,
        session_id,
        title_id,
        ROW_NUMBER() OVER (
            PARTITION BY client_mutation_id
            ORDER BY recorded_at ASC, watch_session_id ASC
        ) AS duplicate_rank,
        FIRST_VALUE(watch_session_id) OVER (
            PARTITION BY client_mutation_id
            ORDER BY recorded_at ASC, watch_session_id ASC
        ) AS retained_watch_session_id,
        FIRST_VALUE(session_id) OVER (
            PARTITION BY client_mutation_id
            ORDER BY recorded_at ASC, watch_session_id ASC
        ) AS retained_session_id,
        FIRST_VALUE(title_id) OVER (
            PARTITION BY client_mutation_id
            ORDER BY recorded_at ASC, watch_session_id ASC
        ) AS retained_title_id
    FROM interaction.watch_sessions
    WHERE client_mutation_id IS NOT NULL
)
UPDATE interaction.ratings AS rating
SET watch_session_id = CASE
    WHEN rating.session_id = ranked.retained_session_id
     AND rating.title_id = ranked.retained_title_id
        THEN ranked.retained_watch_session_id
    ELSE NULL
END
FROM ranked
WHERE ranked.duplicate_rank > 1
  AND rating.watch_session_id = ranked.watch_session_id;

WITH ranked AS (
    SELECT
        watch_session_id,
        ROW_NUMBER() OVER (
            PARTITION BY client_mutation_id
            ORDER BY recorded_at ASC, watch_session_id ASC
        ) AS duplicate_rank
    FROM interaction.watch_sessions
    WHERE client_mutation_id IS NOT NULL
)
DELETE FROM interaction.watch_sessions AS watch
USING ranked
WHERE watch.watch_session_id = ranked.watch_session_id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS search_events_mutation_global_uidx
    ON interaction.search_events (client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS watch_sessions_mutation_global_uidx
    ON interaction.watch_sessions (client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ratings_mutation_global_uidx
    ON interaction.ratings (client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;
