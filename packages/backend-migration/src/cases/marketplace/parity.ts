import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type MarketplaceSliceCheck = NonNullable<ExpectedTarget["marketplaceChecks"]>["slices"][number];

function addMarketplaceFinding(
  findings: ParityFinding[],
  code: string,
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
  suggestedAction: string,
): void {
  findings.push({
    severity: "fail",
    code,
    owner: "Marketplace",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction,
  });
}

async function checkMarketplaceCoreSlice(
  client: pg.Client,
  check: MarketplaceSliceCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    creator_profile_id: string;
    creator_organization_id: string;
    creator_owner_user_id: string | null;
    source_creator_id: string | null;
    display_name: string | null;
    creator_profile_status: string;
    creator_profile_complete: boolean;
    creator_platform_id: string;
    platform: string;
    follower_count: number;
    hotel_profile_property_id: string;
    hotel_organization_id: string;
    source_hotel_profile_id: string | null;
    marketplace_profile_status: string;
    hotel_profile_complete: boolean;
    offer_id: string;
    source_offer_id: string | null;
    offer_status: string;
    accommodation_type: string | null;
    requirement_id: string;
    requirement_platforms: string[];
    requirement_countries: string[] | null;
    collaboration_id: string;
    source_collaboration_id: string | null;
    lifecycle_status: string;
    compensation_type: string | null;
    affiliate_enabled: boolean;
    affiliate_referral_code: string | null;
    creator_consent: boolean | null;
    collaboration_commission_rule_id: string | null;
    affiliate_commission_percentage: string | null;
    creator_rating_id: string;
    rating: number;
    commission_rule_id: string;
    commission_organization_id: string | null;
    commission_product: string;
    commission_status: string;
    commission_rate: string | null;
    read_model_offer_id: string;
    offer_public_id: string;
    canonical_slug: string;
    visibility_status: string;
    property_public_id: string;
    property_slug: string | null;
  }>(
    `SELECT
       creator.id::text AS creator_profile_id,
       creator.organization_id::text AS creator_organization_id,
       creator.owner_user_id::text AS creator_owner_user_id,
       creator.source_creator_id,
       creator.display_name,
       creator.profile_status AS creator_profile_status,
       creator.profile_complete AS creator_profile_complete,
       platform.id::text AS creator_platform_id,
       platform.platform,
       platform.follower_count,
       hotel_profile.property_id::text AS hotel_profile_property_id,
       hotel_profile.organization_id::text AS hotel_organization_id,
       hotel_profile.source_hotel_profile_id,
       hotel_profile.marketplace_profile_status,
       hotel_profile.profile_complete AS hotel_profile_complete,
       offer.id::text AS offer_id,
       offer.source_offer_id,
       offer.offer_status,
       offer.accommodation_type,
       requirement.id::text AS requirement_id,
       requirement.platforms AS requirement_platforms,
       requirement.target_countries AS requirement_countries,
       collaboration.id::text AS collaboration_id,
       collaboration.source_collaboration_id,
       collaboration.lifecycle_status,
       collaboration.compensation_type,
       collaboration.affiliate_enabled,
       collaboration.affiliate_referral_code,
       collaboration.creator_consent,
       collaboration.commission_rule_id::text AS collaboration_commission_rule_id,
       collaboration.affiliate_commission_percentage::text AS affiliate_commission_percentage,
       rating.id::text AS creator_rating_id,
       rating.rating,
       commission_rule.id::text AS commission_rule_id,
       commission_rule.organization_id::text AS commission_organization_id,
       commission_rule.product AS commission_product,
       commission_rule.status AS commission_status,
       commission_rule.percentage_rate::text AS commission_rate,
       read_model.offer_id::text AS read_model_offer_id,
       read_model.public_id AS offer_public_id,
       read_model.canonical_slug,
       read_model.visibility_status,
       property.public_id AS property_public_id,
       slug.slug AS property_slug
     FROM marketplace.creator_profiles creator
     JOIN marketplace.creator_platforms platform
       ON platform.id = $2
      AND platform.creator_profile_id = creator.id
      AND platform.organization_id = creator.organization_id
     JOIN marketplace.marketplace_hotel_profiles hotel_profile
       ON hotel_profile.property_id = $3
      AND hotel_profile.organization_id = $4
     JOIN marketplace.marketplace_offers offer
       ON offer.id = $5
      AND offer.property_id = hotel_profile.property_id
      AND offer.organization_id = hotel_profile.organization_id
     JOIN marketplace.offer_creator_requirements requirement
       ON requirement.id = $6
      AND requirement.offer_id = offer.id
      AND requirement.property_id = offer.property_id
      AND requirement.organization_id = offer.organization_id
     JOIN marketplace.collaborations collaboration
       ON collaboration.id = $7
      AND collaboration.creator_profile_id = creator.id
      AND collaboration.creator_organization_id = creator.organization_id
      AND collaboration.property_id = offer.property_id
      AND collaboration.hotel_organization_id = offer.organization_id
      AND collaboration.offer_id = offer.id
     JOIN marketplace.creator_ratings rating
       ON rating.id = $8
      AND rating.creator_profile_id = creator.id
      AND rating.creator_organization_id = creator.organization_id
      AND rating.property_id = offer.property_id
      AND rating.hotel_organization_id = offer.organization_id
      AND rating.collaboration_id = collaboration.id
     JOIN finance.commission_rules commission_rule
       ON commission_rule.id = $9
      AND commission_rule.id = collaboration.commission_rule_id
      AND commission_rule.organization_id = collaboration.hotel_organization_id
     JOIN marketplace.marketplace_offer_read_model read_model
       ON read_model.offer_id = offer.id
      AND read_model.property_id = offer.property_id
     JOIN hotel_catalog.properties property
       ON property.id = offer.property_id
     LEFT JOIN hotel_catalog.property_slugs slug
       ON slug.property_id = property.id
      AND slug.slug = $10
      AND slug.status = 'active'
     WHERE creator.id = $1`,
    [
      check.creatorProfileId,
      check.creatorPlatformId,
      check.propertyId,
      check.hotelOrganizationId,
      check.offerId,
      check.requirementId,
      check.collaborationId,
      check.creatorRatingId,
      check.commissionRuleId,
      check.offerSlug,
    ],
  );

  const row = result.rows[0];
  const actual = row
    ? {
        creatorProfileId: row.creator_profile_id,
        creatorOrganizationId: row.creator_organization_id,
        creatorOwnerUserId: row.creator_owner_user_id,
        sourceCreatorId: row.source_creator_id,
        displayName: row.display_name,
        creatorProfileStatus: row.creator_profile_status,
        creatorProfileComplete: row.creator_profile_complete,
        creatorPlatformId: row.creator_platform_id,
        platform: row.platform,
        platformFollowerCount: row.follower_count,
        propertyId: row.hotel_profile_property_id,
        hotelOrganizationId: row.hotel_organization_id,
        sourceHotelProfileId: row.source_hotel_profile_id,
        marketplaceProfileStatus: row.marketplace_profile_status,
        hotelProfileComplete: row.hotel_profile_complete,
        offerId: row.offer_id,
        sourceOfferId: row.source_offer_id,
        offerStatus: row.offer_status,
        accommodationType: row.accommodation_type,
        requirementId: row.requirement_id,
        requirementPlatforms: row.requirement_platforms,
        requirementCountries: row.requirement_countries,
        collaborationId: row.collaboration_id,
        sourceCollaborationId: row.source_collaboration_id,
        lifecycleStatus: row.lifecycle_status,
        compensationType: row.compensation_type,
        affiliateEnabled: row.affiliate_enabled,
        affiliateReferralCode: row.affiliate_referral_code,
        creatorConsent: row.creator_consent,
        collaborationCommissionRuleId: row.collaboration_commission_rule_id,
        affiliateCommissionPercentage: row.affiliate_commission_percentage,
        creatorRatingId: row.creator_rating_id,
        rating: row.rating,
        commissionRuleId: row.commission_rule_id,
        commissionOrganizationId: row.commission_organization_id,
        commissionProduct: row.commission_product,
        commissionStatus: row.commission_status,
        commissionRate: row.commission_rate,
        readModelOfferId: row.read_model_offer_id,
        offerPublicId: row.offer_public_id,
        offerSlug: row.canonical_slug,
        visibilityStatus: row.visibility_status,
        propertyPublicId: row.property_public_id,
        propertySlug: row.property_slug,
      }
    : null;

  const matches =
    actual &&
    actual.creatorProfileId === check.creatorProfileId &&
    actual.creatorOrganizationId === check.creatorOrganizationId &&
    actual.creatorOwnerUserId === check.creatorOwnerUserId &&
    actual.sourceCreatorId === check.sourceCreatorId &&
    actual.displayName === check.creatorDisplayName &&
    actual.creatorProfileStatus === "active" &&
    actual.creatorProfileComplete === true &&
    actual.creatorPlatformId === check.creatorPlatformId &&
    actual.platform === check.platform &&
    actual.platformFollowerCount === check.platformFollowerCount &&
    actual.propertyId === check.propertyId &&
    actual.hotelOrganizationId === check.hotelOrganizationId &&
    actual.sourceHotelProfileId === check.sourceHotelProfileId &&
    actual.marketplaceProfileStatus === "verified" &&
    actual.hotelProfileComplete === true &&
    actual.offerId === check.offerId &&
    actual.sourceOfferId === check.sourceOfferId &&
    actual.offerStatus === "verified" &&
    actual.accommodationType === "boutique_hotel" &&
    actual.requirementId === check.requirementId &&
    actual.requirementPlatforms.includes(check.platform) &&
    actual.requirementCountries?.includes("AT") &&
    actual.collaborationId === check.collaborationId &&
    actual.sourceCollaborationId === check.sourceCollaborationId &&
    actual.lifecycleStatus === check.lifecycleStatus &&
    actual.compensationType === check.compensationType &&
    actual.affiliateEnabled === true &&
    actual.affiliateReferralCode === check.affiliateReferralCode &&
    actual.creatorConsent === true &&
    actual.collaborationCommissionRuleId === check.commissionRuleId &&
    actual.affiliateCommissionPercentage === "10.0000" &&
    actual.creatorRatingId === check.creatorRatingId &&
    actual.rating === check.rating &&
    actual.commissionRuleId === check.commissionRuleId &&
    actual.commissionOrganizationId === check.hotelOrganizationId &&
    actual.commissionProduct === "marketplace" &&
    actual.commissionStatus === "active" &&
    actual.commissionRate === "10.0000" &&
    actual.readModelOfferId === check.offerId &&
    actual.offerPublicId === check.offerPublicId &&
    actual.offerSlug === check.offerSlug &&
    actual.visibilityStatus === check.visibilityStatus &&
    actual.propertySlug === check.offerSlug;

  if (!matches) {
    addMarketplaceFinding(
      findings,
      "MARKETPLACE_CORE_SLICE_MISMATCH",
      "marketplace.collaborations",
      `Expected marketplace creator/offer/collaboration slice ${check.collaborationId} was not found`,
      "Creator profile/platform, hotel profile/offer, requirement, collaboration, rating, commission rule, and public offer read model linked with stable IDs",
      actual ? JSON.stringify(actual) : "row missing",
      "Check marketplace fixture IDs, target foreign keys, and source ID preservation across the core marketplace tables.",
    );
  }
}

