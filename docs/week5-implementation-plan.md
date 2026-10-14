# Week 5 — Approved offline implementation contract

Status: implementation in progress. Approved 2026-10-14. API/UI integration belongs to Week 6.

## Tracks and provenance

| Track | Inputs and outputs | Evidence |
| --- | --- | --- |
| Team | Legacy Week 4 manifest; new outputs under `tmp/week5/team_test/` | `team_test_smoke`; ranking quality N/A because observation coverage is unknown |
| Synthetic | Frozen real catalog plus deterministic generated behavior under `tmp/week5/synthetic/` | `synthetic_demo`; computed model/ranking metrics describe this fixture only |

Raw data, user rows, model bundles and reports remain in ignored `tmp/week5`. Existing Week 3/4 source, artifacts and exports are preserved. No dependencies, backend, frontend, migrations or Notion changes.

## Snapshot and features

1. Load source paths relative to the repository root, validate recorded input hashes, CSV headers, canonical titles and ownership. Exclude NULL-like owners and repair watches; reject duplicate event keys and cross-cohort owners.
2. Snapshot strictly before the supplied cutoff. Choose latest user/title rating before applying the 30-day window and liked filter. Conflicting values at an equal timestamp fail; equal values collapse deterministically. Seen titles use all prior watch/rating history; searches only contribute activity.
3. Keep one raw row per prior owned user, including insufficient-history users. Genre shares use unique latest-liked titles with valid genres, each title contributing total weight one. Catalog genre universe is fixed and sorted. K-means uses genre shares then log1p of unique watched titles in 30 days and watch rows in seven days. Metadata and fixture styles never enter X.

## Models and ranking

StandardScaler and K-means fit only at the train cutoff; assign mode transforms/predicts without refitting. Candidates K=2/3/4 require K<n and K<=distinct vectors. Team selects the smallest feasible K and disables its ranking signal. Synthetic selects highest defined silhouette, ties smaller K; gate requires no singleton, positive silhouette, median pairwise ARI>=0.8 across seeds 0/1/2/3/42, and matching expected style partitions/profiles.

A new pre-recommendation tree uses six raw features: content profile cosine, genre affinity, seven-day watch rows, 30-day unique watches, 30-day liked titles, and days since last interaction. Train medians/missing indicators are frozen. Entropy trees with seed42/minsplit4/minleaf2 compare depth1/depth3 and the train CCP path; validation macro F1 selects, ties simpler. Future targets are latest observed ratings in [t,t+7d); unrated titles are not disliked labels.

All algorithms rank the same complete valid catalog minus prior seen titles and duplicates. Content scores use actual cosine to a mean of unique prior-liked vectors. Popularity counts distinct latest-liked users in 30 days; log1p normalization uses cmax over the whole valid catalog before exclusions. Cluster popularity uses current assignments to the train model. Zero remains a valid score; a globally zero cmax is unavailable.

Manual team weights C/P/T/K=0.7/0.3/0/0; synthetic=0.5/0.15/0.25/0.1. Unavailable components are omitted and weights renormalized. Cold users use popularity, then deterministic catalog fallback. All unavailable scores remain null. Ties sort by show_id. Export Top5/10 with actual result count, active weights, reasons, modes and evidence.

## Synthetic fixture and temporal evaluation

Seed42 chooses nine lexicographic single-genre positive-runtime Movies per Action & Adventure, Comedies and Dramas (27 distinct). Twelve warm users have three prior likes each; two cold users have search-only and neutral-rating/watch histories. A first-member override in each style changes rating8 to2 before cutoff without a watch. Three future stage titles per user yield 147 ratings,73 watches,1 search,14 users. Each future window has36 targets and12 labels per class.

Coverage is July1–August22 2026 UTC; train/validation/test are August1/8/15; demo is August22. Team demo is September17. Seven-day windows never overlap. Observation end comes only from source metadata. Selected tree and weights learn through August15 and may serve test at equality or later. Validation results are selection results. Fixed train artifacts are used on test; no demo refit is replayed into the past.

Validation weight grid uses step0.1, sum1; select mean NDCG10 over defined queries. Ties prefer fewer nonzero components, then larger C/P/T/K. There is no requirement that hybrid beat a baseline.

Metrics use the actual deterministic sorted ranking. Precision divides by K even for fewer returns. Recall/NDCG are null without observed positives; report query coverage (synthetic12/14), catalog/returned/fallback/component coverage. Team metrics remain N/A. Numeric outputs must reproduce across isolated reruns; generated timestamps are excluded from logical comparison.

## CLI ownership and verification

| CLI | Owned outputs |
| --- | --- |
| `generate_week5_demo.py` | Synthetic CSV inputs and manifest |
| `build_user_clusters.py` | User matrix, cluster bundle, assignments, profiles and report |
| `evaluate_ranking.py` | Split/query rows, preference bundle, validation candidates/weights and benchmark |
| `build_hybrid_ranking.py` | Popularity, components, TopK and ranking reports |

Common CLI arguments: `--source-manifest`, `--cohort`, `--output-dir`; generator uses `--catalog`. Cluster takes `--cutoff`, `--mode fit/assign` and model reference. Ranking takes cutoff, cluster/preference runs and manual/validation weight source. Evaluation takes all three cutoffs plus the train cluster run. Every CLI has `--self-check`. Trusted local model loading explicitly validates cohort, input/catalog hashes, feature version/order, runtime, checksum and learned-through dates before joblib unpickling.

Complete gates require actual self-checks, fixture counts/class supports, train-only preprocessing, trusted roundtrips and negative guards, both tracks end to end, deterministic isolated reruns, and preservation of all old hashes. Actual commands/results are recorded in `docs/week5-report.md` after execution.
