-- Migration: 0120_immutable_source_extraction
-- Owner: migration-cutover; see VAY-1351

CREATE TABLE platform.source_extraction_runs (
  run_id                 TEXT        PRIMARY KEY,
  environment            TEXT        NOT NULL CHECK (environment IN ('local', 'staging', 'preprod')),
  source_schema_revision CHAR(40)    NOT NULL CHECK (source_schema_revision ~ '^[0-9a-f]{40}$'),
  cutover_freeze_proof_sha256 CHAR(64) CHECK (cutover_freeze_proof_sha256 ~ '^[0-9a-f]{64}$'),
  status                 TEXT        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at            TIMESTAMPTZ,
  duration_ms            BIGINT      CHECK (duration_ms >= 0),
  failure_code           TEXT,
  attempt_count          INTEGER     NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_failure_code      TEXT,
  CONSTRAINT chk_source_extraction_run_completion
    CHECK (
      (status = 'running' AND finished_at IS NULL AND duration_ms IS NULL AND failure_code IS NULL)
      OR (status = 'completed' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND failure_code IS NOT NULL)
    )
);

CREATE TABLE platform.source_extraction_sources (
  run_id                      TEXT        NOT NULL REFERENCES platform.source_extraction_runs(run_id),
  source_database             TEXT        NOT NULL CHECK (source_database IN ('auth', 'booking', 'marketplace', 'pms')),
  snapshot_identifier         TEXT        NOT NULL,
  expected_database_name      TEXT        NOT NULL,
  expected_schema_fingerprint CHAR(32)    NOT NULL CHECK (expected_schema_fingerprint ~ '^[0-9a-f]{32}$'),
  actual_schema_fingerprint   CHAR(32),
  status                      TEXT        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  row_count                   BIGINT      CHECK (row_count >= 0),
  checksum_sha256             CHAR(64)    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                 TIMESTAMPTZ,
  duration_ms                 BIGINT      CHECK (duration_ms >= 0),
  failure_code                TEXT,
  attempt_count               INTEGER     NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_failure_code           TEXT,
  PRIMARY KEY (run_id, source_database),
  CONSTRAINT chk_source_extraction_source_fingerprint
    CHECK (actual_schema_fingerprint IS NULL OR actual_schema_fingerprint ~ '^[0-9a-f]{32}$'),
  CONSTRAINT chk_source_extraction_source_completion
    CHECK (
      (status = 'running' AND finished_at IS NULL AND duration_ms IS NULL AND row_count IS NULL
        AND checksum_sha256 IS NULL AND failure_code IS NULL)
      OR (status = 'completed' AND actual_schema_fingerprint IS NOT NULL
        AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND row_count IS NOT NULL
        AND checksum_sha256 IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL
        AND failure_code IS NOT NULL)
    )
);

CREATE TABLE platform.source_extraction_tables (
  run_id          TEXT        NOT NULL,
  source_database TEXT        NOT NULL,
  source_schema   TEXT        NOT NULL,
  source_table    TEXT        NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  row_count       BIGINT      CHECK (row_count >= 0),
  checksum_sha256 CHAR(64)    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  duration_ms     BIGINT      CHECK (duration_ms >= 0),
  failure_code    TEXT,
  attempt_count   INTEGER     NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_failure_code TEXT,
  PRIMARY KEY (run_id, source_database, source_schema, source_table),
  FOREIGN KEY (run_id, source_database)
    REFERENCES platform.source_extraction_sources(run_id, source_database),
  CONSTRAINT chk_source_extraction_table_completion
    CHECK (
      (status = 'running' AND finished_at IS NULL AND duration_ms IS NULL AND row_count IS NULL
        AND checksum_sha256 IS NULL AND failure_code IS NULL)
      OR (status = 'completed' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL
        AND row_count IS NOT NULL AND checksum_sha256 IS NOT NULL AND failure_code IS NULL)
      OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
    )
);

DO $$
DECLARE
  source_name TEXT;
  staging_schema TEXT;
BEGIN
  FOREACH source_name IN ARRAY ARRAY['auth', 'booking', 'marketplace', 'pms'] LOOP
    staging_schema := 'migration_source_' || source_name;
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', staging_schema);
    EXECUTE format(
      'CREATE TABLE %I.snapshot_rows (
         run_id                  TEXT     NOT NULL REFERENCES platform.source_extraction_runs(run_id),
         snapshot_identifier     TEXT     NOT NULL,
         source_schema           TEXT     NOT NULL,
         source_table            TEXT     NOT NULL,
         row_ordinal             BIGINT   NOT NULL CHECK (row_ordinal > 0),
         row_checksum_sha256     CHAR(64) NOT NULL CHECK (row_checksum_sha256 ~ ''^[0-9a-f]{64}$''),
         row_data                JSONB    NOT NULL,
         PRIMARY KEY (run_id, source_schema, source_table, row_ordinal)
       )',
      staging_schema
    );
  END LOOP;
END;
$$;
