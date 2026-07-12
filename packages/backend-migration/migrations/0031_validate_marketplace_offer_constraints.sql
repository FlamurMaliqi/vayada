-- Migration: 0031_validate_marketplace_offer_constraints
-- Owner: domain-marketplace
-- See: packages/backend-migration/migrations/0030_marketplace_offers.sql
--
-- Validates constraints after the NOT VALID additions in migration 0030 have
-- committed, avoiding a table-scan validation while holding the add lock.

ALTER TABLE identity.organization_resource_links
  VALIDATE CONSTRAINT chk_organization_resource_links_resource_type;

ALTER TABLE identity.product_entitlements
  VALIDATE CONSTRAINT chk_product_entitlements_resource_type;

ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT collaborations_compensation_type_check;

ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT chk_marketplace_collaborations_compensation_terms;

ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT chk_marketplace_collaborations_affiliate_link;
