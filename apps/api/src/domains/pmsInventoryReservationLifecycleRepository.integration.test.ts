import { createHash, randomUUID } from "node:crypto";

import {
  PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  serializePmsInventoryReservationReleaseFingerprint,
  serializePmsInventoryReservationReserveFingerprint,
  type PmsInventoryReservationDayWatermark,
  type PmsInventoryReservationReleaseCommand,
  type PmsInventoryReservationReserveCommand,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarReadPort,
  type RoomCapacityReadPort,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPgPmsInventoryMaterializationRepository,
  type PmsInventoryMaterializationRepository,
} from "./pmsInventoryMaterializationRepository.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  createPgPmsInventoryReservationLifecycleRepository,
  type PmsInventoryReservationLifecycleAuthorizationPort,
  type PmsInventoryReservationLifecycleRepository,
} from "./pmsInventoryReservationLifecycleRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ACCEPTED_AT = new Date("2026-08-04T09:00:00.000Z");
const RELEASED_AT = new Date("2026-08-04T10:00:00.000Z");

type Fixture = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  linkedRoomTypeId?: string;
  actorUserId: string;
  configuration: PmsOperatingCalendarConfigurationSnapshot;
  calendarState: { stale: boolean };
  capacityState: { revision: number; count: number };
  profileState: { available: boolean; revision: number };
  authorizationState: { allowed: boolean };
  authorize: ReturnType<typeof vi.fn>;
  materialization: PmsInventoryMaterializationRepository;
  reservation: PmsInventoryReservationLifecycleRepository;
}>;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS inventory reservation lifecycle", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const closeables: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  afterAll(async () => {
    await Promise.all(closeables.map((repository) => repository.close()));
    await admin.end();
  });

  it("reserves every day atomically and exact reserve/release retries return current state", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-05");
    const reserve = await reserveCommand(admin, fixture, "reserve-one", 1);

    const held = await fixture.reservation.reserveInventory(reserve);
    expect(held).toMatchObject({
      ok: true,
      outcome: "reserved",
      status: {
        state: "reserved",
        lifecycleRevision: 1,
        roomCount: 1,
        reservationWatermarks: [{ stayDate: "2026-08-04" }, { stayDate: "2026-08-05" }],
      },
      projectionRefreshIntent: {
        reason: "reservation_held",
        coverageFrom: "2026-08-04",
        coverageThroughExclusive: "2026-08-06",
      },
    });
    if (!held.ok) throw new Error("Expected successful inventory hold");
    expect(JSON.stringify(held.projectionRefreshIntent)).not.toContain("quote-session");
    expect(JSON.stringify(held.projectionRefreshIntent)).not.toContain("public-offer");
    const heldPayloads = await projectionPayloads(admin, fixture.propertyId);
    expect(heldPayloads).toHaveLength(2);
    for (const payload of heldPayloads) {
      expect(payload).not.toContain("quote-session");
      expect(payload).not.toContain("public-offer");
    }
    await expect(readDays(admin, fixture)).resolves.toEqual([
      dayState("2026-08-04", 1, 1, 2, 1),
      dayState("2026-08-05", 1, 1, 2, 1),
    ]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      reserveAudits: 1,
      releaseAudits: 0,
      reserveIdempotency: 1,
      releaseIdempotency: 0,
      events: 1,
      outbox: 1,
      receipts: 1,
    });

    await expect(fixture.reservation.reserveInventory(reserve)).resolves.toMatchObject({
      ok: true,
      outcome: "already_reserved",
      status: { receipt: held.status.receipt, state: "reserved" },
      projectionRefreshIntent: null,
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      reserveAudits: 1,
      reserveIdempotency: 1,
      events: 1,
      outbox: 1,
    });

    await expect(
      fixture.reservation.getInventoryReservationStatus({
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        receipt: held.status.receipt,
      }),
    ).resolves.toEqual(held.status);

    const release = releaseCommand(fixture, held.status.receipt, "release-one");
    const released = await fixture.reservation.releaseInventory(release);
    expect(released).toMatchObject({
      ok: true,
      outcome: "released",
      status: { state: "released", lifecycleRevision: 2, receipt: held.status.receipt },
      projectionRefreshIntent: { reason: "reservation_released" },
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([
      dayState("2026-08-04", 0, 2, 3, 2),
      dayState("2026-08-05", 0, 2, 3, 2),
    ]);
    await expect(fixture.reservation.releaseInventory(release)).resolves.toMatchObject({
      ok: true,
      outcome: "already_released",
      status: { state: "released", receipt: held.status.receipt },
      projectionRefreshIntent: null,
    });
    await expect(fixture.reservation.reserveInventory(reserve)).resolves.toMatchObject({
      ok: true,
      outcome: "already_released",
      status: { state: "released", receipt: held.status.receipt },
      projectionRefreshIntent: null,
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      reserveAudits: 1,
      releaseAudits: 1,
      reserveIdempotency: 1,
      releaseIdempotency: 1,
      events: 2,
      outbox: 2,
      receipts: 1,
    });
  });

  it("advances canonical revisions and consumes each public booking release once", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count, available_count,
         calendar_revision, inventory_revision, generated_sellable_limit_count,
         effective_sellable_limit_count, generated_source_revision,
         channel_source_revision, manual_source_revision, block_source_revision,
         booking_source_revision
       ) SELECT $1::uuid, $2::uuid, stay_date, 2, 2,
                1, 1, 2, 2, 1, 0, 0, 0, 0
         FROM unnest(ARRAY[DATE '2026-08-04', DATE '2026-08-05']) AS stay_date`,
      [fixture.propertyId, fixture.roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count, available_count
       ) VALUES ($1::uuid, $2::uuid, DATE '2026-08-06', 2, 2)`,
      [fixture.propertyId, fixture.roomTypeId],
    );
    const publicId = `reservation-${fixture.propertyId}`;
    const publicOfferKey = `room-${fixture.roomTypeId}:flexible`;
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id, public_id, display_name, canonical_slug,
         default_locale, supported_locales, profile_status
       ) VALUES ($1::uuid, $2, 'Reservation Hotel', $2, 'en', ARRAY['en'], 'complete')`,
      [fixture.propertyId, publicId],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id, public_id, canonical_slug, canonical_url, booking_base_url,
         timezone, default_currency, supported_currencies, profile_status,
         freshness_status, public_setup_completeness
       ) VALUES (
         $1::uuid, $2, $2, 'https://booking.example.test/' || $2,
         'https://booking.example.test', 'Europe/Berlin', 'EUR', ARRAY['EUR'],
         'public', 'fresh', '{"status":"ready"}'::jsonb
       )`,
      [fixture.propertyId, publicId],
    );
    await admin.query(
      `INSERT INTO distribution.public_room_offer_snapshots (
         property_id, room_type_id, stay_date, public_offer_key,
         available_rooms, currency, freshness_status
       ) SELECT $1::uuid, $2::uuid, stay_date, $3, 2, 'EUR', 'fresh'
         FROM unnest(ARRAY[
           DATE '2026-08-04', DATE '2026-08-05', DATE '2026-08-06'
         ]) AS stay_date`,
      [fixture.propertyId, fixture.roomTypeId, publicOfferKey],
    );
    const port = createTargetPmsInventoryReservationPort();
    const inTransaction = async <T>(operation: (client: pg.Client) => Promise<T>): Promise<T> => {
      await admin.query("BEGIN");
      try {
        const result = await operation(admin);
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    const reserve = (quoteSessionId: string, checkIn: string, checkOut: string) =>
      inTransaction((transaction) =>
        port.reserve({
          transaction,
          propertyId: fixture.propertyId,
          quoteSessionId,
          roomTypeId: fixture.roomTypeId,
          publicOfferKey,
          checkIn,
          checkOut,
          roomCount: 1,
          currency: "EUR",
          occurredAt: ACCEPTED_AT,
        }),
      );
    const first = await reserve(randomUUID(), "2026-08-04", "2026-08-06");
    const second = await reserve(randomUUID(), "2026-08-04", "2026-08-05");
    expect(first).toMatchObject({
      contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      owner: "pms",
      receiptId: expect.any(String),
    });
    expect(second).not.toBeNull();

    const release = (reservation: NonNullable<typeof first>) =>
      inTransaction((transaction) =>
        port.release({
          transaction,
          propertyId: fixture.propertyId,
          reservation,
          occurredAt: RELEASED_AT,
        }),
      );
    await release(first!);
    const afterFirstRelease = (await readDays(admin, fixture)).slice(0, 2);
    expect(afterFirstRelease).toEqual([
      dayState("2026-08-04", 1, 1, 4, 3),
      dayState("2026-08-05", 0, 2, 3, 2),
    ]);
    await release(first!);
    expect((await readDays(admin, fixture)).slice(0, 2)).toEqual(afterFirstRelease);
    await expect(readPublicOfferAvailability(admin, fixture.propertyId)).resolves.toEqual([
      { stayDate: "2026-08-04", availableRooms: 1 },
      { stayDate: "2026-08-05", availableRooms: 2 },
      { stayDate: "2026-08-06", availableRooms: 2 },
    ]);

    await release(second!);
    expect((await readDays(admin, fixture)).slice(0, 2)).toEqual([
      dayState("2026-08-04", 0, 2, 5, 4),
      dayState("2026-08-05", 0, 2, 3, 2),
    ]);

    const legacy = await reserve(randomUUID(), "2026-08-06", "2026-08-07");
    expect(legacy).toBeNull();
    const legacyDay = (await readDays(admin, fixture)).at(-1);
    expect(legacyDay).toEqual({
      stayDate: "2026-08-06",
      assignedCount: 0,
      availableCount: 2,
      inventoryRevision: null,
      bookingRevision: null,
    });
    const releases = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid
         AND operation = 'pms.direct_booking_inventory.release'`,
      [fixture.propertyId],
    );
    expect(releases.rows[0]?.count).toBe(2);

    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count, available_count,
         calendar_revision, inventory_revision, generated_sellable_limit_count,
         effective_sellable_limit_count, generated_source_revision,
         channel_source_revision, manual_source_revision, block_source_revision,
         booking_source_revision
       ) SELECT $1::uuid, $2::uuid, stay_date, 2, 2,
                1, 1, 2, 2, 1, 0, 0, 0, 0
         FROM unnest(ARRAY[DATE '2026-08-07', DATE '2026-08-08']) AS stay_date`,
      [fixture.propertyId, fixture.roomTypeId],
    );
    await admin.query(
      `INSERT INTO distribution.public_room_offer_snapshots (
         property_id, room_type_id, stay_date, public_offer_key,
         available_rooms, currency, freshness_status
       ) SELECT $1::uuid, $2::uuid, stay_date, $3, 2, 'EUR', 'fresh'
         FROM unnest(ARRAY[DATE '2026-08-07', DATE '2026-08-08']) AS stay_date`,
      [fixture.propertyId, fixture.roomTypeId, publicOfferKey],
    );
    const contested = await reserve(randomUUID(), "2026-08-07", "2026-08-09");
    if (!contested) throw new Error("Expected contested reservation marker");
    if (!("receiptId" in contested)) throw new Error("Expected opaque reservation receipt");
    const contestedSideEffects = await sideEffectCounts(admin, fixture.propertyId);
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    const waiter = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    let pendingRelease: Promise<void> | undefined;
    await Promise.all([blocker.connect(), waiter.connect()]);
    try {
      await Promise.all([blocker.query("BEGIN"), waiter.query("BEGIN")]);
      await lockPmsInventoryMutationScope(blocker, fixture.propertyId);
      const waiterPid = await waiter.query<{ pid: number }>(
        "SELECT pg_backend_pid()::integer AS pid",
      );
      pendingRelease = port.release({
        transaction: waiter,
        propertyId: fixture.propertyId,
        reservation: contested,
        occurredAt: RELEASED_AT,
      });
      await waitForAdvisoryWaiter(admin, waiterPid.rows[0]!.pid);
      const rejectedRelease = expect(pendingRelease).rejects.toThrow(
        "receipt could not be released",
      );
      await blocker.query(
        `UPDATE pms.inventory_days
         SET assigned_count = 0, available_count = 2,
             inventory_revision = inventory_revision + 1,
             booking_source_revision = booking_source_revision + 1
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date = DATE '2026-08-08'`,
        [fixture.propertyId, fixture.roomTypeId],
      );
      await blocker.query("COMMIT");
      await rejectedRelease;
      await waiter.query("ROLLBACK");
    } finally {
      await Promise.allSettled([blocker.query("ROLLBACK"), waiter.query("ROLLBACK")]);
      if (pendingRelease) await Promise.allSettled([pendingRelease]);
      await Promise.all([blocker.end(), waiter.end()]);
    }
    const contestedDays = await admin.query<{
      stayDate: string;
      assignedCount: number;
      inventoryRevision: number;
      bookingRevision: number;
    }>(
      `SELECT stay_date::text AS "stayDate", assigned_count AS "assignedCount",
              inventory_revision AS "inventoryRevision",
              booking_source_revision AS "bookingRevision"
       FROM pms.inventory_days
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid
         AND stay_date >= DATE '2026-08-07'
       ORDER BY stay_date`,
      [fixture.propertyId, fixture.roomTypeId],
    );
    expect(contestedDays.rows).toEqual([
      { stayDate: "2026-08-07", assignedCount: 1, inventoryRevision: 2, bookingRevision: 1 },
      { stayDate: "2026-08-08", assignedCount: 0, inventoryRevision: 3, bookingRevision: 2 },
    ]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual(
      contestedSideEffects,
    );
    const contestedStatus = await admin.query<{ state: string }>(
      `SELECT lifecycle_state AS state FROM pms.inventory_reservation_statuses
       WHERE receipt_id=$1::uuid`,
      [contested.receiptId],
    );
    expect(contestedStatus.rows[0]?.state).toBe("reserved");
    const finalReleases = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid
         AND operation = 'pms.direct_booking_inventory.release'`,
      [fixture.propertyId],
    );
    expect(finalReleases.rows[0]?.count).toBe(2);
  });

  it("stop-sells and releases every linked type for direct booking holds", async () => {
    const fixture = await createFixture(admin, closeables, {
      capacity: 2,
      startingLimit: 2,
      linked: true,
    });
    const linkedRoomTypeId = fixture.linkedRoomTypeId!;
    const publicOfferKey = `linked-${fixture.roomTypeId}:flexible`;
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
         inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
         generated_source_revision,channel_source_revision,manual_source_revision,
         block_source_revision,booking_source_revision
       ) SELECT $1,room_type_id,stay_date,2,2,1,1,2,2,1,0,0,0,0
         FROM unnest($2::uuid[]) room_type_id
         CROSS JOIN unnest(ARRAY[DATE '2026-09-10',DATE '2026-09-11']) stay_date`,
      [fixture.propertyId, [fixture.roomTypeId, linkedRoomTypeId]],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id,public_id,display_name,canonical_slug,default_locale,
         supported_locales,profile_status
       ) VALUES ($1,$2,'Linked Hotel',$2,'en',ARRAY['en'],'complete')`,
      [fixture.propertyId, `linked-${fixture.propertyId}`],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
         default_currency,supported_currencies,profile_status,freshness_status,
         public_setup_completeness
       ) VALUES ($1,$2,$2,'https://booking.test/linked','https://booking.test','Europe/Berlin',
         'EUR',ARRAY['EUR'],'public','fresh','{"status":"ready"}')`,
      [fixture.propertyId, `linked-${fixture.propertyId}`],
    );
    await admin.query(
      `INSERT INTO distribution.public_room_offer_snapshots (
         property_id,room_type_id,stay_date,public_offer_key,available_rooms,currency,freshness_status
       ) SELECT $1,$2,stay_date,$3,2,'EUR','fresh'
         FROM unnest(ARRAY[DATE '2026-09-10',DATE '2026-09-11']) stay_date`,
      [fixture.propertyId, fixture.roomTypeId, publicOfferKey],
    );
    const port = createTargetPmsInventoryReservationPort();
    await admin.query("BEGIN");
    // prettier-ignore
    const marker = await port.reserve({ transaction: admin, propertyId: fixture.propertyId, quoteSessionId: randomUUID(), roomTypeId: fixture.roomTypeId, publicOfferKey, checkIn: "2026-09-10", checkOut: "2026-09-12", roomCount: 1, currency: "EUR", occurredAt: ACCEPTED_AT });
    await admin.query("COMMIT");
    expect(marker).not.toBeNull();
    await expect(linkedState(admin, fixture.propertyId, linkedRoomTypeId)).resolves.toEqual({
      available: [0, 0],
      activeBlocks: 1,
      lifecycleState: "reserved",
    });
    await admin.query("BEGIN");
    await port.release({
      transaction: admin,
      propertyId: fixture.propertyId,
      reservation: marker!,
      occurredAt: RELEASED_AT,
    });
    await admin.query("COMMIT");
    const beforeRetry = await sideEffectCounts(admin, fixture.propertyId);
    await admin.query("BEGIN");
    // prettier-ignore
    await port.release({ transaction: admin, propertyId: fixture.propertyId, reservation: marker!, occurredAt: RELEASED_AT });
    await admin.query("COMMIT");
    expect(await sideEffectCounts(admin, fixture.propertyId)).toEqual(beforeRetry);
    await expect(linkedState(admin, fixture.propertyId, linkedRoomTypeId)).resolves.toEqual({
      available: [2, 2],
      activeBlocks: 0,
      lifecycleState: "released",
    });
    // prettier-ignore
    await admin.query("UPDATE pms.inventory_days SET calendar_revision=NULL,inventory_revision=NULL,generated_sellable_limit_count=NULL,effective_sellable_limit_count=NULL,generated_source_revision=NULL,channel_source_revision=NULL,manual_source_revision=NULL,block_source_revision=NULL,booking_source_revision=NULL WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-09-11'", [fixture.propertyId, fixture.roomTypeId]);
    await admin.query("BEGIN");
    // prettier-ignore
    await expect(port.reserve({ transaction: admin, propertyId: fixture.propertyId, quoteSessionId: randomUUID(), roomTypeId: fixture.roomTypeId, publicOfferKey, checkIn: "2026-09-10", checkOut: "2026-09-12", roomCount: 1, currency: "EUR", occurredAt: ACCEPTED_AT })).resolves.toBeNull();
    await admin.query("COMMIT");
    // prettier-ignore
    await expect(linkedState(admin, fixture.propertyId, fixture.roomTypeId)).resolves.toMatchObject({ available: [2, 2] });
  });

  it("rejects a stale full-stay watermark without changing any day", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-05");
    const command = await reserveCommand(admin, fixture, "stale-watermark", 1);
    const stale = {
      ...command,
      inventoryWatermarks: [
        command.inventoryWatermarks[0]!,
        { ...command.inventoryWatermarks[1]!, inventoryRevision: 2 },
      ],
    } satisfies PmsInventoryReservationReserveCommand;

    await expect(fixture.reservation.reserveInventory(stale)).resolves.toEqual({
      ok: false,
      error: { code: "inventory_watermark_conflict" },
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([
      dayState("2026-08-04", 0, 2, 1, 0),
      dayState("2026-08-05", 0, 2, 1, 0),
    ]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      reserveAudits: 1,
      reserveIdempotency: 1,
      events: 0,
      outbox: 0,
      receipts: 0,
    });
    await expect(fixture.reservation.reserveInventory(stale)).resolves.toEqual({
      ok: false,
      error: { code: "inventory_watermark_conflict" },
    });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      reserveAudits: 1,
      reserveIdempotency: 1,
    });
  });

  it("serializes concurrent holds so capacity cannot be oversold", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 1, startingLimit: 1 });
    await materialize(fixture, "2026-08-04", "2026-08-05");
    const left = await reserveCommand(admin, fixture, "concurrent-left", 1);
    const right = {
      ...left,
      idempotencyKey: "concurrent-right",
      offerCorrelation: {
        quoteSessionId: "quote-session-right",
        publicOfferKey: "public-offer-right",
      },
      audit: {
        ...left.audit,
        requestId: "request-concurrent-right",
        correlationId: "correlation-concurrent-right",
      },
    } satisfies PmsInventoryReservationReserveCommand;

    const results = await Promise.all([
      fixture.reservation.reserveInventory(left),
      fixture.reservation.reserveInventory(right),
    ]);
    expect(results.filter((result) => result.ok && result.outcome === "reserved")).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          !result.ok &&
          (result.error.code === "inventory_watermark_conflict" ||
            result.error.code === "inventory_unavailable"),
      ),
    ).toHaveLength(1);
    await expect(readDays(admin, fixture)).resolves.toEqual([
      dayState("2026-08-04", 1, 0, 2, 1),
      dayState("2026-08-05", 1, 0, 2, 1),
    ]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      reserveAudits: 2,
      reserveIdempotency: 2,
      events: 1,
      outbox: 1,
      receipts: 1,
    });
  });

  it("fails closed for stale calendar, profile, capacity, and materialization coverage", async () => {
    const staleCalendar = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(staleCalendar, "2026-08-04", "2026-08-04");
    staleCalendar.calendarState.stale = true;
    await expect(
      staleCalendar.reservation.reserveInventory(
        await reserveCommand(admin, staleCalendar, "stale-calendar", 1, "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });

    const staleProfile = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(staleProfile, "2026-08-04", "2026-08-04");
    staleProfile.profileState.revision = 2;
    await expect(
      staleProfile.reservation.reserveInventory(
        await reserveCommand(admin, staleProfile, "stale-profile", 1, "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });

    const staleCapacity = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(staleCapacity, "2026-08-04", "2026-08-04");
    staleCapacity.capacityState.count = 3;
    await expect(
      staleCapacity.reservation.reserveInventory(
        await reserveCommand(admin, staleCapacity, "stale-capacity", 1, "2026-08-04"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "configuration_not_current" } });

    const missingCoverage = await createFixture(admin, closeables, {
      capacity: 2,
      startingLimit: 2,
    });
    await materialize(missingCoverage, "2026-08-04", "2026-08-04");
    const command = await reserveCommand(admin, missingCoverage, "coverage-gap", 1, "2026-08-04");
    const beyond = {
      ...command,
      checkOut: "2026-08-06",
      inventoryWatermarks: [
        command.inventoryWatermarks[0]!,
        {
          ...command.inventoryWatermarks[0]!,
          stayDate: "2026-08-05",
        },
      ],
    } satisfies PmsInventoryReservationReserveCommand;
    await expect(missingCoverage.reservation.reserveInventory(beyond)).resolves.toEqual({
      ok: false,
      error: { code: "materialization_not_current" },
    });

    for (const fixture of [staleCalendar, staleProfile, staleCapacity, missingCoverage]) {
      await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
        events: 0,
        outbox: 0,
        receipts: 0,
      });
    }
  });

  it("releases after a later sellable-limit reduction without repairing unrelated owners", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const held = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "lower-limit-hold", 2, "2026-08-04"),
    );
    if (!held.ok) throw new Error("Expected hold before lowering limit");
    await admin.query(
      `UPDATE pms.inventory_days
       SET manual_sellable_limit_count = 0,
           effective_sellable_limit_count = 0,
           manual_source_revision = manual_source_revision + 1,
           inventory_revision = inventory_revision + 1,
           available_count = 0
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid
         AND stay_date = DATE '2026-08-04'`,
      [fixture.propertyId, fixture.roomTypeId],
    );

    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, held.status.receipt, "lower-limit-release"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "released" });
    const result = await admin.query<{
      assignedCount: number;
      availableCount: number;
      manualLimit: number;
      manualRevision: number;
      generatedRevision: number;
      bookingRevision: number;
    }>(
      `SELECT assigned_count AS "assignedCount", available_count AS "availableCount",
              manual_sellable_limit_count AS "manualLimit",
              manual_source_revision AS "manualRevision",
              generated_source_revision AS "generatedRevision",
              booking_source_revision AS "bookingRevision"
       FROM pms.inventory_days
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid
         AND stay_date = DATE '2026-08-04'`,
      [fixture.propertyId, fixture.roomTypeId],
    );
    expect(result.rows).toEqual([
      {
        assignedCount: 0,
        availableCount: 0,
        manualLimit: 0,
        manualRevision: 1,
        generatedRevision: 1,
        bookingRevision: 2,
      },
    ]);
  });

  it("returns already_handed_off without decrementing capacity or emitting refresh intent", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const reserve = await reserveCommand(admin, fixture, "handoff-hold", 1, "2026-08-04");
    const held = await fixture.reservation.reserveInventory(reserve);
    if (!held.ok) throw new Error("Expected hold before handoff");
    await admin.query(
      `UPDATE pms.inventory_reservation_statuses
       SET lifecycle_state = 'handed_off', lifecycle_revision = 2,
           handed_off_at = $2::timestamptz
       WHERE receipt_id = $1::uuid`,
      [held.status.receipt.receiptId, RELEASED_AT.toISOString()],
    );

    await expect(fixture.reservation.reserveInventory(reserve)).resolves.toMatchObject({
      ok: true,
      outcome: "already_handed_off",
      status: { state: "handed_off", lifecycleRevision: 2 },
      projectionRefreshIntent: null,
    });
    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, held.status.receipt, "handoff-release"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "already_handed_off",
      status: { state: "handed_off", lifecycleRevision: 2 },
      projectionRefreshIntent: null,
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([dayState("2026-08-04", 1, 1, 2, 1)]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual({
      reserveAudits: 1,
      releaseAudits: 1,
      reserveIdempotency: 1,
      releaseIdempotency: 1,
      events: 1,
      outbox: 1,
      receipts: 1,
    });
  });

  it("authorizes before replay/read and fails closed for the wrong scope", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const reserve = await reserveCommand(admin, fixture, "authorization", 1, "2026-08-04");
    const held = await fixture.reservation.reserveInventory(reserve);
    if (!held.ok) throw new Error("Expected initial authorized hold");

    await expect(
      fixture.reservation.getInventoryReservationStatus({
        organizationId: randomUUID(),
        propertyId: fixture.propertyId,
        receipt: held.status.receipt,
      }),
    ).resolves.toBeNull();
    await expect(
      fixture.reservation.releaseInventory({
        ...releaseCommand(fixture, held.status.receipt, "wrong-scope-release"),
        propertyId: randomUUID(),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "receipt_not_found" } });

    fixture.authorizationState.allowed = false;

    await expect(fixture.reservation.reserveInventory(reserve)).resolves.toEqual({
      ok: false,
      error: { code: "configuration_not_current" },
    });
    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, held.status.receipt, "authorization-release"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "receipt_not_found" } });
    await expect(
      fixture.reservation.getInventoryReservationStatus({
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        receipt: held.status.receipt,
      }),
    ).resolves.toBeNull();
    expect(fixture.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: "status", audit: null }),
    );
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      reserveAudits: 1,
      releaseAudits: 0,
      reserveIdempotency: 1,
      releaseIdempotency: 0,
    });
  });

  it("freezes changed fingerprints and reports unfinished reserve/release keys", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const reserve = await reserveCommand(admin, fixture, "fingerprint", 1, "2026-08-04");
    const held = await fixture.reservation.reserveInventory(reserve);
    if (!held.ok) throw new Error("Expected hold for fingerprint test");
    await expect(
      fixture.reservation.reserveInventory({ ...reserve, roomCount: 2 }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });

    const inProgressReserve = await reserveCommand(
      admin,
      fixture,
      "reserve-in-progress",
      1,
      "2026-08-04",
    );
    await seedInProgress(
      admin,
      fixture.propertyId,
      "pms.inventory.reserve",
      inProgressReserve.idempotencyKey,
      serializePmsInventoryReservationReserveFingerprint(inProgressReserve),
    );
    await expect(fixture.reservation.reserveInventory(inProgressReserve)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });

    const release = releaseCommand(fixture, held.status.receipt, "release-in-progress");
    await seedInProgress(
      admin,
      fixture.propertyId,
      "pms.inventory.release",
      release.idempotencyKey,
      serializePmsInventoryReservationReleaseFingerprint(release),
    );
    await expect(fixture.reservation.releaseInventory(release)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([dayState("2026-08-04", 1, 1, 2, 1)]);
  });

  it("conflicts when a release key is reused for a different scoped receipt", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const first = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "release-fingerprint-first-hold", 1, "2026-08-04"),
    );
    if (!first.ok) throw new Error("Expected first release-fingerprint hold");
    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, first.status.receipt, "shared-release-key"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "released" });

    const second = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "release-fingerprint-second-hold", 1, "2026-08-04"),
    );
    if (!second.ok) throw new Error("Expected second release-fingerprint hold");
    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, second.status.receipt, "shared-release-key"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(readDays(admin, fixture)).resolves.toEqual([dayState("2026-08-04", 1, 1, 4, 3)]);
    await expect(
      fixture.reservation.getInventoryReservationStatus({
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        receipt: second.status.receipt,
      }),
    ).resolves.toMatchObject({ state: "reserved", lifecycleRevision: 1 });
  });

  it("rolls back a multi-day release when any original day is inconsistent", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-05");
    const held = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "release-atomicity-hold", 1),
    );
    if (!held.ok) throw new Error("Expected hold for release atomicity test");
    await admin.query(
      `UPDATE pms.inventory_days
       SET assigned_count = 0, available_count = 2,
           booking_source_revision = booking_source_revision + 1,
           inventory_revision = inventory_revision + 1
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid
         AND stay_date = DATE '2026-08-05'`,
      [fixture.propertyId, fixture.roomTypeId],
    );

    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, held.status.receipt, "release-atomicity"),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "inventory_invariant_violation" } });
    await expect(readDays(admin, fixture)).resolves.toEqual([
      dayState("2026-08-04", 1, 1, 2, 1),
      dayState("2026-08-05", 0, 2, 3, 2),
    ]);
    await expect(
      fixture.reservation.getInventoryReservationStatus({
        organizationId: fixture.organizationId,
        propertyId: fixture.propertyId,
        receipt: held.status.receipt,
      }),
    ).resolves.toMatchObject({ state: "reserved", lifecycleRevision: 1 });
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toMatchObject({
      events: 1,
      outbox: 1,
    });
  });

  it("replays an earlier failed release as already_released after a later successful release", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const held = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "failed-then-released-hold", 1, "2026-08-04"),
    );
    if (!held.ok) throw new Error("Expected hold before failed release replay test");
    const failedRelease = releaseCommand(
      fixture,
      held.status.receipt,
      "failed-before-successful-release",
    );

    fixture.capacityState.count = 3;
    await expect(fixture.reservation.releaseInventory(failedRelease)).resolves.toEqual({
      ok: false,
      error: { code: "inventory_invariant_violation" },
    });
    fixture.capacityState.count = 2;
    await expect(
      fixture.reservation.releaseInventory(
        releaseCommand(fixture, held.status.receipt, "successful-later-release"),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "released" });
    const beforeReplay = await sideEffectCounts(admin, fixture.propertyId);

    await expect(fixture.reservation.releaseInventory(failedRelease)).resolves.toMatchObject({
      ok: true,
      outcome: "already_released",
      status: { state: "released", receipt: held.status.receipt },
      projectionRefreshIntent: null,
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([dayState("2026-08-04", 0, 2, 3, 2)]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual(beforeReplay);
  });

  it("replays an earlier failed release as already_handed_off after adoption", async () => {
    const fixture = await createFixture(admin, closeables, { capacity: 2, startingLimit: 2 });
    await materialize(fixture, "2026-08-04", "2026-08-04");
    const held = await fixture.reservation.reserveInventory(
      await reserveCommand(admin, fixture, "failed-then-handed-off-hold", 1, "2026-08-04"),
    );
    if (!held.ok) throw new Error("Expected hold before failed handoff replay test");
    const failedRelease = releaseCommand(fixture, held.status.receipt, "failed-before-handoff");

    fixture.capacityState.count = 3;
    await expect(fixture.reservation.releaseInventory(failedRelease)).resolves.toEqual({
      ok: false,
      error: { code: "inventory_invariant_violation" },
    });
    await admin.query(
      `UPDATE pms.inventory_reservation_statuses
       SET lifecycle_state = 'handed_off', lifecycle_revision = 2,
           handed_off_at = $2::timestamptz
       WHERE receipt_id = $1::uuid`,
      [held.status.receipt.receiptId, RELEASED_AT.toISOString()],
    );
    const beforeReplay = await sideEffectCounts(admin, fixture.propertyId);

    await expect(fixture.reservation.releaseInventory(failedRelease)).resolves.toMatchObject({
      ok: true,
      outcome: "already_handed_off",
      status: { state: "handed_off", receipt: held.status.receipt },
      projectionRefreshIntent: null,
    });
    await expect(readDays(admin, fixture)).resolves.toEqual([dayState("2026-08-04", 1, 1, 2, 1)]);
    await expect(sideEffectCounts(admin, fixture.propertyId)).resolves.toEqual(beforeReplay);
  });
});

