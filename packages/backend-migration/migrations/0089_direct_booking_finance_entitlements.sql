-- Migration: 0089_direct_booking_finance_entitlements
-- Owner: Finance upstream entitlement state -> Identity authorization read model
-- See: VAY-1296, engineering/target-schema-ownership-map.md

CREATE OR REPLACE FUNCTION finance.sync_direct_booking_finance_entitlement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  entitlement_id UUID;
  entitlement_status TEXT;
  entitlement_starts_at TIMESTAMPTZ;
  entitlement_expires_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.product = 'booking'
       AND OLD.entitlement_key = 'direct-booking-finance'
       AND OLD.property_id IS NOT NULL THEN
      UPDATE identity.product_entitlements
      SET status = 'expired',
          expires_at = CASE WHEN starts_at IS NOT NULL AND starts_at > now() THEN starts_at ELSE now() END,
          metadata = metadata || jsonb_build_object('revokedBy', 'finance.billing_entitlements'),
          updated_at = now()
      WHERE organization_id = OLD.organization_id
        AND product = 'booking'
        AND entitlement_key = 'direct-booking-finance'
        AND resource_product = 'pms'
        AND resource_type = 'pms_property'
        AND resource_id = OLD.property_id::text;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.product = 'booking'
     AND OLD.entitlement_key = 'direct-booking-finance'
     AND OLD.property_id IS NOT NULL
     AND (NEW.organization_id, NEW.property_id, NEW.product, NEW.entitlement_key)
         IS DISTINCT FROM
         (OLD.organization_id, OLD.property_id, OLD.product, OLD.entitlement_key) THEN
    RAISE EXCEPTION 'direct-booking Finance entitlement scope is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_finance_direct_booking_entitlement_scope_immutable';
  END IF;

  IF NEW.product <> 'booking'
     OR NEW.entitlement_key <> 'direct-booking-finance'
     OR NEW.property_id IS NULL THEN
    RETURN NEW;
  END IF;

  entitlement_status := CASE
    WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN 'expired'
    WHEN NEW.billing_status IN ('trialing', 'active') THEN 'active'
    WHEN NEW.billing_status IN ('past_due', 'suspended') THEN 'suspended'
    ELSE 'expired'
  END;
  entitlement_starts_at := COALESCE(NEW.starts_at, NEW.created_at, now());
  entitlement_expires_at := CASE
    WHEN entitlement_status = 'expired' THEN
      GREATEST(entitlement_starts_at, COALESCE(NEW.expires_at, NEW.updated_at, now()))
    ELSE NEW.expires_at
  END;

  INSERT INTO identity.product_entitlements (
    organization_id, product, entitlement_key, status,
    resource_product, resource_type, resource_id,
    starts_at, expires_at, metadata, created_at, updated_at
  ) VALUES (
    NEW.organization_id, 'booking', 'direct-booking-finance', entitlement_status,
    'pms', 'pms_property', NEW.property_id::text,
    entitlement_starts_at, entitlement_expires_at,
    jsonb_build_object(
      'source', 'finance.billing_entitlements',
      'billingEntitlementId', NEW.id,
      'planKey', NEW.plan_key
    ), NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (
    organization_id, product, entitlement_key,
    COALESCE(resource_product, ''), COALESCE(resource_type, ''), COALESCE(resource_id, '')
  ) DO UPDATE SET
    status = EXCLUDED.status,
    starts_at = EXCLUDED.starts_at,
    expires_at = EXCLUDED.expires_at,
    metadata = identity.product_entitlements.metadata || EXCLUDED.metadata,
    updated_at = EXCLUDED.updated_at
  RETURNING id INTO entitlement_id;

  IF NEW.identity_entitlement_id IS DISTINCT FROM entitlement_id THEN
    UPDATE finance.billing_entitlements
    SET identity_entitlement_id = entitlement_id
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_direct_booking_entitlement_sync
  ON finance.billing_entitlements;
DROP TRIGGER IF EXISTS trg_finance_direct_booking_entitlement_insert
  ON finance.billing_entitlements;
DROP TRIGGER IF EXISTS trg_finance_direct_booking_entitlement_update
  ON finance.billing_entitlements;
DROP TRIGGER IF EXISTS trg_finance_direct_booking_entitlement_delete
  ON finance.billing_entitlements;
CREATE TRIGGER trg_finance_direct_booking_entitlement_insert
AFTER INSERT ON finance.billing_entitlements
FOR EACH ROW
EXECUTE FUNCTION finance.sync_direct_booking_finance_entitlement();
CREATE TRIGGER trg_finance_direct_booking_entitlement_update
AFTER UPDATE OF
  organization_id, property_id, product, entitlement_key,
  billing_status, plan_key, starts_at, expires_at, updated_at
ON finance.billing_entitlements
FOR EACH ROW
EXECUTE FUNCTION finance.sync_direct_booking_finance_entitlement();
CREATE TRIGGER trg_finance_direct_booking_entitlement_delete
AFTER DELETE ON finance.billing_entitlements
FOR EACH ROW
EXECUTE FUNCTION finance.sync_direct_booking_finance_entitlement();

-- Project existing Finance facts into the authorization read model and persist
-- the exact link without changing their billing timestamps or status.
UPDATE finance.billing_entitlements
SET billing_status = billing_status
WHERE product = 'booking'
  AND entitlement_key = 'direct-booking-finance'
  AND property_id IS NOT NULL;
