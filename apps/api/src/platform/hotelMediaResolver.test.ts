import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
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
  options: {
    targetAuthorized?: boolean;
    afterTargetQuery?: () => void;
    targetResult?: unknown;
    transformMediaRows?: (rows: unknown[]) => unknown[];
  } = {},
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
        options.afterTargetQuery?.();
        if (options.targetResult) return options.targetResult as never;
        return {
          rows: [{ authorized: options.targetAuthorized ?? true }] as unknown as T[],
        };
      }
      const requestedIds = values[3] as string[];
      const ownerScope = values[0];
      const propertyScope = values[1];
      const rows = requestedIds.map((requestedMediaObjectId, index) => {
        const stored = byId.get(requestedMediaObjectId);
        const scoped =
          stored?.ownerOrganizationId === ownerScope && stored?.propertyId === propertyScope;
        return {
          requestOrdinal: index + 1,
          resolution: !stored || !scoped ? "not_found" : "scoped",
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
      });
      return {
        rows: (options.transformMediaRows?.(rows) ?? rows) as T[],
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
  it("feeds ordered detached snapshots into the opaque trusted-batch port", async () => {
    const first = validMedia(firstMediaId, { purpose: "property.logo" });
    const second = validMedia(secondMediaId, { purpose: "property.gallery_image" });
    const { resolver, queries, end } = harness([first, second]);

    const result = await createHotelMediaResolutionPort(resolver).resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [secondMediaId, firstMediaId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.media.map(({ mediaObjectId }) => mediaObjectId)).toEqual([
      secondMediaId,
      firstMediaId,
    ]);
    expect(result.batch.media.map(({ purpose }) => purpose)).toEqual([
      "property.gallery_image",
      "property.logo",
    ]);
    expect(Object.isFrozen(result.batch)).toBe(true);
    expect(Object.isFrozen(result.batch.target)).toBe(true);
    expect(Object.isFrozen(result.batch.media)).toBe(true);
    expect(Object.isFrozen(result.batch.media[0])).toBe(true);
    expect(Object.isFrozen(result.batch.media[0]!.publicVariants)).toBe(true);
    expect(Object.isFrozen(result.batch.media[0]!.publicVariants[0])).toBe(true);

    second.variants[0]!.publicUrl = "https://attacker.example/changed.webp";
    expect(result.batch.media[0]!.publicVariants[0].publicUrl).toContain("cdn.example.test");
    expect(queries[1]!.values[3]).toEqual([secondMediaId, firstMediaId]);
    expect(queries[1]!.text).toContain("media.owner_organization_id = $1::uuid");
    expect(queries[1]!.text).toContain("property.id = $2::uuid");
    expect(queries[1]!.text).toContain(
      "JOIN authorized_target target ON target.property_id = media.property_id",
    );
    expect(queries[1]!.text).not.toContain("platform.media_objects candidate");

    await resolver.close?.();
    expect(end).not.toHaveBeenCalled();
  });

  it("proves a room belongs to the property while allowing shared property media", async () => {
    const { resolver, queries } = harness([validMedia()]);
    const result = await resolver.loadPublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "room_type", propertyId, roomTypeId },
      mediaObjectIds: [firstMediaId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedTarget).toEqual({ kind: "room_type", propertyId, roomTypeId });
    expect(queries[0]!.values).toEqual([organizationId, propertyId, roomTypeId]);
    expect(queries[0]!.text).toContain("room_type.id = $3::uuid");
    expect(queries[0]!.text).toContain("room_type.property_id = property.id");
    expect(queries[0]!.text).toContain("AND EXISTS (");
    expect(queries[0]!.text).not.toContain("JOIN identity.organization_resource_links");
    expect(queries[0]!.text).toContain("link.product = 'hotel_catalog'");
    expect(queries[0]!.text).toContain("link.relationship IN ('owner', 'operator')");
  });

  it("uses one immutable target snapshot across asynchronous resolution", async () => {
    const target: {
      kind: "property" | "not_room_type";
      propertyId: string;
      roomTypeId?: string;
    } = { kind: "property", propertyId };
    const { resolver, queries } = harness([validMedia()], {
      afterTargetQuery() {
        target.kind = "not_room_type";
        target.propertyId = otherPropertyId;
        target.roomTypeId = roomTypeId;
      },
    });

    const result = await resolver.loadPublicMedia({
      ownerOrganizationId: organizationId,
      target: target as never,
      mediaObjectIds: [firstMediaId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolvedTarget).toEqual({ kind: "property", propertyId });
    expect(queries[0]!.values).toEqual([organizationId, propertyId, null]);
    expect(queries[1]!.values.slice(0, 3)).toEqual([organizationId, propertyId, null]);
  });

  it("uses one immutable media-id snapshot across asynchronous resolution", async () => {
    const mediaObjectIds = [firstMediaId];
    const { resolver, queries } = harness([validMedia()], {
      afterTargetQuery() {
        mediaObjectIds[0] = secondMediaId;
        mediaObjectIds.push(secondMediaId);
      },
    });

    const result = await resolver.loadPublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds,
    });

    expect(result.ok).toBe(true);
    expect(queries[1]!.values[3]).toEqual([firstMediaId]);
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
        resolver.loadPublicMedia({ ...input, mediaObjectIds: [firstMediaId] }),
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
        resolver.loadPublicMedia({
          ownerOrganizationId: organizationId,
          target: { kind: "property", propertyId },
          mediaObjectIds: [firstMediaId],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_found", mediaObjectIds: [firstMediaId] },
      });
    }
  });

  it("classifies missing objects and unsupported hotel purposes safely", async () => {
    const missing = harness([]);
    await expect(
      missing.resolver.loadPublicMedia({
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
      unsupported.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
    });
  });

  it("returns typed failures for malformed identifiers without sending invalid UUID casts", async () => {
    for (const input of [
      {
        ownerOrganizationId: "not-an-organization",
        target: { kind: "property" as const, propertyId },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "property" as const, propertyId: "not-a-property" },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "room_type" as const, propertyId, roomTypeId: "not-a-room" },
      },
    ]) {
      const { resolver, queries } = harness([validMedia()]);
      await expect(
        resolver.loadPublicMedia({ ...input, mediaObjectIds: [firstMediaId] }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
      });
      expect(queries).toHaveLength(0);
    }

    const { resolver, queries } = harness([validMedia()]);
    await expect(
      resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: ["not-media", "not-media"],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_found", mediaObjectIds: ["not-media"] },
    });
    expect(queries).toHaveLength(1);

    const unknownTarget = harness([validMedia()]);
    await expect(
      unknownTarget.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: {
          kind: "not_room_type",
          propertyId: otherPropertyId,
          roomTypeId,
        } as never,
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_authorized", mediaObjectIds: [firstMediaId] },
    });
    expect(unknownTarget.queries).toHaveLength(0);
  });

  it("accepts every PostgreSQL UUID version while retaining RFC variant bits", async () => {
    for (const mediaObjectId of [
      "00000000-0000-0000-8000-000000000001",
      "00000000-0000-7000-9000-000000000002",
      "00000000-0000-8000-a000-000000000003",
    ]) {
      const { resolver } = harness([validMedia(mediaObjectId)]);
      const result = await resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [mediaObjectId],
      });
      expect(result.ok).toBe(true);
    }

    const { resolver, queries } = harness([]);
    await expect(
      resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: ["00000000-0000-7000-7000-000000000004"],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "media_not_found" } });
    expect(queries).toHaveLength(1);
  });

  it("rejects hostile caller shapes without invoking accessors", async () => {
    const { resolver, queries } = harness([validMedia()]);
    let getterCalls = 0;
    const accessor = {
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "mediaObjectIds", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [firstMediaId];
      },
    });
    await expect(resolver.loadPublicMedia(accessor as never)).resolves.toMatchObject({ ok: false });

    const sparse = new Array(1);
    await expect(
      resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: sparse,
      } as never),
    ).resolves.toMatchObject({ ok: false });

    class MediaIds extends Array<string> {}
    await expect(
      resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: new MediaIds(firstMediaId),
      } as never),
    ).resolves.toMatchObject({ ok: false });

    expect(getterCalls).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("requires exact database result cardinality and plain data rows", async () => {
    const extraTarget = harness([validMedia()], {
      targetResult: { rows: [{ authorized: true }, { authorized: true }] },
    });
    await expect(
      extraTarget.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "media_not_authorized" } });

    const extra = harness([validMedia()], {
      transformMediaRows: (rows) => [...rows, rows[0]],
    });
    await expect(
      extra.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_found", mediaObjectIds: [firstMediaId] },
    });

    let rowGetterCalls = 0;
    const hostileRow = harness([validMedia()], {
      transformMediaRows(rows) {
        const row = { ...(rows[0] as Record<string, unknown>) };
        Object.defineProperty(row, "mediaObjectId", {
          enumerable: true,
          get() {
            rowGetterCalls += 1;
            return firstMediaId;
          },
        });
        return [row];
      },
    });
    await expect(
      hostileRow.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "media_not_found" } });
    expect(rowGetterCalls).toBe(0);

    let rowsGetterCalls = 0;
    const hostileResult = {};
    Object.defineProperty(hostileResult, "rows", {
      enumerable: true,
      get() {
        rowsGetterCalls += 1;
        return [{ authorized: true }];
      },
    });
    const target = harness([validMedia()], { targetResult: hostileResult });
    await expect(
      target.resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "media_not_authorized" } });
    expect(rowsGetterCalls).toBe(0);
  });

  it("rejects accessor-backed variant snapshots without invoking them", async () => {
    let getterCalls = 0;
    const variant = {
      visibility: "public",
      storageKey: `public/media/${firstMediaId}/original_safe/v1.webp`,
      contentType: "image/webp",
      publicUrl: `https://cdn.example.test/media/${firstMediaId}/original_safe/v1.webp`,
    } as Record<string, unknown>;
    Object.defineProperty(variant, "variantName", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "original_safe";
      },
    });
    const { resolver } = harness([
      validMedia(firstMediaId, { variants: [variant as unknown as StoredVariant] }),
    ]);
    await expect(
      resolver.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [firstMediaId],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "media_not_ready" } });
    expect(getterCalls).toBe(0);
  });

  it("requires canonical serving configuration values", () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) } as unknown as ResolverPool;
    for (const serving of [
      {
        bucketName: " vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test",
        publicPathPrefix: "media",
      },
      {
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test/",
        publicPathPrefix: "media",
      },
      {
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test:443",
        publicPathPrefix: "media",
      },
      {
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test",
        publicPathPrefix: "/media/",
      },
    ]) {
      expect(() =>
        createPgHotelMediaResolutionPort({
          connectionString: "postgresql://unused",
          serving,
          pool,
        }),
      ).toThrow(/canonical|safe non-empty path/);
    }
  });

  it.each([
    ["private", { visibility: "private" }],
    ["not approved", { publicApproved: false }],
    ["staged lifecycle", { lifecycleStatus: "staged" }],
    ["external storage", { storageKind: "external_reference", bucket: null, storageKey: null }],
    ["non-image object", { contentType: "application/pdf" }],
    ["active SVG object", { contentType: "image/svg+xml" }],
    ["staging object key", { storageKey: `staging/session/${firstMediaId}.webp` }],
    [
      "another media object's key",
      {
        storageKey: `public/media/${secondMediaId}/original_safe/v1.webp`,
      },
    ],
    ["wrong bucket", { bucket: "other-media-bucket" }],
  ] satisfies [string, Partial<StoredMedia>][])(
    "rejects a %s media object as not ready",
    async (_label, overrides) => {
      const { resolver } = harness([validMedia(firstMediaId, overrides)]);
      await expect(
        resolver.loadPublicMedia({
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
      "URL normalized from an explicit default port",
      [
        {
          ...validMedia().variants[0]!,
          publicUrl: `https://cdn.example.test:443/media/${firstMediaId}/original_safe/v1.webp`,
        },
      ],
    ],
    [
      "percent-encoded canonical filename",
      [
        {
          ...validMedia().variants[0]!,
          publicUrl: `https://cdn.example.test/media/${firstMediaId}/original_safe/%761.webp`,
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
      "another media object's variant",
      [
        {
          ...validMedia().variants[0]!,
          storageKey: `public/media/${secondMediaId}/original_safe/v1.webp`,
          publicUrl: `https://cdn.example.test/media/${secondMediaId}/original_safe/v1.webp`,
        },
      ],
    ],
    ...[
      ["%2e encoded traversal", "%2e/%2e"],
      ["%2e%2e encoded traversal", "%2e%2e/%2e%2e"],
      ["mixed-case encoded traversal", "%2E%2e/%2e%2E"],
      ["backslash traversal", String.raw`..\..`],
    ].map(
      ([label, traversal]) =>
        [
          label,
          [
            {
              ...validMedia().variants[0]!,
              storageKey:
                `public/media/${firstMediaId}/original_safe/${traversal}/` +
                `${secondMediaId}/original_safe/v1.webp`,
              publicUrl: `https://cdn.example.test/media/${secondMediaId}/original_safe/v1.webp`,
            },
          ],
        ] as [string, StoredVariant[]],
    ),
    [
      "mismatched variant path",
      [
        {
          ...validMedia().variants[0]!,
          storageKey: `public/media/${firstMediaId}/thumbnail/v1.webp`,
          publicUrl: `https://cdn.example.test/media/${firstMediaId}/thumbnail/v1.webp`,
        },
      ],
    ],
    [
      "URL and storage-key mismatch",
      [
        {
          ...validMedia().variants[0]!,
          publicUrl: `https://cdn.example.test/media/${firstMediaId}/original_safe/v2.webp`,
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
      "active SVG variant",
      [
        {
          ...validMedia().variants[0]!,
          contentType: "image/svg+xml",
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
        resolver.loadPublicMedia({
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
