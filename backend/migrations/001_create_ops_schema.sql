CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.dataset_sources (
    source_id UUID PRIMARY KEY,
    source_name TEXT NOT NULL,
    source_type VARCHAR(32) NOT NULL,
    source_uri TEXT,
    schema_version VARCHAR(64) NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL,
    checksum_sha256 CHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT dataset_sources_name_type_uq UNIQUE (source_name, source_type)
);

CREATE TABLE IF NOT EXISTS ops.ingestion_runs (
    ingestion_run_id UUID PRIMARY KEY,
    source_id UUID NOT NULL REFERENCES ops.dataset_sources(source_id),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL,
    rows_read INTEGER NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
    rows_loaded INTEGER NOT NULL DEFAULT 0 CHECK (rows_loaded >= 0),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ingestion_runs_status_ck CHECK (
        status IN ('running', 'succeeded', 'succeeded_with_warnings', 'failed')
    )
);

CREATE TABLE IF NOT EXISTS ops.data_quality_issues (
    issue_id BIGSERIAL PRIMARY KEY,
    ingestion_run_id UUID NOT NULL REFERENCES ops.ingestion_runs(ingestion_run_id),
    table_name TEXT NOT NULL,
    record_key TEXT,
    issue_type VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT data_quality_issues_severity_ck CHECK (
        severity IN ('info', 'warning', 'error')
    )
);

CREATE INDEX IF NOT EXISTS ingestion_runs_source_started_idx
    ON ops.ingestion_runs (source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS data_quality_issues_run_idx
    ON ops.data_quality_issues (ingestion_run_id, severity);
