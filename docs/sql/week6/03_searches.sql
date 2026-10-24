-- Replace EXPORT_CUTOFF with the exact timestamptz returned by 00_export_context.sql.
-- Search text and filters are intentionally omitted from this export.
WITH params AS (
    SELECT
        'EXPORT_CUTOFF'::timestamptz AS cutoff,
        'unknown'::text AS cohort
)
SELECT
    md5('search:' || e.search_event_id::text) AS search_key,
    md5(s.user_id::text) AS user_key,
    p.cohort,
    COALESCE(e.client_occurred_at, e.occurred_at) AS occurred_at
FROM interaction.search_events AS e
JOIN interaction.sessions AS s
    ON s.session_id = e.session_id
CROSS JOIN params AS p
WHERE s.user_id IS NOT NULL
  AND e.occurred_at < p.cutoff
  AND COALESCE(e.client_occurred_at, e.occurred_at) < p.cutoff
ORDER BY occurred_at, search_key;
