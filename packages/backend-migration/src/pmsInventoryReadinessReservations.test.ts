import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0057_pms_inventory_readiness_reservations.sql"),
  "utf8",
);
const handoffMigration = await readFile(
  join(import.meta.dirname, "../migrations/0111_pms_inventory_receipt_handoff.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "40000000-0000-4000-8000-000000000001";
const RECEIPT_ID = "80000000-0000-4000-8000-000000000001";
const OTHER_RECEIPT_ID = "80000000-0000-4000-8000-000000000002";
const GAP_RECEIPT_ID = "80000000-0000-4000-8000-000000000003";
const RUNTIME_ROLE = "vay1063_inventory_runtime";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const EVIDENCE = {
  materialize1: evidenceIds("01"),
  materialize2: evidenceIds("02"),
  reserve1: evidenceIds("11"),
  release1: evidenceIds("12"),
  reserve2: evidenceIds("21"),
  reserve3: evidenceIds("31"),
} as const;

describe("PMS inventory readiness and reservation migration contract", () => {
  it("adopts exact direct-booking receipts in the assignment transaction", () => {
    expect(handoffMigration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(handoffMigration).toContain("FOR UPDATE OF status");
    expect(handoffMigration).toContain("assignment_count <> receipt_row.room_count");
    expect(handoffMigration).toContain("lifecycle_state = 'handed_off'");
    expect(handoffMigration).toContain("source_assignment_id = target_assignment_id");
  });

  it("is additive for legacy inventory and contains no Distribution coupling", () => {
    expect(migration).toContain("ALTER TABLE pms.inventory_days");
    expect(migration).toContain("chk_pms_inventory_days_canonical_envelope");
    expect(migration).toContain("calendar_revision IS NULL");
    expect(migration).toContain("status IN ('open', 'closed')");
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+distribution\./i);
    expect(migration).not.toMatch(/REFERENCES\s+distribution\./i);
  });

  it("freezes source identity, precedence, and the floor-at-zero formula", () => {
    expect(migration).toContain("generated_source_revision = calendar_revision");
    expect(migration).toContain("materialized_revision = calendar_revision");
    expect(migration).toContain(
      "effective_sellable_limit_count = COALESCE(\n          manual_sellable_limit_count",
    );
    expect(migration).toContain("ELSE GREATEST(");
    expect(migration).toContain("assigned_count + blocked_count <= total_count");
    expect(migration).not.toContain(
      "assigned_count + blocked_count <= effective_sellable_limit_count",
    );
  });

  it("persists scoped current coverage and an opaque non-legacy receipt lifecycle", () => {
    expect(migration).toContain("CREATE TABLE pms.inventory_materialization_coverage");
    expect(migration).toContain("last_changed_materialization_domain_event_id");
    expect(migration).toContain("CREATE TABLE pms.inventory_reservation_receipts");
    expect(migration).toContain("'pms-inventory-reservation-lifecycle.v1'");
    expect(migration).not.toContain("'pms.inventory-reservation.v1'");
    expect(migration).toContain("CREATE TABLE pms.inventory_reservation_statuses");
    expect(migration).toContain("lifecycle_state = 'handed_off'");
    expect(migration).toContain("fk_pms_inventory_reservation_watermark_inventory_day");
    expect(migration).toContain("idx_pms_inventory_reservation_receipts_checkout");
  });

  it("uses deferred exact manifests and immutable terminal evidence", () => {
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThanOrEqual(6);
    expect(migration).toContain("chk_pms_inventory_coverage_manifest");
    expect(migration).toContain("inventory_coverage_validation_queue");
    expect(migration).toContain("queue_inventory_coverage_validation");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain(
      "REVOKE ALL ON pms.inventory_coverage_validation_queue FROM PUBLIC",
    );
    expect(migration).toContain("chk_pms_inventory_reservation_manifest");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE ON pms.inventory_reservation_statuses");
    expect(migration).toContain("platform.prevent_append_only_mutation()");
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "PMS inventory readiness and reservation migration (PostgreSQL)",
  () => {
    let client: pg.Client;

    beforeEach(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await createPredecessorSchema(client);
      await client.query(migration);
      await seedOwnerAndPlatformEvidence(client);
    });

    afterEach(async () => {
      try {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
        await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
      } finally {
        await client.end();
      }
    });

    it("keeps legacy writers valid and rejects partial or falsely bound canonical rows", async () => {
      await client.query(
        `INSERT INTO pms.inventory_days (
           property_id, room_type_id, stay_date, total_count,
           assigned_count, blocked_count, available_count, status, source_freshness
         ) VALUES ($1::uuid, $2::uuid, DATE '2026-08-01', 10, 0, 0, 10, 'limited', '{"legacy":true}')`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      await client.query(
        `UPDATE pms.inventory_days
         SET assigned_count = 1, available_count = 9, updated_at = now()
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-01'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );

      await expect(
        client.query(
          `UPDATE pms.inventory_days SET calendar_revision = 1
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-01'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_canonical_envelope",
      });
      await expect(
        insertCanonicalDay(client, {
          stayDate: "2026-08-02",
          totalCount: 9,
        }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_pms_inventory_days_operating_calendar_room",
      });
      await expect(
        insertCanonicalDay(client, {
          stayDate: "2026-08-03",
          generatedRevision: 2,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_canonical_revisions",
      });

      const legacy = await client.query<{
        assignedCount: number;
        calendarRevision: number | null;
        status: string;
      }>(
        `SELECT assigned_count AS "assignedCount", calendar_revision AS "calendarRevision", status
         FROM pms.inventory_days WHERE stay_date = DATE '2026-08-01'`,
      );
      expect(legacy.rows).toEqual([
        { assignedCount: 1, calendarRevision: null, status: "limited" },
      ]);
    });

    it("freezes legacy freshness when a row first becomes canonical", async () => {
      await client.query(
        `INSERT INTO pms.inventory_days (
           property_id, room_type_id, stay_date, total_count,
           assigned_count, blocked_count, available_count, status, source_freshness
         ) VALUES ($1::uuid, $2::uuid, DATE '2026-08-01', 10, 0, 0, 10, 'open', '{"legacy":true}')`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      await expect(
        client.query(
          `UPDATE pms.inventory_days SET
             calendar_revision = 1, inventory_revision = 1,
             generated_sellable_limit_count = 8,
             effective_sellable_limit_count = 8,
             generated_source_revision = 1, channel_source_revision = 0,
             manual_source_revision = 0, block_source_revision = 0,
             booking_source_revision = 0, available_count = 8,
             source_freshness = '{"canonical":true}'
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-01'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_source_freshness_frozen",
      });
      await client.query(
        `UPDATE pms.inventory_days SET
           calendar_revision = 1, inventory_revision = 1,
           generated_sellable_limit_count = 8,
           effective_sellable_limit_count = 8,
           generated_source_revision = 1, channel_source_revision = 0,
           manual_source_revision = 0, block_source_revision = 0,
           booking_source_revision = 0, available_count = 8
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-01'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
    });

    it("allows lowered limits below consumption and releases without repairing owner state", async () => {
      await insertCanonicalDay(client, {
        stayDate: "2026-08-04",
        assignedCount: 8,
        bookingRevision: 7,
      });

      await client.query(
        `UPDATE pms.inventory_days SET
           manual_sellable_limit_count = 5,
           effective_sellable_limit_count = 5,
           manual_source_revision = 1,
           inventory_revision = 2,
           available_count = 0,
           updated_at = now()
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-04'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      await client.query(
        `UPDATE pms.inventory_days SET
           assigned_count = 6,
           booking_source_revision = 8,
           inventory_revision = 3,
           available_count = 0,
           updated_at = now()
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-04'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      const firstRelease = await readDay(client, "2026-08-04");
      expect(firstRelease).toMatchObject({
        assignedCount: 6,
        manualLimit: 5,
        manualRevision: 1,
        bookingRevision: 8,
        availableCount: 0,
      });

      await client.query(
        `UPDATE pms.inventory_days SET
           assigned_count = 4,
           booking_source_revision = 9,
           inventory_revision = 4,
           available_count = 1,
           updated_at = now()
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-04'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      expect(await readDay(client, "2026-08-04")).toMatchObject({
        assignedCount: 4,
        manualLimit: 5,
        manualRevision: 1,
        bookingRevision: 9,
        availableCount: 1,
      });

      await expect(
        client.query(
          `UPDATE pms.inventory_days SET
             assigned_count = 3,
             manual_sellable_limit_count = 4,
             manual_source_revision = 2,
             booking_source_revision = 10,
             inventory_revision = 5,
             available_count = 1
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-04'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_owner_revision_transition",
      });
    });

    it("forces closed availability to zero and rejects physical-capacity overflow", async () => {
      await insertCanonicalDay(client, {
        stayDate: "2026-08-04",
        assignedCount: 8,
        manualLimit: 5,
        status: "closed",
      });
      expect(await readDay(client, "2026-08-04")).toMatchObject({
        status: "closed",
        availableCount: 0,
      });
      await expect(
        insertCanonicalDay(client, {
          stayDate: "2026-08-05",
          assignedCount: 9,
          blockedCount: 2,
        }),
      ).rejects.toMatchObject({
        code: "23514",
      });
    });

    it("validates exact durable coverage and rejects replay evidence or later gaps", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04" });
      await insertCanonicalDay(client, { stayDate: "2026-08-05" });
      await insertCoverage(client);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");

      await expect(
        client.query(
          `UPDATE pms.inventory_materialization_coverage SET
             last_changed_materialization_idempotency_key_id = $2::uuid,
             last_changed_materialization_domain_event_id = $3::uuid,
             last_changed_materialization_outbox_event_id = $4::uuid,
             updated_at = updated_at + INTERVAL '1 second'
           WHERE property_id = $1::uuid`,
          [PROPERTY_ID, ...Object.values(EVIDENCE.materialize2)],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_coverage_changed_transition",
      });
      await expect(
        client.query(
          `DELETE FROM pms.inventory_days
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-05'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_coverage_manifest",
      });
      await expect(
        client.query(
          `DELETE FROM pms.inventory_materialization_coverage
           WHERE property_id = $1::uuid`,
          [PROPERTY_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query("TRUNCATE pms.inventory_materialization_coverage"),
      ).rejects.toMatchObject({ code: "55000" });
    });

    it("rolls back a deferred coverage gap atomically", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04" });
      await client.query("BEGIN");
      await insertCoverage(client);
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_coverage_manifest",
      });
      await client.query("ROLLBACK");
      const stored = await client.query("SELECT 1 FROM pms.inventory_materialization_coverage");
      expect(stored.rowCount).toBe(0);
    });

    it("keeps deferred coverage validation protected across tampering and savepoints", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04" });
      await insertCanonicalDay(client, { stayDate: "2026-08-05" });
      await insertCoverage(client);
      await client.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
      await client.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA pms TO ${RUNTIME_ROLE}`);
      await client.query(`GRANT SELECT, DELETE ON pms.inventory_days TO ${RUNTIME_ROLE}`);

      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        await expect(
          client.query("DELETE FROM pms.inventory_coverage_validation_queue"),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");

        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        await client.query("SAVEPOINT before_gap");
        await client.query(
          `DELETE FROM pms.inventory_days
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-05'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        );
        await client.query("ROLLBACK TO SAVEPOINT before_gap");
        await client.query(
          `DELETE FROM pms.inventory_days
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid
             AND stay_date = DATE '2026-08-05'`,
          [PROPERTY_ID, ROOM_TYPE_ID],
        );
        await client.query("SET LOCAL vayada.inventory_coverage_dirty_properties = ''");
        await expect(client.query("COMMIT")).rejects.toMatchObject({
          code: "23514",
          constraint: "chk_pms_inventory_coverage_manifest",
        });

        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await expect(
          client.query(
            `DELETE FROM pms.inventory_days
             WHERE property_id = $1::uuid AND room_type_id = $2::uuid
               AND stay_date = DATE '2026-08-05'`,
            [PROPERTY_ID, ROOM_TYPE_ID],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "chk_pms_inventory_coverage_manifest",
        });
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE");
        await client.query(`DROP OWNED BY ${RUNTIME_ROLE}`);
        await client.query(`DROP ROLE ${RUNTIME_ROLE}`);
      }

      const stored = await client.query(
        `SELECT count(*)::int AS count FROM pms.inventory_days
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      expect(stored.rows[0]?.count).toBe(2);
    });

    it("persists exact scoped receipts and makes release terminal and replay-safe", async () => {
      await insertCanonicalDay(client, {
        stayDate: "2026-08-04",
        assignedCount: 8,
        manualLimit: 5,
        manualRevision: 4,
        bookingRevision: 7,
      });
      await insertCanonicalDay(client, {
        stayDate: "2026-08-05",
        assignedCount: 8,
        manualLimit: 5,
        manualRevision: 4,
        bookingRevision: 7,
      });
      await insertReservation(client, {
        receiptId: RECEIPT_ID,
        evidence: EVIDENCE.reserve1,
        inventoryRevision: 1,
        bookingRevision: 7,
      });

      await expect(
        client.query(
          `DELETE FROM pms.inventory_reservation_statuses
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query("TRUNCATE pms.inventory_reservation_statuses"),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_statuses SET
             lifecycle_state = 'released', lifecycle_revision = 2,
             release_fingerprint_hash = NULL,
             release_idempotency_key_id = $2::uuid,
             release_domain_event_id = $3::uuid,
             release_outbox_event_id = $4::uuid,
             released_at = TIMESTAMPTZ '2026-08-03T20:01:00Z'
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID, ...Object.values(EVIDENCE.release1)],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_status_shape",
      });

      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_statuses SET
             lifecycle_state = 'released', lifecycle_revision = 2,
             release_fingerprint_hash = $2,
             release_idempotency_key_id = $3::uuid,
             release_domain_event_id = $4::uuid,
             release_outbox_event_id = $5::uuid,
             released_at = TIMESTAMPTZ '2026-08-03T20:01:00Z'
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID, HASH_B, ...Object.values(EVIDENCE.reserve1)],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_status_transition",
      });

      await client.query("BEGIN");
      await client.query(
        `UPDATE pms.inventory_days SET
           assigned_count = 6,
           booking_source_revision = 8,
           inventory_revision = 2,
           available_count = 0,
           updated_at = now()
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date >= DATE '2026-08-04' AND stay_date < DATE '2026-08-06'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      await releaseStatus(client, RECEIPT_ID);
      await client.query("COMMIT");

      const status = await client.query<{
        lifecycleState: string;
        lifecycleRevision: number;
      }>(
        `SELECT lifecycle_state AS "lifecycleState", lifecycle_revision AS "lifecycleRevision"
         FROM pms.inventory_reservation_statuses WHERE receipt_id = $1::uuid`,
        [RECEIPT_ID],
      );
      expect(status.rows).toEqual([{ lifecycleState: "released", lifecycleRevision: 2 }]);
      expect(await readDay(client, "2026-08-04")).toMatchObject({
        assignedCount: 6,
        availableCount: 0,
        bookingRevision: 8,
      });

      await client.query("BEGIN");
      await client.query(
        `UPDATE pms.inventory_days SET
           assigned_count = 4,
           booking_source_revision = 9,
           inventory_revision = 3,
           available_count = 1
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date >= DATE '2026-08-04' AND stay_date < DATE '2026-08-06'`,
        [PROPERTY_ID, ROOM_TYPE_ID],
      );
      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_statuses
           SET lifecycle_state = 'released', lifecycle_revision = 2
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_status_transition",
      });
      await client.query("ROLLBACK");
      expect(await readDay(client, "2026-08-04")).toMatchObject({
        assignedCount: 6,
        bookingRevision: 8,
      });
    });

    it("allows only a no-capacity handed-off terminal transition", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04", assignedCount: 2 });
      await insertCanonicalDay(client, { stayDate: "2026-08-05", assignedCount: 2 });
      await insertReservation(client, {
        receiptId: OTHER_RECEIPT_ID,
        evidence: EVIDENCE.reserve2,
        inventoryRevision: 1,
        bookingRevision: 0,
      });
      await client.query(
        `UPDATE pms.inventory_reservation_statuses SET
           lifecycle_state = 'handed_off', lifecycle_revision = 2,
           handed_off_at = TIMESTAMPTZ '2026-08-03T20:01:00Z'
         WHERE receipt_id = $1::uuid`,
        [OTHER_RECEIPT_ID],
      );
      expect(await readDay(client, "2026-08-04")).toMatchObject({
        assignedCount: 2,
        inventoryRevision: 1,
      });
      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_statuses
           SET handed_off_at = TIMESTAMPTZ '2026-08-03T20:02:00Z'
           WHERE receipt_id = $1::uuid`,
          [OTHER_RECEIPT_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_status_transition",
      });
    });

    it("rejects wrong owner scope, revision mismatches, and mutable receipt evidence", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04" });
      await insertCanonicalDay(client, { stayDate: "2026-08-05" });
      await expect(
        insertReceiptRow(client, {
          receiptId: RECEIPT_ID,
          organizationId: OTHER_ORGANIZATION_ID,
          evidence: EVIDENCE.reserve1,
        }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_pms_inventory_reservation_receipt_calendar_organization",
      });
      await expect(
        insertReceiptRow(client, {
          receiptId: RECEIPT_ID,
          materializedRevision: 2,
          evidence: EVIDENCE.reserve1,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_receipt_revision_identity",
      });

      await insertReservation(client, {
        receiptId: RECEIPT_ID,
        evidence: EVIDENCE.reserve1,
        inventoryRevision: 1,
        bookingRevision: 0,
      });
      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_receipts SET quote_session_id = 'changed'
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query(
          `UPDATE pms.inventory_reservation_day_watermarks SET inventory_revision = 2
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query(
          `DELETE FROM pms.inventory_reservation_day_watermarks
           WHERE receipt_id = $1::uuid`,
          [RECEIPT_ID],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query("TRUNCATE pms.inventory_reservation_day_watermarks"),
      ).rejects.toMatchObject({ code: "55000" });
    });

    it("rolls back an incomplete deferred reservation manifest", async () => {
      await insertCanonicalDay(client, { stayDate: "2026-08-04" });
      await insertCanonicalDay(client, { stayDate: "2026-08-05" });
      await client.query("BEGIN");
      await insertReceiptRow(client, {
        receiptId: GAP_RECEIPT_ID,
        evidence: EVIDENCE.reserve3,
      });
      await insertReservedStatus(client, GAP_RECEIPT_ID);
      await insertWatermark(client, {
        receiptId: GAP_RECEIPT_ID,
        stayDate: "2026-08-04",
        inventoryRevision: 1,
        bookingRevision: 0,
      });
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_reservation_manifest",
      });
      await client.query("ROLLBACK");
      const stored = await client.query(
        "SELECT 1 FROM pms.inventory_reservation_receipts WHERE receipt_id = $1::uuid",
        [GAP_RECEIPT_ID],
      );
      expect(stored.rowCount).toBe(0);
    });
  },
);

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS pms CASCADE;
    DROP SCHEMA IF EXISTS platform CASCADE;
    CREATE SCHEMA platform;
    CREATE SCHEMA pms;

    CREATE FUNCTION platform.tenant_scope_key(
      tenant_scope TEXT, organization_id UUID, property_id UUID
    ) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
      SELECT CASE
        WHEN tenant_scope = 'property' THEN 'property:' || property_id::TEXT
        WHEN tenant_scope = 'organization' THEN 'organization:' || organization_id::TEXT
        ELSE tenant_scope
      END;
    $$;
    CREATE FUNCTION platform.prevent_append_only_mutation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'append-only' USING ERRCODE = '55000';
    END;
    $$;
    CREATE TABLE platform.idempotency_keys (
      id UUID PRIMARY KEY,
      scope_key TEXT NOT NULL,
      UNIQUE (id, scope_key)
    );
    CREATE TABLE platform.domain_events (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      UNIQUE (id, property_id)
    );
    CREATE TABLE platform.outbox_events (
      id UUID PRIMARY KEY,
      domain_event_id UUID NOT NULL,
      scope_key TEXT NOT NULL,
      UNIQUE (id, domain_event_id),
      UNIQUE (id, scope_key)
    );

    CREATE TABLE pms.operating_calendar_revisions (
      organization_id UUID NOT NULL,
      property_id UUID NOT NULL,
      calendar_revision INTEGER NOT NULL,
      PRIMARY KEY (property_id, calendar_revision)
    );
    CREATE TABLE pms.operating_calendar_room_bindings (
      property_id UUID NOT NULL,
      calendar_revision INTEGER NOT NULL,
      room_type_id UUID NOT NULL,
      physical_capacity_count SMALLINT NOT NULL,
      starting_sellable_limit_count SMALLINT NOT NULL,
      PRIMARY KEY (property_id, calendar_revision, room_type_id),
      FOREIGN KEY (property_id, calendar_revision)
        REFERENCES pms.operating_calendar_revisions(property_id, calendar_revision)
    );
    CREATE TABLE pms.inventory_days (
      property_id UUID NOT NULL,
      room_type_id UUID NOT NULL,
      stay_date DATE NOT NULL,
      total_count INTEGER NOT NULL CHECK (total_count >= 0),
      assigned_count INTEGER NOT NULL DEFAULT 0 CHECK (assigned_count >= 0),
      blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
      available_count INTEGER NOT NULL CHECK (available_count >= 0),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'limited')),
      source_freshness JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (property_id, room_type_id, stay_date),
      CONSTRAINT chk_pms_inventory_days_count_balance
        CHECK (available_count + assigned_count + blocked_count <= total_count)
    );
  `);
}

async function seedOwnerAndPlatformEvidence(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO pms.operating_calendar_revisions (
       organization_id, property_id, calendar_revision
     ) VALUES ($1::uuid, $2::uuid, 1), ($1::uuid, $2::uuid, 2)`,
    [ORGANIZATION_ID, PROPERTY_ID],
  );
  await client.query(
    `INSERT INTO pms.operating_calendar_room_bindings (
       property_id, calendar_revision, room_type_id,
       physical_capacity_count, starting_sellable_limit_count
     ) VALUES
       ($1::uuid, 1, $2::uuid, 10, 8),
       ($1::uuid, 2, $2::uuid, 10, 8)`,
    [PROPERTY_ID, ROOM_TYPE_ID],
  );
  for (const evidence of Object.values(EVIDENCE)) {
    await client.query(
      `INSERT INTO platform.idempotency_keys (id, scope_key)
       VALUES ($1::uuid, $2)`,
      [evidence.idempotencyId, `property:${PROPERTY_ID}`],
    );
    await client.query(
      `INSERT INTO platform.domain_events (id, property_id)
       VALUES ($1::uuid, $2::uuid)`,
      [evidence.domainEventId, PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO platform.outbox_events (id, domain_event_id, scope_key)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [evidence.outboxEventId, evidence.domainEventId, `property:${PROPERTY_ID}`],
    );
  }
}

async function insertCanonicalDay(
  client: pg.Client,
  options: {
    stayDate: string;
    totalCount?: number;
    assignedCount?: number;
    blockedCount?: number;
    channelLimit?: number | null;
    manualLimit?: number | null;
    status?: "open" | "closed";
    inventoryRevision?: number;
    generatedRevision?: number;
    channelRevision?: number;
    manualRevision?: number;
    blockRevision?: number;
    bookingRevision?: number;
  },
): Promise<void> {
  const totalCount = options.totalCount ?? 10;
  const assignedCount = options.assignedCount ?? 0;
  const blockedCount = options.blockedCount ?? 0;
  const channelLimit = options.channelLimit ?? null;
  const manualLimit = options.manualLimit ?? null;
  const effectiveLimit = manualLimit ?? channelLimit ?? 8;
  const status = options.status ?? "open";
  const availableCount =
    status === "closed" ? 0 : Math.max(0, effectiveLimit - assignedCount - blockedCount);
  await client.query(
    `INSERT INTO pms.inventory_days (
       property_id, room_type_id, stay_date, total_count,
       assigned_count, blocked_count, available_count, status, source_freshness,
       calendar_revision, inventory_revision,
       generated_sellable_limit_count, channel_sellable_limit_count,
       manual_sellable_limit_count, effective_sellable_limit_count,
       generated_source_revision, channel_source_revision,
       manual_source_revision, block_source_revision, booking_source_revision
     ) VALUES (
       $1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, '{}'::jsonb,
       1, $9, 8, $10, $11, $12, $13, $14, $15, $16, $17
     )`,
    [
      PROPERTY_ID,
      ROOM_TYPE_ID,
      options.stayDate,
      totalCount,
      assignedCount,
      blockedCount,
      availableCount,
      status,
      options.inventoryRevision ?? 1,
      channelLimit,
      manualLimit,
      effectiveLimit,
      options.generatedRevision ?? 1,
      options.channelRevision ?? 0,
      options.manualRevision ?? 0,
      options.blockRevision ?? 0,
      options.bookingRevision ?? 0,
    ],
  );
}

async function readDay(client: pg.Client, stayDate: string) {
  const result = await client.query<{
    assignedCount: number;
    availableCount: number;
    bookingRevision: number;
    inventoryRevision: number;
    manualLimit: number | null;
    manualRevision: number;
    status: string;
  }>(
    `SELECT assigned_count AS "assignedCount", available_count AS "availableCount",
            booking_source_revision AS "bookingRevision",
            inventory_revision AS "inventoryRevision",
            manual_sellable_limit_count AS "manualLimit",
            manual_source_revision AS "manualRevision", status
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND stay_date = $3::date`,
    [PROPERTY_ID, ROOM_TYPE_ID, stayDate],
  );
  return result.rows[0]!;
}

async function insertCoverage(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO pms.inventory_materialization_coverage (
       property_id, organization_id, calendar_revision, materialized_revision,
       coverage_from, coverage_through, room_type_count,
       expected_day_count, materialized_day_count,
       last_changed_materialization_idempotency_key_id,
       last_changed_materialization_domain_event_id,
       last_changed_materialization_outbox_event_id, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 1, 1, DATE '2026-08-04', DATE '2026-08-05',
       1, 2, 2, $3::uuid, $4::uuid, $5::uuid,
       TIMESTAMPTZ '2026-08-03T20:00:00Z'
     )`,
    [PROPERTY_ID, ORGANIZATION_ID, ...Object.values(EVIDENCE.materialize1)],
  );
}

async function insertReservation(
  client: pg.Client,
  options: {
    receiptId: string;
    evidence: EvidenceIds;
    inventoryRevision: number;
    bookingRevision: number;
  },
): Promise<void> {
  await client.query("BEGIN");
  await insertReceiptRow(client, options);
  await insertReservedStatus(client, options.receiptId);
  for (const stayDate of ["2026-08-04", "2026-08-05"]) {
    await insertWatermark(client, {
      receiptId: options.receiptId,
      stayDate,
      inventoryRevision: options.inventoryRevision,
      bookingRevision: options.bookingRevision,
    });
  }
  await client.query("COMMIT");
}

async function insertReceiptRow(
  client: pg.Client,
  options: {
    receiptId: string;
    evidence: EvidenceIds;
    organizationId?: string;
    materializedRevision?: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pms.inventory_reservation_receipts (
       receipt_id, contract_version, receipt_owner,
       organization_id, property_id, room_type_id,
       check_in, check_out, room_count, quote_session_id, public_offer_key,
       calendar_revision, materialized_revision, reserve_fingerprint_hash,
       reserve_idempotency_key_id, reserve_domain_event_id, reserve_outbox_event_id,
       reserved_at
     ) VALUES (
       $1::uuid, 'pms-inventory-reservation-lifecycle.v1', 'pms',
       $2::uuid, $3::uuid, $4::uuid,
       DATE '2026-08-04', DATE '2026-08-06', 2, 'quote-session-1', 'offer-1',
       1, $5, $6, $7::uuid, $8::uuid, $9::uuid,
       TIMESTAMPTZ '2026-08-03T20:00:00Z'
     )`,
    [
      options.receiptId,
      options.organizationId ?? ORGANIZATION_ID,
      PROPERTY_ID,
      ROOM_TYPE_ID,
      options.materializedRevision ?? 1,
      HASH_A,
      ...Object.values(options.evidence),
    ],
  );
}

async function insertReservedStatus(client: pg.Client, receiptId: string): Promise<void> {
  await client.query(
    `INSERT INTO pms.inventory_reservation_statuses (
       receipt_id, organization_id, property_id, lifecycle_state, lifecycle_revision
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'reserved', 1)`,
    [receiptId, ORGANIZATION_ID, PROPERTY_ID],
  );
}

async function insertWatermark(
  client: pg.Client,
  options: {
    receiptId: string;
    stayDate: string;
    inventoryRevision: number;
    bookingRevision: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pms.inventory_reservation_day_watermarks (
       receipt_id, organization_id, property_id, room_type_id, stay_date,
       calendar_revision, inventory_revision, generated_source_revision,
       channel_source_revision, manual_source_revision,
       block_source_revision, booking_source_revision
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date,
       1, $6, 1, 0, 0, 0, $7
     )`,
    [
      options.receiptId,
      ORGANIZATION_ID,
      PROPERTY_ID,
      ROOM_TYPE_ID,
      options.stayDate,
      options.inventoryRevision,
      options.bookingRevision,
    ],
  );
}

async function releaseStatus(client: pg.Client, receiptId: string): Promise<void> {
  await client.query(
    `UPDATE pms.inventory_reservation_statuses SET
       lifecycle_state = 'released', lifecycle_revision = 2,
       release_fingerprint_hash = $2,
       release_idempotency_key_id = $3::uuid,
       release_domain_event_id = $4::uuid,
       release_outbox_event_id = $5::uuid,
       released_at = TIMESTAMPTZ '2026-08-03T20:01:00Z'
     WHERE receipt_id = $1::uuid`,
    [receiptId, HASH_B, ...Object.values(EVIDENCE.release1)],
  );
}

type EvidenceIds = Readonly<{
  idempotencyId: string;
  domainEventId: string;
  outboxEventId: string;
}>;

function evidenceIds(suffix: string): EvidenceIds {
  return {
    idempotencyId: `50000000-0000-4000-8000-0000000000${suffix}`,
    domainEventId: `60000000-0000-4000-8000-0000000000${suffix}`,
    outboxEventId: `70000000-0000-4000-8000-0000000000${suffix}`,
  };
}
