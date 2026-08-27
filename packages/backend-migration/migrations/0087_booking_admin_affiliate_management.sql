-- Migration: 0087_booking_admin_affiliate_management
-- Owners: domain-marketplace, domain-finance, domain-identity
-- See: engineering/booking-admin-affiliate-management-contract.md

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('marketplace.affiliate.manage', 'marketplace', 'Manage property affiliate applications and lifecycle')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'marketplace.affiliate.manage'),
  ('hotel_group', 'owner',       'marketplace.affiliate.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;

CREATE TABLE marketplace.property_affiliates (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  affiliate_id              TEXT        NOT NULL,
  affiliate_organization_id UUID        REFERENCES identity.organizations(id),
  referral_code             TEXT        NOT NULL,
  display_name              TEXT,
  contact_email             TEXT,
  contact_email_hash        TEXT,
  social_media              TEXT,
  affiliate_type            TEXT        NOT NULL DEFAULT 'guest'
                                         CHECK (affiliate_type IN ('guest', 'creator')),
  lifecycle_status          TEXT        NOT NULL DEFAULT 'pending'
                                         CHECK (lifecycle_status IN (
                                           'pending', 'approved', 'rejected', 'suspended'
                                         )),
  application_source        TEXT        NOT NULL
                                         CHECK (application_source IN (
                                           'public_registration', 'collaboration', 'migration'
                                         )),
  applied_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_property_affiliates_identity
    UNIQUE (property_id, affiliate_id),
  CONSTRAINT uq_marketplace_property_affiliates_referral
    UNIQUE (property_id, referral_code),
  CONSTRAINT chk_marketplace_property_affiliates_display_name
    CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  CONSTRAINT chk_marketplace_property_affiliates_contact_email
    CHECK (contact_email IS NULL OR contact_email = lower(btrim(contact_email)))
);

CREATE UNIQUE INDEX uq_marketplace_property_affiliates_email_hash
  ON marketplace.property_affiliates (property_id, contact_email_hash)
  WHERE contact_email_hash IS NOT NULL;

CREATE INDEX idx_marketplace_property_affiliates_admin_list
  ON marketplace.property_affiliates (property_id, lifecycle_status, applied_at DESC, affiliate_id);

CREATE TABLE marketplace.affiliate_lifecycle_changes (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_affiliate_id    UUID        NOT NULL REFERENCES marketplace.property_affiliates(id),
  property_id              UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  affiliate_id             TEXT        NOT NULL,
  command_id               TEXT        NOT NULL,
  idempotency_key_hash     TEXT        NOT NULL,
  request_fingerprint_hash TEXT        NOT NULL,
  actor_user_id            UUID        NOT NULL REFERENCES identity.users(id),
  previous_status          TEXT        NOT NULL,
  new_status               TEXT        NOT NULL,
  outcome                  TEXT        NOT NULL CHECK (outcome IN ('applied', 'unchanged')),
  result_snapshot          JSONB       NOT NULL,
  audit_event_id           UUID        NOT NULL REFERENCES platform.product_audit_events(id),
  occurred_at              TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_marketplace_affiliate_lifecycle_idempotency
    UNIQUE (property_id, idempotency_key_hash),
  CONSTRAINT chk_marketplace_affiliate_lifecycle_previous_status
    CHECK (previous_status IN ('pending', 'approved', 'rejected', 'suspended')),
  CONSTRAINT chk_marketplace_affiliate_lifecycle_new_status
    CHECK (new_status IN ('pending', 'approved', 'rejected', 'suspended'))
);

CREATE INDEX idx_marketplace_affiliate_lifecycle_history
  ON marketplace.affiliate_lifecycle_changes (property_id, affiliate_id, occurred_at DESC);

CREATE TRIGGER trg_marketplace_affiliate_lifecycle_changes_append_only
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_lifecycle_changes
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

ALTER TABLE finance.commission_rules
  ADD COLUMN affiliate_id TEXT;

ALTER TABLE finance.commission_rules
  DROP CONSTRAINT chk_finance_commission_rules_scope;

ALTER TABLE finance.commission_rules
  ADD CONSTRAINT chk_finance_commission_rules_scope CHECK (
    (rule_scope = 'property' AND property_id IS NOT NULL AND affiliate_id IS NULL)
    OR (
      rule_scope = 'affiliate'
      AND (
        (organization_id IS NOT NULL AND affiliate_id IS NULL)
        OR (property_id IS NOT NULL AND affiliate_id IS NOT NULL)
      )
    )
    OR (rule_scope IN ('organization', 'marketplace') AND organization_id IS NOT NULL)
    OR (rule_scope = 'platform' AND property_id IS NULL AND organization_id IS NULL)
    OR rule_scope = 'migration'
  );

CREATE UNIQUE INDEX uq_finance_active_property_affiliate_default
  ON finance.commission_rules (property_id)
  WHERE product = 'affiliate' AND rule_scope = 'property' AND status = 'active';

CREATE UNIQUE INDEX uq_finance_active_property_affiliate_override
  ON finance.commission_rules (property_id, affiliate_id)
  WHERE product = 'affiliate' AND rule_scope = 'affiliate' AND status = 'active';

INSERT INTO marketplace.property_affiliates (
  property_id,
  affiliate_id,
  referral_code,
  contact_email_hash,
  affiliate_type,
  lifecycle_status,
  application_source,
  applied_at,
  updated_at
)
SELECT
  property_slug.property_id,
  event.resource_id,
  event.payload ->> 'referralCode',
  event.payload ->> 'emailHash',
  CASE WHEN event.payload ->> 'userType' = 'creator' THEN 'creator' ELSE 'guest' END,
  'pending',
  'public_registration',
  event.occurred_at,
  event.occurred_at
FROM platform.domain_events event
JOIN hotel_catalog.property_slugs property_slug
  ON property_slug.slug = lower(event.payload ->> 'hotelSlug')
 AND property_slug.purpose = 'canonical'
 AND property_slug.status = 'active'
WHERE event.source_system = 'marketplace'
  AND event.event_type = 'marketplace.affiliate.public_registered'
  AND event.resource_product = 'marketplace'
  AND event.resource_type = 'affiliate'
  AND event.payload ->> 'referralCode' IS NOT NULL
ON CONFLICT (property_id, affiliate_id) DO NOTHING;
