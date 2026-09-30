-- Read-only Week 4 readiness audit. Export this single result as
-- tmp/week4_readiness.csv (columns: check_name, observed_value).
-- It returns aggregates only: no user/session/device IDs or search text.
WITH rating_audit AS (
    SELECT r.rating_value, r.rated_at, s.user_id, t.title_id AS matched_title_id,
           r.watch_session_id
    FROM interaction.ratings AS r
    LEFT JOIN interaction.sessions AS s ON s.session_id = r.session_id
    LEFT JOIN catalog.titles AS t ON t.title_id = r.title_id
), watch_audit AS (
    SELECT w.watch_seconds, w.completion_rate, w.recorded_at,
           s.user_id, t.title_id AS matched_title_id
    FROM interaction.watch_sessions_for_mining AS w
    LEFT JOIN interaction.sessions AS s ON s.session_id = w.session_id
    LEFT JOIN catalog.titles AS t ON t.title_id = w.title_id
), search_audit AS (
    SELECT e.occurred_at, s.user_id
    FROM interaction.search_events AS e
    LEFT JOIN interaction.sessions AS s ON s.session_id = e.session_id
), checks AS (
    SELECT 'ratings_rows'::text AS check_name, COUNT(*)::text AS observed_value FROM rating_audit
    UNION ALL SELECT 'ratings_owner_missing', COUNT(*)::text FROM rating_audit WHERE user_id IS NULL
    UNION ALL SELECT 'ratings_title_missing', COUNT(*)::text FROM rating_audit WHERE matched_title_id IS NULL
    UNION ALL SELECT 'ratings_unmapped_labels', COUNT(*)::text FROM rating_audit WHERE rating_value IN (3.5, 6.5)
    UNION ALL SELECT 'ratings_duplicate_mutations', COUNT(*)::text FROM (
      SELECT session_id, client_mutation_id FROM interaction.ratings
      WHERE client_mutation_id IS NOT NULL GROUP BY session_id, client_mutation_id HAVING COUNT(*) > 1
    ) AS duplicates
    UNION ALL SELECT 'ratings_zero_values', COUNT(*)::text FROM rating_audit WHERE rating_value = 0
    UNION ALL SELECT 'ratings_min_time', COALESCE(MIN(rated_at)::text, '') FROM rating_audit
    UNION ALL SELECT 'ratings_max_time', COALESCE(MAX(rated_at)::text, '') FROM rating_audit
    UNION ALL SELECT 'watches_rows', COUNT(*)::text FROM watch_audit
    UNION ALL SELECT 'watches_owner_missing', COUNT(*)::text FROM watch_audit WHERE user_id IS NULL
    UNION ALL SELECT 'watches_title_missing', COUNT(*)::text FROM watch_audit WHERE matched_title_id IS NULL
    UNION ALL SELECT 'watches_duplicate_mutations', COUNT(*)::text FROM (
      SELECT session_id, client_mutation_id FROM interaction.watch_sessions_for_mining
      WHERE client_mutation_id IS NOT NULL GROUP BY session_id, client_mutation_id HAVING COUNT(*) > 1
    ) AS duplicates
    UNION ALL SELECT 'watches_invalid_values', COUNT(*)::text FROM watch_audit
      WHERE watch_seconds < 0 OR (completion_rate IS NOT NULL AND (completion_rate < 0 OR completion_rate > 1))
    UNION ALL SELECT 'watches_repair_rows_excluded',
      ((SELECT COUNT(*) FROM interaction.watch_sessions) - COUNT(*))::text
      FROM interaction.watch_sessions_for_mining
    UNION ALL SELECT 'watches_min_time', COALESCE(MIN(recorded_at)::text, '') FROM watch_audit
    UNION ALL SELECT 'watches_max_time', COALESCE(MAX(recorded_at)::text, '') FROM watch_audit
    UNION ALL SELECT 'searches_rows', COUNT(*)::text FROM search_audit
    UNION ALL SELECT 'searches_owner_missing', COUNT(*)::text FROM search_audit WHERE user_id IS NULL
    UNION ALL SELECT 'searches_duplicate_mutations', COUNT(*)::text FROM (
      SELECT session_id, client_mutation_id FROM interaction.search_events
      WHERE client_mutation_id IS NOT NULL GROUP BY session_id, client_mutation_id HAVING COUNT(*) > 1
    ) AS duplicates
    UNION ALL SELECT 'searches_min_time', COALESCE(MIN(occurred_at)::text, '') FROM search_audit
    UNION ALL SELECT 'searches_max_time', COALESCE(MAX(occurred_at)::text, '') FROM search_audit
    UNION ALL SELECT 'linked_watch_at_or_after_rating', COUNT(*)::text
      FROM rating_audit AS r
      JOIN interaction.watch_sessions_for_mining AS w ON w.watch_session_id = r.watch_session_id
      WHERE w.recorded_at >= r.rated_at
)
SELECT check_name, observed_value
FROM checks
ORDER BY check_name;
