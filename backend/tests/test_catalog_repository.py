import unittest

from cinemind.catalog.repository import CatalogRepository


class FakeConnection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.statements = []

    def execute(self, statement, params=()):
        self.statements.append((statement, params))
        return self

    def fetchall(self):
        return self.rows


class CatalogRepositoryTests(unittest.TestCase):
    def test_filters_escape_like_wildcards(self):
        sql, params = CatalogRepository._filters(
            query="%_!", content_type=None, genre=None, release_year=None
        )

        self.assertIn("ESCAPE '!'", sql)
        self.assertEqual(params, ["%!%!_!!%", "%!%!_!!%"])

    def test_list_titles_has_a_unique_pagination_tiebreaker(self):
        connection = FakeConnection()
        CatalogRepository(connection).list_titles(limit=10, offset=20)

        self.assertIn("t.title ASC, t.show_id ASC", connection.statements[0][0])

    def test_detail_cast_keeps_source_order(self):
        connection = FakeConnection([{"person_name": "Second"}, {"person_name": "First"}])
        values = CatalogRepository(connection)._relation_values("title_cast", "person_name", 7)

        self.assertEqual(values, ["Second", "First"])
        self.assertIn("ORDER BY cast_order, person_name", connection.statements[0][0])


if __name__ == "__main__":
    unittest.main()
