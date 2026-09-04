-- Migration: 0134_production_booking_migration_quarantines
-- Owner: booking / VAY-1430
--
-- Unsupported legacy guest fields and empty placeholder rows are retained as
-- hash-only evidence. Raw values remain solely in the immutable source snapshot.

CREATE TABLE platform.production_booking_migration_quarantines (
  source_run_id       TEXT        NOT NULL
                                  REFERENCES platform.source_extraction_runs(run_id),
  source_database     TEXT        NOT NULL CHECK (source_database IN ('booking', 'pms')),
  source_table        TEXT        NOT NULL,
  source_id           TEXT        NOT NULL,
  source_field        TEXT        NOT NULL,
  source_value_sha256 CHAR(64)    NOT NULL CHECK (source_value_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code         TEXT        NOT NULL CHECK (reason_code IN (
                                    'EMPTY_ADDITIONAL_GUEST_PLACEHOLDER',
                                    'UNSUPPORTED_GUEST_PRIVATE_FIELD'
                                  )),
  retention_until     DATE        NOT NULL,
  quarantined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    source_run_id, source_database, source_table, source_id, source_field, reason_code
  )
);

CREATE FUNCTION platform.protect_production_booking_migration_quarantine()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'production Booking quarantine evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_production_booking_migration_quarantines_immutable
BEFORE UPDATE OR DELETE ON platform.production_booking_migration_quarantines
FOR EACH ROW EXECUTE FUNCTION platform.protect_production_booking_migration_quarantine();

CREATE TRIGGER trg_production_booking_migration_quarantines_protect_truncate
BEFORE TRUNCATE ON platform.production_booking_migration_quarantines
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_production_booking_migration_quarantine();

-- A missing legacy billing plan is intentionally interpreted as the
-- pre-switch commission contract. Keep that inference outside mutable booking
-- metadata and bind it to both the source field and immutable source row.
CREATE TABLE platform.production_booking_migration_inferences (
  source_run_id       TEXT        NOT NULL
                                  REFERENCES platform.source_extraction_runs(run_id),
  source_database     TEXT        NOT NULL CHECK (source_database = 'pms'),
  source_table        TEXT        NOT NULL CHECK (source_table = 'bookings'),
  source_id           TEXT        NOT NULL,
  source_field        TEXT        NOT NULL CHECK (source_field = 'billing_plan_at_creation'),
  source_value_sha256 CHAR(64)    NOT NULL CHECK (source_value_sha256 ~ '^[0-9a-f]{64}$'),
  source_row_sha256   CHAR(64)    NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  inferred_value      TEXT        NOT NULL CHECK (inferred_value = 'commission'),
  reason_code         TEXT        NOT NULL CHECK (
                                  reason_code = 'MISSING_BILLING_PLAN_PRE_SWITCH_COMMISSION'),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_run_id, source_database, source_table, source_id, source_field)
);

CREATE FUNCTION platform.protect_production_booking_migration_inference()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'production Booking inference evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_production_booking_migration_inferences_immutable
BEFORE UPDATE OR DELETE ON platform.production_booking_migration_inferences
FOR EACH ROW EXECUTE FUNCTION platform.protect_production_booking_migration_inference();

CREATE TRIGGER trg_production_booking_migration_inferences_protect_truncate
BEFORE TRUNCATE ON platform.production_booking_migration_inferences
FOR EACH STATEMENT EXECUTE FUNCTION platform.protect_production_booking_migration_inference();

-- Legacy bookings only retained one aggregate add-on amount, even when several
-- named items were purchased. The immutable selection keeps that economic fact
-- once; this view expands its item snapshot for product read models without
-- inventing per-item prices.
CREATE VIEW booking.booking_addon_selection_items AS
SELECT
  selection.id AS selection_id,
  selection.property_id,
  selection.guest_booking_id,
  selection.quote_session_id,
  COALESCE(
    NULLIF(item.value ->> 'sourceAddonId', ''),
    definition.source_addon_id,
    definition.id::text,
    selection.id::text
  ) AS addon_key,
  COALESCE(
    NULLIF(item.value ->> 'name', ''),
    NULLIF(selection.addon_snapshot ->> 'name', ''),
    definition.name,
    'Unavailable add-on'
  ) AS addon_name,
  CASE
    WHEN item.value ->> 'quantity' ~ '^[1-9][0-9]*$'
      THEN (item.value ->> 'quantity')::INTEGER
    ELSE selection.quantity
  END AS quantity,
  CASE
    WHEN jsonb_typeof(item.value -> 'serviceDates') = 'array'
      THEN item.value -> 'serviceDates'
    WHEN jsonb_typeof(selection.addon_snapshot -> 'serviceDates') = 'array'
      THEN selection.addon_snapshot -> 'serviceDates'
    WHEN selection.service_date IS NOT NULL
      THEN jsonb_build_array(selection.service_date::text)
    ELSE '[]'::JSONB
  END AS service_dates,
  selection.total_amount AS selection_total_amount,
  selection.currency,
  selection.created_at,
  item.ordinality::INTEGER AS item_ordinality
FROM booking.booking_addon_selections selection
LEFT JOIN booking.addon_definitions definition
  ON definition.id = selection.addon_definition_id
 AND definition.property_id = selection.property_id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(selection.addon_snapshot -> 'items') = 'array'
      THEN selection.addon_snapshot -> 'items'
    ELSE jsonb_build_array('{}'::JSONB)
  END
) WITH ORDINALITY AS item(value, ordinality);
