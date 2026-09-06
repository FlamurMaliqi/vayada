import { createHash, randomUUID } from "node:crypto";

import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  type PmsInventoryMaterializationCommand,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarReadPort,
  type RoomCapacityReadPort,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPgPmsInventoryMaterializationRepository,
  type PmsInventoryMaterializationAuthorizationPort,
  type PmsInventoryMaterializationRepository,
} from "./pmsInventoryMaterializationRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ACCEPTED_AT = new Date("2026-08-04T09:00:00.000Z");

type Fixture = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  actorUserId: string;
  configurations: ReadonlyMap<number, PmsOperatingCalendarConfigurationSnapshot>;
  calendarState: {
    currentRevision: number;
    stale: boolean;
    readCount: number;
    staleOnRead: number | null;
  };
  capacityState: { revision: number; count: number };
  profileState: { available: boolean; revision: number };
  authorizationState: { allowed: boolean };
  authorize: ReturnType<typeof vi.fn>;
  repository: PmsInventoryMaterializationRepository;
}>;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS inventory materialization repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repositories: PmsInventoryMaterializationRepository[] = [];

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  afterAll(async () => {
    await Promise.all(repositories.map((repository) => repository.close()));
    await admin.end();
  });

  it("applies, replays, extends, and rematerializes without erasing retained owners", async () => {
    const fixture = await createFixture(admin, repositories, [2, 1]);
    const first = materializationCommand(fixture, "first", 1, "2026-08-04", "2026-08-06");

    const applied = await fixture.repository.materializeInventory(first);
    expect(applied).toMatchObject({
      ok: true,
      outcome: "applied",
      changedDayCount: 3,
      projectionRefreshIntent: {
        eventType: "pms.inventory.projection_refresh_requested",
        reason: "full_horizon_apply",
        roomTypeIds: [fixture.roomTypeId],
      },
    });
    await expect(fixture.repository.materializeInventory(first)).resolves.toEqual(applied);
    await expect(
      fixture.repository.materializeInventory({
        ...first,
        horizon: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });

    const unchanged = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "unchanged", 1, "2026-08-04", "2026-08-06"),
    );
    expect(unchanged).toMatchObject({
      ok: true,
      outcome: "unchanged",
      changedDayCount: 0,
      projectionRefreshIntent: null,
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 2,
      idempotency: 2,
      events: 1,
      outbox: 1,
    });

    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-06" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });

    await consumeAndOverrideFirstDay(admin, fixture);
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-06" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });

    const extended = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "extend", 1, "2026-08-04", "2026-08-07"),
    );
    expect(extended).toMatchObject({
      ok: true,
      outcome: "extended",
      changedDayCount: 1,
      projectionRefreshIntent: { reason: "horizon_extension" },
    });
    await expect(readFirstDay(admin, fixture)).resolves.toMatchObject({
      assignedCount: 2,
      bookingRevision: 1,
      manualLimit: 1,
      manualRevision: 1,
      inventoryRevision: 3,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: 0,
    });

    await activateCalendarRevision(admin, fixture, 2);
    const rematerialized = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "revision-two", 2, "2026-08-04", "2026-08-07"),
    );
    expect(rematerialized).toMatchObject({
      ok: true,
      outcome: "rematerialized",
      changedDayCount: 4,
      projectionRefreshIntent: { reason: "rematerialization", materializedRevision: 2 },
    });
    await expect(readFirstDay(admin, fixture)).resolves.toEqual({
      calendarRevision: 2,
      inventoryRevision: 4,
      generatedLimit: 1,
      generatedRevision: 2,
      assignedCount: 2,
      bookingRevision: 1,
      manualLimit: 1,
      manualRevision: 1,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: 0,
    });
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });
    fixture.calendarState.readCount = 0;
    fixture.calendarState.staleOnRead = 2;
    await expect(
      fixture.repository.getInventoryLaunchReadiness({
        propertyId: fixture.propertyId,
        requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
      }),
    ).resolves.toBeNull();
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 4,
      idempotency: 4,
      events: 3,
      outbox: 3,
    });
  });

  it("finishes an earlier partial rematerialization at the current calendar revision", async () => {
    const fixture = await createFixture(admin, repositories, [2, 1]);
    await fixture.repository.materializeInventory(
      materializationCommand(fixture, "initial-full", 1, "2026-08-04", "2026-08-07"),
    );
    await activateCalendarRevision(admin, fixture, 2);
    await expect(fixture.repository.materializeInventory(
      materializationCommand(fixture, "partial-new", 2, "2026-08-04", "2026-08-05"),
    )).resolves.toMatchObject({ ok: true, outcome: "rematerialized" });
    const retained = await readFirstDay(admin, fixture);
    const command = materializationCommand(fixture, "finish-new", 2, "2026-08-04", "2026-08-07");
    const completed = await fixture.repository.materializeInventory(command);
    expect(completed).toMatchObject({ ok: true, outcome: "rematerialized", changedDayCount: 2 });
    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual(completed);
    await expect(readFirstDay(admin, fixture)).resolves.toEqual(retained);
    await expect(fixture.repository.getInventoryLaunchReadiness({
      propertyId: fixture.propertyId,
      requiredCoverage: { from: "2026-08-04", through: "2026-08-07" },
    })).resolves.toMatchObject({ ready: true, blockers: [] });
  });

  it("stop-sells newly extended dates for an existing linked cause", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const groupId = randomUUID();
    const sourceRoomTypeId = randomUUID();
    await admin.query(
      `INSERT INTO pms.linked_inventory_groups (id, property_id, name)
       VALUES ($1::uuid, $2::uuid, 'Convertible rooms')`,
      [groupId, fixture.propertyId],
    );
    await admin.query(
      "UPDATE pms.room_types SET linked_inventory_group_id=$1::uuid WHERE id=$2::uuid",
      [groupId, fixture.roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (id, property_id, name, active, linked_inventory_group_id)
       VALUES ($1::uuid, $2::uuid, 'Linked source', false, $3::uuid)`,
      [sourceRoomTypeId, fixture.propertyId, groupId],
    );
    await admin.query(
      `INSERT INTO pms.room_blocks
         (property_id, room_type_id, starts_on, ends_on, reason)
       VALUES ($1::uuid, $2::uuid, DATE '2026-08-04', DATE '2026-08-07', 'Maintenance')`,
      [fixture.propertyId, sourceRoomTypeId],
    );

    const initial = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "linked-initial", 1, "2026-08-04", "2026-08-05"),
    );
    if (!initial.ok) throw new Error(initial.error.code);
    expect(initial).toMatchObject({ ok: true, outcome: "applied", changedDayCount: 2 });
    const extension = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "linked-extend", 1, "2026-08-04", "2026-08-07"),
    );
    if (!extension.ok) throw new Error(extension.error.code);
    expect(extension).toMatchObject({ ok: true, outcome: "extended", changedDayCount: 2 });

    await expect(
      admin.query(
        `SELECT linked_stop_sell AS stopped, linked_source_revision AS revision,
                available_count AS available
         FROM pms.inventory_days
         WHERE property_id=$1::uuid AND room_type_id=$2::uuid
         ORDER BY stay_date`,
        [fixture.propertyId, fixture.roomTypeId],
      ),
    ).resolves.toMatchObject({
      rows: Array.from({ length: 4 }, () => ({ stopped: true, revision: 1, available: 0 })),
    });
    await expect(
      admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM platform.outbox_events
         WHERE property_id=$1::uuid AND resource_type='linked_inventory'`,
        [fixture.propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 6 }] });
  });

  it("persists the complete 366-day launch horizon", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const result = await fixture.repository.materializeInventory(
      materializationCommand(fixture, "full-horizon", 1, "2026-08-04", "2027-08-04"),
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: "applied",
      changedDayCount: 366,
      coverage: { expectedDayCount: 366, materializedDayCount: 366, gaps: [] },
    });
    expect(fixture.calendarState.readCount).toBe(0);
    const count = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pms.inventory_days
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    expect(count.rows[0]?.count).toBe("366");
  });

  it("serializes concurrent exact commands to one durable mutation and one receipt-free replay", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "concurrent", 1, "2026-08-04", "2026-08-06");

    const [left, right] = await Promise.all([
      fixture.repository.materializeInventory(command),
      fixture.repository.materializeInventory(command),
    ]);

    expect(left).toEqual(right);
    expect(left).toMatchObject({ ok: true, outcome: "applied", changedDayCount: 3 });
    expect(fixture.authorize).toHaveBeenCalledTimes(2);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("shares the established property inventory lock identity with legacy inventory writers", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await blocker.connect();
    try {
      const blockerProcessId = await backendProcessId(blocker);
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(concat('pms-inventory:', $1::text), 0)
         )`,
        [fixture.propertyId],
      );
      const pending = fixture.repository.materializeInventory(
        materializationCommand(fixture, "legacy-lock", 1, "2026-08-04", "2026-08-04"),
      );
      void pending.catch(() => {});
      await waitForLockWaiter(admin, blockerProcessId);
      await blocker.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ ok: true, outcome: "applied" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });

  it("reauthorizes before replay and fails closed without exposing the stored result", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "reauthorize", 1, "2026-08-04", "2026-08-04");
    await expect(fixture.repository.materializeInventory(command)).resolves.toMatchObject({
      ok: true,
    });

    fixture.authorizationState.allowed = false;
    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual({
      ok: false,
      error: { code: "configuration_not_found" },
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("rejects a self-consistent stored replay that escapes the authorized organization", async () => {
    const fixture = await createFixture(admin, repositories, [2]);
    const command = materializationCommand(fixture, "bound-replay", 1, "2026-08-04", "2026-08-04");
    const applied = await fixture.repository.materializeInventory(command);
    if (!applied.ok || !applied.projectionRefreshIntent) {
      throw new Error("Expected changed materialization result");
    }
    const stored = JSON.parse(JSON.stringify(applied)) as Record<string, unknown>;
    const intent = stored["projectionRefreshIntent"] as Record<string, unknown>;
    intent["organizationId"] = randomUUID();
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $2::jsonb),
           response_body_hash = $3
       WHERE property_id = $1::uuid AND operation = 'pms.inventory.materialize'`,
      [fixture.propertyId, JSON.stringify(stored), sha256(stableJson(stored))],
    );

    await expect(fixture.repository.materializeInventory(command)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });
  });

  it("rejects stale evidence and adopts only pristine onboarding inventory", async () => {
    const newerCalendar = await createFixture(admin, repositories, [2, 1]);
    await activateCalendarRevision(admin, newerCalendar, 2);
    await expect(
      newerCalendar.repository.materializeInventory(
        materializationCommand(newerCalendar, "newer-calendar", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, newerCalendar.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, newerCalendar.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const staleProfile = await createFixture(admin, repositories, [2]);
    staleProfile.profileState.revision = 2;
    await expect(
      staleProfile.repository.materializeInventory(
        materializationCommand(staleProfile, "stale-profile", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, staleProfile.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, staleProfile.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const staleCapacity = await createFixture(admin, repositories, [2]);
    staleCapacity.capacityState.count = 3;
    await expect(
      staleCapacity.repository.materializeInventory(
        materializationCommand(staleCapacity, "stale-capacity", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });
    await expect(inventoryDayCount(admin, staleCapacity.propertyId)).resolves.toBe(0);
    await expect(sideEffectCounts(admin, staleCapacity.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    const legacy = await createFixture(admin, repositories, [2]);
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-08-04', 2, 0, 0, 2, 'open',
         jsonb_build_object('pms', jsonb_build_object(
           'status', 'fresh', 'generatedAt', $3::timestamptz, 'horizonDays', 366
         ))
       )`,
      [legacy.propertyId, legacy.roomTypeId, ACCEPTED_AT.toISOString()],
    );
    await expect(
      legacy.repository.materializeInventory(
        materializationCommand(legacy, "legacy", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "applied", changedDayCount: 1 });
    const stored = await admin.query<{ calendarRevision: number | null; sourceFreshness: unknown }>(
      `SELECT calendar_revision AS "calendarRevision", source_freshness AS "sourceFreshness"
       FROM pms.inventory_days WHERE property_id = $1::uuid`,
      [legacy.propertyId],
    );
    expect(stored.rows).toEqual([
      {
        calendarRevision: 1,
        sourceFreshness: {
          pms: { status: "fresh", generatedAt: expect.any(String), horizonDays: 366 },
        },
      },
    ]);
    await expect(sideEffectCounts(admin, legacy.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
    });

    const occupiedLegacy = await createFixture(admin, repositories, [2]);
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-08-04', 2, 1, 0, 1, 'open',
         jsonb_build_object('pms', jsonb_build_object(
           'status', 'fresh', 'generatedAt', $3::timestamptz, 'horizonDays', 366
         ))
       )`,
      [occupiedLegacy.propertyId, occupiedLegacy.roomTypeId, ACCEPTED_AT.toISOString()],
    );
    await expect(
      occupiedLegacy.repository.materializeInventory(
        materializationCommand(occupiedLegacy, "occupied-legacy", 1, "2026-08-04", "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "inventory_invariant_violation" } });
    await expect(sideEffectCounts(admin, occupiedLegacy.propertyId)).resolves.toEqual({
      audits: 1,
      idempotency: 1,
      events: 0,
      outbox: 0,
    });

    for (const [suffix, freshness] of [
      [
        "extra-source-key",
        {
          pms: { status: "fresh", generatedAt: ACCEPTED_AT.toISOString(), horizonDays: 366 },
          other: {},
        },
      ],
      [
        "extra-pms-key",
        {
          pms: {
            status: "fresh",
            generatedAt: ACCEPTED_AT.toISOString(),
            horizonDays: 366,
            other: true,
          },
        },
      ],
      [
        "noncanonical-timestamp",
        { pms: { status: "fresh", generatedAt: "Aug 4 2026 10:00 UTC", horizonDays: 366 } },
      ],
      [
        "overflow-timestamp",
        { pms: { status: "fresh", generatedAt: "2026-02-31T24:00:00Z", horizonDays: 366 } },
      ],
    ] as const) {
      const malformed = await createFixture(admin, repositories, [2]);
      await admin.query(
        `INSERT INTO pms.inventory_days (
           property_id, room_type_id, stay_date, total_count,
           assigned_count, blocked_count, available_count, status, source_freshness
         ) VALUES ($1::uuid, $2::uuid, DATE '2026-08-04', 2, 0, 0, 2, 'open', $3::jsonb)`,
        [malformed.propertyId, malformed.roomTypeId, JSON.stringify(freshness)],
      );
      await expect(
        malformed.repository.materializeInventory(
          materializationCommand(malformed, suffix, 1, "2026-08-04", "2026-08-04"),
        ),
      ).resolves.toEqual({ ok: false, error: { code: "inventory_invariant_violation" } });
    }
  });
});

async function createFixture(
  admin: pg.Client,
  repositories: PmsInventoryMaterializationRepository[],
  startingLimits: readonly number[],
): Promise<Fixture> {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const actorUserId = randomUUID();
  await admin.query(
    `INSERT INTO identity.organizations (id, kind, name, slug)
     VALUES ($1::uuid, 'hotel_group', 'VAY-1063 Test', $2)`,
    [organizationId, `vay-1063-${organizationId}`],
  );
  await admin.query(
    `INSERT INTO identity.users (id, email, name)
     VALUES ($1::uuid, $2, 'VAY-1063 Test')`,
    [actorUserId, `${actorUserId}@example.test`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-1063 Test')`,
    [propertyId, `vay-1063-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name)
     VALUES ($1::uuid, $2::uuid, 'Room')`,
    [roomTypeId, propertyId],
  );

  const configurations = new Map<number, PmsOperatingCalendarConfigurationSnapshot>();
  for (let index = 0; index < startingLimits.length; index += 1) {
    const revision = index + 1;
    const configuration = configurationSnapshot({
      propertyId,
      roomTypeId,
      revision,
      startingLimit: startingLimits[index]!,
    });
    configurations.set(revision, configuration);
    if (revision === 1) {
      await seedCalendarRevision(admin, {
        organizationId,
        propertyId,
        roomTypeId,
        actorUserId,
        revision,
        startingLimit: startingLimits[index]!,
      });
    }
  }

  const calendarState = {
    currentRevision: 1,
    stale: false,
    readCount: 0,
    staleOnRead: null as number | null,
  };
  const capacityState = { revision: 1, count: 2 };
  const profileState = { available: true, revision: 1 };
  const authorizationState = { allowed: true };
  const authorize = vi.fn(async () => authorizationState.allowed);
  const authorization: PmsInventoryMaterializationAuthorizationPort = {
    authorizeInventoryMaterialization: authorize,
  };
  const operatingCalendar: PmsOperatingCalendarReadPort = {
    async getCurrentOperatingCalendarConfiguration(requestedPropertyId) {
      if (requestedPropertyId !== propertyId) return null;
      calendarState.readCount += 1;
      if (calendarState.readCount === calendarState.staleOnRead) calendarState.stale = true;
      const configuration = configurations.get(calendarState.currentRevision);
      if (!configuration) return null;
      return calendarState.stale
        ? {
            configuration,
            sourceStatus: "stale",
            sourceConflicts: [
              { code: "room_units_revision_conflict", roomTypeId, currentRevision: 2 },
            ],
          }
        : { configuration, sourceStatus: "current", sourceConflicts: [] };
    },
    async getOperatingCalendarConfigurationBySource(source) {
      if (source.entityId !== propertyId) return null;
      const revision = Number(source.revision.slice("calendar:".length));
      return configurations.get(revision) ?? null;
    },
  };
  const roomCapacity: RoomCapacityReadPort = {
    async getRoomTypeCapacity(requestedPropertyId, requestedRoomTypeId) {
      return requestedPropertyId === propertyId && requestedRoomTypeId === roomTypeId
        ? {
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId,
            roomUnitsRevision: capacityState.revision,
            activeUnitCount: capacityState.count,
            capturedAt: ACCEPTED_AT.toISOString(),
          }
        : null;
    },
  };
  const propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort = {
    ownerDomain: "hotel_catalog",
    registryVersion: "test.v1",
    isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
    async runWithPropertyProfileEvidence(_input, guarded) {
      const configuration = configurations.get(calendarState.currentRevision);
      if (!configuration) throw new Error("Missing current test configuration");
      const source = {
        ownerDomain: "hotel_catalog" as const,
        entityType: "property_profile" as const,
        entityId: propertyId,
        revision: `profile:${profileState.revision}`,
      };
      return guarded(
        profileState.available
          ? {
              status: "available",
              evidence: {
                source,
                timeZone: configuration.sourceInputs.propertyTimeZone,
              },
            }
          : { status: "timezone_missing", source },
      );
    },
  };
  const repository = createPgPmsInventoryMaterializationRepository({
    connectionString: TEST_DATABASE_URL!,
    max: 4,
    now: () => ACCEPTED_AT,
    authorization,
    operatingCalendar,
    propertyProfileEvidence,
    roomCapacity,
  });
  repositories.push(repository);
  return {
    organizationId,
    propertyId,
    roomTypeId,
    actorUserId,
    configurations,
    calendarState,
    capacityState,
    profileState,
    authorizationState,
    authorize,
    repository,
  };
}

async function activateCalendarRevision(
  admin: pg.Client,
  fixture: Fixture,
  revision: number,
): Promise<void> {
  const configuration = fixture.configurations.get(revision);
  const binding = configuration?.sourceInputs.roomBindings[0];
  if (!configuration || !binding) throw new Error("Missing calendar revision fixture");
  await seedCalendarRevision(admin, {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    roomTypeId: fixture.roomTypeId,
    actorUserId: fixture.actorUserId,
    revision,
    startingLimit: binding.startingSellableLimitCount,
  });
  fixture.calendarState.currentRevision = revision;
}

function configurationSnapshot(input: {
  propertyId: string;
  roomTypeId: string;
  revision: number;
  startingLimit: number;
}): PmsOperatingCalendarConfigurationSnapshot {
  const parsed = parsePmsOperatingCalendarConfigurationSnapshot(
    {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      propertyId: input.propertyId,
      calendarRevision: input.revision,
      source: createPmsOperatingCalendarSourceRevision(input.propertyId, input.revision),
      sourceInputs: {
        propertyProfile: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: input.propertyId,
          revision: "profile:1",
        },
        propertyTimeZone: "Europe/Berlin",
        roomBindings: [
          {
            roomTypeId: input.roomTypeId,
            sourceRoomFactsRevision: 1,
            sourceRoomUnitsRevision: 1,
            physicalCapacityCount: 2,
            startingSellableLimitCount: input.startingLimit,
          },
        ],
      },
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
      createdAt: ACCEPTED_AT.toISOString(),
      updatedAt: ACCEPTED_AT.toISOString(),
    },
    {
      ownerDomain: "hotel_catalog",
      registryVersion: "test.v1",
      isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
    },
  );
  if (!parsed) throw new Error("Test operating calendar configuration is invalid");
  return parsed;
}

async function seedCalendarRevision(
  admin: pg.Client,
  input: {
    organizationId: string;
    propertyId: string;
    roomTypeId: string;
    actorUserId: string;
    revision: number;
    startingLimit: number;
  },
): Promise<void> {
  const idempotencyId = randomUUID();
  const eventId = randomUUID();
  const outboxId = randomUUID();
  await admin.query(
    `INSERT INTO platform.idempotency_keys (
       id, operation_scope, operation, key_hash, request_fingerprint_hash,
       status, tenant_scope, property_id, first_seen_at, last_seen_at, expires_at
     ) VALUES (
       $1::uuid, 'pms', 'pms.operating_calendar.upsert', $2, $3,
       'in_progress', 'property', $4::uuid, $5::timestamptz,
       $5::timestamptz, $5::timestamptz + interval '24 hours'
     )`,
    [
      idempotencyId,
      `calendar-seed-${randomUUID()}`,
      `fingerprint-${randomUUID()}`,
      input.propertyId,
      ACCEPTED_AT.toISOString(),
    ],
  );
  await admin.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, occurred_at, tenant_scope,
       property_id, resource_product, resource_type, resource_id
     ) VALUES (
       $1::uuid, 'pms', $2, 'pms.operating_calendar.changed', $3::timestamptz,
       'property', $4::uuid, 'pms', 'operating_calendar', $4::uuid::text
     )`,
    [eventId, `calendar-seed-${randomUUID()}`, ACCEPTED_AT.toISOString(), input.propertyId],
  );
  await admin.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type, tenant_scope,
       property_id, resource_product, resource_type, resource_id
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'pms.inventory-source',
       'pms.operating_calendar.changed', 'property', $4::uuid,
       'pms', 'operating_calendar', $4::uuid::text
     )`,
    [outboxId, eventId, `calendar-seed-${randomUUID()}`, input.propertyId],
  );
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO pms.operating_calendar_revisions (
         organization_id, property_id, calendar_revision, contract_version,
         property_profile_revision, property_time_zone, schedule_mode,
         recurring_period_count, room_binding_count, default_minimum_stay_nights,
         idempotency_key_id, domain_event_id, outbox_event_id,
         created_by_user_id, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'pms-operating-calendar.v1', 1,
         'Europe/Berlin', 'year_round', 0, 1, 1, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::timestamptz, $8::timestamptz
       )`,
      [
        input.organizationId,
        input.propertyId,
        input.revision,
        idempotencyId,
        eventId,
        outboxId,
        input.actorUserId,
        ACCEPTED_AT.toISOString(),
      ],
    );
    await admin.query(
      `INSERT INTO pms.operating_calendar_room_bindings (
         property_id, calendar_revision, room_type_id,
         source_room_facts_revision, source_room_units_revision,
         physical_capacity_count, starting_sellable_limit_count
       ) VALUES ($1::uuid, $2, $3::uuid, 1, 1, 2, $4)`,
      [input.propertyId, input.revision, input.roomTypeId, input.startingLimit],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function materializationCommand(
  fixture: Fixture,
  key: string,
  revision: number,
  from: string,
  through: string,
): PmsInventoryMaterializationCommand {
  const configuration = fixture.configurations.get(revision);
  if (!configuration) throw new Error("Missing test configuration");
  return {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    configurationSource: configuration.source,
    expectedMaterializedRevision: revision,
    horizon: { from, through },
    idempotencyKey: key,
    audit: {
      actor: { kind: "user", userId: fixture.actorUserId },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      requestedAt: ACCEPTED_AT.toISOString(),
    },
  };
}

async function consumeAndOverrideFirstDay(admin: pg.Client, fixture: Fixture): Promise<void> {
  await admin.query(
    `UPDATE pms.inventory_days
     SET assigned_count = 2, available_count = 0,
         booking_source_revision = 1, inventory_revision = 2
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
  await admin.query(
    `UPDATE pms.inventory_days
     SET manual_sellable_limit_count = 1, effective_sellable_limit_count = 1,
         available_count = 0, manual_source_revision = 1, inventory_revision = 3
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
}

async function readFirstDay(admin: pg.Client, fixture: Fixture) {
  const result = await admin.query<{
    calendarRevision: number;
    inventoryRevision: number;
    generatedLimit: number;
    generatedRevision: number;
    assignedCount: number;
    bookingRevision: number;
    manualLimit: number | null;
    manualRevision: number;
    linkedStopSell: boolean;
    linkedSourceRevision: number;
    availableCount: number;
  }>(
    `SELECT calendar_revision AS "calendarRevision",
            inventory_revision AS "inventoryRevision",
            generated_sellable_limit_count AS "generatedLimit",
            generated_source_revision AS "generatedRevision",
            assigned_count AS "assignedCount",
            booking_source_revision AS "bookingRevision",
            manual_sellable_limit_count AS "manualLimit",
            manual_source_revision AS "manualRevision",
            linked_stop_sell AS "linkedStopSell",
            linked_source_revision AS "linkedSourceRevision",
            available_count AS "availableCount"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date = DATE '2026-08-04'`,
    [fixture.propertyId, fixture.roomTypeId],
  );
  if (!result.rows[0]) throw new Error("Missing test inventory day");
  return result.rows[0];
}

async function sideEffectCounts(admin: pg.Client, propertyId: string) {
  const result = await admin.query<{
    audits: number;
    idempotency: number;
    events: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM platform.product_audit_events
        WHERE property_id = $1::uuid
          AND action = 'pms.inventory.materialize') AS audits,
       (SELECT count(*)::integer FROM platform.idempotency_keys
        WHERE property_id = $1::uuid
          AND operation = 'pms.inventory.materialize') AS idempotency,
       (SELECT count(*)::integer FROM platform.domain_events
        WHERE property_id = $1::uuid
          AND resource_type = 'inventory_materialization') AS events,
       (SELECT count(*)::integer FROM platform.outbox_events
        WHERE property_id = $1::uuid
          AND destination = 'distribution.inventory-projection') AS outbox`,
    [propertyId],
  );
  if (!result.rows[0]) throw new Error("Missing materialization side-effect counts");
  return result.rows[0];
}

async function inventoryDayCount(admin: pg.Client, propertyId: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM pms.inventory_days WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0]?.count ?? -1;
}

async function backendProcessId(client: pg.Client): Promise<number> {
  const result = await client.query<{ processId: number }>(
    `SELECT pg_backend_pid()::integer AS "processId"`,
  );
  const processId = result.rows[0]?.processId;
  if (!processId) throw new Error("Missing PostgreSQL backend process ID");
  return processId;
}

async function waitForLockWaiter(admin: pg.Client, blockingProcessId: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await admin.query<{ waitingCount: number }>(
      `SELECT count(*)::integer AS "waitingCount"
       FROM pg_stat_activity activity
       WHERE $1::integer = ANY(pg_blocking_pids(activity.pid))`,
      [blockingProcessId],
    );
    if ((result.rows[0]?.waitingCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the shared PMS inventory advisory lock");
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const databaseName = url.pathname.slice(1);
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
