import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPgHotelMediaResolutionPort,
  type PgHotelMediaResolverConfig,
} from "./hotelMediaResolver.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstMediaId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secondMediaId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const otherOrganizationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const otherPropertyId = "11111111-1111-4111-8111-111111111111";

type StoredVariant = {
  variantName: string;
  visibility: string;
  storageKey: string;
  contentType: string;
  publicUrl: string | null;
};

type StoredMedia = {
  mediaObjectId: string;
  bucket: string | null;
  storageKey: string | null;
  storageKind: string;
  visibility: string;
  purpose: string;
  ownerOrganizationId: string;
  propertyId: string;
  lifecycleStatus: string;
  contentType: string | null;
  publicApproved: boolean;
  variants: StoredVariant[];
};

type ResolverPool = NonNullable<PgHotelMediaResolverConfig["pool"]>;

function validMedia(
  mediaObjectId = firstMediaId,
  overrides: Partial<StoredMedia> = {},
): StoredMedia {
  return {
    mediaObjectId,
    bucket: "vayada-media-test",
    storageKey: `public/media/${mediaObjectId}/original_safe/v1.webp`,
    storageKind: "vayada_managed",
    visibility: "public",
    purpose: "property.gallery_image",
    ownerOrganizationId: organizationId,
    propertyId,
    lifecycleStatus: "active",
    contentType: "image/webp",
    publicApproved: true,
    variants: [
      {
        variantName: "original_safe",
        visibility: "public",
        storageKey: `public/media/${mediaObjectId}/original_safe/v1.webp`,
        contentType: "image/webp",
        publicUrl: `https://cdn.example.test/media/${mediaObjectId}/original_safe/v1.webp`,
      },
      {
        variantName: "thumbnail",
        visibility: "public",
        storageKey: `public/media/${mediaObjectId}/thumbnail/v1.webp`,
        contentType: "image/webp",
        publicUrl: `https://cdn.example.test/media/${mediaObjectId}/thumbnail/v1.webp`,
      },
    ],
    ...overrides,
  };
}

function harness(
  media: StoredMedia[],
  options: { targetAuthorized?: boolean } = {},
): {
  resolver: ReturnType<typeof createPgHotelMediaResolutionPort>;
  queries: { text: string; values: readonly unknown[] }[];
  end: ReturnType<typeof vi.fn>;
} {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const end = vi.fn(async () => undefined);
  const byId = new Map(media.map((item) => [item.mediaObjectId, item]));
  const pool: ResolverPool = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      queries.push({ text, values });
      if (text.includes("hotel_media_target_resolution")) {
        return {
          rows: [{ authorized: options.targetAuthorized ?? true }] as unknown as T[],
        };
      }
      const requestedIds = values[3] as string[];
      const ownerScope = values[0];
      const propertyScope = values[1];
      return {
        rows: requestedIds.map((requestedMediaObjectId, index) => {
          const stored = byId.get(requestedMediaObjectId);
          const scoped =
            stored?.ownerOrganizationId === ownerScope && stored?.propertyId === propertyScope;
          return {
            requestOrdinal: index + 1,
            requestedMediaObjectId,
            resolution: !stored ? "not_found" : scoped ? "scoped" : "not_authorized",
            mediaObjectId: scoped ? stored!.mediaObjectId : null,
            bucket: scoped ? stored!.bucket : null,
            storageKey: scoped ? stored!.storageKey : null,
            storageKind: scoped ? stored!.storageKind : null,
            visibility: scoped ? stored!.visibility : null,
            purpose: scoped ? stored!.purpose : null,
            ownerOrganizationId: scoped ? stored!.ownerOrganizationId : null,
            propertyId: scoped ? stored!.propertyId : null,
            lifecycleStatus: scoped ? stored!.lifecycleStatus : null,
            contentType: scoped ? stored!.contentType : null,
            publicApproved: scoped ? stored!.publicApproved : null,
            variants: scoped ? stored!.variants : [],
          } as unknown as T;
        }),
      };
    },
    end,
  };
  return {
    resolver: createPgHotelMediaResolutionPort({
      connectionString: "postgresql://unused",
      serving: {
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test",
        publicPathPrefix: "media",
      },
      pool,
    }),
    queries,
    end,
  };
}