// prettier-ignore
async function linkedState(admin: pg.Client, propertyId: string, roomTypeId: string) { const state = await admin.query<{ available: number[]; activeBlocks: number; lifecycleState: string }>(`SELECT ARRAY(SELECT available_count FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2 ORDER BY stay_date) AS available,(SELECT count(*)::int FROM pms.room_blocks WHERE property_id=$1 AND room_type_id=$2 AND status='active') AS "activeBlocks",(SELECT lifecycle_state FROM pms.inventory_reservation_statuses status JOIN pms.inventory_reservation_receipts receipt USING (receipt_id) WHERE receipt.property_id=$1 LIMIT 1) AS "lifecycleState"`, [propertyId, roomTypeId]); return state.rows[0]; }

async function createFixture(
  admin: pg.Client,
  closeables: Array<{ close(): Promise<void> }>,
  options: Readonly<{ capacity: number; startingLimit: number; linked?: boolean }>,
): Promise<Fixture> {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const linkedRoomTypeId = options.linked ? randomUUID() : undefined;
  const actorUserId = randomUUID();
  await admin.query(
    `INSERT INTO identity.organizations (id, kind, name, slug)
     VALUES ($1::uuid, 'hotel_group', 'VAY-1063 Reservation Test', $2)`,
    [organizationId, `vay-1063-reservation-${organizationId}`],
  );
  await admin.query(
    `INSERT INTO identity.users (id, email, name)
     VALUES ($1::uuid, $2, 'VAY-1063 Reservation Test')`,
    [actorUserId, `${actorUserId}@example.test`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-1063 Reservation Test')`,
    [propertyId, `vay-1063-reservation-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name)
     VALUES ($1::uuid, $2::uuid, 'Room')`,
    [roomTypeId, propertyId],
  );
  if (linkedRoomTypeId) {
    const groupId = randomUUID();
    await admin.query(
      `INSERT INTO pms.room_types (id,property_id,name) VALUES ($1,$2,'Linked Room')`,
      [linkedRoomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.linked_inventory_groups (id,property_id,name) VALUES ($1,$2,'Convertible')`,
      [groupId, propertyId],
    );
    await admin.query(
      `UPDATE pms.room_types SET linked_inventory_group_id=$1 WHERE id=ANY($2::uuid[])`,
      [groupId, [roomTypeId, linkedRoomTypeId]],
    );
  }
  const configuration = configurationSnapshot({
    propertyId,
    roomTypeId,
    capacity: options.capacity,
    startingLimit: options.startingLimit,
  });
  await seedCalendarRevision(admin, {
    organizationId,
    propertyId,
    roomTypeIds: [roomTypeId, ...(linkedRoomTypeId ? [linkedRoomTypeId] : [])],
    actorUserId,
    capacity: options.capacity,
    startingLimit: options.startingLimit,
  });

  const calendarState = { stale: false };
  const capacityState = { revision: 1, count: options.capacity };
  const profileState = { available: true, revision: 1 };
  const authorizationState = { allowed: true };
  const operatingCalendar: PmsOperatingCalendarReadPort = {
    async getCurrentOperatingCalendarConfiguration(requestedPropertyId) {
      if (requestedPropertyId !== propertyId) return null;
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
      return source.entityId === propertyId && source.revision === "calendar:1"
        ? configuration
        : null;
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
              evidence: { source, timeZone: configuration.sourceInputs.propertyTimeZone },
            }
          : { status: "timezone_missing", source },
      );
    },
  };
  const materialization = createPgPmsInventoryMaterializationRepository({
    connectionString: TEST_DATABASE_URL!,
    max: 2,
    now: () => ACCEPTED_AT,
    authorization: {
      async authorizeInventoryMaterialization() {
        return true;
      },
    },
    operatingCalendar,
    propertyProfileEvidence,
    roomCapacity,
  });
  const authorize = vi.fn(async () => authorizationState.allowed);
  const authorization: PmsInventoryReservationLifecycleAuthorizationPort = {
    authorizeInventoryReservationScope: authorize,
  };
  let clock = ACCEPTED_AT;
  const reservation = createPgPmsInventoryReservationLifecycleRepository({
    connectionString: TEST_DATABASE_URL!,
    max: 2,
    now: () => {
      const value = clock;
      clock = new Date(clock.getTime() + 60_000);
      return value;
    },
    authorization,
    operatingCalendar,
    propertyProfileEvidence,
    roomCapacity,
  });
  closeables.push(materialization, reservation);
  return {
    organizationId,
    propertyId,
    roomTypeId,
    linkedRoomTypeId,
    actorUserId,
    configuration,
    calendarState,
    capacityState,
    profileState,
    authorizationState,
    authorize,
    materialization,
    reservation,
  };
}

function configurationSnapshot(input: {
  propertyId: string;
  roomTypeId: string;
  capacity: number;
  startingLimit: number;
}): PmsOperatingCalendarConfigurationSnapshot {
  const parsed = parsePmsOperatingCalendarConfigurationSnapshot(
    {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      propertyId: input.propertyId,
      calendarRevision: 1,
      source: createPmsOperatingCalendarSourceRevision(input.propertyId, 1),
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
            physicalCapacityCount: input.capacity,
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
  if (!parsed) throw new Error("Reservation test operating calendar is invalid");
  return parsed;
}

async function seedCalendarRevision(
  admin: pg.Client,
  input: {
    organizationId: string;
    propertyId: string;
    roomTypeIds: string[];
    actorUserId: string;
    capacity: number;
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
         $1::uuid, $2::uuid, 1, 'pms-operating-calendar.v1', 1,
         'Europe/Berlin', 'year_round', 0, $8, 1, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::timestamptz, $7::timestamptz
       )`,
      [
        input.organizationId,
        input.propertyId,
        idempotencyId,
        eventId,
        outboxId,
        input.actorUserId,
        ACCEPTED_AT.toISOString(),
        input.roomTypeIds.length,
      ],
    );
    await admin.query(
      `INSERT INTO pms.operating_calendar_room_bindings (
         property_id, calendar_revision, room_type_id,
         source_room_facts_revision, source_room_units_revision,
         physical_capacity_count, starting_sellable_limit_count
       ) SELECT $1::uuid,1,room_type_id,1,1,$3,$4
         FROM unnest($2::uuid[]) room_type_id`,
      [input.propertyId, input.roomTypeIds, input.capacity, input.startingLimit],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function materialize(fixture: Fixture, from: string, through: string): Promise<void> {
  const result = await fixture.materialization.materializeInventory({
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    configurationSource: fixture.configuration.source,
    expectedMaterializedRevision: 1,
    horizon: { from, through },
    idempotencyKey: `materialize-${fixture.propertyId}-${from}-${through}`,
    audit: audit(fixture, `materialize-${from}-${through}`),
  });
  if (!result.ok)
    throw new Error(`Failed to materialize reservation fixture: ${result.error.code}`);
}

async function reserveCommand(
  admin: pg.Client,
  fixture: Fixture,
  key: string,
  roomCount: number,
  onlyDate?: string,
): Promise<PmsInventoryReservationReserveCommand> {
  const inventoryWatermarks = await readWatermarks(admin, fixture, onlyDate);
  const checkIn = onlyDate ?? "2026-08-04";
  const checkOut = onlyDate ? nextDate(onlyDate) : "2026-08-06";
  return {
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    roomTypeId: fixture.roomTypeId,
    checkIn,
    checkOut,
    roomCount,
    offerCorrelation: {
      quoteSessionId: `quote-session-${key}`,
      publicOfferKey: `public-offer-${key}`,
    },
    configurationSource: fixture.configuration.source,
    expectedMaterializedRevision: 1,
    inventoryWatermarks,
    idempotencyKey: key,
    audit: audit(fixture, key),
  };
}

function releaseCommand(
  fixture: Fixture,
  receipt: PmsInventoryReservationReleaseCommand["receipt"],
  key: string,
): PmsInventoryReservationReleaseCommand {
  return {
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    receipt,
    idempotencyKey: key,
    audit: audit(fixture, key),
  };
}

function audit(fixture: Fixture, key: string) {
  return {
    actor: { kind: "user" as const, userId: fixture.actorUserId },
    requestId: `request-${key}`,
    correlationId: `correlation-${key}`,
    requestedAt: ACCEPTED_AT.toISOString(),
  };
}

async function readWatermarks(
  admin: pg.Client,
  fixture: Fixture,
  onlyDate?: string,
): Promise<readonly PmsInventoryReservationDayWatermark[]> {
  const result = await admin.query<{
    stayDate: string;
    calendarRevision: number;
    inventoryRevision: number;
    generated: number;
    channel: number;
    manual: number;
    block: number;
    booking: number;
  }>(
    `SELECT stay_date::text AS "stayDate", calendar_revision AS "calendarRevision",
            inventory_revision AS "inventoryRevision",
            generated_source_revision AS generated,
            channel_source_revision AS channel, manual_source_revision AS manual,
            block_source_revision AS block, booking_source_revision AS booking
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND ($3::date IS NULL OR stay_date = $3::date)
     ORDER BY stay_date`,
    [fixture.propertyId, fixture.roomTypeId, onlyDate ?? null],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        propertyId: fixture.propertyId,
        roomTypeId: fixture.roomTypeId,
        stayDate: row.stayDate,
        calendarRevision: row.calendarRevision,
        inventoryRevision: row.inventoryRevision,
        sourceRevisions: Object.freeze({
          generated: row.generated,
          channel: row.channel,
          manual: row.manual,
          block: row.block,
          booking: row.booking,
        }),
      }),
    ),
  );
}

async function readDays(admin: pg.Client, fixture: Fixture) {
  const result = await admin.query<{
    stayDate: string;
    assignedCount: number;
    availableCount: number;
    inventoryRevision: number;
    bookingRevision: number;
  }>(
    `SELECT stay_date::text AS "stayDate", assigned_count AS "assignedCount",
            available_count AS "availableCount", inventory_revision AS "inventoryRevision",
            booking_source_revision AS "bookingRevision"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
     ORDER BY stay_date`,
    [fixture.propertyId, fixture.roomTypeId],
  );
  return result.rows;
}

async function readPublicOfferAvailability(admin: pg.Client, propertyId: string) {
  const result = await admin.query<{ stayDate: string; availableRooms: number }>(
    `SELECT stay_date::text AS "stayDate", available_rooms AS "availableRooms"
     FROM distribution.public_room_offer_snapshots
     WHERE property_id = $1::uuid
     ORDER BY stay_date`,
    [propertyId],
  );
  return result.rows;
}

async function waitForAdvisoryWaiter(admin: pg.Client, processId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS waiting
       FROM pg_stat_activity WHERE pid = $1`,
      [processId],
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for inventory advisory lock contention");
}

function dayState(
  stayDate: string,
  assignedCount: number,
  availableCount: number,
  inventoryRevision: number,
  bookingRevision: number,
) {
  return { stayDate, assignedCount, availableCount, inventoryRevision, bookingRevision };
}

async function sideEffectCounts(admin: pg.Client, propertyId: string) {
  const result = await admin.query<{
    reserveAudits: number;
    releaseAudits: number;
    reserveIdempotency: number;
    releaseIdempotency: number;
    events: number;
    outbox: number;
    receipts: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM platform.product_audit_events
        WHERE property_id = $1::uuid AND action = 'pms.inventory.reserve') AS "reserveAudits",
       (SELECT count(*)::integer FROM platform.product_audit_events
        WHERE property_id = $1::uuid AND action = 'pms.inventory.release') AS "releaseAudits",
       (SELECT count(*)::integer FROM platform.idempotency_keys
        WHERE property_id = $1::uuid AND operation = 'pms.inventory.reserve') AS "reserveIdempotency",
       (SELECT count(*)::integer FROM platform.idempotency_keys
        WHERE property_id = $1::uuid AND operation = 'pms.inventory.release') AS "releaseIdempotency",
       (SELECT count(*)::integer FROM platform.domain_events
        WHERE property_id = $1::uuid AND resource_type = 'inventory_reservation') AS events,
       (SELECT count(*)::integer FROM platform.outbox_events
        WHERE property_id = $1::uuid AND destination = 'distribution.inventory-projection'
          AND resource_type = 'inventory_reservation') AS outbox,
       (SELECT count(*)::integer FROM pms.inventory_reservation_receipts
        WHERE property_id = $1::uuid) AS receipts`,
    [propertyId],
  );
  if (!result.rows[0]) throw new Error("Missing reservation side-effect counts");
  return result.rows[0];
}

async function projectionPayloads(admin: pg.Client, propertyId: string): Promise<string[]> {
  const result = await admin.query<{ payload: string }>(
    `SELECT payload::text AS payload
     FROM platform.domain_events
     WHERE property_id = $1::uuid AND resource_type = 'inventory_reservation'
     UNION ALL
     SELECT payload::text AS payload
     FROM platform.outbox_events
     WHERE property_id = $1::uuid AND resource_type = 'inventory_reservation'
     ORDER BY payload`,
    [propertyId],
  );
  return result.rows.map(({ payload }) => payload);
}

async function seedInProgress(
  admin: pg.Client,
  propertyId: string,
  operation: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, first_seen_at, last_seen_at, expires_at
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', $4::uuid,
       $5::timestamptz, $5::timestamptz, 'infinity'::timestamptz
     )`,
    [operation, hash(idempotencyKey), hash(fingerprint), propertyId, ACCEPTED_AT.toISOString()],
  );
}

function nextDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const databaseName = url.pathname.slice(1);
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
