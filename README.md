# CineMind

CineMind is a Netflix-inspired catalog and Data Mining prototype for the midterm project. It uses the Kaggle Netflix Movies and TV Shows dataset and includes normalized `ops`, `catalog`, `interaction`, and `auth` database boundaries.

## Scope of this iteration

- React + TailwindCSS frontend
- Webpack development server on port 5173
- Responsive desktop and mobile layout
- English-only interface
- Real catalog titles and metadata from Kaggle
- TMDB poster URLs when a local TMDB credential is configured, with IMDb and TVmaze fallbacks plus a generated poster asset for every unmatched title
- Search, type, genre and release-year filters
- Title detail page and rating/watch-duration modal
- Cookie-session account flow with email/username login, registration, logout, and account profile
- Anonymous interaction persistence that can merge into an account: bounded sessions, search events, watch signals, and half-star ratings
- Backend `ops`, `catalog`, `interaction`, and `auth` schemas with PostgreSQL migrations, catalog ingestion, data-quality audit, and API endpoints
- Protected three-scope database reset console for local and demo maintenance

## Interactive architecture flow

Open docs/cinemind-system-flow.html in a browser to explore the current
frontend, browser-recovery, API, backend service/repository, PostgreSQL,
migration and security boundaries. The viewer reads the focused architecture
model from docs/cinemind-system-flow.architecture.json when served over HTTP
and includes an embedded fallback for direct file opening. It provides four
guided views, node search, deep-linkable moments, theme/style presets and SVG
export. The canvas shows only the selected step and its nearest neighbors;
the complete story remains available in the step list and node passport.

## Frontend configuration boundary

Runtime, filter, display-limit, navigation, poster-fallback, validation, deployment-path, and browser-storage settings live in `frontend/config/cinemind.config.json`. The UI reads these settings through `frontend/src/config/appConfig.js`; catalog loading, recommendation preview, account access, and browser signal persistence are separate services so a later API/model layer can replace them without moving constants back into components.

The catalog preparation script enriches the full dataset, caches poster matches, and writes a data-driven SVG poster for every title. It does not contain a manually curated title list, fake fallback records, or poster aliases. The app prioritizes a verified remote poster and falls back to the generated local asset if a remote image is unavailable.

## Real poster enrichment with TMDB

TMDB credentials are used only by the local catalog preparation script; they are never bundled into the frontend. Copy `frontend/.env.example` to `frontend/.env.local`, put either a TMDB Read Access Token or API key in that local file, and run `npm run data:prepare` from `frontend`. The script searches movies and TV shows through the matching TMDB endpoint, matches title and release year, stores only public image URLs in `catalog.json`, and retains IMDb plus TVmaze (for TV shows) as fallbacks. Do not commit `.env.local` or share the credential in chat.

The UI includes the TMDB attribution required for this prototype. Poster image references and use of the TMDB service remain subject to TMDB's terms.

## Data mining pipeline (KDD)

The mining path is separate from poster enrichment. Catalog cleaning and the offline models live under `mining/`. The API in `backend/src/cinemind/recommendations/` loads their outputs and scores the signed-in user at request time. Popularity is a ranking baseline, not a fourth mining algorithm.

| KDD step | What it does | Where it lives |
| --- | --- | --- |
| Selection | Catalog titles stay separate from behavior events. The served cohort is the curated Week 6 export. | `frontend/public/data/catalog.json`, `mining/data/week6/` |
| Preprocessing | Deterministic catalog cleaning and a manifest. | `mining/data_cleaning.py`: `clean_row`, `clean_rows`, `run` |
| Transformation | Builds the mining document and the preference label. | `mining/tfidf.py`: `build_baseline_rows`; `mining/preference_features.py`: `label_for` |
| Mining | TF-IDF, cosine, a decision tree, and K-means. | Sections below |
| Interpretation | Hybrid ranking and the live Top-K list. | `mining/hybrid_ranking.py`: `rank_candidates`; `backend/src/cinemind/recommendations/core.py`: `rank_recommendations` |

### Data cleaning (preprocessing)

`mining/data_cleaning.py` reads the Kaggle CSV and writes a cleaned CSV plus a manifest. `clean_row` applies the frozen text, genre, duration, and duplicate rules. `run` is the command entry. The app then serves the normalized catalog at `frontend/public/data/catalog.json`, which the backend loads in `backend/src/cinemind/recommendations/prepare.py` through `_load_catalog`.