async function checkMarketplaceOwnershipLinks(
  client: pg.Client,
  check: MarketplaceSliceCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    has_hotel_owner_membership: boolean;
    has_creator_owner_membership: boolean;
    has_hotel_profile_link: boolean;
    has_marketplace_offer_link: boolean;
    has_creator_profile_link: boolean;
    has_hotel_profile_entitlement: boolean;
    has_marketplace_offer_entitlement: boolean;
    has_creator_profile_entitlement: boolean;
    has_hotel_profile_source: boolean;
    has_listing_source: boolean;
  }>(
    `SELECT
       EXISTS(
         SELECT 1
         FROM identity.organization_memberships membership
         WHERE membership.organization_id = $1
           AND membership.user_id = $8
           AND membership.status = 'active'
           AND membership.role_key = $9
           AND $9 = ANY(membership.workos_role_slugs)
       ) AS has_hotel_owner_membership,
       EXISTS(
         SELECT 1
         FROM identity.organization_memberships membership
         WHERE membership.organization_id = $4
           AND membership.user_id = $10
           AND membership.status = 'active'
           AND membership.role_key = $11
           AND $11 = ANY(membership.workos_role_slugs)
       ) AS has_creator_owner_membership,
       EXISTS(
         SELECT 1
         FROM identity.organization_resource_links link
         WHERE link.organization_id = $1
           AND link.product = 'marketplace'
           AND link.resource_type = 'hotel_profile'
           AND link.resource_id = ($2::uuid)::text
           AND link.relationship = 'owner'
           AND link.status = 'active'
       ) AS has_hotel_profile_link,
       EXISTS(
         SELECT 1
         FROM identity.organization_resource_links link
         WHERE link.organization_id = $1
           AND link.product = 'marketplace'
           AND link.resource_type = 'marketplace_offer'
           AND link.resource_id = $3
           AND link.relationship = 'owner'
           AND link.status = 'active'
       ) AS has_marketplace_offer_link,
       EXISTS(
         SELECT 1
         FROM identity.organization_resource_links link
         WHERE link.organization_id = $4
           AND link.product = 'marketplace'
           AND link.resource_type = 'creator_profile'
           AND link.resource_id = $5
           AND link.relationship = 'owner'
           AND link.status = 'active'
       ) AS has_creator_profile_link,
       EXISTS(
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = $1
           AND entitlement.product = 'marketplace'
           AND entitlement.entitlement_key = 'marketplace-hotel-profile'
           AND entitlement.status = 'active'
           AND entitlement.resource_product = 'marketplace'
           AND entitlement.resource_type = 'hotel_profile'
           AND entitlement.resource_id = ($2::uuid)::text
       ) AS has_hotel_profile_entitlement,
       EXISTS(
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = $1
           AND entitlement.product = 'marketplace'
           AND entitlement.entitlement_key = 'marketplace-offer'
           AND entitlement.status = 'active'
           AND entitlement.resource_product = 'marketplace'
           AND entitlement.resource_type = 'marketplace_offer'
           AND entitlement.resource_id = $3
       ) AS has_marketplace_offer_entitlement,
       EXISTS(
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = $4
           AND entitlement.product = 'marketplace'
           AND entitlement.entitlement_key = 'marketplace-creator-profile'
           AND entitlement.status = 'active'
           AND entitlement.resource_product = 'marketplace'
           AND entitlement.resource_type = 'creator_profile'
           AND entitlement.resource_id = $5
       ) AS has_creator_profile_entitlement,
       EXISTS(
         SELECT 1
         FROM hotel_catalog.property_source_links source
         WHERE source.property_id = $2::uuid
           AND source.source_system = 'marketplace'
           AND source.source_table = 'hotel_profiles'
           AND source.source_id = $6
           AND source.relationship = 'profile_input'
           AND source.status = 'active'
       ) AS has_hotel_profile_source,
       EXISTS(
         SELECT 1
         FROM hotel_catalog.property_source_links source
         WHERE source.property_id = $2::uuid
           AND source.source_system = 'marketplace'
           AND source.source_table = 'hotel_listings'
           AND source.source_id = $7
           AND source.relationship = 'listing_input'
           AND source.status = 'active'
       ) AS has_listing_source`,
    [
      check.hotelOrganizationId,
      check.propertyId,
      check.offerId,
      check.creatorOrganizationId,
      check.creatorProfileId,
      check.sourceHotelProfileId,
      check.sourceOfferId,
      check.hotelOwnerUserId,
      check.hotelOwnerRoleKey,
      check.creatorOwnerUserId,
      check.creatorOwnerRoleKey,
    ],
  );

  const row = result.rows[0];
  const matches =
    row.has_hotel_owner_membership &&
    row.has_creator_owner_membership &&
    row.has_hotel_profile_link &&
    row.has_marketplace_offer_link &&
    row.has_creator_profile_link &&
    row.has_hotel_profile_entitlement &&
    row.has_marketplace_offer_entitlement &&
    row.has_creator_profile_entitlement &&
    row.has_hotel_profile_source &&
    row.has_listing_source;

  if (!matches) {
    addMarketplaceFinding(
      findings,
      "MARKETPLACE_OWNERSHIP_LINK_MISMATCH",
      "identity.organization_resource_links",
      `Expected marketplace ownership/resource links for offer ${check.offerId} were not found`,
      "Active marketplace owner memberships, hotel profile, offer, and creator profile resource links plus scoped marketplace entitlements and catalog source links",
      JSON.stringify(row),
      "Check marketplace ownership backfill rows before accepting creator, hotel profile, or offer target rows.",
    );
  }
}

