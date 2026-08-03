import {
  createHotelMediaResolutionPort,
  type HotelMediaResolutionPort,
} from "@vayada/domain-hotels";
import {
  parseAssignRoomTypeMediaCommand,
  parseConfirmRoomTypeAmenitiesCommand,
  type RoomAmenityVocabularyValidationPort,
} from "@vayada/domain-pms";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgPmsRoomPublicationCommandRepository,
  type PmsRoomPublicationCommandPool,
} from "./domains/pmsRoomPublicationCommandRepository.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const mediaObjectId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const eventId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const idempotencyId = "11111111-1111-4111-8111-111111111111";
const acceptedAt = new Date("2026-08-03T09:00:00.000Z");

function mediaCommand(overrides: Record<string, unknown> = {}) {
  const parsed = parseAssignRoomTypeMediaCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRoomMediaRevision: 3,
    assignments: [{ mediaObjectId, altText: "Garden suite", sortOrder: 0 }],
    idempotencyKey: "assign-room-media",
    audit: {
      actor: { kind: "user", userId: actorId },
      requestId: "request-media-1",
      correlationId: "correlation-media-1",
      requestedAt: "2026-08-03T08:59:00.000Z",
    },
    ...overrides,
  });
  if (!parsed) throw new Error("test media command is invalid");
  return parsed;
}

function amenitiesCommand(overrides: Record<string, unknown> = {}) {
  const parsed = parseConfirmRoomTypeAmenitiesCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRoomAmenitiesRevision: 1,
    amenities: [],
    idempotencyKey: "confirm-room-amenities",
    audit: {
      actor: { kind: "user", userId: actorId },
      requestId: "request-amenities-1",
      correlationId: null,
      requestedAt: "2026-08-03T08:59:00.000Z",
    },
    ...overrides,
  });
  if (!parsed) throw new Error("test amenities command is invalid");
  return parsed;
}