### TF-IDF

Offline training uses scikit-learn. `mining/tfidf.py` defines `VECTOR_CONFIG` (`lowercase`, no stop words, unigrams) and `fit_tfidf` turns `title_clean + description_clean + genres_clean` into the document-term matrix.

The API does not import scikit-learn. `prepare.py` rebuilds L2-normalized vectors in `_document_text` and `_content_vectors` with smoothed IDF `log((1+N)/(1+df))+1`. `mining/week6_baseline_export.py` calls that same function from `_content_vectors` so the served tree sees the API vectors.

### Cosine similarity

Three callers use cosine, and they do not share one formula.

| Use | Function | Formula |
| --- | --- | --- |
| Offline content score | `mining/cosine_similarity.py`: `content_scores` | Cosine between a title and the equal-weight mean of unique liked-title vectors |
| Tree feature `content_profile_similarity` | `backend/src/cinemind/recommendations/baseline_features.py`: `equal_weight_similarity` | Same equal-weight mean, computed per request |
| Content mode on the API | `backend/src/cinemind/recommendations/core.py`: `content_similarity_scores`, then the blend inside `rank_recommendations` | Recency-weighted cosine, decay 30 days and rating intensity, then `0.8 * cosine + 0.2 * genre score` |

Content mode and P(like) are empty until the user has at least one rating of 7 or higher.

### Decision Tree and classification evaluation

Labels are frozen in `mining/preference_features.py`: `label_for` maps 0–3 to `disliked`, 4–6 to `neutral`, and 7–10 to `liked`. Ratings 3.5 and 6.5 have no label.

The six pre-rating features are `TREE_FEATURES` in `mining/week5_artifacts.py`. `mining/decision_tree.py`: `fit_preference_model` fits an entropy tree, prunes with CCP, and keeps the candidate with the best validation macro-F1. `predict_liked` returns P(like).

The same file is the offline evaluator. `chronological_split` cuts train, validation, and test by time. `classification_metrics` writes macro-F1, accuracy, per-class precision, recall, F1, and the confusion matrix. `majority_result` is the majority-class baseline.

`mining/week6_baseline_export.py`: `_fit_tree` and `_training_rows` fit that tree on the Week 6 cohort and write `tree_fragment.json`. At request time, `baseline_features.py`: `live_tree_features` builds the six features for the signed-in user, and `core.py`: `_tree_probability` walks the tree.

### K-means

`mining/user_behavior_features.py`: `genre_shares` and `build_user_matrix` build the user vector from genre shares of unique liked titles plus the two `log1p` watch counts. `mining/kmeans.py`: `fit_clusters` scales on the ready users only, tries K in {2, 3, 4}, and selects with silhouette and pairwise ARI. `assign_clusters` assigns a saved model.

`mining/week6_baseline_export.py`: `_cluster_fragment` writes centroids, the frozen scaler, and per-cluster popularity to `cluster_fragment.json`. Serving uses `baseline_features.py`: `cluster_vector`, `assign_scaled_cluster`, and `live_cluster_id`. A user with no liked title is not assigned.

### Hybrid ranking

Offline ranking is `mining/hybrid_ranking.py`: `popularity_scores` and `rank_candidates`. The components are content `C`, popularity `P`, P(like) `T`, and cluster `K`. `resolve_weights` and `run` write the ranked lists and the Top-K files. `ranking_metrics` computes Precision, Recall, and NDCG.

The API ranking is `core.py`: `rank_recommendations`. Declared hybrid weights are popularity 0.50, content 0.15, cluster 0.25, and P(like) 0.10. A missing component is dropped and the remaining weights are renormalized. Single modes are `popularity`, `content`, `cluster`, and `p_like`. `routes.py`: `get_recommendations` accepts those modes and limits 5 and 10. `service.py`: `RecommendationService.recommend` builds the live features and calls the ranker. The selector is `frontend/src/components/PersonalizedRecommendations.jsx`.

## Run with Docker