describe("persistent hotel media resolver", () => {
  it("preserves requested order and duplicates as deeply immutable property snapshots", async () => {
    const first = validMedia(firstMediaId, { purpose: "property.logo" });
    const second = validMedia(secondMediaId, { purpose: "pms.room_type.media" });
    const { resolver, queries, end } = harness([first, second]);

    const result = await resolver.resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [secondMediaId, firstMediaId, secondMediaId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media.map(({ mediaObjectId }) => mediaObjectId)).toEqual([
      secondMediaId,
      firstMediaId,
      secondMediaId,
    ]);
    expect(result.media.map(({ purpose }) => purpose)).toEqual([
      "pms.room_type.media",
      "property.logo",
      "pms.room_type.media",
    ]);
    expect(Object.isFrozen(result.resolvedTarget)).toBe(true);
    expect(Object.isFrozen(result.resolvedTarget.target)).toBe(true);
    expect(Object.isFrozen(result.media)).toBe(true);
    expect(Object.isFrozen(result.media[0])).toBe(true);
    expect(Object.isFrozen(result.media[0]!.publicVariants)).toBe(true);
    expect(Object.isFrozen(result.media[0]!.publicVariants[0])).toBe(true);

    second.variants[0]!.publicUrl = "https://attacker.example/changed.webp";
    expect(result.media[0]!.publicVariants[0].publicUrl).toContain("cdn.example.test");
    expect(queries[1]!.values[3]).toEqual([secondMediaId, firstMediaId, secondMediaId]);
    expect(queries[1]!.text).toContain("media.owner_organization_id = $1::uuid");
    expect(queries[1]!.text).toContain("property.id = $2::uuid");
    expect(queries[1]!.text).toContain(
      "JOIN authorized_target target ON target.property_id = media.property_id",
    );

    await resolver.close?.();
    expect(end).not.toHaveBeenCalled();
  });

  it("proves a room belongs to the property while allowing shared property media", async () => {
    const { resolver, queries } = harness([validMedia()]);
    const result = await resolver.resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "room_type", propertyId, roomTypeId },
      mediaObjectIds: [firstMediaId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedTarget).toMatchObject({
      ownerOrganizationId: organizationId,
      target: { kind: "room_type", propertyId, roomTypeId },
    });
    expect(queries[0]!.values).toEqual([organizationId, propertyId, roomTypeId]);
    expect(queries[0]!.text).toContain("room_type.id = $3::uuid");
    expect(queries[0]!.text).toContain("room_type.property_id = property.id");
    expect(queries[0]!.text).toContain("link.product = 'hotel_catalog'");
    expect(queries[0]!.text).toContain("link.relationship IN ('owner', 'operator')");
  });

  it("fails target and media cross-scope checks without exposing media rows", async () => {
    for (const input of [
      {
        ownerOrganizationId: otherOrganizationId,
        target: { kind: "property" as const, propertyId },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "property" as const, propertyId: otherPropertyId },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "room_type" as const, propertyId, roomTypeId },
      },
    ]) {
      const { resolver, queries } = harness([validMedia()], { targetAuthorized: false });
      await expect(
        resolver.resolvePublicMedia({ ...input, mediaObjectIds: [firstMediaId] }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
      });
      expect(queries).toHaveLength(1);
    }

    for (const media of [
      validMedia(firstMediaId, { ownerOrganizationId: otherOrganizationId }),
      validMedia(firstMediaId, { propertyId: otherPropertyId }),
    ]) {
      const { resolver } = harness([media]);
      await expect(
        resolver.resolvePublicMedia({
          ownerOrganizationId: organizationId,
          target: { kind: "property", propertyId },
          mediaObjectIds: [firstMediaId, firstMediaId],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
      });
    }
  });

  it("classifies missing objects and unsupported hotel purposes safely", async () => {
    const missing = harness([]);
    await expect(
      missing.resolver.resolvePublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_found", mediaObjectIds: [firstMediaId] },
    });

    const unsupported = harness([validMedia(firstMediaId, { purpose: "marketplace.offer.media" })]);
    await expect(
      unsupported.resolver.resolvePublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
    });
  });

  it.each([
    ["private", { visibility: "private" }],
    ["not approved", { publicApproved: false }],
    ["staged lifecycle", { lifecycleStatus: "staged" }],
    ["external storage", { storageKind: "external_reference", bucket: null, storageKey: null }],
    ["non-image object", { contentType: "application/pdf" }],
    ["staging object key", { storageKey: `staging/session/${firstMediaId}.webp` }],
    ["wrong bucket", { bucket: "other-media-bucket" }],
  ] satisfies [string, Partial<StoredMedia>][])(
    "rejects a %s media object as not ready",
    async (_label, overrides) => {
      const { resolver } = harness([validMedia(firstMediaId, overrides)]);
      await expect(
        resolver.resolvePublicMedia({
          ownerOrganizationId: organizationId,
          target: { kind: "property", propertyId },
          mediaObjectIds: [firstMediaId],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_ready", mediaObjectIds: [firstMediaId] },
      });
    },
  );

  it.each([
    [
      "wrong CDN",
      [
        {
          ...validMedia().variants[0]!,
          publicUrl: `https://elsewhere.example/media/${firstMediaId}/original_safe/v1.webp`,
        },
      ],
    ],
    [
      "wrong CDN path",
      [
        {
          ...validMedia().variants[0]!,
          publicUrl: `https://cdn.example.test/private/${firstMediaId}/original_safe/v1.webp`,
        },
      ],
    ],
    [
      "staging variant key",
      [
        {
          ...validMedia().variants[0]!,
          storageKey: `staging/session/${firstMediaId}.webp`,
        },
      ],
    ],
    [
      "non-image variant",
      [
        {
          ...validMedia().variants[0]!,
          contentType: "application/pdf",
        },
      ],
    ],
    [
      "unsupported provider_original variant",
      [
        validMedia().variants[0]!,
        {
          ...validMedia().variants[1]!,
          variantName: "provider_original",
        },
      ],
    ],
    ["missing original_safe", [{ ...validMedia().variants[1]!, variantName: "large" }]],
  ] satisfies [string, StoredVariant[]][])(
    "rejects %s variants as not ready",
    async (_label, variants) => {
      const { resolver } = harness([validMedia(firstMediaId, { variants })]);
      await expect(
        resolver.resolvePublicMedia({
          ownerOrganizationId: organizationId,
          target: { kind: "property", propertyId },
          mediaObjectIds: [firstMediaId],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_ready", mediaObjectIds: [firstMediaId] },
      });
    },
  );
});