function resolvingMediaPort(
  calls: unknown[],
  outcome: "resolved" | "not_ready" = "resolved",
): HotelMediaResolutionPort {
  return createHotelMediaResolutionPort({
    async loadPublicMedia(input) {
      calls.push(input);
      if (outcome === "not_ready") {
        return {
          ok: false as const,
          error: { code: "media_not_ready" as const, mediaObjectIds: [...input.mediaObjectIds] },
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
  });
}

const supportedAmenities: RoomAmenityVocabularyValidationPort = {
  async validateRoomAmenities() {
    return { ok: true };
  },
};

describe("PMS room publication command repository", () => {
  it("atomically references reusable media, increments once, and replays without side effects", async () => {
    const target = commandTarget();
    const resolverCalls: unknown[] = [];
    const repository = createRepository(target, resolvingMediaPort(resolverCalls));
    const command = mediaCommand();

    const assigned = await repository.assignRoomTypeMedia(command);
    const replayed = await repository.assignRoomTypeMedia(command);

    expect(assigned).toEqual(replayed);
    expect(assigned).toMatchObject({
      ok: true,
      response: { outcome: "assigned", roomMediaRevision: 4, assignments: command.assignments },
    });
    expect(target.roomMediaRevision).toBe(4);
    expect(target.roomMedia).toEqual([{ mediaObjectId, altText: "Garden suite", sortOrder: 0 }]);
    expect(resolverCalls).toEqual([
      {
        ownerOrganizationId: organizationId,
        target: { kind: "room_type", propertyId, roomTypeId },
        mediaObjectIds: [mediaObjectId],
      },
    ]);
    expect(target.events).toHaveLength(1);
    expect(target.events[0]).toMatchObject({
      eventType: "pms.room_media.assigned",
      eventVersion: 1,
      propertyId,
      roomTypeId,
      payload: {
        contractVersion: "pms-room-publication.v1",
        organizationId,
        propertyId,
        roomTypeId,
        outcome: "assigned",
        roomMediaRevision: 4,
        acceptedAt: acceptedAt.toISOString(),
      },
    });
    expect(target.events[0]?.payload).not.toHaveProperty("assignments");
    expect(target.events[0]?.payload).not.toHaveProperty("mediaObjectIds");
    expect(target.audits).toHaveLength(1);
    expect(target.commits).toBe(1);
    expect(target.sql()).not.toContain("platform.outbox_events");
    expect(target.sql()).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) platform\.media_objects/);
  });

  it("persists reviewed-empty amenities with revision, audit, event, and exact replay", async () => {
    const target = commandTarget({ roomAmenitiesRevision: 1 });
    const repository = createRepository(target, resolvingMediaPort([]));
    const command = amenitiesCommand();

    const confirmed = await repository.confirmRoomTypeAmenities(command);
    const replayed = await repository.confirmRoomTypeAmenities(command);

    expect(confirmed).toEqual(replayed);
    expect(confirmed).toMatchObject({
      ok: true,
      response: {
        outcome: "confirmed",
        roomAmenities: {
          roomAmenitiesRevision: 2,
          reviewed: true,
          amenities: [],
          reviewedAt: acceptedAt.toISOString(),
        },
      },
    });
    expect(target.roomAmenitiesRevision).toBe(2);
    expect(target.amenities).toEqual([]);
    expect(target.roomAmenitiesReviewedAt).toBe(acceptedAt.toISOString());
    expect(target.events).toHaveLength(1);
    expect(target.events[0]).toMatchObject({
      eventType: "pms.room_amenities.confirmed",
      payload: {
        contractVersion: "pms-room-amenities.v1",
        organizationId,
        propertyId,
        roomTypeId,
        outcome: "confirmed",
        roomAmenitiesRevision: 2,
        reviewedAt: acceptedAt.toISOString(),
        acceptedAt: acceptedAt.toISOString(),
      },
    });
    expect(target.events[0]?.payload).not.toHaveProperty("amenities");
    expect(target.audits).toHaveLength(1);
    expect(target.commits).toBe(1);
  });

  it("finalizes stale revisions without overwriting or publishing an event", async () => {
    const target = commandTarget({ roomMediaRevision: 4 });
    const resolverCalls: unknown[] = [];
    const repository = createRepository(target, resolvingMediaPort(resolverCalls));
    const command = mediaCommand();

    const conflict = await repository.assignRoomTypeMedia(command);
    const replayed = await repository.assignRoomTypeMedia(command);

    expect(conflict).toEqual({
      ok: false,
      error: { code: "room_media_revision_conflict", currentRevision: 4 },
    });
    expect(replayed).toEqual(conflict);
    expect(target.roomMediaRevision).toBe(4);
    expect(target.roomMedia).toEqual([]);
    expect(resolverCalls).toHaveLength(0);
    expect(target.events).toHaveLength(0);
    expect(target.audits).toHaveLength(1);
    expect(target.commits).toBe(1);
  });

  it("finalizes deterministic media readiness and vocabulary failures without events", async () => {
    const mediaTarget = commandTarget();
    const mediaRepository = createRepository(mediaTarget, resolvingMediaPort([], "not_ready"));
    const mediaResult = await mediaRepository.assignRoomTypeMedia(mediaCommand());

    expect(mediaResult).toEqual({
      ok: false,
      error: { code: "media_not_ready", mediaObjectIds: [mediaObjectId] },
    });
    expect(mediaTarget.events).toHaveLength(0);
    expect(mediaTarget.audits).toHaveLength(1);
    expect(mediaTarget.roomMediaRevision).toBe(3);

    const amenitiesTarget = commandTarget({ roomAmenitiesRevision: 1 });
    const vocabulary: RoomAmenityVocabularyValidationPort = {
      async validateRoomAmenities(keys) {
        return {
          ok: false,
          error: { code: "unsupported_room_amenity_keys", unsupportedAmenityKeys: [...keys] },
        };
      },
    };
    const amenitiesRepository = createRepository(
      amenitiesTarget,
      resolvingMediaPort([]),
      vocabulary,
    );
    const amenitiesResult = await amenitiesRepository.confirmRoomTypeAmenities(
      amenitiesCommand({ amenities: ["unknown_key"] }),
    );

    expect(amenitiesResult).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_amenity_keys",
        unsupportedAmenityKeys: ["unknown_key"],
      },
    });
    expect(amenitiesTarget.events).toHaveLength(0);
    expect(amenitiesTarget.audits).toHaveLength(1);
    expect(amenitiesTarget.roomAmenitiesRevision).toBe(1);
  });

  it("rolls back dependency uncertainty and creates no durable envelope", async () => {
    const target = commandTarget();
    const repository = createRepository(target, {
      async resolvePublicMedia() {
        throw new Error("media database unavailable");
      },
    });

    await expect(repository.assignRoomTypeMedia(mediaCommand())).rejects.toThrow(
      "media database unavailable",
    );
    expect(target.idempotencyCount).toBe(0);
    expect(target.events).toHaveLength(0);
    expect(target.audits).toHaveLength(0);
    expect(target.roomMediaRevision).toBe(3);
    expect(target.commits).toBe(0);
    expect(target.rollbacks).toBe(1);
  });

  it("rolls back a truthy non-boolean vocabulary result without durable state", async () => {
    const target = commandTarget({ roomAmenitiesRevision: 1 });
    const malformedVocabulary = {
      async validateRoomAmenities() {
        return { ok: "yes" };
      },
    } as unknown as RoomAmenityVocabularyValidationPort;
    const repository = createRepository(target, resolvingMediaPort([]), malformedVocabulary);

    await expect(repository.confirmRoomTypeAmenities(amenitiesCommand())).rejects.toThrow(
      "amenity vocabulary returned an invalid result",
    );
    expect(target.roomAmenitiesRevision).toBe(1);
    expect(target.roomAmenitiesReviewedAt).toBeNull();
    expect(target.idempotencyCount).toBe(0);
    expect(target.events).toHaveLength(0);
    expect(target.audits).toHaveLength(0);
    expect(target.commits).toBe(0);
    expect(target.rollbacks).toBe(1);
  });

  it("denies missing caller scope before reserving idempotency or resolving media", async () => {
    const target = commandTarget({ authorized: false });
    const resolverCalls: unknown[] = [];
    const repository = createRepository(target, resolvingMediaPort(resolverCalls));

    const result = await repository.assignRoomTypeMedia(mediaCommand());

    expect(result).toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    expect(target.idempotencyCount).toBe(0);
    expect(target.events).toHaveLength(0);
    expect(target.audits).toHaveLength(0);
    expect(resolverCalls).toHaveLength(0);
    expect(target.commits).toBe(0);
  });
});

