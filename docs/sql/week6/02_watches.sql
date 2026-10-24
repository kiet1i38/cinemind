-- Replace EXPORT_CUTOFF with the exact timestamptz returned by 00_export_context.sql.
WITH params AS (
    SELECT
        'EXPORT_CUTOFF'::timestamptz AS cutoff,
        'unknown'::text AS cohort
)
SELECT
    md5('watch:' || w.watch_session_id::text) AS watch_key,
    md5(s.user_id::text) AS user_key,
    p.cohort,
    t.show_id,
    w.watch_seconds,
    w.completion_rate,
    w.duration_basis,
    COALESCE(w.client_occurred_at, w.recorded_at) AS recorded_at
FROM interaction.watch_sessions_for_mining AS w
JOIN interaction.sessions AS s
    ON s.session_id = w.session_id
JOIN catalog.titles AS t
    ON t.title_id = w.title_id
CROSS JOIN params AS p
WHERE s.user_id IS NOT NULL
  AND w.recorded_at < p.cutoff
  AND COALESCE(w.client_occurred_at, w.recorded_at) < p.cutoff
ORDER BY recorded_at, watch_key;
