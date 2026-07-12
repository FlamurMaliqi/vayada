-- Fixture: marketplace / marketplace.sql
-- Source: migration_source_marketplace schema.
--
-- Represents source-side marketplace inputs for one creator/hotel
-- collaboration slice. The rebuild command loads these rows into
-- migration-only fixture tables, then packages/backend-migration transforms
-- them into identity, hotel_catalog, finance, and marketplace target tables.

DROP SCHEMA IF EXISTS migration_source_marketplace CASCADE;
CREATE SCHEMA migration_source_marketplace;

CREATE TABLE migration_source_marketplace.users AS
SELECT
  'f6881000-0000-0000-0000-000000000001'::uuid AS id,
  'hotel.marketplace@example.test'::text AS email,
  'Marketplace Hotel Owner'::text AS name,
  'active'::text AS status
UNION ALL
SELECT
  'f6881000-0000-0000-0000-000000000002'::uuid,
  'creator.marketplace@example.test'::text,
  'Marketplace Creator Owner'::text,
  'active'::text
UNION ALL
SELECT
  'f6881000-0000-0000-0000-000000000003'::uuid,
  'platform.marketplace@example.test'::text,
  'Marketplace Platform Admin'::text,
  'active'::text;

CREATE TABLE migration_source_marketplace.organizations AS
SELECT
  'f6882000-0000-0000-0000-000000000001'::uuid AS id,
  'hotel_group'::text AS kind,
  'Marketplace Alpenrose Group'::text AS name,
  'marketplace-alpenrose-group'::text AS slug,
  'active'::text AS status,
  'org_marketplace_alpenrose'::text AS workos_org_id,
  'marketplace-alpenrose-group'::text AS workos_external_id
UNION ALL
SELECT
  'f6882000-0000-0000-0000-000000000002'::uuid,
  'creator_workspace'::text,
  'Mara Lens Studio'::text,
  'mara-lens-studio'::text,
  'active'::text,
  'org_marketplace_mara_lens'::text,
  'mara-lens-studio'::text;

CREATE TABLE migration_source_marketplace.organization_memberships AS
SELECT
  'f6882100-0000-0000-0000-000000000001'::uuid AS id,
  'f6882000-0000-0000-0000-000000000001'::uuid AS organization_id,
  'f6881000-0000-0000-0000-000000000001'::uuid AS user_id,
  'active'::text AS status,
  'hotel_owner'::text AS role_key,
  'membership_marketplace_hotel_owner'::text AS workos_membership_id,
  ARRAY['hotel_owner']::text[] AS workos_role_slugs
UNION ALL
SELECT
  'f6882100-0000-0000-0000-000000000002'::uuid,
  'f6882000-0000-0000-0000-000000000002'::uuid,
  'f6881000-0000-0000-0000-000000000002'::uuid,
  'active'::text,
  'creator_owner'::text,
  'membership_marketplace_creator_owner'::text,
  ARRAY['creator_owner']::text[];

CREATE TABLE migration_source_marketplace.organization_resource_links AS
SELECT
  'f6882200-0000-0000-0000-000000000001'::uuid AS id,
  'f6882000-0000-0000-0000-000000000001'::uuid AS organization_id,
  'marketplace'::text AS product,
  'hotel_profile'::text AS resource_type,
  'f6883000-0000-0000-0000-000000000001'::text AS resource_id,
  'owner'::text AS relationship,
  'active'::text AS status
UNION ALL
SELECT
  'f6882200-0000-0000-0000-000000000002'::uuid,
  'f6882000-0000-0000-0000-000000000001'::uuid,
  'marketplace'::text,
  'hotel_listing'::text,
  'f6885000-0000-0000-0000-000000000001'::text,
  'owner'::text,
  'active'::text
UNION ALL
SELECT
  'f6882200-0000-0000-0000-000000000003'::uuid,
  'f6882000-0000-0000-0000-000000000002'::uuid,
  'marketplace'::text,
  'creator_profile'::text,
  'f6884000-0000-0000-0000-000000000001'::text,
  'owner'::text,
  'active'::text;

