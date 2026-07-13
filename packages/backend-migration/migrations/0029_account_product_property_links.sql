-- Migration: 0029_account_product_property_links
-- Owner: domain-identity, domain-hotels
-- See: engineering/shared-hotel-setup-status-contract.md
--
-- Product choice is account-wide. Reconcile the former per-property intent and
-- resource-scoped access rows into one primary entitlement per organization.
-- An explicit suspension wins over active legacy access, while an existing
-- primary account entitlement otherwise remains authoritative.

WITH suspended_legacy_access AS (
  SELECT
    organization_id,
    product,
    bool_or(expires_at IS NULL) AS has_unbounded_suspension,
    max(expires_at) AS suspension_expires_at
  FROM identity.product_entitlements
  WHERE status = 'suspended'
    AND (starts_at IS NULL OR starts_at <= now())
    AND (expires_at IS NULL OR expires_at > now())
    AND (
      (product = 'booking' AND entitlement_key IN ('account_access', 'booking-engine'))
      OR (product = 'pms' AND entitlement_key IN ('account_access', 'pms-core', 'property-management'))
      OR (
        product = 'marketplace'
        AND entitlement_key IN ('account_access', 'marketplace-hotel-profile')
      )
    )
    AND NOT (
      resource_product IS NULL
      AND resource_type IS NULL
      AND resource_id IS NULL
      AND entitlement_key = CASE product
        WHEN 'booking' THEN 'booking-engine'
        WHEN 'pms' THEN 'property-management'
        WHEN 'marketplace' THEN 'marketplace-hotel-profile'
      END
    )
  GROUP BY organization_id, product
)
UPDATE identity.product_entitlements primary_entitlement
SET
  status = 'suspended',
  starts_at = NULL,
  expires_at = CASE
    WHEN legacy.has_unbounded_suspension THEN NULL
    ELSE legacy.suspension_expires_at
  END,
  metadata = primary_entitlement.metadata || jsonb_build_object(
    'migrationSuspensionSource',
    'legacy_resource_entitlement'
  ),
  updated_at = now()
FROM suspended_legacy_access legacy
WHERE primary_entitlement.organization_id = legacy.organization_id
  AND primary_entitlement.product = legacy.product
  AND primary_entitlement.entitlement_key = CASE primary_entitlement.product
    WHEN 'booking' THEN 'booking-engine'
    WHEN 'pms' THEN 'property-management'
    WHEN 'marketplace' THEN 'marketplace-hotel-profile'
  END
  AND primary_entitlement.resource_product IS NULL
  AND primary_entitlement.resource_type IS NULL
  AND primary_entitlement.resource_id IS NULL
  AND primary_entitlement.status <> 'suspended'
  AND (primary_entitlement.starts_at IS NULL OR primary_entitlement.starts_at <= now());

