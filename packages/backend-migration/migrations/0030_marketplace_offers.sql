-- Migration: 0030_marketplace_offers
-- Owner: domain-marketplace
-- See: engineering/marketplace-offer-model.md
--
-- Reframes the Marketplace parent entity as the hotel's collaboration offer.
-- Existing target rows retain their UUIDs, ownership, status, and source IDs.

-- Resource grants and entitlements follow the canonical entity name.
ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS chk_organization_resource_links_resource_type;
ALTER TABLE identity.product_entitlements
  DROP CONSTRAINT IF EXISTS chk_product_entitlements_resource_type;

UPDATE identity.organization_resource_links
SET resource_type = 'marketplace_offer'
WHERE resource_type = 'hotel_listing';

-- Hotel groups retain the migrated owner link and receive the operator link
-- used by collaboration workflows.
INSERT INTO identity.organization_resource_links (
  organization_id,
  product,
  resource_type,
  resource_id,
  relationship,
  status
)
SELECT
  link.organization_id,
  link.product,
  link.resource_type,
  link.resource_id,
  'operator',
  link.status
FROM identity.organization_resource_links link
WHERE link.product = 'marketplace'
  AND link.resource_type = 'marketplace_offer'
  AND link.relationship = 'owner'
ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
DO UPDATE SET status = EXCLUDED.status, updated_at = now();

UPDATE identity.product_entitlements
SET resource_type = 'marketplace_offer',
    entitlement_key = CASE
      WHEN entitlement_key = 'marketplace-hotel-listing' THEN 'marketplace-offer'
      ELSE entitlement_key
    END
WHERE resource_type = 'hotel_listing'
   OR entitlement_key = 'marketplace-hotel-listing';

ALTER TABLE identity.organization_resource_links
  ADD CONSTRAINT chk_organization_resource_links_resource_type
  CHECK (resource_type IN (
    'platform',
    'property',
    'booking_hotel',
    'pms_hotel',
    'pms_property',
    'hotel_profile',
    'marketplace_offer',
    'creator_profile',
    'affiliate',
    'payout_account'
  )) NOT VALID;
ALTER TABLE identity.organization_resource_links
  VALIDATE CONSTRAINT chk_organization_resource_links_resource_type;

ALTER TABLE identity.product_entitlements
  ADD CONSTRAINT chk_product_entitlements_resource_type
  CHECK (
    resource_type IS NULL
    OR resource_type IN (
      'platform',
      'property',
      'booking_hotel',
      'pms_hotel',
      'pms_property',
      'hotel_profile',
      'marketplace_offer',
      'creator_profile',
      'affiliate',
      'payout_account'
    )
  ) NOT VALID;
ALTER TABLE identity.product_entitlements
  VALIDATE CONSTRAINT chk_product_entitlements_resource_type;

-- The offer is the hotel-authored collaboration brief.
ALTER TABLE marketplace.marketplace_hotel_listings
  RENAME TO marketplace_offers;
ALTER TABLE marketplace.marketplace_offers
  RENAME COLUMN source_listing_id TO source_offer_id;
ALTER TABLE marketplace.marketplace_offers
  RENAME COLUMN listing_summary TO offer_summary;
ALTER TABLE marketplace.marketplace_offers
  RENAME COLUMN listing_status TO offer_status;
ALTER TABLE marketplace.marketplace_offers
  RENAME COLUMN listing_metadata TO offer_metadata;

ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT marketplace_hotel_listings_pkey TO marketplace_offers_pkey;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT marketplace_hotel_listings_source_system_check
  TO marketplace_offers_source_system_check;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT marketplace_hotel_listings_accommodation_type_check
  TO marketplace_offers_accommodation_type_check;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT uq_marketplace_hotel_listings_id_property
  TO uq_marketplace_offers_id_property;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT uq_marketplace_hotel_listings_id_property_org
  TO uq_marketplace_offers_id_property_org;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT uq_marketplace_hotel_listings_source
  TO uq_marketplace_offers_source;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT chk_marketplace_hotel_listings_status
  TO chk_marketplace_offers_status;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT chk_marketplace_hotel_listings_source_id
  TO chk_marketplace_offers_source_id;
ALTER TABLE marketplace.marketplace_offers
  RENAME CONSTRAINT fk_marketplace_hotel_listings_profile_org
  TO fk_marketplace_offers_profile_org;
