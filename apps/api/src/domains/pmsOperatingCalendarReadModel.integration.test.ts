import { createPmsOperatingCalendarSourceRevision } from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "a5100000-0000-4000-8000-000000000001";
const roomTypeA = "a5100000-0000-4000-8000-000000000002";
const roomTypeB = "a5100000-0000-4000-8000-000000000003";
const actorUserId = "a5100000-0000-4000-8000-000000000004";
const organizationId = "a5100000-0000-4000-8000-000000000005";
const acceptedAt = "2026-08-04T08:30:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS operating-calendar read model", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const profileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
    max: 3,
  });
  const roomEvidence = createPgPmsRoomFactsReadModel({
    connectionString,
    max: 3,
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
    await seedFixture();
  });

  afterAll(async () => {
    await cleanup();
    await readModel.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });

  it("reads an exact immutable source and selects the latest complete revision as current", async () => {
    await expect(
      readModel.getOperatingCalendarConfigurationBySource(
        createPmsOperatingCalendarSourceRevision(propertyId, 1),
      ),
    ).resolves.toMatchObject({
      propertyId,
      calendarRevision: 1,
      source: {
        ownerDomain: "pms",
        entityType: "pms_operating_calendar.v1",
        entityId: propertyId,
        revision: "calendar:1",
      },
      sourceInputs: {
        propertyProfile: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:7",
        },
        propertyTimeZone: "Europe/Berlin",
      },
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
    });

    await expect(readModel.getCurrentOperatingCalendarConfiguration(propertyId)).resolves.toEqual({
      configuration: expectedLatestConfiguration(),
      sourceStatus: "current",
      sourceConflicts: [],
    });
  });

  it("evaluates the locked current owner and room revisions as source-only stale conflicts", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE hotel_catalog.properties
         SET profile_revision = 8, updated_at = now()
         WHERE id = $1::uuid`,
        [propertyId],
      );
      await admin.query(
        `UPDATE hotel_catalog.property_locations
         SET timezone = 'Asia/Kolkata', updated_at = now()
         WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await admin.query(
        `UPDATE pms.room_types
         SET room_facts_revision = 4, room_units_revision = 6, updated_at = now()
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [propertyId, roomTypeA],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    const result = await readModel.getCurrentOperatingCalendarConfiguration(propertyId);
    expect(result).toMatchObject({
      configuration: expectedLatestConfiguration(),
      sourceStatus: "stale",
      sourceConflicts: [
        { code: "property_profile_revision_conflict", currentRevision: 8 },
        { code: "room_facts_revision_conflict", roomTypeId: roomTypeA, currentRevision: 4 },
        { code: "room_units_revision_conflict", roomTypeId: roomTypeA, currentRevision: 6 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Asia/Kolkata");
  });

  async function seedFixture(): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, 'vay1071-operating-calendar-read', 'VAY-1071 Read Hotel', 7)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, category, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES
       (
         $1::uuid, $3::uuid, 'Garden Suite', 'Stable garden room.', 'suite',
         '{"total":3,"adults":2,"children":1}'::jsonb,
         '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
         TRUE, 3, 5
       ),
       (
         $2::uuid, $3::uuid, 'Loft Suite', 'Stable loft room.', 'suite',
         '{"total":4,"adults":3,"children":1}'::jsonb,
         '{"beds":[{"type":"king","quantity":1}],"bedrooms":1,"bathrooms":1,
           "bathroomType":"private","size":{"value":40,"unit":"sqm"}}'::jsonb,
         TRUE, 3, 8
       )`,
      [roomTypeA, roomTypeB, propertyId],
    );
    await seedPhysicalRooms();
    await seedCalendarRevision(1, "year_round", 0, 1);
    await seedCalendarRevision(2, "recurring", 1, 2);
  }

  async function seedPhysicalRooms(): Promise<void> {
    const rooms = [
      ["a5100000-0000-4000-8000-000000000011", roomTypeA, "A-101"],
      ["a5100000-0000-4000-8000-000000000012", roomTypeA, "A-102"],
      ["a5100000-0000-4000-8000-000000000013", roomTypeB, "B-201"],
      ["a5100000-0000-4000-8000-000000000014", roomTypeB, "B-202"],
      ["a5100000-0000-4000-8000-000000000015", roomTypeB, "B-203"],
    ] as const;
    for (const [roomId, roomTypeId, label] of rooms) {
      await admin.query(
        `INSERT INTO pms.rooms (
           id, property_id, room_type_id, room_number, status, operational_label_status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [roomId, propertyId, roomTypeId, label],
      );
    }
  }

  async function seedCalendarRevision(
    revision: 1 | 2,
    scheduleMode: "year_round" | "recurring",
    recurringPeriodCount: 0 | 1,
    minimumStayNights: 1 | 2,
  ): Promise<void> {
    const idempotencyId = `a5100000-0000-4000-8${revision}00-00000000002${revision}`;
    const domainEventId = `a5100000-0000-4000-8${revision}00-00000000003${revision}`;
    const outboxEventId = `a5100000-0000-4000-8${revision}00-00000000004${revision}`;
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO platform.idempotency_keys (
           id, operation_scope, operation, key_hash, request_fingerprint_hash, status,
           tenant_scope, property_id, response_status_code, response_body_hash,
           first_seen_at, last_seen_at, completed_at, expires_at
         ) VALUES (
           $1::uuid, 'pms', 'pms.operating_calendar.upsert', $2, $3, 'completed',
           'property', $4::uuid, 200, $5,
           $6::timestamptz, $6::timestamptz, $6::timestamptz,
           $6::timestamptz + interval '24 hours'
         )`,
        [
          idempotencyId,
          `vay1071-read-key-${revision}`,
          `sha256:${String(revision).repeat(64)}`,
          propertyId,
          `sha256:${String(revision + 2).repeat(64)}`,
          acceptedAt,
        ],
      );
      await admin.query(
        `INSERT INTO platform.domain_events (
           id, source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
           resource_product, resource_type, resource_id, actor_type, payload
         ) VALUES (
           $1::uuid, 'pms', $2, 'pms.operating_calendar.changed', $3::timestamptz,
           'property', $4::uuid, 'pms', 'operating_calendar', $4, 'system', '{}'::jsonb
         )`,
        [domainEventId, `vay1071-read-event-${revision}`, acceptedAt, propertyId],
      );
      await admin.query(
        `INSERT INTO platform.outbox_events (
           id, domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
           resource_product, resource_type, resource_id, payload
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'pms.inventory-source',
           'pms.operating_calendar.changed', 'property', $4::uuid,
           'pms', 'operating_calendar', $4, '{}'::jsonb
         )`,
        [outboxEventId, domainEventId, `vay1071-read-outbox-${revision}`, propertyId],
      );
      await admin.query(
        `INSERT INTO pms.operating_calendar_revisions (
           organization_id, property_id, calendar_revision, contract_version,
           property_profile_revision, property_time_zone, schedule_mode,
           recurring_period_count, room_binding_count, default_minimum_stay_nights,
           idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
           created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'pms-operating-calendar.v1', 7, 'Europe/Berlin', $4,
           $5, 2, $6, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
           $11::timestamptz, $11::timestamptz
         )`,
        [
          organizationId,
          propertyId,
          revision,
          scheduleMode,
          recurringPeriodCount,
          minimumStayNights,
          idempotencyId,
          domainEventId,
          outboxEventId,
          actorUserId,
          acceptedAt,
        ],
      );
      if (scheduleMode === "recurring") {
        await admin.query(
          `INSERT INTO pms.operating_calendar_recurring_periods (
             property_id, calendar_revision, period_index,
             start_month, start_day, end_month, end_day
           ) VALUES ($1::uuid, $2, 0, 11, 1, 3, 31)`,
          [propertyId, revision],
        );
      }
      await admin.query(
        `INSERT INTO pms.operating_calendar_room_bindings (
           property_id, calendar_revision, room_type_id,
           source_room_facts_revision, source_room_units_revision,
           physical_capacity_count, starting_sellable_limit_count
         ) VALUES
           ($1::uuid, $2, $3::uuid, 3, 5, 2, 2),
           ($1::uuid, $2, $4::uuid, 3, 8, 3, 2)`,
        [propertyId, revision, roomTypeA, roomTypeB],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM pms.operating_calendar_recurring_periods WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM pms.operating_calendar_room_bindings WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM pms.operating_calendar_revisions WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
      await admin.query(
        "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function expectedLatestConfiguration() {
  return {
    contractVersion: "pms-operating-calendar.v1",
    propertyId,
    calendarRevision: 2,
    source: createPmsOperatingCalendarSourceRevision(propertyId, 2),
    sourceInputs: {
      propertyProfile: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile:7",
      },
      propertyTimeZone: "Europe/Berlin",
      roomBindings: [
        {
          roomTypeId: roomTypeA,
          sourceRoomFactsRevision: 3,
          sourceRoomUnitsRevision: 5,
          physicalCapacityCount: 2,
          startingSellableLimitCount: 2,
        },
        {
          roomTypeId: roomTypeB,
          sourceRoomFactsRevision: 3,
          sourceRoomUnitsRevision: 8,
          physicalCapacityCount: 3,
          startingSellableLimitCount: 2,
        },
      ],
    },
    schedule: { mode: "recurring", periods: [{ startsOn: "11-01", endsOn: "03-31" }] },
    defaultMinimumStayNights: 2,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