CREATE TABLE migration_source_marketplace.product_entitlements AS
SELECT
  'f6882300-0000-0000-0000-000000000001'::uuid AS id,
  'f6882000-0000-0000-0000-000000000001'::uuid AS organization_id,
  'marketplace'::text AS product,
  'marketplace-hotel-profile'::text AS entitlement_key,
  'active'::text AS status,
  'marketplace'::text AS resource_product,
  'hotel_profile'::text AS resource_type,
  'f6883000-0000-0000-0000-000000000001'::text AS resource_id,
  '2026-06-01T00:00:00Z'::timestamptz AS starts_at,
  '{"fixture": "marketplace"}'::jsonb AS metadata
UNION ALL
SELECT
  'f6882300-0000-0000-0000-000000000002'::uuid,
  'f6882000-0000-0000-0000-000000000001'::uuid,
  'marketplace'::text,
  'marketplace-hotel-listing'::text,
  'active'::text,
  'marketplace'::text,
  'hotel_listing'::text,
  'f6885000-0000-0000-0000-000000000001'::text,
  '2026-06-01T00:00:00Z'::timestamptz,
  '{"fixture": "marketplace"}'::jsonb
UNION ALL
SELECT
  'f6882300-0000-0000-0000-000000000003'::uuid,
  'f6882000-0000-0000-0000-000000000002'::uuid,
  'marketplace'::text,
  'marketplace-creator-profile'::text,
  'active'::text,
  'marketplace'::text,
  'creator_profile'::text,
  'f6884000-0000-0000-0000-000000000001'::text,
  '2026-06-01T00:00:00Z'::timestamptz,
  '{"fixture": "marketplace"}'::jsonb;

CREATE TABLE migration_source_marketplace.properties AS
SELECT
  'f6883000-0000-0000-0000-000000000001'::uuid AS id,
  'prop_marketplace_alpenrose'::text AS public_id,
  'Marketplace Alpenrose'::text AS display_name,
  'hotel'::text AS property_type,
  'boutique'::text AS category,
  'en'::text AS default_locale,
  ARRAY['en', 'de']::text[] AS supported_locales,
  'complete'::text AS profile_status,
  ARRAY[]::text[] AS completeness_reasons;

CREATE TABLE migration_source_marketplace.property_source_links AS
SELECT
  'f6883100-0000-0000-0000-000000000001'::uuid AS id,
  'f6883000-0000-0000-0000-000000000001'::uuid AS property_id,
  'marketplace'::text AS source_system,
  'hotel_profiles'::text AS source_table,
  'marketplace-hotel-profile-688'::text AS source_id,
  'profile_input'::text AS relationship,
  '{"fixture": "marketplace"}'::jsonb AS metadata
UNION ALL
SELECT
  'f6883100-0000-0000-0000-000000000002'::uuid,
  'f6883000-0000-0000-0000-000000000001'::uuid,
  'marketplace'::text,
  'hotel_listings'::text,
  'marketplace-listing-688'::text,
  'listing_input'::text,
  '{"fixture": "marketplace"}'::jsonb;

CREATE TABLE migration_source_marketplace.property_slugs AS
SELECT
  'f6883200-0000-0000-0000-000000000001'::uuid AS id,
  'f6883000-0000-0000-0000-000000000001'::uuid AS property_id,
  'marketplace-alpenrose'::text AS slug,
  NULL::text AS locale,
  'marketplace_overlay'::text AS purpose,
  'active'::text AS status;

CREATE TABLE migration_source_marketplace.commission_rules AS
SELECT
  'f6887000-0000-0000-0000-000000000001'::uuid AS id,
  'f6883000-0000-0000-0000-000000000001'::uuid AS property_id,
  'f6882000-0000-0000-0000-000000000001'::uuid AS organization_id,
  'marketplace'::text AS rule_scope,
  'marketplace'::text AS product,
  'percentage'::text AS commission_type,
  10.0000::numeric AS percentage_rate,
  'EUR'::char(3) AS currency,
  'active'::text AS status,
  '2026-06-01T00:00:00Z'::timestamptz AS starts_at,
  'marketplace'::text AS source_system,
  'marketplace-commission-rule-688'::text AS source_rule_id,
  '{"fixture": "marketplace"}'::jsonb AS rule_metadata;

