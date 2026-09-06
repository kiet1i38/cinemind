# CineMind backend

This backend implements the `ops`, `catalog`, `interaction`, and cookie-session `auth` boundaries. It also exposes a protected maintenance reset endpoint that is intentionally excluded from the public OpenAPI schema.

## Implemented boundaries

- `ops`: registers the Kaggle catalog source, records ingestion runs, and stores data-quality issues.
- `catalog`: stores normalized title records plus genre, cast, country, and director relations.
- `interaction`: stores anonymous sessions, search events, watch sessions, ratings, favorites, and watchlist items.
- `auth`: stores account records and hashed opaque sessions; account sessions can own and aggregate interaction sessions.
- Catalog input: `frontend/public/data/catalog.json`, which currently contains the normalized 8,807-title catalog.
- Database: PostgreSQL.
- API: FastAPI, with catalog, interaction, and protected maintenance boundaries.

## Project layout

```text
backend/
|-- migrations/
|   |-- 000_bootstrap.sql
|   |-- 001_create_ops_schema.sql
|   |-- 002_create_catalog_schema.sql
|   |-- 003_create_interaction_schema.sql
|   |-- 004_harden_interaction_constraints.sql
|   `-- 005_create_auth_schema.sql
|-- src/cinemind/
|   |-- admin/
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
- Interactive Swagger: `http://127.0.0.1:8000/docs`
- Redoc: `http://127.0.0.1:8000/redoc`
- Auth state: `GET http://127.0.0.1:8000/api/auth/me`
- Login/register: `POST http://127.0.0.1:8000/api/auth/login` and `POST http://127.0.0.1:8000/api/auth/register`

The frontend remains on port `5173` and uses the interaction API when available. Its separate reset console is `http://127.0.0.1:5173/reset.html`.

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

Set `ADMIN_RESET_USERNAME` and `ADMIN_RESET_PASSWORD` before using the reset console. The endpoint requires HTTP Basic Auth and an exact scope-specific confirmation phrase. `interaction` resets the current session, `demo` resets all interaction data, and `full` clears application data before running the catalog bootstrap again.

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
- Passwords are stored only as salted PBKDF2-HMAC-SHA256 hashes; the browser receives an HttpOnly, SameSite cookie and never receives the raw session token in JavaScript.
- Login accepts a normalized email or username, and a newly authenticated account may merge its current anonymous interaction session.
- Ingestion failures and invalid rows are recorded in `ops` before the process exits.
