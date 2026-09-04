-- Migration: 0137_pms_historical_pricing_currencies
-- Owner: domain-pms
-- See: VAY-1361
--
-- A legacy property can retain historical room types and rate plans whose
-- currencies differ from its current operational pricing currency. Preserve
-- that evidence exactly, but never allow an inactive historical row to become
-- operational without passing the single-currency guard.

LOCK TABLE pms.room_types, pms.rate_plans, pms.property_pricing_settings
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_currency CHAR(3);
  conflicting_legacy_currency CHAR(3);
BEGIN
  IF NEW.currency IS NULL OR NOT NEW.active THEN
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
    WHERE property_id = NEW.property_id AND active AND currency IS NOT NULL
    UNION
    SELECT currency
    FROM pms.rate_plans
    WHERE property_id = NEW.property_id AND active
  ) legacy_currency
  WHERE currency IS DISTINCT FROM NEW.currency
  ORDER BY currency
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'property % already has active legacy PMS pricing currency %, not %',
      NEW.property_id, conflicting_legacy_currency, NEW.currency
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pms.enforce_pricing_settings_legacy_currency_consistency()
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
    WHERE property_id = NEW.property_id AND active AND currency IS NOT NULL
    UNION
    SELECT currency
    FROM pms.rate_plans
    WHERE property_id = NEW.property_id AND active
  ) legacy_currency
  WHERE currency IS DISTINCT FROM NEW.currency
  ORDER BY currency
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'property % has active legacy PMS pricing currency %, not %',
      NEW.property_id, conflicting_currency, NEW.currency
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_property_pricing_currency_consistency';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER trg_pms_room_types_legacy_pricing_currency ON pms.room_types;
CREATE TRIGGER trg_pms_room_types_legacy_pricing_currency
BEFORE INSERT OR UPDATE OF property_id, currency, active ON pms.room_types
FOR EACH ROW
EXECUTE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write();

DROP TRIGGER trg_pms_rate_plans_legacy_pricing_currency ON pms.rate_plans;
CREATE TRIGGER trg_pms_rate_plans_legacy_pricing_currency
BEFORE INSERT OR UPDATE OF property_id, currency, active ON pms.rate_plans
FOR EACH ROW
EXECUTE FUNCTION pms.enforce_configured_pricing_currency_on_legacy_write();
