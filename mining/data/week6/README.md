# Week 6 synthetic mining dataset

This is a curated, pseudonymized snapshot exported from the Helio CineMind database.

- Export cutoff: `2026-10-23T18:37:20.421859+00:00`.
- The event export originally labeled its cohort as `unknown`. This public snapshot includes only rows whose source `user_key` matched the 100-user synthetic cohort map; those included rows are labeled `synthetic`. Unmapped event rows are excluded.
- Original user and event keys have been replaced with snapshot-local aliases. The same `user_key` alias joins a user's events across files.
- The data contains no account email, raw account/session identifier, password, or search-query text. Search rows contain timestamps only.
- The `show_id` values refer to the CineMind catalog; this folder does not duplicate catalog content.

## Files

| File | Rows | Purpose |
| --- | ---: | --- |
| `ratings.csv` | 2,000 | Synthetic rating events, with unique aliased `target_key` values. |
| `watches_for_mining.csv` | 2,000 | Synthetic watch-duration events, with unique aliased `watch_key` values. |
| `searches.csv` | 500 | Search timestamps only, with unique aliased `search_key` values. |
| `week6_cohort_map.csv` | 100 | Pseudonymous user-to-group map; four groups of 25 users each. |
| `week6_export_context.csv` | 1 | Shared export cutoff and source watch view. |

The event CSV headers match the input contract used by `mining/build_preference_dataset.py`. Rebuild the derived recommendation artifact from these source CSVs using the project pipeline; generated artifacts and the original raw exports remain outside this shared dataset.
