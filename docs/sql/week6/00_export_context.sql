SELECT
    CURRENT_TIMESTAMP AS export_cutoff,
    'unknown'::text AS cohort,
    to_regclass(
        'interaction.watch_sessions_for_mining'
    )::text AS watch_mining_view;
