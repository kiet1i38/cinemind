ALTER TABLE interaction.ratings
    DROP CONSTRAINT IF EXISTS ratings_session_watch_ck;

ALTER TABLE interaction.ratings
    ADD CONSTRAINT ratings_value_step_ck CHECK (
        rating_value * 2 = trunc(rating_value * 2)
    );