CREATE TABLE migration_source_marketplace.creators AS
SELECT
  'f6884000-0000-0000-0000-000000000001'::uuid AS id,
  'f6882000-0000-0000-0000-000000000002'::uuid AS organization_id,
  'f6881000-0000-0000-0000-000000000002'::uuid AS owner_user_id,
  'marketplace-creator-688'::text AS source_creator_id,
  'Mara Lens'::text AS display_name,
  'travel'::text AS creator_type,
  'Innsbruck, Austria'::text AS location_text,
  'Travel creator focused on alpine boutique hotels.'::text AS short_description,
  'https://mara.example.test'::text AS portfolio_url,
  '+43123456888'::text AS phone,
  'https://cdn.example.test/creators/mara.jpg'::text AS profile_picture_url,
  TRUE::boolean AS profile_complete,
  '2026-06-01T10:00:00Z'::timestamptz AS profile_completed_at,
  'active'::text AS profile_status,
  '{"fixture": "marketplace", "internalSegment": "creatorSecretRate"}'::jsonb AS profile_metadata,
  '2027-06-01'::date AS pii_retention_until,
  '2026-06-01T09:00:00Z'::timestamptz AS created_at,
  '2026-06-01T10:00:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.creator_platforms AS
SELECT
  'f6884100-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-platform-688'::text AS source_platform_id,
  'instagram'::text AS platform,
  '@maralens'::text AS handle,
  'https://instagram.example.test/maralens'::text AS profile_url,
  82400::integer AS follower_count,
  4.2500::numeric AS engagement_rate,
  '["AT", "DE", "CH"]'::jsonb AS audience_countries,
  '["25-34", "35-44"]'::jsonb AS audience_age_groups,
  '{"female": 55, "male": 43, "unknown": 2}'::jsonb AS audience_gender_split,
  'verified'::text AS verification_status,
  '{"fixture": "marketplace", "audienceSnapshot": "platform-internal-approval-688"}'::jsonb AS platform_metadata,
  '2026-06-01T09:15:00Z'::timestamptz AS created_at,
  '2026-06-01T09:45:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.hotel_profiles AS
SELECT
  'f6883000-0000-0000-0000-000000000001'::uuid AS property_id,
  'f6882000-0000-0000-0000-000000000001'::uuid AS organization_id,
  'marketplace-hotel-profile-688'::text AS source_hotel_profile_id,
  'verified'::text AS marketplace_profile_status,
  TRUE::boolean AS profile_complete,
  '2026-06-01T11:00:00Z'::timestamptz AS profile_completed_at,
  'Family-run alpine boutique hotel with creator-friendly experiences.'::text AS host_summary,
  'Creators receive a private briefing before arrival.'::text AS collaboration_guidelines,
  '{"fixture": "marketplace", "privateOnboardingNote": "host-private-briefing-688"}'::jsonb AS marketplace_metadata,
  '2026-06-01T09:30:00Z'::timestamptz AS created_at,
  '2026-06-01T11:00:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.hotel_listings AS
SELECT
  'f6885000-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-hotel-profile-688'::text AS source_hotel_profile_id,
  'marketplace-listing-688'::text AS source_listing_id,
  'Alpine creator stay at Marketplace Alpenrose'::text AS title,
  'Two-night creator collaboration stay near Innsbruck.'::text AS listing_summary,
  'boutique_hotel'::text AS accommodation_type,
  'verified'::text AS listing_status,
  'public'::text AS visibility_status,
  'Innsbruck, Austria'::text AS raw_location_text,
  '{"countryCode": "AT", "region": "Tyrol", "city": "Innsbruck", "display": "Innsbruck, Austria", "mapDisplayMode": "approximate"}'::jsonb AS public_location,
  ARRAY[
    'https://cdn.example.test/marketplace/alpenrose-hero.jpg',
    'https://cdn.example.test/marketplace/alpenrose-room.jpg'
  ]::text[] AS image_urls,
  '{"fixture": "marketplace", "privateYieldTag": "yield-private-688"}'::jsonb AS listing_metadata,
  '{"marketplace": {"status": "fresh", "projectedAt": "2026-06-02T12:00:00Z"}}'::jsonb AS source_freshness,
  '2026-06-02T12:00:00Z'::timestamptz AS projected_at,
  '2026-06-01T09:35:00Z'::timestamptz AS created_at,
  '2026-06-01T11:05:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.listing_collaboration_offerings AS
