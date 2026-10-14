# Week 5 — Implementation and verified results

Completed locally on 2026-10-14. Two tracks are separate: `team_test_smoke` and `synthetic_demo`. API/UI remain Week 6 work.

## Results

| Check | Team | Synthetic |
| --- | --- | --- |
| Owned snapshot users / cluster-eligible | 11 / 10 | 14 / 12 |
| Catalog / genre universe / K columns | 8,807 / 42 / 44 | 8,807 / 42 / 44 |
| NULL owner search exclusions | 2 | 0 |
| K selection | K=2, provisional; signal disabled | K=3; groups 4/4/4; signal eligible |
| Synthetic cluster diagnostics | N/A as a quality claim | silhouette=1; median pairwise ARI=1; no singleton; fixture style partitions/profiles match |
| Manual demo Top5/10 rows (three algorithms) | 495 | 630 |
| Manual demo candidate component rows | 96,863 | 123,152 |
| Test benchmark | N/A; observation coverage unknown | 12/14 queries have observed positives |

Synthetic generator produces **147 ratings, 73 watches, 1 search, 14 users and 27 fixture titles**. Selection is the first nine lexicographic single-genre Movies with positive runtime for each approved genre. Every exported watch has runtime-consistent seconds/completion. Each train/validation/test outcome window contains **36 targets: 12 liked, 12 neutral, 12 disliked**. The ranking candidate pool uses the complete valid 8,807-title catalog minus each user's prior seen titles.

Synthetic test **Precision, Recall and NDCG at both 5 and 10 are exactly 0 for Popularity, Content and Hybrid**. Precision averages all 14 queries; Recall/NDCG average the same 12 defined queries. The validation grid also has zero NDCG10, so the documented tie rule selects **C=1, P=T=K=0**. These results do not demonstrate recommendation quality or a hybrid improvement. The fixture, seven-day windows and full candidate pool were preserved.

The synthetic tree selects `ccp_alpha_0.05920376`; test macro F1=0.555556, accuracy=0.666667, liked-class F1=1.000000, with support12/class. Tree class predictions and ranking relevance are different evaluations. Rules, importance, preprocessing, all validation candidates and class metrics are saved in the private preference report.

## Actual commands

Run from the repository root with the existing venv. `LOKY_MAX_CPU_COUNT=4` avoids a macOS physical-core detection warning; it changes no model contract.

```bash
mining/.venv/bin/python mining/generate_week5_demo.py --catalog tmp/catalog_clean.csv --output-dir tmp/week5/synthetic/input
LOKY_MAX_CPU_COUNT=4 mining/.venv/bin/python mining/build_user_clusters.py --source-manifest tmp/week5/synthetic/input/source_manifest.json --cohort synthetic --output-dir tmp/week5/synthetic/benchmark/clusters --cutoff 2026-08-01T00:00:00Z --mode fit
mining/.venv/bin/python mining/evaluate_ranking.py --source-manifest tmp/week5/synthetic/input/source_manifest.json --cohort synthetic --output-dir tmp/week5/synthetic/benchmark/evaluation --train-cutoff 2026-08-01T00:00:00Z --validation-cutoff 2026-08-08T00:00:00Z --test-cutoff 2026-08-15T00:00:00Z --cluster-run tmp/week5/synthetic/benchmark/clusters --trusted-models
mining/.venv/bin/python mining/build_hybrid_ranking.py --source-manifest tmp/week5/synthetic/input/source_manifest.json --cohort synthetic --output-dir tmp/week5/synthetic/demo/ranking --cutoff 2026-08-22T00:00:00Z --cluster-run tmp/week5/synthetic/benchmark/clusters --preference-run tmp/week5/synthetic/benchmark/evaluation --weight-source manual_demo --trusted-models
mining/.venv/bin/python mining/build_hybrid_ranking.py --source-manifest tmp/week5/synthetic/input/source_manifest.json --cohort synthetic --output-dir tmp/week5/synthetic/benchmark/ranking --cutoff 2026-08-15T00:00:00Z --cluster-run tmp/week5/synthetic/benchmark/clusters --preference-run tmp/week5/synthetic/benchmark/evaluation --weight-source validation_selected --trusted-models
LOKY_MAX_CPU_COUNT=4 mining/.venv/bin/python mining/build_user_clusters.py --source-manifest tmp/week4_preference_manifest.json --cohort team_test --output-dir tmp/week5/team_test/demo/clusters --cutoff 2026-09-17T00:00:00Z --mode fit
mining/.venv/bin/python mining/build_hybrid_ranking.py --source-manifest tmp/week4_preference_manifest.json --cohort team_test --output-dir tmp/week5/team_test/demo/ranking --cutoff 2026-09-17T00:00:00Z --cluster-run tmp/week5/team_test/demo/clusters --weight-source manual_demo
mining/.venv/bin/python mining/evaluate_ranking.py --source-manifest tmp/week4_preference_manifest.json --cohort team_test --output-dir tmp/week5/team_test/benchmark/evaluation
LOKY_MAX_CPU_COUNT=4 mining/.venv/bin/python mining/build_user_clusters.py --source-manifest tmp/week5/synthetic/input/source_manifest.json --cohort synthetic --output-dir tmp/week5/synthetic/demo/assignments --cutoff 2026-08-22T00:00:00Z --mode assign --model tmp/week5/synthetic/benchmark/clusters --trusted-models
```

