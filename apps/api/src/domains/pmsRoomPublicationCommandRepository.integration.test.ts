import { createHash } from "node:crypto";

import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import {
  parseAssignRoomTypeMediaCommand,
  parseConfirmRoomTypeAmenitiesCommand,
  parseCreateRoomTypeFactsCommand,
  parseSafeDeleteRoomTypeCommand,
  type RoomTypeFacts,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { createPmsRoomAmenityVocabularyValidationPort } from "./pmsRoomAmenityVocabulary.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import { createPgPmsRoomFactsCommandRepository } from "./pmsRoomFactsCommandRepository.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { createPgPmsRoomPublicationCommandRepository } from "./pmsRoomPublicationCommandRepository.js";
import { createPgPmsRoomPublicationReadModel } from "./pmsRoomPublicationReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "16100000-0000-4000-8000-000000000001";
const organizationId = "16100000-0000-4000-8000-000000000002";
const propertyId = "16100000-0000-4000-8000-000000000003";
const mediaObjectId = "16100000-0000-4000-8000-000000000004";
const roomUnitId = "16100000-0000-4000-8000-000000000005";
const acceptedAt = "2026-08-03T14:00:00.000Z";
const roleKey = "vay1061_room_publication_integration";
const serving = {
  bucketName: "vayada-media-test",
  cdnBaseUrl: "https://cdn.example.test",
  publicPathPrefix: "media",
} as const;

const readRepository: PmsOperationsReadRepository = {
  async listRoomsByPropertyId() {
    return { items: [] };
  },
  async listRoomTypesByPropertyId() {
    return { items: [] };
  },
  async findRoomTypeById() {
    return null;
  },
  async listCalendarDaysByPropertyId() {
    return { items: [] };
  },
  async listRoomBlocksByPropertyId() {
    return { items: [] };
  },
  async listReservationsByPropertyId() {
    return { items: [], total: 0 };
  },
  async findReservationByGuestBookingId() {
    return null;
  },
};

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS room-publication adapters", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const factsRepository = createPgPmsRoomFactsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(acceptedAt),
    vocabularyValidator: {
      async validateRoomFactsVocabulary() {
        return { ok: true };
      },
    },
  });
  const factsReadModel = createPgPmsRoomFactsReadModel({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 3,
    now: () => new Date(acceptedAt),
  });
  const mediaAdapter = createPgHotelMediaResolutionPort({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    serving,
    max: 3,
  });
  const mediaResolver = createHotelMediaResolutionPort(mediaAdapter);
  const amenityVocabulary = createPmsRoomAmenityVocabularyValidationPort();
  const repository = createPgPmsRoomPublicationCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    mediaResolver,
    amenityVocabulary,
    max: 6,
    now: () => new Date(acceptedAt),
  });
  const publicationReadModel = createPgPmsRoomPublicationReadModel({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    roomFacts: factsReadModel,
    roomCapacity: factsReadModel,
    mediaResolver,
    amenityVocabulary,
    max: 3,
  });
  const legacyRepository = createTargetPmsOperationsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 3,
    readRepository,
    now: () => new Date(acceptedAt),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
  });

  afterAll(async () => {
    await repository.close();
    await publicationReadModel.close();
    await factsReadModel.close();
    await factsRepository.close();
    await legacyRepository.close?.();
    await mediaAdapter.close?.();
    await cleanup();
    await admin.end();
  });

  it("assigns reusable safe media, confirms reviewed amenities, and projects one stable snapshot", async () => {
    const roomTypeId = await createFactsRoom("publication-main", "Garden Suite");
    await seedActiveUnit(roomTypeId);
    await seedReusablePublicMedia();

    const media = mediaCommand("media-main", roomTypeId, 1, [
      { mediaObjectId, altText: "Garden suite", sortOrder: 0 },
    ]);
    const amenities = amenitiesCommand("amenities-main", roomTypeId, 1, [
      "wifi",
      "air_conditioning",
    ]);
    const assigned = await repository.assignRoomTypeMedia(media);
    const confirmed = await repository.confirmRoomTypeAmenities(amenities);

    expect(assigned).toMatchObject({
      ok: true,
      response: { outcome: "assigned", roomMediaRevision: 2 },
    });
    expect(confirmed).toMatchObject({
      ok: true,
      response: {
        outcome: "confirmed",
        roomAmenities: {
          roomAmenitiesRevision: 2,
          reviewed: true,
          amenities: ["air_conditioning", "wifi"],
          reviewedAt: acceptedAt,
        },
      },
    });
    await expect(repository.assignRoomTypeMedia(media)).resolves.toEqual(assigned);
    await expect(repository.confirmRoomTypeAmenities(amenities)).resolves.toEqual(confirmed);

    await expect(readPublicationState(roomTypeId)).resolves.toMatchObject({
      active: true,
      roomMediaRevision: "2",
      roomAmenitiesRevision: "2",
      roomAmenitiesReviewedAt: new Date(acceptedAt),
      amenitiesSnapshot: ["air_conditioning", "wifi"],
      assignmentCount: "1",
      mediaObjectCount: "1",
    });
    await expect(eventRows()).resolves.toEqual([
      expect.objectContaining({
        eventType: "pms.room_amenities.confirmed",
        eventVersion: 1,
        sourceSystem: "pms",
        resourceId: roomTypeId,
        payload: {
          contractVersion: "pms-room-amenities.v1",
          organizationId,
          propertyId,
          roomTypeId,
          outcome: "confirmed",
          roomAmenitiesRevision: 2,
          reviewedAt: acceptedAt,
          acceptedAt,
        },
      }),
      expect.objectContaining({
        eventType: "pms.room_media.assigned",
        eventVersion: 1,
        sourceSystem: "pms",
        resourceId: roomTypeId,
        payload: {
          contractVersion: "pms-room-publication.v1",
          organizationId,
          propertyId,
          roomTypeId,
          outcome: "assigned",
          roomMediaRevision: 2,
          acceptedAt,
        },
      }),
    ]);
    await expect(publicationAuditCount()).resolves.toBe(2);
    await expect(publicationOutboxCount()).resolves.toBe(0);

    const snapshot = await publicationReadModel.getRoomPublicationSnapshot({
      organizationId,
      propertyId,
    });
    expect(snapshot).toMatchObject({
      status: "ready",
      blockers: [],
      rooms: [
        {
          roomTypeId,
          activeUnitCount: 1,
          amenities: ["air_conditioning", "wifi"],
          sourceRevisions: {
            roomFactsRevision: 1,
            roomUnitsRevision: 1,
            roomMediaRevision: 2,
            roomAmenitiesRevision: 2,
          },
          media: [
            {
              mediaObjectId,
              altText: "Garden suite",
              sortOrder: 0,
              publicVariants: [
                {
                  variantName: "original_safe",
                  publicUrl: publicMediaUrl(),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/bucket|storageKey|ownerOrganizationId/);
  });

  it("serializes concurrent amenity confirms and never lets a stale set overwrite the winner", async () => {
    const roomTypeId = await createFactsRoom("concurrent", "Concurrent Suite");
    const first = amenitiesCommand("amenities-first", roomTypeId, 1, ["balcony"]);
    const second = amenitiesCommand("amenities-second", roomTypeId, 1, ["kitchen"]);

    await admin.query("BEGIN");
    await admin.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('pms.room_publication'), hashtext($1::uuid::text)
       )`,
      [propertyId],
    );
    const firstResult = repository.confirmRoomTypeAmenities(first);
    const secondResult = repository.confirmRoomTypeAmenities(second);
    try {
      await waitForAdvisoryWaiters(2);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([firstResult, secondResult]);
      throw error;
    }

    const results = await Promise.all([firstResult, secondResult]);
    const winner = results.find((result) => result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "room_amenities_revision_conflict", currentRevision: 2 } },
    ]);
    if (!winner?.ok) throw new Error("Expected one concurrent amenity winner");
    const winningAmenities = winner.response.roomAmenities.amenities;

    await expect(readPublicationState(roomTypeId)).resolves.toMatchObject({
      roomAmenitiesRevision: "2",
      amenitiesSnapshot: winningAmenities,
    });
    await expect(
      repository.confirmRoomTypeAmenities(winner === results[0] ? first : second),
    ).resolves.toEqual(winner);
    await expect(eventRows("pms.room_amenities.confirmed")).resolves.toHaveLength(1);
  });

  it("rolls the room write, idempotency, event, and audit back as one unit", async () => {
    const roomTypeId = await createFactsRoom("atomic", "Atomic Suite");
    const command = amenitiesCommand("amenities-atomic", roomTypeId, 1, ["wifi"]);
    const failingRepository = createPgPmsRoomPublicationCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      mediaResolver,
      amenityVocabulary,
      max: 2,
      now: () => new Date(acceptedAt),
      randomId: () => "not-a-valid-event-uuid",
    });

    try {
      await expect(failingRepository.confirmRoomTypeAmenities(command)).rejects.toThrow(
        "event ID generator returned an invalid UUID",
      );
    } finally {
      await failingRepository.close();
    }
    await expect(readPublicationState(roomTypeId)).resolves.toMatchObject({
      roomAmenitiesRevision: "1",
      roomAmenitiesReviewedAt: null,
      amenitiesSnapshot: [],
    });
    await expect(eventRows("pms.room_amenities.confirmed")).resolves.toEqual([]);
    await expect(publicationAuditCount()).resolves.toBe(0);
    await expect(publicationIdempotencyCount()).resolves.toBe(0);

    await expect(repository.confirmRoomTypeAmenities(command)).resolves.toMatchObject({
      ok: true,
      response: { roomAmenities: { roomAmenitiesRevision: 2 } },
    });
  });

  it("preserves amenity review history while safe delete removes only media assignments", async () => {
    const roomTypeId = await createFactsRoom("delete", "Delete Suite");
    await seedReusablePublicMedia();
    await repository.assignRoomTypeMedia(
      mediaCommand("media-delete", roomTypeId, 1, [{ mediaObjectId, altText: null, sortOrder: 0 }]),
    );
    await repository.confirmRoomTypeAmenities(
      amenitiesCommand("amenities-delete", roomTypeId, 1, ["wifi"]),
    );

    const deleted = await factsRepository.safeDeleteRoomType(
      safeDeleteCommand("facts-delete", roomTypeId, 1),
    );
    expect(deleted).toMatchObject({
      ok: true,
      response: { outcome: "deleted", lifecycle: "inactive", deletedRevision: 2 },
    });
    await expect(readPublicationState(roomTypeId)).resolves.toMatchObject({
      active: false,
      roomMediaRevision: "3",
      roomAmenitiesRevision: "2",
      roomAmenitiesReviewedAt: new Date(acceptedAt),
      amenitiesSnapshot: ["wifi"],
      assignmentCount: "0",
      mediaObjectCount: "1",
    });
    await expect(
      publicationReadModel.getRoomPublicationSnapshot({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      status: "blocked",
      rooms: [],
      blockers: [
        {
          code: "room_type_required",
          affectedEntity: { entityType: "property", entityId: propertyId },
        },
      ],
    });
  });

  it("leaves populated legacy pmsOperations amenities at revision one and unreviewed", async () => {
    const created = await legacyRepository.createRoomType({
      propertyId,
      commandId: "legacy-room-command",
      idempotencyKey: "legacy-room-command",
      initialSetupOnly: true,
      name: "Legacy Suite",
      description: "Legacy command fixture",
      category: "double",
      occupancyLimits: { adults: 2, children: 0, total: 2 },
      attributes: {},
      amenities: ["balcony", "minibar"],
      media: [],
      baseRate: { amountDecimal: "120.00", currency: "EUR" },
      nonRefundableRate: null,
      operatingPeriods: [{ from: "01-01", to: "12-31" }],
      seasons: [
        {
          name: "Year-round",
          tier: "standard",
          from: "01-01",
          to: "12-31",
          rate: { amountDecimal: "120.00", currency: "EUR" },
          minStayNights: 1,
          maxStayNights: null,
        },
      ],
      active: true,
      sortOrder: 0,
      roomCount: 1,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: "legacy-room-command",
        correlationId: "legacy-room-command",
        reason: "Verify legacy amenity review defaults",
        requestedAt: acceptedAt,
      },
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("Expected legacy room creation to succeed");

    await expect(readPublicationState(created.roomType.roomTypeId)).resolves.toMatchObject({
      roomAmenitiesRevision: "1",
      roomAmenitiesReviewedAt: null,
      amenitiesSnapshot: ["balcony", "minibar"],
    });
  });

  async function createFactsRoom(suffix: string, name: string): Promise<string> {
    const created = await factsRepository.createRoomTypeFacts(createFactsCommand(suffix, name));
    if (!created.ok) throw new Error(`Failed to create room facts: ${created.error.code}`);
    return created.response.roomType.roomTypeId;
  }

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1061-room-publication@example.test',
               'VAY-1061 Room Publication', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1061 Room Publication',
               'vay1061-room-publication', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1061-room-publication', 'VAY-1061 Room Publication')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage')
       ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES
         ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active'),
         ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedActiveUnit(roomTypeId: string): Promise<void> {
    await admin.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, source_system, room_number,
         status, operational_label_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'pms', NULL, 'available', 'unverified')`,
      [roomUnitId, propertyId, roomTypeId],
    );
  }

  async function seedReusablePublicMedia(): Promise<void> {
    const checksum = mediaChecksum();
    const storageKey = publicMediaStorageKey();
    await admin.query(
      `INSERT INTO platform.media_objects (
         id, bucket, storage_key, storage_kind, visibility, purpose,
         owner_organization_id, property_id, resource_product, resource_type,
         resource_id, lifecycle_status, content_type, width_px, height_px,
         size_bytes, checksum_sha256, public_approved, created_by_user_id
       ) VALUES (
         $1::uuid, $2, $3, 'vayada_managed', 'public', 'property.gallery_image',
         $4::uuid, $5::uuid, 'hotel_catalog', 'property', $5,
         'active', 'image/webp', 1200, 800, 900, $6, TRUE, $7::uuid
       )`,
      [
        mediaObjectId,
        serving.bucketName,
        storageKey,
        organizationId,
        propertyId,
        checksum,
        actorUserId,
      ],
    );
    await admin.query(
      `INSERT INTO platform.media_variants (
         media_object_id, variant_name, visibility, storage_key, content_type,
         width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
       ) VALUES (
         $1::uuid, 'original_safe', 'public', $2, 'image/webp',
         1200, 800, 900, $3, $4
       )`,
      [mediaObjectId, storageKey, checksum, publicMediaUrl()],
    );
  }

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = FALSE
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = hashtext('pms.room_publication')::oid
           AND objid = hashtext($1::uuid::text)::oid`,
        [propertyId],
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent room-publication commands did not reach the advisory lock");
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      const deletes: Array<[string, string[]]> = [
        ["DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)",
          [propertyId],
        ],
        ["DELETE FROM platform.jobs WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.inventory_days WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rate_rules WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rate_plans WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.room_type_media WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.media_variants WHERE media_object_id = $1::uuid", [mediaObjectId]],
        ["DELETE FROM platform.media_objects WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        [
          "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        [
          "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        ["DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]],
        ["DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]],
        ["DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]],
      ];
      for (const [statement, parameters] of deletes) {
        await admin.query(statement, parameters);
      }
      await admin.query(
        `DELETE FROM identity.role_permission_grants
         WHERE organization_kind = 'hotel_group' AND role_key = $1`,
        [roleKey],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function readPublicationState(roomTypeId: string) {
    const result = await admin.query(
      `SELECT
         room_type.active,
         room_type.room_media_revision::text AS "roomMediaRevision",
         room_type.room_amenities_revision::text AS "roomAmenitiesRevision",
         room_type.room_amenities_reviewed_at AS "roomAmenitiesReviewedAt",
         room_type.amenities_snapshot AS "amenitiesSnapshot",
         (SELECT count(*)::text FROM pms.room_type_media assignment
          WHERE assignment.property_id = room_type.property_id
            AND assignment.room_type_id = room_type.id) AS "assignmentCount",
         (SELECT count(*)::text FROM platform.media_objects media
          WHERE media.property_id = room_type.property_id
            AND media.id = $3::uuid) AS "mediaObjectCount"
       FROM pms.room_types room_type
       WHERE room_type.property_id = $1::uuid AND room_type.id = $2::uuid`,
      [propertyId, roomTypeId, mediaObjectId],
    );
    return result.rows[0] ?? null;
  }

  async function eventRows(eventType?: string) {
    const result = await admin.query<{
      eventType: string;
      eventVersion: number;
      sourceSystem: string;
      resourceId: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type AS "eventType", event_version AS "eventVersion",
              source_system AS "sourceSystem", resource_id AS "resourceId", payload
       FROM platform.domain_events
       WHERE property_id = $1::uuid
         AND ($2::text IS NULL OR event_type = $2)
       ORDER BY event_type`,
      [propertyId, eventType ?? null],
    );
    return result.rows;
  }

  async function publicationAuditCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid
         AND (
           action LIKE 'pms.room_media.assign.%'
           OR action LIKE 'pms.room_amenities.confirm.%'
         )`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function publicationIdempotencyCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid
         AND operation IN ('pms.assignRoomTypeMedia', 'pms.confirmRoomTypeAmenities')`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function publicationOutboxCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.outbox_events
       WHERE property_id = $1::uuid
         AND resource_product = 'pms'
         AND resource_type = 'room_type'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
});

function createFactsCommand(suffix: string, name: string) {
  const command = parseCreateRoomTypeFactsCommand({
    organizationId,
    propertyId,
    draftRoomId: `vay1061-${suffix}`,
    expectedRevision: 0,
    facts: roomFacts(name),
    idempotencyKey: `facts-${suffix}`,
    audit: commandAudit(`facts-${suffix}`),
  });
  if (!command) throw new Error("Invalid VAY-1061 create-room-facts integration command");
  return command;
}

function mediaCommand(
  suffix: string,
  roomTypeId: string,
  expectedRoomMediaRevision: number,
  assignments: Array<{ mediaObjectId: string; altText: string | null; sortOrder: number }>,
) {
  const command = parseAssignRoomTypeMediaCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRoomMediaRevision,
    assignments,
    idempotencyKey: suffix,
    audit: commandAudit(suffix),
  });
  if (!command) throw new Error("Invalid VAY-1061 room-media integration command");
  return command;
}

