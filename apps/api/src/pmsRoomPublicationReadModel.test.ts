import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  type RoomCapacityReadPort,
  type RoomFactsReadPort,
  type RoomAmenityVocabularyValidationPort,
} from "@vayada/domain-pms";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgPmsRoomPublicationReadModel,
  type PmsRoomPublicationReadPool,
} from "./domains/pmsRoomPublicationReadModel.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPropertyId = "11111111-1111-4111-8111-111111111111";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const activeFacts = required(
  parseRoomTypeFactsSnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision: 3,
    lifecycle: "active",
    facts: {
      name: "Garden Suite",
      description: "A calm room facing the garden.",
      category: "suite",
      occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "king", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 32, unit: "sqm" },
    },
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-03T08:00:00.000Z",
  }),
  "test room facts are invalid",
);

const capacity = required(
  parseRoomTypeCapacitySnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitsRevision: 4,
    activeUnitCount: 2,
    capturedAt: "2026-08-03T08:00:00.000Z",
  }),
  "test room capacity is invalid",
);

describe("PMS room publication read model", () => {
  it("reauthorizes exact caller scope and builds a public-safe ready snapshot", async () => {
    const target = readTarget();
    const factsCalls: string[] = [];
    const capacityCalls: string[][] = [];
    const resolverCalls: unknown[] = [];
    const model = createModel(target, {
      facts: {
        async getRoomTypeFacts() {
          return null;
        },
        async listRoomTypeFacts(requestedPropertyId) {
          factsCalls.push(requestedPropertyId);
          return [activeFacts];
        },
      },
      capacity: {
        async getRoomTypeCapacity(requestedPropertyId, requestedRoomTypeId) {
          capacityCalls.push([requestedPropertyId, requestedRoomTypeId]);
          return capacity;
        },
      },
      resolverCalls,
    });

    const snapshot = await model.getRoomPublicationSnapshot({ organizationId, propertyId });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0]).toMatchObject({
      propertyId,
      roomTypeId,
      activeUnitCount: 2,
      amenities: ["air_conditioning", "wifi"],
      sourceRevisions: {
        roomFactsRevision: 3,
        roomUnitsRevision: 4,
        roomMediaRevision: 5,
        roomAmenitiesRevision: 6,
      },
    });
    expect(snapshot.rooms[0]?.media).toEqual([
      {
        mediaObjectId,
        altText: "Garden suite",
        sortOrder: 0,
        publicVariants: [
          {
            variantName: "original_safe",
            publicUrl: `https://images.vayada.com/media/${mediaObjectId}/original_safe/v1.webp`,
          },
        ],
      },
    ]);
    expect(factsCalls).toEqual([propertyId, propertyId]);
    expect(capacityCalls).toEqual([
      [propertyId, roomTypeId],
      [propertyId, roomTypeId],
    ]);
    expect(target.scopeChecks).toEqual([
      [organizationId, propertyId],
      [organizationId, propertyId],
      [organizationId, propertyId],
    ]);
    expect(target.scopeSql).toHaveLength(3);
    expect(target.scopeSql.every((sql) => !sql.includes("SELECT count(*)"))).toBe(true);
    expect(
      target.scopeSql.every(
        (sql) =>
          sql.includes("link.product = 'pms'") && sql.includes("link.product = 'hotel_catalog'"),
      ),
    ).toBe(true);
    expect(resolverCalls).toEqual([
      {
        ownerOrganizationId: organizationId,
        target: { kind: "room_type", propertyId, roomTypeId },
        mediaObjectIds: [mediaObjectId],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("bucket");
    expect(JSON.stringify(snapshot)).not.toContain("storageKey");
  });

  it("keeps unreviewed legacy amenities private and emits the Step 4 room blocker", async () => {
    const target = readTarget({
      sourceRow: {
        roomAmenitiesRevision: 1,
        roomAmenitiesReviewedAt: null,
        amenitiesSnapshot: ["legacy_wifi"],
      },
    });
    const model = createModel(target);

    const snapshot = await model.getRoomPublicationSnapshot({ organizationId, propertyId });

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.rooms[0]?.amenities).toBeNull();
    expect(snapshot.blockers).toEqual([
      expect.objectContaining({
        code: "room_amenities_review_required",
        owningStepId: "rooms",
        affectedEntity: { entityType: "room_type", entityId: roomTypeId },
      }),
    ]);
  });

  it("fails closed when a reviewed stored amenity is no longer in the live vocabulary", async () => {
    const target = readTarget({
      sourceRow: {
        roomAmenitiesRevision: 2,
        roomAmenitiesReviewedAt: "2026-08-03T08:00:00.000Z",
        amenitiesSnapshot: ["retired_amenity"],
      },
    });
    const resolverCalls: unknown[] = [];
    const model = createModel(target, {
      resolverCalls,
      amenityVocabulary: {
        async validateRoomAmenities(keys) {
          return {
            ok: false,
            error: {
              code: "unsupported_room_amenity_keys",
              unsupportedAmenityKeys: [...keys],
            },
          };
        },
      },
    });

    await expect(model.getRoomPublicationSnapshot({ organizationId, propertyId })).rejects.toThrow(
      "vocabulary failed publication validation",
    );
    expect(resolverCalls).toHaveLength(0);
  });

  it("fails closed on a truthy non-boolean vocabulary result before resolving media", async () => {
    const target = readTarget();
    const resolverCalls: unknown[] = [];
    const malformedVocabulary = {
      async validateRoomAmenities() {
        return { ok: "yes" };
      },
    } as unknown as RoomAmenityVocabularyValidationPort;
    const model = createModel(target, {
      resolverCalls,
      amenityVocabulary: malformedVocabulary,
    });

    await expect(model.getRoomPublicationSnapshot({ organizationId, propertyId })).rejects.toThrow(
      "amenity vocabulary returned an invalid result",
    );
    expect(resolverCalls).toHaveLength(0);
  });

  it("publishes only the current media revision when trusted resolution is unavailable", async () => {
    const target = readTarget();
    const resolverCalls: unknown[] = [];
    const model = createModel(target, { resolverCalls, mediaOutcome: "not_ready" });

    const snapshot = await model.getRoomPublicationSnapshot({ organizationId, propertyId });

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.rooms[0]?.media).toEqual([]);
    expect(snapshot.rooms[0]?.sourceRevisions.roomMediaRevision).toBe(5);
    expect(snapshot.blockers.map(({ code }) => code)).toEqual(["room_media_unavailable"]);
    expect(JSON.stringify(snapshot)).not.toContain(mediaObjectId);
    expect(JSON.stringify(snapshot)).not.toContain("https://");
    expect(resolverCalls).toHaveLength(1);
  });

  it("fails closed when caller scope is revoked between source reads and media resolution", async () => {
    const target = readTarget({ authorized: [true, false] });
    const resolverCalls: unknown[] = [];
    const model = createModel(target, { resolverCalls });

    await expect(model.getRoomPublicationSnapshot({ organizationId, propertyId })).rejects.toThrow(
      "scope is unavailable",
    );
    expect(resolverCalls).toHaveLength(0);
    expect(target.scopeChecks).toEqual([
      [organizationId, propertyId],
      [organizationId, propertyId],
    ]);
  });

  it("fails closed when a versioned source changes while the snapshot is being built", async () => {
    const target = readTarget();
    let factsRead = 0;
    const model = createModel(target, {
      facts: {
        async getRoomTypeFacts() {
          return null;
        },
        async listRoomTypeFacts() {
          factsRead += 1;
          return factsRead === 1
            ? [activeFacts]
            : [{ ...activeFacts, roomFactsRevision: activeFacts.roomFactsRevision + 1 }];
        },
      },
    });

    await expect(model.getRoomPublicationSnapshot({ organizationId, propertyId })).rejects.toThrow(
      "sources changed while the snapshot was being built",
    );
  });

  it("fails closed on malformed amenity storage and cross-property supplemental rows", async () => {
    const malformed = createModel(readTarget({ sourceRow: { amenitiesSnapshot: { wifi: true } } }));
    await expect(
      malformed.getRoomPublicationSnapshot({ organizationId, propertyId }),
    ).rejects.toThrow("amenities storage failed publication validation");

    const escaped = createModel(readTarget({ sourceRow: { propertyId: otherPropertyId } }));
    await expect(
      escaped.getRoomPublicationSnapshot({ organizationId, propertyId }),
    ).rejects.toThrow("storage escaped its requested scope");
  });

  it("rejects sparse or accessor-backed assignment storage before invoking media resolution", async () => {
    const sparse = new Array(1);
    const sparseCalls: unknown[] = [];
    const sparseModel = createModel(readTarget({ sourceRow: { assignments: sparse } }), {
      resolverCalls: sparseCalls,
    });
    await expect(
      sparseModel.getRoomPublicationSnapshot({ organizationId, propertyId }),
    ).rejects.toThrow("assignments failed publication validation");
    expect(sparseCalls).toHaveLength(0);

    let accessed = 0;
    const accessorAssignments: unknown[] = [];
    Object.defineProperty(accessorAssignments, "0", {
      enumerable: true,
      configurable: true,
      get() {
        accessed += 1;
        return { mediaObjectId, altText: null, sortOrder: 0 };
      },
    });
    const accessorCalls: unknown[] = [];
    const accessorModel = createModel(
      readTarget({ sourceRow: { assignments: accessorAssignments } }),
      { resolverCalls: accessorCalls },
    );
    await expect(
      accessorModel.getRoomPublicationSnapshot({ organizationId, propertyId }),
    ).rejects.toThrow("assignments failed publication validation");
    expect(accessed).toBe(0);
    expect(accessorCalls).toHaveLength(0);
  });

  it("excludes inactive tombstones and returns a property blocker when no active room remains", async () => {
    const target = readTarget();
    const inactiveFacts = { ...activeFacts, lifecycle: "inactive" as const };
    const resolverCalls: unknown[] = [];
    const model = createModel(target, {
      facts: {
        async getRoomTypeFacts() {
          return inactiveFacts;
        },
        async listRoomTypeFacts() {
          return [inactiveFacts];
        },
      },
      resolverCalls,
    });

    const snapshot = await model.getRoomPublicationSnapshot({ organizationId, propertyId });

    expect(snapshot.rooms).toEqual([]);
    expect(snapshot.blockers).toEqual([
      expect.objectContaining({
        code: "room_type_required",
        affectedEntity: { entityType: "property", entityId: propertyId },
      }),
    ]);
    expect(target.sourceReads).toBe(0);
    expect(resolverCalls).toHaveLength(0);
  });
});