WITH legacy_state AS (
  SELECT
    organization_id,
    product,
    bool_or(
      status = 'suspended'
      AND (starts_at IS NULL OR starts_at <= now())
      AND (expires_at IS NULL OR expires_at > now())
    ) AS has_suspension,
    bool_or(
      status = 'suspended'
      AND (starts_at IS NULL OR starts_at <= now())
      AND (expires_at IS NULL OR expires_at > now())
      AND expires_at IS NULL
    ) AS has_unbounded_suspension,
    max(expires_at) FILTER (
      WHERE status = 'suspended'
        AND (starts_at IS NULL OR starts_at <= now())
        AND (expires_at IS NULL OR expires_at > now())
    ) AS suspension_expires_at,
    bool_or(
      status = 'active'
      AND (starts_at IS NULL OR starts_at <= now())
      AND (expires_at IS NULL OR expires_at > now())
    ) AS has_active_access,
    min(starts_at) FILTER (
      WHERE status = 'active'
        AND (starts_at IS NULL OR starts_at <= now())
        AND (expires_at IS NULL OR expires_at > now())
    ) AS starts_at,
    bool_or(
      status = 'active'
      AND (starts_at IS NULL OR starts_at <= now())
      AND expires_at IS NULL
    ) AS has_unbounded_access,
    max(expires_at) FILTER (
      WHERE status = 'active'
        AND (starts_at IS NULL OR starts_at <= now())
        AND (expires_at IS NULL OR expires_at > now())
    ) AS expires_at
  FROM identity.product_entitlements
  WHERE (
      (product = 'booking' AND entitlement_key IN ('account_access', 'booking-engine'))
      OR (product = 'pms' AND entitlement_key IN ('account_access', 'pms-core', 'property-management'))
      OR (
        product = 'marketplace'
        AND entitlement_key IN ('account_access', 'marketplace-hotel-profile')
      )
    )
    AND NOT (
      resource_product IS NULL
      AND resource_type IS NULL
      AND resource_id IS NULL
      AND entitlement_key = CASE product
        WHEN 'booking' THEN 'booking-engine'
        WHEN 'pms' THEN 'property-management'
        WHEN 'marketplace' THEN 'marketplace-hotel-profile'
      END
    )
  GROUP BY organization_id, product
),
selected_intent AS (
  SELECT DISTINCT organization_id, product
  FROM hotel_catalog.property_product_selections
  WHERE status = 'selected'
),
candidates AS (
  SELECT organization_id, product FROM legacy_state
  UNION
  SELECT organization_id, product FROM selected_intent
)
INSERT INTO identity.product_entitlements (
  organization_id,
  product,
  entitlement_key,
  status,
  starts_at,
  expires_at,
  metadata
)
SELECT
  candidates.organization_id,
  candidates.product,
  CASE candidates.product
    WHEN 'booking' THEN 'booking-engine'
    WHEN 'pms' THEN 'property-management'
    WHEN 'marketplace' THEN 'marketplace-hotel-profile'
  END,
  CASE WHEN COALESCE(legacy_state.has_suspension, FALSE) THEN 'suspended' ELSE 'active' END,
  CASE
    WHEN COALESCE(legacy_state.has_suspension, FALSE) THEN NULL
    WHEN COALESCE(legacy_state.has_active_access, FALSE) THEN legacy_state.starts_at
    ELSE now()
  END,
  CASE
    WHEN COALESCE(legacy_state.has_suspension, FALSE)
      AND COALESCE(legacy_state.has_unbounded_suspension, FALSE)
      THEN NULL
    WHEN COALESCE(legacy_state.has_suspension, FALSE)
      THEN legacy_state.suspension_expires_at
    WHEN COALESCE(legacy_state.has_active_access, FALSE)
      AND NOT COALESCE(legacy_state.has_unbounded_access, FALSE)
      THEN legacy_state.expires_at
    ELSE NULL
  END,
  CASE
    WHEN COALESCE(legacy_state.has_suspension, FALSE)
      OR COALESCE(legacy_state.has_active_access, FALSE)
      THEN jsonb_build_object(
        'source', 'legacy_product_entitlement',
        'migratedFrom', 'resource_product_entitlement'
      )
    ELSE jsonb_build_object(
      'source', 'shared_hotel_setup',
      'migratedFrom', 'property_product_selection'
    )
  END
FROM candidates
LEFT JOIN legacy_state
  ON legacy_state.organization_id = candidates.organization_id
 AND legacy_state.product = candidates.product
WHERE COALESCE(legacy_state.has_suspension, FALSE)
   OR COALESCE(legacy_state.has_active_access, FALSE)
   OR EXISTS (
     SELECT 1
     FROM selected_intent
     WHERE selected_intent.organization_id = candidates.organization_id
       AND selected_intent.product = candidates.product
   )
ON CONFLICT (
  organization_id,
  product,
  entitlement_key,
  COALESCE(resource_product, ''),
  COALESCE(resource_type, ''),
  COALESCE(resource_id, '')
) DO UPDATE SET
  status = EXCLUDED.status,
  starts_at = EXCLUDED.starts_at,
  expires_at = EXCLUDED.expires_at,
  metadata = identity.product_entitlements.metadata || EXCLUDED.metadata,
  updated_at = now()
WHERE EXCLUDED.status = 'active'
  AND (
    identity.product_entitlements.status = 'expired'
    OR (
      identity.product_entitlements.expires_at IS NOT NULL
      AND identity.product_entitlements.expires_at <= now()
    )
  );

