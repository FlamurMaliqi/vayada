import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannexManagementJob } from "./pmsChannexManagementWorker.js";
import {
  applyPmsChannexManagementProgress,
  createPmsChannexManagementTargetState,
} from "./pmsChannexManagementTargetState.js";

const URL = process.env["TEST_DATABASE_URL"],
  PROPERTY_ID = "84500000-0000-4000-8000-000000000001",
  NOW = new Date("2026-08-21T10:00:00.000Z");
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!URL)("Channex booking revision tombstones (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled" });

  beforeAll(async () => {
    await cleanup();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay-845-tombstones','Tombstones')",
      [PROPERTY_ID],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("preserves exact bindings, archives disabled tombstones, and governs retention", async () => {
    const client = await db.connect();
    try {
      await applyPmsChannexManagementProgress(
        client,
        job("enable"),
        { ok: true, externalPropertyId: "external-a", connectionStatus: "connected" },
        NOW,
      );
      const first = await connection();
      await insertTombstone(first, "booking-old");

      await applyPmsChannexManagementProgress(
        client,
        job("enable"),
        { ok: true, externalPropertyId: "external-a", connectionStatus: "connected" },
        NOW,
      );
      expect((await connection()).generation).toBe(first.generation);

      await expect(
        createPmsChannexManagementTargetState().succeed(
          client,
          job("provision"),
          { ok: true, externalPropertyId: "external-b" },
          NOW,
        ),
      ).rejects.toThrow("Channex binding claim is not active");
      expect(await connection()).toEqual(first);

      await applyPmsChannexManagementProgress(
        client,
        job("disable"),
        { ok: true, connectionStatus: "disconnected" },
        NOW,
      );
      const disconnected = await connection();
      expect(disconnected.generation).not.toBe(first.generation);
      expect(await activeCount(first, "booking-old")).toBe(0);

      await db.query(
        `INSERT INTO pms.channel_booking_revision_tombstones(
           connection_id,property_id,binding_generation,external_booking_id,
           authoritative_revision_id,inserted_at,created_at,retention_expires_at)
         VALUES($1,$2,$3,'expired','revision-expired',now(),now()-interval '90 days',now()-interval '1 microsecond')`,
        [disconnected.id, PROPERTY_ID, disconnected.generation],
      );
      expect(await activeCount(disconnected, "expired")).toBe(0);
      await insertTombstone(disconnected, "cleanup-probe");
      expect(
        (
          await db.query(
            "SELECT count(*)::int count FROM pms.channel_booking_revision_tombstones WHERE external_booking_id='expired'",
          )
        ).rows[0]?.count,
      ).toBe(0);
      await expect(
        db.query(
          `INSERT INTO pms.channel_booking_revision_tombstones(
             connection_id,property_id,binding_generation,external_booking_id,
             authoritative_revision_id,inserted_at,retention_expires_at)
           VALUES($1,$2,$3,'over-retained','revision-over-retained',now(),now()+interval '91 days')`,
          [disconnected.id, PROPERTY_ID, disconnected.generation],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await insertTombstone(disconnected, "resolved");
      await db.query(
        "UPDATE pms.channel_booking_revision_tombstones SET resolved_at=now(),updated_at=now() WHERE connection_id=$1 AND binding_generation=$2 AND external_booking_id='resolved'",
        [disconnected.id, disconnected.generation],
      );
      expect(await activeCount(disconnected, "resolved")).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects an unreviewed external-property rebind", async () => {
    await db.query("DELETE FROM pms.channel_connections WHERE property_id=$1", [PROPERTY_ID]);
    await db.query("DELETE FROM pms.channel_binding_claims WHERE property_id=$1", [PROPERTY_ID]);
    await applyPmsChannexManagementProgress(
      db,
      job("enable"),
      { ok: true, externalPropertyId: "race-a", connectionStatus: "connected" },
      NOW,
    );
    const current = await connection();

    await expect(
      db.query("UPDATE pms.channel_connections SET external_property_id='race-b' WHERE id=$1", [
        current.id,
      ]),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_pms_channel_binding_claims_provider_external",
    });
    expect(await connection()).toEqual(current);
  });

  type Connection = { id: string; generation: string; externalPropertyId: string | null };
  async function connection(): Promise<Connection> {
    return (
      await db.query<Connection>(
        `SELECT id::text,binding_generation::text AS generation,
           external_property_id AS "externalPropertyId"
         FROM pms.channel_connections WHERE property_id=$1 AND provider='channex'`,
        [PROPERTY_ID],
      )
    ).rows[0]!;
  }
  async function insertTombstone(
    connection: Connection,
    bookingId: string,
    executor: pg.Pool | pg.PoolClient = db,
  ) {
    await executor.query(
      `INSERT INTO pms.channel_booking_revision_tombstones(
         connection_id,property_id,binding_generation,external_booking_id,
         authoritative_revision_id,inserted_at)
       VALUES($1,$2,$3,$4,$5,'2026-08-20T12:00:00.123456Z')`,
      [connection.id, PROPERTY_ID, connection.generation, bookingId, `revision-${bookingId}`],
    );
  }
  async function activeCount(connection: Connection, bookingId: string): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int count FROM pms.channel_booking_revision_tombstones
       WHERE connection_id=$1 AND binding_generation=$2 AND external_booking_id=$3
         AND resolved_at IS NULL AND retention_expires_at>now()`,
      [connection.id, connection.generation, bookingId],
    );
    return result.rows[0]!.count;
  }
  async function cleanup() {
    await db.query("DELETE FROM pms.channel_connections WHERE property_id=$1", [PROPERTY_ID]);
    await db.query("DELETE FROM pms.channel_binding_claims WHERE property_id=$1", [PROPERTY_ID]);
    await db.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [PROPERTY_ID]);
  }
});

function job(operationType: ChannexManagementJob["input"]["operationType"]): ChannexManagementJob {
  return {
    jobId: "vay-845",
    propertyId: PROPERTY_ID,
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "vay-845", idempotencyKey: "vay-845", operationType },
  };
}