function createModel(
  target: ReturnType<typeof readTarget>,
  options: {
    facts?: RoomFactsReadPort;
    capacity?: RoomCapacityReadPort;
    resolverCalls?: unknown[];
    mediaOutcome?: "resolved" | "not_ready";
    amenityVocabulary?: RoomAmenityVocabularyValidationPort;
  } = {},
) {
  const resolverCalls = options.resolverCalls ?? [];
  return createPgPmsRoomPublicationReadModel({
    connectionString: "postgresql://pms-room-publication-read-test",
    pool: target.pool,
    roomFacts:
      options.facts ??
      ({
        async getRoomTypeFacts() {
          return activeFacts;
        },
        async listRoomTypeFacts() {
          return [activeFacts];
        },
      } satisfies RoomFactsReadPort),
    roomCapacity:
      options.capacity ??
      ({
        async getRoomTypeCapacity() {
          return capacity;
        },
      } satisfies RoomCapacityReadPort),
    amenityVocabulary:
      options.amenityVocabulary ??
      ({
        async validateRoomAmenities() {
          return { ok: true };
        },
      } satisfies RoomAmenityVocabularyValidationPort),
    mediaResolver: createHotelMediaResolutionPort({
      async loadPublicMedia(input) {
        resolverCalls.push(input);
        if (options.mediaOutcome === "not_ready") {
          return {
            ok: false as const,
            error: {
              code: "media_not_ready" as const,
              mediaObjectIds: [...input.mediaObjectIds],
            },
          };
        }
        return {
          ok: true as const,
          resolvedTarget: input.target,
          media: input.mediaObjectIds.map((id) => ({
            mediaObjectId: id,
            ownerOrganizationId: input.ownerOrganizationId,
            propertyId: input.target.propertyId,
            purpose: "property.gallery_image" as const,
            publicVariants: [
              {
                variantName: "original_safe" as const,
                publicUrl: `https://images.vayada.com/media/${id}/original_safe/v1.webp`,
              },
            ],
          })),
        };
      },
    }),
  });
}

