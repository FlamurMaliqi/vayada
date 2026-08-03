-- Migration: 0055_finance_payment_readiness
-- Owner: domain-finance, domain-identity
-- See: engineering/hotel-onboarding-information-inventory.md (ONB-24)

ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS organization_resource_links_relationship_check;
ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS chk_organization_resource_links_relationship;
ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT chk_organization_resource_links_relationship
    CHECK (relationship IN (
      'owner', 'operator', 'front_desk', 'finance_manager', 'promotes', 'billing_account'
    ));

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('pms.finance.manage', 'pms', 'Manage property payment-method readiness')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants
  (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner',    'pms.finance.manage'),
  ('hotel_group', 'owner',          'pms.finance.manage'),
  ('hotel_group', 'finance_manager','pms.finance.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;

ALTER TABLE finance.payment_settings
  ADD COLUMN payment_readiness_contract_version TEXT,
  ADD COLUMN payment_methods_revision BIGINT,
  ADD COLUMN source_pricing_currency_revision BIGINT,
  ADD CONSTRAINT chk_finance_payment_settings_readiness_binding
    CHECK (
      (
        payment_readiness_contract_version IS NULL
        AND payment_methods_revision IS NULL
        AND source_pricing_currency_revision IS NULL
      )
      OR (
        payment_readiness_contract_version IS NOT NULL
        AND payment_methods_revision IS NOT NULL
        AND source_pricing_currency_revision IS NOT NULL
        AND payment_readiness_contract_version = 'finance-payment-readiness.v1'
        AND payment_methods_revision BETWEEN 1 AND 2147483647
        AND source_pricing_currency_revision BETWEEN 1 AND 2147483647
      )
    ),
  ADD CONSTRAINT fk_finance_payment_settings_pricing_currency_revision
    FOREIGN KEY (property_id, default_currency, source_pricing_currency_revision)
    REFERENCES pms.property_pricing_settings (
      property_id, currency, pricing_currency_revision
    );
