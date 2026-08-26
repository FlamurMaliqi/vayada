-- Migration: 0086_finance_affiliate_payout_payment_evidence
-- Owner: domain-finance
-- See: engineering/finance-route-contracts.md

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('platform.finance.manage', 'platform', 'Record platform-admin Finance outcomes')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('platform', 'platform_admin', 'platform.finance.read'),
  ('platform', 'platform_admin', 'platform.finance.manage'),
  ('platform', 'finance_manager', 'platform.finance.read'),
  ('platform', 'finance_manager', 'platform.finance.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;

INSERT INTO identity.product_entitlements (
  organization_id, product, entitlement_key, status,
  resource_product, resource_type, resource_id, metadata
)
SELECT id, 'platform', 'finance-admin', 'active',
       'platform', 'platform', 'vayada',
       '{"source":"0086_finance_affiliate_payout_payment_evidence"}'::jsonb
FROM identity.organizations
WHERE kind = 'platform' AND status = 'active'
ON CONFLICT DO NOTHING;

ALTER TABLE finance.payouts
  ADD CONSTRAINT uq_finance_payouts_id_organization UNIQUE (id, organization_id);

CREATE TABLE finance.affiliate_payout_payment_evidence (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               UUID          NOT NULL REFERENCES identity.organizations(id),
  affiliate_id                  TEXT          NOT NULL,
  recorded_by_organization_id   UUID          NOT NULL REFERENCES identity.organizations(id),
  recorded_by_user_id           UUID          NOT NULL REFERENCES identity.users(id),
  idempotency_key_id            UUID          NOT NULL REFERENCES platform.idempotency_keys(id),
  command_id                    TEXT          NOT NULL,
  request_fingerprint_hash      TEXT          NOT NULL,
  payment_method                TEXT          NOT NULL CHECK (payment_method IN ('manual', 'bank_transfer')),
  external_reference            TEXT          NOT NULL CHECK (external_reference = btrim(external_reference) AND external_reference <> ''),
  evidence_reference            TEXT          NOT NULL CHECK (evidence_reference = btrim(evidence_reference) AND evidence_reference <> ''),
  note                          TEXT,
  amount                        NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  currency                      CHAR(3)       NOT NULL CHECK (currency = upper(currency)),
  payout_count                  INTEGER       NOT NULL CHECK (payout_count > 0),
  paid_at                       TIMESTAMPTZ   NOT NULL,
  recorded_at                   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_affiliate_payout_evidence_id_organization
    UNIQUE (id, organization_id),
  CONSTRAINT uq_finance_affiliate_payout_evidence_idempotency
    UNIQUE (idempotency_key_id)
);

CREATE UNIQUE INDEX uq_finance_affiliate_payout_evidence_external_reference
  ON finance.affiliate_payout_payment_evidence (
    organization_id, lower(external_reference)
  );

CREATE INDEX idx_finance_affiliate_payout_evidence_history
  ON finance.affiliate_payout_payment_evidence (
    affiliate_id, currency, paid_at DESC
  );

CREATE TABLE finance.affiliate_payout_payment_evidence_items (
  evidence_id       UUID          NOT NULL,
  organization_id   UUID          NOT NULL,
  payout_id          UUID          NOT NULL,
  amount             NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  currency           CHAR(3)       NOT NULL CHECK (currency = upper(currency)),
  PRIMARY KEY (evidence_id, payout_id),
  CONSTRAINT uq_finance_affiliate_payout_evidence_items_payout UNIQUE (payout_id),
  CONSTRAINT fk_finance_affiliate_payout_evidence_items_evidence
    FOREIGN KEY (evidence_id, organization_id)
    REFERENCES finance.affiliate_payout_payment_evidence(id, organization_id),
  CONSTRAINT fk_finance_affiliate_payout_evidence_items_payout
    FOREIGN KEY (payout_id, organization_id)
    REFERENCES finance.payouts(id, organization_id)
);

CREATE FUNCTION finance.validate_affiliate_payout_payment_evidence_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM finance.affiliate_payout_payment_evidence evidence
    JOIN finance.payouts payout
      ON payout.id = NEW.payout_id
     AND payout.organization_id = evidence.organization_id
    LEFT JOIN finance.payout_settings settings
      ON settings.id = payout.payout_setting_id
     AND settings.organization_id = payout.organization_id
    WHERE evidence.id = NEW.evidence_id
      AND evidence.organization_id = NEW.organization_id
      AND COALESCE(
        payout.payout_metadata ->> 'affiliateId',
        payout.payout_metadata ->> 'affiliate_id',
        settings.payout_preferences ->> 'affiliateId',
        settings.payout_preferences ->> 'affiliate_id',
        payout.payout_metadata ->> 'resourceId'
      ) = evidence.affiliate_id
      AND payout.amount = NEW.amount
      AND payout.currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'affiliate payout evidence item does not match its payout snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_affiliate_payout_evidence_items_validate
  BEFORE INSERT ON finance.affiliate_payout_payment_evidence_items
  FOR EACH ROW EXECUTE FUNCTION finance.validate_affiliate_payout_payment_evidence_item();

CREATE FUNCTION finance.validate_affiliate_payout_payment_evidence_aggregate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  evidence_uuid UUID;
BEGIN
  evidence_uuid := COALESCE(
    to_jsonb(NEW) ->> 'id',
    to_jsonb(NEW) ->> 'evidence_id'
  )::uuid;
  IF NOT EXISTS (
    SELECT 1
    FROM finance.affiliate_payout_payment_evidence evidence
    JOIN finance.affiliate_payout_payment_evidence_items item
      ON item.evidence_id = evidence.id
     AND item.organization_id = evidence.organization_id
    WHERE evidence.id = evidence_uuid
    GROUP BY evidence.id
    HAVING COUNT(*) = evidence.payout_count
       AND SUM(item.amount) = evidence.amount
       AND BOOL_AND(item.currency = evidence.currency)
  ) THEN
    RAISE EXCEPTION 'affiliate payout evidence aggregate does not match its item snapshots'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_finance_affiliate_payout_evidence_aggregate
  AFTER INSERT ON finance.affiliate_payout_payment_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.validate_affiliate_payout_payment_evidence_aggregate();

CREATE CONSTRAINT TRIGGER trg_finance_affiliate_payout_evidence_items_aggregate
  AFTER INSERT ON finance.affiliate_payout_payment_evidence_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.validate_affiliate_payout_payment_evidence_aggregate();

CREATE TRIGGER trg_finance_affiliate_payout_evidence_append_only
  BEFORE UPDATE OR DELETE ON finance.affiliate_payout_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_finance_affiliate_payout_evidence_items_append_only
  BEFORE UPDATE OR DELETE ON finance.affiliate_payout_payment_evidence_items
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_finance_affiliate_payout_evidence_truncate
  BEFORE TRUNCATE ON finance.affiliate_payout_payment_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_finance_affiliate_payout_evidence_items_truncate
  BEFORE TRUNCATE ON finance.affiliate_payout_payment_evidence_items
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
