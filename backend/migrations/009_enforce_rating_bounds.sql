-- Enforce the public 0.5-to-10 rating contract at the database boundary.
-- Applied migrations are immutable; future changes require another file.

ALTER TABLE interaction.ratings
    DROP CONSTRAINT IF EXISTS ratings_value_ck;

ALTER TABLE interaction.ratings
    ADD CONSTRAINT ratings_value_ck CHECK (
        rating_value >= 0.5 AND rating_value <= 10
    );
