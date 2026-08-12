import {
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import { createPgPmsManualBookingPlatformOwnerPort } from "./pmsManualBookingCommandEvidence.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import {
  createPgPmsManualBookingBookingOwnerPort,
  createPgPmsManualBookingOperationsOwnerPort,
} from "./pmsManualBookingPersistence.js";
import type {
  PmsManualBookingTransactionDependencies,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `82000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const organizationId = uuid(1),
  actorId = uuid(2),
  propertyId = uuid(3);
const otherPropertyId = uuid(4),
  roomTypeId = uuid(5),
  roomIds = [uuid(6), uuid(7)];
const addonId = uuid(8);
const acceptedAt = new Date("2026-08-12T20:30:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("target manual-booking PostgreSQL transaction", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const repository = createPgPmsManualBookingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    now: () => acceptedAt,
    dependencies: dependencies(),
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
      `INSERT INTO pms.room_types (
         id, property_id, name, occupancy_limits, base_rate_amount, currency
       ) VALUES ($1::uuid, $2::uuid, 'Studio', '{"adults":4,"children":4,"total":4}', 100, 'EUR')`,
      [roomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number)
       VALUES ($1::uuid, $3::uuid, $4::uuid, '101'),
              ($2::uuid, $3::uuid, $4::uuid, '102')`,
      [roomIds[0], roomIds[1], propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO booking.addon_definitions (
         id, property_id, name, pricing_model, price_amount, currency
       ) VALUES ($1::uuid, $2::uuid, 'Breakfast', 'per_guest_night', 5, 'EUR')`,
      [addonId, propertyId],
    );
  });

  beforeEach(async () => cleanup(false));

  afterAll(async () => {
    await repository.close();
    await cleanup(true);
    await admin.end();
  });

  it("atomically creates heterogeneous owned facts, outbox evidence, and an exact replay", async () => {
    const input = command("full", "unpaid", "cash", "2027-01-01", true);
    const created = await repository.createManualBooking(input);
    await expect(repository.createManualBooking(input)).resolves.toEqual({
      ...created,
      outcome: "replayed",
    });

    const stored = await admin.query(
      `SELECT booking.expected_payment_method AS method, booking.payment_status AS payment,
        booking.total_amount::text AS total, booking.balance_amount::text AS balance,
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
      requests: "Quiet room",
      stays: 2,
      notes: 1,
      addons: 1,
      metadata: { attribution: "email", nightlyEvidence: true },
    });
    await expect(counts()).resolves.toMatchObject({
      booking: "1",
      payment: "0",
      outbox: "4",
      audit: "1",
      commands: "1",
    });
  });

  it("round-trips every expected method for paid and unpaid bookings", async () => {
    const methods = ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const;
    for (const [methodIndex, method] of methods.entries()) {
      for (const [statusIndex, status] of (["unpaid", "paid"] as const).entries()) {
        const day = String(10 + methodIndex * 4 + statusIndex * 2).padStart(2, "0");
        const created = await repository.createManualBooking(
          command(`${method}-${status}`, status, method, `2027-02-${day}`, false),
        );
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
      }
    }
    expect((await counts()).payment).toBe("5");
  });

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
      attribution: {
        async recordManualAttribution({ transaction, guestBookingId, directSource }) {
          await transaction.query(
            `UPDATE booking.guest_bookings
             SET booking_metadata = booking_metadata || jsonb_build_object('attribution', $2::text)
             WHERE id = $1::uuid`,
            [guestBookingId, directSource],
          );
        },
      },
      nightlyEvidence: {
        async appendExactNightlyEvidence({ transaction, guestBookingId }) {
          await transaction.query(
            `UPDATE booking.guest_bookings
             SET booking_metadata = booking_metadata || '{"nightlyEvidence":true}'::jsonb
             WHERE id = $1::uuid`,
            [guestBookingId],
          );
        },
      },
      ...override,
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
        (SELECT count(*)::text FROM finance.payments WHERE property_id = $1::uuid) AS payment,
        (SELECT count(*)::text FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
        (SELECT count(*)::text FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audit,
        (SELECT count(*)::text FROM platform.idempotency_keys WHERE property_id = $1::uuid
          AND operation = 'pms.manual_booking.create') AS commands`,
      [propertyId],
    );
    return result.rows[0];
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
        "DELETE FROM booking.booking_guests WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid)",
        "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
      ])
        await admin.query(sql, [propertyId]);
      if (full) {
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
