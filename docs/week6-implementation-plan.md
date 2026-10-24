# Week 6 — Recommendation and reproducible demo

Updated: 2026-10-24
Status: Week 6 local data/artifact and isolated dev/staging runtime/browser acceptance passed on 2026-10-24. Browser testing found and fixed a recommendation query-parameter parsing defect; regression coverage now exercises the HTTP boundary. Week 5 cluster and `P(like)` scoring remain disabled pending their separate artifact/holdout gates. No Helio deployment was performed; this GitHub commit is for collaborator review and testing.

## Goal and boundary

Build a reproducible local demo in which an exported, fixed interaction snapshot initializes recommendation evidence, while a separately-created local demo user can browse, rate/watch titles, and receive updated recommendations from their own committed history.

The approved seed cohort is the additional 100 Helio public test accounts, split into four descriptive favorite groups of 25. The existing 100 accounts remain `unknown` unless independently mapped. Group labels describe the seed cohort only; they are not model inputs or ground-truth labels.

Helio was checked read-only after seeding: the 100-row pseudonymous group query returned 25 per group; `/healthz` and `/readyz` returned HTTP 200, with readiness at migration `014_mark_rating_watch_repairs`. On 2026-10-24, all five exports were downloaded to ignored `tmp/week6/seed/` with a shared cutoff. The map has 100 users (25 per group); the event exports have 4,031 rating rows, 4,031 watch rows, and 502 searches. These are pseudonymous production interaction exports plus the explicitly mapped synthetic cohort, not anonymous data.

## Data path

```text
Helio PostgreSQL
    └─ five read-only CSV exports (pseudonymous; kept local/ignored)
         + catalog.json
              ↓ validate headers, keys, timestamps, values, and cohort counts
         checksummed local recommendation artifact
              ↓ API combines seed evidence with the authenticated user's committed history
         recommendation UI (popularity / content / hybrid availability)
```

The startup preparation step validates the bundle and writes the artifact atomically only after validation. Missing or invalid exports leave the API available in degraded/cold-start mode and do not replace a previous valid artifact. Input CSVs are mounted read-only. Raw search text is not part of the export contract or artifact.

## Current implementation

- Python standard-library CSV validation, pseudonymous key checks, canonical catalog ID checks, timezone-aware event ordering, export cutoff checks, rating half-step/range checks, watch bounds, duplicate event checks, event/user counts, and the 100 × 25 readiness gate requiring at least the seeded 20 valid ratings and 5 searches per mapped account (later events do not invalidate the roster).
- The source contains 9 legacy `rating_value=0` rows from the old “No rating” UI behavior. The source CSV is preserved; these rows are explicitly counted and excluded from preference labels. The viewer exports nullable completion rates as `NULL`; those 2,030 watch rows are preserved and counted as missing evidence, not coerced to zero. Other invalid values still fail validation.
- Deterministic catalog TF-IDF vectors over title, description, and genres; popularity is based on each mapped synthetic user's latest rating per title, counting only ratings of 7 or above. Unknown users are excluded from this frozen seed popularity score.
- Input hashes and artifact checksum; safe size limits; atomic replace; prior artifact preserved when a new input bundle fails validation.
- Search event text is omitted. The artifact contains no e-mail, username, account ID, raw search string, or session ID.
- API/UI scaffolding is already present in the local tree. Cluster and `P(like)` remain explicitly disabled until the Week 5 cluster artifact and a valid chronological holdout are independently validated. Do not present disabled components as trained or evaluated.
- Week 5 source algorithms (`mining/build_user_clusters.py`, `mining/pre_rec_tree.py`, and `mining/week5_pipeline.py`) are already on `main`; no separate collaborator branch contains mining files. The Week 6 runtime currently integrates the portable popularity/content components only. It does not load Python/joblib model pickles or claim the Week 5 clustering/tree models are integrated into runtime; safe portable serialization and real-data/holdout validation are still required before enabling them.
- Compose runs catalog bootstrap, then `prepare_recommendations`, then starts the API. Missing exports should log a redacted skip code rather than take the catalog/auth API offline.

## Export contract

Place exactly these files in `tmp/week6/seed/`:

| File | Required header |
|---|---|
| `week6_export_context.csv` | `export_cutoff,cohort,watch_mining_view` |
| `ratings.csv` | `user_key,target_key,cohort,show_id,rating_value,rated_at` |
| `watches_for_mining.csv` | `watch_key,user_key,cohort,show_id,watch_seconds,completion_rate,duration_basis,recorded_at` |
| `searches.csv` | `search_key,user_key,cohort,occurred_at` |
| `week6_cohort_map.csv` | `user_key,cohort,favorite_group` |