From the repository root:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:5173`. The frontend image builds its production bundle in a dedicated stage. The same Compose project starts PostgreSQL and the backend on port `8000`; the backend applies migrations and seeds `catalog.json` automatically.

Without the Week 6 seed, recommendation preparation logs `RECOMMENDATION_PREP status=skipped` and the app stays available with catalog fallback. That fallback is not a trained model.

### Recommendation baseline

The demo serves five ranking modes: `popularity`, `content`, `cluster`, `p_like`, and `hybrid`. Content is TF-IDF cosine. `cluster` is K-means. `p_like` is the decision tree. Hybrid mixes those three with popularity. The fitted fragments are not committed. Build them, then place an API-valid seed where Compose already mounts it.

1. Fit the two models from the curated dataset. This uses the mining virtualenv that already has scikit-learn:

```bash
mining/.venv/bin/python mining/week6_baseline_export.py \
  --seed-dir mining/data/week6 \
  --catalog frontend/public/data/catalog.json \
  --output-dir tmp/week6/baseline
```

2. Rewrite the five CSVs into `tmp/week6/seed/`. The curated files use aliases such as `synthetic_user_001` and mark event rows `cohort=synthetic`. The API accepts only 32-character MD5 keys, and event rows must be `cohort=unknown`. The cohort map stays `synthetic`.

```bash
mkdir -p tmp/week6/seed
python3 - <<'PY'
import csv, hashlib
from pathlib import Path
src, dst = Path("mining/data/week6"), Path("tmp/week6/seed")
def md5(value):
    return hashlib.md5(value.encode()).hexdigest()
for name in ("week6_export_context.csv","week6_cohort_map.csv","ratings.csv","watches_for_mining.csv","searches.csv"):
    rows = list(csv.DictReader((src/name).open(encoding="utf-8")))
    for row in rows:
        for key in ("user_key","target_key","watch_key","search_key"):
            if row.get(key):
                row[key] = md5(row[key])
        if name != "week6_cohort_map.csv" and "cohort" in row:
            row["cohort"] = "unknown"
    with (dst/name).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
PY
```

3. Start, or restart the backend if Compose is already running. The backend command rebuilds the recommendation artifact from `tmp/week6/seed/` and the two files in `tmp/week6/baseline/`.

```bash
docker compose up --build -d
docker compose restart backend
docker compose logs --tail 30 backend
```

Preparation succeeded when the log contains `RECOMMENDATION_PREP status=ready`. A line with `status=skipped code=pseudonymous_key_invalid` means the seed was copied without the rewrite above.

4. Open `http://127.0.0.1:5173`, create a local account, and rate one title 7 or higher. Then switch Ranking among Hybrid, Content, Clusters, Preference, and Popularity. A profile with no rating of 7 or higher has no cluster assignment, so Hybrid for that profile uses popularity and content only.

`tmp/week6/` is gitignored. Re-run step 3 after replacing the seed. Do not use `docker compose down -v` unless the local database and the built artifact should be deleted. More checks are in `docs/week6-run-dev.md`.

Interactive API documentation is available at `http://127.0.0.1:8000/docs`. Account access is available at `http://127.0.0.1:5173/auth.html`, and the signed-in profile is available at `http://127.0.0.1:5173/profile.html`. The separate reset console is available at `http://127.0.0.1:5173/reset.html`; configure `ADMIN_RESET_USERNAME` and `ADMIN_RESET_PASSWORD` in a local ignored environment file before using it. The reset API is excluded from the public OpenAPI schema and requires Basic Auth plus an exact confirmation phrase.

The Docker image serves the verified production bundle through nginx on port 5173. After a UI change, rebuild the image with `docker compose up --build -d`. The backend service applies the PostgreSQL migrations and seeds the catalog on port 8000. Backend endpoints and local commands are documented in `backend/README.md`.

### Trusted proxy boundary

The Compose topology keeps the backend bound to loopback and lets the frontend nginx proxy overwrite client forwarding headers. Leave `CINEMIND_TRUSTED_UPSTREAM_PROXY_NETWORKS` empty for direct local access. If an additional TLS-terminating proxy is placed in front of nginx, set that variable on the `frontend` service to a comma-separated list of the proxy's exact CIDR blocks. The container then trusts forwarded HTTPS and client-IP headers only from those networks; never use a catch-all network. Keep `TRUSTED_PROXY_NETWORKS` limited to the internal proxy network that can reach the backend.

When `CINEMIND_ENVIRONMENT=production`, leaving `REQUIRE_HTTPS` and `RESET_ENABLED` blank preserves the application's secure defaults: HTTPS is required and the destructive reset endpoint is disabled unless explicitly enabled with separate admin credentials.

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