async function checkMarketplaceRelatedRows(
  client: pg.Client,
  check: MarketplaceSliceCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    compensation_option_count: string;
    has_free_stay_option: boolean;
    has_affiliate_option: boolean;
    deliverable_count: string;
    has_approved_deliverable: boolean;
    has_submitted_deliverable: boolean;
    chat_message_count: string;
    creator_chat_body: string | null;
    hotel_chat_body: string | null;
    notification_count: string;
    has_unread_notification: boolean;
    has_read_notification: boolean;
    invite_code_count: string;
    has_pending_invite: boolean;
    has_redeemed_invite: boolean;
    newsletter_preference_count: string;
    has_creator_newsletter: boolean;
    has_hotel_newsletter: boolean;
  }>(
    `SELECT
       (
         SELECT count(*)::text
         FROM marketplace.offer_compensation_options option
         WHERE option.offer_id = $1
           AND option.property_id = $2
           AND option.organization_id = $3
       ) AS compensation_option_count,
       EXISTS(
         SELECT 1
         FROM marketplace.offer_compensation_options option
         WHERE option.id = $4
           AND option.offer_id = $1
           AND option.compensation_type = 'free_stay'
           AND option.free_stay_min_nights = 2
           AND option.free_stay_max_nights = 4
           AND $5 = ANY(option.platforms)
       ) AS has_free_stay_option,
       EXISTS(
         SELECT 1
         FROM marketplace.offer_compensation_options option
         WHERE option.id = $6
           AND option.offer_id = $1
           AND option.compensation_type = 'affiliate'
           AND option.commission_percentage::text = '10.0000'
           AND option.min_followers = 50000
       ) AS has_affiliate_option,
       (
         SELECT count(*)::text
         FROM marketplace.collaboration_deliverables deliverable
         WHERE deliverable.collaboration_id = $7
           AND deliverable.property_id = $2
       ) AS deliverable_count,
       EXISTS(
         SELECT 1
         FROM marketplace.collaboration_deliverables deliverable
         WHERE deliverable.id = $8
           AND deliverable.collaboration_id = $7
           AND deliverable.platform = $5
           AND deliverable.deliverable_status = 'approved'
       ) AS has_approved_deliverable,
       EXISTS(
         SELECT 1
         FROM marketplace.collaboration_deliverables deliverable
         WHERE deliverable.id = $9
           AND deliverable.collaboration_id = $7
           AND deliverable.platform = 'tiktok'
           AND deliverable.deliverable_status = 'submitted'
       ) AS has_submitted_deliverable,
       (
         SELECT count(*)::text
         FROM marketplace.marketplace_chat_messages message
         WHERE message.collaboration_id = $7
           AND message.property_id = $2
       ) AS chat_message_count,
       (
         SELECT message.body
         FROM marketplace.marketplace_chat_messages message
         WHERE message.id = $10
           AND message.collaboration_id = $7
           AND message.sender_user_id = $11
           AND message.sender_type = 'creator'
       ) AS creator_chat_body,
       (
         SELECT message.body
         FROM marketplace.marketplace_chat_messages message
         WHERE message.id = $12
           AND message.collaboration_id = $7
           AND message.sender_user_id = $13
           AND message.sender_type = 'hotel'
       ) AS hotel_chat_body,
       (
         SELECT count(*)::text
         FROM marketplace.marketplace_notifications notification
         WHERE notification.recipient_user_id IN ($11, $13)
           AND notification.organization_id IN ($14, $3)
       ) AS notification_count,
       EXISTS(
         SELECT 1
         FROM marketplace.marketplace_notifications notification
         WHERE notification.id = $15
           AND notification.recipient_user_id = $11
           AND notification.organization_id = $14
           AND notification.resource_type = 'collaboration'
           AND notification.resource_id = ($7::uuid)::text
           AND notification.read_at IS NULL
       ) AS has_unread_notification,
       EXISTS(
         SELECT 1
         FROM marketplace.marketplace_notifications notification
         WHERE notification.id = $16
           AND notification.recipient_user_id = $13
           AND notification.organization_id = $3
           AND notification.resource_type = 'creator_profile'
           AND notification.resource_id = ($17::uuid)::text
           AND notification.read_at IS NOT NULL
       ) AS has_read_notification,
       (
         SELECT count(*)::text
         FROM marketplace.invite_codes invite
         WHERE invite.creator_profile_id = $17::uuid
           AND invite.creator_organization_id = $14
           AND invite.property_id = $2
       ) AS invite_code_count,
       EXISTS(
         SELECT 1
         FROM marketplace.invite_codes invite
         WHERE invite.id = $18
           AND invite.code = $19
           AND invite.status = 'pending'
           AND invite.redeemed_by_user_id IS NULL
       ) AS has_pending_invite,
       EXISTS(
         SELECT 1
         FROM marketplace.invite_codes invite
         WHERE invite.id = $20
           AND invite.code = $21
           AND invite.status = 'redeemed'
           AND invite.redeemed_by_user_id = $11
           AND invite.redeemed_at IS NOT NULL
       ) AS has_redeemed_invite,
       (
         SELECT count(*)::text
         FROM marketplace.newsletter_preferences preference
         WHERE preference.user_id IN ($11, $13)
       ) AS newsletter_preference_count,
       EXISTS(
         SELECT 1
         FROM marketplace.newsletter_preferences preference
         WHERE preference.id = $22
           AND preference.user_id = $11
           AND preference.organization_id = $14
           AND preference.enabled = TRUE
           AND 'AT' = ANY(preference.country_filter)
       ) AS has_creator_newsletter,
       EXISTS(
         SELECT 1
         FROM marketplace.newsletter_preferences preference
         WHERE preference.id = $23
           AND preference.user_id = $13
           AND preference.organization_id = $3
           AND preference.enabled = FALSE
       ) AS has_hotel_newsletter`,
    [
      check.offerId,
      check.propertyId,
      check.hotelOrganizationId,
      check.compensationOptionFreeStayId,
      check.platform,
      check.compensationOptionAffiliateId,
      check.collaborationId,
      check.deliverableApprovedId,
      check.deliverableSubmittedId,
      check.creatorChatMessageId,
      check.creatorOwnerUserId,
      check.hotelChatMessageId,
      check.hotelOwnerUserId,
      check.creatorOrganizationId,
      check.unreadNotificationId,
      check.readNotificationId,
      check.creatorProfileId,
      check.pendingInviteCodeId,
      check.pendingInviteCode,
      check.redeemedInviteCodeId,
      check.redeemedInviteCode,
      check.creatorNewsletterPreferenceId,
      check.hotelNewsletterPreferenceId,
    ],
  );

  const row = result.rows[0];
  const actual = {
    compensationOptionCount: parseInt(row.compensation_option_count, 10),
    hasFreeStayOption: row.has_free_stay_option,
    hasAffiliateOption: row.has_affiliate_option,
    deliverableCount: parseInt(row.deliverable_count, 10),
    hasApprovedDeliverable: row.has_approved_deliverable,
    hasSubmittedDeliverable: row.has_submitted_deliverable,
    chatMessageCount: parseInt(row.chat_message_count, 10),
    creatorChatBody: row.creator_chat_body,
    hotelChatBody: row.hotel_chat_body,
    notificationCount: parseInt(row.notification_count, 10),
    hasUnreadNotification: row.has_unread_notification,
    hasReadNotification: row.has_read_notification,
    inviteCodeCount: parseInt(row.invite_code_count, 10),
    hasPendingInvite: row.has_pending_invite,
    hasRedeemedInvite: row.has_redeemed_invite,
    newsletterPreferenceCount: parseInt(row.newsletter_preference_count, 10),
    hasCreatorNewsletter: row.has_creator_newsletter,
    hasHotelNewsletter: row.has_hotel_newsletter,
  };

  const matches =
    actual.compensationOptionCount === check.compensationOptionCount &&
    actual.hasFreeStayOption &&
    actual.hasAffiliateOption &&
    actual.deliverableCount === check.deliverableCount &&
    actual.hasApprovedDeliverable &&
    actual.hasSubmittedDeliverable &&
    actual.chatMessageCount === check.chatMessageCount &&
    actual.creatorChatBody === check.creatorChatBody &&
    actual.hotelChatBody === check.hotelChatBody &&
    actual.notificationCount === check.notificationCount &&
    actual.hasUnreadNotification &&
    actual.hasReadNotification &&
    actual.inviteCodeCount === check.inviteCodeCount &&
    actual.hasPendingInvite &&
    actual.hasRedeemedInvite &&
    actual.newsletterPreferenceCount === check.newsletterPreferenceCount &&
    actual.hasCreatorNewsletter &&
    actual.hasHotelNewsletter;

  if (!matches) {
    addMarketplaceFinding(
      findings,
      "MARKETPLACE_RELATED_ROW_MISMATCH",
      "marketplace.offer_compensation_options",
      `Expected marketplace related rows for offer ${check.offerId} were not found`,
      "Compensation option, deliverable, chat, notification, invite-code, and newsletter preference counts plus representative row state",
      JSON.stringify(actual),
      "Check related marketplace fixture rows and relationship preservation around the collaboration/offer slice.",
    );
  }
}

