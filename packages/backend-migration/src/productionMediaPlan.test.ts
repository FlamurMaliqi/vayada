import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  buildProductionMediaPlan,
  type ProductionMediaTargetState,
} from "./productionMediaPlan.js";

const RUN = "vay1351-0123456789abcdef01234567";
const HOTEL = "10550000-0000-4000-a000-000000000001";
const PROPERTY = "10550000-0000-4000-a000-000000000002";
const ORGANIZATION = "10550000-0000-4000-a000-000000000003";
const HERO = "https://legacy-media-test.s3.amazonaws.com/hotels/My%20Hero.jpg";
const LOGO = "https://legacy-media-test.s3.amazonaws.com/rooms/logo.png";
const CREATOR = "10550000-0000-4000-a000-000000000010";
const CREATOR_USER = "10550000-0000-4000-a000-000000000011";
const HOTEL_USER = "10550000-0000-4000-a000-000000000012";
const CREATOR_ORGANIZATION = "10550000-0000-4000-a000-000000000013";
const COLLABORATION = "10550000-0000-4000-a000-000000000014";
const MESSAGE = "10550000-0000-4000-a000-000000000015";

describe("production media plan", () => {
  it("plans only attested current references with stable source identities", () => {
    const input = fixture();
    const first = buildProductionMediaPlan(input);
    const repeated = buildProductionMediaPlan(input);

    expect(first.blockers).toEqual([]);
    expect(first.counts).toEqual({
      planned: 1,
      pending: 1,
      reused: 0,
      quarantined: 0,
      public: 1,
      private: 0,
    });
    expect(first.references[0]).toMatchObject({
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceRowId: `${HOTEL}:hero_image`,
      sourceUrl: HERO,
      purpose: "property.hero_image",
      propertyId: PROPERTY,
      ownerOrganizationId: ORGANIZATION,
    });
    expect(repeated.checksum).toBe(first.checksum);
    expect(repeated.references[0]!.mediaObjectId).toBe(first.references[0]!.mediaObjectId);
  });

  it("preserves conflicting target state and blocks a different migration run", () => {
    const input = fixture();
    const reference = buildProductionMediaPlan(input).references[0]!;
    input.target.mediaObjects.push({
      id: reference.mediaObjectId,
      sourceSystem: reference.sourceSystem,
      sourceTable: reference.sourceTable,
      sourceRowId: reference.sourceRowId,
      sourceUrl: reference.sourceUrl,
      purpose: reference.purpose,
      lifecycleStatus: "active",
      visibility: "public",
      publicApproved: true,
      migrationRunId: "vay1351-ffffffffffffffffffffffff",
      checksumSha256: "a".repeat(64),
      bucket: "platform-media-test",
      storageKind: "vayada_managed",
      storageKey: `public/media/${reference.mediaObjectId}/original_safe/original.webp`,
      propertyId: reference.propertyId,
      ownerOrganizationId: reference.ownerOrganizationId,
      resourceProduct: reference.resourceProduct,
      resourceType: reference.resourceType,
      resourceId: reference.resourceId,
      retainedUntil: reference.retainedUntil,
      migrationCase: null,
      variants: ["blur_preview", "large", "original_safe", "thumbnail"].map((name) => ({
        name,
        visibility: "public",
        storageKey: `public/media/${reference.mediaObjectId}/${name}/variant.webp`,
        publicCdnUrl: `https://media.example.test/media/${reference.mediaObjectId}/${name}/variant.webp`,
      })),
    });

    const plan = buildProductionMediaPlan(input);
    expect(plan.pending).toEqual([]);
    expect(plan.reused).toEqual([]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "MEDIA_TARGET_CONFLICT", sourceId: reference.mediaObjectId }),
    );
  });

  it("reuses only the configured managed bucket and CDN variants", () => {
    const input = fixture();
    const reference = buildProductionMediaPlan(input).references[0]!;
    const existing = {
      id: reference.mediaObjectId,
      sourceSystem: reference.sourceSystem,
      sourceTable: reference.sourceTable,
      sourceRowId: reference.sourceRowId,
      sourceUrl: reference.sourceUrl,
      purpose: reference.purpose,
      lifecycleStatus: "active",
      visibility: "public",
      publicApproved: true,
      migrationRunId: RUN,
      checksumSha256: "a".repeat(64),
      bucket: "platform-media-test",
      storageKind: "vayada_managed",
      storageKey: `public/media/${reference.mediaObjectId}/original_safe/original.webp`,
      propertyId: reference.propertyId,
      ownerOrganizationId: reference.ownerOrganizationId,
      resourceProduct: reference.resourceProduct,
      resourceType: reference.resourceType,
      resourceId: reference.resourceId,
      retainedUntil: reference.retainedUntil,
      migrationCase: null,
      variants: ["blur_preview", "large", "original_safe", "thumbnail"].map((name) => ({
        name,
        visibility: "public",
        storageKey: `public/media/${reference.mediaObjectId}/${name}/variant.webp`,
        publicCdnUrl: `https://media.example.test/media/${reference.mediaObjectId}/${name}/variant.webp`,
      })),
    };
    input.target.mediaObjects = [existing];
    expect(buildProductionMediaPlan(input).reused).toEqual([reference]);

    existing.variants[0]!.publicCdnUrl =
      "https://platform-media-test.s3.us-east-1.amazonaws.com/media/object/blur_preview";
    const rawS3 = buildProductionMediaPlan(input);
    expect(rawS3.reused).toEqual([]);
    expect(rawS3.blockers).toContainEqual(
      expect.objectContaining({ code: "MEDIA_TARGET_CONFLICT" }),
    );

    existing.variants[0]!.storageKey =
      "public/media/10550000-0000-4000-a000-000000000099/blur_preview/variant.webp";
    existing.variants[0]!.publicCdnUrl =
      "https://media.example.test/media/10550000-0000-4000-a000-000000000099/blur_preview/variant.webp";
    const crossObjectPath = buildProductionMediaPlan(input);
    expect(crossObjectPath.reused).toEqual([]);
    expect(crossObjectPath.blockers).toContainEqual(
      expect.objectContaining({ code: "MEDIA_TARGET_CONFLICT" }),
    );
  });

  it("creates distinct catalog and Booking assignments for the legacy Booking logo", () => {
    const input = fixture();
    input.rows[0]!.data["branding_logo_url"] = LOGO;

    const logos = buildProductionMediaPlan(input).references.filter(
      (reference) => reference.sourceField === "branding_logo_url",
    );
    expect(logos).toHaveLength(2);
    expect(logos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRowId: `${HOTEL}:branding_logo_url`,
          purpose: "property.logo",
          resourceProduct: "hotel_catalog",
          resourceId: PROPERTY,
        }),
        expect.objectContaining({
          sourceRowId: `${HOTEL}:branding_logo_url:booking_header`,
          purpose: "booking.header_logo",
          resourceProduct: "booking",
          resourceType: "booking_hotel",
          resourceId: HOTEL,
        }),
      ]),
    );
  });

  it("retains archived hotel media as private and never public-approved", () => {
    const input = fixture();
    input.target.resourceLinks[0]!.status = "archived";

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references[0]).toMatchObject({ visibility: "private", publicApproved: false });
  });

  it("forces media for a private-quarantined property to remain private", () => {
    const input = fixture();
    input.target.propertyLinks[0]!.migrationDisposition = "private_quarantine";

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references[0]).toMatchObject({ visibility: "private", publicApproved: false });
  });

  it("retains suspended creator media as private", () => {
    const input = fixture();
    input.rows = [
      marketplaceRow("creators", {
        id: CREATOR,
        user_id: CREATOR_USER,
        profile_picture: HERO,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      }),
    ];
    input.target.propertyLinks = [];
    input.target.resourceLinks = [
      {
        organizationId: CREATOR_ORGANIZATION,
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: CREATOR,
        relationship: "owner",
        status: "suspended",
      },
    ];

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references[0]).toMatchObject({ visibility: "private", publicApproved: false });
  });

  it("retains archived PMS room media as private", () => {
    const input = fixture();
    input.rows = [
      pmsRow("room_types", {
        id: CREATOR,
        hotel_id: HOTEL,
        images: [HERO],
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      }),
    ];
    input.target.propertyLinks = [
      {
        sourceSystem: "pms",
        sourceTable: "hotels",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: RUN,
      },
    ];
    input.target.resourceLinks = [
      {
        organizationId: ORGANIZATION,
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: HOTEL,
        relationship: "operator",
        status: "archived",
      },
    ];

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references[0]).toMatchObject({ visibility: "private", publicApproved: false });
  });

  it("quarantines a malformed URL and continues valid media later on the same row", () => {
    const input = fixture();
    input.rows[0]!.data["hero_image"] =
      "http://legacy-media-test.s3.amazonaws.com/hotels/unsafe.jpg";
    input.rows[0]!.data["images"] = [LOGO];

    const plan = buildProductionMediaPlan(input);
    expect(plan.references).toHaveLength(1);
    expect(plan.references[0]).toMatchObject({
      sourceRowId: `${HOTEL}:images:1`,
      sourceUrl: LOGO,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.quarantines).toEqual([
      expect.objectContaining({
        sourceSystem: "booking",
        sourceTable: "booking_hotels",
        sourceRowId: `${HOTEL}:hero_image`,
        sourceField: "hero_image",
        purpose: "property.hero_image",
        reasonCode: "INVALID_HTTPS_URL",
        sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(plan.quarantines)).not.toContain("unsafe.jpg");
  });

  it("quarantines a malformed PMS image array without copying its value", () => {
    const input = fixture();
    input.rows = [
      pmsRow("room_types", {
        id: CREATOR,
        hotel_id: HOTEL,
        images: { stale: HERO },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      }),
    ];
    input.target.propertyLinks = [
      {
        sourceSystem: "pms",
        sourceTable: "hotels",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: RUN,
      },
    ];
    input.target.resourceLinks = [
      {
        organizationId: ORGANIZATION,
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: HOTEL,
        relationship: "operator",
        status: "active",
      },
    ];

    const plan = buildProductionMediaPlan(input);

    expect(plan.references).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.quarantines).toEqual([
      expect.objectContaining({
        sourceSystem: "pms",
        sourceTable: "room_types",
        sourceRowId: `${CREATOR}:images`,
        sourceField: "images",
        purpose: "pms.room_type.media",
        reasonCode: "INVALID_STRING_ARRAY",
      }),
    ]);
    expect(JSON.stringify(plan.quarantines)).not.toContain(HERO);
  });

  it("prefers a valid PMS S3 key without parsing an unused malformed source URL", () => {
    const input = fixture();
    input.rows = [
      pmsRow("message_threads", { id: COLLABORATION, hotel_id: HOTEL }),
      pmsRow("messages", { id: MESSAGE, thread_id: COLLABORATION }),
      pmsRow("message_attachments", {
        id: CREATOR,
        message_id: MESSAGE,
        s3_key: "messages/photo.jpg",
        source_url: { stale: HERO },
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      }),
    ];
    input.target.propertyLinks = [
      {
        sourceSystem: "pms",
        sourceTable: "hotels",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: RUN,
      },
    ];
    input.target.resourceLinks = [
      {
        organizationId: ORGANIZATION,
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: HOTEL,
        relationship: "operator",
        status: "active",
      },
    ];

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.quarantines).toEqual([]);
    expect(plan.references).toEqual([
      expect.objectContaining({
        sourceField: "s3_key",
        sourceUrl: "https://legacy-media-test.s3.amazonaws.com/messages/photo.jpg",
      }),
    ]);

    input.rows[2]!.data["s3_key"] = null;
    const fallback = buildProductionMediaPlan(input);
    expect(fallback.blockers).toEqual([]);
    expect(fallback.references).toEqual([]);
    expect(fallback.quarantines).toEqual([
      expect.objectContaining({
        sourceRowId: `${CREATOR}:source_url`,
        sourceField: "source_url",
        reasonCode: "INVALID_HTTPS_URL",
      }),
    ]);

    Object.assign(input.rows[2]!.data, { s3_key: " \t ", source_url: null });
    const missing = buildProductionMediaPlan(input);
    expect(missing.blockers).toEqual([]);
    expect(missing.references).toEqual([]);
    expect(missing.quarantines).toEqual([]);

    input.rows[2]!.data["source_url"] = HERO;
    const urlOnly = buildProductionMediaPlan(input);
    expect(urlOnly.blockers).toEqual([]);
    expect(urlOnly.quarantines).toEqual([]);
    expect(urlOnly.references).toEqual([
      expect.objectContaining({ sourceField: "source_url", sourceUrl: HERO }),
    ]);
  });

  it("uses a safe filename fallback for a valid URL with malformed percent escapes", () => {
    const input = fixture();
    input.rows[0]!.data["hero_image"] =
      "https://legacy-media-test.s3.amazonaws.com/hotels/%E0%A4%A";

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references[0]).toMatchObject({ originalFilename: "legacy-media" });
  });

  it.each([
    ["creator", CREATOR_USER, CREATOR_ORGANIZATION],
    ["hotel", HOTEL_USER, ORGANIZATION],
  ])(
    "owns a %s chat image by its sender and preserves its retention",
    (_side, senderId, ownerId) => {
      const input = fixture();
      input.rows = [
        marketplaceRow("hotel_profiles", { id: HOTEL, user_id: HOTEL_USER }),
        marketplaceRow("creators", { id: CREATOR, user_id: CREATOR_USER }),
        marketplaceRow("collaborations", {
          id: COLLABORATION,
          hotel_id: HOTEL,
          creator_id: CREATOR,
        }),
        marketplaceRow("chat_messages", {
          id: MESSAGE,
          collaboration_id: COLLABORATION,
          sender_id: senderId,
          message_type: "image",
          content: "https://legacy-media-test.s3.amazonaws.com/chat/private.jpg",
          metadata: {},
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        }),
      ];
      input.target.propertyLinks = [
        {
          sourceSystem: "marketplace",
          sourceTable: "hotel_profiles",
          sourceId: HOTEL,
          propertyId: PROPERTY,
          relationship: "profile_input",
          status: "active",
          migrationRunId: RUN,
        },
      ];
      input.target.resourceLinks = [
        {
          organizationId: ORGANIZATION,
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: HOTEL,
          relationship: "owner",
          status: "active",
        },
        {
          organizationId: CREATOR_ORGANIZATION,
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: CREATOR,
          relationship: "owner",
          status: "active",
        },
      ];

      const plan = buildProductionMediaPlan(input);

      expect(plan.blockers).toEqual([]);
      expect(plan.references).toEqual([
        expect.objectContaining({
          purpose: "marketplace.collaboration_chat.attachment",
          ownerOrganizationId: ownerId,
          retainedUntil: "2028-08-01T00:00:00.000Z",
          visibility: "private",
        }),
      ]);
    },
  );

  it("does not copy a Marketplace chat image whose retention already expired", () => {
    const input = fixture();
    input.rows = [
      marketplaceRow("hotel_profiles", { id: HOTEL, user_id: HOTEL_USER }),
      marketplaceRow("creators", { id: CREATOR, user_id: CREATOR_USER }),
      marketplaceRow("collaborations", {
        id: COLLABORATION,
        hotel_id: HOTEL,
        creator_id: CREATOR,
      }),
      marketplaceRow("chat_messages", {
        id: MESSAGE,
        collaboration_id: COLLABORATION,
        sender_id: CREATOR_USER,
        message_type: "image",
        content: "https://legacy-media-test.s3.amazonaws.com/chat/expired.jpg",
        metadata: {},
        created_at: "2023-08-01T00:00:00Z",
        updated_at: "2023-08-02T00:00:00Z",
      }),
    ];
    input.target.propertyLinks = [
      {
        sourceSystem: "marketplace",
        sourceTable: "hotel_profiles",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "profile_input",
        status: "active",
        migrationRunId: RUN,
      },
    ];
    input.target.resourceLinks = [
      {
        organizationId: ORGANIZATION,
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: HOTEL,
        relationship: "owner",
        status: "active",
      },
      {
        organizationId: CREATOR_ORGANIZATION,
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: CREATOR,
        relationship: "owner",
        status: "active",
      },
    ];

    const plan = buildProductionMediaPlan(input);

    expect(plan.blockers).toEqual([]);
    expect(plan.references).toEqual([]);
  });
});

function fixture(): {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionMediaTargetState;
  legacyPmsBucket: string;
  targetBucket: string;
  cdnBaseUrl: string;
} {
  return {
    sourceRunId: RUN,
    completedAt: "2026-08-30T00:00:00.000Z",
    rows: [
      row("booking_hotels", {
        id: HOTEL,
        hero_image: HERO,
        images: [],
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      }),
    ],
    target: {
      propertyLinks: [
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: HOTEL,
          propertyId: PROPERTY,
          relationship: "canonical_input",
          status: "active",
          migrationRunId: RUN,
        },
      ],
      resourceLinks: [
        {
          organizationId: ORGANIZATION,
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: HOTEL,
          relationship: "owner",
          status: "active",
        },
      ],
      mediaObjects: [],
    },
    legacyPmsBucket: "legacy-media-test",
    targetBucket: "platform-media-test",
    cdnBaseUrl: "https://media.example.test",
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "booking", sourceTable, rowOrdinal: 1, data };
}

function marketplaceRow(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "marketplace", sourceTable, rowOrdinal: 1, data };
}

function pmsRow(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