function createRepository(
  target: ReturnType<typeof commandTarget>,
  mediaResolver: HotelMediaResolutionPort,
  amenityVocabulary: RoomAmenityVocabularyValidationPort = supportedAmenities,
) {
  return createPgPmsRoomPublicationCommandRepository({
    connectionString: "postgresql://pms-room-publication-test",
    pool: target.pool,
    mediaResolver,
    amenityVocabulary,
    now: () => acceptedAt,
    randomId: () => eventId,
  });
}

type StoredIdempotency = {
  id: string;
  operation: string;
  keyHash: string;
  propertyId: string;
  requestFingerprintHash: string;
  status: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  result: unknown;
  expiresAt: string;
};

type CapturedEvent = {
  eventType: string;
  eventVersion: number;
  propertyId: string;
  roomTypeId: string;
  payload: Record<string, unknown>;
};

function commandTarget(
  options: {
    authorized?: boolean;
    roomMediaRevision?: number;
    roomAmenitiesRevision?: number;
  } = {},
) {
  let roomMediaRevision = options.roomMediaRevision ?? 3;
  let roomAmenitiesRevision = options.roomAmenitiesRevision ?? 1;
  let roomAmenitiesReviewedAt: string | null = null;
  let roomMedia: { mediaObjectId: string; altText: string | null; sortOrder: number }[] = [];
  let amenities: string[] = [];
  let transactionSnapshot: ReturnType<typeof snapshot> | null = null;
  let commits = 0;
  let rollbacks = 0;
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const events: CapturedEvent[] = [];
  const audits: Record<string, unknown>[] = [];
  const idempotency = new Map<string, StoredIdempotency>();

  function snapshot() {
    return {
      roomMediaRevision,
      roomAmenitiesRevision,
      roomAmenitiesReviewedAt,
      roomMedia: roomMedia.map((item) => ({ ...item })),
      amenities: [...amenities],
      events: events.map((event) => ({ ...event, payload: { ...event.payload } })),
      audits: audits.map((audit) => ({ ...audit })),
      idempotency: new Map([...idempotency].map(([key, value]) => [key, { ...value }] as const)),
    };
  }

  function restore(state: ReturnType<typeof snapshot>) {
    roomMediaRevision = state.roomMediaRevision;
    roomAmenitiesRevision = state.roomAmenitiesRevision;
    roomAmenitiesReviewedAt = state.roomAmenitiesReviewedAt;
    roomMedia = state.roomMedia;
    amenities = state.amenities;
    events.splice(0, events.length, ...state.events);
    audits.splice(0, audits.length, ...state.audits);
    idempotency.clear();
    for (const [key, value] of state.idempotency) idempotency.set(key, value);
  }

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) => {
    calls.push({ text, values });
    if (text === "BEGIN") {
      transactionSnapshot = snapshot();
      return emptyRows<T>();
    }
    if (text === "COMMIT") {
      commits += 1;
      transactionSnapshot = null;
      return emptyRows<T>();
    }
    if (text === "ROLLBACK") {
      rollbacks += 1;
      if (transactionSnapshot) restore(transactionSnapshot);
      transactionSnapshot = null;
      return emptyRows<T>();
    }
    if (text.includes("SELECT property.id")) {
      return options.authorized === false
        ? emptyRows<T>()
        : rows([{ id: propertyId } as unknown as T]);
    }
    if (text.includes("FROM identity.product_entitlements")) {
      return rows([
        {
          status: "active",
          startsAt: "2026-08-01T00:00:00.000Z",
          expiresAt: null,
        } as unknown as T,
      ]);
    }
    if (text.includes("pg_advisory_xact_lock")) return emptyRows<T>();
    if (text.includes("FROM platform.idempotency_keys")) {
      const key = idempotencyKey(String(values?.[0]), String(values?.[1]), String(values?.[2]));
      const stored = idempotency.get(key);
      return stored
        ? rows([
            {
              id: stored.id,
              status: stored.status,
              requestFingerprintHash: stored.requestFingerprintHash,
              responseStatusCode: stored.responseStatusCode,
              responseBodyHash: stored.responseBodyHash,
              idempotencyMetadata: { attempt: 1, result: stored.result },
              expiresAt: stored.expiresAt,
            } as unknown as T,
          ])
        : emptyRows<T>();
    }
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      const operation = String(values?.[0]);
      const keyHash = String(values?.[1]);
      const property = String(values?.[3]);
      const key = idempotencyKey(operation, keyHash, property);
      if (idempotency.has(key)) return emptyRows<T>();
      idempotency.set(key, {
        id: idempotencyId,
        operation,
        keyHash,
        propertyId: property,
        requestFingerprintHash: String(values?.[2]),
        status: "in_progress",
        responseStatusCode: null,
        responseBodyHash: null,
        result: null,
        expiresAt: "2026-08-04T09:00:00.000Z",
      });
      return rows([{ id: idempotencyId, attempt: 1 } as unknown as T]);
    }
    if (text.includes('SELECT room_media_revision AS "roomMediaRevision"')) {
      return rows([{ roomMediaRevision } as unknown as T]);
    }
    if (text.includes('SELECT room_amenities_revision AS "roomAmenitiesRevision"')) {
      return rows([{ roomAmenitiesRevision, roomAmenitiesReviewedAt } as unknown as T]);
    }
    if (text.includes("DELETE FROM pms.room_type_media")) {
      roomMedia = [];
      return emptyRows<T>();
    }
    if (text.includes("INSERT INTO pms.room_type_media")) {
      roomMedia = (
        JSON.parse(String(values?.[2])) as {
          media_object_id: string;
          alt_text: string | null;
          sort_order: number;
        }[]
      ).map((assignment) => ({
        mediaObjectId: assignment.media_object_id,
        altText: assignment.alt_text,
        sortOrder: assignment.sort_order,
      }));
      return emptyRows<T>();
    }
    if (text.includes("SET room_media_revision = room_media_revision + 1")) {
      if (Number(values?.[2]) !== roomMediaRevision) return emptyRows<T>();
      roomMediaRevision += 1;
      return rows([{ revision: roomMediaRevision } as unknown as T]);
    }
    if (text.includes("SET amenities_snapshot = $4::jsonb")) {
      if (Number(values?.[2]) !== roomAmenitiesRevision) return emptyRows<T>();
      amenities = JSON.parse(String(values?.[3])) as string[];
      roomAmenitiesRevision += 1;
      roomAmenitiesReviewedAt = String(values?.[4]);
      return rows([{ revision: roomAmenitiesRevision } as unknown as T]);
    }
    if (text.includes("INSERT INTO platform.domain_events")) {
      events.push({
        eventType: String(values?.[2]),
        eventVersion: 1,
        propertyId: String(values?.[4]),
        roomTypeId: String(values?.[5]),
        payload: JSON.parse(String(values?.[10])) as Record<string, unknown>,
      });
      return emptyRows<T>();
    }
    if (text.includes("INSERT INTO platform.product_audit_events")) {
      audits.push({
        auditKey: values?.[0],
        action: values?.[1],
        payload: JSON.parse(String(values?.[10])) as Record<string, unknown>,
      });
      return emptyRows<T>();
    }
    if (text.includes("UPDATE platform.idempotency_keys")) {
      const stored = [...idempotency.values()].find(({ id }) => id === values?.[0]);
      if (!stored) return emptyRows<T>();
      stored.status = "completed";
      stored.responseStatusCode = Number(values?.[1]);
      stored.responseBodyHash = String(values?.[2]);
      stored.result = JSON.parse(String(values?.[7]));
      return { rows: [] as T[], rowCount: 1 };
    }
    return emptyRows<T>();
  };

  const pool: PmsRoomPublicationCommandPool = {
    async connect() {
      return { query, release() {} };
    },
    async end() {},
  };

  return {
    pool,
    calls,
    events,
    audits,
    get commits() {
      return commits;
    },
    get rollbacks() {
      return rollbacks;
    },
    get roomMediaRevision() {
      return roomMediaRevision;
    },
    get roomAmenitiesRevision() {
      return roomAmenitiesRevision;
    },
    get roomAmenitiesReviewedAt() {
      return roomAmenitiesReviewedAt;
    },
    get roomMedia() {
      return roomMedia;
    },
    get amenities() {
      return amenities;
    },
    get idempotencyCount() {
      return idempotency.size;
    },
    sql() {
      return calls.map(({ text }) => text).join("\n");
    },
  };
}

function idempotencyKey(operation: string, keyHash: string, property: string): string {
  return `${operation}:${keyHash}:${property}`;
}

function rows<T extends QueryResultRow>(items: T[]) {
  return { rows: items, rowCount: items.length };
}

function emptyRows<T extends QueryResultRow>() {
  return rows<T>([]);
}
