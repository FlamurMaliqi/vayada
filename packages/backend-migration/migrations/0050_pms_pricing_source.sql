-- Migration: 0050_pms_pricing_source
-- Owner: domain-pms
-- See: engineering/hotel-onboarding-information-inventory.md (ONB-15)
--
-- Establishes one authoritative PMS pricing currency per property and marks
-- independently managed canonical flexible rate plans. Existing room-type and
-- rate-plan prices remain intact as legacy cutover inputs; this migration does
-- not invent cancellation terms or silently select one of several legacy
-- flexible plans.

-- Prevent a mounted legacy writer from changing the evidence set between the
-- preflight/backfill snapshots and trigger installation. The migration runner
-- holds these locks until its transaction commits.
LOCK TABLE pms.room_types, pms.rate_plans IN SHARE ROW EXCLUSIVE MODE;

-- A property with contradictory legacy currencies cannot be assigned one
-- authoritative value safely. Preflight both historical storage locations
-- before creating or changing any schema object.
DO $$
DECLARE
  invalid_property_id UUID;
  invalid_currency TEXT;
BEGIN
  SELECT property_id, currency::TEXT
  INTO invalid_property_id, invalid_currency
  FROM (
    SELECT property_id, currency
    FROM pms.room_types
    WHERE currency IS NOT NULL
    UNION ALL
    SELECT property_id, currency
    FROM pms.rate_plans
  ) legacy_currency
  WHERE currency::TEXT !~ '^[A-Z]{3}$'
  ORDER BY property_id, currency::TEXT
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'property % has invalid legacy PMS pricing currency %',
      invalid_property_id, invalid_currency
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency';
  END IF;
END;
$$;

DO $$
DECLARE
  conflicting_property_id UUID;
BEGIN
  SELECT property_id
  INTO conflicting_property_id
  FROM (
    SELECT property_id, currency
    FROM pms.room_types
    WHERE currency IS NOT NULL
    UNION
    SELECT property_id, currency
    FROM pms.rate_plans
  ) legacy_currency
  GROUP BY property_id
  HAVING count(DISTINCT currency) > 1
  ORDER BY property_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'property % has conflicting legacy PMS pricing currencies',
      conflicting_property_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
  END IF;
END;
$$;

CREATE TABLE pms.property_pricing_settings (
  property_id                 UUID        PRIMARY KEY
                                          REFERENCES hotel_catalog.properties(id)
                                          ON DELETE CASCADE,
  currency                    CHAR(3)     NOT NULL,
  pricing_currency_revision   BIGINT      NOT NULL DEFAULT 1,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_property_pricing_settings_currency
    UNIQUE (property_id, currency),
  CONSTRAINT uq_pms_property_pricing_settings_currency_revision
    UNIQUE (property_id, currency, pricing_currency_revision),
  CONSTRAINT chk_pms_property_pricing_currency
    CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_pms_property_pricing_currency_revision
    CHECK (pricing_currency_revision BETWEEN 1 AND 2147483647)
);

-- Backfill only a value that every extant PMS price row already agrees on.
-- A property with no legacy price remains unconfigured instead of defaulting.
INSERT INTO pms.property_pricing_settings (property_id, currency)
SELECT property_id, min(currency)::CHAR(3)
FROM (
  SELECT property_id, currency
  FROM pms.room_types
  WHERE currency IS NOT NULL
  UNION ALL
  SELECT property_id, currency
  FROM pms.rate_plans
) legacy_currency
GROUP BY property_id;

-- Staged enforcement for mounted pre-ONB-15 writers. They may still create a
-- legacy price before the dedicated pricing command is mounted, but they can
-- neither create nor change the authoritative settings row. Once a reviewed
-- pricing command configures that row, every legacy writer participates in the
-- same property lock and must agree with it. The nullable composite canonical
-- plan FK below remains the database backstop for the ONB-15 source itself.
CREATE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_currency CHAR(3);
  conflicting_legacy_currency CHAR(3);
BEGIN
  IF NEW.currency IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('pms-pricing-currency:', NEW.property_id::TEXT), 0)
  );

  SELECT currency
  INTO authoritative_currency
  FROM pms.property_pricing_settings
  WHERE property_id = NEW.property_id;

  IF FOUND THEN
    IF authoritative_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION
        'property % PMS pricing currency is %, not %',
        NEW.property_id, authoritative_currency, NEW.currency
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
    END IF;
    RETURN NEW;
  END IF;

  SELECT currency
  INTO conflicting_legacy_currency
  FROM (
    SELECT currency
    FROM pms.room_types
    WHERE property_id = NEW.property_id AND currency IS NOT NULL
    UNION
    SELECT currency
    FROM pms.rate_plans
    WHERE property_id = NEW.property_id
  ) legacy_currency
  WHERE currency IS DISTINCT FROM NEW.currency
  ORDER BY currency
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'property % already has legacy PMS pricing currency %, not %',
      NEW.property_id, conflicting_legacy_currency, NEW.currency
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_room_types_legacy_pricing_currency
BEFORE INSERT OR UPDATE OF property_id, currency ON pms.room_types
FOR EACH ROW
EXECUTE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write();

