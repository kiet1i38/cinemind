# CineMind backend

This backend milestone implements the `ops` and `catalog` boundaries only. It does not implement interaction persistence, machine learning, recommendation serving, authentication, or login.

## Implemented boundaries

- `ops`: registers the Kaggle catalog source, records ingestion runs, and stores data-quality issues.
- `catalog`: stores normalized title records plus genre, cast, country, and director relations.
- Catalog input: `frontend/public/data/catalog.json`, which currently contains the normalized 8,807-title catalog.
- Database: PostgreSQL.
- API: FastAPI, with read-only catalog endpoints for the next frontend integration step.

## Project layout

```text
backend/
|-- migrations/
|   |-- 000_bootstrap.sql
|   |-- 001_create_ops_schema.sql
|   `-- 002_create_catalog_schema.sql
|-- src/cinemind/
|   |-- catalog/
|   |-- db/
|   |-- ops/
|   |-- scripts/bootstrap_catalog.py
|   |-- config.py
|   `-- main.py
|-- tests/
|-- Dockerfile
|-- requirements.txt
`-- .env.example
```

## Run with Docker

From the `CineMind` directory:

```powershell
docker compose up --build -d database backend
```

The backend waits for PostgreSQL, applies missing migrations, and upserts the catalog automatically.

- Health: `http://127.0.0.1:8000/healthz`
- Readiness: `http://127.0.0.1:8000/readyz`
- Catalog page: `http://127.0.0.1:8000/api/catalog?limit=20&offset=0`
- Catalog summary: `http://127.0.0.1:8000/api/catalog/summary`
- One title: `http://127.0.0.1:8000/api/catalog/s1`

The existing frontend remains on port `5173`. It is not switched to the API in this milestone.

## Run locally

From the `CineMind` directory, create a virtual environment and install dependencies:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
$env:PYTHONPATH = "backend/src"
python -m cinemind.scripts.bootstrap_catalog
python -m uvicorn cinemind.main:app --reload --port 8000
```

Use `backend/.env.example` as the configuration reference. Never commit a real `.env` file or database credential.

## Tests

The loader tests do not require a live database:

```powershell
$env:PYTHONPATH = "backend/src"
python -m unittest discover -s backend/tests -p "test_*.py"
```

## Data and migration rules

- Migrations are applied in filename order and recorded in `ops.schema_migrations`.
- Re-running the bootstrap is safe: titles are upserted by `show_id`, and normalized relation rows are rebuilt for the loaded records.
- Movie duration is stored in `movie_duration_min`; TV Show duration is stored in `season_count`.
- A TV Show's `runtimeMinutes` value from the frontend catalog is not treated as Movie runtime.
- Remote poster URL and local fallback path are stored separately.
- Ingestion failures and invalid rows are recorded in `ops` before the process exits.