function readTarget(
  options: {
    authorized?: boolean[];
    sourceRow?: Partial<{
      propertyId: string;
      roomTypeId: string;
      roomMediaRevision: number;
      roomAmenitiesRevision: number;
      roomAmenitiesReviewedAt: string | null;
      amenitiesSnapshot: unknown;
      assignments: unknown;
    }>;
  } = {},
) {
  const authorized = [...(options.authorized ?? [true, true, true])];
  const scopeChecks: string[][] = [];
  const scopeSql: string[] = [];
  let sourceReads = 0;
  const sourceRow = {
    propertyId,
    roomTypeId,
    roomMediaRevision: 5,
    roomAmenitiesRevision: 6,
    roomAmenitiesReviewedAt: "2026-08-03T08:00:00.000Z",
    amenitiesSnapshot: ["air_conditioning", "wifi"],
    assignments: [{ mediaObjectId, altText: "Garden suite", sortOrder: 0 }],
    ...options.sourceRow,
  };

  const pool: PmsRoomPublicationReadPool = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) {
      if (text.includes("pms_room_publication_scope")) {
        scopeChecks.push([String(values?.[0]), String(values?.[1])]);
        scopeSql.push(text);
        const value = authorized.shift() ?? false;
        return rows([{ authorized: value } as unknown as T]);
      }
      if (text.includes("pms_room_publication_sources")) {
        sourceReads += 1;
        return rows([{ ...sourceRow } as unknown as T]);
      }
      return rows<T>([]);
    },
  };

  return {
    pool,
    scopeChecks,
    scopeSql,
    get sourceReads() {
      return sourceReads;
    },
  };
}

function rows<T extends QueryResultRow>(items: T[]) {
  return { rows: items, rowCount: items.length };
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}