CREATE TRIGGER trg_pms_rate_plans_legacy_pricing_currency
BEFORE INSERT OR UPDATE OF property_id, currency ON pms.rate_plans
FOR EACH ROW
EXECUTE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write();

CREATE FUNCTION pms.enforce_pricing_settings_legacy_currency_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  conflicting_currency CHAR(3);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    RAISE EXCEPTION 'PMS property pricing settings cannot move between properties'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_settings_property_immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(concat('pms-pricing-currency:', NEW.property_id::TEXT), 0)
  );

  SELECT currency
  INTO conflicting_currency
  FROM (
    SELECT currency
    FROM pms.room_types
    WHERE property_id = NEW.property_id AND currency IS NOT NULL
    UNION
    SELECT currency
    FROM pms.rate_plans
    WHERE property_id = NEW.property_id
  ) legacy_currency
  WHERE currency IS DISTINCT FROM NEW.currency
  ORDER BY currency
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'property % has legacy PMS pricing currency %, not %',
      NEW.property_id, conflicting_currency, NEW.currency
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_property_pricing_settings_legacy_currency
BEFORE INSERT OR UPDATE OF property_id, currency ON pms.property_pricing_settings
FOR EACH ROW
EXECUTE FUNCTION pms.enforce_pricing_settings_legacy_currency_consistency();

-- Legacy room-type amounts remain cutover evidence, not a second canonical
-- writer. The staged trigger permits an unconfigured property's existing
-- mounted first-room flow, but protects every configured property from drift.

ALTER TABLE pms.rate_plans
  ADD COLUMN pricing_contract_version TEXT,
  ADD COLUMN flexible_rate_plan_revision BIGINT,
  ADD COLUMN source_room_facts_revision BIGINT,
  ADD COLUMN source_pricing_currency_revision BIGINT,
  ADD CONSTRAINT fk_pms_rate_plans_pricing_currency_revision
    FOREIGN KEY (property_id, currency, source_pricing_currency_revision)
    REFERENCES pms.property_pricing_settings(
      property_id, currency, pricing_currency_revision
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  ADD CONSTRAINT chk_pms_rate_plans_pricing_metadata
    CHECK (
      (
        pricing_contract_version IS NULL
        AND flexible_rate_plan_revision IS NULL
        AND source_room_facts_revision IS NULL
        AND source_pricing_currency_revision IS NULL
      )
      OR
      (
        pricing_contract_version IS NOT NULL
        AND pricing_contract_version = 'pms-pricing.v1'
        AND flexible_rate_plan_revision IS NOT NULL
        AND flexible_rate_plan_revision BETWEEN 1 AND 2147483647
        AND source_room_facts_revision IS NOT NULL
        AND source_room_facts_revision BETWEEN 1 AND 2147483647
        AND source_pricing_currency_revision IS NOT NULL
        AND source_pricing_currency_revision BETWEEN 1 AND 2147483647
      )
    ),
  ADD CONSTRAINT chk_pms_rate_plans_canonical_flexible_shape
    CHECK (
      pricing_contract_version IS NULL
      OR
      (
        pricing_contract_version = 'pms-pricing.v1'
        AND rate_type = 'flexible'
        AND base_rate_amount > 0
        AND active
        AND meal_plan IS NULL
        AND payment_policy = '{}'::jsonb
        AND deposit_policy = '{}'::jsonb
        AND jsonb_typeof(cancellation_policy_snapshot) = 'object'
        AND cancellation_policy_snapshot = jsonb_build_object(
          'type', 'free_until_days_before_arrival',
          'freeCancellationDeadlineDays',
            cancellation_policy_snapshot->'freeCancellationDeadlineDays',
          'afterDeadlinePenalty', 'full_booking_amount',
          'noShowPenalty', 'full_booking_amount'
        )
        AND jsonb_typeof(
          cancellation_policy_snapshot->'freeCancellationDeadlineDays'
        ) = 'number'
        AND cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
              ~ '^(0|[1-9][0-9]{0,2})$'
        AND CASE
          WHEN cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
                 ~ '^(0|[1-9][0-9]{0,2})$'
          THEN (
            cancellation_policy_snapshot->>'freeCancellationDeadlineDays'
          )::INTEGER BETWEEN 0 AND 365
          ELSE FALSE
        END
      )
    );

-- The partial index distinguishes the one ONB-15 source plan from untouched
-- legacy flexible/non-refundable/package/manual rows. A first explicit upsert
-- may adopt one unambiguous legacy flexible row by setting this version.
CREATE UNIQUE INDEX uq_pms_rate_plans_room_canonical_flexible
  ON pms.rate_plans (property_id, room_type_id)
  WHERE pricing_contract_version = 'pms-pricing.v1';

CREATE INDEX idx_pms_rate_plans_property_pricing_source
  ON pms.rate_plans (property_id, room_type_id, flexible_rate_plan_revision)
  WHERE pricing_contract_version = 'pms-pricing.v1';
