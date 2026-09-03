-- Migration: 0140_production_marketplace_migration_quarantines
-- Owner: marketplace / VAY-1361
--
-- Legacy Marketplace values that cannot safely become product state are kept
-- only as immutable hashes. Raw values remain in the source snapshot.

CREATE TABLE platform.production_marketplace_migration_quarantines (
  source_run_id       TEXT        NOT NULL
                                  REFERENCES platform.source_extraction_runs(run_id),
  source_table        TEXT        NOT NULL,
  source_id           TEXT        NOT NULL,
  source_field        TEXT        NOT NULL,
  source_value_sha256 CHAR(64)    NOT NULL CHECK (source_value_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code         TEXT        NOT NULL CHECK (reason_code IN (
                                    'MISSING_COLLABORATION_COMPENSATION_TYPE_RETAINED_NULL',
                                    'INVALID_AUDIENCE_PERCENTAGE_ENTRY_OMITTED',
                                    'UNAPPROVED_CREATOR_PROFILE_MEDIA_OMITTED',
                                    'EXPIRED_INVITE_MEDIA_PAYLOAD_OMITTED',
                                    'ORPHANED_IDENTITY_DEPENDENT_ROW_OMITTED'
                                  )),
  retention_until     DATE        NOT NULL,
  quarantined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_run_id, source_table, source_id, source_field, reason_code)
);

CREATE FUNCTION platform.protect_production_marketplace_migration_quarantine()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'production Marketplace quarantine evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_production_marketplace_migration_quarantines_immutable
BEFORE UPDATE OR DELETE ON platform.production_marketplace_migration_quarantines
FOR EACH ROW EXECUTE FUNCTION platform.protect_production_marketplace_migration_quarantine();

CREATE TRIGGER trg_production_marketplace_migration_quarantines_protect_truncate
BEFORE TRUNCATE ON platform.production_marketplace_migration_quarantines
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_production_marketplace_migration_quarantine();
