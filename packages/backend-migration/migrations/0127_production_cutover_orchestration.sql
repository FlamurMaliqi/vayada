-- Migration: 0127_production_cutover_orchestration
-- Owner: platform migration
-- See: engineering/migration-parity-harness.md

CREATE TABLE platform.production_cutover_runs (
  run_id                           TEXT        PRIMARY KEY
                                               CHECK (run_id ~ '^vay1360-[0-9a-f]{24}$'),
  mode                             TEXT        NOT NULL
                                               CHECK (mode IN ('staging_rehearsal', 'cutover_dry_run', 'production_cutover')),
  environment                      TEXT        NOT NULL
                                               CHECK (environment IN ('staging', 'preprod', 'production')),
  source_environment               TEXT        NOT NULL
                                               CHECK (source_environment IN ('staging', 'preprod')),
  source_run_id                    TEXT        NOT NULL
                                               CHECK (source_run_id ~ '^vay1351-[0-9a-f]{24}$'),
  config_sha256                    TEXT        NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  source_tags_sha256               JSONB       NOT NULL,
  application_release              TEXT        NOT NULL CHECK (application_release ~ '^[0-9a-f]{40}$'),
  target_identity_sha256           TEXT        NOT NULL CHECK (target_identity_sha256 ~ '^[0-9a-f]{64}$'),
  operator_sha256                  TEXT        NOT NULL CHECK (operator_sha256 ~ '^[0-9a-f]{64}$'),
  abort_operator_sha256            TEXT        CHECK (abort_operator_sha256 ~ '^[0-9a-f]{64}$'),
  approved_run_id                  TEXT,
  approved_report_checksum_sha256  TEXT,
  approved_run_evidence_sha256     TEXT,
  approved_parity_decision         TEXT        CHECK (approved_parity_decision IN ('go', 'review', 'no-go')),
  approval_proof_sha256            TEXT,
  backup_proof_sha256              TEXT,
  target_clean_proof_sha256        TEXT        NOT NULL CHECK (target_clean_proof_sha256 ~ '^[0-9a-f]{64}$'),
  freeze_proof_sha256              TEXT        NOT NULL CHECK (freeze_proof_sha256 ~ '^[0-9a-f]{64}$'),
  smoke_proof_sha256               TEXT        CHECK (smoke_proof_sha256 ~ '^[0-9a-f]{64}$'),
  status                           TEXT        NOT NULL
                                               CHECK (status IN ('running', 'awaiting_smoke', 'failed', 'aborted', 'completed')),
  current_step                     TEXT,
  last_safe_checkpoint             TEXT,
  parity_report_checksum_sha256    TEXT,
  parity_decision                  TEXT CHECK (parity_decision IN ('go', 'review', 'no-go')),
  failure_code                     TEXT,
  evidence                         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  started_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                      TIMESTAMPTZ,
  CHECK (
    (mode = 'staging_rehearsal' AND environment = 'staging' AND source_environment = 'staging')
    OR (mode = 'cutover_dry_run' AND environment = 'preprod' AND source_environment = 'preprod')
    OR (
      mode = 'production_cutover' AND environment = 'production' AND source_environment = 'preprod'
      AND approved_run_id IS NOT NULL
      AND approved_run_id ~ '^vay1360-[0-9a-f]{24}$'
      AND approved_run_id <> run_id
      AND approved_report_checksum_sha256 IS NOT NULL
      AND approved_report_checksum_sha256 ~ '^[0-9a-f]{64}$'
      AND approved_run_evidence_sha256 IS NOT NULL
      AND approved_run_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND approved_parity_decision IS NOT NULL
      AND approved_parity_decision = 'go'
      AND approval_proof_sha256 IS NOT NULL
      AND approval_proof_sha256 ~ '^[0-9a-f]{64}$'
      AND backup_proof_sha256 IS NOT NULL
      AND backup_proof_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CHECK ((status IN ('failed', 'aborted', 'completed')) = (finished_at IS NOT NULL)),
  CHECK (
    status <> 'awaiting_smoke'
    OR (
      current_step = 'smoke_evidence'
      AND parity_decision = 'go'
      AND parity_report_checksum_sha256 IS NOT NULL
      AND parity_report_checksum_sha256 ~ '^[0-9a-f]{64}$'
      AND finished_at IS NULL
    )
  ),
  CHECK (
    status <> 'completed'
    OR (
      current_step IS NULL
      AND parity_decision = 'go'
      AND parity_report_checksum_sha256 IS NOT NULL
      AND parity_report_checksum_sha256 ~ '^[0-9a-f]{64}$'
      AND smoke_proof_sha256 IS NOT NULL
      AND smoke_proof_sha256 ~ '^[0-9a-f]{64}$'
      AND failure_code IS NULL
    )
  )
);

CREATE TABLE platform.production_cutover_steps (
  run_id             TEXT        NOT NULL REFERENCES platform.production_cutover_runs(run_id),
  step_order         INTEGER     NOT NULL CHECK (step_order > 0),
  step_name          TEXT        NOT NULL,
  status             TEXT        NOT NULL
                                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  safe_checkpoint    BOOLEAN     NOT NULL DEFAULT FALSE,
  attempt_count      INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  output_sha256      TEXT,
  failure_code       TEXT,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  PRIMARY KEY (run_id, step_name),
  UNIQUE (run_id, step_order),
  CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_production_cutover_runs_status_updated
  ON platform.production_cutover_runs (status, updated_at DESC);

CREATE INDEX idx_production_cutover_steps_run_order
  ON platform.production_cutover_steps (run_id, step_order);

CREATE UNIQUE INDEX uq_production_cutover_single_use_approval
  ON platform.production_cutover_runs (approval_proof_sha256)
  WHERE mode = 'production_cutover';
