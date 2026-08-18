import { createHash } from "node:crypto";

import {
  PMS_MANUAL_BOOKING_DIRECT_SOURCES,
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import { createBookingPmsManualAttributionOwner } from "./bookingPmsManualAttribution.js";
import { createBookingPmsManualNightlyRevenueEvidenceOwner } from "./bookingPmsManualNightlyRevenueEvidence.js";
import { createPgPmsManualBookingPlatformOwnerPort } from "./pmsManualBookingCommandEvidence.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import {
  createTargetPmsOperationsReadRepository,
  type PmsOperationsReadRepository,
} from "./pmsOperationsReadModel.js";
import type {
  PmsManualPriceCorrectionCommand,
  PmsManualStayCorrectionCommand,
} from "../routes/pmsOperations.js";
import {
  createPgPmsManualBookingBookingOwnerPort,
  createPgPmsManualBookingOperationsOwnerPort,
} from "./pmsManualBookingPersistence.js";
import type {
  PmsManualBookingTransactionDependencies,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";
import { createPmsRoomAssignmentOptimizationTriggerPort } from "./pmsRoomAssignmentOptimizationTriggers.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `82000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const organizationId = uuid(1),
  actorId = uuid(2),
  propertyId = uuid(3);
const otherPropertyId = uuid(4),
  roomTypeId = uuid(5),
  roomIds = [uuid(6), uuid(7), uuid(9)];
const addonId = uuid(8);
const acceptedAt = new Date("2026-08-12T22:30:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("target manual-booking PostgreSQL transaction", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const optimizationCalls: Array<{ reason: string; roomTypeIds: readonly string[] }> = [];
  let optimizationFailure = false;
  const repository = createPgPmsManualBookingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    now: () => acceptedAt,
    dependencies: dependencies(),
  });
  const operations = createTargetPmsOperationsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    now: () => acceptedAt,
    readRepository: {
      async findReservationByGuestBookingId(_propertyId: string, requestedGuestBookingId: string) {
        return { guestBookingId: requestedGuestBookingId } as never;
      },
    } as unknown as PmsOperationsReadRepository,
    roomAssignmentOptimization: {
      afterCreate: async () => [],
      afterChange: async ({ reason, roomTypeIds }) => {
        optimizationCalls.push({ reason, roomTypeIds });
        if (optimizationFailure) throw new Error("forced optimization failure");
        return [];
      },
    },
  });
  const readRepository = createTargetPmsOperationsReadRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    pool: admin,
  });

  beforeAll(async () => {
    const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
    if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) throw new Error("Unsafe test database");
    await cleanup(true);
    await admin.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1::uuid, 'vay-1254@example.test', 'active')`,
      [actorId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1254', 'vay-1254', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES
       ($1::uuid, 'vay-1254', 'VAY-1254'),
       ($2::uuid, 'vay-1254-other', 'VAY-1254 other')`,
      [propertyId, otherPropertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Athens')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, occupancy_limits, base_rate_amount, currency
       ) VALUES ($1::uuid, $2::uuid, 'Studio', '{"adults":4,"children":4,"total":4}', 100, 'EUR')`,
      [roomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number,operational_label_status)
       VALUES ($1::uuid, $3::uuid, $4::uuid, '101','verified'),
              ($2::uuid, $3::uuid, $4::uuid, '102','verified'),
              ($5::uuid, $3::uuid, $4::uuid, '103','verified')`,
      [roomIds[0], roomIds[1], propertyId, roomTypeId, roomIds[2]],
    );
    await seedInventory();
    await admin.query(
      `INSERT INTO booking.addon_definitions (
         id, property_id, name, pricing_model, price_amount, currency
       ) VALUES ($1::uuid, $2::uuid, 'Breakfast', 'per_guest_night', 5, 'EUR')`,
      [addonId, propertyId],
    );
  });

  beforeEach(async () => {
    optimizationCalls.length = 0;
    optimizationFailure = false;
    await cleanup(false);
  });

  afterAll(async () => {
    await operations.close?.();
    await repository.close();
    await cleanup(true);
    await admin.end();
  });

  it("atomically creates heterogeneous owned facts, outbox evidence, and an exact replay", async () => {
    await admin.query(
      `UPDATE booking.addon_definitions
       SET ownership_kind = 'partner', partner_commission_rate = 12.5
       WHERE id = $1::uuid AND property_id = $2::uuid`,
      [addonId, propertyId],
    );
    const input = command("full", "unpaid", "cash", "2027-01-01", true);
    const created = await repository.createManualBooking(input);
    await expect(repository.createManualBooking(input)).resolves.toEqual({
      ...created,
      outcome: "replayed",
    });

    const stored = await admin.query(
      `SELECT booking.expected_payment_method AS method, booking.payment_status AS payment,
        booking.total_amount::text AS total, booking.balance_amount::text AS balance,
        booking.source_booking_id AS "sourceBookingReference",
        booking.booking_channel AS "bookingChannel",
        booking.direct_booking_source AS "directSource",
        guest.special_requests AS requests, booking.booking_metadata AS metadata,
        (SELECT count(*)::int FROM pms.operational_booking_assignments assignment
          WHERE assignment.guest_booking_id = booking.id) AS stays,
        (SELECT count(*)::int FROM pms.booking_notes_private note
          WHERE note.guest_booking_id = booking.id) AS notes,
        (SELECT count(*)::int FROM booking.booking_addon_selections addon
          WHERE addon.guest_booking_id = booking.id) AS addons
       FROM booking.guest_bookings booking
       JOIN booking.booking_guests guest ON guest.guest_booking_id = booking.id
       WHERE booking.id = $1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toMatchObject({
      method: "cash",
      payment: "unpaid",
      total: "410.00",
      balance: "410.00",
      sourceBookingReference: input.commandId,
      bookingChannel: "direct",
      directSource: "email",
      requests: "Quiet room",
      stays: 2,
      notes: 1,
      addons: 1,
      metadata: {
        contractVersion: "pms-manual-booking.v1",
        commandId: input.commandId,
      },
    });
    const acceptance = await admin.query(
      `SELECT event_type AS "eventType", from_status AS "fromStatus",
         to_status AS "toStatus", actor_type AS "actorType",
         actor_user_id::text AS "actorUserId", public_visible AS "publicVisible",
         public_message AS "publicMessage", event_payload AS payload,
         occurred_at = $2::timestamptz AS "occurredAtMatches"
       FROM booking.booking_status_events
       WHERE guest_booking_id = $1::uuid AND event_type = 'guest_booking.accepted'`,
      [created.guestBookingId, acceptedAt.toISOString()],
    );
    expect(acceptance.rows).toEqual([
      {
        eventType: "guest_booking.accepted",
        fromStatus: null,
        toStatus: "confirmed",
        actorType: "property_user",
        actorUserId: actorId,
        publicVisible: false,
        publicMessage: null,
        payload: { contractVersion: "pms-manual-booking.v1" },
        occurredAtMatches: true,
      },
    ]);
    const financeAttribution = await admin.query(
      `SELECT booking_channel AS channel, direct_booking_source AS source
       FROM booking.finance_booking_attribution WHERE guest_booking_id = $1::uuid`,
      [created.guestBookingId],
    );
    expect(financeAttribution.rows[0]).toEqual({ channel: "direct", source: "email" });
    await admin.query(
      `UPDATE booking.addon_definitions
       SET ownership_kind = 'property', partner_commission_rate = NULL
       WHERE id = $1::uuid AND property_id = $2::uuid`,
      [addonId, propertyId],
    );
    const addonEconomics = await admin.query(
      `SELECT ownership_kind AS ownership,
         partner_commission_rate = 12.5 AS "commissionMatches"
       FROM booking.finance_addon_purchase_evidence
       WHERE guest_booking_id = $1::uuid`,
      [created.guestBookingId],
    );
    expect(addonEconomics.rows).toEqual([{ ownership: "partner", commissionMatches: true }]);
    const nightly = await admin.query(
      `SELECT stay_date::text AS date, line_position AS position,
         gross_room_amount::text AS amount, source_kind AS source,
         evidence_quality AS quality
       FROM booking.nightly_revenue_evidence
       WHERE guest_booking_id = $1::uuid ORDER BY stay_date, line_position`,
      [created.guestBookingId],
    );
    expect(nightly.rows).toEqual([
      { date: "2027-01-01", position: 1, amount: "100.0000", source: "manual", quality: "exact" },
      { date: "2027-01-02", position: 1, amount: "100.0000", source: "manual", quality: "exact" },
      { date: "2027-01-02", position: 2, amount: "100.0000", source: "manual", quality: "exact" },
      { date: "2027-01-03", position: 2, amount: "100.0000", source: "manual", quality: "exact" },
    ]);
    const projection = await readRepository.findReservationByGuestBookingId(
      propertyId,
      created.guestBookingId,
    );
    expect(projection).toMatchObject({
      stay: { checkIn: "2027-01-01", checkOut: "2027-01-04", adults: 3, children: 0 },
      primaryGuest: {
        email: "ada@example.test",
        phone: "+306900000000",
        specialRequests: "Quiet room",
      },
      addOns: [{ addonId, name: "Breakfast", quantity: 1 }],
      payment: { expectedMethod: "cash", status: "unpaid" },
      assignments: [
        {
          position: 1,
          roomId: roomIds[0],
          ratePlanId: null,
          stay: { checkIn: "2027-01-01", checkOut: "2027-01-03", adults: 1, children: 0 },
          nightly: [
            {
              serviceDate: "2027-01-01",
              applied: { amountDecimal: "100.00", currency: "EUR" },
              evidenceQuality: "exact",
            },
            {
              serviceDate: "2027-01-02",
              applied: { amountDecimal: "100.00", currency: "EUR" },
              evidenceQuality: "exact",
            },
          ],
        },
        {
          position: 2,
          roomId: roomIds[1],
          stay: { checkIn: "2027-01-02", checkOut: "2027-01-04", adults: 2, children: 0 },
          nightly: [{ serviceDate: "2027-01-02" }, { serviceDate: "2027-01-03" }],
        },
      ],
    });
    const calendar = await readRepository.listCalendarDaysByPropertyId(propertyId, {
      from: "2027-01-01",
      to: "2027-01-03",
    });
    expect(
      calendar.items.map(({ stayDate, assignmentRefs }) => ({ stayDate, assignmentRefs })),
    ).toEqual([
      { stayDate: "2027-01-01", assignmentRefs: [projection!.assignments[0]!.assignmentId] },
      {
        stayDate: "2027-01-02",
        assignmentRefs: projection!.assignments.map(({ assignmentId }) => assignmentId),
      },
      { stayDate: "2027-01-03", assignmentRefs: [projection!.assignments[1]!.assignmentId] },
    ]);
    await expect(
      readRepository.findReservationByGuestBookingId(otherPropertyId, created.guestBookingId),
    ).resolves.toBeNull();
    const confirmation = await admin.query(
      `SELECT payload FROM platform.outbox_events
       WHERE property_id = $1::uuid
         AND event_type = 'booking.guest_confirmation.requested.v1'`,
      [propertyId],
    );
    expect(confirmation.rows[0]?.payload).toMatchObject({
      guestBookingId: created.guestBookingId,
      bookingReference: created.bookingReference,
      guest: { email: "ada@example.test", specialRequests: "Quiet room" },
      expectedPaymentMethod: "cash",
      paymentStatus: "unpaid",
      stays: expect.arrayContaining([
        expect.objectContaining({
          position: 1,
          roomId: roomIds[0],
          nightly: expect.arrayContaining([expect.objectContaining({ serviceDate: "2027-01-01" })]),
        }),
        expect.objectContaining({
          position: 2,
          roomId: roomIds[1],
          nightly: expect.arrayContaining([expect.objectContaining({ serviceDate: "2027-01-02" })]),
        }),
      ]),
    });
    expect(JSON.stringify(confirmation.rows[0]?.payload)).not.toContain("VIP");
    await expect(counts()).resolves.toMatchObject({
      booking: "1",
      nightly: "4",
      payment: "0",
      outbox: "4",
      audit: "1",
      commands: "1",
    });
  });

  it("atomically clears manual room nights on no-show and replays exactly", async () => {
    const created = await repository.createManualBooking(
      command("no-show", "unpaid", "cash", "2026-08-10", true),
    );
    const noShow = {
      propertyId,
      guestBookingId: created.guestBookingId,
      commandId: "no-show-command",
      idempotencyKey: "no-show-key",
      reason: "guest did not arrive",
      audit: {
        actor: { kind: "user" as const, userId: actorId, organizationId },
        requestId: "no-show-request",
        reason: "Mark manual booking no-show",
        requestedAt: acceptedAt.toISOString(),
      },
    };
    await expect(operations.executeNoShowCommand(noShow)).resolves.toMatchObject({ ok: true });
    await expect(operations.executeNoShowCommand(noShow)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(
      operations.executeNoShowCommand({ ...noShow, reason: "changed" }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const totals = await admin.query(
      `SELECT stay_date::text AS date,line_position AS position,
         SUM(occupied_room_nights)::int AS occupied,SUM(gross_room_amount)::text AS amount,
         MAX(recognized_on) FILTER (WHERE economic_event='occupancy_adjustment')::text AS "recognizedOn"
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid
       GROUP BY stay_date,line_position ORDER BY stay_date,line_position`,
      [created.guestBookingId],
    );
    expect(totals.rows).toHaveLength(4);
    expect(totals.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ occupied: 0, amount: "0.0000" })]),
    );
    expect(
      totals.rows.every(
        ({ occupied, amount, recognizedOn }) =>
          occupied === 0 && amount === "0.0000" && recognizedOn === "2026-08-13",
      ),
    ).toBe(true);
    const assignments = await admin.query(
      `SELECT DISTINCT assignment_status AS status,room_id AS room
       FROM pms.operational_booking_assignments WHERE guest_booking_id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(assignments.rows).toEqual([{ status: "released", room: null }]);
    expect((await counts()).nightly).toBe("8");
  });

  it("rolls assignment release back when no-show evidence is unavailable", async () => {
    const created = await repository.createManualBooking(
      command("no-show-rollback", "unpaid", "cash", "2027-01-20", false),
    );
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET timezone=NULL WHERE property_id=$1::uuid",
      [propertyId],
    );
    try {
      await expect(
        operations.executeNoShowCommand({
          propertyId,
          guestBookingId: created.guestBookingId,
          commandId: "no-show-failing-command",
          idempotencyKey: "no-show-failing-key",
          audit: {
            actor: { kind: "user", userId: actorId, organizationId },
            requestId: "no-show-failing-request",
            reason: "Mark manual booking no-show",
            requestedAt: acceptedAt.toISOString(),
          },
        }),
      ).rejects.toThrow("canonical property timezone");
    } finally {
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET timezone='Europe/Athens' WHERE property_id=$1::uuid",
        [propertyId],
      );
    }
    const state = await admin.query(
      `SELECT DISTINCT assignment_status AS status,count(*)::int AS count
       FROM pms.operational_booking_assignments WHERE guest_booking_id=$1::uuid
       GROUP BY assignment_status`,
      [created.guestBookingId],
    );
    expect(state.rows).toEqual([{ status: "assigned", count: 1 }]);
    expect((await counts()).nightly).toBe("2");
  });

  it("atomically corrects heterogeneous stay dates, room assignment, and current revenue tips", async () => {
    const created = await repository.createManualBooking(
      command("stay-correction", "unpaid", "cash", "2026-08-20", true),
    );
    const correction = await stayCorrection(created.guestBookingId, "stay-correction", [
      { roomId: roomIds[1]!, checkIn: "2026-08-21" },
      { roomId: roomIds[1]!, checkIn: "2026-08-23" },
    ]);
    correction.stays[1]!.nightly[0]!.evidenceQuality = "inferred";
    const corrected = await operations.correctManualBookingStays!(correction);
    if (!corrected.ok) throw new Error(corrected.message);
    expect(corrected).toMatchObject({
      ok: true,
      commandMeta: { sideEffects: ["calendar_refresh", "ari_changed", "audit_event"] },
    });
    expect(optimizationCalls).toEqual([{ reason: "modify", roomTypeIds: [roomTypeId] }]);
    await expect(operations.correctManualBookingStays!(correction)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(
      operations.correctManualBookingStays!({ ...correction, accountingDate: "2026-08-22" }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const stored = await admin.query(
      `SELECT booking.check_in::text AS "checkIn",booking.check_out::text AS "checkOut",
         booking.total_amount::text AS total,
         (SELECT jsonb_agg(jsonb_build_object('position',position,'room',room_id::text,
            'from',check_in::text,'to',check_out::text) ORDER BY position)
          FROM pms.operational_booking_assignments WHERE guest_booking_id=booking.id) AS stays,
         (SELECT count(*)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS evidence,
         (SELECT sum(occupied_room_nights)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS occupied,
         (SELECT sum(gross_room_amount)::text FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS amount,
         (SELECT count(*)::int FROM platform.outbox_events outbox
          WHERE outbox.resource_id=booking.id::text
            AND outbox.outbox_key LIKE 'booking.manual-stay-correction.%') AS outbox,
         (SELECT jsonb_array_length(private_payload->'stays') FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id AND action='pms.manual_stay_correction') AS audited
       FROM booking.guest_bookings booking WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toEqual({
      checkIn: "2026-08-21",
      checkOut: "2026-08-25",
      total: "410.00",
      stays: [
        { position: 1, room: roomIds[1], from: "2026-08-21", to: "2026-08-23" },
        { position: 2, room: roomIds[1], from: "2026-08-23", to: "2026-08-25" },
      ],
      evidence: 10,
      occupied: 4,
      amount: "400.0000",
      outbox: 2,
      audited: 2,
    });
    const projection = await readRepository.findReservationByGuestBookingId(
      propertyId,
      created.guestBookingId,
    );
    expect(
      projection!.assignments.map(({ nightly }) =>
        nightly!.map(({ serviceDate, applied, evidenceQuality }) => ({
          serviceDate,
          amount: applied?.amountDecimal,
          evidenceQuality,
        })),
      ),
    ).toEqual([
      [
        { serviceDate: "2026-08-21", amount: "100.00", evidenceQuality: "exact" },
        { serviceDate: "2026-08-22", amount: "100.00", evidenceQuality: "exact" },
      ],
      [
        { serviceDate: "2026-08-23", amount: "100.00", evidenceQuality: "inferred" },
        { serviceDate: "2026-08-24", amount: "100.00", evidenceQuality: "exact" },
      ],
    ]);
  });

  it("rolls assignment and Booking changes back when explicit nightly economics do not balance", async () => {
    const created = await repository.createManualBooking(
      command("stay-correction-rollback", "unpaid", "cash", "2026-08-20", false),
    );
    const correction = await stayCorrection(
      created.guestBookingId,
      "stay-correction-rollback",
      [{ roomId: roomIds[1]!, checkIn: "2026-08-21" }],
      [["90.00", "100.00"]],
    );
    await expect(operations.correctManualBookingStays!(correction)).resolves.toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    const stored = await admin.query(
      `SELECT booking.check_in::text AS "checkIn",booking.check_out::text AS "checkOut",
         assignment.room_id::text AS room,assignment.check_in::text AS "assignmentCheckIn",
         (SELECT count(*)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS evidence,
         (SELECT count(*)::int FROM platform.idempotency_keys key
          WHERE key.property_id=booking.property_id
            AND operation='manual_stay_correction_command') AS keys
       FROM booking.guest_bookings booking JOIN pms.operational_booking_assignments assignment
         ON assignment.guest_booking_id=booking.id WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toEqual({
      checkIn: "2026-08-20",
      checkOut: "2026-08-22",
      room: roomIds[0],
      assignmentCheckIn: "2026-08-20",
      evidence: 2,
      keys: 0,
    });
  });

  it("fails closed when canonical inventory closes a corrected night", async () => {
    const created = await repository.createManualBooking(
      command("stay-correction-closed", "unpaid", "cash", "2026-08-20", false),
    );
    await fixtureQuery(
      `UPDATE pms.inventory_days SET status='closed',available_count=0
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date='2026-08-27'::date`,
      [propertyId, roomTypeId],
    );
    const correction = await stayCorrection(created.guestBookingId, "stay-correction-closed", [
      { roomId: roomIds[1]!, checkIn: "2026-08-27" },
    ]);
    await expect(operations.correctManualBookingStays!(correction)).resolves.toMatchObject({
      ok: false,
      code: "room_unavailable",
    });
  });

  it("serializes simultaneous corrections selecting the same physical room", async () => {
    const first = await repository.createManualBooking(
      command("stay-correction-race-a", "unpaid", "cash", "2026-08-20", false),
    );
    const second = await repository.createManualBooking(
      command("stay-correction-race-b", "unpaid", "cash", "2026-08-23", false),
    );
    const [firstCommand, secondCommand] = await Promise.all([
      stayCorrection(first.guestBookingId, "stay-correction-race-a", [
        { roomId: roomIds[2]!, checkIn: "2026-08-26" },
      ]),
      stayCorrection(second.guestBookingId, "stay-correction-race-b", [
        { roomId: roomIds[2]!, checkIn: "2026-08-26" },
      ]),
    ]);
    const results = await Promise.all([
      operations.correctManualBookingStays!(firstCommand),
      operations.correctManualBookingStays!(secondCommand),
    ]);
    expect(
      results.map((result) => (result.ok ? "ok" : `${result.code}:${result.message}`)).sort(),
    ).toEqual(["ok", "room_unavailable:A selected room is unavailable for the corrected stay"]);
    const evidence = await admin.query<{ count: number }>(
      `SELECT count(*)::int count FROM booking.nightly_revenue_evidence
       WHERE guest_booking_id=ANY($1::uuid[]) GROUP BY guest_booking_id ORDER BY count`,
      [[first.guestBookingId, second.guestBookingId]],
    );
    expect(evidence.rows.map(({ count }) => count)).toEqual([2, 6]);
  });

  it("atomically appends exact and explicitly inferred price replacements", async () => {
    const created = await repository.createManualBooking(
      command("price-correction", "unpaid", "cash", "2026-08-20", true),
    );
    const targets = await admin.query<{ id: string }>(
      `SELECT id::text FROM booking.nightly_revenue_evidence
       WHERE guest_booking_id=$1::uuid ORDER BY stay_date,line_position,id`,
      [created.guestBookingId],
    );
    const exact = priceCorrection(created.guestBookingId, "exact", {
      kind: "exact",
      nights: [
        {
          targetEvidenceId: targets.rows[0]!.id,
          replacementAmount: { amountDecimal: "120.00", currency: "EUR" },
        },
        {
          targetEvidenceId: targets.rows[1]!.id,
          replacementAmount: { amountDecimal: "80.00", currency: "EUR" },
        },
      ],
    });
    await expect(operations.correctManualBookingPrices!(exact)).resolves.toMatchObject({
      ok: true,
      commandMeta: { sideEffects: ["audit_event"] },
    });
    const inferred = priceCorrection(created.guestBookingId, "inferred", {
      kind: "equal_inferred",
      targetEvidenceIds: [targets.rows[2]!.id, targets.rows[3]!.id],
      replacementTotal: { amountDecimal: "201.0001", currency: "EUR" },
    });
    await expect(operations.correctManualBookingPrices!(inferred)).resolves.toMatchObject({
      ok: true,
    });
    await expect(operations.correctManualBookingPrices!(exact)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(
      operations.correctManualBookingPrices!({ ...exact, reason: "changed" }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const stored = await admin.query(
      `SELECT
        (SELECT sum(gross_room_amount)::text FROM booking.nightly_revenue_evidence
         WHERE guest_booking_id=$1::uuid) AS amount,
        (SELECT sum(occupied_room_nights)::int FROM booking.nightly_revenue_evidence
         WHERE guest_booking_id=$1::uuid) AS occupied,
        (SELECT jsonb_agg(jsonb_build_object('amount',gross_room_amount::text,
          'quality',evidence_quality,'recognized',recognized_on::text) ORDER BY source_revision,
          stay_date,line_position) FROM booking.nightly_revenue_evidence
         WHERE guest_booking_id=$1::uuid AND economic_event='correction') AS corrections,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid
          AND operation='manual_price_correction_command') AS keys,
        (SELECT jsonb_agg(private_payload ORDER BY occurred_at,audit_key)
         FROM platform.product_audit_events WHERE property_id=$2::uuid
          AND action='pms.manual_price_correction') AS audits`,
      [created.guestBookingId, propertyId],
    );
    expect(stored.rows[0]).toMatchObject({
      amount: "401.0001",
      occupied: 4,
      corrections: [
        { amount: "20.0000", quality: "exact", recognized: "2026-08-25" },
        { amount: "-20.0000", quality: "exact", recognized: "2026-08-25" },
        { amount: "0.5001", quality: "inferred", recognized: "2026-08-25" },
        { amount: "0.5000", quality: "inferred", recognized: "2026-08-25" },
      ],
      keys: 2,
      audits: [
        { accountingDate: "2026-08-25", reason: "correct nightly prices" },
        { accountingDate: "2026-08-25", reason: "correct nightly prices" },
      ],
    });
    const projection = await readRepository.findReservationByGuestBookingId(
      propertyId,
      created.guestBookingId,
    );
    expect(
      projection!.assignments.flatMap(({ nightly }) =>
        nightly!.map(({ applied, evidenceQuality }) => ({
          amount: applied?.amountDecimal,
          evidenceQuality,
        })),
      ),
    ).toEqual([
      { amount: "120.00", evidenceQuality: "exact" },
      { amount: "80.00", evidenceQuality: "exact" },
      { amount: "100.50", evidenceQuality: "inferred" },
      { amount: "100.50", evidenceQuality: "inferred" },
    ]);
  });

  it("serializes competing price corrections against one current tip", async () => {
    const created = await repository.createManualBooking(
      command("price-correction-race", "unpaid", "cash", "2026-08-20", false),
    );
    const target = await admin.query<{ id: string }>(
      "SELECT id::text FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid ORDER BY stay_date LIMIT 1",
      [created.guestBookingId],
    );
    const correction = (suffix: string, amountDecimal: string) =>
      priceCorrection(created.guestBookingId, suffix, {
        kind: "exact",
        nights: [
          {
            targetEvidenceId: target.rows[0]!.id,
            replacementAmount: { amountDecimal, currency: "EUR" },
          },
        ],
      });
    const results = await Promise.all([
      operations.correctManualBookingPrices!(correction("race-a", "110.00")),
      operations.correctManualBookingPrices!(correction("race-b", "120.00")),
    ]);
    expect(results.map((result) => (result.ok ? "ok" : result.code)).sort()).toEqual([
      "invalid_body",
      "ok",
    ]);
    const stored = await admin.query<{ corrections: number; keys: number }>(
      `SELECT count(*) FILTER (WHERE economic_event='correction')::int corrections,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid
          AND operation='manual_price_correction_command') keys
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid`,
      [created.guestBookingId, propertyId],
    );
    expect(stored.rows[0]).toEqual({ corrections: 1, keys: 1 });
  });

  it("rolls price evidence and idempotency back when the late audit write fails", async () => {
    const created = await repository.createManualBooking(
      command("price-correction-rollback", "unpaid", "cash", "2026-08-20", false),
    );
    const target = await admin.query<{ id: string }>(
      "SELECT id::text FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid ORDER BY stay_date LIMIT 1",
      [created.guestBookingId],
    );
    const correction = priceCorrection(created.guestBookingId, "rollback", {
      kind: "exact",
      nights: [
        {
          targetEvidenceId: target.rows[0]!.id,
          replacementAmount: { amountDecimal: "110.00", currency: "EUR" },
        },
      ],
    });
    correction.audit.actor = { kind: "user", userId: uuid(999), organizationId };
    await expect(operations.correctManualBookingPrices!(correction)).rejects.toMatchObject({
      code: "23503",
    });
    const stored = await admin.query<{ evidence: number; keys: number; audits: number }>(
      `SELECT count(*)::int evidence,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid
          AND operation='manual_price_correction_command') keys,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$2::uuid
          AND action='pms.manual_price_correction') audits
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid`,
      [created.guestBookingId, propertyId],
    );
    expect(stored.rows[0]).toEqual({ evidence: 2, keys: 0, audits: 0 });
  });

  it.each([
    ["partial", ["25.00"]],
    ["full", ["100.00", "100.00"]],
  ])("rejects price correction after a %s refund", async (kind, amounts) => {
    const created = await repository.createManualBooking(
      command(`price-after-${kind}-refund`, "paid", "cash", "2026-08-20", false),
    );
    const evidence = await admin.query<{ payment: string; id: string }>(
      `SELECT payment.id::text AS payment,evidence.id::text
       FROM finance.payments payment JOIN booking.nightly_revenue_evidence evidence
         ON evidence.guest_booking_id=payment.guest_booking_id
       WHERE payment.guest_booking_id=$1::uuid AND payment.payment_kind='manual'
       ORDER BY evidence.stay_date,evidence.line_position`,
      [created.guestBookingId],
    );
    const refund = {
      propertyId,
      guestBookingId: created.guestBookingId,
      commandId: `refund-before-price-${kind}`,
      idempotencyKey: `refund-before-price-${kind}`,
      paymentEvidenceId: evidence.rows[0]!.payment,
      accountingDate: "2026-08-21",
      allocations: amounts.map((amountDecimal, index) => ({
        evidenceId: evidence.rows[index]!.id,
        amount: { amountDecimal, currency: "EUR" },
      })),
      audit: {
        actor: { kind: "user" as const, userId: actorId, organizationId },
        requestId: `refund-before-price-${kind}`,
        reason: "Refund manual booking",
        requestedAt: acceptedAt.toISOString(),
      },
    };
    await expect(operations.refundManualBooking!(refund)).resolves.toMatchObject({ ok: true });
    const refundTarget = await admin.query<{ id: string }>(
      `SELECT id::text FROM booking.nightly_revenue_evidence
       WHERE guest_booking_id=$1::uuid AND economic_event='refund' ORDER BY id LIMIT 1`,
      [created.guestBookingId],
    );
    await expect(
      operations.correctManualBookingPrices!(
        priceCorrection(created.guestBookingId, `after-${kind}-refund`, {
          kind: "exact",
          nights: [
            {
              targetEvidenceId: refundTarget.rows[0]!.id,
              replacementAmount: { amountDecimal: "100.00", currency: "EUR" },
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_body" });
    const stored = await admin.query<{ corrections: number; keys: number }>(
      `SELECT count(*) FILTER (WHERE economic_event='correction')::int corrections,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid
          AND operation='manual_price_correction_command') keys
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid`,
      [created.guestBookingId, propertyId],
    );
    expect(stored.rows[0]).toEqual({ corrections: 0, keys: 0 });
  });

  it("serializes price correction behind a concurrent refund", async () => {
    const created = await repository.createManualBooking(
      command("price-refund-race", "paid", "cash", "2026-08-20", false),
    );
    const evidence = await admin.query<{ payment: string; id: string }>(
      `SELECT payment.id::text AS payment,evidence.id::text
       FROM finance.payments payment JOIN booking.nightly_revenue_evidence evidence
         ON evidence.guest_booking_id=payment.guest_booking_id
       WHERE payment.guest_booking_id=$1::uuid AND payment.payment_kind='manual'
       ORDER BY evidence.stay_date LIMIT 1`,
      [created.guestBookingId],
    );
    const gate = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await gate.connect();
    await gate.query("SELECT pg_advisory_lock(1272)");
    await admin.query(`
      CREATE FUNCTION booking.test_pause_manual_refund() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.economic_event='refund' THEN PERFORM pg_advisory_xact_lock(1272); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_test_pause_manual_refund BEFORE INSERT ON booking.nightly_revenue_evidence
      FOR EACH ROW EXECUTE FUNCTION booking.test_pause_manual_refund();
    `);
    try {
      const refund = operations.refundManualBooking!({
        propertyId,
        guestBookingId: created.guestBookingId,
        commandId: "refund-price-race",
        idempotencyKey: "refund-price-race",
        paymentEvidenceId: evidence.rows[0]!.payment,
        accountingDate: "2026-08-21",
        allocations: [
          {
            evidenceId: evidence.rows[0]!.id,
            amount: { amountDecimal: "25.00", currency: "EUR" },
          },
        ],
        audit: {
          actor: { kind: "user", userId: actorId, organizationId },
          requestId: "refund-price-race",
          reason: "Refund manual booking",
          requestedAt: acceptedAt.toISOString(),
        },
      });
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) value FROM pg_stat_activity WHERE wait_event='advisory'",
              )
            ).rows[0].value,
          ),
        )
        .toBeGreaterThan(0);
      const correction = operations.correctManualBookingPrices!(
        priceCorrection(created.guestBookingId, "refund-race", {
          kind: "exact",
          nights: [
            {
              targetEvidenceId: evidence.rows[0]!.id,
              replacementAmount: { amountDecimal: "110.00", currency: "EUR" },
            },
          ],
        }),
      );
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) value FROM pg_stat_activity WHERE wait_event='transactionid'",
              )
            ).rows[0].value,
          ),
        )
        .toBeGreaterThan(0);
      await gate.query("SELECT pg_advisory_unlock(1272)");
      await expect(refund).resolves.toMatchObject({ ok: true });
      await expect(correction).resolves.toMatchObject({ ok: false, code: "invalid_body" });
      const stored = await admin.query<{ corrections: number; keys: number }>(
        `SELECT count(*) FILTER (WHERE economic_event='correction')::int corrections,
          (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid
            AND operation='manual_price_correction_command') keys
         FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid`,
        [created.guestBookingId, propertyId],
      );
      expect(stored.rows[0]).toEqual({ corrections: 0, keys: 0 });
    } finally {
      await gate.query("SELECT pg_advisory_unlock(1272)");
      await gate.end();
      await admin.query(`
        DROP TRIGGER IF EXISTS trg_test_pause_manual_refund ON booking.nightly_revenue_evidence;
        DROP FUNCTION IF EXISTS booking.test_pause_manual_refund();
      `);
    }
  });

  it("atomically cancels a manual booking with explicit retained-charge evidence", async () => {
    const created = await repository.createManualBooking(
      command("cancel", "unpaid", "cash", "2026-08-20", false),
    );
    const cancellation = {
      propertyId,
      guestBookingId: created.guestBookingId,
      commandId: "cancel-command",
      idempotencyKey: "cancel-key",
      reason: "property cancellation",
      accountingDate: "2026-08-21",
      retainedCharges: [
        {
          linePosition: 1,
          stayDate: "2026-08-20",
          amount: { amountDecimal: "25.00", currency: "EUR" },
        },
      ],
      audit: {
        actor: { kind: "user" as const, userId: actorId, organizationId },
        requestId: "cancel-request",
        reason: "Cancel manual booking",
        requestedAt: acceptedAt.toISOString(),
      },
    };
    await expect(
      operations.cancelManualBooking!({
        ...cancellation,
        commandId: "cancel-duplicate-command",
        idempotencyKey: "cancel-duplicate-key",
        retainedCharges: [cancellation.retainedCharges[0]!, cancellation.retainedCharges[0]!],
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_body" });
    await expect(operations.cancelManualBooking!(cancellation)).resolves.toMatchObject({
      ok: true,
      commandMeta: { sideEffects: ["calendar_refresh", "ari_changed", "audit_event"] },
    });
    expect(optimizationCalls).toEqual([{ reason: "cancel", roomTypeIds: [roomTypeId] }]);
    await expect(operations.cancelManualBooking!(cancellation)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(
      operations.cancelManualBooking!({ ...cancellation, reason: "changed" }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const stored = await admin.query(
      `SELECT booking.lifecycle_status AS status,assignment.assignment_status AS assignment,
         assignment.room_id AS room,booking.cancellation_reason AS reason,
         (SELECT count(*)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS evidence_count,
         (SELECT SUM(occupied_room_nights)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS occupied,
         (SELECT SUM(gross_room_amount)::text FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id) AS amount,
         (SELECT MAX(recognized_on)::text FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id AND economic_event='retained_charge') AS recognized,
         (SELECT MAX(source_revision)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id AND economic_event='occupancy_adjustment') AS occupancy_revision,
         (SELECT MAX(source_revision)::int FROM booking.nightly_revenue_evidence evidence
          WHERE evidence.guest_booking_id=booking.id AND economic_event='retained_charge') AS retained_revision,
         (SELECT count(*)::int FROM platform.outbox_events outbox
          WHERE outbox.resource_id=booking.id::text AND outbox.outbox_key LIKE 'booking.manual-cancellation.%') AS outbox,
         (SELECT source_system FROM platform.domain_events event
          WHERE event.resource_id=booking.id::text AND event.event_type='booking.manual_booking.canceled.v1') AS event_source,
         (SELECT event_payload ? 'reason' FROM booking.booking_status_events event
          WHERE event.guest_booking_id=booking.id AND event.event_type='guest_booking.canceled') AS leaks_reason,
         (SELECT private_payload->>'reason' FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id AND action='pms.manual_cancellation') AS audit_reason
       FROM booking.guest_bookings booking JOIN pms.operational_booking_assignments assignment
         ON assignment.guest_booking_id=booking.id WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toEqual({
      status: "canceled",
      assignment: "canceled",
      room: null,
      reason: "property_cancellation",
      evidence_count: 5,
      occupied: 0,
      amount: "25.0000",
      recognized: "2026-08-21",
      occupancy_revision: 2,
      retained_revision: 3,
      outbox: 2,
      event_source: "booking",
      leaks_reason: false,
      audit_reason: "property cancellation",
    });
  });

  it("rolls cancellation, room release, audit, and idempotency back on evidence failure", async () => {
    const created = await repository.createManualBooking(
      command("cancel-rollback", "unpaid", "cash", "2026-08-12", false),
    );
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET timezone=NULL WHERE property_id=$1::uuid",
      [propertyId],
    );
    try {
      await expect(
        operations.cancelManualBooking!({
          propertyId,
          guestBookingId: created.guestBookingId,
          commandId: "cancel-rollback-command",
          idempotencyKey: "cancel-rollback-key",
          accountingDate: null,
          retainedCharges: [],
          audit: {
            actor: { kind: "user", userId: actorId, organizationId },
            requestId: "cancel-rollback-request",
            reason: "Cancel manual booking",
            requestedAt: acceptedAt.toISOString(),
          },
        }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_body" });
    } finally {
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET timezone='Europe/Athens' WHERE property_id=$1::uuid",
        [propertyId],
      );
    }
    const state = await admin.query(
      `SELECT booking.lifecycle_status AS status,assignment.assignment_status AS assignment,
         (SELECT count(*)::int FROM platform.idempotency_keys key
          WHERE key.property_id=booking.property_id AND operation='manual_cancellation_command') AS keys,
         (SELECT count(*)::int FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id AND action='pms.manual_cancellation') AS audits,
         (SELECT count(*)::int FROM platform.domain_events event
          WHERE event.property_id=booking.property_id AND event.event_type='booking.manual_booking.canceled.v1') AS events,
         (SELECT count(*)::int FROM platform.outbox_events outbox
          WHERE outbox.property_id=booking.property_id AND outbox.outbox_key LIKE 'booking.manual-cancellation.%') AS outbox
       FROM booking.guest_bookings booking JOIN pms.operational_booking_assignments assignment
         ON assignment.guest_booking_id=booking.id WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(state.rows[0]).toEqual({
      status: "confirmed",
      assignment: "assigned",
      keys: 0,
      audits: 0,
      events: 0,
      outbox: 0,
    });
  });

  it("rolls cancellation back when room optimization fails", async () => {
    const created = await repository.createManualBooking(
      command("cancel-optimization-rollback", "unpaid", "cash", "2026-08-20", false),
    );
    optimizationFailure = true;
    await expect(
      operations.cancelManualBooking!({
        propertyId,
        guestBookingId: created.guestBookingId,
        commandId: "cancel-optimization-rollback-command",
        idempotencyKey: "cancel-optimization-rollback-key",
        accountingDate: null,
        retainedCharges: [],
        audit: {
          actor: { kind: "user", userId: actorId, organizationId },
          requestId: "cancel-optimization-rollback-request",
          reason: "Cancel manual booking",
          requestedAt: acceptedAt.toISOString(),
        },
      }),
    ).rejects.toThrow("forced optimization failure");
    const state = await admin.query(
      `SELECT booking.lifecycle_status AS status,assignment.assignment_status AS assignment
       FROM booking.guest_bookings booking JOIN pms.operational_booking_assignments assignment
         ON assignment.guest_booking_id=booking.id WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(state.rows).toEqual([{ status: "confirmed", assignment: "assigned" }]);
  });

  it("atomically records an exact partial manual refund and replays it", async () => {
    const created = await repository.createManualBooking(
      command("refund", "paid", "cash", "2026-08-20", false),
    );
    const evidence = await admin.query(
      `SELECT payment.id::text AS payment,
         (SELECT id::text FROM booking.nightly_revenue_evidence
          WHERE guest_booking_id=booking.id ORDER BY stay_date,line_position LIMIT 1) AS target
       FROM booking.guest_bookings booking JOIN finance.payments payment
         ON payment.guest_booking_id=booking.id AND payment.payment_kind='manual'
       WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    const refund = {
      propertyId,
      guestBookingId: created.guestBookingId,
      commandId: "refund-command",
      idempotencyKey: "refund-key",
      paymentEvidenceId: evidence.rows[0].payment as string,
      accountingDate: "2026-08-21",
      reason: "partial guest refund",
      allocations: [
        {
          evidenceId: evidence.rows[0].target as string,
          amount: { amountDecimal: "25.00", currency: "EUR" },
        },
      ],
      audit: {
        actor: { kind: "user" as const, userId: actorId, organizationId },
        requestId: "refund-request",
        reason: "Refund manual booking",
        requestedAt: acceptedAt.toISOString(),
      },
    };
    await expect(
      operations.refundManualBooking!({
        ...refund,
        commandId: "over-refund-command",
        idempotencyKey: "over-refund-key",
        allocations: [
          { ...refund.allocations[0]!, amount: { amountDecimal: "101.00", currency: "EUR" } },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_body" });
    await expect(operations.refundManualBooking!(refund)).resolves.toMatchObject({ ok: true });
    await expect(operations.refundManualBooking!(refund)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(
      operations.refundManualBooking!({
        ...refund,
        commandId: "stale-refund-command",
        idempotencyKey: "stale-refund-key",
        allocations: [
          { ...refund.allocations[0]!, amount: { amountDecimal: "1.00", currency: "EUR" } },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_body" });
    await expect(
      operations.refundManualBooking!({ ...refund, reason: "changed" }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const stored = await admin.query(
      `SELECT payment.status,payment.refunded_amount::text AS refunded,
         payment.net_amount::text AS net,booking.payment_status AS booking_payment,
         (SELECT count(*)::int FROM booking.nightly_revenue_evidence item
          WHERE item.guest_booking_id=booking.id AND economic_event='refund') AS refunds,
         (SELECT gross_room_amount::text FROM booking.nightly_revenue_evidence item
          WHERE item.guest_booking_id=booking.id AND economic_event='refund') AS refund_amount,
         (SELECT recognized_on::text FROM booking.nightly_revenue_evidence item
          WHERE item.guest_booking_id=booking.id AND economic_event='refund') AS recognized,
         (SELECT private_payload FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id AND action='pms.manual_refund') AS audit,
         (SELECT count(*)::int FROM platform.idempotency_keys key
          WHERE key.property_id=booking.property_id AND operation='manual_refund_command') AS keys
        ,(SELECT jsonb_build_object('amount',refund.amount::text,'net',refund.net_amount::text,
            'refunded',refund.refunded_amount::text,'metadata',refund.payment_metadata)
          FROM finance.payments refund WHERE refund.guest_booking_id=booking.id
            AND refund.payment_kind='refund') AS refund_fact
        ,(SELECT jsonb_build_object('retention',audit.retention_class,'privacy',audit.privacy_scope,
            'target',audit.target_resource_id)
          FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id
            AND action='finance.manual_booking_refund') AS finance_audit
       FROM booking.guest_bookings booking JOIN finance.payments payment
         ON payment.guest_booking_id=booking.id AND payment.payment_kind='manual'
       WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "partially_refunded",
      refunded: "25.00",
      net: "200.00",
      booking_payment: "paid",
      refunds: 1,
      refund_amount: "-25.0000",
      recognized: "2026-08-21",
      keys: 1,
      refund_fact: {
        amount: "25.00",
        net: "-25.00",
        refunded: "25.00",
        metadata: {
          contractVersion: "finance-manual-booking-refund.v1",
          correctsPaymentEvidenceId: evidence.rows[0].payment,
          commandId: "refund-command",
          accountingDate: "2026-08-21",
        },
      },
      finance_audit: {
        retention: "financial",
        privacy: "confidential",
        target: evidence.rows[0].payment,
      },
      audit: {
        reason: "partial guest refund",
        paymentEvidenceId: evidence.rows[0].payment,
        accountingDate: "2026-08-21",
      },
    });
    await expect(
      readRepository.findReservationByGuestBookingId(propertyId, created.guestBookingId),
    ).resolves.toMatchObject({
      assignments: [
        {
          nightly: [
            { applied: { amountDecimal: "100.00" }, evidenceQuality: "exact" },
            { applied: { amountDecimal: "100.00" }, evidenceQuality: "exact" },
          ],
        },
      ],
    });
  });

  it("refunds the current retained-charge tip after a paid cancellation", async () => {
    const created = await repository.createManualBooking(
      command("refund-retained", "paid", "cash", "2026-08-20", false),
    );
    await expect(
      operations.cancelManualBooking!({
        propertyId,
        guestBookingId: created.guestBookingId,
        commandId: "refund-retained-cancel-command",
        idempotencyKey: "refund-retained-cancel-key",
        accountingDate: "2026-08-21",
        retainedCharges: [
          {
            linePosition: 1,
            stayDate: "2026-08-20",
            amount: { amountDecimal: "25.00", currency: "EUR" },
          },
        ],
        audit: {
          actor: { kind: "user", userId: actorId, organizationId },
          requestId: "refund-retained-cancel-request",
          reason: "Cancel manual booking",
          requestedAt: acceptedAt.toISOString(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    const evidence = await admin.query(
      `SELECT payment.id::text AS payment,
         (SELECT id::text FROM booking.nightly_revenue_evidence
          WHERE guest_booking_id=booking.id AND economic_event='retained_charge') AS target
       FROM booking.guest_bookings booking JOIN finance.payments payment
         ON payment.guest_booking_id=booking.id AND payment.payment_kind='manual'
       WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    await expect(
      operations.refundManualBooking!({
        propertyId,
        guestBookingId: created.guestBookingId,
        commandId: "refund-retained-command",
        idempotencyKey: "refund-retained-key",
        paymentEvidenceId: evidence.rows[0].payment,
        accountingDate: "2026-08-22",
        allocations: [
          {
            evidenceId: evidence.rows[0].target,
            amount: { amountDecimal: "25.00", currency: "EUR" },
          },
        ],
        audit: {
          actor: { kind: "user", userId: actorId, organizationId },
          requestId: "refund-retained-request",
          reason: "Refund retained charge",
          requestedAt: acceptedAt.toISOString(),
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    const stored = await admin.query(
      `SELECT payment.status,payment.refunded_amount::text AS refunded,
         SUM(item.gross_room_amount)::text AS amount,SUM(item.occupied_room_nights)::int AS occupied,
         bool_and(item.corrects_evidence_id=$2::uuid) FILTER (WHERE item.economic_event='refund') AS target
       FROM finance.payments payment JOIN booking.nightly_revenue_evidence item
         ON item.guest_booking_id=payment.guest_booking_id
       WHERE payment.guest_booking_id=$1::uuid AND payment.payment_kind='manual'
       GROUP BY payment.id`,
      [created.guestBookingId, evidence.rows[0].target],
    );
    expect(stored.rows[0]).toEqual({
      status: "partially_refunded",
      refunded: "25.00",
      amount: "0.0000",
      occupied: 0,
      target: true,
    });
  });

  it("rolls payment and nightly refund facts back when the audit write fails", async () => {
    const created = await repository.createManualBooking(
      command("refund-rollback", "paid", "cash", "2026-08-20", false),
    );
    const evidence = await admin.query(
      `SELECT payment.id::text AS payment,
         (SELECT id::text FROM booking.nightly_revenue_evidence
          WHERE guest_booking_id=booking.id ORDER BY stay_date LIMIT 1) AS target
       FROM booking.guest_bookings booking JOIN finance.payments payment
         ON payment.guest_booking_id=booking.id AND payment.payment_kind='manual'
       WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    await expect(
      operations.refundManualBooking!({
        propertyId,
        guestBookingId: created.guestBookingId,
        commandId: "refund-rollback-command",
        idempotencyKey: "refund-rollback-key",
        paymentEvidenceId: evidence.rows[0].payment,
        accountingDate: "2026-08-21",
        allocations: [
          {
            evidenceId: evidence.rows[0].target,
            amount: { amountDecimal: "25.00", currency: "EUR" },
          },
        ],
        audit: {
          actor: { kind: "user", userId: uuid(99), organizationId },
          requestId: "refund-rollback-request",
          reason: "Refund manual booking",
          requestedAt: acceptedAt.toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: "23503" });
    const stored = await admin.query(
      `SELECT payment.status,payment.refunded_amount::text AS refunded,
         payment.net_amount::text AS net,booking.payment_status AS booking_payment,
         (SELECT count(*)::int FROM booking.nightly_revenue_evidence item
          WHERE item.guest_booking_id=booking.id) AS evidence,
         (SELECT count(*)::int FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id AND action='pms.manual_refund') AS audits,
         (SELECT count(*)::int FROM platform.idempotency_keys key
          WHERE key.property_id=booking.property_id AND operation='manual_refund_command') AS keys,
         (SELECT count(*)::int FROM finance.payments refund
          WHERE refund.guest_booking_id=booking.id AND refund.payment_kind='refund') AS refund_facts,
         (SELECT count(*)::int FROM platform.product_audit_events audit
          WHERE audit.property_id=booking.property_id
            AND action='finance.manual_booking_refund') AS finance_audits
       FROM booking.guest_bookings booking JOIN finance.payments payment
         ON payment.guest_booking_id=booking.id AND payment.payment_kind='manual'
       WHERE booking.id=$1::uuid`,
      [created.guestBookingId],
    );
    expect(stored.rows[0]).toEqual({
      status: "paid",
      refunded: "0.00",
      net: "200.00",
      booking_payment: "paid",
      evidence: 2,
      audits: 0,
      keys: 0,
      refund_facts: 0,
      finance_audits: 0,
    });
  });

  it("round-trips every expected method for paid and unpaid bookings", async () => {
    const methods = ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const;
    for (const [methodIndex, method] of methods.entries()) {
      for (const [statusIndex, status] of (["unpaid", "paid"] as const).entries()) {
        const day = String(10 + methodIndex * 4 + statusIndex * 2).padStart(2, "0");
        const input = command(`${method}-${status}`, status, method, `2027-02-${day}`, false);
        const created = await repository.createManualBooking(input);
        await expect(repository.createManualBooking(input)).resolves.toEqual({
          ...created,
          outcome: "replayed",
        });
        const row = await admin.query(
          `SELECT expected_payment_method AS method, payment_status AS status,
             balance_amount::text AS balance
           FROM booking.guest_bookings WHERE id = $1::uuid`,
          [created.guestBookingId],
        );
        expect(row.rows[0]).toEqual({
          method,
          status,
          balance: status === "paid" ? "0.00" : "200.00",
        });
        await expect(
          readRepository.findReservationByGuestBookingId(propertyId, created.guestBookingId),
        ).resolves.toMatchObject({ payment: { expectedMethod: method, status } });
      }
    }
    await expect(counts()).resolves.toMatchObject({
      booking: "10",
      payment: "5",
      outbox: "40",
      audit: "10",
      commands: "10",
    });
  });

  it("persists every canonical manual direct source", async () => {
    for (const [index, directSource] of PMS_MANUAL_BOOKING_DIRECT_SOURCES.entries()) {
      const input = command(
        `source-${directSource}`,
        "unpaid",
        "cash",
        `2027-08-${10 + index * 3}`,
        false,
      );
      const created = await repository.createManualBooking({ ...input, directSource });
      const stored = await admin.query(
        `SELECT booking_channel AS channel, direct_booking_source AS source
         FROM booking.guest_bookings WHERE id = $1::uuid`,
        [created.guestBookingId],
      );
      expect(stored.rows[0]).toEqual({ channel: "direct", source: directSource });
    }
  });

  it.each(["booking_engine", "arbitrary_raw_channel"])(
    "rejects injected source %s without partial facts",
    async (directSource) => {
      const input = command(`invalid-${directSource}`, "unpaid", "cash", "2027-09-01", false);
      await expect(
        repository.createManualBooking({
          ...input,
          directSource,
        } as PmsManualBookingCreateCommand),
      ).rejects.toMatchObject({ code: "invalid_source", field: "directSource" });
      await expect(counts()).resolves.toMatchObject({ booking: "0", commands: "0" });
    },
  );

  it("rejects changed replay, command reuse, and cross-property rooms without partial facts", async () => {
    const original = command("conflict", "unpaid", "cash", "2027-03-01", false);
    await repository.createManualBooking(original);
    await expect(
      repository.createManualBooking({
        ...original,
        guest: { ...original.guest, lastName: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      repository.createManualBooking({ ...original, idempotencyKey: "another-key" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      repository.createManualBooking({
        ...command("cross-property", "unpaid", "cash", "2027-03-05", false),
        propertyId: otherPropertyId,
      }),
    ).rejects.toMatchObject({ code: "room_not_found" });
    expect((await counts()).booking).toBe("1");
  });

  it("rolls paid Booking, PMS, evidence, command, and Finance facts back together", async () => {
    const failing = createPgPmsManualBookingCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => acceptedAt,
      dependencies: dependencies({
        financeSettlement: {
          async settleFull() {
            throw new Error("forced Finance failure");
          },
        },
      }),
    });
    await expect(
      failing.createManualBooking(command("paid-rollback", "paid", "cash", "2027-04-01", true)),
    ).rejects.toThrow("forced Finance failure");
    await failing.close();
    await expect(counts()).resolves.toMatchObject({
      booking: "0",
      nightly: "0",
      payment: "0",
      outbox: "0",
      audit: "0",
      commands: "0",
    });
  });

  it("rejects a calculated total that exceeds Booking persistence precision", async () => {
    const basePricing = pricing();
    const oversized = createPgPmsManualBookingCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => acceptedAt,
      dependencies: dependencies({
        pricing: {
          async calculate(input) {
            return {
              ...(await basePricing.calculate(input)),
              grandTotal: { amountDecimal: "10000000000000.00", currency: "EUR" },
            };
          },
        },
      }),
    });
    await expect(
      oversized.createManualBooking(
        command("oversized-total", "unpaid", "cash", "2027-04-10", false),
      ),
    ).rejects.toMatchObject({ code: "invalid_body", field: "grandTotal" });
    await oversized.close();
    await expect(counts()).resolves.toMatchObject({ booking: "0", commands: "0" });
  });

  it("rolls the booking back when exact nightly coverage is incomplete", async () => {
    const basePricing = pricing();
    const incomplete = createPgPmsManualBookingCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => acceptedAt,
      dependencies: dependencies({
        pricing: {
          async calculate(input) {
            const preview = await basePricing.calculate(input);
            return {
              ...preview,
              stays: preview.stays.map((stay) => ({ ...stay, nightly: stay.nightly.slice(0, 1) })),
            };
          },
        },
      }),
    });
    await expect(
      incomplete.createManualBooking(
        command("incomplete-nightly", "unpaid", "cash", "2027-04-20", false),
      ),
    ).rejects.toThrow("Manual booking nightly evidence is incomplete");
    await incomplete.close();
    await expect(counts()).resolves.toMatchObject({ booking: "0", nightly: "0", commands: "0" });
  });

  it("serializes overlapping room commands so exactly one creates evidence", async () => {
    const first = repository.createManualBooking(
      command("race-one", "unpaid", "cash", "2027-05-01", false),
    );
    const second = repository.createManualBooking(
      command("race-two", "unpaid", "cash", "2027-05-01", false),
    );
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "room_unavailable" }),
      }),
    ]);
    expect((await counts()).booking).toBe("1");
  });

  it("turns two simultaneous identical submissions into one create and one replay", async () => {
    const input = command("same-key-race", "unpaid", "cash", "2027-06-01", false);
    const results = await Promise.all([
      repository.createManualBooking(input),
      repository.createManualBooking(input),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["created", "replayed"]);
    expect((await counts()).booking).toBe("1");
  });

  it("rejects self-consistent malformed or cross-command replay evidence", async () => {
    const input = command("bad-replay", "unpaid", "cash", "2027-06-05", false);
    const created = await repository.createManualBooking(input);
    for (const result of [
      { ...created, commandId: "different-command" },
      { ...created, unexpected: true },
      { ...created, guestBookingId: otherPropertyId },
    ]) {
      await admin.query(
        `UPDATE platform.idempotency_keys
         SET idempotency_metadata = jsonb_set(idempotency_metadata, '{result}', $2::jsonb),
           response_body_hash = $3
           , response_resource_id = $4
         WHERE operation = 'pms.manual_booking.create' AND property_id = $1::uuid`,
        [propertyId, JSON.stringify(result), hash(result), result.guestBookingId],
      );
      await expect(repository.createManualBooking(input)).rejects.toThrow(
        "Stored manual booking replay is invalid",
      );
    }
  });

  it("serializes simultaneous command-id reuse across different keys and rooms", async () => {
    const first = command("command-id-race", "unpaid", "cash", "2027-07-01", false);
    const second = {
      ...first,
      idempotencyKey: "different-key-same-command",
      stays: [{ ...first.stays[0]!, roomId: roomIds[1]! }],
    };
    const settled = await Promise.allSettled([
      repository.createManualBooking(first),
      repository.createManualBooking(second),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "idempotency_conflict" }),
      }),
    ]);
    expect((await counts()).booking).toBe("1");
  });

  function dependencies(
    override: Partial<PmsManualBookingTransactionDependencies> = {},
  ): PmsManualBookingTransactionDependencies {
    return {
      booking: createPgPmsManualBookingBookingOwnerPort(),
      operations: createPgPmsManualBookingOperationsOwnerPort(),
      platform: createPgPmsManualBookingPlatformOwnerPort(),
      pricing: pricing(),
      financeSettlement: createFinanceManualBookingSettlementPort(),
      attribution: createBookingPmsManualAttributionOwner(),
      nightlyEvidence: createBookingPmsManualNightlyRevenueEvidenceOwner(),
      roomAssignmentOptimization: createPmsRoomAssignmentOptimizationTriggerPort(),
      ...override,
    };
  }

  async function stayCorrection(
    guestBookingId: string,
    suffix: string,
    targets: Array<{ roomId: string; checkIn: string }>,
    amounts?: string[][],
  ): Promise<PmsManualStayCorrectionCommand> {
    const assignments = await admin.query<{ assignmentId: string; position: number }>(
      `SELECT id::text AS "assignmentId",position FROM pms.operational_booking_assignments
       WHERE guest_booking_id=$1::uuid ORDER BY position`,
      [guestBookingId],
    );
    return {
      propertyId,
      guestBookingId,
      commandId: `correct-command-${suffix}`,
      idempotencyKey: `correct-key-${suffix}`,
      accountingDate: "2026-08-21",
      stays: assignments.rows.map(({ assignmentId, position }, index) => {
        const target = targets[index]!;
        return {
          assignmentId,
          position,
          roomId: target.roomId,
          checkIn: target.checkIn,
          checkOut: addDays(target.checkIn, 2),
          nightly: [target.checkIn, addDays(target.checkIn, 1)].map((stayDate, night) => ({
            stayDate,
            amount: { amountDecimal: amounts?.[index]?.[night] ?? "100.00", currency: "EUR" },
            evidenceQuality: "exact" as const,
          })),
        };
      }),
      audit: {
        actor: { kind: "user", userId: actorId, organizationId },
        requestId: `correct-request-${suffix}`,
        reason: "Correct manual booking stays",
        requestedAt: acceptedAt.toISOString(),
      },
    };
  }

  function priceCorrection(
    guestBookingId: string,
    suffix: string,
    pricing: PmsManualPriceCorrectionCommand["pricing"],
  ): PmsManualPriceCorrectionCommand {
    return {
      propertyId,
      guestBookingId,
      commandId: `price-command-${suffix}`,
      idempotencyKey: `price-key-${suffix}`,
      accountingDate: "2026-08-25",
      reason: "correct nightly prices",
      pricing,
      audit: {
        actor: { kind: "user", userId: actorId, organizationId },
        requestId: `price-request-${suffix}`,
        reason: "Correct manual booking prices",
        requestedAt: acceptedAt.toISOString(),
      },
    };
  }

  function pricing(): PmsManualBookingTransactionalPricingPort {
    return {
      async calculate({ transaction, command: input }) {
        for (const stay of input.stays) {
          const overlap = await transaction.query(
            `SELECT 1 FROM pms.operational_booking_assignments
             WHERE property_id = $1::uuid AND room_id = $2::uuid
               AND assignment_status NOT IN ('canceled', 'released')
               AND check_in < $4::date AND check_out > $3::date`,
            [input.propertyId, stay.roomId, stay.checkIn, stay.checkOut],
          );
          if (overlap.rowCount)
            throw new PmsManualBookingCreateError("room_unavailable", "roomId", stay.position);
        }
        const stays = input.stays.map((stay) => ({
          position: stay.position,
          roomId: stay.roomId,
          ratePlanId: null,
          nightly: [stay.checkIn, addDays(stay.checkIn, 1)].map((serviceDate) => ({
            serviceDate,
            standard: null,
            applied: { amountDecimal: "100.00", currency: "EUR" },
          })),
          standardTotal: null,
          appliedTotal: { amountDecimal: "200.00", currency: "EUR" },
        }));
        const addOns = input.addOns.map((selection) => ({
          addonId: selection.addonId,
          pricingModel: "per_guest_night" as const,
          unitPrice: { amountDecimal: "5.00", currency: "EUR" },
          packageCount: selection.packageCount,
          serviceUnits: [...selection.serviceUnits],
          total: { amountDecimal: "10.00", currency: "EUR" },
        }));
        return {
          contractVersion: input.contractVersion,
          currency: "EUR",
          stays,
          addOns,
          grandTotal: {
            amountDecimal: input.stays.length === 2 ? "410.00" : "200.00",
            currency: "EUR",
          },
        } as any;
      },
    };
  }

  async function counts() {
    const result = await admin.query(
      `SELECT
        (SELECT count(*)::text FROM booking.guest_bookings WHERE property_id = $1::uuid) AS booking,
        (SELECT count(*)::text FROM booking.nightly_revenue_evidence
          WHERE property_id = $1::uuid) AS nightly,
        (SELECT count(*)::text FROM finance.payments WHERE property_id = $1::uuid) AS payment,
        (SELECT count(*)::text FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
        (SELECT count(*)::text FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audit,
        (SELECT count(*)::text FROM platform.idempotency_keys WHERE property_id = $1::uuid
          AND operation = 'pms.manual_booking.create') AS commands`,
      [propertyId],
    );
    return result.rows[0];
  }

  async function seedInventory() {
    await fixtureQuery(
      `INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
         inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
         generated_source_revision,channel_source_revision,manual_source_revision,
         block_source_revision,booking_source_revision)
       SELECT $1::uuid,$2::uuid,day,3,3,1,1,3,3,1,0,0,0,0
       FROM generate_series('2026-08-01'::date,'2027-12-31','1 day') day`,
      [propertyId, roomTypeId],
    );
  }

  async function fixtureQuery(sql: string, parameters: readonly unknown[]) {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(sql, [...parameters]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanup(full: boolean) {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const sql of [
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
        "DELETE FROM finance.payments WHERE property_id = $1::uuid",
        "DELETE FROM pms.booking_notes_private WHERE property_id = $1::uuid",
        "DELETE FROM pms.operational_booking_assignments WHERE property_id = $1::uuid",
        "DELETE FROM booking.booking_addon_selections WHERE property_id = $1::uuid",
        "DELETE FROM booking.nightly_revenue_evidence WHERE property_id = $1::uuid",
        "DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id = $1::uuid",
        "DELETE FROM booking.booking_guests WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid)",
        "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
      ])
        await admin.query(sql, [propertyId]);
      await admin.query(
        `UPDATE pms.inventory_days SET status='open',manual_sellable_limit_count=NULL,
           effective_sellable_limit_count=3,available_count=3
         WHERE property_id=$1::uuid`,
        [propertyId],
      );
      if (full) {
        await admin.query("DELETE FROM pms.inventory_days WHERE property_id = $1::uuid", [
          propertyId,
        ]);
        await admin.query(
          "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
          [propertyId],
        );
        await admin.query("DELETE FROM booking.addon_definitions WHERE property_id = $1::uuid", [
          propertyId,
        ]);
        await admin.query("DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]);
        await admin.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
        await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
          [propertyId, otherPropertyId],
        ]);
        await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
          organizationId,
        ]);
        await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorId]);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function command(
  suffix: string,
  status: "paid" | "unpaid",
  expectedMethod: PmsManualBookingCreateCommand["payment"]["expectedMethod"],
  checkIn: string,
  heterogeneous: boolean,
): PmsManualBookingCreateCommand {
  const stay = (position: number, roomId: string, from: string) => ({
    position,
    roomId,
    checkIn: from,
    checkOut: addDays(from, 2),
    adults: position,
    children: 0,
    ratePlanId: null,
    pricing: {
      kind: "custom" as const,
      nightlyAmount: { amountDecimal: "100.00", currency: "EUR" },
    },
  });
  return {
    contractVersion: "pms-manual-booking.v1",
    commandId: `command-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    propertyId,
    organizationId,
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phoneE164: "+306900000000",
      countryCode: "GR",
      specialRequests: "Quiet room",
    },
    privateNote: "VIP",
    directSource: "email",
    stays: heterogeneous
      ? [stay(1, roomIds[0]!, checkIn), stay(2, roomIds[1]!, addDays(checkIn, 1))]
      : [stay(1, roomIds[0]!, checkIn)],
    addOns: heterogeneous
      ? [{ addonId, packageCount: 1, serviceUnits: [{ serviceDate: checkIn, guestCount: 2 }] }]
      : [],
    payment: {
      expectedMethod,
      settlement: status === "paid" ? { status, reference: `receipt-${suffix}` } : { status },
    },
    audit: {
      actor: { kind: "user", userId: actorId, organizationId },
      requestId: `request-${suffix}`,
      correlationId: null,
      requestedAt: acceptedAt.toISOString(),
    },
  };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
