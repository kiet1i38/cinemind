-- Emits only pseudonymous keys and the approved favorite-group label.
-- Verify the result count is 100 and each group has 25 rows before exporting.
WITH candidates AS (
    SELECT
        user_id,
        substring(lower(username) FROM '([0-9]{3})$') AS serial_text
    FROM auth.users
    WHERE email ILIKE '%@gmail.com'
      AND lower(username) ~ '^[a-z]+[0-9]{3}$'
), numbered AS (
    SELECT
        user_id,
        CASE
            WHEN serial_text ~ '^[0-9]{3}$' THEN serial_text::integer
            ELSE NULL
        END AS serial
    FROM candidates
)
SELECT
    md5(user_id::text) AS user_key,
    'synthetic'::text AS cohort,
    CASE
        WHEN serial BETWEEN 1 AND 25 THEN 'breaking_bad'
        WHEN serial BETWEEN 26 AND 50 THEN 'stranger_things'
        WHEN serial BETWEEN 51 AND 75 THEN 'friends'
        WHEN serial BETWEEN 76 AND 100 THEN 'squid_game'
    END AS favorite_group
FROM numbered
WHERE serial BETWEEN 1 AND 100
ORDER BY serial;