Optional unavailable models renormalize manual scores. A degenerate fit produces no bundle, null assignments and an explicit `insufficient_data` report; ranking from that run succeeds with available components/fallback.

## Verification receipts

- A separate adversarial no-load exercise supplied a synthetic preference-run path to team ranking: tree/cluster scores remained null and neither bundle was loaded. The canonical team command above omits that foreign reference; its existing CSV/JSON outputs were verified byte-identical.
- All four CLI `--self-check` runs pass. Snapshot, pure tree, and golden checks also pass. Existing Week3 baseline and Week4 dataset/tree self-checks pass; old raw pipelines were not rerun.
- All **11 new modules compile**, each stays at most400 lines and every function at most50 lines.
- Golden checks cover NULL/equal/future/override/conflicting ties/multigenre/repair/duplicates/cohort/canonical joins/source hashes; degenerate/constant K, train-only scaler, ARI permutation; true cosine, distinct popularity/cmax0, tree classes/train medians/masks; same pools, weights/renormalization/real zero/ties/cold/empty/fewer results; windows/unknown coverage/no positives/determinism.
- Trusted model roundtrip preserves cluster assignments and tree probabilities/preprocessing. **Nine negative guards reject before unpickling** (cohort/schema/hash/runtime/features/time/trust/checksum); the actual selected tree rejects an August8 query and an actual cross-cohort cluster rejects loading.
- Synthetic scaler equals train-only means and is unchanged by August22 assignment. Models/weights selected through August15 serve test at equality; validation tables are selection results.
- Complete isolated reruns under `tmp/week5/synthetic/repro/` and `tmp/week5/team_test/repro/` reproduce **46 CSV/JSON artifacts** (CSV bytes and logical JSON; generated timestamps, command/path fields and binary bundle checksums excluded from logical JSON comparisons).
- Inertia and assignment distance exports use12 decimal places to remove insignificant floating reduction differences; model fitting and signal gates use the computed values.
- KMeans fitting limits the existing sklearn threadpool utility to one thread, so symmetric K2 fixture partitions reproduce across processes. No package was added.
- Primary orchestration verified **all17 protected old source/raw/Week4 hashes unchanged**. No dependencies, backend/frontend/migrations/Notion changes, staging, commits or pushes.

Private receipts: `tmp/week5/receipts/{delegation,self_checks,degenerate_cli,integration,reproducibility,final_ranking_commands,canonical_team_command}.json`. The delegation receipt records three completed real `mcp__deepseek_worker__delegate` roles A/B/C; no tool-returned model identifier was available.

## Artifact map

| Location | Contents |
| --- | --- |
| `tmp/week5/synthetic/input/` | Source CSVs, hashes, fixture-only style map and declared coverage |
| `tmp/week5/synthetic/benchmark/clusters/` | Train scaler/KMeans, raw user rows, assignments, profiles, gate diagnostics, guarded sidecar |
| `tmp/week5/synthetic/benchmark/evaluation/` | Query/split manifests, targets/features, tree+guarded sidecar, candidates,286 weights, benchmark and reports |
| `tmp/week5/synthetic/{demo,benchmark}/ranking/` | Manual demo / validation-selected test components, popularity, TopK, coverage and provenance |
| `tmp/week5/team_test/{demo,benchmark}/` | Provisional cluster, Content/Popularity smoke lists and explicit N/A benchmark report |

Shared APIs use ordinary dictionaries. `build_user_matrix` returns `{user_keys, rows, feature_names}`; `build_candidate_features` returns a show_id-keyed feature dictionary. Identity/style/cohort metadata stays outside X. Model guards use separate `schema_version=week5-v1`, `user_clusters-v1` and `preference_ranker-v1` with exact feature/preprocessing order.

Limits: synthetic metrics describe a controlled fixture; team coverage remains unknown and ranking quality is N/A. Real-user relevance, live provider/API/UI behavior and Week6 runtime integration were not checked.