async function checkMarketplaceTrips(
  client: pg.Client,
  check: MarketplaceSliceCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    trip_id: string;
    trip_name: string;
    trip_creator_profile_id: string;
    trip_organization_id: string;
    external_collaboration_id: string;
    external_title: string;
    external_trip_id: string | null;
    external_creator_profile_id: string;
    external_organization_id: string;
  }>(
    `SELECT
       trip.id::text AS trip_id,
       trip.name AS trip_name,
       trip.creator_profile_id::text AS trip_creator_profile_id,
       trip.organization_id::text AS trip_organization_id,
       external.id::text AS external_collaboration_id,
       external.title AS external_title,
       external.trip_id::text AS external_trip_id,
       external.creator_profile_id::text AS external_creator_profile_id,
       external.organization_id::text AS external_organization_id
     FROM marketplace.trips trip
     JOIN marketplace.external_collaborations external
       ON external.id = $2
      AND external.trip_id = trip.id
      AND external.creator_profile_id = trip.creator_profile_id
      AND external.organization_id = trip.organization_id
     WHERE trip.id = $1
       AND trip.creator_profile_id = $3
       AND trip.organization_id = $4`,
    [
      check.tripId,
      check.externalCollaborationId,
      check.creatorProfileId,
      check.creatorOrganizationId,
    ],
  );

  const row = result.rows[0];
  const matches =
    row &&
    row.trip_id === check.tripId &&
    row.trip_name === check.tripName &&
    row.trip_creator_profile_id === check.creatorProfileId &&
    row.trip_organization_id === check.creatorOrganizationId &&
    row.external_collaboration_id === check.externalCollaborationId &&
    row.external_title === check.externalCollaborationTitle &&
    row.external_trip_id === check.tripId &&
    row.external_creator_profile_id === check.creatorProfileId &&
    row.external_organization_id === check.creatorOrganizationId;

  if (!matches) {
    addMarketplaceFinding(
      findings,
      "MARKETPLACE_TRIP_EXTERNAL_COLLABORATION_MISMATCH",
      "marketplace.external_collaborations",
      `Expected trip/external collaboration link ${check.externalCollaborationId} was not found`,
      "External collaboration linked to the same creator profile, creator organization, and trip",
      row ? JSON.stringify(row) : "row missing",
      "Check marketplace trip and external collaboration fixture rows for creator/trip relationship integrity.",
    );
  }
}