SELECT
  'f6885100-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-listing-688'::text AS source_listing_id,
  'marketplace-offering-free-stay-688'::text AS source_offering_id,
  'free_stay'::text AS collaboration_type,
  ARRAY['June', 'September']::text[] AS availability_months,
  ARRAY['instagram', 'tiktok']::text[] AS platforms,
  2::integer AS free_stay_min_nights,
  4::integer AS free_stay_max_nights,
  NULL::numeric AS paid_max_amount,
  NULL::integer AS discount_percentage,
  NULL::numeric AS commission_percentage,
  50000::integer AS min_followers,
  'EUR'::char(3) AS currency,
  'Hosted stay for public content deliverables.'::text AS terms_summary,
  '{"fixture": "marketplace"}'::jsonb AS offering_metadata,
  1::integer AS public_sort_order,
  '2026-06-01T09:40:00Z'::timestamptz AS created_at,
  '2026-06-01T09:50:00Z'::timestamptz AS updated_at
UNION ALL
SELECT
  'f6885100-0000-0000-0000-000000000002'::uuid,
  'marketplace-listing-688'::text,
  'marketplace-offering-affiliate-688'::text,
  'affiliate'::text,
  ARRAY['June', 'July', 'August']::text[],
  ARRAY['instagram']::text[],
  NULL::integer,
  NULL::integer,
  NULL::numeric,
  NULL::integer,
  10.0000::numeric,
  50000::integer,
  'EUR'::char(3),
  'Affiliate collaboration with private tracking handled off the public listing.'::text,
  '{"fixture": "marketplace", "commissionRuleId": "f6887000-0000-0000-0000-000000000001"}'::jsonb,
  2::integer,
  '2026-06-01T09:42:00Z'::timestamptz,
  '2026-06-01T09:52:00Z'::timestamptz
UNION ALL
SELECT
  'f6885100-0000-0000-0000-000000000003'::uuid,
  'marketplace-listing-688'::text,
  'marketplace-offering-paid-688'::text,
  'paid'::text,
  ARRAY['October']::text[],
  ARRAY['youtube']::text[],
  NULL::integer,
  NULL::integer,
  750.00::numeric,
  NULL::integer,
  NULL::numeric,
  25000::integer,
  'EUR'::char(3),
  'Paid collaboration up to EUR 750.'::text,
  '{"fixture": "marketplace", "kind": "paid"}'::jsonb,
  3::integer,
  '2026-06-01T09:43:00Z'::timestamptz,
  '2026-06-01T09:53:00Z'::timestamptz
UNION ALL
SELECT
  'f6885100-0000-0000-0000-000000000004'::uuid,
  'marketplace-listing-688'::text,
  'marketplace-offering-discount-688'::text,
  'discount'::text,
  ARRAY['November']::text[],
  ARRAY['blog']::text[],
  NULL::integer,
  NULL::integer,
  NULL::numeric,
  25::integer,
  NULL::numeric,
  10000::integer,
  'EUR'::char(3),
  'Discounted stay at 25 percent off.'::text,
  '{"fixture": "marketplace", "kind": "discount"}'::jsonb,
  4::integer,
  '2026-06-01T09:44:00Z'::timestamptz,
  '2026-06-01T09:54:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.listing_creator_requirements AS
SELECT
  'f6885200-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-listing-688'::text AS source_listing_id,
  'marketplace-requirement-688'::text AS source_requirement_id,
  ARRAY['instagram', 'tiktok']::text[] AS platforms,
  ARRAY['AT', 'DE', 'CH']::text[] AS target_countries,
  25::integer AS target_age_min,
  44::integer AS target_age_max,
  ARRAY['25-34', '35-44']::text[] AS target_age_groups,
  ARRAY['travel', 'lifestyle']::text[] AS creator_types,
  '{"fixture": "marketplace"}'::jsonb AS requirement_metadata,
  '2026-06-01T09:45:00Z'::timestamptz AS created_at,
  '2026-06-01T09:55:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.collaborations AS
