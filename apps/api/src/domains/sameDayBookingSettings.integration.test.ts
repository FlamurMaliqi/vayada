import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetSameDayBookingSettingsPort } from "./sameDayBookingSettings.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "12820000-0000-4000-8000-000000000001";
const userId = "12820000-0000-4000-8000-000000000002";
const connectionId = "12820000-0000-4000-8000-000000000003";

describe.skipIf(!TEST_DATABASE_URL)("same-day settings PostgreSQL concurrency", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const blocker = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
  });
  const commandPool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    max: 1,
  });
  const port = createTargetSameDayBookingSettingsPort({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    pool: commandPool as never,
    now: () => new Date("2026-09-01T10:00:00.000Z"),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await blocker.connect();
    await cleanup();
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'same-day-concurrency@example.test', 'Same-day Test', 'active')`,
      [userId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'same-day-concurrency', 'Same-day Concurrency Hotel')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Vienna')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO booking.same_day_booking_policies
         (property_id, enabled, cutoff_local_time, revision)
       VALUES ($1::uuid, TRUE, '18:00', 1)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.channel_binding_claims
         (property_id, provider, external_property_id, claim_state, claim_source)
       VALUES ($1::uuid, 'channex', 'chx-same-day-concurrency', 'active', 'repair')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections
         (id, property_id, provider, connection_status, external_property_id)
       VALUES ($2::uuid, $1::uuid, 'channex', 'connected', 'chx-same-day-concurrency')`,
      [propertyId, connectionId],
    );
  });

  afterAll(async () => {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await port.close?.();
    await blocker.end();
    await cleanup();
    await admin.end();
  });

  it("restores A after an in-flight A-to-B update and publishes revision 3", async () => {
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT property.id FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid FOR UPDATE OF property`,
      [propertyId],
    );
    await blocker.query(
      `UPDATE booking.same_day_booking_policies
       SET enabled = FALSE, cutoff_local_time = '12:30', revision = revision + 1
       WHERE property_id = $1::uuid`,
      [propertyId],
    );

    const pid = await backendPid(commandPool);
    const restore = port.update(context(), propertyId, {
      commandId: "restore-a",
      idempotencyKey: "restore-a",
      enabled: true,
      cutoffLocalTime: "18:00",
    });
    await waitForLockWaiter(admin, pid);
    await blocker.query("COMMIT");

    await expect(restore).resolves.toMatchObject({
      ok: true,
      replayed: false,
      channexOperationId: expect.any(String),
      settings: { enabled: true, cutoffLocalTime: "18:00", revision: 3 },
    });
    const result = await admin.query<{
      enabled: boolean;
      cutoffLocalTime: string;
      revision: number;
      outboxCount: number;
      jobCount: number;
    }>(
      `SELECT policy.enabled, policy.cutoff_local_time AS "cutoffLocalTime", policy.revision,
         (SELECT count(*)::int FROM platform.outbox_events
          WHERE property_id = $1::uuid
            AND event_type = 'booking.same_day_booking_policy.changed') AS "outboxCount",
         (SELECT count(*)::int FROM platform.jobs
          WHERE property_id = $1::uuid AND job_type = 'channex.sync_ari') AS "jobCount"
       FROM booking.same_day_booking_policies policy WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(result.rows[0]).toEqual({
      enabled: true,
      cutoffLocalTime: "18:00",
      revision: 3,
      outboxCount: 1,
      jobCount: 1,
    });
  });

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
        "DELETE FROM pms.channel_connections WHERE property_id = $1::uuid",
        "DELETE FROM pms.channel_binding_claims WHERE property_id = $1::uuid",
        "DELETE FROM booking.same_day_booking_policies WHERE property_id = $1::uuid",
        "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
        "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
        "DELETE FROM identity.users WHERE id = $1::uuid",
      ]) {
        await admin.query(statement, [statement.includes("identity.users") ? userId : propertyId]);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

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
  throw new Error("Timed out waiting for the settings writer to acquire the property lock");
}

function context(): RequestContext {
  return {
    actor: { internalUserId: userId },
    audit: { requestId: "restore-a", correlationId: "restore-a" },
  } as RequestContext;
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
