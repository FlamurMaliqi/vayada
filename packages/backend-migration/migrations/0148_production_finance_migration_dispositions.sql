-- Migration: 0148_production_finance_migration_dispositions
-- Owner: finance / VAY-1461
--
-- Finance source values that cannot safely become active target state are
-- retained as immutable hash evidence. Provider and payout destinations remain
-- only in the immutable source snapshot and require approved target re-entry.

CREATE TABLE platform.production_finance_migration_dispositions (
  source_run_id       TEXT        NOT NULL
                                  REFERENCES platform.source_extraction_runs(run_id),
  source_database     TEXT        NOT NULL CHECK (source_database IN ('booking', 'pms')),
  source_table        TEXT        NOT NULL,
  source_id           TEXT        NOT NULL,
  source_field        TEXT        NOT NULL,
  source_value_sha256 CHAR(64)    NOT NULL CHECK (source_value_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code         TEXT        NOT NULL CHECK (reason_code IN (
                                    'INVALID_FINANCE_SOURCE_ROW',
                                    'INVALID_BOOKING_FINANCE_ALLOCATION',
                                    'BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED',
                                    'PAYMENT_CAPTURE_EVIDENCE_REQUIRED',
                                    'MISSING_PAYMENT_PROVIDER_ACCOUNT_ID',
                                    'LEGACY_PAYMENT_PROVIDER_REFERENCE_QUARANTINED',
                                    'LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED',
                                    'FINANCE_PARENT_RECORD_QUARANTINED',
                                    'MISSING_PROVIDER_ACCOUNT_ID',
                                    'MISSING_PAYOUT_PROVIDER_ACCOUNT_ID',
                                    'PAYMENT_SETTINGS_SOURCE_DISAGREEMENT',
                                    'BANK_TRANSFER_DESTINATION_REENTRY_REQUIRED',
                                    'PAYPAL_DESTINATION_REENTRY_REQUIRED',
                                    'SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED',
                                    'PAYOUT_PAYMENT_ALLOCATION_EVIDENCE_REQUIRED',
                                    'NONCANONICAL_BOOKING_ENGINE_FEE',
                                    'NONCANONICAL_FIXED_PLAN_PRICING',
                                    'FIXED_PLAN_PROVIDER_REBIND_REQUIRED',
                                    'BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT',
                                    'FIXED_PLAN_SUBSCRIPTION_EVIDENCE_REQUIRED',
                                    'FIXED_PLAN_BILLING_PRICE_DIRTY',
                                    'FIXED_PLAN_BILLING_PRICE_EVIDENCE_REQUIRED',
                                    'INVALID_FIXED_PLAN_BILLING_EVIDENCE',
                                    'FIXED_PLAN_BILLING_AMOUNT_MISMATCH'
                                  )),
  disposition         TEXT        NOT NULL CHECK (disposition IN (
                                    'omitted_row',
                                    'omitted_field',
                                    'disabled_configuration',
                                    'target_reentry_required',
                                    'unbound_history'
                                  )),
  target_table        TEXT,
  target_id           UUID,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    source_run_id, source_database, source_table, source_id, source_field, reason_code
  ),
  CHECK ((target_table IS NULL) = (target_id IS NULL))
);

CREATE FUNCTION platform.protect_production_finance_migration_disposition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'production Finance migration disposition evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_production_finance_migration_dispositions_immutable
BEFORE UPDATE OR DELETE ON platform.production_finance_migration_dispositions
FOR EACH ROW EXECUTE FUNCTION platform.protect_production_finance_migration_disposition();

CREATE TRIGGER trg_production_finance_migration_dispositions_protect_truncate
BEFORE TRUNCATE ON platform.production_finance_migration_dispositions
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_production_finance_migration_disposition();