SELECT
  'f6886000-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-listing-688'::text AS source_listing_id,
  'marketplace-commission-rule-688'::text AS source_commission_rule_id,
  'marketplace-collaboration-688'::text AS source_collaboration_id,
  'creator'::text AS initiator_type,
  'accepted'::text AS lifecycle_status,
  'affiliate'::text AS collaboration_type,
  'PRIVATE_CREATOR_APPLICATION_688'::text AS application_message,
  '{"creatorFee": "10.0000", "privateComp": "creatorSecretRate", "briefing": "private-negotiated-terms-688"}'::jsonb AS negotiated_terms,
  '[{"platform": "instagram", "type": "reel", "quantity": 1}, {"platform": "tiktok", "type": "story", "quantity": 2}]'::jsonb AS platform_deliverables,
  ARRAY['June']::text[] AS preferred_months,
  '2026-06-20'::date AS travel_date_from,
  '2026-06-23'::date AS travel_date_to,
  '2026-06-20'::date AS preferred_date_from,
  '2026-06-23'::date AS preferred_date_to,
  2::integer AS free_stay_min_nights,
  3::integer AS free_stay_max_nights,
  NULL::numeric AS paid_amount,
  NULL::integer AS discount_percentage,
  10.0000::numeric AS creator_fee,
  'EUR'::char(3) AS currency,
  'AFF-PRIVATE-688'::text AS affiliate_referral_code,
  'https://private.example.test/aff-688'::text AS affiliate_link,
  TRUE::boolean AS creator_consent,
  '2026-06-02T10:00:00Z'::timestamptz AS hotel_agreed_at,
  '2026-06-02T09:30:00Z'::timestamptz AS creator_agreed_at,
  '2026-06-02T10:00:00Z'::timestamptz AS term_last_updated_at,
  '2026-06-02T10:05:00Z'::timestamptz AS responded_at,
  NULL::timestamptz AS cancelled_at,
  NULL::timestamptz AS completed_at,
  '{"fixture": "marketplace"}'::jsonb AS collaboration_metadata,
  '2026-06-01T12:00:00Z'::timestamptz AS created_at,
  '2026-06-02T10:05:00Z'::timestamptz AS updated_at
UNION ALL
SELECT
  'f6886000-0000-0000-0000-000000000002'::uuid,
  'marketplace-creator-688'::text,
  'marketplace-listing-688'::text,
  NULL::text,
  'marketplace-collaboration-paid-688'::text,
  'hotel'::text,
  'completed'::text,
  'paid'::text,
  'Paid video proposal.'::text,
  '{"briefing": "paid-terms-688"}'::jsonb,
  '[{"platform": "youtube", "type": "video", "quantity": 1}]'::jsonb,
  ARRAY['October']::text[],
  '2026-10-10'::date,
  '2026-10-12'::date,
  '2026-10-09'::date,
  '2026-10-13'::date,
  NULL::integer,
  NULL::integer,
  625.00::numeric,
  NULL::integer,
  NULL::numeric,
  'EUR'::char(3),
  NULL::text,
  NULL::text,
  TRUE::boolean,
  '2026-09-02T10:00:00Z'::timestamptz,
  '2026-09-02T10:05:00Z'::timestamptz,
  '2026-09-02T10:05:00Z'::timestamptz,
  '2026-09-01T12:00:00Z'::timestamptz,
  NULL::timestamptz,
  '2026-10-13T12:00:00Z'::timestamptz,
  '{"fixture": "marketplace", "kind": "paid"}'::jsonb,
  '2026-09-01T09:00:00Z'::timestamptz,
  '2026-10-13T12:00:00Z'::timestamptz
UNION ALL
SELECT
  'f6886000-0000-0000-0000-000000000003'::uuid,
  'marketplace-creator-688'::text,
  'marketplace-listing-688'::text,
  NULL::text,
  'marketplace-collaboration-discount-688'::text,
  'creator'::text,
  'cancelled'::text,
  'discount'::text,
  'Discounted stay proposal.'::text,
  '{"briefing": "discount-terms-688"}'::jsonb,
  '[{"platform": "blog", "type": "article", "quantity": 1}]'::jsonb,
  ARRAY['November']::text[],
  '2026-11-10'::date,
  '2026-11-13'::date,
  '2026-11-09'::date,
  '2026-11-14'::date,
  NULL::integer,
  NULL::integer,
  NULL::numeric,
  30::integer,
  NULL::numeric,
  'EUR'::char(3),
  NULL::text,
  NULL::text,
  TRUE::boolean,
  NULL::timestamptz,
  NULL::timestamptz,
  '2026-10-02T10:05:00Z'::timestamptz,
  '2026-10-02T10:00:00Z'::timestamptz,
  '2026-10-03T08:00:00Z'::timestamptz,
  NULL::timestamptz,
  '{"fixture": "marketplace", "kind": "discount"}'::jsonb,
  '2026-10-01T09:00:00Z'::timestamptz,
  '2026-10-03T08:00:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.creator_ratings AS