ALTER INDEX marketplace.idx_marketplace_hotel_listings_property_status
  RENAME TO idx_marketplace_offers_property_status;

COMMENT ON COLUMN marketplace.marketplace_offers.accommodation_type IS
  'Legacy migration input only; canonical property classification is owned by hotel_catalog.';
COMMENT ON COLUMN marketplace.marketplace_offers.raw_location_text IS
  'Legacy migration evidence only; canonical property location is owned by hotel_catalog.';
COMMENT ON COLUMN marketplace.marketplace_offers.image_urls IS
  'Legacy compatibility media only; canonical hotel media is owned by hotel_catalog.';

-- These rows define what compensation the hotel makes available. They are not
-- creator-specific proposals.
ALTER TABLE marketplace.listing_collaboration_offerings
  RENAME TO offer_compensation_options;
ALTER TABLE marketplace.offer_compensation_options
  RENAME COLUMN listing_id TO offer_id;
ALTER TABLE marketplace.offer_compensation_options
  RENAME COLUMN source_offering_id TO source_compensation_option_id;
ALTER TABLE marketplace.offer_compensation_options
  RENAME COLUMN collaboration_type TO compensation_type;
ALTER TABLE marketplace.offer_compensation_options
  RENAME COLUMN offering_metadata TO compensation_metadata;

ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT listing_collaboration_offerings_pkey
  TO offer_compensation_options_pkey;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT listing_collaboration_offerings_source_system_check
  TO offer_compensation_options_source_system_check;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT listing_collaboration_offerings_collaboration_type_check
  TO offer_compensation_options_compensation_type_check;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT uq_marketplace_offerings_source
  TO uq_marketplace_compensation_options_source;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT chk_marketplace_offerings_source_id
  TO chk_marketplace_compensation_options_source_id;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT chk_marketplace_offerings_currency_upper
  TO chk_marketplace_compensation_options_currency_upper;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT chk_marketplace_offerings_type_terms
  TO chk_marketplace_compensation_options_terms;
ALTER TABLE marketplace.offer_compensation_options
  RENAME CONSTRAINT fk_marketplace_offerings_listing_org
  TO fk_marketplace_compensation_options_offer_org;
ALTER INDEX marketplace.idx_marketplace_offerings_listing_type
  RENAME TO idx_marketplace_compensation_options_offer_type;

-- Creator requirements belong to one offer.
ALTER TABLE marketplace.listing_creator_requirements
  RENAME TO offer_creator_requirements;
ALTER TABLE marketplace.offer_creator_requirements
  RENAME COLUMN listing_id TO offer_id;

ALTER TABLE marketplace.offer_creator_requirements
  RENAME CONSTRAINT listing_creator_requirements_pkey
  TO offer_creator_requirements_pkey;
ALTER TABLE marketplace.offer_creator_requirements
  RENAME CONSTRAINT listing_creator_requirements_source_system_check
  TO offer_creator_requirements_source_system_check;
ALTER TABLE marketplace.offer_creator_requirements
  RENAME CONSTRAINT uq_marketplace_requirements_listing
  TO uq_marketplace_requirements_offer;
ALTER TABLE marketplace.offer_creator_requirements
  RENAME CONSTRAINT fk_marketplace_requirements_listing_org
  TO fk_marketplace_requirements_offer_org;

