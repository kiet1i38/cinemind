# CineMind

CineMind is a Netflix-inspired catalog and Data Mining prototype for the midterm project. It uses the Kaggle Netflix Movies and TV Shows dataset and includes normalized `ops`, `catalog`, `interaction`, and `auth` database boundaries.

## Scope of this iteration

- React + TailwindCSS frontend
- Webpack development server on port 5173
- Responsive desktop and mobile layout
- English and Vietnamese interface toggle
- Real catalog titles and metadata from Kaggle
- TMDB poster URLs when a local TMDB credential is configured, with IMDb and TVmaze fallbacks plus a generated poster asset for every unmatched title
- Search, type, genre and release-year filters
- Title detail page and rating/watch-duration modal
- Cookie-session account flow with email/username login, registration, logout, account profile, and English/Vietnamese support
- Anonymous interaction persistence that can merge into an account: sessions, search events, watch signals, ratings, favorites, and watchlist items
- Backend `ops`, `catalog`, `interaction`, and `auth` schemas with PostgreSQL migrations, catalog ingestion, data-quality audit, and API endpoints
- Protected three-scope database reset console for local and demo maintenance

## Frontend configuration boundary

Runtime, filter, display-limit, navigation, poster-fallback, validation, deployment-path, and browser-storage settings live in `frontend/config/cinemind.config.json`. The UI reads these settings through `frontend/src/config/appConfig.js`; catalog loading, recommendation preview, account access, and browser signal persistence are separate services so a later API/model layer can replace them without moving constants back into components.

The catalog preparation script enriches the full dataset, caches poster matches, and writes a data-driven SVG poster for every title. It does not contain a manually curated title list, fake fallback records, or poster aliases. The app prioritizes a verified remote poster and falls back to the generated local asset if a remote image is unavailable.

## Real poster enrichment with TMDB

TMDB credentials are used only by the local catalog preparation script; they are never bundled into the frontend. Copy `frontend/.env.example` to `frontend/.env.local`, put either a TMDB Read Access Token or API key in that local file, and run `npm run data:prepare` from `frontend`. The script searches movies and TV shows through the matching TMDB endpoint, matches title and release year, stores only public image URLs in `catalog.json`, and retains IMDb plus TVmaze (for TV shows) as fallbacks. Do not commit `.env.local` or share the credential in chat.

The UI includes the TMDB attribution required for this prototype. Poster image references and use of the TMDB service remain subject to TMDB's terms.

## Run with Docker

Run `npm run build` from `frontend`, then run `docker compose up --build -d` and open `http://127.0.0.1:5173`. The same Compose project starts PostgreSQL and the backend on port `8000`; the backend applies migrations and seeds `catalog.json` automatically.

Interactive API documentation is available at `http://127.0.0.1:8000/docs`. Account access is available at `http://127.0.0.1:5173/auth.html`, and the signed-in profile is available at `http://127.0.0.1:5173/profile.html`. The separate reset console is available at `http://127.0.0.1:5173/reset.html`; configure `ADMIN_RESET_USERNAME` and `ADMIN_RESET_PASSWORD` in a local ignored environment file before using it. The reset API is excluded from the public OpenAPI schema and requires Basic Auth plus an exact confirmation phrase.

The Docker image serves the verified production bundle through nginx on port 5173. After a UI change, run `npm run build` again before rebuilding the image. The backend service applies the PostgreSQL migrations and seeds the catalog on port 8000. Backend endpoints and local commands are documented in `backend/README.md`.

## Run locally

Run `cd frontend`, then `npm install` and `npm run dev`. The normalized catalog is
already committed, so a fresh clone can start without the source CSV. To rebuild
the catalog, first download the Kaggle source CSV into
`frontend/public/data/raw/netflix_titles.csv`, then run `npm run data:prepare`
and (optionally) `npm run data:check-posters`.

Run `npm run check` before delivery. It checks visible dash characters, architecture hardcode rules, and the production bundle.

## Backend tests

From the project root, run the loader unit tests with:

```powershell
$env:PYTHONPATH = "backend/src"
python -m unittest discover -s backend/tests -p "test_*.py"
```

## Data source

Dataset: https://www.kaggle.com/datasets/shivamb/netflix-shows/data

The original CSV is intentionally not committed because it is an external
dataset. Download it from the source above into
`frontend/public/data/raw/netflix_titles.csv` only when regenerating data. The
app consumes the normalized `frontend/public/data/catalog.json` file committed
to this repository.

## Reset scopes

- `interaction`: clears the current browser session's interaction rows and keeps the catalog.
- `demo`: clears all current interaction data and keeps the catalog and operational history.
- `full`: deletes all users, auth sessions, and interaction data while preserving the catalog, migration history, and operational audit tables.

The reset endpoint is intentionally not listed in Swagger. Never place real admin credentials in the repository or in the frontend bundle.
