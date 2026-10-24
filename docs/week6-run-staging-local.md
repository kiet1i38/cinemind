# Week 6 — Run isolated local staging

Local staging exists to exercise the production-built frontend through Nginx without sharing the development database, artifacts, or auth cookie. It is not Helio staging and must never be configured with a production database URL or production credentials.

## Profile and isolation

[`../.env.staging.example`](../.env.staging.example) sets separate frontend/API host ports (`5183`/`8006`), a unique cookie name, local HTTP origins, a staging database name, and loopback binds. Compose project name `cinemind-staging` gives its PostgreSQL and artifact volumes a separate namespace. The seed folder is shared read-only; each environment generates its own artifact.

## Validate and start

From the repository root:

```powershell
docker compose --env-file .env.staging.example -p cinemind-staging config --quiet
docker compose --env-file .env.staging.example -p cinemind-staging up --build -d
docker compose --env-file .env.staging.example -p cinemind-staging ps
```

Verify readiness and recommendation status:

```powershell
Invoke-RestMethod http://127.0.0.1:8006/healthz
Invoke-RestMethod http://127.0.0.1:8006/readyz
Invoke-RestMethod http://127.0.0.1:8006/api/recommendations/status
```

Open `http://127.0.0.1:5183/cinemind/`. Create a staging-only demo account and test the recommendation flow. Confirm dev at `5173` and staging at `5183` can remain open at once, and that each account's ratings/recommendations stay within its own Compose project.

## Reset/stop guidance

Stop while retaining data:

```powershell
docker compose --env-file .env.staging.example -p cinemind-staging down
```

Do not use `down -v`; it deletes staging's database and artifact volumes. A disposable full reset requires a separate explicit decision and a verified target project name. Never point staging at Helio or at the dev database.

## Troubleshooting

- Port conflict: check `8006` and `5183`; do not stop/delete the dev project. Change the two host-port values in a private staging env file if necessary.
- `status=skipped`: verify all five exact CSV filenames, headers, cutoff, and cohort counts. Keep inputs private; use the redacted error code only.
- Viewer/API connection issue: inspect `docker compose ... logs --tail 100 backend` and frontend health. Do not expose environment values or DB URLs in screenshots.
- Docker engine unavailable: `compose config --quiet` only validates configuration. It does not prove containers start, migrations run, or browser flows work.
