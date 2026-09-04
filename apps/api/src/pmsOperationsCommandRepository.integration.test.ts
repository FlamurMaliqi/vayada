import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import { createPgPmsPhysicalRoomOperationalLabelRepository } from "./domains/pmsPhysicalRoomOperationalLabelRepository.js";
import { createPgPmsPhysicalRoomUnitReconcileRepository } from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";
import { pmsRoomOrderVersion } from "./domains/pmsRoomOrder.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import type { PmsRoomOrderCommand, PmsRoomTypeCreateCommand } from "./routes/pmsOperations.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "95959595-9595-4595-8595-959595959501";
const organizationId = "95959595-9595-4595-8595-959595959502";
const propertyId = "95959595-9595-4595-8595-959595959503";

describe.skipIf(!TEST_DATABASE_URL)("first-run PMS room setup concurrency", () => {
  const control = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const lifecycleReadRepository = createTargetPmsOperationsReadRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
    readRepository: lifecycleReadRepository,
    now: () => new Date("2026-07-27T13:00:00.000Z"),
  });
  const reconcileRepository = createPgPmsPhysicalRoomUnitReconcileRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    now: () => new Date("2026-07-27T13:00:00.000Z"),
  });
  const labelRepository = createPgPmsPhysicalRoomOperationalLabelRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
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
    await control.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES ($1::uuid, 'pms', 'pms_property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await control.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await control.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id
       ) VALUES (
         $1::uuid, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2
       )`,
      [organizationId, propertyId],
    );
  });

  beforeEach(async () => {
    await cleanupPmsData();
  });

  afterAll(async () => {
    await repository.close?.();
    await reconcileRepository.close();
    await labelRepository.close();
    await lifecycleReadRepository.close?.();
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

  it("creates, verifies, reduces, and re-expands across a retired case-only label collision", async () => {
    const legacy = await repository.createRoomType(
      roomCommand("generated-cycle-legacy", "Legacy Suite", false),
    );
    if (!legacy.ok) throw new Error("Expected legacy room type to be created");
    await control.query(
      `UPDATE pms.rooms
       SET room_number='CYCLE SUITE 1', operational_label_status='verified', status='retired'
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid`,
      [propertyId, legacy.roomType.roomTypeId],
    );

    const created = await repository.createRoomType(
      roomCommand("generated-cycle", "Cycle Suite", false, 3),
    );
    if (!created.ok) throw new Error("Expected generated room type to be created");
    const roomTypeId = created.roomType.roomTypeId;
    const initialUnits = await control.query<{
      roomUnitId: string;
      operationalLabel: string | null;
      setupGenerated: boolean;
    }>(
      `SELECT id::text AS "roomUnitId", room_number AS "operationalLabel",
              COALESCE(room_metadata ->> 'setupGenerated', 'false') = 'true' AS "setupGenerated"
       FROM pms.rooms
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status<>'retired'
       ORDER BY sort_order, id`,
      [propertyId, roomTypeId],
    );
    expect(initialUnits.rows).toMatchObject([
      { operationalLabel: null, setupGenerated: true },
      { operationalLabel: null, setupGenerated: true },
      { operationalLabel: null, setupGenerated: true },
    ]);

    let revision = 1;
    await expect(
      labelRepository.setPhysicalRoomOperationalLabel({
        organizationId,
        propertyId,
        roomTypeId,
        roomUnitId: initialUnits.rows[0]!.roomUnitId,
        expectedRevision: revision,
        operationalLabel: "Cycle Suite 1",
        idempotencyKey: "pms-room-cycle-label-conflict",
        audit: roomFactsAudit("label-conflict"),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "operational_label_conflict" } });
    for (const [index, unit] of initialUnits.rows.entries()) {
      const operationalLabel = `Cycle Suite ${index + 2}`;
      const result = await labelRepository.setPhysicalRoomOperationalLabel({
        organizationId,
        propertyId,
        roomTypeId,
        roomUnitId: unit.roomUnitId,
        expectedRevision: revision,
        operationalLabel,
        idempotencyKey: `pms-room-cycle-label-${index}`,
        audit: roomFactsAudit(`label-${index}`),
      });
      if (!result.ok) throw new Error("Expected generated room label to be verified");
      revision = result.response.roomUnitsRevision;
    }

    const reduced = await reconcileRepository.reconcilePhysicalRoomUnits({
      organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: revision,
      targetActiveUnitCount: 2,
      idempotencyKey: "pms-room-cycle-reduce",
      audit: roomFactsAudit("reduce"),
    });
    if (!reduced.ok) throw new Error("Expected generated room count to be reduced");
    expect(reduced.response.retiredUnitIds).toEqual([initialUnits.rows[2]!.roomUnitId]);
    revision = reduced.response.capacity.roomUnitsRevision;

    const expanded = await reconcileRepository.reconcilePhysicalRoomUnits({
      organizationId,
      propertyId,
      roomTypeId,
      expectedRevision: revision,
      targetActiveUnitCount: 3,
      idempotencyKey: "pms-room-cycle-expand",
      audit: roomFactsAudit("expand"),
    });
    if (!expanded.ok) throw new Error("Expected generated room count to be re-expanded");
    revision = expanded.response.capacity.roomUnitsRevision;
    const addedUnit = expanded.response.addedUnits[0];
    if (!addedUnit) throw new Error("Expected a replacement generated room");
    const labeled = await labelRepository.setPhysicalRoomOperationalLabel({
      organizationId,
      propertyId,
      roomTypeId,
      roomUnitId: addedUnit.roomUnitId,
      expectedRevision: revision,
      operationalLabel: "Cycle Suite 5",
      idempotencyKey: "pms-room-cycle-label-replacement",
      audit: roomFactsAudit("label-replacement"),
    });
    if (!labeled.ok) throw new Error("Expected replacement room label to remain unique");

    await expect(
      control.query<{ operationalLabel: string }>(
        `SELECT room_number AS "operationalLabel"
         FROM pms.rooms
         WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status<>'retired'
         ORDER BY sort_order, id`,
        [propertyId, roomTypeId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { operationalLabel: "Cycle Suite 2" },
        { operationalLabel: "Cycle Suite 3" },
        { operationalLabel: "Cycle Suite 5" },
      ],
    });
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

  it("duplicates configuration without operational state, replays, and safely retires the copy", async () => {
    const created = await repository.createRoomType(
      roomCommand("lifecycle-source", "Lifecycle Suite", false),
    );
    if (!created.ok) throw new Error("Expected lifecycle source room type");
    const duplicateCommand = {
      propertyId,
      roomTypeId: created.roomType.roomTypeId,
      commandId: "pms-room-lifecycle-duplicate",
      idempotencyKey: "pms-room-lifecycle-duplicate",
      expectedVersion: created.roomType.version,
      audit: createdCommandAudit("Duplicate room type"),
    };

    const duplicated = await repository.duplicateRoomType(duplicateCommand);
    const replay = await repository.duplicateRoomType(duplicateCommand);
    expect(duplicated).toMatchObject({
      ok: true,
      roomType: { name: "Lifecycle Suite Copy", roomCount: 0, version: "room-type-facts-v1" },
    });
    expect(replay).toEqual({ ...duplicated, replayed: true });
    if (!duplicated.ok) throw new Error("Expected room type duplicate");

    const copiedState = await control.query<{
      roomCount: string;
      inventoryCount: string;
      mappingCount: string;
      ratePlanCount: string;
    }>(
      `SELECT
         (SELECT count(*) FROM pms.rooms WHERE property_id=$1::uuid AND room_type_id=$2::uuid)::text AS "roomCount",
         (SELECT count(*) FROM pms.inventory_days WHERE property_id=$1::uuid AND room_type_id=$2::uuid)::text AS "inventoryCount",
         (SELECT count(*) FROM pms.channel_room_type_mappings WHERE property_id=$1::uuid AND room_type_id=$2::uuid)::text AS "mappingCount",
         (SELECT count(*) FROM pms.rate_plans WHERE property_id=$1::uuid AND room_type_id=$2::uuid)::text AS "ratePlanCount"`,
      [propertyId, duplicated.roomType.roomTypeId],
    );
    expect(copiedState.rows[0]).toEqual({
      roomCount: "0",
      inventoryCount: "0",
      mappingCount: "0",
      ratePlanCount: "1",
    });

    const impact = await repository.inspectRoomTypeRetirement(
      propertyId,
      duplicated.roomType.roomTypeId,
    );
    expect(impact).toMatchObject({ canRetire: true, blockers: [] });
    const retireCommand = {
      ...duplicateCommand,
      roomTypeId: duplicated.roomType.roomTypeId,
      commandId: "pms-room-lifecycle-retire",
      idempotencyKey: "pms-room-lifecycle-retire",
      expectedVersion: duplicated.roomType.version,
      audit: createdCommandAudit("Retire room type"),
    };
    const retired = await repository.retireRoomType(retireCommand);
    const retireReplay = await repository.retireRoomType(retireCommand);
    expect(retired).toMatchObject({ ok: true, impact: { version: "room-type-facts-v2" } });
    expect(retireReplay).toEqual({ ...retired, replayed: true });

    await expect(
      control.query<{ active: boolean; activeRatePlans: string }>(
        `SELECT room_type.active,
                count(rate_plan.id) FILTER (WHERE rate_plan.active)::text AS "activeRatePlans"
         FROM pms.room_types room_type
         LEFT JOIN pms.rate_plans rate_plan
           ON rate_plan.property_id=room_type.property_id AND rate_plan.room_type_id=room_type.id
         WHERE room_type.property_id=$1::uuid AND room_type.id=$2::uuid
         GROUP BY room_type.active`,
        [propertyId, duplicated.roomType.roomTypeId],
      ),
    ).resolves.toMatchObject({ rows: [{ active: false, activeRatePlans: "0" }] });
    await expect(
      control.query<{ auditCount: string; outboxCount: string }>(
        `SELECT
           (SELECT count(*) FROM platform.product_audit_events
            WHERE property_id=$1::uuid AND action IN ('pms.room_type.duplicated','pms.room_type.retired'))::text AS "auditCount",
           (SELECT count(*) FROM platform.outbox_events
            WHERE property_id=$1::uuid AND resource_id=$2::uuid::text)::text AS "outboxCount"`,
        [propertyId, duplicated.roomType.roomTypeId],
      ),
    ).resolves.toMatchObject({ rows: [{ auditCount: "2", outboxCount: "4" }] });
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
      await control.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await control.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await control.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        [organizationId],
      );
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
  roomCount = 1,
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
    roomCount,
    audit: {
      actor: { kind: "user", userId: actorUserId, organizationId },
      requestId: commandId,
      correlationId: commandId,
      reason: "Create first room during hotel setup",
      requestedAt: "2026-07-27T13:00:00.000Z",
    },
  };
}

function roomFactsAudit(suffix: string) {
  return {
    actor: { kind: "user" as const, userId: actorUserId },
    requestId: `pms-room-cycle-${suffix}`,
    correlationId: "pms-room-cycle",
    requestedAt: "2026-07-27T13:00:00.000Z",
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

function createdCommandAudit(reason: string) {
  return {
    actor: { kind: "user" as const, userId: actorUserId, organizationId },
    requestId: `pms-room-lifecycle-${reason.toLowerCase().replaceAll(" ", "-")}`,
    correlationId: "pms-room-lifecycle",
    reason,
    requestedAt: "2026-07-27T13:00:00.000Z",
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
