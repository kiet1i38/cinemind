CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE IF NOT EXISTS catalog.titles (
    title_id BIGSERIAL PRIMARY KEY,
    show_id VARCHAR(32) NOT NULL UNIQUE,
    source_id UUID NOT NULL REFERENCES ops.dataset_sources(source_id),
    content_type VARCHAR(16) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    date_added DATE,
    release_year SMALLINT,
    content_rating VARCHAR(32),
    movie_duration_min INTEGER,
    season_count INTEGER,
    duration_basis VARCHAR(32) NOT NULL,
    poster_provider VARCHAR(64),
    poster_path TEXT,
    poster_url TEXT,
    poster_status VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT titles_content_type_ck CHECK (content_type IN ('Movie', 'TV Show')),
    CONSTRAINT titles_release_year_ck CHECK (
        release_year IS NULL OR release_year BETWEEN 1888 AND 2100
    ),
    CONSTRAINT titles_movie_duration_ck CHECK (
        movie_duration_min IS NULL OR movie_duration_min > 0
    ),
    CONSTRAINT titles_season_count_ck CHECK (
        season_count IS NULL OR season_count > 0
    ),
    CONSTRAINT titles_duration_shape_ck CHECK (
        (content_type = 'Movie' AND season_count IS NULL)
        OR (content_type = 'TV Show' AND movie_duration_min IS NULL)
    ),
    CONSTRAINT titles_duration_basis_ck CHECK (
        duration_basis IN ('movie_minutes', 'tv_seasons', 'episode_progress', 'unknown')
    ),
    CONSTRAINT titles_poster_status_ck CHECK (
        poster_status IN ('pending', 'available', 'fallback', 'unavailable')
    )
);

CREATE TABLE IF NOT EXISTS catalog.title_genres (
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE CASCADE,
    genre_name TEXT NOT NULL CHECK (length(trim(genre_name)) > 0),
    PRIMARY KEY (title_id, genre_name)
);

CREATE TABLE IF NOT EXISTS catalog.title_cast (
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE CASCADE,
    person_name TEXT NOT NULL CHECK (length(trim(person_name)) > 0),
    cast_order SMALLINT NOT NULL DEFAULT 0 CHECK (cast_order >= 0),
    PRIMARY KEY (title_id, person_name)
);

CREATE TABLE IF NOT EXISTS catalog.title_countries (
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE CASCADE,
    country_name TEXT NOT NULL CHECK (length(trim(country_name)) > 0),
    PRIMARY KEY (title_id, country_name)
);

CREATE TABLE IF NOT EXISTS catalog.title_directors (
    title_id BIGINT NOT NULL REFERENCES catalog.titles(title_id) ON DELETE CASCADE,
    director_name TEXT NOT NULL CHECK (length(trim(director_name)) > 0),
    PRIMARY KEY (title_id, director_name)
);

CREATE INDEX IF NOT EXISTS titles_type_year_idx
    ON catalog.titles (content_type, release_year DESC);

CREATE INDEX IF NOT EXISTS titles_title_lower_idx
    ON catalog.titles (LOWER(title));

CREATE INDEX IF NOT EXISTS title_genres_genre_idx
    ON catalog.title_genres (genre_name, title_id);

CREATE INDEX IF NOT EXISTS title_cast_person_idx
    ON catalog.title_cast (person_name, title_id);

CREATE INDEX IF NOT EXISTS title_countries_country_idx
    ON catalog.title_countries (country_name, title_id);

CREATE INDEX IF NOT EXISTS title_directors_director_idx
    ON catalog.title_directors (director_name, title_id);
