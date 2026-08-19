import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import type { PmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import { pmsRoomOrderVersion } from "./domains/pmsRoomOrder.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import type { PmsRoomOrderCommand, PmsRoomTypeCreateCommand } from "./routes/pmsOperations.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "95959595-9595-4595-8595-959595959501";
const organizationId = "95959595-9595-4595-8595-959595959502";
const propertyId = "95959595-9595-4595-8595-959595959503";

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

describe.skipIf(!TEST_DATABASE_URL)("first-run PMS room setup concurrency", () => {
  const control = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
    readRepository,
    now: () => new Date("2026-07-27T13:00:00.000Z"),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await control.connect();
    await cleanup();
    await control.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'pms-room-race@example.test', 'PMS Room Race', 'active')`,
      [actorUserId],
    );
    await control.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'PMS Room Race', 'pms-room-race', 'active')`,
      [organizationId],
    );
    await control.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'pms-room-race', 'PMS Room Race')`,
      [propertyId],
    );
  });

  beforeEach(async () => {
    await cleanupPmsData();
  });

  afterAll(async () => {
    await repository.close?.();
    await cleanup();
    await control.end();
  });

  it("allows exactly one of two simultaneous first-room commands", async () => {
    await control.query("BEGIN");
    await control.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(concat('pms-initial-room-setup:', $1::text), 0)
       )`,
      [propertyId],
    );

    const first = repository.createRoomType(roomCommand("first", "Garden Room"));
    const second = repository.createRoomType(roomCommand("second", "Courtyard Room"));

    try {
      await waitForAdvisoryWaiters(2);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      await Promise.allSettled([first, second]);
      throw error;
    }

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        statusCode: 409,
        code: "room_type_conflict",
      }),
    ]);
    await expect(
      control.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pms.room_types
         WHERE property_id = $1::uuid`,
        [propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    const facts = await createPgPmsRoomFactsReadModel({
      connectionString: TEST_DATABASE_URL!,
      pool: control,
    }).listRoomTypeFacts(propertyId);
    expect(facts[0]?.facts).toMatchObject({
      beds: [{ type: "king_bed", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 32, unit: "sqm" },
    });
  });

  it("serializes concurrent room appends across room types", async () => {
    await control.query("BEGIN");
    await control.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('pms.room-order:' || $1::uuid::text, 0)
       )`,
      [propertyId],
    );

    const first = repository.createRoomType(roomCommand("append-first", "Garden Room", false));
    const second = repository.createRoomType(roomCommand("append-second", "Courtyard Room", false));

    try {
      await waitForAdvisoryWaiters(2);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      await Promise.allSettled([first, second]);
      throw error;
    }

    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    await expect(
      control.query<{ roomCount: string; distinctOrderCount: string }>(
        `SELECT count(*)::text AS "roomCount",
                count(DISTINCT sort_order)::text AS "distinctOrderCount"
         FROM pms.rooms
         WHERE property_id = $1::uuid AND status <> 'retired'`,
        [propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ roomCount: "2", distinctOrderCount: "2" }] });
  });

  it("persists reorder across connections and rejects a stale session without duplicate audit", async () => {
    await repository.createRoomType(roomCommand("order-first", "Garden Room", false));
    await repository.createRoomType(roomCommand("order-second", "Courtyard Room", false));
    await control.query("UPDATE pms.rooms SET sort_order = 1 WHERE property_id = $1::uuid", [
      propertyId,
    ]);
    const initial = await control.query<{ roomId: string }>(
      `SELECT id::text AS "roomId"
       FROM pms.rooms
       WHERE property_id = $1::uuid AND status <> 'retired'
       ORDER BY sort_order ASC, room_number ASC, id ASC`,
      [propertyId],
    );
    const initialIds = initial.rows.map(({ roomId }) => roomId);
    const desiredIds = [...initialIds].reverse();
    const command = roomOrderCommand("saved", desiredIds, pmsRoomOrderVersion(initialIds));

    const saved = await repository.reorderRooms!(command);
    const replayed = await repository.reorderRooms!(command);
    const stale = await repository.reorderRooms!(
      roomOrderCommand("stale", initialIds, pmsRoomOrderVersion(initialIds)),
    );

    expect(saved).toMatchObject({ ok: true, orderedRoomIds: desiredIds });
    expect(replayed).toMatchObject({ ok: true, orderedRoomIds: desiredIds, replayed: true });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict" });

    const fresh = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await fresh.connect();
    try {
      const persisted = await fresh.query<{ roomId: string; sortOrder: number }>(
        `SELECT id::text AS "roomId", sort_order AS "sortOrder"
         FROM pms.rooms
         WHERE property_id = $1::uuid AND status <> 'retired'
         ORDER BY sort_order ASC, room_number ASC, id ASC`,
        [propertyId],
      );
      expect(persisted.rows).toEqual(
        desiredIds.map((roomId, index) => ({ roomId, sortOrder: index + 1 })),
      );
      await expect(
        fresh.query<{ auditCount: string }>(
          `SELECT count(*)::text AS "auditCount"
           FROM platform.product_audit_events
           WHERE property_id = $1::uuid AND action = 'pms.rooms.reordered'`,
          [propertyId],
        ),
      ).resolves.toMatchObject({ rows: [{ auditCount: "1" }] });
      await expect(
        fresh.query<{ commandCount: string }>(
          `SELECT count(*)::text AS "commandCount"
           FROM platform.idempotency_keys
           WHERE property_id = $1::uuid AND operation = 'room_reorder'`,
          [propertyId],
        ),
      ).resolves.toMatchObject({ rows: [{ commandCount: "1" }] });
    } finally {
      await fresh.end();
    }
  });

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await control.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = FALSE`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent room setup commands did not reach the advisory lock");
  }

  async function cleanup(): Promise<void> {
    await control.query("BEGIN");
    try {
      await control.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await control.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await control.query(
        "DELETE FROM platform.product_audit_events WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await control.query(
        `DELETE FROM platform.idempotency_keys
         WHERE organization_id = $1::uuid
            OR property_id = $2::uuid`,
        [organizationId, propertyId],
      );
      await control.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
      await control.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await control.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      await control.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
  }

  async function cleanupPmsData(): Promise<void> {
    await control.query("BEGIN");
    try {
      await control.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await control.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await control.query(
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        [propertyId],
      );
      await control.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await control.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
  }
});

function roomCommand(
  suffix: string,
  name: string,
  initialSetupOnly = true,
): PmsRoomTypeCreateCommand {
  const commandId = `pms-room-race-${suffix}`;
  return {
    propertyId,
    commandId,
    idempotencyKey: commandId,
    initialSetupOnly,
    name,
    description: "",
    category: "double",
    occupancyLimits: { adults: 2, children: 0, total: 2 },
    attributes: {
      bedType: "1 King Bed",
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: 32,
    },
    amenities: [],
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
      requestId: commandId,
      correlationId: commandId,
      reason: "Create first room during hotel setup",
      requestedAt: "2026-07-27T13:00:00.000Z",
    },
  };
}

function roomOrderCommand(
  suffix: string,
  orderedRoomIds: string[],
  expectedVersion: string,
): PmsRoomOrderCommand {
  const commandId = `pms-room-order-${suffix}`;
  return {
    propertyId,
    commandId,
    idempotencyKey: commandId,
    expectedVersion,
    orderedRoomIds,
    audit: {
      actor: { kind: "user", userId: actorUserId, organizationId },
      requestId: commandId,
      correlationId: commandId,
      reason: "Reorder rooms",
      requestedAt: "2026-07-27T13:00:00.000Z",
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