function amenitiesCommand(
  suffix: string,
  roomTypeId: string,
  expectedRoomAmenitiesRevision: number,
  amenities: string[],
) {
  const command = parseConfirmRoomTypeAmenitiesCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRoomAmenitiesRevision,
    amenities,
    idempotencyKey: suffix,
    audit: commandAudit(suffix),
  });
  if (!command) throw new Error("Invalid VAY-1061 room-amenities integration command");
  return command;
}

function safeDeleteCommand(suffix: string, roomTypeId: string, expectedRevision: number) {
  const command = parseSafeDeleteRoomTypeCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRevision,
    idempotencyKey: suffix,
    audit: commandAudit(suffix),
  });
  if (!command) throw new Error("Invalid VAY-1061 safe-delete integration command");
  return command;
}

function commandAudit(suffix: string) {
  return {
    actor: { kind: "user" as const, userId: actorUserId },
    requestId: `request-${suffix}`,
    correlationId: `correlation-${suffix}`,
    requestedAt: acceptedAt,
  };
}

function roomFacts(name: string): RoomTypeFacts {
  return {
    name,
    description: "A VAY-1061 PostgreSQL integration fixture.",
    category: "suite" as RoomTypeFacts["category"],
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    beds: [{ type: "queen" as RoomTypeFacts["beds"][number]["type"], quantity: 1 }],
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: { value: 28, unit: "sqm" },
  };
}

function publicMediaStorageKey(): string {
  return `public/${serving.publicPathPrefix}/${mediaObjectId}/original_safe/sha256-${mediaChecksum()}.webp`;
}

function publicMediaUrl(): string {
  return `${serving.cdnBaseUrl}/${serving.publicPathPrefix}/${mediaObjectId}/original_safe/sha256-${mediaChecksum()}.webp`;
}

function mediaChecksum(): string {
  return createHash("sha256").update(`${mediaObjectId}:original_safe`).digest("hex");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