-- The account entitlement is now authoritative. Keep resource links for
-- authorization scope, but retire duplicate entitlement rows so they cannot
-- independently grant or suspend product access.
UPDATE identity.product_entitlements entitlement
SET
  status = 'expired',
  expires_at = CASE
    WHEN entitlement.starts_at IS NOT NULL AND entitlement.starts_at > now()
      THEN entitlement.starts_at
    ELSE COALESCE(entitlement.expires_at, now())
  END,
  metadata = entitlement.metadata || jsonb_build_object(
    'migratedTo',
    'account_product_entitlement'
  ),
  updated_at = now()
WHERE (
    (product = 'booking' AND entitlement_key IN ('account_access', 'booking-engine'))
    OR (product = 'pms' AND entitlement_key IN ('account_access', 'pms-core', 'property-management'))
    OR (
      product = 'marketplace'
      AND entitlement_key IN ('account_access', 'marketplace-hotel-profile')
    )
  )
  AND NOT (
    resource_product IS NULL
    AND resource_type IS NULL
    AND resource_id IS NULL
    AND entitlement_key = CASE product
      WHEN 'booking' THEN 'booking-engine'
      WHEN 'pms' THEN 'property-management'
      WHEN 'marketplace' THEN 'marketplace-hotel-profile'
    END
  )
  AND status <> 'expired'
  AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
  AND EXISTS (
    SELECT 1
    FROM identity.product_entitlements primary_entitlement
    WHERE primary_entitlement.organization_id = entitlement.organization_id
      AND primary_entitlement.product = entitlement.product
      AND primary_entitlement.entitlement_key = CASE primary_entitlement.product
        WHEN 'booking' THEN 'booking-engine'
        WHEN 'pms' THEN 'property-management'
        WHEN 'marketplace' THEN 'marketplace-hotel-profile'
      END
      AND primary_entitlement.status = 'active'
      AND primary_entitlement.resource_product IS NULL
      AND primary_entitlement.resource_type IS NULL
      AND primary_entitlement.resource_id IS NULL
      AND (primary_entitlement.starts_at IS NULL OR primary_entitlement.starts_at <= now())
      AND (primary_entitlement.expires_at IS NULL OR primary_entitlement.expires_at > now())
  );

WITH effective_product_state AS (
  SELECT
    organization_id,
    product,
    bool_or(status = 'active') AS active,
    bool_or(status = 'suspended') AS suspended
  FROM identity.product_entitlements
  WHERE (starts_at IS NULL OR starts_at <= now())
    AND (expires_at IS NULL OR expires_at > now())
    AND (
      (product = 'booking' AND entitlement_key IN ('booking-engine', 'account_access'))
      OR (
        product = 'pms'
        AND entitlement_key IN ('property-management', 'pms-core', 'account_access')
      )
      OR (
        product = 'marketplace'
        AND entitlement_key IN ('marketplace-hotel-profile', 'account_access')
      )
    )
  GROUP BY organization_id, product
),
selected_products AS (
  SELECT organization_id, product
  FROM effective_product_state
  WHERE active AND NOT suspended
),
canonical_properties AS (
  SELECT link.organization_id, link.resource_id, link.relationship
  FROM identity.organization_resource_links link
  JOIN hotel_catalog.properties property
    ON property.id::text = link.resource_id
  WHERE link.product = 'hotel_catalog'
    AND link.resource_type = 'property'
    AND link.status = 'active'
    AND link.relationship IN ('owner', 'operator')
)
INSERT INTO identity.organization_resource_links (
  organization_id,
  product,
  resource_type,
  resource_id,
  relationship,
  status
)
SELECT
  selected_products.organization_id,
  selected_products.product,
  CASE selected_products.product
    WHEN 'booking' THEN 'booking_hotel'
    WHEN 'pms' THEN 'pms_property'
    WHEN 'marketplace' THEN 'hotel_profile'
  END,
  canonical_properties.resource_id,
  canonical_properties.relationship,
  'active'
FROM selected_products
JOIN canonical_properties
  ON canonical_properties.organization_id = selected_products.organization_id
ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
DO UPDATE SET status = 'active', updated_at = now()
WHERE identity.organization_resource_links.status <> 'suspended';

