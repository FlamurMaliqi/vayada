-- Migration: 0038_repair_marketplace_offer_operator_links
-- Owner: domain-marketplace
--
-- Hotel self-service briefly copied the hotel-profile relationship onto new
-- Marketplace offers. Hotel owners therefore received an offer owner link,
-- while collaboration workflows require the canonical operator link. Only
-- insert missing links so explicit operator suspensions or archival stay intact.

INSERT INTO identity.organization_resource_links (
  organization_id,
  product,
  resource_type,
  resource_id,
  relationship,
  status
)
SELECT
  offer.organization_id,
  'marketplace',
  'marketplace_offer',
  offer.id::text,
  'operator',
  'active'
FROM marketplace.marketplace_offers offer
JOIN identity.organization_resource_links owner_link
  ON owner_link.organization_id = offer.organization_id
 AND owner_link.product = 'marketplace'
 AND owner_link.resource_type = 'marketplace_offer'
 AND owner_link.resource_id = offer.id::text
 AND owner_link.relationship = 'owner'
 AND owner_link.status = 'active'
WHERE offer.offer_status <> 'archived'
ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
DO NOTHING;
