import { describe, expect, it } from "vitest";

import { inventoryReservationReceiptFromBookingMetadata } from "../platform/inventoryReservation.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";

const reservationInput = {
  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
  quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
  roomTypeId: "59b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
  publicOfferKey: "room-deluxe:flexible",
  checkIn: "2026-09-12",
  checkOut: "2026-09-15",
  roomCount: 1,
  currency: "EUR",
  occurredAt: new Date("2026-09-01T10:00:00.000Z"),
} as const;
const receiptId = "69b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66";

describe("target PMS inventory reservation adapter", () => {
  it("reserves through the caller transaction and returns the opaque receipt", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const transaction = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes('AS "receiptId"')) return { rows: [{ receiptId }] };
        if (text.includes("UPDATE pms.inventory_days")) return { rows: [{ reserved: true }] };
        return { rows: [] };
      },
    };

    const marker = await createTargetPmsInventoryReservationPort().reserve({
      transaction: transaction as never,
      ...reservationInput,
    });

    expect(marker).toEqual({
      contractVersion: "pms-inventory-reservation-lifecycle.v1",
      owner: "pms",
      receiptId,
    });
    expect(calls).toHaveLength(5);
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(calls[1]?.text).toContain("UPDATE pms.inventory_days");
    expect(calls[1]?.text).toContain("booking_source_revision + 1");
    expect(calls[1]?.text.match(/COALESCE\(inventory\.rate_gate_open, TRUE\)/g)).toHaveLength(2);
    expect(calls[1]?.text).not.toContain("payAtProperty");
    expect(calls[1]?.text).toContain(
      "WHEN offer.availability_status IN ('closed', 'stale', 'unavailable')",
    );
    expect(calls[1]?.text).toContain(
      "WHEN offer.availability_status IN ('closed', 'stale', 'unavailable') THEN FALSE",
    );
    expect(calls[1]?.values).toEqual([
      reservationInput.propertyId,
      reservationInput.roomTypeId,
      reservationInput.publicOfferKey,
      reservationInput.checkIn,
      reservationInput.checkOut,
      reservationInput.roomCount,
      reservationInput.currency,
      reservationInput.occurredAt.toISOString(),
    ]);
    expect(calls[2]?.text).toContain("pms.direct_booking_inventory.reserve");
  });

  it("returns null when the guarded reservation does not cover the full stay", async () => {
    const transaction = {
      async query() {
        return { rows: [{ reserved: false }] };
      },
    };

    await expect(
      createTargetPmsInventoryReservationPort().reserve({
        transaction: transaction as never,
        ...reservationInput,
      }),
    ).resolves.toBeNull();
  });

  it("loads, releases, and credits only the exact opaque receipt", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    let terminal = false;
    const transaction = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes('receipt.quote_session_id AS "quoteSessionId"')) {
          if (terminal) return { rows: [] };
          return {
            rows: [
              {
                quoteSessionId: reservationInput.quoteSessionId,
                roomTypeId: reservationInput.roomTypeId,
                publicOfferKey: reservationInput.publicOfferKey,
                checkIn: reservationInput.checkIn,
                checkOut: reservationInput.checkOut,
                roomCount: reservationInput.roomCount,
              },
            ],
          };
        }
        if (text.includes("UPDATE pms.inventory_reservation_statuses")) {
          return { rows: [{ receiptId }] };
        }
        // prettier-ignore
        if (text.includes('receipt.check_in::text AS "checkIn"')) return { rows: values?.[4] === reservationInput.checkIn ? [{ checkIn: reservationInput.checkIn, checkOut: reservationInput.checkOut, roomCount: reservationInput.roomCount }] : [] };
        return { rows: [] };
      },
    };
    const adapter = createTargetPmsInventoryReservationPort();

    const invalidReservation = inventoryReservationReceiptFromBookingMetadata(
      {},
      reservationInput.propertyId,
    );
    expect(invalidReservation).toBeNull();
    expect(calls).toHaveLength(0);

    const reservation = inventoryReservationReceiptFromBookingMetadata(
      {
        inventoryReservation: {
          contractVersion: "pms-inventory-reservation-lifecycle.v1",
          owner: "pms",
          receiptId,
        },
      },
      reservationInput.propertyId,
    );
    expect(reservation).not.toBeNull();
    await adapter.release({
      transaction: transaction as never,
      propertyId: reservationInput.propertyId,
      reservation: reservation!,
      occurredAt: reservationInput.occurredAt,
    });

    expect(calls).toHaveLength(6);
    expect(calls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(calls[1]?.text).toContain("FOR UPDATE OF status");
    expect(calls[1]?.values).toEqual([receiptId, reservationInput.propertyId]);
    expect(calls[2]?.text).toContain("assigned_count = GREATEST");
    expect(calls[2]?.text).toContain("booking_source_revision + 1");
    expect(calls[2]?.text).toContain("pms.direct_booking_inventory.release");
    expect(calls[2]?.values).toEqual([
      reservationInput.propertyId,
      reservationInput.roomTypeId,
      reservationInput.checkIn,
      reservationInput.checkOut,
      reservationInput.roomCount,
      reservationInput.occurredAt.toISOString(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(calls[3]?.text).toContain("receipt.receipt_id=$12::uuid");
    expect(calls[3]?.values?.[11]).toBe(receiptId);
    terminal = true;
    calls.length = 0;
    // prettier-ignore
    await adapter.release({ transaction: transaction as never, propertyId: reservationInput.propertyId, reservation: reservation!, occurredAt: reservationInput.occurredAt });
    expect(calls).toHaveLength(2);
    expect(calls.some(({ text }) => text.includes("assigned_count = GREATEST"))).toBe(false);
    calls.length = 0;
    // prettier-ignore
    await expect(adapter.availabilityCredit!({ transaction: transaction as never, propertyId: reservationInput.propertyId, reservation: reservation! as never, roomTypeId: reservationInput.roomTypeId, publicOfferKey: reservationInput.publicOfferKey, checkIn: reservationInput.checkIn, checkOut: reservationInput.checkOut, roomCount: reservationInput.roomCount })).resolves.toEqual({ checkIn: reservationInput.checkIn, checkOut: reservationInput.checkOut, roomCount: 1 });
    // prettier-ignore
    expect(calls[0]?.values).toEqual([receiptId, reservationInput.propertyId, reservationInput.roomTypeId, reservationInput.publicOfferKey, reservationInput.checkIn, reservationInput.checkOut, 1, "pms-inventory-reservation-lifecycle.v1"]);
    // prettier-ignore
    await expect(adapter.availabilityCredit!({ transaction: transaction as never, propertyId: reservationInput.propertyId, reservation: reservation! as never, roomTypeId: reservationInput.roomTypeId, publicOfferKey: reservationInput.publicOfferKey, checkIn: "2026-09-13", checkOut: reservationInput.checkOut, roomCount: reservationInput.roomCount })).resolves.toBeNull();
  });
});
