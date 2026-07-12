import type pg from "pg";

export async function backfillCanonicalPropertyResourceLinks(client: pg.Client): Promise<void> {
  await client.query(`
    WITH property_link_candidates AS (
      SELECT
        link.organization_id,
        source.property_id,
        link.relationship
      FROM identity.organization_resource_links link
      JOIN identity.organizations organization
        ON organization.id = link.organization_id
      JOIN hotel_catalog.property_source_links source
        ON source.source_system = 'booking'
       AND source.source_table = 'booking_hotels'
       AND source.source_id = link.resource_id
       AND source.status = 'active'
      WHERE organization.kind = 'hotel_group'
        AND organization.status = 'active'
        AND link.status = 'active'
        AND link.product = 'booking'
        AND link.resource_type = 'booking_hotel'
        AND link.relationship IN ('owner', 'operator')

      UNION ALL

      SELECT
        link.organization_id,
        source.property_id,
        link.relationship
      FROM identity.organization_resource_links link
      JOIN identity.organizations organization
        ON organization.id = link.organization_id
      JOIN hotel_catalog.property_source_links source
        ON source.source_system = 'pms'
       AND source.source_table = 'hotels'
       AND source.source_id = link.resource_id
       AND source.status = 'active'
      WHERE organization.kind = 'hotel_group'
        AND organization.status = 'active'
        AND link.status = 'active'
        AND link.product = 'pms'
        AND link.resource_type = 'pms_hotel'
        AND link.relationship IN ('owner', 'operator')

      UNION ALL

      SELECT
        link.organization_id,
        property.id AS property_id,
        link.relationship
      FROM identity.organization_resource_links link
      JOIN identity.organizations organization
        ON organization.id = link.organization_id
      JOIN hotel_catalog.properties property
        ON property.id::text = link.resource_id
      WHERE organization.kind = 'hotel_group'
        AND organization.status = 'active'
        AND link.status = 'active'
        AND link.product = 'pms'
        AND link.resource_type = 'pms_property'
        AND link.relationship IN ('owner', 'operator')

      UNION ALL

      SELECT
        link.organization_id,
        profile.property_id,
        link.relationship
      FROM identity.organization_resource_links link
      JOIN identity.organizations organization
        ON organization.id = link.organization_id
      JOIN marketplace.marketplace_hotel_profiles profile
        ON profile.organization_id = link.organization_id
       AND (
         profile.property_id::text = link.resource_id
         OR profile.source_hotel_profile_id = link.resource_id
       )
      WHERE organization.kind = 'hotel_group'
        AND organization.status = 'active'
        AND link.status = 'active'
        AND link.product = 'marketplace'
        AND link.resource_type = 'hotel_profile'
        AND link.relationship IN ('owner', 'operator')

      UNION ALL

      SELECT
        link.organization_id,
        offer.property_id,
        link.relationship
      FROM identity.organization_resource_links link
      JOIN identity.organizations organization
        ON organization.id = link.organization_id
      JOIN marketplace.marketplace_offers offer
        ON offer.organization_id = link.organization_id
       AND (
         offer.id::text = link.resource_id
         OR offer.source_offer_id = link.resource_id
       )
      WHERE organization.kind = 'hotel_group'
        AND organization.status = 'active'
        AND link.status = 'active'
        AND link.product = 'marketplace'
        AND link.resource_type = 'marketplace_offer'
        AND link.relationship IN ('owner', 'operator')
    ),
    canonical_property_links AS (
      SELECT
        organization_id,
        property_id::text AS resource_id,
        CASE WHEN bool_or(relationship = 'owner') THEN 'owner' ELSE 'operator' END AS relationship
      FROM property_link_candidates
      GROUP BY organization_id, property_id
    )
    INSERT INTO identity.organization_resource_links
      (organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      organization_id,
      'hotel_catalog',
      'property',
      resource_id,
      relationship,
      'active'
    FROM canonical_property_links
    ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
    DO UPDATE SET status = 'active', updated_at = now()
  `);
}
