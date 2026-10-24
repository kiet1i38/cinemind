# Week 6 — Run the development environment

## Prerequisites and inputs

- Docker Desktop/Engine running and Docker Compose v2 available.
- Catalog present at `frontend/public/data/catalog.json`.
- After the Helio export handoff, all five CSV files placed in `tmp/week6/seed/`. This path is ignored by Git and is mounted read-only in the backend.

Until the CSV bundle is present, the preparation step reports a redacted skip and the existing API remains available in degraded/cold-start mode. Do not treat fallback titles as a trained recommendation result.

## Start

From the repository root:

```powershell
docker compose -p cinemind-dev up --build -d
docker compose -p cinemind-dev ps
docker compose -p cinemind-dev logs --tail 100 backend
```

The first build may take a few minutes. Successful preparation prints only aggregate status/counts. A missing or invalid input bundle should log `RECOMMENDATION_PREP status=skipped code=...`; it must not print CSV rows or credentials.

## Smoke check

```powershell
Invoke-RestMethod http://127.0.0.1:8000/healthz
Invoke-RestMethod http://127.0.0.1:8000/readyz
Invoke-RestMethod http://127.0.0.1:8000/api/recommendations/status
```

Open `http://localhost:5173/cinemind/`. Create/use a local demo account; do not use Helio credentials. Check cold-start, switch popularity/content/hybrid and Top-5/10, then rate a title and verify refresh only after the API confirms the save. Check that a seen/rated title is not recommended again and that logout/account switching removes the previous account's rows.

For logs and state:

```powershell
docker compose -p cinemind-dev logs --tail 100 backend
docker compose -p cinemind-dev ps
```

Do not print raw local CSV content. Do not use `down -v` unless explicitly intending to delete the local development database and artifact volumes.

## Refresh seed input

Replace the five CSV files as one consistent snapshot, then restart the backend so bootstrap and preparation run again:

```powershell
docker compose -p cinemind-dev restart backend
docker compose -p cinemind-dev logs --tail 100 backend
```

The process validates the new bundle before atomically replacing a previous valid artifact. Keep the previous CSV bundle until the new run is verified. The PostgreSQL interaction database persists independently and is not overwritten by the export step.

## Stop without deleting data

```powershell
docker compose -p cinemind-dev down
```

Do not add `-v` if database/artifact data should survive.
