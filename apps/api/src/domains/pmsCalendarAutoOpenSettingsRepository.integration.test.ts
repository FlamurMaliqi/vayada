import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsCalendarAutoOpenSettingsRepository } from "./pmsCalendarAutoOpenSettingsRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
let propertyId = randomUUID();
const actorUserId = "14330000-0000-4000-8000-000000000002";

describe.skipIf(!TEST_DATABASE_URL)("PMS calendar auto-open settings concurrency", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const firstPool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    max: 1,
  });
  const secondPool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    max: 1,
  });
  const firstRepository = createPgPmsCalendarAutoOpenSettingsRepository({
    pool: firstPool as never,
  });
  const secondRepository = createPgPmsCalendarAutoOpenSettingsRepository({
    pool: secondPool as never,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await blocker.connect();
  });

  beforeEach(async () => {
    await blocker.query("ROLLBACK");
    propertyId = randomUUID();
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1434@example.test', 'VAY-1434', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Auto-open Concurrency')`,
      [propertyId, `auto-open-${propertyId}`],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Vienna')`,
      [propertyId],
    );
    const roomTypeId = randomUUID();
    const seed = await admin.connect();
    try {
      await seed.query("BEGIN");
      await seed.query("SET LOCAL session_replication_role = replica");
      await seed.query(
        `INSERT INTO pms.room_types
           (id, property_id, name, room_facts_revision, room_units_revision)
         VALUES ($1::uuid, $2::uuid, 'Verified Suite', 1, 1)`,
        [roomTypeId, propertyId],
      );
      await seed.query(
        `INSERT INTO pms.rooms
           (id, property_id, room_type_id, room_number, operational_label_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Verified Suite 1', 'verified')`,
        [randomUUID(), propertyId, roomTypeId],
      );
      await seed.query(
        `INSERT INTO pms.operating_calendar_revisions
           (organization_id, property_id, calendar_revision, contract_version,
            property_profile_revision, property_time_zone, schedule_mode,
            recurring_period_count, room_binding_count, default_minimum_stay_nights,
            idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
            created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 1, 'pms-operating-calendar.v1', 1, 'Europe/Vienna',
            'year_round', 0, 1, 1, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
            now(), now())`,
        [randomUUID(), propertyId, randomUUID(), randomUUID(), randomUUID(), actorUserId],
      );
      await seed.query(
        `INSERT INTO pms.operating_calendar_room_bindings
           (property_id, calendar_revision, room_type_id, source_room_facts_revision,
            source_room_units_revision, physical_capacity_count,
            starting_sellable_limit_count)
         VALUES ($1::uuid, 1, $2::uuid, 1, 1, 1, 1)`,
        [propertyId, roomTypeId],
      );
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK");
      throw error;
    } finally {
      seed.release();
    }
  });

  afterAll(async () => {
    await blocker.query("ROLLBACK");
    await Promise.all([firstPool.end(), secondPool.end(), admin.end()]);
    await blocker.end();
  });

  it("rereads after the property lock and rejects a stale virtual-default save", async () => {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE", [
      propertyId,
    ]);

    const firstPid = await backendPid(firstPool);
    const first = firstRepository.update(command(true, "first-key"));
    await waitForLockWaiter(admin, firstPid);

    const secondPid = await backendPid(secondPool);
    const second = secondRepository.update(command(false, "second-key"));
    await waitForLockWaiter(admin, secondPid);
    await blocker.query("COMMIT");

    await expect(first).resolves.toMatchObject({
      ok: true,
      outcome: "created",
      setting: { revision: 1, enabled: true },
    });
    await expect(second).resolves.toEqual({
      ok: false,
      error: { code: "calendar_auto_open_revision_conflict", currentRevision: 1 },
    });
  });

  it("replays the committed response without duplicating setting evidence or work", async () => {
    const commandValue = command(true, "replay-key");
    const first = await firstRepository.update(commandValue);
    const replay = await secondRepository.update(commandValue);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: true,
      outcome: "created",
      setting: { revision: 1, enabled: true },
    });
    const evidence = await admin.query<{
      settings: number;
      events: number;
      outbox: number;
      audits: number;
      idempotency: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pms.calendar_auto_open_settings WHERE property_id = $1::uuid) AS settings,
         (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid) AS events,
         (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
         (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits,
         (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid) AS idempotency`,
      [propertyId],
    );
    expect(evidence.rows[0]).toEqual({
      settings: 1,
      events: 1,
      outbox: 1,
      audits: 1,
      idempotency: 1,
    });
    const records = await admin.query<{
      eventKey: string;
      eventType: string;
      eventPayload: Record<string, unknown>;
      destination: string;
      outboxType: string;
      outboxPayload: Record<string, unknown>;
      auditPayload: Record<string, unknown>;
    }>(
      `SELECT event.event_key AS "eventKey", event.event_type AS "eventType",
              event.payload AS "eventPayload", outbox.destination,
              outbox.event_type AS "outboxType", outbox.payload AS "outboxPayload",
              audit.redacted_payload AS "auditPayload"
       FROM platform.domain_events event
       JOIN platform.outbox_events outbox ON outbox.domain_event_id = event.id
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       WHERE event.property_id = $1::uuid`,
      [propertyId],
    );
    expect(records.rows[0]).toMatchObject({
      eventKey: `pms.calendar-auto-open.setting:${propertyId}:revision-1:v1`,
      eventType: "pms.calendar_auto_open.setting_changed",
      eventPayload: { propertyId, revision: 1, enabled: true, mode: "rolling" },
      destination: "pms.inventory.scheduler",
      outboxType: "pms.calendar_auto_open.evaluation_requested",
      outboxPayload: { propertyId, settingRevision: 1 },
      auditPayload: {
        previous: { revision: 0, enabled: false },
        next: { revision: 1, enabled: true },
      },
    });
    expect(Object.keys(records.rows[0]!.eventPayload).sort()).toEqual([
      "enabled",
      "mode",
      "propertyId",
      "revision",
    ]);
  });
});

function command(enabled: boolean, idempotencyKey: string) {
  return {
    propertyId,
    expectedRevision: 0,
    enabled,
    mode: "rolling" as const,
    rollingMonths: 18 as const,
    fixedEndMonth: null,
    idempotencyKey,
    audit: {
      actorUserId,
      requestId: `${idempotencyKey}-request`,
      correlationId: `${idempotencyKey}-correlation`,
      requestedAt: "2026-09-03T08:00:00.000Z",
    },
  };
}

async function backendPid(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function waitForLockWaiter(observer: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the calendar auto-open property lock");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName))
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
}
