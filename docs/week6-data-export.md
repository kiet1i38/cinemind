# Week 6 — Helio CSV export runbook

This is a read-only export of production interaction data for the approved local Data Mining demo. Do not run `INSERT`, `UPDATE`, `DELETE`, DDL, reset, or other writes in the Helio SQL console for this workflow.

## Privacy and destination

- Export only the five result sets in [`sql/week6/`](sql/week6/).
- Keep the resulting CSVs in the ignored local path `CineMind/tmp/week6/seed/`; do not commit them, attach them to a public issue, or copy them into `flag.md`.
- Event rows contain stable pseudonymous keys and viewing/search event metadata. Pseudonymization is reversible by someone with the source database and is not anonymization.
- Search text, e-mail, username, user UUID, password hash, auth token, session UUID, and cookie are not output by these queries.
- Use the same cutoff for the context, ratings, watches, and searches exports. Export the cohort map separately; it outputs only a pseudonymous key and approved group.

## Export order

1. Open the Helio Database Viewer and confirm it is connected to the CineMind production database.
2. Run [`00_export_context.sql`](sql/week6/00_export_context.sql). Download its single row as `week6_export_context.csv`. If `watch_mining_view` is blank/NULL, stop; do not alter the production schema.
3. Copy the returned `export_cutoff` exactly into the `EXPORT_CUTOFF` placeholder in files `01`–`03`. Run each query and download its result immediately as `ratings.csv`, `watches_for_mining.csv`, and `searches.csv` respectively. Preserve the header row and all returned rows; do not add filters or limits.
4. Run [`04_cohort_map.sql`](sql/week6/04_cohort_map.sql), download as `week6_cohort_map.csv`, and verify 100 rows total with 25 in each group. The query must not be edited to return identifying columns.
5. Move/rename the five files into `CineMind/tmp/week6/seed/` with exact names. Do not merge files exported with different cutoffs.

The SQL Viewer may say a download completed without surfacing a file in the expected local folder. Check the browser's configured download destination and file-exists list manually; do not assume a download succeeded merely from its toast. On 2026-10-24, all five files were confirmed in `tmp/week6/seed/` and validated locally: one context row, 4,031 rating rows, 4,031 watch rows, 502 search rows, and 100 cohort-map rows (25 per group). They use the shared cutoff recorded in the context file.

## Verify locally without printing row data

From the repository root in PowerShell:

```powershell
$seed = 'tmp/week6/seed'
Get-ChildItem $seed -File | Select-Object Name, Length
```

Confirm all five basenames exist and are non-empty. Keep the files in the ignored `tmp/` tree. Then run the builder using the Docker Compose runbook. Do not open CSV contents in shared logs/screenshots; use the builder's aggregate counts and status.

For the current snapshot, 9 legacy `rating_value=0` rows mean “No rating” from an older UI and are counted but excluded from preference labels; the input CSV is not modified. The viewer serializes nullable `completion_rate` as `NULL`; the builder preserves these as missing values (2,030 in this snapshot), not as zero. Other malformed/out-of-range values still fail validation.

## Export limitations

- The Viewer executes each query separately. A shared cutoff bounds event time, but does not create a single cross-query database snapshot; concurrent writes can make the exports differ slightly.
- Client occurrence time is included only after the SQL query also bounds server receive/record time by the cutoff. Unexpected invalid timestamps/values or stale `show_id` references fail validation, not silently repaired; the documented legacy no-rating zero and nullable completion cases are handled explicitly above.
- Exported event timestamps prefer `client_occurred_at` over server receipt time (the `COALESCE` in files `01`–`03`), so they can differ from the Week 4 manifest's server-time-only `event_time_policy` by client clock skew. The cutoff filter bounds both bases. This affects which duplicate rating/watch counts as "latest" downstream, not event inclusion.
- Cohort group labels are descriptive metadata and are excluded from the feature model.
- Exporting a snapshot does not automatically include later Helio interactions. Repeat all exports with a new cutoff to refresh the snapshot.