The four event exports use `cohort=unknown`; the separate verified map labels only the 100 synthetic accounts as `synthetic`. User/event keys use the prescribed stable MD5 pseudonyms so exports can join. These are pseudonymous, not anonymous. Treat every CSV as private behavioral data and keep it out of GitHub, shared artifacts, and public logs.

## Local environments

| | Development | Local staging |
|---|---|---|
| Compose project | `cinemind-dev` | `cinemind-staging` |
| Frontend / API | `5173` / `8000` | `5183` / `8006` |
| Database/artifact volume | project-scoped | separate project-scoped volume |
| Seed input | shared read-only local snapshot | same read-only snapshot |
| Auth cookie | `cinemind_auth` | `cinemind_auth_staging` |

Commands and smoke checks are in [`week6-run-dev.md`](week6-run-dev.md) and [`week6-run-staging-local.md`](week6-run-staging-local.md). The example staging profile is loopback-only, local development mode, and must never be reused on Helio.

## Acceptance gates

1. Export all five files using the same cutoff; verify headers, row counts, pseudonym joins, and 25 accounts per favorite group without displaying raw identity.
2. Run the builder against the actual exports; require 100 synthetic accounts, at least 2,000 ratings, at least 500 searches, and `seed_status=ready`. Preserve any older cohort as `unknown`.
3. Validate restart determinism, invalid-input preservation, no sensitive fields in artifact/logs, and recommendation status/fallback behavior.
4. Start dev and staging simultaneously; confirm different ports, database volumes, artifact volumes, and cookie names.
5. Exercise a fresh demo account, cold start, committed rating change, seen-title exclusion, Top-5/10, logout/account switch, and no cross-account recommendation leakage.
6. Measure warmed API latency and UI refresh delay; report actual figures rather than the target (<2 s API, <5 s after a committed interaction).

## Verification boundary at this revision

Verified locally on 2026-10-24:

- All five export headers and the 100-row 25-per-group cohort map passed the builder. The snapshot has 4,022 valid ratings, 9 excluded legacy no-rating rows, 4,031 watches (2,030 nullable completion values), and 502 searches. Every mapped account meets the minimum 20 valid ratings and 5 searches.
- The builder wrote `tmp/week6/artifacts/recommendation_artifact.json`, `seed_status=ready`, `model_version=week6-tfidf-popularity-v2`, 100 mapped synthetic users, 2,000 synthetic ratings, 500 synthetic searches, and 8,807 content vectors. The 6,951,034-byte artifact passed its checksum loader and an identical second build did not change its file hash. Regression tests cover privacy-minimized fields and preservation of the previous artifact on invalid input. CSVs and artifact are Git-ignored.
- Docker Engine 28.3.3 ran `cinemind-dev` and `cinemind-staging` simultaneously. They use separate project-scoped PostgreSQL and artifact volumes, ports (5173/8000 and 5183/8006), and auth cookies. Both startup logs reported `RECOMMENDATION_PREP status=ready`; both `/healthz` and `/readyz` returned healthy/ready with migration `014_mark_rating_watch_repairs`. The older `cinemind` and QA volumes were not touched.
- Real-browser local QA registered two throwaway accounts in dev. The first account saved and edited a rating; the modal rehydrated its saved value and duration. After logout, the second account initially showed an empty personal-history row; after its own rating, dev aggregate counts were two users with one and two rating events, while staging remained at zero users. The staging browser ignored the dev auth cookie and stayed signed out. No account identifiers or credentials are included here.
- Browser/API checks passed all popularity/content/hybrid combinations at Top-5 and Top-10 (`200`, exact item count, personalized mode); the rated title was absent from every result. A first real browser request exposed that `Literal[int]` rejected URL values `5`/`10`; the route now parses an integer and explicitly allows only 5 or 10. Added ASGI regression coverage verifies 5/10 succeed and 6 returns 422.
- Warmed browser-to-API latency over eight hybrid Top-10 requests: median `754 ms`, max `776 ms`. After a committed rating, the next recommendation response completed about `741 ms` after the signal request. These are local measurements, not production/Helio measurements.
- Backend `pytest`: `139 passed, 9 subtests passed`. Frontend `npm run check` passed (68 interaction-sync cases, 3 catalog-integrity cases, syntax/architecture/catalog checks, and production build); webpack reported the existing three bundle-size/performance warnings. All eight Week 5 mining CLI self-checks passed.

Week 6 local runtime acceptance is complete for the implemented popularity/content/hybrid demo. This does not claim a validated K-Means or Decision Tree model: Week 5 cluster scoring and `P(like)` remain disabled until a valid cluster artifact and chronological holdout are available. Both local Compose projects are left running for inspection; their dev database contains only the two local QA accounts and test interactions created during this run. No Helio write/deployment, production database change/reset, GitHub push, or volume deletion was performed.