-- Offer deliverables describe the content the hotel requests. Accepted
-- collaborations receive their own trackable deliverable rows.
CREATE TABLE marketplace.offer_deliverables (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id             UUID        NOT NULL,
  property_id          UUID        NOT NULL,
  organization_id      UUID        NOT NULL,
  platform             TEXT        NOT NULL,
  deliverable_type     TEXT        NOT NULL,
  quantity             INTEGER     NOT NULL DEFAULT 1,
  timing_guidance      TEXT,
  deliverable_metadata JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_offer_deliverables_quantity
    CHECK (quantity > 0),
  CONSTRAINT fk_marketplace_offer_deliverables_offer_org
    FOREIGN KEY (offer_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_offers(id, property_id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_offer_deliverables_offer
  ON marketplace.offer_deliverables (offer_id, created_at);

-- A pending or negotiating collaboration is the creator proposal. Affiliate
-- participation is additive and no longer occupies the primary compensation
-- type slot.
ALTER TABLE marketplace.collaborations
  DROP CONSTRAINT IF EXISTS collaborations_collaboration_type_check;
ALTER TABLE marketplace.collaborations
  DROP CONSTRAINT IF EXISTS chk_marketplace_collaborations_type_terms;

ALTER TABLE marketplace.collaborations
  RENAME COLUMN listing_id TO offer_id;
ALTER TABLE marketplace.collaborations
  RENAME COLUMN collaboration_type TO compensation_type;
ALTER TABLE marketplace.collaborations
  RENAME COLUMN creator_fee TO affiliate_commission_percentage;
ALTER TABLE marketplace.collaborations
  ADD COLUMN affiliate_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE marketplace.collaborations
SET affiliate_enabled = TRUE
WHERE compensation_type = 'affiliate'
   OR commission_rule_id IS NOT NULL
   OR affiliate_referral_code IS NOT NULL
   OR affiliate_link IS NOT NULL;

UPDATE marketplace.collaborations
SET compensation_type = NULL
WHERE compensation_type = 'affiliate';

ALTER TABLE marketplace.collaborations
  ADD CONSTRAINT collaborations_compensation_type_check
  CHECK (
    compensation_type IS NULL
    OR compensation_type IN ('free_stay', 'paid', 'discount', 'custom')
  ) NOT VALID;
ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT collaborations_compensation_type_check;
ALTER TABLE marketplace.collaborations
  ADD CONSTRAINT chk_marketplace_collaborations_compensation_terms
  CHECK (
    (
      compensation_type IS DISTINCT FROM 'free_stay'
      OR (
        free_stay_min_nights IS NOT NULL
        AND free_stay_max_nights IS NOT NULL
        AND free_stay_min_nights > 0
        AND free_stay_max_nights >= free_stay_min_nights
      )
    )
    AND (
      compensation_type IS DISTINCT FROM 'paid'
      OR (paid_amount IS NOT NULL AND paid_amount > 0)
    )
    AND (
      compensation_type IS DISTINCT FROM 'discount'
      OR (discount_percentage IS NOT NULL AND discount_percentage BETWEEN 1 AND 100)
    )
    AND (
      affiliate_commission_percentage IS NULL
      OR affiliate_commission_percentage BETWEEN 1 AND 100
    )
    AND (initiator_type <> 'creator' OR creator_consent IS TRUE)
  ) NOT VALID;
ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT chk_marketplace_collaborations_compensation_terms;
ALTER TABLE marketplace.collaborations
  ADD CONSTRAINT chk_marketplace_collaborations_affiliate_link
  CHECK (
    (affiliate_referral_code IS NULL AND affiliate_link IS NULL)
    OR affiliate_enabled = TRUE
  ) NOT VALID;
ALTER TABLE marketplace.collaborations
  VALIDATE CONSTRAINT chk_marketplace_collaborations_affiliate_link;
ALTER TABLE marketplace.collaborations
  RENAME CONSTRAINT fk_marketplace_collaborations_listing_org
  TO fk_marketplace_collaborations_offer_org;
ALTER INDEX marketplace.uq_marketplace_collaborations_active_listing_creator
  RENAME TO uq_marketplace_collaborations_active_offer_creator;

-- Public discovery is projected from offers plus canonical hotel facts.
ALTER TABLE marketplace.marketplace_listing_read_model
  RENAME TO marketplace_offer_read_model;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME COLUMN listing_id TO offer_id;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME COLUMN listing_title TO offer_title;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME COLUMN listing_summary TO offer_summary;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME COLUMN public_offering_summary TO public_compensation_summary;

ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME CONSTRAINT marketplace_listing_read_model_pkey
  TO marketplace_offer_read_model_pkey;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME CONSTRAINT marketplace_listing_read_model_visibility_status_check
  TO marketplace_offer_read_model_visibility_status_check;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME CONSTRAINT chk_marketplace_listing_read_model_public_json
  TO chk_marketplace_offer_read_model_public_json;
ALTER TABLE marketplace.marketplace_offer_read_model
  RENAME CONSTRAINT fk_marketplace_read_model_listing_property
  TO fk_marketplace_read_model_offer_property;
ALTER INDEX marketplace.idx_marketplace_listing_read_model_visibility
  RENAME TO idx_marketplace_offer_read_model_visibility;

-- Keep the public-key guard aligned with canonical column names.
CREATE OR REPLACE FUNCTION marketplace.jsonb_has_marketplace_private_key(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT marketplace.jsonb_has_forbidden_public_key(
    document,
    ARRAY[
      'affiliate_link', 'affiliate_referral_code', 'application_message',
      'body', 'commission_rule_id', 'content', 'created_by_user_id',
      'affiliate_commission_percentage', 'email', 'latitude', 'longitude',
      'message_body', 'message_metadata', 'negotiated_terms',
      'organization_id', 'phone', 'pii_retention_until',
      'postal_code', 'private_notes', 'raw_marketplace_location',
      'redeemed_by_user_id', 'source_collaboration_id',
      'source_creator_id', 'source_hotel_profile_id',
      'source_offer_id', 'street_address', 'user_id'
    ]::TEXT[]
  );
$$;

-- Platform media uses the offer resource and purpose names.
CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.listing.gallery',
      'marketplace.offer.media',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

UPDATE platform.media_objects
SET purpose = 'marketplace.offer.media'
WHERE purpose = 'marketplace.listing.gallery';

UPDATE platform.media_upload_sessions
SET requested_purpose = 'marketplace.offer.media'
WHERE requested_purpose = 'marketplace.listing.gallery';

UPDATE platform.media_objects
SET resource_type = 'marketplace_offer'
WHERE resource_product = 'marketplace'
  AND resource_type = 'hotel_listing';

UPDATE platform.media_upload_sessions
SET resource_type = 'marketplace_offer'
WHERE resource_product = 'marketplace'
  AND resource_type = 'hotel_listing';

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.offer.media',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

-- Ask Intelligence keeps only the canonical read-model source name. Allow
-- both names while existing evidence rows are rewritten, then tighten it.
CREATE OR REPLACE FUNCTION intelligence.valid_source_view(
  source_owner TEXT,
  source_view TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE source_owner
    WHEN 'booking' THEN source_view IN ('direct_booking_summary_read_model')
    WHEN 'pms' THEN source_view IN ('pms_operations_summary_read_model')
    WHEN 'finance' THEN source_view IN ('finance_visibility_read_model')
    WHEN 'marketplace' THEN source_view IN (
      'marketplace_listing_read_model',
      'marketplace_offer_read_model'
    )
    WHEN 'distribution' THEN source_view IN (
      'public_hotel_bookability_profiles',
      'public_quote_read_models',
      'public_room_offer_snapshots'
    )
    WHEN 'hotel_catalog' THEN source_view IN (
      'property_public_profile_read_model',
      'property_setup_status'
    )
    WHEN 'platform' THEN source_view IN ('product_audit_events')
    WHEN 'intelligence' THEN source_view IN (
      'metric_snapshot_runs',
      'setup_completeness_snapshots'
    )
    ELSE FALSE
  END;
$$;

UPDATE intelligence.metric_snapshot_runs
SET source_view = 'marketplace_offer_read_model'
WHERE source_owner = 'marketplace'
  AND source_view = 'marketplace_listing_read_model';

UPDATE intelligence.ai_evidence_catalog
SET source_view = 'marketplace_offer_read_model'
WHERE source_owner = 'marketplace'
  AND source_view = 'marketplace_listing_read_model';

CREATE OR REPLACE FUNCTION intelligence.valid_source_view(
  source_owner TEXT,
  source_view TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE source_owner
    WHEN 'booking' THEN source_view IN ('direct_booking_summary_read_model')
    WHEN 'pms' THEN source_view IN ('pms_operations_summary_read_model')
    WHEN 'finance' THEN source_view IN ('finance_visibility_read_model')
    WHEN 'marketplace' THEN source_view IN ('marketplace_offer_read_model')
    WHEN 'distribution' THEN source_view IN (
      'public_hotel_bookability_profiles',
      'public_quote_read_models',
      'public_room_offer_snapshots'
    )
    WHEN 'hotel_catalog' THEN source_view IN (
      'property_public_profile_read_model',
      'property_setup_status'
    )
    WHEN 'platform' THEN source_view IN ('product_audit_events')
    WHEN 'intelligence' THEN source_view IN (
      'metric_snapshot_runs',
      'setup_completeness_snapshots'
    )
    ELSE FALSE
  END;
$$;
