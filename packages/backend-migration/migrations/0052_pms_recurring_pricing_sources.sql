-- Migration: 0052_pms_recurring_pricing_sources
-- Owner: domain-pms
-- See: VAY-1072, engineering/hotel-onboarding-information-inventory.md (ONB-16)
--
-- Recurring authoring is deliberately separate from legacy dated
-- pms.rate_rules. Materialized rows below are replaceable projections for one
-- bounded horizon and never become an authoring source.

CREATE FUNCTION pms.recurring_pricing_invalid_reasons_are_canonical(reasons JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  reason JSONB;
  reason_code TEXT;
  reason_identifier TEXT;
  reason_priority INTEGER;
  previous_identifier TEXT := NULL;
  previous_priority INTEGER := 0;
  uuid_pattern CONSTANT TEXT :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF reasons IS NULL OR jsonb_typeof(reasons) <> 'array' THEN
    RETURN FALSE;
  END IF;

  FOR reason IN SELECT value FROM jsonb_array_elements(reasons)
  LOOP
    IF jsonb_typeof(reason) <> 'object' OR jsonb_typeof(reason->'code') <> 'string' THEN
      RETURN FALSE;
    END IF;

    reason_code := reason->>'code';
    reason_priority := CASE reason_code
      WHEN 'pricing_currency_mismatch' THEN 1
      WHEN 'pricing_currency_revision_stale' THEN 2
      WHEN 'room_type_missing' THEN 3
      WHEN 'room_facts_revision_stale' THEN 4
      WHEN 'flexible_rate_plan_missing' THEN 5
      WHEN 'flexible_rate_plan_revision_stale' THEN 6
      WHEN 'recurring_pricing_room_plan_missing' THEN 7
      WHEN 'season_overlap' THEN 8
      WHEN 'additional_guest_capacity_inapplicable' THEN 9
      WHEN 'non_refundable_payment_timing_invalid' THEN 10
      WHEN 'dependency_unavailable' THEN 11
      ELSE 0
    END;

    IF reason_priority = 0 THEN
      RETURN FALSE;
    ELSIF reason_code IN (
      'room_type_missing',
      'room_facts_revision_stale',
      'flexible_rate_plan_missing',
      'flexible_rate_plan_revision_stale',
      'recurring_pricing_room_plan_missing',
      'additional_guest_capacity_inapplicable'
    ) THEN
      reason_identifier := reason->>'roomTypeId';
      IF reason_identifier IS NULL
        OR reason_identifier !~ uuid_pattern
        OR reason <> jsonb_build_object(
          'code', reason_code, 'roomTypeId', reason_identifier
        )
      THEN
        RETURN FALSE;
      END IF;
    ELSIF reason_code = 'season_overlap' THEN
      reason_identifier := reason->>'conflictingSourceId';
      IF reason_identifier IS NULL
        OR reason_identifier !~ uuid_pattern
        OR reason <> jsonb_build_object(
          'code', reason_code, 'conflictingSourceId', reason_identifier
        )
      THEN
        RETURN FALSE;
      END IF;
    ELSE
      reason_identifier := '';
      IF reason <> jsonb_build_object('code', reason_code) THEN
        RETURN FALSE;
      END IF;
    END IF;

    IF reason_priority < previous_priority
      OR (reason_priority = previous_priority AND reason_identifier <= previous_identifier)
    THEN
      RETURN FALSE;
    END IF;
    previous_priority := reason_priority;
    previous_identifier := reason_identifier;
  END LOOP;

  RETURN TRUE;
END;
$$;

CREATE FUNCTION pms.recurring_pricing_weekdays_are_canonical(weekdays TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT weekdays IS NOT NULL
    AND cardinality(weekdays) BETWEEN 1 AND 7
    AND weekdays <@ ARRAY[
      'monday', 'tuesday', 'wednesday', 'thursday',
      'friday', 'saturday', 'sunday'
    ]::TEXT[]
    AND weekdays = ARRAY(
      SELECT weekday
      FROM unnest(weekdays) AS weekday
      ORDER BY array_position(
        ARRAY[
          'monday', 'tuesday', 'wednesday', 'thursday',
          'friday', 'saturday', 'sunday'
        ]::TEXT[],
        weekday
      )
    )
    AND cardinality(weekdays) = (
      SELECT count(DISTINCT weekday)::INTEGER FROM unnest(weekdays) AS weekday
    );
$$;

CREATE FUNCTION pms.recurring_pricing_month_day_is_valid(month SMALLINT, day SMALLINT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT month BETWEEN 1 AND 12
    AND day BETWEEN 1 AND CASE month
      WHEN 2 THEN 29
      WHEN 4 THEN 30
      WHEN 6 THEN 30
      WHEN 9 THEN 30
      WHEN 11 THEN 30
      ELSE 31
    END;
$$;

CREATE FUNCTION pms.recurring_pricing_room_value_shape_is_valid(
  source_kind TEXT,
  seasonal_nightly_amount NUMERIC(15, 2),
  weekend_surcharge_amount NUMERIC(15, 2),
  maximum_adult_guests SMALLINT,
  included_guest_count SMALLINT,
  additional_guest_amount NUMERIC(15, 2)
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(CASE source_kind
    WHEN 'season' THEN
      seasonal_nightly_amount > 0
      AND weekend_surcharge_amount IS NULL
      AND maximum_adult_guests IS NULL
      AND included_guest_count IS NULL
      AND additional_guest_amount IS NULL
    WHEN 'weekend_surcharge' THEN
      seasonal_nightly_amount IS NULL
      AND weekend_surcharge_amount >= 0
      AND maximum_adult_guests IS NULL
      AND included_guest_count IS NULL
      AND additional_guest_amount IS NULL
    WHEN 'additional_guest' THEN
      seasonal_nightly_amount IS NULL
      AND weekend_surcharge_amount IS NULL
      AND maximum_adult_guests >= 2
      AND included_guest_count BETWEEN 1 AND maximum_adult_guests - 1
      AND additional_guest_amount >= 0
    ELSE FALSE
  END, FALSE);
$$;

CREATE FUNCTION pms.lock_recurring_pricing_currency_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  locked_property_id UUID;
  new_row JSONB;
  old_row JSONB;
BEGIN
  locked_property_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.property_id ELSE NEW.property_id END;
  IF TG_OP = 'UPDATE' THEN
    new_row := to_jsonb(NEW);
    old_row := to_jsonb(OLD);
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'recurring_pricing_sources'
    AND (
      new_row->>'id' IS DISTINCT FROM old_row->>'id'
      OR new_row->>'property_id' IS DISTINCT FROM old_row->>'property_id'
      OR new_row->>'source_kind' IS DISTINCT FROM old_row->>'source_kind'
      OR new_row->>'currency' IS DISTINCT FROM old_row->>'currency'
      OR new_row->>'source_pricing_currency_revision' IS DISTINCT FROM
        old_row->>'source_pricing_currency_revision'
    )
  THEN
    RAISE EXCEPTION 'recurring pricing source identity cannot change'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_recurring_pricing_source_identity_immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'recurring_pricing_source_room_values'
    AND (
      new_row->>'source_id' IS DISTINCT FROM old_row->>'source_id'
      OR new_row->>'property_id' IS DISTINCT FROM old_row->>'property_id'
      OR new_row->>'source_kind' IS DISTINCT FROM old_row->>'source_kind'
      OR new_row->>'room_type_id' IS DISTINCT FROM old_row->>'room_type_id'
      OR new_row->>'currency' IS DISTINCT FROM old_row->>'currency'
      OR new_row->>'source_pricing_currency_revision' IS DISTINCT FROM
        old_row->>'source_pricing_currency_revision'
    )
  THEN
    RAISE EXCEPTION 'recurring pricing room-value identity cannot change'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_recurring_pricing_room_value_identity_immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'non_refundable_rate_plan_source_rooms'
    AND (
      new_row->>'source_id' IS DISTINCT FROM old_row->>'source_id'
      OR new_row->>'property_id' IS DISTINCT FROM old_row->>'property_id'
      OR new_row->>'source_kind' IS DISTINCT FROM old_row->>'source_kind'
      OR new_row->>'room_type_id' IS DISTINCT FROM old_row->>'room_type_id'
      OR new_row->>'currency' IS DISTINCT FROM old_row->>'currency'
      OR new_row->>'source_pricing_currency_revision' IS DISTINCT FROM
        old_row->>'source_pricing_currency_revision'
    )
  THEN
    RAISE EXCEPTION 'non-refundable pricing source identity cannot change'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_non_refundable_pricing_source_room_identity_immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('pms-pricing-currency:', locked_property_id::TEXT), 0)
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE pms.property_pricing_settings
  ADD COLUMN optional_pricing_aggregate_revision BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_pms_property_optional_pricing_aggregate_revision
    CHECK (optional_pricing_aggregate_revision BETWEEN 0 AND 2147483647);

CREATE TABLE pms.recurring_pricing_sources (
  id                                UUID        PRIMARY KEY,
  property_id                       UUID        NOT NULL
                                                REFERENCES hotel_catalog.properties(id)
                                                ON DELETE CASCADE,
  source_kind                       TEXT        NOT NULL,
  source_revision                   BIGINT      NOT NULL,
  configured_state                  TEXT        NOT NULL,
  validation_state                  TEXT        NOT NULL,
  validation_revision               BIGINT      NOT NULL,
  validated_at                      TIMESTAMPTZ NOT NULL,
  invalid_reasons                   JSONB       NOT NULL,
  lifecycle                         TEXT        GENERATED ALWAYS AS (
    CASE
      WHEN configured_state = 'disabled' THEN 'disabled'
      WHEN validation_state = 'invalid' THEN 'invalid'
      ELSE 'active'
    END
  ) STORED,
  materialization_revision          BIGINT      NOT NULL DEFAULT 0,
  currency                          CHAR(3)     NOT NULL,
  source_pricing_currency_revision  BIGINT      NOT NULL,
  season_name                       TEXT,
  season_start_month                SMALLINT,
  season_start_day                  SMALLINT,
  season_end_month                  SMALLINT,
  season_end_day                    SMALLINT,
  weekend_days                      TEXT[],
  discount_percent                  SMALLINT,
  cancellation_terms_type           TEXT,
  refund_policy                     TEXT,
  no_show_penalty                    TEXT,
  payment_timing                     TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_recurring_pricing_sources_identity
    UNIQUE (id, property_id, source_kind),
  CONSTRAINT uq_pms_recurring_pricing_sources_currency_evidence
    UNIQUE (
      id, property_id, source_kind, currency, source_pricing_currency_revision
    ),
  CONSTRAINT fk_pms_recurring_pricing_sources_currency_revision
    FOREIGN KEY (property_id, currency, source_pricing_currency_revision)
    REFERENCES pms.property_pricing_settings(
      property_id, currency, pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT chk_pms_recurring_pricing_sources_revisions
    CHECK (
      source_revision BETWEEN 1 AND 2147483647
      AND validation_revision BETWEEN 1 AND 2147483647
      AND materialization_revision BETWEEN 0 AND 2147483647
    ),
  CONSTRAINT chk_pms_recurring_pricing_sources_states
    CHECK (
      configured_state IN ('active', 'disabled')
      AND validation_state IN ('valid', 'invalid')
      AND pms.recurring_pricing_invalid_reasons_are_canonical(invalid_reasons)
      AND (
        (validation_state = 'valid' AND invalid_reasons = '[]'::jsonb)
        OR (validation_state = 'invalid' AND jsonb_array_length(invalid_reasons) > 0)
      )
    ),
  CONSTRAINT chk_pms_recurring_pricing_sources_typed_configuration
    CHECK (
      (
        source_kind = 'season'
        AND season_name IS NOT NULL
        AND season_start_month IS NOT NULL
        AND season_start_day IS NOT NULL
        AND season_end_month IS NOT NULL
        AND season_end_day IS NOT NULL
        AND season_name = btrim(season_name)
        AND char_length(season_name) BETWEEN 1 AND 100
        AND pms.recurring_pricing_month_day_is_valid(
          season_start_month, season_start_day
        )
        AND pms.recurring_pricing_month_day_is_valid(season_end_month, season_end_day)
        AND weekend_days IS NULL
        AND discount_percent IS NULL
        AND cancellation_terms_type IS NULL
        AND refund_policy IS NULL
        AND no_show_penalty IS NULL
        AND payment_timing IS NULL
      )
      OR (
        source_kind = 'weekend_surcharge'
        AND season_name IS NULL
        AND season_start_month IS NULL
        AND season_start_day IS NULL
        AND season_end_month IS NULL
        AND season_end_day IS NULL
        AND pms.recurring_pricing_weekdays_are_canonical(weekend_days)
        AND discount_percent IS NULL
        AND cancellation_terms_type IS NULL
        AND refund_policy IS NULL
        AND no_show_penalty IS NULL
        AND payment_timing IS NULL
      )
      OR (
        source_kind = 'additional_guest'
        AND season_name IS NULL
        AND season_start_month IS NULL
        AND season_start_day IS NULL
        AND season_end_month IS NULL
        AND season_end_day IS NULL
        AND weekend_days IS NULL
        AND discount_percent IS NULL
        AND cancellation_terms_type IS NULL
        AND refund_policy IS NULL
        AND no_show_penalty IS NULL
        AND payment_timing IS NULL
      )
      OR (
        source_kind = 'non_refundable'
        AND season_name IS NULL
        AND season_start_month IS NULL
        AND season_start_day IS NULL
        AND season_end_month IS NULL
        AND season_end_day IS NULL
        AND weekend_days IS NULL
        AND discount_percent IS NOT NULL
        AND cancellation_terms_type IS NOT NULL
        AND refund_policy IS NOT NULL
        AND no_show_penalty IS NOT NULL
        AND payment_timing IS NOT NULL
        AND discount_percent BETWEEN 1 AND 50
        AND cancellation_terms_type = 'non_refundable'
        AND refund_policy = 'no_refund'
        AND no_show_penalty = 'full_booking_amount'
        AND payment_timing = 'prepay_full'
      )
    )
);

CREATE UNIQUE INDEX uq_pms_recurring_pricing_sources_weekend
  ON pms.recurring_pricing_sources (property_id, source_kind)
  WHERE source_kind = 'weekend_surcharge';

CREATE UNIQUE INDEX uq_pms_recurring_pricing_sources_non_refundable
  ON pms.recurring_pricing_sources (property_id, source_kind)
  WHERE source_kind = 'non_refundable';

CREATE UNIQUE INDEX uq_pms_recurring_pricing_sources_season_name
  ON pms.recurring_pricing_sources (property_id, lower(season_name))
  WHERE source_kind = 'season';

CREATE INDEX idx_pms_recurring_pricing_sources_property_lifecycle
  ON pms.recurring_pricing_sources (property_id, lifecycle, source_kind, id);

CREATE TRIGGER trg_pms_recurring_pricing_sources_currency_lock
BEFORE INSERT OR UPDATE OR DELETE ON pms.recurring_pricing_sources
FOR EACH ROW
EXECUTE FUNCTION pms.lock_recurring_pricing_currency_scope();

ALTER TABLE pms.rate_plans
  ADD CONSTRAINT uq_pms_rate_plans_recurring_pricing_parent
    UNIQUE (id, property_id, room_type_id, pricing_contract_version);

CREATE TABLE pms.recurring_pricing_source_room_values (
  source_id                         UUID           NOT NULL,
  property_id                       UUID           NOT NULL,
  source_kind                       TEXT           NOT NULL,
  room_type_id                      UUID           NOT NULL,
  source_room_facts_revision        BIGINT         NOT NULL,
  flexible_rate_plan_id             UUID           NOT NULL,
  flexible_pricing_contract_version TEXT           NOT NULL,
  source_flexible_plan_revision     BIGINT         NOT NULL,
  currency                          CHAR(3)        NOT NULL,
  source_pricing_currency_revision  BIGINT         NOT NULL,
  seasonal_nightly_amount           NUMERIC(15, 2),
  weekend_surcharge_amount          NUMERIC(15, 2),
  maximum_adult_guests              SMALLINT,
  included_guest_count              SMALLINT,
  additional_guest_amount           NUMERIC(15, 2),
  PRIMARY KEY (source_id, room_type_id),
  CONSTRAINT fk_pms_recurring_pricing_room_values_source
    FOREIGN KEY (
      source_id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    REFERENCES pms.recurring_pricing_sources(
      id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_recurring_pricing_room_values_room_type
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_recurring_pricing_room_values_flexible_plan
    FOREIGN KEY (
      flexible_rate_plan_id, property_id, room_type_id,
      flexible_pricing_contract_version
    )
    REFERENCES pms.rate_plans(
      id, property_id, room_type_id, pricing_contract_version
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT chk_pms_recurring_pricing_room_values_revisions
    CHECK (
      source_room_facts_revision BETWEEN 1 AND 2147483647
      AND source_flexible_plan_revision BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT chk_pms_recurring_pricing_room_values_flexible_contract
    CHECK (flexible_pricing_contract_version = 'pms-pricing.v1'),
  CONSTRAINT chk_pms_recurring_pricing_room_values_shape
    CHECK (pms.recurring_pricing_room_value_shape_is_valid(
      source_kind,
      seasonal_nightly_amount,
      weekend_surcharge_amount,
      maximum_adult_guests,
      included_guest_count,
      additional_guest_amount
    ))
);

CREATE UNIQUE INDEX uq_pms_recurring_additional_guest_room
  ON pms.recurring_pricing_source_room_values (property_id, room_type_id, source_kind)
  WHERE source_kind = 'additional_guest';

CREATE UNIQUE INDEX uq_pms_recurring_additional_guest_source
  ON pms.recurring_pricing_source_room_values (source_id)
  WHERE source_kind = 'additional_guest';

CREATE INDEX idx_pms_recurring_pricing_room_values_room
  ON pms.recurring_pricing_source_room_values (property_id, room_type_id, source_kind);

CREATE TRIGGER trg_pms_recurring_pricing_room_values_currency_lock
BEFORE INSERT OR UPDATE OR DELETE ON pms.recurring_pricing_source_room_values
FOR EACH ROW
EXECUTE FUNCTION pms.lock_recurring_pricing_currency_scope();

CREATE TABLE pms.non_refundable_rate_plan_source_rooms (
  source_id                         UUID        NOT NULL,
  property_id                       UUID        NOT NULL,
  source_kind                       TEXT        NOT NULL,
  room_type_id                      UUID        NOT NULL,
  flexible_rate_plan_id             UUID        NOT NULL,
  flexible_pricing_contract_version TEXT        NOT NULL,
  source_flexible_plan_revision     BIGINT      NOT NULL,
  source_room_facts_revision        BIGINT      NOT NULL,
  currency                          CHAR(3)     NOT NULL,
  source_pricing_currency_revision  BIGINT      NOT NULL,
  PRIMARY KEY (source_id, room_type_id),
  CONSTRAINT uq_pms_non_refundable_rate_plan_source_rooms_room
    UNIQUE (property_id, room_type_id),
  CONSTRAINT fk_pms_non_refundable_rate_plan_source_rooms_root
    FOREIGN KEY (
      source_id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    REFERENCES pms.recurring_pricing_sources(
      id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_non_refundable_rate_plan_source_rooms_room_type
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_non_refundable_rate_plan_source_rooms_flexible_plan
    FOREIGN KEY (
      flexible_rate_plan_id, property_id, room_type_id,
      flexible_pricing_contract_version
    )
    REFERENCES pms.rate_plans(
      id, property_id, room_type_id, pricing_contract_version
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT chk_pms_non_refundable_rate_plan_source_rooms_revisions
    CHECK (
      source_flexible_plan_revision BETWEEN 1 AND 2147483647
      AND source_room_facts_revision BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT chk_pms_non_refundable_rate_plan_source_rooms_shape
    CHECK (
      source_kind = 'non_refundable'
      AND flexible_pricing_contract_version = 'pms-pricing.v1'
    )
);

CREATE INDEX idx_pms_non_refundable_rate_plan_source_rooms_flexible
  ON pms.non_refundable_rate_plan_source_rooms (
    property_id, flexible_rate_plan_id, source_flexible_plan_revision
  );

CREATE TRIGGER trg_pms_non_refundable_rate_plan_source_rooms_currency_lock
BEFORE INSERT OR UPDATE OR DELETE ON pms.non_refundable_rate_plan_source_rooms
FOR EACH ROW
EXECUTE FUNCTION pms.lock_recurring_pricing_currency_scope();

CREATE TABLE pms.recurring_pricing_materialization_receipts (
  id                 UUID        PRIMARY KEY,
  property_id        UUID        NOT NULL
                                  REFERENCES hotel_catalog.properties(id)
                                  ON DELETE RESTRICT,
  horizon_start      DATE        NOT NULL,
  horizon_end        DATE        NOT NULL,
  optional_pricing_aggregate_revision BIGINT NOT NULL,
  accepted_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_pms_recurring_pricing_materialization_receipt_horizon
    UNIQUE (
      id, property_id, horizon_start, horizon_end,
      optional_pricing_aggregate_revision
    ),
  CONSTRAINT chk_pms_recurring_pricing_materialization_receipt_horizon
    CHECK ((horizon_end - horizon_start) BETWEEN 0 AND 365),
  CONSTRAINT chk_pms_recurring_pricing_materialization_receipt_aggregate_revision
    CHECK (optional_pricing_aggregate_revision BETWEEN 0 AND 2147483647)
);

CREATE TABLE pms.recurring_pricing_materialization_source_receipts (
  receipt_id                       UUID        NOT NULL,
  property_id                      UUID        NOT NULL,
  horizon_start                    DATE        NOT NULL,
  horizon_end                      DATE        NOT NULL,
  optional_pricing_aggregate_revision BIGINT   NOT NULL,
  source_id                        UUID        NOT NULL,
  source_kind                      TEXT        NOT NULL,
  source_revision                  BIGINT      NOT NULL,
  configured_state                 TEXT        NOT NULL,
  validation_state                 TEXT        NOT NULL,
  validation_revision              BIGINT      NOT NULL,
  validated_at                     TIMESTAMPTZ NOT NULL,
  invalid_reasons                  JSONB       NOT NULL,
  source_lifecycle                 TEXT        NOT NULL,
  materialization_revision         BIGINT      NOT NULL,
  currency                         CHAR(3)     NOT NULL,
  source_pricing_currency_revision BIGINT      NOT NULL,
  result                            TEXT        NOT NULL,
  materialized_row_count            INTEGER     NOT NULL,
  materialized_rows_sha256          TEXT        NOT NULL,
  PRIMARY KEY (receipt_id, source_id),
  CONSTRAINT uq_pms_recurring_pricing_materialization_source_evidence
    UNIQUE (
      receipt_id, property_id, horizon_start, horizon_end, source_id, source_kind,
      optional_pricing_aggregate_revision, source_revision, source_lifecycle,
      materialization_revision, currency, source_pricing_currency_revision
    ),
  CONSTRAINT fk_pms_recurring_pricing_materialization_source_receipt
    FOREIGN KEY (
      receipt_id, property_id, horizon_start, horizon_end,
      optional_pricing_aggregate_revision
    )
    REFERENCES pms.recurring_pricing_materialization_receipts(
      id, property_id, horizon_start, horizon_end,
      optional_pricing_aggregate_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_recurring_pricing_materialization_source_root
    FOREIGN KEY (
      source_id, property_id, source_kind, currency,
      source_pricing_currency_revision
    )
    REFERENCES pms.recurring_pricing_sources(
      id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT chk_pms_recurring_pricing_materialization_source_revisions
    CHECK (
      source_revision BETWEEN 1 AND 2147483647
      AND validation_revision BETWEEN 1 AND 2147483647
      AND materialization_revision BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT chk_pms_recurring_pricing_materialization_source_state
    CHECK (
      configured_state IN ('active', 'disabled')
      AND validation_state IN ('valid', 'invalid')
      AND pms.recurring_pricing_invalid_reasons_are_canonical(invalid_reasons)
      AND (
        (validation_state = 'valid' AND invalid_reasons = '[]'::jsonb)
        OR (validation_state = 'invalid' AND jsonb_array_length(invalid_reasons) > 0)
      )
      AND source_lifecycle = CASE
        WHEN configured_state = 'disabled' THEN 'disabled'
        WHEN validation_state = 'invalid' THEN 'invalid'
        ELSE 'active'
      END
    ),
  CONSTRAINT chk_pms_recurring_pricing_materialization_source_result
    CHECK (
      materialized_row_count >= 0
      AND materialized_rows_sha256 ~ '^[0-9a-f]{64}$'
      AND (
        (source_lifecycle = 'active' AND result = 'materialized')
        OR (
          source_lifecycle = 'disabled'
          AND result = 'skipped_disabled'
          AND materialized_row_count = 0
        )
        OR (
          source_lifecycle = 'invalid'
          AND result = 'skipped_invalid'
          AND materialized_row_count = 0
        )
      )
    )
);

CREATE INDEX idx_pms_recurring_pricing_materialization_sources
  ON pms.recurring_pricing_materialization_source_receipts (
    property_id, source_id, materialization_revision DESC
  );

CREATE TABLE pms.recurring_pricing_materialized_rows (
  receipt_id                       UUID           NOT NULL,
  property_id                      UUID           NOT NULL,
  horizon_start                    DATE           NOT NULL,
  horizon_end                      DATE           NOT NULL,
  optional_pricing_aggregate_revision BIGINT      NOT NULL,
  source_id                        UUID           NOT NULL,
  source_kind                      TEXT           NOT NULL,
  source_revision                  BIGINT         NOT NULL,
  source_lifecycle                 TEXT           NOT NULL,
  materialization_revision         BIGINT         NOT NULL,
  currency                         CHAR(3)        NOT NULL,
  source_pricing_currency_revision BIGINT         NOT NULL,
  room_type_id                     UUID           NOT NULL,
  stay_date                        DATE           NOT NULL,
  seasonal_nightly_amount          NUMERIC(15, 2),
  weekend_surcharge_amount         NUMERIC(15, 2),
  maximum_adult_guests             SMALLINT,
  included_guest_count             SMALLINT,
  additional_guest_amount          NUMERIC(15, 2),
  PRIMARY KEY (property_id, source_id, room_type_id, stay_date),
  CONSTRAINT fk_pms_recurring_pricing_materialized_rows_receipt
    FOREIGN KEY (
      receipt_id, property_id, horizon_start, horizon_end, source_id, source_kind,
      optional_pricing_aggregate_revision, source_revision, source_lifecycle,
      materialization_revision, currency, source_pricing_currency_revision
    )
    REFERENCES pms.recurring_pricing_materialization_source_receipts(
      receipt_id, property_id, horizon_start, horizon_end, source_id, source_kind,
      optional_pricing_aggregate_revision, source_revision, source_lifecycle,
      materialization_revision, currency, source_pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_recurring_pricing_materialized_rows_source
    FOREIGN KEY (
      source_id, property_id, source_kind, currency,
      source_pricing_currency_revision
    )
    REFERENCES pms.recurring_pricing_sources(
      id, property_id, source_kind, currency, source_pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_recurring_pricing_materialized_rows_room_type
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT chk_pms_recurring_pricing_materialized_rows_active
    CHECK (source_lifecycle = 'active'),
  CONSTRAINT chk_pms_recurring_pricing_materialized_rows_horizon
    CHECK (stay_date BETWEEN horizon_start AND horizon_end),
  CONSTRAINT chk_pms_recurring_pricing_materialized_rows_shape
    CHECK (pms.recurring_pricing_room_value_shape_is_valid(
      source_kind,
      seasonal_nightly_amount,
      weekend_surcharge_amount,
      maximum_adult_guests,
      included_guest_count,
      additional_guest_amount
    ))
);

CREATE INDEX idx_pms_recurring_pricing_materialized_rows_stay_date
  ON pms.recurring_pricing_materialized_rows (
    property_id, room_type_id, stay_date, source_kind
  );

CREATE FUNCTION pms.reject_recurring_pricing_receipt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'recurring pricing materialization receipts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'chk_pms_recurring_pricing_materialization_receipt_immutable';
END;
$$;

CREATE TRIGGER trg_pms_recurring_pricing_materialization_receipts_immutable
BEFORE UPDATE OR DELETE ON pms.recurring_pricing_materialization_receipts
FOR EACH ROW
EXECUTE FUNCTION pms.reject_recurring_pricing_receipt_mutation();

CREATE TRIGGER trg_pms_recurring_pricing_materialization_source_receipts_immutable
BEFORE UPDATE OR DELETE ON pms.recurring_pricing_materialization_source_receipts
FOR EACH ROW
EXECUTE FUNCTION pms.reject_recurring_pricing_receipt_mutation();
