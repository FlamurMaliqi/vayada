import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  bool,
  currency,
  date,
  integer,
  iso,
  money,
  optionalArray,
  optionalDate,
  optionalIso,
  optionalObject,
  optionalText,
  requiredText,
  sha256,
  uuid,
} from "./productionBookingValues.js";
import {
  block,
  collaborationScope,
  creatorOrganization,
  hotelScope,
  offerScope,
  optionalUser,
  requireUser,
  resourceLinkFor,
  sourceIdentity,
} from "./productionMarketplaceContext.js";
import type {
  MarketplaceBuildContext,
  MarketplaceMediaReference,
  MarketplaceTargetRecord,
} from "./productionMarketplaceTypes.js";

export function buildMarketplaceRecords(
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const builders: Record<
    string,
    (row: IdentitySourceRow, context: MarketplaceBuildContext) => MarketplaceTargetRecord[]
  > = {
    creators: buildCreator,
    creator_platforms: buildCreatorPlatform,
    hotel_profiles: buildHotelProfile,
    hotel_listings: buildOffer,
    listing_collaboration_offerings: buildCompensation,
    listing_creator_requirements: buildRequirement,
    collaborations: buildCollaboration,
    creator_ratings: buildRating,
    collaboration_deliverables: buildDeliverable,
    chat_messages: buildChatMessage,
    trips: buildTrip,
    external_collaborations: buildExternalCollaboration,
    notifications: buildNotification,
    invite_codes: buildInvite,
    newsletter_preferences: buildNewsletter,
  };
  const records: MarketplaceTargetRecord[] = [];
  for (const row of context.rows) {
    try {
      const builder = builders[row.sourceTable];
      if (!builder) throw new Error("Source table is not supported");
      records.push(...builder(row, context));
    } catch (error) {
      block(
        context,
        "INVALID_SOURCE_ROW",
        `marketplace.${row.sourceTable}`,
        safeSourceId(row),
        error instanceof Error ? error.message : "Marketplace source row is invalid",
      );
    }
  }
  return records;
}