SELECT
  'f6886200-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-collaboration-688'::text AS source_collaboration_id,
  5::integer AS rating,
  'Excellent collaboration; internal rating note stays private.'::text AS comment,
  'f6881000-0000-0000-0000-000000000001'::uuid AS created_by_user_id,
  '2026-06-25T10:00:00Z'::timestamptz AS created_at,
  '2026-06-25T10:00:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.collaboration_deliverables AS
SELECT
  'f6886100-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-collaboration-688'::text AS source_collaboration_id,
  'instagram'::text AS platform,
  'reel'::text AS deliverable_type,
  1::integer AS quantity,
  'approved'::text AS deliverable_status,
  '2026-06-24T12:00:00Z'::timestamptz AS due_at,
  '2026-06-23T18:00:00Z'::timestamptz AS submitted_at,
  '2026-06-24T09:00:00Z'::timestamptz AS completed_at,
  'https://content.example.test/reel-688'::text AS content_url,
  'Approved for publication.'::text AS review_notes,
  '{"fixture": "marketplace"}'::jsonb AS deliverable_metadata,
  '2026-06-02T10:10:00Z'::timestamptz AS created_at,
  '2026-06-24T09:00:00Z'::timestamptz AS updated_at
UNION ALL
SELECT
  'f6886100-0000-0000-0000-000000000002'::uuid,
  'marketplace-collaboration-688'::text,
  'tiktok'::text,
  'story'::text,
  2::integer,
  'submitted'::text,
  '2026-06-24T12:00:00Z'::timestamptz,
  '2026-06-23T19:00:00Z'::timestamptz,
  NULL::timestamptz,
  'https://content.example.test/story-688'::text,
  'Awaiting final hotel approval.'::text,
  '{"fixture": "marketplace"}'::jsonb,
  '2026-06-02T10:11:00Z'::timestamptz,
  '2026-06-23T19:00:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.chat_messages AS
SELECT
  'f6886300-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-collaboration-688'::text AS source_collaboration_id,
  'f6881000-0000-0000-0000-000000000002'::uuid AS sender_user_id,
  'creator'::text AS sender_type,
  'text'::text AS message_type,
  'PRIVATE_CREATOR_CHAT_688'::text AS body,
  '{"fixture": "marketplace", "thread": "creator-private-thread-688"}'::jsonb AS message_metadata,
  '2026-06-02T10:20:00Z'::timestamptz AS read_at,
  '2027-06-23'::date AS pii_retention_until,
  '2026-06-02T10:15:00Z'::timestamptz AS created_at
UNION ALL
SELECT
  'f6886300-0000-0000-0000-000000000002'::uuid,
  'marketplace-collaboration-688'::text,
  'f6881000-0000-0000-0000-000000000001'::uuid,
  'hotel'::text,
  'text'::text,
  'PRIVATE_HOTEL_CHAT_688'::text,
  '{"fixture": "marketplace", "thread": "hotel-private-thread-688"}'::jsonb,
  NULL::timestamptz,
  '2027-06-23'::date,
  '2026-06-02T10:16:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.trips AS
SELECT
  'f6886400-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-trip-688'::text AS source_trip_id,
  'June Alpine Content Trip'::text AS name,
  'Tyrol, Austria'::text AS location_text,
  '2026-06-20'::date AS start_date,
  '2026-06-27'::date AS end_date,
  'Creator-private itinerary details.'::text AS notes,
  '{"fixture": "marketplace"}'::jsonb AS trip_metadata,
  '2026-06-01T08:00:00Z'::timestamptz AS created_at,
  '2026-06-01T08:30:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.external_collaborations AS
SELECT
  'f6886500-0000-0000-0000-000000000001'::uuid AS id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-trip-688'::text AS source_trip_id,
  'marketplace-external-collaboration-688'::text AS source_external_collaboration_id,
  'External Vienna Campaign'::text AS title,
  'External Hotel Wien'::text AS hotel_name,
  'Vienna, Austria'::text AS location_text,
  'paid'::text AS collaboration_type,
  '2026-06-25'::date AS start_date,
  '2026-06-26'::date AS end_date,
  'One paid Instagram carousel.'::text AS deliverables_summary,
  'External private contract reference EXT-PRIVATE-688.'::text AS notes,
  '{"fixture": "marketplace"}'::jsonb AS external_metadata,
  '2026-06-01T08:45:00Z'::timestamptz AS created_at,
  '2026-06-01T08:55:00Z'::timestamptz AS updated_at;

