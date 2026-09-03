import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsCalendarAutoOpenSettingsRepository } from "./pmsCalendarAutoOpenSettingsRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "14330000-0000-4000-8000-000000000001";

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
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'auto-open-concurrency', 'Auto-open Concurrency')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Vienna')`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await blocker.query("ROLLBACK");
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
    await Promise.all([firstPool.end(), secondPool.end(), admin.end()]);
    await blocker.end();
  });

  it("rereads after the property lock and rejects a stale virtual-default save", async () => {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE", [
      propertyId,
    ]);

    const firstPid = await backendPid(firstPool);
    const first = firstRepository.update(command(true));
    await waitForLockWaiter(admin, firstPid);

    const secondPid = await backendPid(secondPool);
    const second = secondRepository.update(command(false));
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
});

function command(enabled: boolean) {
  return {
    propertyId,
    expectedRevision: 0,
    enabled,
    mode: "rolling" as const,
    rollingMonths: 18 as const,
    fixedEndMonth: null,
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
