-- Migration: 0133_production_media_field_quarantines
-- Owner: platform-media / VAY-1416
--
-- Malformed legacy media fields are retained only as redacted, immutable
-- evidence. The raw value is never copied to the target or made public.

ALTER TABLE platform.production_media_migration_runs
  ADD COLUMN quarantined_count INTEGER NOT NULL DEFAULT 0
    CHECK (quarantined_count >= 0);

CREATE TABLE platform.production_media_migration_quarantines (
  source_run_id           TEXT        NOT NULL,
  source_system           TEXT        NOT NULL
                                       CHECK (source_system IN ('booking', 'marketplace', 'pms')),
  source_table            TEXT        NOT NULL,
  source_row_id           TEXT        NOT NULL,
  purpose                 TEXT        NOT NULL,
  source_field            TEXT        NOT NULL,
  source_value_sha256     CHAR(64)    NOT NULL
                                       CHECK (source_value_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code             TEXT        NOT NULL
                                       CHECK (reason_code IN (
                                         'INVALID_HTTPS_URL',
                                         'INVALID_STRING_ARRAY'
                                       )),
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_run_id, source_system, source_table, source_row_id, purpose),
  CONSTRAINT fk_production_media_migration_quarantines_run
    FOREIGN KEY (source_run_id)
    REFERENCES platform.production_media_migration_runs(source_run_id)
);

CREATE OR REPLACE FUNCTION platform.protect_production_media_migration_quarantine()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'production media quarantine evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF to_jsonb(OLD) - 'updated_at' IS DISTINCT FROM to_jsonb(NEW) - 'updated_at' THEN
    RAISE EXCEPTION 'production media quarantine evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_production_media_migration_quarantines_immutable
BEFORE UPDATE OR DELETE ON platform.production_media_migration_quarantines
FOR EACH ROW EXECUTE FUNCTION platform.protect_production_media_migration_quarantine();

CREATE TRIGGER trg_production_media_migration_quarantines_protect_truncate
BEFORE TRUNCATE ON platform.production_media_migration_quarantines
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_production_media_migration_quarantine();
