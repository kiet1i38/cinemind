"""PostgreSQL repository for the normalized catalog."""

from cinemind.catalog.models import CatalogRecord


class CatalogRepository:
    """Persist and query catalog titles and their normalized relations."""

    def __init__(self, connection):
        self.connection = connection

    def replace_catalog(
        self,
        records: tuple[CatalogRecord, ...],
        source_id,
        source_checksum: str | None = None,
    ) -> int:
        """Upsert titles and rebuild their relation rows for one source."""

        if not records:
            return 0

        with self.connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO catalog.titles (
                    show_id,
                    source_id,
                    content_type,
                    title,
                    description,
                    date_added,
                    release_year,
                    content_rating,
                    movie_duration_min,
                    season_count,
                    duration_basis,
                    poster_provider,
                    poster_path,
                    poster_url,
                    poster_status,
                    is_active,
                    source_checksum_sha256
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, TRUE, %s
                )
                ON CONFLICT (show_id)
                DO UPDATE SET
                    source_id = EXCLUDED.source_id,
                    content_type = EXCLUDED.content_type,
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    date_added = EXCLUDED.date_added,
                    release_year = EXCLUDED.release_year,
                    content_rating = EXCLUDED.content_rating,
                    movie_duration_min = EXCLUDED.movie_duration_min,
                    season_count = EXCLUDED.season_count,
                    duration_basis = EXCLUDED.duration_basis,
                    poster_provider = EXCLUDED.poster_provider,
                    poster_path = EXCLUDED.poster_path,
                    poster_url = EXCLUDED.poster_url,
                    poster_status = EXCLUDED.poster_status,
                    is_active = TRUE,
                    source_checksum_sha256 = EXCLUDED.source_checksum_sha256,
                    updated_at = CURRENT_TIMESTAMP
                """,
                    [self._title_values(record, source_id, source_checksum) for record in records],
            )

            show_ids = [record.show_id for record in records]
            cursor.execute(
                """
                SELECT title_id, show_id
                FROM catalog.titles
                WHERE show_id = ANY(%s)
                """,
                (show_ids,),
            )
            title_ids = {
                row["show_id"]: row["title_id"] for row in cursor.fetchall()
            }
            if len(title_ids) != len(show_ids):
                raise RuntimeError("Catalog upsert did not return every title")

            cursor.execute(
                """
                UPDATE catalog.titles
                SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
                WHERE show_id <> ALL(%s)
                """,
                (show_ids,),
            )

            numeric_title_ids = list(title_ids.values())
            self._delete_relations(cursor, numeric_title_ids)
            self._insert_relations(cursor, records, title_ids)

        return len(records)

    def matches_source(
        self,
        records: tuple[CatalogRecord, ...],
        source_id,
        source_checksum: str,
    ) -> bool:
        """Verify every active catalog value and relation against the seed."""

        expected = {
            record.show_id: self._integrity_projection(record, source_id, source_checksum)
            for record in records
        }
        rows = self.connection.execute(
            """
            SELECT
                t.show_id,
                t.source_id,
                t.content_type,
                t.title,
                t.description,
                t.date_added,
                t.release_year,
                t.content_rating,
                t.movie_duration_min,
                t.season_count,
                t.duration_basis,
                t.poster_provider,
                t.poster_path,
                t.poster_url,
                t.poster_status,
                t.source_checksum_sha256,
                COALESCE((
                    SELECT array_agg(g.genre_name ORDER BY g.genre_name)
                    FROM catalog.title_genres g
                    WHERE g.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS genres,
                COALESCE((
                    SELECT array_agg(c.person_name ORDER BY c.cast_order, c.person_name)
                    FROM catalog.title_cast c
                    WHERE c.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS cast,
                COALESCE((
                    SELECT array_agg(c.country_name ORDER BY c.country_name)
                    FROM catalog.title_countries c
                    WHERE c.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS countries,
                COALESCE((
                    SELECT array_agg(d.director_name ORDER BY d.director_name)
                    FROM catalog.title_directors d
                    WHERE d.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS directors
            FROM catalog.titles t
            WHERE t.is_active = TRUE
            ORDER BY t.show_id
            """
        ).fetchall()
        if len(rows) != len(expected):
            return False
        for row in rows:
            show_id = str(row.get("show_id") or "").strip()
            if show_id not in expected:
                return False
            actual = {
                "show_id": show_id,
                "source_id": str(row.get("source_id") or "").strip(),
                "content_type": row.get("content_type"),
                "title": row.get("title"),
                "description": row.get("description"),
                "date_added": (
                    row["date_added"].isoformat()
                    if row.get("date_added") is not None
                    else None
                ),
                "release_year": (
                    int(row["release_year"])
                    if row.get("release_year") is not None
                    else None
                ),
                "content_rating": row.get("content_rating"),
                "movie_duration_min": (
                    int(row["movie_duration_min"])
                    if row.get("movie_duration_min") is not None
                    else None
                ),
                "season_count": (
                    int(row["season_count"])
                    if row.get("season_count") is not None
                    else None
                ),
                "duration_basis": row.get("duration_basis"),
                "poster_provider": row.get("poster_provider"),
                "poster_path": row.get("poster_path"),
                "poster_url": row.get("poster_url"),
                "poster_status": row.get("poster_status"),
                "source_checksum_sha256": str(
                    row.get("source_checksum_sha256") or ""
                ).strip(),
                "genres": tuple(str(value) for value in (row.get("genres") or ())),
                "cast": tuple(str(value) for value in (row.get("cast") or ())),
                "countries": tuple(str(value) for value in (row.get("countries") or ())),
                "directors": tuple(str(value) for value in (row.get("directors") or ())),
            }
            if actual != expected[show_id]:
                return False
        return True

    @staticmethod
    def _integrity_projection(record: CatalogRecord, source_id, source_checksum: str) -> dict:
        """Build the canonical representation used by the bootstrap guard."""

        return {
            "show_id": record.show_id,
            "source_id": str(source_id).strip(),
            "content_type": record.content_type,
            "title": record.title,
            "description": record.description,
            "date_added": record.date_added.isoformat() if record.date_added else None,
            "release_year": record.release_year,
            "content_rating": record.content_rating,
            "movie_duration_min": record.movie_duration_min,
            "season_count": record.season_count,
            "duration_basis": record.duration_basis,
            "poster_provider": record.poster_provider,
            "poster_path": record.poster_path,
            "poster_url": record.poster_url,
            "poster_status": record.poster_status,
            "source_checksum_sha256": str(source_checksum or "").strip(),
            "genres": tuple(sorted(record.genres)),
            "cast": tuple(record.cast),
            "countries": tuple(sorted(record.countries)),
            "directors": tuple(sorted(record.directors)),
        }

    def list_titles(
        self,
        *,
        limit: int,
        offset: int,
        query: str | None = None,
        content_type: str | None = None,
        genre: str | None = None,
        release_year: int | None = None,
    ) -> tuple[dict, ...]:
        """Return a page of catalog titles with normalized display relations."""

        where_sql, params = self._filters(
            query=query,
            content_type=content_type,
            genre=genre,
            release_year=release_year,
        )
        rows = self.connection.execute(
            f"""
            SELECT
                t.title_id,
                t.show_id,
                t.content_type,
                t.title,
                t.description,
                t.date_added,
                t.release_year,
                t.content_rating,
                t.movie_duration_min,
                t.season_count,
                t.duration_basis,
                t.poster_provider,
                t.poster_path,
                t.poster_url,
                t.poster_status,
                COALESCE((
                    SELECT array_agg(g.genre_name ORDER BY g.genre_name)
                    FROM catalog.title_genres g
                    WHERE g.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS genres,
                COALESCE((
                    SELECT array_agg(c.person_name ORDER BY c.cast_order, c.person_name)
                    FROM catalog.title_cast c
                    WHERE c.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS cast,
                COALESCE((
                    SELECT array_agg(c.country_name ORDER BY c.country_name)
                    FROM catalog.title_countries c
                    WHERE c.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS countries,
                COALESCE((
                    SELECT array_agg(d.director_name ORDER BY d.director_name)
                    FROM catalog.title_directors d
                    WHERE d.title_id = t.title_id
                ), ARRAY[]::TEXT[]) AS directors
            FROM catalog.titles t
            {where_sql}
            ORDER BY t.release_year DESC NULLS LAST, t.title ASC, t.show_id ASC
            LIMIT %s OFFSET %s
            """,
            (*params, limit, offset),
        ).fetchall()
        return tuple(rows)

    def count_titles(
        self,
        *,
        query: str | None = None,
        content_type: str | None = None,
        genre: str | None = None,
        release_year: int | None = None,
    ) -> int:
        """Count titles using the same filters as list_titles."""

        where_sql, params = self._filters(
            query=query,
            content_type=content_type,
            genre=genre,
            release_year=release_year,
        )
        row = self.connection.execute(
            f"SELECT COUNT(*) AS total FROM catalog.titles t {where_sql}",
            params,
        ).fetchone()
        return int(row["total"])

    def get_title(self, show_id: str) -> dict | None:
        """Return one title and all normalized relation values."""

        row = self.connection.execute(
            """
            SELECT
                title_id,
                show_id,
                content_type,
                title,
                description,
                date_added,
                release_year,
                content_rating,
                movie_duration_min,
                season_count,
                duration_basis,
                poster_provider,
                poster_path,
                poster_url,
                poster_status
            FROM catalog.titles
            WHERE show_id = %s AND is_active = TRUE
            """,
            (show_id,),
        ).fetchone()
        if row is None:
            return None

        result = dict(row)
        result["genres"] = self._relation_values("title_genres", "genre_name", row["title_id"])
        result["cast"] = self._relation_values("title_cast", "person_name", row["title_id"])
        result["countries"] = self._relation_values("title_countries", "country_name", row["title_id"])
        result["directors"] = self._relation_values("title_directors", "director_name", row["title_id"])
        return result

    def summary(self) -> dict:
        """Return catalog counts for readiness and smoke tests."""

        row = self.connection.execute(
            """
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE content_type = 'Movie') AS movies,
                COUNT(*) FILTER (WHERE content_type = 'TV Show') AS tv_shows,
                COUNT(*) FILTER (WHERE poster_status = 'available') AS public_posters,
                COUNT(*) FILTER (WHERE poster_status = 'fallback') AS fallback_posters,
                MAX(source_checksum_sha256) AS source_checksum_sha256
            FROM catalog.titles
            WHERE is_active = TRUE
            """
        ).fetchone()
        summary = {
            key: int(value)
            for key, value in row.items()
            if key != "source_checksum_sha256"
        }
        checksum = row.get("source_checksum_sha256")
        summary["source_checksum_sha256"] = str(checksum).strip() if checksum else None
        return summary

    @staticmethod
    def _title_values(record: CatalogRecord, source_id, source_checksum: str | None) -> tuple:
        return (
            record.show_id,
            source_id,
            record.content_type,
            record.title,
            record.description,
            record.date_added,
            record.release_year,
            record.content_rating,
            record.movie_duration_min,
            record.season_count,
            record.duration_basis,
            record.poster_provider,
            record.poster_path,
            record.poster_url,
            record.poster_status,
            source_checksum,
        )

    @staticmethod
    def _delete_relations(cursor, title_ids: list[int]) -> None:
        for table_name in (
            "catalog.title_genres",
            "catalog.title_cast",
            "catalog.title_countries",
            "catalog.title_directors",
        ):
            cursor.execute(f"DELETE FROM {table_name} WHERE title_id = ANY(%s)", (title_ids,))

    @staticmethod
    def _insert_relations(cursor, records, title_ids: dict[str, int]) -> None:
        genre_values = []
        cast_values = []
        country_values = []
        director_values = []
        for record in records:
            title_id = title_ids[record.show_id]
            genre_values.extend((title_id, genre) for genre in record.genres)
            cast_values.extend(
                (title_id, person, order)
                for order, person in enumerate(record.cast, start=1)
            )
            country_values.extend((title_id, country) for country in record.countries)
            director_values.extend((title_id, director) for director in record.directors)

        if genre_values:
            cursor.executemany(
                "INSERT INTO catalog.title_genres (title_id, genre_name) VALUES (%s, %s)",
                genre_values,
            )
        if cast_values:
            cursor.executemany(
                "INSERT INTO catalog.title_cast (title_id, person_name, cast_order) VALUES (%s, %s, %s)",
                cast_values,
            )
        if country_values:
            cursor.executemany(
                "INSERT INTO catalog.title_countries (title_id, country_name) VALUES (%s, %s)",
                country_values,
            )
        if director_values:
            cursor.executemany(
                "INSERT INTO catalog.title_directors (title_id, director_name) VALUES (%s, %s)",
                director_values,
            )

    def _relation_values(self, table_name: str, column_name: str, title_id: int) -> list[str]:
        allowed = {
            ("title_genres", "genre_name"),
            ("title_cast", "person_name"),
            ("title_countries", "country_name"),
            ("title_directors", "director_name"),
        }
        if (table_name, column_name) not in allowed:
            raise ValueError("Unsupported catalog relation")
        order_sql = "cast_order, person_name" if table_name == "title_cast" else column_name
        rows = self.connection.execute(
            f"SELECT {column_name} FROM catalog.{table_name} WHERE title_id = %s ORDER BY {order_sql}",
            (title_id,),
        ).fetchall()
        return [row[column_name] for row in rows]

    @staticmethod
    def _filters(*, query, content_type, genre, release_year) -> tuple[str, list]:
        clauses = ["t.is_active = TRUE"]
        params = []
        if query:
            clauses.append(
                "(t.title ILIKE %s ESCAPE '!' "
                "OR COALESCE(t.description, '') ILIKE %s ESCAPE '!')"
            )
            pattern = f"%{CatalogRepository._escape_like(query)}%"
            params.extend((pattern, pattern))
        if content_type:
            clauses.append("t.content_type = %s")
            params.append(content_type)
        if genre:
            clauses.append(
                "EXISTS (SELECT 1 FROM catalog.title_genres gf "
                "WHERE gf.title_id = t.title_id AND gf.genre_name = %s)"
            )
            params.append(genre)
        if release_year is not None:
            clauses.append("t.release_year = %s")
            params.append(release_year)
        return ("WHERE " + " AND ".join(clauses)) if clauses else "", params

    @staticmethod
    def _escape_like(value: str) -> str:
        """Escape LIKE wildcards while using ``!`` as the SQL escape char."""

        return str(value).replace("!", "!!").replace("%", "!%").replace("_", "!_")
