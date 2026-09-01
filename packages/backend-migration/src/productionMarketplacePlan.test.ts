import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionMarketplacePlan } from "./productionMarketplacePlan.js";
import type { ProductionMarketplaceTargetState } from "./productionMarketplaceTypes.js";
import { readProductionMarketplaceTargetState } from "./productionMarketplaceTargetReader.js";
import { writeProductionMarketplaceRecords } from "./productionMarketplaceWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const RUN = "vay1351-0123456789abcdef01234567";
const CREATED = "2026-08-01T00:00:00.000Z";
const UPDATED = "2026-08-02T00:00:00.000Z";
const USER_CREATOR = id(1);
const USER_HOTEL = id(2);
const CREATOR = id(3);
const HOTEL = id(4);
const OFFER = id(5);
const COLLABORATION = id(6);
const PROPERTY = id(7);
const CREATOR_ORG = id(8);
const HOTEL_ORG = id(9);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("production Marketplace plan", () => {
  it("maps every production source table through exact ownership relationships", () => {
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows: representativeRows(),
      target: prerequisites(),
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({ sourceRows: 15, plannedRecords: 16, inserts: 16 });
    expect(plan.parity.sourceTableCounts).toMatchObject({
      "marketplace.creators": 1,
      "marketplace.hotel_listings": 1,
      "marketplace.collaborations": 1,
      "marketplace.chat_messages": 1,
      "marketplace.invite_codes": 1,
    });
    expect(plan.parity.targetTableCounts).toMatchObject({
      "marketplace.creator_profiles": 1,
      "marketplace.marketplace_offers": 1,
      "marketplace.marketplace_offer_read_model": 1,
      "marketplace.collaborations": 1,
      "marketplace.marketplace_chat_messages": 1,
    });
    const readModel = plan.records.find(
      (record) => record.targetTable === "marketplace_offer_read_model",
    );
    expect(readModel?.row).toMatchObject({
      visibilityStatus: "public",
      location: { country: "Portugal" },
    });
    expect(JSON.stringify(readModel?.row)).not.toContain("why_great_fit");
    expect(plan.parity.preferenceDraftsByProperty[PROPERTY]).toMatchObject({
      canonicalTargetRevision: null,
      draft: {
        draftOnly: true,
        canonicalWriteAllowed: false,
        unansweredFields: ["marketplace.preferences.content_types"],
      },
    });
  });

  it.each([
    ["suspended hotel profile", "suspended", "active"],
    ["suspended hotel owner", "verified", "suspended"],
  ])(
    "keeps a verified offer private when it belongs to a %s",
    (_label, hotelStatus, ownerStatus) => {
      const rows = representativeRows();
      rows.find((row) => row.sourceTable === "hotel_profiles")!.data["status"] = hotelStatus;
      const target = prerequisites();
      target.resourceLinks.find((link) => link.resourceType === "hotel_profile")!.status =
        ownerStatus;

      const plan = buildProductionMarketplacePlan({
        sourceRunId: RUN,
        completedAt: "2026-08-03T00:00:00.000Z",
        rows,
        target,
      });

      expect(plan.blockers).toEqual([]);
      expect(
        plan.records.find((record) => record.targetTable === "marketplace_offer_read_model")?.row[
          "visibilityStatus"
        ],
      ).toBe("disabled");
    },
  );

  it("preserves an archived-owner offer without creating a public read model", () => {
    const target = prerequisites();
    target.resourceLinks.find((link) => link.resourceType === "hotel_profile")!.status = "archived";
    target.publicProperties = [];

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows: representativeRows(),
      target,
    });

    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.find((record) => record.targetTable === "marketplace_offers")?.row,
    ).toMatchObject({
      offerStatus: "archived",
      offerMetadata: { legacySourceStatus: "verified", ownerQuarantined: true },
    });
    expect(
      plan.records.find((record) => record.targetTable === "marketplace_hotel_profiles")?.row,
    ).toMatchObject({
      marketplaceProfileStatus: "archived",
      marketplaceMetadata: { legacySourceStatus: "verified", ownerStatus: "archived" },
    });
    expect(
      plan.records.some((record) => record.targetTable === "marketplace_offer_read_model"),
    ).toBe(false);
  });

  it("keeps an active owner's private-quarantined property and operations non-live", () => {
    const target = prerequisites();
    target.propertyLinks[0]!.migrationDisposition = "private_quarantine";
    target.publicProperties = [];

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows: representativeRows(),
      target,
    });

    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.find((record) => record.targetTable === "marketplace_hotel_profiles")?.row,
    ).toMatchObject({
      marketplaceProfileStatus: "archived",
      marketplaceMetadata: { migrationDisposition: "private_quarantine" },
    });
    expect(
      plan.records.find((record) => record.targetTable === "marketplace_offers")?.row,
    ).toMatchObject({
      offerStatus: "archived",
      imageUrls: [],
      offerMetadata: { migrationDisposition: "private_quarantine" },
    });
    expect(
      plan.records.find((record) => record.targetTable === "collaborations")?.row,
    ).toMatchObject({
      lifecycleStatus: "cancelled",
      collaborationMetadata: { migrationDisposition: "private_quarantine" },
    });
    expect(
      plan.records.some((record) => record.targetTable === "marketplace_offer_read_model"),
    ).toBe(false);
  });

  it("ignores a valid operator link when the owner is unambiguous", () => {
    const target = prerequisites();
    target.resourceLinks.push({
      organizationId: CREATOR_ORG,
      resourceType: "hotel_profile",
      resourceId: HOTEL,
      relationship: "operator",
      status: "active",
    });

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows: representativeRows(),
      target,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.counts.inserts).toBe(16);
  });

  it("normalizes legacy audience object maps and array rows to canonical arrays", () => {
    const rows = representativeRows();
    const platform = rows.find((row) => row.sourceTable === "creator_platforms")!;
    platform.data["top_countries"] = { US: "55", DE: 45 };
    platform.data["top_age_groups"] = { "35-44": 40, "25-34": "60" };
    platform.data["gender_split"] = { male: "45", female: 50, other: 5 };

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: prerequisites(),
    });
    const migrated = plan.records.find((record) => record.targetTable === "creator_platforms");
    expect(migrated?.row).toMatchObject({
      audienceCountries: [
        { country: "DE", percentage: 45 },
        { country: "US", percentage: 55 },
      ],
      audienceAgeGroups: [
        { ageRange: "25-34", percentage: 60 },
        { ageRange: "35-44", percentage: 40 },
      ],
      audienceGenderSplit: { male: 45, female: 50, other: 5 },
    });

    platform.data["top_countries"] = [
      { country: "US", percentage: 55 },
      { country: "DE", percentage: 45 },
    ];
    platform.data["top_age_groups"] = [
      { age_range: "35-44", percentage: 40 },
      { ageRange: "25-34", percentage: 60 },
    ];
    const arrayPlan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: prerequisites(),
    });
    expect(
      arrayPlan.records.find((record) => record.targetTable === "creator_platforms")?.row,
    ).toMatchObject({
      audienceCountries: migrated?.row["audienceCountries"],
      audienceAgeGroups: migrated?.row["audienceAgeGroups"],
    });
  });

  it("blocks unresolved legacy media instead of copying a raw URL", () => {
    const rows = representativeRows();
    const listing = rows.find((row) => row.sourceTable === "hotel_listings")!;
    listing.data["images"] = ["https://legacy-marketplace.s3.amazonaws.com/listing.jpg"];
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: prerequisites(),
    });
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVALID_SOURCE_ROW",
          source: "marketplace.hotel_listings",
        }),
      ]),
    );
    expect(
      plan.records.some((record) => JSON.stringify(record.row).includes("legacy-marketplace")),
    ).toBe(false);
  });

  it("preserves listing image positions when the legacy URL is repeated", () => {
    const rows = representativeRows();
    const listing = rows.find((row) => row.sourceTable === "hotel_listings")!;
    const legacyUrl = "https://legacy-marketplace.s3.amazonaws.com/repeated.jpg";
    listing.data["images"] = [legacyUrl, legacyUrl];
    const target = prerequisites();
    target.media.push(
      ...[0, 1].map((index) => ({
        mediaObjectId: id(30 + index),
        sourceUrl: legacyUrl,
        sourceTable: "hotel_listings",
        sourceRowId: `${OFFER}:images:${index + 1}`,
        sourceField: `images[${index}]`,
        visibility: "public",
        purpose: "marketplace.offer.media",
        lifecycleStatus: "active",
        publicApproved: true,
        publicUrl: `https://media.example.test/listing-${index + 1}.webp`,
        resourceType: "marketplace_offer",
        resourceId: OFFER,
      })),
    );

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target,
    });

    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.find((record) => record.targetTable === "marketplace_offers")?.row["imageUrls"],
    ).toEqual([
      "https://media.example.test/listing-1.webp",
      "https://media.example.test/listing-2.webp",
    ]);
  });

  it("replaces image-message metadata with the private media object reference", () => {
    const rows = representativeRows();
    const message = rows.find((row) => row.sourceTable === "chat_messages")!;
    const legacyUrl = "https://legacy-marketplace.s3.amazonaws.com/private-message.jpg";
    message.data["content"] = legacyUrl;
    message.data["message_type"] = "image";
    message.data["metadata"] = {
      url: legacyUrl,
      legacySourceUrl: legacyUrl,
      nested: { rawUrl: legacyUrl },
    };
    const target = prerequisites();
    target.media.push({
      mediaObjectId: id(23),
      sourceUrl: legacyUrl,
      sourceTable: "chat_messages",
      sourceRowId: `${id(15)}:image`,
      sourceField: "image",
      visibility: "private",
      purpose: "marketplace.collaboration_chat.attachment",
      lifecycleStatus: "active",
      publicApproved: false,
      publicUrl: null,
      resourceType: "collaboration_chat_message",
      resourceId: id(15),
    });

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target,
    });

    expect(plan.blockers).toEqual([]);
    const migrated = plan.records.find(
      (record) => record.targetTable === "marketplace_chat_messages",
    );
    expect(migrated?.row["messageMetadata"]).toEqual({
      mediaObjectId: id(23),
      attachmentSource: "platform_media_migration",
    });
    expect(JSON.stringify(migrated?.row)).not.toContain(legacyUrl);
  });

  it("tombstones an image message whose retention expired before extraction", () => {
    const rows = representativeRows();
    const message = rows.find((row) => row.sourceTable === "chat_messages")!;
    const legacyUrl = "https://legacy-marketplace.s3.amazonaws.com/expired-message.jpg";
    message.data["content"] = legacyUrl;
    message.data["message_type"] = "image";
    message.data["metadata"] = { url: legacyUrl };
    message.data["created_at"] = "2023-08-01T00:00:00.000Z";
    message.data["updated_at"] = "2023-08-02T00:00:00.000Z";

    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: prerequisites(),
    });

    expect(plan.blockers).toEqual([]);
    const migrated = plan.records.find(
      (record) => record.targetTable === "marketplace_chat_messages",
    );
    expect(migrated?.row).toMatchObject({
      senderUserId: null,
      senderType: "migration",
      messageType: "system",
      body: "[expired legacy image attachment omitted]",
      messageMetadata: { attachmentSource: "legacy_retention_expired" },
      piiRetentionUntil: "2025-08-01",
    });
    expect(JSON.stringify(migrated?.row)).not.toContain(legacyUrl);
  });

  it("preserves a target row that changed after the prior migration", () => {
    const rows = [creatorRow()];
    const preliminary = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: creatorPrerequisites(),
    });
    const candidate = preliminary.records[0]!;
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: {
        ...creatorPrerequisites(),
        records: [
          {
            targetProduct: "marketplace",
            targetTable: candidate.targetTable,
            targetId: candidate.targetId,
            updatedAt: "2026-08-05T00:00:00.000Z",
            row: { ...candidate.row, locationText: "new target state" },
          },
        ],
        provenance: [provenance(candidate, "2026-08-04T00:00:00.000Z")],
      },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.counts.preservedNewerTarget).toBe(1);
  });

  it("preserves an intentional target deletion and does not recreate it", () => {
    const rows = [creatorRow()];
    const preliminary = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: creatorPrerequisites(),
    });
    const candidate = preliminary.records[0]!;
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: {
        ...creatorPrerequisites(),
        records: [],
        provenance: [provenance(candidate, "2026-08-04T00:00:00.000Z")],
      },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
    expect(plan.counts.preservedTargetDeletions).toBe(1);
  });

  it("blocks equal-time conflicts without provenance", () => {
    const rows = [creatorRow()];
    const preliminary = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: creatorPrerequisites(),
    });
    const candidate = preliminary.records[0]!;
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows,
      target: {
        ...creatorPrerequisites(),
        records: [
          {
            targetProduct: "marketplace",
            targetTable: candidate.targetTable,
            targetId: candidate.targetId,
            updatedAt: candidate.sourceUpdatedAt,
            row: { ...candidate.row, locationText: "conflict" },
          },
        ],
        provenance: [],
      },
    });
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TARGET_EQUAL_TIME_CONFLICT" })]),
    );
    expect(plan.writes).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("production Marketplace writer (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it("accepts the complete production mapping in dependency order", async () => {
    const planPrerequisites = prerequisites();
    const plan = buildProductionMarketplacePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-03T00:00:00.000Z",
      rows: representativeRows(),
      target: planPrerequisites,
    });
    expect(plan.blockers).toEqual([]);
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1, 'marketplace-writer-creator@example.test', 'Creator', 'active'),
                ($2, 'marketplace-writer-hotel@example.test', 'Hotel', 'active')`,
        [USER_CREATOR, USER_HOTEL],
      );
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status)
         VALUES ($1, 'creator_workspace', 'Creator', 'marketplace-writer-creator', 'active'),
                ($2, 'hotel_group', 'Hotel', 'marketplace-writer-hotel', 'active')`,
        [CREATOR_ORG, HOTEL_ORG],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, property_type, default_locale, supported_locales,
            profile_status, completeness_reasons)
         VALUES ($1, 'marketplace-writer-property', 'Hotel', 'hotel', 'en', ARRAY['en'],
                 'complete', ARRAY[]::text[])`,
        [PROPERTY],
      );
      const prerequisiteTables = new Set([
        "creator_profiles",
        "creator_platforms",
        "marketplace_hotel_profiles",
        "marketplace_offers",
        "offer_compensation_options",
        "offer_creator_requirements",
      ]);
      await writeProductionMarketplaceRecords(
        client,
        plan.writes.filter((record) => prerequisiteTables.has(record.targetTable)),
      );
      const collaboration = plan.records.find((record) => record.targetTable === "collaborations")!;
      const conflictingCollaboration = {
        ...collaboration,
        targetId: id(24),
        sourceId: id(24),
        row: {
          ...collaboration.row,
          id: id(24),
          sourceCollaborationId: id(24),
        },
      };
      const sourceCollisionTarget = await readProductionMarketplaceTargetState(
        client,
        [...plan.records, conflictingCollaboration],
        planPrerequisites,
      );
      expect(sourceCollisionTarget.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "TARGET_UNIQUE_CONFLICT",
            message:
              "Multiple source collaborations collide on the active offer and creator identity",
          }),
        ]),
      );
      await writeProductionMarketplaceRecords(client, [conflictingCollaboration]);
      const blockedTarget = await readProductionMarketplaceTargetState(
        client,
        plan.records,
        planPrerequisites,
      );
      expect(blockedTarget.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "TARGET_UNIQUE_CONFLICT",
            source: "marketplace.collaborations",
          }),
        ]),
      );
      await client.query(`DELETE FROM marketplace.collaborations WHERE id = $1`, [id(24)]);
      const target = await readProductionMarketplaceTargetState(client, plan.records, {
        propertyLinks: planPrerequisites.propertyLinks,
        resourceLinks: planPrerequisites.resourceLinks,
        userIds: planPrerequisites.userIds,
        userNames: planPrerequisites.userNames,
        publicProperties: planPrerequisites.publicProperties,
        media: planPrerequisites.media,
        hotelPreferences: planPrerequisites.hotelPreferences,
      });
      expect(target.blockers).toEqual([]);
      const counts = await writeProductionMarketplaceRecords(client, plan.writes);
      expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(16);
      expect(
        (
          await client.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM marketplace.marketplace_offer_read_model WHERE offer_id = $1`,
            [OFFER],
          )
        ).rows[0]?.count,
      ).toBe(1);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