function buildCreator(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const organizationId = creatorOrganization(context, id);
  const ownerUserId = requireUser(context, source.data["user_id"], "user_id");
  const updatedAt = timestamp(source);
  const picture = optionalText(source.data["profile_picture"], "profile_picture");
  return [
    record(source, "creator_profiles", id, updatedAt, {
      id,
      organizationId,
      ownerUserId,
      sourceSystem: "migration",
      sourceCreatorId: id,
      displayName: context.userNameById.get(ownerUserId) ?? null,
      creatorType: mapCreatorType(source.data["creator_type"]),
      locationText: optionalText(source.data["location"], "location"),
      shortDescription: optionalText(source.data["short_description"], "short_description"),
      portfolioUrl: optionalText(source.data["portfolio_link"], "portfolio_link"),
      phone: optionalText(source.data["phone"], "phone"),
      profilePictureUrl: picture
        ? resolvePublicMedia(context, picture, "creators", id, "profile_picture")
        : null,
      profileComplete: bool(source.data["profile_complete"], "profile_complete"),
      profileCompletedAt: optionalIso(source.data["profile_completed_at"], "profile_completed_at"),
      profileStatus: mapOwnerStatus(
        resourceLinkFor(context.target.resourceLinks, "creator_profile", id)?.status,
      ),
      profileMetadata: { legacySource: "marketplace.creators" },
      piiRetentionUntil: retentionDate(context.completedAt),
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildCreatorPlatform(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const creatorId = uuid(source.data["creator_id"], "creator_id");
  const organizationId = creatorOrganization(context, creatorId);
  const platform = mapPlatform(source.data["name"]);
  const handle = requiredText(source.data["handle"], "handle");
  const updatedAt = timestamp(source);
  return [
    record(source, "creator_platforms", id, updatedAt, {
      id,
      creatorProfileId: creatorId,
      organizationId,
      sourceSystem: "migration",
      sourcePlatformId: id,
      platform,
      handle,
      profileUrl: socialProfileUrl(platform, handle),
      followerCount: nonNegativeInteger(source.data["followers"], "followers"),
      engagementRate: nonNegativeDecimal(source.data["engagement_rate"], "engagement_rate"),
      audienceCountries: audiencePercentages(source.data["top_countries"], "country"),
      audienceAgeGroups: audiencePercentages(source.data["top_age_groups"], "ageRange"),
      audienceGenderSplit: audienceGenderSplit(source.data["gender_split"]),
      verificationStatus: "unverified",
      platformMetadata: { legacySource: "marketplace.creator_platforms" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildHotelProfile(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const { propertyId, organizationId } = hotelScope(context, id);
  requireUser(context, source.data["user_id"], "user_id");
  const ownerStatus = mapOwnerStatus(
    resourceLinkFor(context.target.resourceLinks, "hotel_profile", id)?.status,
  );
  const sourceStatus = mapHotelStatus(source.data["status"]);
  const updatedAt = timestamp(source);
  return [
    record(source, "marketplace_hotel_profiles", propertyId, updatedAt, {
      propertyId,
      organizationId,
      sourceSystem: "migration",
      sourceHotelProfileId: id,
      marketplaceProfileStatus: ownerStatus === "active" ? sourceStatus : ownerStatus,
      profileComplete: bool(source.data["profile_complete"], "profile_complete"),
      profileCompletedAt: optionalIso(source.data["profile_completed_at"], "profile_completed_at"),
      hostSummary: optionalText(source.data["about"], "about"),
      collaborationGuidelines: null,
      marketplaceMetadata: {
        legacySource: "marketplace.hotel_profiles",
        legacySourceStatus: sourceStatus,
        ownerStatus,
        website: optionalText(source.data["website"], "website"),
        phone: optionalText(source.data["phone"], "phone"),
      },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildOffer(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const hotelProfileId = uuid(source.data["hotel_profile_id"], "hotel_profile_id");
  const { propertyId, organizationId } = hotelScope(context, hotelProfileId);
  const hotelProfile = context.hotelById.get(hotelProfileId)!;
  const hotelStatus = mapHotelStatus(hotelProfile.data["status"]);
  const ownerStatus = mapOwnerStatus(
    resourceLinkFor(context.target.resourceLinks, "hotel_profile", hotelProfileId)?.status,
  );
  const updatedAt = timestamp(source);
  const images = stringArray(source.data["images"], "images").map((url, index) =>
    resolvePublicMedia(context, url, "hotel_listings", id, `images[${index}]`),
  );
  const status = mapOfferStatus(source.data["status"]);
  const offer = record(source, "marketplace_offers", id, updatedAt, {
    id,
    propertyId,
    organizationId,
    sourceSystem: "migration",
    sourceOfferId: id,
    title: requiredText(source.data["name"], "name"),
    offerSummary: requiredText(source.data["description"], "description"),
    accommodationType: mapAccommodation(source.data["accommodation_type"]),
    offerStatus: ownerStatus === "active" ? status : ownerStatus,
    rawLocationText: requiredText(source.data["location"], "location"),
    imageUrls: images,
    offerMetadata: {
      legacySource: "marketplace.hotel_listings",
      legacySourceStatus: status,
      ownerQuarantined: ownerStatus === "archived",
    },
    createdAt: iso(source.data["created_at"], "created_at"),
    updatedAt,
  });
  if (ownerStatus === "archived") return [offer];
  const publicProperty = context.publicPropertyById.get(propertyId);
  if (!publicProperty)
    throw new Error(`property ${propertyId} has no accepted public catalog projection`);
  const offerings = (context.rowsByTable.get("listing_collaboration_offerings") ?? []).filter(
    (row) => String(row.data["listing_id"] ?? "").toLowerCase() === id,
  );
  const requirements = (context.rowsByTable.get("listing_creator_requirements") ?? []).filter(
    (row) => String(row.data["listing_id"] ?? "").toLowerCase() === id,
  );
  if (requirements.length > 1) throw new Error("listing has multiple creator requirements");
  const requirement = requirements[0];
  const readModel = record(source, "marketplace_offer_read_model", id, updatedAt, {
    offerId: id,
    propertyId,
    publicId: id,
    canonicalSlug: publicProperty.canonicalSlug,
    displayName: publicProperty.displayName,
    offerTitle: requiredText(source.data["name"], "name"),
    offerSummary: requiredText(source.data["description"], "description"),
    accommodationType: mapAccommodation(source.data["accommodation_type"]),
    visibilityStatus: mapVisibility(status, hotelStatus, ownerStatus),
    location: publicProperty.location,
    imageUrls: images,
    publicCompensationSummary: offerings
      .map((row) => publicCompensation(row))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    publicCreatorRequirements: requirement ? publicRequirements(requirement) : {},
    sourceFreshness: {
      source: "marketplace.hotel_listings",
      sourceRunId: context.sourceRunId,
      updatedAt,
    },
    projectedAt: updatedAt,
  });
  return [offer, readModel];
}

function buildCompensation(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const { offer, propertyId, organizationId } = offerScope(context, source.data["listing_id"]);
  const offerId = uuid(offer.data["id"], "listing_id");
  const compensationType = mapCompensation(source.data["collaboration_type"]);
  const updatedAt = timestamp(source);
  return [
    record(source, "offer_compensation_options", id, updatedAt, {
      id,
      offerId,
      propertyId,
      organizationId,
      sourceSystem: "migration",
      sourceCompensationOptionId: id,
      compensationType,
      availabilityMonths: stringArray(source.data["availability_months"], "availability_months"),
      platforms: stringArray(source.data["platforms"], "platforms").map(mapPlatform),
      freeStayMinNights: optionalInteger(
        source.data["free_stay_min_nights"],
        "free_stay_min_nights",
      ),
      freeStayMaxNights: optionalInteger(
        source.data["free_stay_max_nights"],
        "free_stay_max_nights",
      ),
      paidMaxAmount: optionalMoney(source.data["paid_max_amount"], "paid_max_amount"),
      discountPercentage: optionalInteger(
        source.data["discount_percentage"],
        "discount_percentage",
      ),
      commissionPercentage: optionalMoney(
        source.data["commission_percentage"],
        "commission_percentage",
      ),
      minFollowers: optionalInteger(source.data["min_followers"], "min_followers"),
      currency: currency(source.data["currency"], "currency"),
      termsSummary: null,
      compensationMetadata: { legacySource: "marketplace.listing_collaboration_offerings" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildRequirement(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const { offer, propertyId, organizationId } = offerScope(context, source.data["listing_id"]);
  const updatedAt = timestamp(source);
  return [
    record(source, "offer_creator_requirements", id, updatedAt, {
      id,
      offerId: uuid(offer.data["id"], "listing_id"),
      propertyId,
      organizationId,
      sourceSystem: "migration",
      sourceRequirementId: id,
      platforms: stringArray(source.data["platforms"], "platforms").map(mapPlatform),
      targetCountries: nullableStringArray(source.data["target_countries"], "target_countries"),
      targetAgeMin: optionalInteger(source.data["target_age_min"], "target_age_min"),
      targetAgeMax: optionalInteger(source.data["target_age_max"], "target_age_max"),
      targetAgeGroups: stringArray(source.data["target_age_groups"], "target_age_groups"),
      creatorTypes: stringArray(source.data["creator_types"], "creator_types").map(mapCreatorType),
      requirementMetadata: { legacySource: "marketplace.listing_creator_requirements" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildCollaboration(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const scope = collaborationScope(context, id);
  const initiatorType = requiredText(source.data["initiator_type"], "initiator_type").toLowerCase();
  if (!["creator", "hotel"].includes(initiatorType))
    throw new Error("initiator_type is unsupported");
  const creatorConsent =
    source.data["consent"] == null ? null : bool(source.data["consent"], "consent");
  if (initiatorType === "creator" && creatorConsent !== true)
    throw new Error("creator-initiated collaboration lacks explicit creator consent");
  const rawType = mapCompensation(source.data["collaboration_type"]);
  const affiliateEnabled =
    rawType === "affiliate" ||
    optionalText(source.data["affiliate_referral_code"], "affiliate_referral_code") !== null ||
    optionalText(source.data["affiliate_link"], "affiliate_link") !== null;
  const updatedAt = timestamp(source);
  return [
    record(source, "collaborations", id, updatedAt, {
      id,
      creatorProfileId: scope.creatorId,
      creatorOrganizationId: scope.creatorOrganizationId,
      propertyId: scope.propertyId,
      hotelOrganizationId: scope.hotelOrganizationId,
      offerId: scope.offerId,
      commissionRuleId: null,
      sourceSystem: "migration",
      sourceCollaborationId: id,
      initiatorType,
      lifecycleStatus: mapCollaborationStatus(source.data["status"]),
      compensationType: rawType === "affiliate" ? null : rawType,
      applicationMessage: optionalText(source.data["why_great_fit"], "why_great_fit"),
      negotiatedTerms: {},
      platformDeliverables: {},
      preferredMonths: stringArray(source.data["preferred_months"], "preferred_months"),
      travelDateFrom: optionalDate(source.data["travel_date_from"], "travel_date_from"),
      travelDateTo: optionalDate(source.data["travel_date_to"], "travel_date_to"),
      preferredDateFrom: optionalDate(source.data["preferred_date_from"], "preferred_date_from"),
      preferredDateTo: optionalDate(source.data["preferred_date_to"], "preferred_date_to"),
      freeStayMinNights: optionalInteger(
        source.data["free_stay_min_nights"],
        "free_stay_min_nights",
      ),
      freeStayMaxNights: optionalInteger(
        source.data["free_stay_max_nights"],
        "free_stay_max_nights",
      ),
      paidAmount: optionalMoney(source.data["paid_amount"], "paid_amount"),
      discountPercentage: optionalInteger(
        source.data["discount_percentage"],
        "discount_percentage",
      ),
      affiliateCommissionPercentage: optionalMoney(source.data["creator_fee"], "creator_fee"),
      affiliateEnabled,
      currency: currency(source.data["currency"], "currency"),
      affiliateReferralCode: optionalText(
        source.data["affiliate_referral_code"],
        "affiliate_referral_code",
      ),
      affiliateLink: optionalText(source.data["affiliate_link"], "affiliate_link"),
      creatorConsent,
      hotelAgreedAt: optionalIso(source.data["hotel_agreed_at"], "hotel_agreed_at"),
      creatorAgreedAt: optionalIso(source.data["creator_agreed_at"], "creator_agreed_at"),
      termLastUpdatedAt: optionalIso(source.data["term_last_updated_at"], "term_last_updated_at"),
      respondedAt: optionalIso(source.data["responded_at"], "responded_at"),
      cancelledAt: optionalIso(source.data["cancelled_at"], "cancelled_at"),
      completedAt: optionalIso(source.data["completed_at"], "completed_at"),
      collaborationMetadata: { legacySource: "marketplace.collaborations" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildRating(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const creatorId = uuid(source.data["creator_id"], "creator_id");
  const creatorOrganizationId = creatorOrganization(context, creatorId);
  const hotel = hotelScope(context, source.data["hotel_id"]);
  const collaborationId = source.data["collaboration_id"]
    ? uuid(source.data["collaboration_id"], "collaboration_id")
    : null;
  if (collaborationId) {
    const collaboration = collaborationScope(context, collaborationId);
    if (
      collaboration.creatorId !== creatorId ||
      collaboration.propertyId !== hotel.propertyId ||
      collaboration.hotelOrganizationId !== hotel.organizationId
    )
      throw new Error("rating ownership disagrees with its collaboration");
  }
  const updatedAt = timestamp(source);
  return [
    record(source, "creator_ratings", id, updatedAt, {
      id,
      creatorProfileId: creatorId,
      creatorOrganizationId,
      propertyId: hotel.propertyId,
      hotelOrganizationId: hotel.organizationId,
      collaborationId,
      rating: boundedInteger(source.data["rating"], "rating", 1, 5),
      comment: optionalText(source.data["comment"], "comment"),
      createdByUserId: null,
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildDeliverable(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const scope = collaborationScope(context, source.data["collaboration_id"]);
  const updatedAt = timestamp(source);
  const status = requiredText(source.data["status"], "status").toLowerCase();
  if (!["pending", "completed"].includes(status))
    throw new Error("deliverable status is unsupported");
  return [
    record(source, "collaboration_deliverables", id, updatedAt, {
      id,
      collaborationId: uuid(source.data["collaboration_id"], "collaboration_id"),
      propertyId: scope.propertyId,
      platform: mapPlatform(source.data["platform"]),
      deliverableType: requiredText(source.data["type"], "type").toLowerCase(),
      quantity: positiveInteger(source.data["quantity"], "quantity"),
      deliverableStatus: status,
      dueAt: null,
      submittedAt: null,
      completedAt: status === "completed" ? updatedAt : null,
      contentUrl: null,
      reviewNotes: null,
      deliverableMetadata: { legacySource: "marketplace.collaboration_deliverables" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildChatMessage(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const scope = collaborationScope(context, source.data["collaboration_id"]);
  const createdAt = iso(source.data["created_at"], "created_at");
  const readAt = optionalIso(source.data["read_at"], "read_at");
  const messageType = requiredText(source.data["message_type"], "message_type").toLowerCase();
  if (!["text", "image", "system"].includes(messageType))
    throw new Error("message_type is unsupported");
  const retainedUntil = retentionTimestamp(createdAt);
  if (messageType === "image" && Date.parse(retainedUntil) <= Date.parse(context.completedAt))
    return [
      record(source, "marketplace_chat_messages", id, readAt ?? createdAt, {
        id,
        collaborationId: uuid(source.data["collaboration_id"], "collaboration_id"),
        propertyId: scope.propertyId,
        senderUserId: null,
        senderType: "migration",
        messageType: "system",
        body: "[expired legacy image attachment omitted]",
        messageMetadata: { attachmentSource: "legacy_retention_expired" },
        readAt,
        piiRetentionUntil: retainedUntil.slice(0, 10),
        createdAt,
      }),
    ];
  const sender = senderForMessage(context, scope, source.data["sender_id"], messageType);
  const sourceMetadata = { ...optionalObject(source.data["metadata"]) };
  let metadata = sourceMetadata;
  let body = requiredText(source.data["content"], "content");
  if (messageType === "image") {
    const legacyUrl = extractLegacyUrl(source.data["metadata"], body);
    const media = resolvePrivateMedia(context, legacyUrl, "chat_messages", id);
    metadata = {
      mediaObjectId: media.mediaObjectId,
      attachmentSource: "platform_media_migration",
    };
    body = "[image attachment migrated]";
  } else assertNoLegacyMedia(metadata, "message metadata");
  return [
    record(source, "marketplace_chat_messages", id, readAt ?? createdAt, {
      id,
      collaborationId: uuid(source.data["collaboration_id"], "collaboration_id"),
      propertyId: scope.propertyId,
      senderUserId: sender.userId,
      senderType: sender.type,
      messageType,
      body,
      messageMetadata: metadata,
      readAt,
      piiRetentionUntil: retainedUntil.slice(0, 10),
      createdAt,
    }),
  ];
}

function buildTrip(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const creatorId = uuid(source.data["creator_id"], "creator_id");
  const updatedAt = timestamp(source);
  return [
    record(source, "trips", id, updatedAt, {
      id,
      creatorProfileId: creatorId,
      organizationId: creatorOrganization(context, creatorId),
      sourceSystem: "migration",
      sourceTripId: id,
      name: requiredText(source.data["name"], "name"),
      locationText: optionalText(source.data["location"], "location"),
      startDate: date(source.data["start_date"], "start_date"),
      endDate: date(source.data["end_date"], "end_date"),
      notes: optionalText(source.data["notes"], "notes"),
      tripMetadata: { legacySource: "marketplace.trips" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildExternalCollaboration(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const creatorId = uuid(source.data["creator_id"], "creator_id");
  const tripId = source.data["trip_id"] ? uuid(source.data["trip_id"], "trip_id") : null;
  if (tripId) {
    const trip = context.tripById.get(tripId);
    if (!trip || uuid(trip.data["creator_id"], "creator_id") !== creatorId)
      throw new Error("external collaboration trip ownership is invalid");
  }
  const updatedAt = timestamp(source);
  return [
    record(source, "external_collaborations", id, updatedAt, {
      id,
      creatorProfileId: creatorId,
      organizationId: creatorOrganization(context, creatorId),
      tripId,
      sourceSystem: "migration",
      sourceExternalCollaborationId: id,
      title: requiredText(source.data["title"], "title"),
      hotelName: optionalText(source.data["hotel_name"], "hotel_name"),
      locationText: optionalText(source.data["location"], "location"),
      collaborationType: mapExternalType(source.data["collaboration_type"]),
      startDate: date(source.data["start_date"], "start_date"),
      endDate: date(source.data["end_date"], "end_date"),
      deliverablesSummary: optionalText(source.data["deliverables"], "deliverables"),
      notes: optionalText(source.data["notes"], "notes"),
      externalMetadata: { legacySource: "marketplace.external_collaborations" },
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function buildNotification(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const createdAt = iso(source.data["created_at"], "created_at");
  const readAt = optionalIso(source.data["read_at"], "read_at");
  return [
    record(source, "marketplace_notifications", id, readAt ?? createdAt, {
      id,
      recipientUserId: requireUser(context, source.data["user_id"], "user_id"),
      organizationId: null,
      notificationType: requiredText(source.data["type"], "type"),
      title: requiredText(source.data["title"], "title"),
      body: requiredText(source.data["body"], "body"),
      linkUrl: optionalText(source.data["link_url"], "link_url"),
      resourceType: null,
      resourceId: null,
      notificationMetadata: { legacySource: "marketplace.notifications" },
      readAt,
      createdAt,
    }),
  ];
}

function buildInvite(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const createdAt = iso(source.data["created_at"], "created_at");
  const redeemedAt = optionalIso(source.data["redeemed_at"], "redeemed_at");
  const payload = requiredObject(source.data["data"], "data");
  assertNoLegacyMedia(payload, "invite payload");
  return [
    record(source, "invite_codes", id, redeemedAt ?? createdAt, {
      id,
      code: requiredText(source.data["code"], "code"),
      inviteType: "hotel",
      status: mapInviteStatus(source.data["status"]),
      payload,
      createdByUserId: optionalUser(context, source.data["created_by"], "created_by"),
      redeemedByUserId: optionalUser(context, source.data["redeemed_by"], "redeemed_by"),
      creatorProfileId: null,
      creatorOrganizationId: null,
      propertyId: null,
      redeemedAt,
      expiresAt: iso(source.data["expires_at"], "expires_at"),
      createdAt,
    }),
  ];
}

function buildNewsletter(
  source: IdentitySourceRow,
  context: MarketplaceBuildContext,
): MarketplaceTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const updatedAt = timestamp(source);
  return [
    record(source, "newsletter_preferences", id, updatedAt, {
      id,
      userId: requireUser(context, source.data["user_id"], "user_id"),
      organizationId: null,
      enabled: bool(source.data["enabled"], "enabled"),
      countryFilter: nullableStringArray(source.data["country_filter"], "country_filter"),
      sourceSystem: "migration",
      sourcePreferenceId: id,
      createdAt: iso(source.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function record(
  source: IdentitySourceRow,
  targetTable: string,
  targetId: string,
  sourceUpdatedAt: string,
  row: Record<string, unknown>,
): MarketplaceTargetRecord {
  return {
    targetProduct: "marketplace",
    targetTable,
    targetId,
    sourceDatabase: "marketplace",
    sourceTable: source.sourceTable,
    sourceId: sourceIdentity(source),
    sourceChecksum: sha256({ source: source.data, row }),
    sourceUpdatedAt,
    mutable: true,
    row,
  };
}

function resolvePublicMedia(
  context: MarketplaceBuildContext,
  sourceUrl: string,
  sourceTable: string,
  sourceId: string,
  field: string,
): string {
  const media = resolveMedia(context, sourceUrl, sourceTable, sourceId, field);
  if (
    media.visibility !== "public" ||
    media.lifecycleStatus !== "active" ||
    !media.publicApproved ||
    !media.publicUrl
  )
    throw new Error(`${field} has no approved active public VAY-1055 media variant`);
  const expected =
    sourceTable === "creators"
      ? { purpose: "marketplace.creator.profile_image", resourceType: "creator_profile" }
      : { purpose: "marketplace.offer.media", resourceType: "marketplace_offer" };
  if (
    media.purpose !== expected.purpose ||
    media.resourceType !== expected.resourceType ||
    media.resourceId !== sourceId
  )
    throw new Error(`${field} resolves to a VAY-1055 media object with the wrong resource scope`);
  if (looksLegacy(media.publicUrl)) throw new Error(`${field} still resolves to a legacy URL`);
  return media.publicUrl;
}

function resolvePrivateMedia(
  context: MarketplaceBuildContext,
  sourceUrl: string,
  sourceTable: string,
  sourceId: string,
): MarketplaceMediaReference {
  const media = resolveMedia(context, sourceUrl, sourceTable, sourceId, "image");
  if (media.visibility !== "private" || media.lifecycleStatus !== "active")
    throw new Error("image message has no active private VAY-1055 media object");
  if (
    media.purpose !== "marketplace.collaboration_chat.attachment" ||
    media.resourceType !== "collaboration_chat_message" ||
    media.resourceId !== sourceId
  )
    throw new Error("image message media object has the wrong resource scope");
  return media;
}

function resolveMedia(
  context: MarketplaceBuildContext,
  sourceUrl: string,
  sourceTable: string,
  sourceId: string,
  field: string,
): MarketplaceMediaReference {
  if (!looksUrl(sourceUrl)) throw new Error(`${field} is not a URL`);
  const expectedSourceRowId = mediaSourceRowId(sourceId, field);
  const matches = (context.mediaBySourceUrl.get(sourceUrl) ?? []).filter(
    (media) =>
      media.sourceTable === sourceTable &&
      media.sourceRowId === expectedSourceRowId &&
      media.sourceField === field,
  );
  if (matches.length !== 1)
    throw new Error(`${field} resolves to ${matches.length} VAY-1055 media objects`);
  return matches[0]!;
}

function mediaSourceRowId(sourceId: string, field: string): string {
  const indexed = /^images\[(\d+)]$/.exec(field);
  if (indexed) return `${sourceId}:images:${Number(indexed[1]) + 1}`;
  return `${sourceId}:${field}`;
}

function senderForMessage(
  context: MarketplaceBuildContext,
  scope: ReturnType<typeof collaborationScope>,
  senderId: unknown,
  messageType: string,
): { userId: string | null; type: string } {
  if (senderId == null || senderId === "" || messageType === "system")
    return { userId: null, type: "system" };
  const userId = requireUser(context, senderId, "sender_id");
  const creatorUserId = uuid(
    context.creatorById.get(scope.creatorId)?.data["user_id"],
    "creator.user_id",
  );
  const hotelId = uuid(scope.collaboration.data["hotel_id"], "hotel_id");
  const hotelUserId = uuid(context.hotelById.get(hotelId)?.data["user_id"], "hotel.user_id");
  if (userId === creatorUserId) return { userId, type: "creator" };
  if (userId === hotelUserId) return { userId, type: "hotel" };
  throw new Error("sender_id is neither the collaboration creator nor hotel owner");
}

function extractLegacyUrl(metadata: unknown, body: string): string {
  const object = optionalObject(metadata);
  const candidate = object["legacySourceUrl"] ?? object["url"] ?? body;
  return requiredText(candidate, "image source URL");
}

function publicCompensation(source: IdentitySourceRow): Record<string, unknown> {
  const type = mapCompensation(source.data["collaboration_type"]);
  return {
    type,
    months: stringArray(source.data["availability_months"], "availability_months"),
    platforms: stringArray(source.data["platforms"], "platforms").map(mapPlatform),
    minNights: optionalInteger(source.data["free_stay_min_nights"], "free_stay_min_nights"),
    maxNights: optionalInteger(source.data["free_stay_max_nights"], "free_stay_max_nights"),
    maxAmount: optionalMoney(source.data["paid_max_amount"], "paid_max_amount"),
    discountPercentage: optionalInteger(source.data["discount_percentage"], "discount_percentage"),
    commissionPercentage: optionalInteger(
      source.data["commission_percentage"],
      "commission_percentage",
    ),
    minFollowers: optionalInteger(source.data["min_followers"], "min_followers"),
    currency: currency(source.data["currency"], "currency"),
  };
}

function publicRequirements(source: IdentitySourceRow): Record<string, unknown> {
  return {
    platforms: stringArray(source.data["platforms"], "platforms").map(mapPlatform),
    countries: nullableStringArray(source.data["target_countries"], "target_countries"),
    ageMin: optionalInteger(source.data["target_age_min"], "target_age_min"),
    ageMax: optionalInteger(source.data["target_age_max"], "target_age_max"),
    ageGroups: stringArray(source.data["target_age_groups"], "target_age_groups"),
    creatorTypes: stringArray(source.data["creator_types"], "creator_types").map(mapCreatorType),
  };
}

function timestamp(source: IdentitySourceRow): string {
  return (
    optionalIso(source.data["updated_at"], "updated_at") ??
    iso(source.data["created_at"], "created_at")
  );
}

function retentionDate(value: string): string {
  return retentionTimestamp(value).slice(0, 10);
}

function retentionTimestamp(value: string): string {
  const retained = new Date(iso(value, "retention timestamp"));
  retained.setUTCFullYear(retained.getUTCFullYear() + 2);
  return retained.toISOString();
}

function mapCreatorType(value: unknown): string {
  const type = requiredText(value, "creator_type").toLowerCase();
  if (type === "lifestyle" || type === "travel") return type;
  throw new Error(`creator_type ${type} is unsupported`);
}

function mapPlatform(value: unknown): string {
  const platform = requiredText(value, "platform").toLowerCase();
  if (["instagram", "tiktok", "youtube", "facebook"].includes(platform)) return platform;
  throw new Error(`platform ${platform} is unsupported`);
}

function mapHotelStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  if (["pending", "verified", "rejected", "suspended"].includes(status)) return status;
  throw new Error(`hotel status ${status} is unsupported`);
}

function mapOwnerStatus(value: unknown): string {
  if (value === "active") return "active";
  if (value === "suspended") return "suspended";
  if (value === "archived") return "archived";
  throw new Error("creator owner link status is unsupported");
}

function mapOfferStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  if (["pending", "verified", "rejected"].includes(status)) return status;
  throw new Error(`offer status ${status} is unsupported`);
}

function mapVisibility(offerStatus: string, hotelStatus: string, ownerStatus: string): string {
  if (ownerStatus !== "active") return "disabled";
  if (hotelStatus === "pending") return "private";
  if (hotelStatus !== "verified") return "disabled";
  return offerStatus === "verified" ? "public" : offerStatus === "pending" ? "private" : "disabled";
}

function mapAccommodation(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value, "accommodation_type").toLowerCase();
  const mapped: Record<string, string> = {
    hotel: "hotel",
    resort: "resort",
    "boutique hotel": "boutique_hotel",
    "boutiques hotel": "boutique_hotel",
    "city hotel": "hotel",
    "luxury hotel": "hotel",
    lodge: "lodge",
    apartment: "apartment",
    villa: "villa",
  };
  if (!mapped[normalized]) throw new Error(`accommodation_type ${normalized} is unsupported`);
  return mapped[normalized];
}

function mapCompensation(value: unknown): string {
  const normalized = requiredText(value, "collaboration_type").toLowerCase().replaceAll(" ", "_");
  if (["free_stay", "paid", "discount", "affiliate"].includes(normalized)) return normalized;
  throw new Error(`collaboration_type ${normalized} is unsupported`);
}

function mapCollaborationStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  if (["pending", "negotiating", "accepted", "declined", "completed", "cancelled"].includes(status))
    return status;
  throw new Error(`collaboration status ${status} is unsupported`);
}

function mapExternalType(value: unknown): string | null {
  if (value == null || value === "") return null;
  const normalized = requiredText(value, "collaboration_type")
    .toLowerCase()
    .replaceAll(" / ", "_")
    .replaceAll(" ", "_");
  const mapped: Record<string, string> = {
    custom_external: "custom_external",
    paid: "paid",
    free_stay: "free_stay",
  };
  if (!mapped[normalized])
    throw new Error(`external collaboration type ${normalized} is unsupported`);
  return mapped[normalized];
}

function mapInviteStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  if (["pending", "redeemed", "expired"].includes(status)) return status;
  throw new Error(`invite status ${status} is unsupported`);
}

function socialProfileUrl(platform: string, handle: string): string | null {
  const clean = handle.replace(/^@/, "");
  if (!clean || /[\s/]/.test(clean)) return null;
  const base: Record<string, string> = {
    instagram: "https://www.instagram.com/",
    tiktok: "https://www.tiktok.com/@",
    youtube: "https://www.youtube.com/@",
    facebook: "https://www.facebook.com/",
  };
  return `${base[platform]}${clean}`;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item) => requiredText(item, field));
}

function nullableStringArray(value: unknown, field: string): string[] | null {
  return value == null ? null : stringArray(value, field);
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function audiencePercentages(
  value: unknown,
  label: "country" | "ageRange",
): Array<Record<"percentage" | "country" | "ageRange", number | string>> {
  if (value === null || value === undefined) return [];
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((entry) => {
        const object = requiredObject(entry, `audience ${label}`);
        const rawLabel =
          label === "ageRange" ? (object["ageRange"] ?? object["age_range"]) : object["country"];
        return [requiredText(rawLabel, label), object["percentage"]];
      })
    : Object.entries(requiredObject(value, `audience ${label}`));
  if (entries.length > 50) throw new Error(`audience ${label} must contain at most 50 entries`);
  const seen = new Set<string>();
  return entries
    .map(([rawLabel, percentage]) => {
      const normalizedLabel = requiredText(rawLabel, label);
      if (seen.has(normalizedLabel))
        throw new Error(`audience ${label} contains a duplicate label`);
      seen.add(normalizedLabel);
      return {
        [label]: normalizedLabel,
        percentage: audiencePercentage(percentage, `${label}.percentage`),
      } as Record<"percentage" | "country" | "ageRange", number | string>;
    })
    .sort((left, right) => String(left[label]).localeCompare(String(right[label])));
}

function audienceGenderSplit(value: unknown): Record<string, number> {
  if (value === null || value === undefined) return {};
  const object = requiredObject(value, "gender_split");
  if (Object.keys(object).length === 0) return {};
  const result: Record<string, number> = {
    male: audiencePercentage(object["male"], "gender_split.male"),
    female: audiencePercentage(object["female"], "gender_split.female"),
  };
  if (object["other"] !== undefined)
    result["other"] = audiencePercentage(object["other"], "gender_split.other");
  return result;
}

function audiencePercentage(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)
    throw new Error(`${field} must be between 0 and 100`);
  return parsed;
}

function optionalInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined || value === "" ? null : integer(value, field);
}

function optionalMoney(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === "" ? null : money(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 0) throw new Error(`${field} must be non-negative`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed <= 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = integer(value, field);
  if (parsed < min || parsed > max) throw new Error(`${field} is outside ${min}-${max}`);
  return parsed;
}

function nonNegativeDecimal(value: unknown, field: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be non-negative`);
  return parsed.toFixed(4);
}

function looksUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function looksLegacy(value: string): boolean {
  return /legacy|amazonaws\.com|s3[.-]/i.test(value);
}

function assertNoLegacyMedia(value: unknown, field: string): void {
  if (typeof value === "string") {
    if (looksUrl(value) && looksLegacy(value))
      throw new Error(`${field} contains an unresolved legacy media URL`);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoLegacyMedia(entry, field);
    return;
  }
  if (value && typeof value === "object")
    for (const entry of Object.values(value as Record<string, unknown>))
      assertNoLegacyMedia(entry, field);
}

function safeSourceId(row: IdentitySourceRow): string {
  return typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`;
}
