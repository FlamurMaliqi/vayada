import type { ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type MediaUrlMigrationChecks = {
  bookingPropertyMedia?: Array<{
    id: string;
    mediaType: string;
    url: string;
    sourceSystem: string;
    publicApproved: boolean;
    platformMediaObjectId: string;
  }>;
  propertyPublicProfiles?: Array<{
    propertyId: string;
    mediaObjectIds: string[];
    urls: string[];
    forbiddenUrls: string[];
  }>;
  marketplace?: {
    creatorProfileId: string;
    profilePictureUrl: string;
    offerId: string;
    offerImageUrls: string[];
    chatMessageId: string;
    chatMediaObjectId: string;
  };
  pms?: {
    roomTypeId: string;
    roomMediaObjectIds: string[];
    roomMediaUrls: string[];
    attachments: Array<{
      id: string;
      s3Key: string | null;
      sourceUrl: string | null;
      platformMediaObjectId: string;
    }>;
  };
  forbiddenPublicReferenceValues?: string[];
};

function addMediaUrlFinding(
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
    owner: "Platform media migration",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction,
  });
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function checkMediaUrlMigrationParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  const config = expected.mediaUrlMigrationChecks as MediaUrlMigrationChecks | undefined;
  if (!config) {
    addMediaUrlFinding(
      findings,
      "MEDIA_URL_MIGRATION_EXPECTED_CONFIG_MISSING",
      "expected-target.json.mediaUrlMigrationChecks",
      "Media URL migration fixture must document domain-reference parity expectations",
      "mediaUrlMigrationChecks with Booking, Marketplace, PMS references",
      "undefined",
      "Add mediaUrlMigrationChecks to media-url-migration/expected-target.json.",
    );
    return;
  }

  for (const propertyMedia of config.bookingPropertyMedia ?? []) {
    const { rows } = await client.query<{
      media_type: string;
      url: string;
      source_system: string;
      public_approved: boolean;
      platform_media_object_id: string | null;
    }>(
      `
        SELECT media_type, url, source_system, public_approved,
               platform_media_object_id::text
        FROM hotel_catalog.property_media
        WHERE id = $1
      `,
      [propertyMedia.id],
    );
    const actual = rows[0];
    if (
      actual &&
      actual.media_type === propertyMedia.mediaType &&
      actual.url === propertyMedia.url &&
      actual.source_system === propertyMedia.sourceSystem &&
      actual.public_approved === propertyMedia.publicApproved &&
      actual.platform_media_object_id === propertyMedia.platformMediaObjectId
    ) {
      continue;
    }

    addMediaUrlFinding(
      findings,
      "MEDIA_URL_BOOKING_PROPERTY_MEDIA_MISMATCH",
      `hotel_catalog.property_media.${propertyMedia.id}`,
      "Booking hero/gallery URL migration did not preserve the expected target property media reference",
      JSON.stringify(propertyMedia),
      JSON.stringify(actual ?? null),
      "Check Booking hero_image/images mapping and copied/external URL selection.",
    );
  }

  for (const publicProfile of config.propertyPublicProfiles ?? []) {
    const { rows } = await client.query<{ media: unknown }>(
      `
        SELECT media
        FROM hotel_catalog.property_public_profile_read_model
        WHERE property_id = $1
      `,
      [publicProfile.propertyId],
    );
    const media = JSON.stringify(rows[0]?.media ?? []);
    const missingMediaObjectIds = publicProfile.mediaObjectIds.filter(
      (mediaObjectId) => !media.includes(mediaObjectId),
    );
    const missingUrls = publicProfile.urls.filter((url) => !media.includes(url));
    const leakedForbiddenUrls = publicProfile.forbiddenUrls.filter((url) => media.includes(url));
    if (
      rows.length === 1 &&
      missingMediaObjectIds.length === 0 &&
      missingUrls.length === 0 &&
      leakedForbiddenUrls.length === 0
    ) {
      continue;
    }

    addMediaUrlFinding(
      findings,
      "MEDIA_URL_PROPERTY_PUBLIC_PROFILE_MEDIA_MISMATCH",
      `hotel_catalog.property_public_profile_read_model.${publicProfile.propertyId}.media`,
      "Property public profile media did not expose exactly the approved public platform variants expected by the fixture",
      JSON.stringify(publicProfile),
      media,
      "Check property_media platform_media_object_id mapping and public profile media projection filters.",
    );
  }

  if (config.marketplace) {
    const { rows } = await client.query<{
      profile_picture_url: string | null;
      offer_image_urls: string[];
      read_model_image_urls: string[];
      chat_media_object_id: string | null;
    }>(
      `
        SELECT
          creator.profile_picture_url,
          offer.image_urls AS offer_image_urls,
          read_model.image_urls AS read_model_image_urls,
          chat.message_metadata ->> 'mediaObjectId' AS chat_media_object_id
        FROM marketplace.creator_profiles creator
        CROSS JOIN marketplace.marketplace_offers offer
        JOIN marketplace.marketplace_offer_read_model read_model
          ON read_model.offer_id = offer.id
        CROSS JOIN marketplace.marketplace_chat_messages chat
        WHERE creator.id = $1
          AND offer.id = $2
          AND chat.id = $3
      `,
      [
        config.marketplace.creatorProfileId,
        config.marketplace.offerId,
        config.marketplace.chatMessageId,
      ],
    );
    const actual = rows[0];
    if (
      !actual ||
      actual.profile_picture_url !== config.marketplace.profilePictureUrl ||
      !sameStringArray(actual.offer_image_urls, config.marketplace.offerImageUrls) ||
      !sameStringArray(actual.read_model_image_urls, config.marketplace.offerImageUrls) ||
      actual.chat_media_object_id !== config.marketplace.chatMediaObjectId
    ) {
      addMediaUrlFinding(
        findings,
        "MEDIA_URL_MARKETPLACE_REFERENCE_MISMATCH",
        "marketplace media references",
        "Marketplace offer/profile/chat URLs did not migrate to the expected target references",
        JSON.stringify(config.marketplace),
        JSON.stringify(actual ?? null),
        "Check creator profile, offer gallery, offer read model, and chat attachment mapping.",
      );
    }
  }

  if (config.pms) {
    const { rows: roomRows } = await client.query<{ media_snapshot: unknown }>(
      `
        SELECT media_snapshot
        FROM pms.room_types
        WHERE id = $1
      `,
      [config.pms.roomTypeId],
    );
    const mediaSnapshot = JSON.stringify(roomRows[0]?.media_snapshot ?? []);
    const missingRoomObjectIds = config.pms.roomMediaObjectIds.filter(
      (mediaObjectId) => !mediaSnapshot.includes(mediaObjectId),
    );
    const missingRoomUrls = config.pms.roomMediaUrls.filter((url) => !mediaSnapshot.includes(url));
    if (missingRoomObjectIds.length > 0 || missingRoomUrls.length > 0) {
      addMediaUrlFinding(
        findings,
        "MEDIA_URL_PMS_ROOM_MEDIA_MISMATCH",
        `pms.room_types.${config.pms.roomTypeId}.media_snapshot`,
        "PMS room image/import migration did not preserve the expected room media snapshot references",
        JSON.stringify({
          mediaObjectIds: config.pms.roomMediaObjectIds,
          urls: config.pms.roomMediaUrls,
        }),
        mediaSnapshot,
        "Check PMS room images/import mapping and public-safe URL selection.",
      );
    }

    for (const attachment of config.pms.attachments) {
      const { rows } = await client.query<{
        s3_key: string | null;
        source_url: string | null;
        platform_media_object_id: string | null;
      }>(
        `
          SELECT s3_key, source_url, platform_media_object_id::text
          FROM pms.message_attachments
          WHERE id = $1
        `,
        [attachment.id],
      );
      const actual = rows[0];
      if (
        actual &&
        actual.s3_key === attachment.s3Key &&
        actual.source_url === attachment.sourceUrl &&
        actual.platform_media_object_id === attachment.platformMediaObjectId
      ) {
        continue;
      }

      addMediaUrlFinding(
        findings,
        "MEDIA_URL_PMS_ATTACHMENT_MISMATCH",
        `pms.message_attachments.${attachment.id}`,
        "PMS message attachment migration did not preserve the expected private storage/source reference",
        JSON.stringify(attachment),
        JSON.stringify(actual ?? null),
        "Check copied private attachment keys and unresolved external attachment source URLs.",
      );
    }
  }

  for (const forbiddenValue of config.forbiddenPublicReferenceValues ?? []) {
    const { rows } = await client.query<{ leaked: boolean }>(
      `
        SELECT EXISTS(
          SELECT 1
          FROM hotel_catalog.property_media
          WHERE url LIKE '%' || $1 || '%'
          UNION ALL
          SELECT 1
          FROM marketplace.creator_profiles
          WHERE COALESCE(profile_picture_url, '') LIKE '%' || $1 || '%'
          UNION ALL
          SELECT 1
          FROM marketplace.marketplace_offers
          WHERE array_to_string(image_urls, ' ') LIKE '%' || $1 || '%'
          UNION ALL
          SELECT 1
          FROM marketplace.marketplace_offer_read_model
          WHERE array_to_string(image_urls, ' ') LIKE '%' || $1 || '%'
          UNION ALL
          SELECT 1
          FROM pms.room_types
          WHERE media_snapshot::text LIKE '%' || $1 || '%'
        ) AS leaked
      `,
      [forbiddenValue],
    );
    if (rows[0]?.leaked !== true) continue;

    addMediaUrlFinding(
      findings,
      "MEDIA_URL_PUBLIC_REFERENCE_PRIVATE_VALUE_LEAK",
      "public media references",
      "Public Booking, Marketplace, or PMS media references expose a value marked private by the fixture",
      "No forbidden private value in public media references",
      forbiddenValue,
      "Rewrite public references to platform CDN URLs or preserved public external URLs only.",
    );
  }
}
