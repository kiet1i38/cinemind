-- The product now stores one interaction type: ratings plus watch duration.
-- Remove the retired preference tables and give anonymous sessions a bounded
-- lifetime so stale browser proofs cannot be reused indefinitely.

DROP TABLE IF EXISTS interaction.favorites CASCADE;
DROP TABLE IF EXISTS interaction.watchlist_items CASCADE;

ALTER TABLE interaction.sessions
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE interaction.sessions
SET expires_at = COALESCE(expires_at, started_at + INTERVAL '30 days')
WHERE expires_at IS NULL;

ALTER TABLE interaction.sessions
    ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE interaction.sessions
    DROP CONSTRAINT IF EXISTS sessions_expiry_order_ck;

ALTER TABLE interaction.sessions
    ADD CONSTRAINT sessions_expiry_order_ck CHECK (expires_at >= started_at);

CREATE INDEX IF NOT EXISTS interaction_sessions_expiry_idx
    ON interaction.sessions (expires_at)
    WHERE ended_at IS NULL;
