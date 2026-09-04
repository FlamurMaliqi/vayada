import {
  parseReconcilePhysicalRoomUnitsCommand,
  parseSetPhysicalRoomOperationalLabelCommand,
  type ReconcilePhysicalRoomUnitsCommand,
  type SetPhysicalRoomOperationalLabelCommand,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { createPgPmsPhysicalRoomOperationalLabelRepository } from "./pmsPhysicalRoomOperationalLabelRepository.js";
import {
  createPgPmsPhysicalRoomUnitReconcileRepository,
  type PmsPhysicalRoomUnitReconcileClient,
  type PmsPhysicalRoomUnitReconcilePool,
} from "./pmsPhysicalRoomUnitReconcileRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "d1070000-0000-4000-8000-000000000001";
const organizationId = "d1070000-0000-4000-8000-000000000002";
const propertyId = "d1070000-0000-4000-8000-000000000003";
const roomTypeId = "d1070000-0000-4000-8000-000000000004";
const guestBookingId = "d1070000-0000-4000-8000-000000000005";
const assignmentId = "d1070000-0000-4000-8000-000000000006";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS physical-room reconciliation", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgPmsPhysicalRoomUnitReconcileRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
  const labelRepository = createPgPmsPhysicalRoomOperationalLabelRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedRoomType();
  });

  afterAll(async () => {
    await repository.close();
    await labelRepository.close();
    await cleanup();
    await admin.end();
  });

  it("atomically adds stable opaque placeholders and exactly replays without adjacent writes", async () => {
    const command = reconcileCommand("add-three", 1, 3);
    const first = await repository.reconcilePhysicalRoomUnits(command);
    expect(first).toMatchObject({
      ok: true,
      response: {
        outcome: "reconciled",
        previousActiveUnitCount: 0,
        capacity: { activeUnitCount: 3, roomUnitsRevision: 2 },
        retiredUnitIds: [],
      },
    });
    if (!first.ok) throw new Error("Expected physical units to be added");
    expect(first.response.addedUnits).toHaveLength(3);
    expect(new Set(first.response.addedUnits.map(({ roomUnitId }) => roomUnitId)).size).toBe(3);
    for (const unit of first.response.addedUnits) {
      expect(unit).toMatchObject({
        lifecycle: "active",
        operationalLabel: null,
        operationalLabelStatus: "unverified",
      });
    }

    await expect(repository.reconcilePhysicalRoomUnits(command)).resolves.toEqual(first);
    await expect(
      repository.reconcilePhysicalRoomUnits({
        ...command,
        targetActiveUnitCount: 4,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });

    const state = await admin.query<{
      activeCount: number;
      roomFactsRevision: number;
      roomUnitsRevision: number;
      nullLabelCount: number;
      unverifiedCount: number;
    }>(
      `SELECT
         count(room.id) FILTER (WHERE room.status <> 'retired')::integer AS "activeCount",
         room_type.room_facts_revision::integer AS "roomFactsRevision",
         room_type.room_units_revision::integer AS "roomUnitsRevision",
         count(room.id) FILTER (WHERE room.room_number IS NULL)::integer AS "nullLabelCount",
         count(room.id) FILTER (WHERE room.operational_label_status = 'unverified')::integer
           AS "unverifiedCount"
       FROM pms.room_types room_type
       LEFT JOIN pms.rooms room ON room.room_type_id = room_type.id
       WHERE room_type.id = $1::uuid
       GROUP BY room_type.id`,
      [roomTypeId],
    );
    expect(state.rows[0]).toEqual({
      activeCount: 3,
      roomFactsRevision: 1,
      roomUnitsRevision: 2,
      nullLabelCount: 3,
      unverifiedCount: 3,
    });
    await expect(durableSideEffectCounts()).resolves.toEqual({
      audits: 1,
      idempotencyKeys: 1,
      domainEvents: 0,
      outboxEvents: 0,
    });
  });

  it("verifies one real label, exactly replays, and maps a case-insensitive duplicate", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(reconcileCommand("label-seed", 1, 2));
    if (!added.ok) throw new Error("Expected physical units to be added");
    const [firstUnit, secondUnit] = added.response.addedUnits;
    const command = labelCommand("first-label", firstUnit!.roomUnitId, 2, "QA-101");
    const first = await labelRepository.setPhysicalRoomOperationalLabel(command);
    expect(first).toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        roomUnitId: firstUnit!.roomUnitId,
        roomUnitsRevision: 3,
        operationalLabel: "QA-101",
        operationalLabelStatus: "verified",
      },
    });
    await expect(labelRepository.setPhysicalRoomOperationalLabel(command)).resolves.toEqual(first);
    await expect(
      labelRepository.setPhysicalRoomOperationalLabel(
        labelCommand("duplicate-label", secondUnit!.roomUnitId, 3, "qa-101"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "operational_label_conflict" } });

    const units = await admin.query<{
      roomUnitId: string;
      label: string | null;
      labelStatus: string;
    }>(
      `SELECT id::text AS "roomUnitId", room_number AS label,
              operational_label_status AS "labelStatus"
       FROM pms.rooms WHERE room_type_id = $1::uuid ORDER BY id`,
      [roomTypeId],
    );
    expect(units.rows).toEqual([
      { roomUnitId: firstUnit!.roomUnitId, label: "QA-101", labelStatus: "verified" },
      { roomUnitId: secondUnit!.roomUnitId, label: null, labelStatus: "unverified" },
    ]);
    await expect(roomTypeRevisions()).resolves.toEqual({ facts: 1, units: 3 });
    const durable = await admin.query<{ audits: number; keys: number }>(
      `SELECT
         (SELECT count(*)::integer FROM platform.product_audit_events
          WHERE property_id = $1::uuid
            AND action = 'physical_room_unit.operational_label.set') AS audits,
         (SELECT count(*)::integer FROM platform.idempotency_keys
          WHERE property_id = $1::uuid
            AND operation = 'pms.physical_room_unit.operational_label.set') AS keys`,
      [propertyId],
    );
    expect(durable.rows[0]).toEqual({ audits: 2, keys: 2 });
  });

  it("replays a legacy exact-label conflict without drifting the room revision", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(
      reconcileCommand("legacy-seed", 1, 2),
    );
    if (!added.ok) throw new Error("Expected physical units to be added");
    const [firstUnit, secondUnit] = added.response.addedUnits;
    await admin.query("UPDATE pms.rooms SET room_number = 'GENERATED-102' WHERE id = $1::uuid", [
      secondUnit!.roomUnitId,
    ]);
    const command = labelCommand("legacy-conflict", firstUnit!.roomUnitId, 2, "GENERATED-102");
    const conflict = { ok: false, error: { code: "operational_label_conflict" } } as const;
    await expect(labelRepository.setPhysicalRoomOperationalLabel(command)).resolves.toEqual(
      conflict,
    );
    await expect(labelRepository.setPhysicalRoomOperationalLabel(command)).resolves.toEqual(
      conflict,
    );
    await expect(roomTypeRevisions()).resolves.toEqual({ facts: 1, units: 2 });

    const units = await admin.query<{ label: string | null; labelStatus: string }>(
      `SELECT room_number AS label, operational_label_status AS "labelStatus"
       FROM pms.rooms WHERE room_type_id = $1::uuid ORDER BY id`,
      [roomTypeId],
    );
    expect(units.rows).toEqual([
      { label: null, labelStatus: "unverified" },
      { label: "GENERATED-102", labelStatus: "unverified" },
    ]);
  });

  it("counts every non-retired unit and reports verified, blocked, and non-available blockers", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(reconcileCommand("protected", 1, 3));
    if (!added.ok) throw new Error("Expected physical units to be added");
    const [verifiedId, maintenanceId, blockedId] = added.response.addedUnits.map(
      ({ roomUnitId }) => roomUnitId,
    );
    await admin.query(
      `UPDATE pms.rooms
       SET room_number = '101', operational_label_status = 'verified',
           room_metadata = room_metadata - 'setupGenerated'
       WHERE id = $1::uuid`,
      [verifiedId],
    );
    await admin.query("UPDATE pms.rooms SET status = 'maintenance' WHERE id = $1::uuid", [
      maintenanceId,
    ]);
    await admin.query(
      `INSERT INTO pms.room_blocks (
         property_id, room_type_id, room_id, starts_on, ends_on, reason, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, DATE '2026-08-03', DATE '2026-08-04',
                 'Operational protection', 'active')`,
      [propertyId, roomTypeId, blockedId],
    );

    await expect(
      repository.reconcilePhysicalRoomUnits(reconcileCommand("blocked-decrease", 2, 1)),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 2,
        currentActiveUnitCount: 3,
        targetActiveUnitCount: 1,
        safelyRemovableUnitCount: 0,
        blockers: [
          { code: "verified_operational_label", affectedCount: 1 },
          { code: "room_block", affectedCount: 1 },
          { code: "operational_status", affectedCount: 1 },
        ],
      },
    });

    await expect(activeUnitCount()).resolves.toBe(3);
    await expect(roomTypeRevisions()).resolves.toEqual({ facts: 1, units: 2 });
  });

  it("retires an unused verified room generated by canonical setup", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(
      reconcileCommand("generated-decrease-seed", 1, 3),
    );
    if (!added.ok) throw new Error("Expected physical units to be added");
    let revision = added.response.capacity.roomUnitsRevision;
    for (const [index, unit] of added.response.addedUnits.entries()) {
      const labeled = await labelRepository.setPhysicalRoomOperationalLabel(
        labelCommand(`generated-label-${index}`, unit.roomUnitId, revision, `Suite ${index + 1}`),
      );
      if (!labeled.ok) throw new Error("Expected generated label to be verified");
      revision = labeled.response.roomUnitsRevision;
    }

    await expect(
      repository.reconcilePhysicalRoomUnits(reconcileCommand("generated-decrease", revision, 2)),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        previousActiveUnitCount: 3,
        capacity: { activeUnitCount: 2, roomUnitsRevision: revision + 1 },
        retiredUnitIds: [expect.any(String)],
      },
    });
  });

  it("serializes concurrent expected revisions so exactly one target wins", async () => {
    const [first, second] = await Promise.all([
      repository.reconcilePhysicalRoomUnits(reconcileCommand("concurrent-two", 1, 2)),
      repository.reconcilePhysicalRoomUnits(reconcileCommand("concurrent-three", 1, 3)),
    ]);

    const results = [first, second];
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      { ok: false, error: { code: "room_units_revision_conflict", currentRevision: 2 } },
    ]);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok) throw new Error("Expected one reconcile winner");
    await expect(activeUnitCount()).resolves.toBe(winner.response.capacity.activeUnitCount);
    await expect(roomTypeRevisions()).resolves.toEqual({ facts: 1, units: 2 });
  });

  it("returns one exact durable result to concurrent callers sharing an idempotency key", async () => {
    const command = reconcileCommand("concurrent-replay", 1, 2);
    const [first, second] = await Promise.all([
      repository.reconcilePhysicalRoomUnits(command),
      repository.reconcilePhysicalRoomUnits(command),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      response: { capacity: { activeUnitCount: 2, roomUnitsRevision: 2 } },
    });
    await expect(durableSideEffectCounts()).resolves.toEqual({
      audits: 1,
      idempotencyKeys: 1,
      domainEvents: 0,
      outboxEvents: 0,
    });
  });

  it("canonicalizes advisory-lock UUIDs before serializing a mutation scope", async () => {
    const lowerPropertyId = "a1070000-0000-4000-8000-00000000000a";
    const lowerRoomTypeId = "b1070000-0000-4000-8000-00000000000b";
    const first = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    const second = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await Promise.all([first.connect(), second.connect()]);
    try {
      const [firstProcessId, secondProcessId] = await Promise.all([
        backendProcessId(first),
        backendProcessId(second),
      ]);
      await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
      await lockPmsPhysicalRoomUnitMutationScope(first, lowerPropertyId, lowerRoomTypeId);
      const pending = lockPmsPhysicalRoomUnitMutationScope(
        second,
        lowerPropertyId.toUpperCase(),
        lowerRoomTypeId.toUpperCase(),
      );
      void pending.catch(() => {});
      await waitForLockWaiter({
        blockedProcessId: secondProcessId,
        blockingProcessId: firstProcessId,
      });
      await first.query("COMMIT");
      await pending;
      await second.query("COMMIT");
    } catch (error) {
      await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      throw error;
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("observes an assignment that wins the room-row lock race and preserves its stable unit", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(reconcileCommand("race-seed", 1, 2));
    if (!added.ok) throw new Error("Expected physical units to be added");
    const protectedRoomId = added.response.addedUnits[0]!.roomUnitId;
    await admin.query(
      `INSERT INTO booking.guest_bookings (
         id, property_id, public_reference, lifecycle_status, check_in, check_out,
         currency, total_amount, balance_amount
       ) VALUES (
         $1::uuid, $2::uuid, 'VAY1070-RACE', 'confirmed', DATE '2026-08-03',
         DATE '2026-08-04', 'EUR', 0, 0
       )`,
      [guestBookingId, propertyId],
    );

    const assignmentWriter = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await assignmentWriter.connect();
    const assignmentWriterProcessId = await backendProcessId(assignmentWriter);
    try {
      await assignmentWriter.query("BEGIN");
      await lockPmsPhysicalRoomUnitMutationScope(assignmentWriter, propertyId, roomTypeId);
      await assignmentWriter.query("SELECT id FROM pms.rooms WHERE id = $1::uuid FOR UPDATE", [
        protectedRoomId,
      ]);
      await assignmentWriter.query(
        `INSERT INTO pms.operational_booking_assignments (
           id, property_id, guest_booking_id, room_type_id, room_id, position,
           assignment_status, assigned_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 'assigned', now())`,
        [assignmentId, propertyId, guestBookingId, roomTypeId, protectedRoomId],
      );

      const pending = repository.reconcilePhysicalRoomUnits(
        reconcileCommand("assignment-race", 2, 1),
      );
      void pending.catch(() => {});
      await waitForLockWaiter({ blockingProcessId: assignmentWriterProcessId });
      await assignmentWriter.query("COMMIT");

      await expect(pending).resolves.toMatchObject({
        ok: true,
        response: { capacity: { activeUnitCount: 1, roomUnitsRevision: 3 } },
      });
    } catch (error) {
      await assignmentWriter.query("ROLLBACK");
      throw error;
    } finally {
      await assignmentWriter.end();
    }

    await expect(
      admin.query<{ status: string }>("SELECT status FROM pms.rooms WHERE id = $1::uuid", [
        protectedRoomId,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "available" }] });
    await expect(
      admin.query<{ roomId: string }>(
        `SELECT room_id::text AS "roomId"
         FROM pms.operational_booking_assignments WHERE id = $1::uuid`,
        [assignmentId],
      ),
    ).resolves.toMatchObject({ rows: [{ roomId: protectedRoomId }] });
  });

  it("makes a reference writer that loses reconciliation recheck the retired unit", async () => {
    const added = await repository.reconcilePhysicalRoomUnits(
      reconcileCommand("reverse-race-seed", 1, 2),
    );
    if (!added.ok) throw new Error("Expected physical units to be added");
    const retirementCandidate = await admin.query<{ roomUnitId: string }>(
      `SELECT id::text AS "roomUnitId"
       FROM pms.rooms
       WHERE id = ANY($1::uuid[])
       ORDER BY sort_order DESC, id DESC
       LIMIT 1`,
      [added.response.addedUnits.map(({ roomUnitId }) => roomUnitId)],
    );
    const retirementCandidateId = retirementCandidate.rows[0]?.roomUnitId;
    if (!retirementCandidateId) throw new Error("Expected a retirement candidate");
    await expect(
      admin.query("SELECT id FROM pms.rooms WHERE id = $1::uuid AND status <> 'retired'", [
        retirementCandidateId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });

    let releaseReconcile!: () => void;
    const reconcileMayContinue = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    let advisoryAcquired!: () => void;
    const reconcileHasAdvisory = new Promise<void>((resolve) => {
      advisoryAcquired = resolve;
    });
    const backingPool = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
    const gatedPool: PmsPhysicalRoomUnitReconcilePool = {
      async connect() {
        const client = await backingPool.connect();
        const wrapped: PmsPhysicalRoomUnitReconcileClient = {
          async query<T extends QueryResultRow = QueryResultRow>(
            text: string,
            values: readonly unknown[] = [],
          ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
            const result = await client.query<T>(text, [...values]);
            if (text.includes("'pms.physical-room-unit:'")) {
              advisoryAcquired();
              await reconcileMayContinue;
            }
            return { rows: result.rows, rowCount: result.rowCount };
          },
          release() {
            client.release();
          },
        };
        return wrapped;
      },
      async end() {
        await backingPool.end();
      },
    };
    const gatedRepository = createPgPmsPhysicalRoomUnitReconcileRepository({
      pool: gatedPool,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });
    const referenceWriter = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await referenceWriter.connect();
    const referenceWriterProcessId = await backendProcessId(referenceWriter);
    try {
      const pendingReconcile = gatedRepository.reconcilePhysicalRoomUnits(
        reconcileCommand("reconcile-wins-race", 2, 1),
      );
      void pendingReconcile.catch(() => {});
      await reconcileHasAdvisory;

      await referenceWriter.query("BEGIN");
      const pendingReferenceLock = lockPmsPhysicalRoomUnitMutationScope(
        referenceWriter,
        propertyId,
        roomTypeId,
      );
      void pendingReferenceLock.catch(() => {});
      await waitForLockWaiter({ blockedProcessId: referenceWriterProcessId });
      releaseReconcile();

      await expect(pendingReconcile).resolves.toMatchObject({
        ok: true,
        response: { capacity: { activeUnitCount: 1, roomUnitsRevision: 3 } },
      });
      await pendingReferenceLock;
      const eligibility = await referenceWriter.query(
        `SELECT id
         FROM pms.rooms
         WHERE property_id = $1::uuid
           AND room_type_id = $2::uuid
           AND id = $3::uuid
           AND status <> 'retired'
         FOR SHARE`,
        [propertyId, roomTypeId, retirementCandidateId],
      );
      if ((eligibility.rowCount ?? 0) > 0) {
        await referenceWriter.query(
          `INSERT INTO pms.room_blocks (
             property_id, room_type_id, room_id, starts_on, ends_on, reason, status
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, DATE '2026-08-03', DATE '2026-08-04',
             'Concurrent housekeeping protection', 'active'
           )`,
          [propertyId, roomTypeId, retirementCandidateId],
        );
      }
      expect(eligibility.rowCount).toBe(0);
      await referenceWriter.query("COMMIT");
    } catch (error) {
      releaseReconcile();
      await referenceWriter.query("ROLLBACK");
      throw error;
    } finally {
      await referenceWriter.end();
      await backingPool.end();
    }

    await expect(
      admin.query<{ status: string }>("SELECT status FROM pms.rooms WHERE id = $1::uuid", [
        retirementCandidateId,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "retired" }] });
    await expect(
      admin.query("SELECT id FROM pms.room_blocks WHERE room_id = $1::uuid", [
        retirementCandidateId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("observes a concurrent entitlement revocation before mutating capacity", async () => {
    const revoker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await revoker.connect();
    const revokerProcessId = await backendProcessId(revoker);
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        `UPDATE identity.product_entitlements
         SET status = 'suspended'
         WHERE organization_id = $1::uuid
           AND product = 'pms'
           AND entitlement_key = 'property-management'`,
        [organizationId],
      );

      const pending = repository.reconcilePhysicalRoomUnits(
        reconcileCommand("revocation-wins", 1, 2),
      );
      void pending.catch(() => {});
      await waitForLockWaiter({ blockingProcessId: revokerProcessId });
      await revoker.query("COMMIT");

      await expect(pending).resolves.toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
    } catch (error) {
      await revoker.query("ROLLBACK");
      throw error;
    } finally {
      await revoker.end();
    }

    await expect(activeUnitCount()).resolves.toBe(0);
    await expect(roomTypeRevisions()).resolves.toEqual({ facts: 1, units: 1 });
    await expect(durableSideEffectCounts()).resolves.toEqual({
      audits: 0,
      idempotencyKeys: 0,
      domainEvents: 0,
      outboxEvents: 0,
    });
  });

  async function waitForLockWaiter(options: {
    blockedProcessId?: number;
    blockingProcessId?: number;
  }): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(DISTINCT waiting.pid)::text AS count
         FROM pg_locks AS waiting
         JOIN pg_stat_activity AS activity ON activity.pid = waiting.pid
         WHERE waiting.granted = FALSE
           AND activity.datid = (
             SELECT oid FROM pg_database WHERE datname = current_database()
           )
           AND ($1::integer IS NULL OR waiting.pid = $1::integer)
           AND (
             $2::integer IS NULL
             OR $2::integer = ANY(pg_blocking_pids(waiting.pid))
           )`,
        [options.blockedProcessId ?? null, options.blockingProcessId ?? null],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No expected physical-unit lock waiter appeared within the timeout");
  }

  async function backendProcessId(client: pg.Client): Promise<number> {
    const result = await client.query<{ pid: number }>("SELECT pg_backend_pid()::integer AS pid");
    const processId = result.rows[0]?.pid;
    if (processId === undefined || !Number.isInteger(processId)) {
      throw new Error("PostgreSQL test client did not expose a backend process id");
    }
    return processId;
  }

  async function activeUnitCount(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM pms.rooms
       WHERE room_type_id = $1::uuid AND status <> 'retired'`,
      [roomTypeId],
    );
    return result.rows[0]?.count ?? -1;
  }

  async function roomTypeRevisions(): Promise<{ facts: number; units: number }> {
    const result = await admin.query<{ facts: number; units: number }>(
      `SELECT room_facts_revision::integer AS facts, room_units_revision::integer AS units
       FROM pms.room_types WHERE id = $1::uuid`,
      [roomTypeId],
    );
    return result.rows[0] ?? { facts: -1, units: -1 };
  }

  async function durableSideEffectCounts(): Promise<{
    audits: number;
    idempotencyKeys: number;
    domainEvents: number;
    outboxEvents: number;
  }> {
    const result = await admin.query<{
      audits: number;
      idempotencyKeys: number;
      domainEvents: number;
      outboxEvents: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND action = 'physical_room_units.reconcile') AS audits,
         (SELECT count(*)::integer FROM platform.idempotency_keys
          WHERE property_id = $1::uuid AND operation = 'pms.physical_room_units.reconcile')
           AS "idempotencyKeys",
         (SELECT count(*)::integer FROM platform.domain_events WHERE property_id = $1::uuid)
           AS "domainEvents",
         (SELECT count(*)::integer FROM platform.outbox_events WHERE property_id = $1::uuid)
           AS "outboxEvents"`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function seedAuthorizedRoomType(): Promise<void> {
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, 'vay1070@example.test', 'VAY-1070', 'active')",
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1070', 'vay-1070', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay-1070-property', 'VAY-1070 Property')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES ($1::uuid, 'pms', 'pms_property', $2, 'front_desk', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id
       ) VALUES (
         $1::uuid, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2
       )`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, active, room_facts_revision, room_units_revision
       ) VALUES ($1::uuid, $2::uuid, 'VAY-1070 Room Type', '', TRUE, 1, 1)`,
      [roomTypeId, propertyId],
    );
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM pms.operational_booking_assignments WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM pms.room_blocks WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query(
        `DELETE FROM identity.organization_resource_links
         WHERE organization_id = $1::uuid OR resource_id = $2`,
        [organizationId, propertyId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function reconcileCommand(
  suffix: string,
  expectedRevision: number,
  targetActiveUnitCount: number,
): ReconcilePhysicalRoomUnitsCommand {
  const parsed = parseReconcilePhysicalRoomUnitsCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRevision,
    targetActiveUnitCount,
    idempotencyKey: `vay1070-${suffix}`,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `req-${suffix}`,
      correlationId: `corr-${suffix}`,
      requestedAt: "2026-08-03T12:00:00.000Z",
    },
  });
  if (!parsed) throw new Error("Invalid integration-test reconcile command");
  return parsed;
}

function labelCommand(
  suffix: string,
  targetRoomUnitId: string,
  expectedRevision: number,
  operationalLabel: string,
): SetPhysicalRoomOperationalLabelCommand {
  const parsed = parseSetPhysicalRoomOperationalLabelCommand({
    organizationId,
    propertyId,
    roomTypeId,
    roomUnitId: targetRoomUnitId,
    expectedRevision,
    operationalLabel,
    idempotencyKey: `vay1277-${suffix}`,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `req-${suffix}`,
      correlationId: `corr-${suffix}`,
      requestedAt: "2026-08-03T12:00:00.000Z",
    },
  });
  if (!parsed) throw new Error("Invalid integration-test room-label command");
  return parsed;
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