WITH marketplace_enabled AS (
  SELECT organization_id
  FROM identity.product_entitlements
  WHERE product = 'marketplace'
    AND entitlement_key IN ('marketplace-hotel-profile', 'account_access')
    AND (starts_at IS NULL OR starts_at <= now())
    AND (expires_at IS NULL OR expires_at > now())
  GROUP BY organization_id
  HAVING bool_or(status = 'active') AND NOT bool_or(status = 'suspended')
)
INSERT INTO marketplace.marketplace_hotel_profiles (
  property_id,
  organization_id,
  source_system,
  source_hotel_profile_id
)
SELECT
  profile_link.resource_id::uuid,
  profile_link.organization_id,
  'marketplace',
  profile_link.resource_id
FROM identity.organization_resource_links profile_link
JOIN marketplace_enabled
  ON marketplace_enabled.organization_id = profile_link.organization_id
JOIN hotel_catalog.properties property
  ON property.id::text = profile_link.resource_id
WHERE profile_link.product = 'marketplace'
  AND profile_link.resource_type = 'hotel_profile'
  AND profile_link.status = 'active'
  AND profile_link.relationship IN ('owner', 'operator')
ON CONFLICT (property_id) DO NOTHING;

-- Existing listings need the same target-native authorization link as new
-- self-service offers. Preserve explicit suspensions by inserting only missing
-- links. Marketplace-native rows keep their nullable source ID because their
-- target UUID becomes the canonical offer API ID in migration 0030.
INSERT INTO identity.organization_resource_links (
  organization_id,
  product,
  resource_type,
  resource_id,
  relationship,
  status
)
SELECT
  listing.organization_id,
  'marketplace',
  'hotel_listing',
  listing.id::text,
  profile_link.relationship,
  'active'
FROM marketplace.marketplace_hotel_listings listing
JOIN identity.organization_resource_links profile_link
  ON profile_link.organization_id = listing.organization_id
 AND profile_link.product = 'marketplace'
 AND profile_link.resource_type = 'hotel_profile'
 AND profile_link.resource_id = listing.property_id::text
 AND profile_link.status = 'active'
 AND profile_link.relationship IN ('owner', 'operator')
WHERE listing.listing_status <> 'archived'
  AND NOT EXISTS (
    SELECT 1
    FROM identity.organization_resource_links suspended_link
    WHERE suspended_link.organization_id = listing.organization_id
      AND suspended_link.product = 'marketplace'
      AND suspended_link.resource_type = 'hotel_listing'
      AND suspended_link.status = 'suspended'
      AND suspended_link.relationship IN ('owner', 'operator')
      AND suspended_link.resource_id IN (
        listing.id::text,
        listing.source_listing_id
      )
  )
ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
DO NOTHING;

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  (
    'hotel_catalog.products.manage',
    'hotel_catalog',
    'Enable or disable account-wide hotel products during onboarding'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('hotel_group', 'hotel_owner', 'hotel_catalog.products.manage'),
  ('hotel_group', 'owner',       'hotel_catalog.products.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;

WITH booking_enabled AS (
  SELECT organization_id
  FROM identity.product_entitlements
  WHERE product = 'booking'
    AND entitlement_key IN ('booking-engine', 'account_access')
    AND (starts_at IS NULL OR starts_at <= now())
    AND (expires_at IS NULL OR expires_at > now())
  GROUP BY organization_id
  HAVING bool_or(status = 'active') AND NOT bool_or(status = 'suspended')
)
INSERT INTO booking.booking_settings (property_id)
SELECT DISTINCT booking_link.resource_id::uuid
FROM identity.organization_resource_links booking_link
JOIN booking_enabled
  ON booking_enabled.organization_id = booking_link.organization_id
JOIN hotel_catalog.properties property
  ON property.id::text = booking_link.resource_id
WHERE booking_link.product = 'booking'
  AND booking_link.resource_type = 'booking_hotel'
  AND booking_link.status = 'active'
  AND booking_link.relationship IN ('owner', 'operator')
ON CONFLICT (property_id) DO NOTHING;

DROP TABLE hotel_catalog.property_product_selections;