CREATE TABLE migration_source_marketplace.notifications AS
SELECT
  'f6886600-0000-0000-0000-000000000001'::uuid AS id,
  'f6881000-0000-0000-0000-000000000002'::uuid AS recipient_user_id,
  'f6882000-0000-0000-0000-000000000002'::uuid AS organization_id,
  'collaboration.accepted'::text AS notification_type,
  'Collaboration accepted'::text AS title,
  'The hotel accepted your private collaboration terms.'::text AS body,
  '/marketplace/collaborations/f6886000-0000-0000-0000-000000000001'::text AS link_url,
  'collaboration'::text AS resource_type,
  'f6886000-0000-0000-0000-000000000001'::text AS resource_id,
  '{"fixture": "marketplace"}'::jsonb AS notification_metadata,
  NULL::timestamptz AS read_at,
  '2026-06-02T10:06:00Z'::timestamptz AS created_at
UNION ALL
SELECT
  'f6886600-0000-0000-0000-000000000002'::uuid,
  'f6881000-0000-0000-0000-000000000001'::uuid,
  'f6882000-0000-0000-0000-000000000001'::uuid,
  'creator.approved'::text,
  'Creator profile approved'::text,
  'Mara Lens is approved for the Marketplace Alpenrose listing.'::text,
  '/marketplace/creators/f6884000-0000-0000-0000-000000000001'::text,
  'creator_profile'::text,
  'f6884000-0000-0000-0000-000000000001'::text,
  '{"fixture": "marketplace"}'::jsonb,
  '2026-06-02T11:00:00Z'::timestamptz,
  '2026-06-02T10:30:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.invite_codes AS
SELECT
  'f6886700-0000-0000-0000-000000000001'::uuid AS id,
  'MARKET-688-CREATOR'::text AS code,
  'creator'::text AS invite_type,
  'pending'::text AS status,
  '{"fixture": "marketplace", "audience": "travel"}'::jsonb AS payload,
  'f6881000-0000-0000-0000-000000000003'::uuid AS created_by_user_id,
  NULL::uuid AS redeemed_by_user_id,
  'marketplace-creator-688'::text AS source_creator_id,
  'marketplace-hotel-profile-688'::text AS source_hotel_profile_id,
  NULL::timestamptz AS redeemed_at,
  '2026-07-01T00:00:00Z'::timestamptz AS expires_at,
  '2026-06-01T08:00:00Z'::timestamptz AS created_at
UNION ALL
SELECT
  'f6886700-0000-0000-0000-000000000002'::uuid,
  'MARKET-688-REDEEMED'::text,
  'creator'::text,
  'redeemed'::text,
  '{"fixture": "marketplace", "campaign": "summer"}'::jsonb,
  'f6881000-0000-0000-0000-000000000003'::uuid,
  'f6881000-0000-0000-0000-000000000002'::uuid,
  'marketplace-creator-688'::text,
  'marketplace-hotel-profile-688'::text,
  '2026-06-03T09:00:00Z'::timestamptz,
  '2026-07-01T00:00:00Z'::timestamptz,
  '2026-06-01T08:05:00Z'::timestamptz;

CREATE TABLE migration_source_marketplace.newsletter_preferences AS
SELECT
  'f6886800-0000-0000-0000-000000000001'::uuid AS id,
  'f6881000-0000-0000-0000-000000000002'::uuid AS user_id,
  'f6882000-0000-0000-0000-000000000002'::uuid AS organization_id,
  TRUE::boolean AS enabled,
  ARRAY['AT', 'DE']::text[] AS country_filter,
  'marketplace-newsletter-creator-688'::text AS source_preference_id,
  '2026-06-01T07:00:00Z'::timestamptz AS created_at,
  '2026-06-01T07:00:00Z'::timestamptz AS updated_at
UNION ALL
SELECT
  'f6886800-0000-0000-0000-000000000002'::uuid,
  'f6881000-0000-0000-0000-000000000001'::uuid,
  'f6882000-0000-0000-0000-000000000001'::uuid,
  FALSE::boolean,
  NULL::text[],
  'marketplace-newsletter-hotel-688'::text,
  '2026-06-01T07:05:00Z'::timestamptz,
  '2026-06-01T07:05:00Z'::timestamptz;
