import {
  parseUpsertPmsOperatingCalendarCommand,
  type PmsOperatingCalendarRoomEvidencePorts,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "a5300000-0000-4000-8000-000000000001";
const propertyId = "a5300000-0000-4000-8000-000000000002";
const actorUserId = "a5300000-0000-4000-8000-000000000003";
const roomTypeA = "a5300000-0000-4000-8000-000000000004";
const roomTypeB = "a5300000-0000-4000-8000-000000000005";
const roomTypeC = "a5300000-0000-4000-8000-000000000006";
const acceptedAt = "2026-08-04T10:00:00.000Z";
const roleKey = "vay1071_operating_calendar_integration";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS operating-calendar command repository", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const profileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
    max: 4,
  });
  const roomEvidence = createPgPmsRoomFactsReadModel({
    connectionString,
    max: 4,
    now: () => new Date(acceptedAt),
  });
  const repository = createPgPmsOperatingCalendarCommandRepository({
    connectionString,
    max: 4,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    now: () => new Date(acceptedAt),
  });
  const readModel = createPgPmsOperatingCalendarReadModel({
    connectionString,
    max: 3,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(connectionString);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
    await seedRooms();
  });

  afterAll(async () => {
    await removeAuditFailureTrigger();
    await cleanup();
    await readModel.close();
    await repository.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });

  it("atomically creates, reads, and exactly replays one secret-safe immutable source", async () => {
    const input = command("accepted");
    const first = await repository.upsertOperatingCalendar(input);

    expect(first).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        configuration: {
          propertyId,
          calendarRevision: 1,
          source: { revision: "calendar:1" },
          sourceInputs: {
            propertyProfile: { revision: "profile:7" },
            propertyTimeZone: "Europe/Berlin",
          },
        },
      },
    });
    await expect(readModel.getCurrentOperatingCalendarConfiguration(propertyId)).resolves.toEqual({
      configuration: first.ok ? first.response.configuration : null,
      sourceStatus: "current",
      sourceConflicts: [],
    });
    await expect(counts()).resolves.toEqual({
      revisions: 1,
      periods: 1,
      bindings: 2,
      idempotency: 1,
      audit: 1,
      events: 1,
      outbox: 1,
    });
    const event = await storedEvent();
    expect(event).toEqual({
      payload: {
        contractVersion: "pms-operating-calendar.v1",
        eventType: "pms.operating_calendar.changed",
        destination: "pms.inventory-source",
        metadata: { sourceReadRequired: true },
        propertyId,
        calendarRevision: 1,
        sourceRevision: "calendar:1",
      },
      destination: "pms.inventory-source",
      metadata: { contractVersion: "pms-operating-calendar.v1", sourceReadRequired: true },
    });

    await expect(repository.upsertOperatingCalendar(input)).resolves.toEqual(first);
    await expect(counts()).resolves.toEqual({
      revisions: 1,
      periods: 1,
      bindings: 2,
      idempotency: 1,
      audit: 1,
      events: 1,
      outbox: 1,
    });
    await expect(
      repository.upsertOperatingCalendar(command("accepted", { defaultMinimumStayNights: 4 })),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
  });

  it("coordinates concurrent exact retries into one accepted write", async () => {
    const input = command("concurrent-replay");
    const [first, second] = await Promise.all([
      repository.upsertOperatingCalendar(input),
      repository.upsertOperatingCalendar(input),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, response: { outcome: "created" } });
    await expect(counts()).resolves.toEqual({
      revisions: 1,
      periods: 1,
      bindings: 2,
      idempotency: 1,
      audit: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("serializes competing keys at one expected revision with a typed calendar conflict", async () => {
    const results = await Promise.all([
      repository.upsertOperatingCalendar(command("competing-a")),
      repository.upsertOperatingCalendar(command("competing-b")),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      { ok: false, error: { code: "calendar_revision_conflict", currentRevision: 1 } },
    ]);
    await expect(counts()).resolves.toEqual({
      revisions: 1,
      periods: 1,
      bindings: 2,
      idempotency: 2,
      audit: 2,
      events: 1,
      outbox: 1,
    });
  });

  it("persists source-only failures with profile revision precedence and no changed event", async () => {
    await writeCanonicalProfile(8, "Europe/Kiev");

    await expect(repository.upsertOperatingCalendar(command("profile-revision"))).resolves.toEqual({
      ok: false,
      error: { code: "property_profile_revision_conflict", currentRevision: 8 },
    });
    await expect(
      repository.upsertOperatingCalendar(
        command("timezone-invalid", { expectedPropertyProfileRevision: 8 }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "property_timezone_invalid" } });

    await writeCanonicalProfile(9, "Europe/Berlin");
    await admin.query(
      `UPDATE pms.room_types SET room_facts_revision = 4
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [propertyId, roomTypeA],
    );
    await expect(
      repository.upsertOperatingCalendar(
        command("facts-conflict", { expectedPropertyProfileRevision: 9 }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", roomTypeId: roomTypeA, currentRevision: 4 },
    });
    await expect(counts()).resolves.toMatchObject({
      revisions: 0,
      idempotency: 3,
      audit: 3,
      events: 0,
      outbox: 0,
    });
  });

  it("holds the facts and every unit lock until the accepted snapshot commits", async () => {
    let releaseCapacity!: () => void;
    let signalCapacity!: () => void;
    const capacityReached = new Promise<void>((resolve) => {
      signalCapacity = resolve;
    });
    const capacityReleased = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    let firstCapacity = true;
    const gatedRoomEvidence: PmsOperatingCalendarRoomEvidencePorts = {
      roomFacts: roomEvidence,
      roomCapacity: {
        async getRoomTypeCapacity(requestedPropertyId, roomTypeId) {
          if (firstCapacity) {
            firstCapacity = false;
            signalCapacity();
            await capacityReleased;
          }
          return roomEvidence.getRoomTypeCapacity(requestedPropertyId, roomTypeId);
        },
      },
    };
    const gated = createPgPmsOperatingCalendarCommandRepository({
      connectionString,
      max: 4,
      propertyProfileEvidence: profileEvidence,
      roomEvidence: gatedRoomEvidence,
      now: () => new Date(acceptedAt),
    });
    const factsWriter = new pg.Client({ connectionString });
    const unitWriter = new pg.Client({ connectionString });
    await factsWriter.connect();
    await unitWriter.connect();
    try {
      const pending = gated.upsertOperatingCalendar(command("locking"));
      await capacityReached;
      await factsWriter.query("BEGIN");
      await unitWriter.query("BEGIN");
      const pendingFactsLock = lockPmsRoomFactsMutationScope(factsWriter, propertyId);
      const pendingUnitLock = lockPmsPhysicalRoomUnitMutationScope(
        unitWriter,
        propertyId,
        roomTypeA,
      );
      await waitForAdvisoryWaiters(2);
      releaseCapacity();
      await expect(pending).resolves.toMatchObject({ ok: true });
      await pendingFactsLock;
      await pendingUnitLock;
      await factsWriter.query(
        `INSERT INTO pms.room_types (
           id, property_id, name, description, occupancy_limits, room_attributes,
           active, room_facts_revision, room_units_revision
         ) VALUES (
           $1::uuid, $2::uuid, 'Added Suite', '',
           '{"total":2,"adults":2,"children":0}'::jsonb,
           '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
             "bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
           TRUE, 1, 1
         )`,
        [roomTypeC, propertyId],
      );
      await unitWriter.query(
        `UPDATE pms.room_types SET room_units_revision = 6
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [propertyId, roomTypeA],
      );
      await factsWriter.query("COMMIT");
      await unitWriter.query("COMMIT");
    } finally {
      await factsWriter.query("ROLLBACK").catch(() => undefined);
      await unitWriter.query("ROLLBACK").catch(() => undefined);
      await factsWriter.end();
      await unitWriter.end();
      await gated.close();
    }

    await expect(
      repository.upsertOperatingCalendar(command("after-locks", { expectedCalendarRevision: 1 })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "room_type_set_conflict",
        currentRoomTypeIds: [roomTypeA, roomTypeB, roomTypeC],
      },
    });
  });

  it("rolls back the complete accepted write when required audit persistence fails", async () => {
    await installAuditFailureTrigger();

    await expect(repository.upsertOperatingCalendar(command("audit-failure"))).rejects.toThrow(
      "injected VAY-1071 audit failure",
    );
    await expect(counts()).resolves.toEqual({
      revisions: 0,
      periods: 0,
      bindings: 0,
      idempotency: 0,
      audit: 0,
      events: 0,
      outbox: 0,
    });
  });

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1071-command@example.test', 'VAY-1071 Command', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1071 Command', 'vay1071-command', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, 'vay1071-command', 'VAY-1071 Command', 7)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key)
       VALUES ($1::uuid, $2::uuid, 'active', $3)`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage') ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
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

  async function seedRooms(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES
       (
         $1::uuid, $3::uuid, 'Garden Suite', '',
         '{"total":3,"adults":2,"children":1}'::jsonb,
         '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
         TRUE, 3, 5
       ),
       (
         $2::uuid, $3::uuid, 'Loft Suite', '',
         '{"total":4,"adults":3,"children":1}'::jsonb,
         '{"beds":[{"type":"king","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":40,"unit":"sqm"}}'::jsonb,
         TRUE, 4, 8
       )`,
      [roomTypeA, roomTypeB, propertyId],
    );
    const rooms = [
      ["a5300000-0000-4000-8000-000000000011", roomTypeA, "A-101"],
      ["a5300000-0000-4000-8000-000000000012", roomTypeA, "A-102"],
      ["a5300000-0000-4000-8000-000000000013", roomTypeB, "B-201"],
      ["a5300000-0000-4000-8000-000000000014", roomTypeB, "B-202"],
      ["a5300000-0000-4000-8000-000000000015", roomTypeB, "B-203"],
    ] as const;
    for (const [roomId, roomTypeId, roomNumber] of rooms) {
      await admin.query(
        `INSERT INTO pms.rooms (
           id, property_id, room_type_id, room_number, status, operational_label_status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [roomId, propertyId, roomTypeId, roomNumber],
      );
    }
  }

  async function writeCanonicalProfile(revision: number, timezone: string): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE hotel_catalog.properties
         SET profile_revision = $2, updated_at = now()
         WHERE id = $1::uuid`,
        [propertyId, revision],
      );
      await admin.query(
        `UPDATE hotel_catalog.property_locations
         SET timezone = $2, updated_at = now()
         WHERE property_id = $1::uuid`,
        [propertyId, timezone],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function counts() {
    const result = await admin.query<{
      revisions: string;
      periods: string;
      bindings: string;
      idempotency: string;
      audit: string;
      events: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*) FROM pms.operating_calendar_revisions
          WHERE property_id = $1::uuid)::text AS revisions,
         (SELECT count(*) FROM pms.operating_calendar_recurring_periods
          WHERE property_id = $1::uuid)::text AS periods,
         (SELECT count(*) FROM pms.operating_calendar_room_bindings
          WHERE property_id = $1::uuid)::text AS bindings,
         (SELECT count(*) FROM platform.idempotency_keys
          WHERE property_id = $1::uuid AND operation = 'pms.operating_calendar.upsert')::text
          AS idempotency,
         (SELECT count(*) FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND action = 'pms.operating_calendar.upsert')::text AS audit,
         (SELECT count(*) FROM platform.domain_events
          WHERE property_id = $1::uuid AND event_type = 'pms.operating_calendar.changed')::text
          AS events,
         (SELECT count(*) FROM platform.outbox_events
          WHERE property_id = $1::uuid AND event_type = 'pms.operating_calendar.changed')::text
          AS outbox`,
      [propertyId],
    );
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    );
  }

  async function storedEvent() {
    const result = await admin.query<{
      payload: unknown;
      destination: string;
      metadata: unknown;
    }>(
      `SELECT domain.payload, outbox.destination,
              outbox.outbox_metadata AS metadata
       FROM platform.domain_events domain
       JOIN platform.outbox_events outbox ON outbox.domain_event_id = domain.id
       WHERE domain.property_id = $1::uuid
         AND domain.event_type = 'pms.operating_calendar.changed'`,
      [propertyId],
    );
    return result.rows[0];
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION pms.vay1071_audit_failure()
       RETURNS trigger LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action = 'pms.operating_calendar.upsert' THEN
           RAISE EXCEPTION 'injected VAY-1071 audit failure';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    );
    await admin.query(
      `CREATE TRIGGER vay1071_audit_failure
       BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION pms.vay1071_audit_failure()`,
    );
  }

  async function removeAuditFailureTrigger(): Promise<void> {
    await admin.query(
      "DROP TRIGGER IF EXISTS vay1071_audit_failure ON platform.product_audit_events",
    );
    await admin.query("DROP FUNCTION IF EXISTS pms.vay1071_audit_failure()");
  }

  async function cleanup(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const [statement, value] of [
        [
          "DELETE FROM pms.operating_calendar_recurring_periods WHERE property_id = $1::uuid",
          propertyId,
        ],
        [
          "DELETE FROM pms.operating_calendar_room_bindings WHERE property_id = $1::uuid",
          propertyId,
        ],
        ["DELETE FROM pms.operating_calendar_revisions WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM platform.domain_events WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM pms.rooms WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM pms.room_types WHERE property_id = $1::uuid", propertyId],
        [
          "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
          organizationId,
        ],
        [
          "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
          organizationId,
        ],
        [
          "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
          organizationId,
        ],
        ["DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid", propertyId],
        ["DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", propertyId],
        ["DELETE FROM identity.organizations WHERE id = $1::uuid", organizationId],
        ["DELETE FROM identity.users WHERE id = $1::uuid", actorUserId],
      ] as const) {
        await admin.query(statement, [value]);
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

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for operating-calendar lock contenders");
  }
});

function command(
  suffix: string,
  overrides: Partial<UpsertPmsOperatingCalendarCommand> = {},
): UpsertPmsOperatingCalendarCommand {
  const parsed = parseUpsertPmsOperatingCalendarCommand({
    organizationId,
    propertyId,
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "recurring", periods: [{ startsOn: "11-01", endsOn: "03-31" }] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: [
      {
        roomTypeId: roomTypeA,
        expectedRoomFactsRevision: 3,
        expectedRoomUnitsRevision: 5,
        startingSellableLimitCount: 2,
      },
      {
        roomTypeId: roomTypeB,
        expectedRoomFactsRevision: 4,
        expectedRoomUnitsRevision: 8,
        startingSellableLimitCount: 2,
      },
    ],
    idempotencyKey: `vay1071-command-${suffix}`,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `req-vay1071-command-${suffix}`,
      correlationId: `corr-vay1071-command-${suffix}`,
      requestedAt: acceptedAt,
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Invalid operating-calendar integration command");
  return parsed;
}

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(test|vayada_ci)/.test(database)) {
    throw new Error("Refusing to run VAY-1071 integration tests against a non-test database");
  }
}