async function checkMarketplaceReadModelSafety(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenKeyResult = await client.query<{ offer_id: string }>(
    `SELECT offer_id::text
     FROM marketplace.marketplace_offer_read_model
     WHERE marketplace.jsonb_has_marketplace_private_key(location)
        OR marketplace.jsonb_has_marketplace_private_key(public_compensation_summary)
        OR marketplace.jsonb_has_marketplace_private_key(public_creator_requirements)
        OR marketplace.jsonb_has_marketplace_private_key(source_freshness)`,
  );

  for (const row of forbiddenKeyResult.rows) {
    addMarketplaceFinding(
      findings,
      "MARKETPLACE_PUBLIC_READ_MODEL_PRIVATE_KEY",
      "marketplace.marketplace_offer_read_model",
      `Marketplace offer read model ${row.offer_id} contains a private JSON key`,
      "No private marketplace, PII, ownership, chat, collaboration, invite, or affiliate tracking keys in public JSON",
      row.offer_id,
      "Filter private fields before projecting marketplace offer read models.",
    );
  }

  const forbiddenValues = expected.marketplaceChecks?.forbiddenPublicReadModelValues ?? [];
  if (forbiddenValues.length === 0) return;

  const publicRows = await client.query<{ offer_id: string; public_surface: string }>(
    `SELECT offer_id::text,
            concat_ws(
              ' ',
              public_id,
              canonical_slug,
              display_name,
              offer_title,
              offer_summary,
              accommodation_type,
              location::text,
              array_to_string(image_urls, ' '),
              public_compensation_summary::text,
              public_creator_requirements::text,
              source_freshness::text
            ) AS public_surface
     FROM marketplace.marketplace_offer_read_model`,
  );

  for (const row of publicRows.rows) {
    const matchedValue = forbiddenValues.find((value) => row.public_surface.includes(value));
    if (!matchedValue) continue;

    addMarketplaceFinding(
      findings,
      "MARKETPLACE_PUBLIC_READ_MODEL_PRIVATE_VALUE",
      "marketplace.marketplace_offer_read_model",
      `Marketplace offer read model ${row.offer_id} contains private value ${matchedValue}`,
      "No private chat text, creator PII, invite codes, affiliate tracking refs, or negotiated terms in public offer read models",
      matchedValue,
      "Keep private marketplace state in marketplace tables and project only public-safe offer fields.",
    );
  }
}

async function checkMarketplaceFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.marketplaceChecks;
  if (!checks) return;

  for (const check of checks.slices) {
    await checkMarketplaceCoreSlice(client, check, findings);
    await checkMarketplaceOwnershipLinks(client, check, findings);
    await checkMarketplaceRelatedRows(client, check, findings);
    await checkMarketplaceTrips(client, check, findings);
  }

  await checkMarketplaceReadModelSafety(client, expected, findings);
}

export async function checkMarketplaceParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkMarketplaceFixtures(client, expected, findings);
}