function representativeRows(): IdentitySourceRow[] {
  return [
    creatorRow(),
    row("creator_platforms", 2, {
      id: id(10),
      creator_id: CREATOR,
      name: "Instagram",
      handle: "creator",
      followers: 1000,
      engagement_rate: 2.5,
      top_countries: [],
      top_age_groups: [],
      gender_split: {},
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("hotel_profiles", 3, {
      id: HOTEL,
      user_id: USER_HOTEL,
      name: "Hotel",
      location: "Lisbon",
      picture: null,
      website: "https://hotel.example",
      about: "A hotel",
      phone: null,
      status: "verified",
      profile_complete: true,
      profile_completed_at: CREATED,
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("hotel_listings", 4, {
      id: OFFER,
      hotel_profile_id: HOTEL,
      name: "Lisbon stay",
      location: "Exact private address",
      description: "Public offer summary",
      accommodation_type: "Hotel",
      images: [],
      status: "verified",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("listing_collaboration_offerings", 5, {
      id: id(11),
      listing_id: OFFER,
      collaboration_type: "Free Stay",
      availability_months: ["May"],
      platforms: ["Instagram"],
      free_stay_min_nights: 1,
      free_stay_max_nights: 2,
      paid_max_amount: null,
      discount_percentage: null,
      commission_percentage: null,
      min_followers: 500,
      currency: "EUR",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("listing_creator_requirements", 6, {
      id: id(12),
      listing_id: OFFER,
      platforms: ["Instagram"],
      target_countries: ["PT"],
      target_age_min: 18,
      target_age_max: 40,
      target_age_groups: ["18-24"],
      creator_types: ["Travel"],
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("collaborations", 7, {
      id: COLLABORATION,
      initiator_type: "creator",
      creator_id: CREATOR,
      hotel_id: HOTEL,
      listing_id: OFFER,
      status: "accepted",
      why_great_fit: "Private application",
      collaboration_type: "Free Stay",
      free_stay_min_nights: 1,
      free_stay_max_nights: 2,
      paid_amount: null,
      discount_percentage: null,
      travel_date_from: "2026-09-01",
      travel_date_to: "2026-09-03",
      preferred_date_from: null,
      preferred_date_to: null,
      preferred_months: ["September"],
      consent: true,
      responded_at: UPDATED,
      cancelled_at: null,
      completed_at: null,
      hotel_agreed_at: UPDATED,
      creator_agreed_at: UPDATED,
      term_last_updated_at: UPDATED,
      creator_fee: null,
      affiliate_referral_code: null,
      affiliate_link: null,
      currency: "EUR",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("creator_ratings", 8, {
      id: id(13),
      creator_id: CREATOR,
      hotel_id: HOTEL,
      collaboration_id: COLLABORATION,
      rating: 5,
      comment: "Great",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("collaboration_deliverables", 9, {
      id: id(14),
      collaboration_id: COLLABORATION,
      platform: "Instagram",
      type: "post",
      quantity: 1,
      status: "completed",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("chat_messages", 10, {
      id: id(15),
      collaboration_id: COLLABORATION,
      sender_id: USER_CREATOR,
      content: "Private chat",
      message_type: "text",
      metadata: {},
      created_at: CREATED,
      read_at: UPDATED,
    }),
    row("trips", 11, {
      id: id(16),
      creator_id: CREATOR,
      name: "Portugal",
      location: "Lisbon",
      start_date: "2026-09-01",
      end_date: "2026-09-10",
      notes: "Private notes",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("external_collaborations", 12, {
      id: id(17),
      creator_id: CREATOR,
      trip_id: id(16),
      title: "External",
      hotel_name: "Other Hotel",
      location: "Porto",
      collaboration_type: "Paid",
      start_date: "2026-09-02",
      end_date: "2026-09-03",
      deliverables: "One post",
      notes: "Private",
      created_at: CREATED,
      updated_at: UPDATED,
    }),
    row("notifications", 13, {
      id: id(18),
      user_id: USER_CREATOR,
      type: "collaboration",
      title: "Update",
      body: "Private notification",
      link_url: "/collaborations",
      read_at: null,
      created_at: CREATED,
    }),
    row("invite_codes", 14, {
      id: id(19),
      code: "ABCD-1234",
      data: { property: { property_name: "Future Hotel" } },
      status: "pending",
      created_by: USER_HOTEL,
      redeemed_by: null,
      redeemed_at: null,
      expires_at: "2027-01-01T00:00:00.000Z",
      created_at: CREATED,
    }),
    row("newsletter_preferences", 15, {
      id: id(20),
      user_id: USER_CREATOR,
      enabled: true,
      country_filter: ["PT"],
      created_at: CREATED,
      updated_at: UPDATED,
    }),
  ];
}

function creatorRow(): IdentitySourceRow {
  return row("creators", 1, {
    id: CREATOR,
    user_id: USER_CREATOR,
    location: "Portugal",
    short_description: "Travel creator",
    portfolio_link: "https://creator.example",
    phone: null,
    profile_complete: true,
    profile_completed_at: CREATED,
    profile_picture: null,
    creator_type: "Travel",
    created_at: CREATED,
    updated_at: UPDATED,
  });
}

function prerequisites(): ProductionMarketplaceTargetState {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "profile_input",
        status: "active",
        migrationRunId: RUN,
      },
    ],
    resourceLinks: [
      {
        organizationId: CREATOR_ORG,
        resourceType: "creator_profile",
        resourceId: CREATOR,
        relationship: "owner",
        status: "active",
      },
      {
        organizationId: HOTEL_ORG,
        resourceType: "hotel_profile",
        resourceId: HOTEL,
        relationship: "owner",
        status: "active",
      },
    ],
    userIds: [USER_CREATOR, USER_HOTEL],
    userNames: [
      { id: USER_CREATOR, name: "Creator" },
      { id: USER_HOTEL, name: "Hotel Owner" },
    ],
    publicProperties: [
      {
        propertyId: PROPERTY,
        publicId: "hotel-public",
        displayName: "Hotel",
        canonicalSlug: "hotel",
        location: { country: "Portugal" },
      },
    ],
    media: [],
    hotelPreferences: [],
    records: [],
    provenance: [],
  };
}

function creatorPrerequisites(): ProductionMarketplaceTargetState {
  const target = prerequisites();
  return {
    ...target,
    propertyLinks: [],
    resourceLinks: target.resourceLinks.filter((link) => link.resourceType === "creator_profile"),
    publicProperties: [],
  };
}

function provenance(
  record: ReturnType<typeof buildProductionMarketplacePlan>["records"][number],
  lastMigratedAt: string,
) {
  return {
    sourceDatabase: record.sourceDatabase,
    sourceTable: record.sourceTable,
    sourceId: record.sourceId,
    targetProduct: record.targetProduct,
    targetTable: record.targetTable,
    targetId: record.targetId,
    sourceChecksum: record.sourceChecksum,
    sourceUpdatedAt: record.sourceUpdatedAt,
    lastMigratedAt,
  };
}

function row(
  sourceTable: string,
  rowOrdinal: number,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase: "marketplace", sourceTable, rowOrdinal, data };
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
