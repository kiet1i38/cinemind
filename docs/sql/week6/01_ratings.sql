-- Replace EXPORT_CUTOFF with the exact timestamptz returned by 00_export_context.sql.
WITH params AS (
    SELECT
        'EXPORT_CUTOFF'::timestamptz AS cutoff,
        'unknown'::text AS cohort
)
SELECT
    md5(s.user_id::text) AS user_key,
    md5('rating:' || r.rating_id::text) AS target_key,
    p.cohort,
    t.show_id,
    r.rating_value,
    COALESCE(r.client_occurred_at, r.rated_at) AS rated_at
FROM interaction.ratings AS r
JOIN interaction.sessions AS s
    ON s.session_id = r.session_id
JOIN catalog.titles AS t
    ON t.title_id = r.title_id
CROSS JOIN params AS p
WHERE s.user_id IS NOT NULL
  AND r.rated_at < p.cutoff
  AND COALESCE(r.client_occurred_at, r.rated_at) < p.cutoff
ORDER BY rated_at, target_key;
