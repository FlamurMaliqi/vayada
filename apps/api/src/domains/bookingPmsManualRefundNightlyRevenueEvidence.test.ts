import { describe, expect, it, vi } from "vitest";

import type { ExternalRevenueEvidenceClient } from "./bookingExternalNightlyRevenueEvidence.js";
import {
  ManualRefundEvidenceError,
  refundPmsManualBooking,
} from "./bookingPmsManualRefundNightlyRevenueEvidence.js";
import {
  createFinanceManualBookingRefundPort,
  financeManualBookingRefundTransaction,
} from "./financeManualBookingRefund.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const BOOKING = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";
const EVIDENCE = "44444444-4444-4444-8444-444444444444";
const ROOM_TYPE = "55555555-5555-4555-8555-555555555555";

describe("manual booking refund evidence", () => {
  it("updates the manual payment and appends an exact negative nightly fact", async () => {
    const { client, query } = fixture("90.0000");
    const financeTransaction = await financeManualBookingRefundTransaction(client);
    await refundPmsManualBooking(
      client,
      command("25.00"),
      "2026-08-13T12:00:00.000Z",
      createFinanceManualBookingRefundPort(),
      financeTransaction,
    );

    const paymentUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE finance.payments"),
    );
    expect(paymentUpdate?.[1]).toEqual([
      PAYMENT,
      "40.0000",
      "partially_refunded",
      "2026-08-13T12:00:00.000Z",
      "15.00",
    ]);
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO booking.nightly_revenue_evidence"),
    );
    expect(JSON.parse(String(insert?.[1]?.[5]))).toEqual([
      expect.objectContaining({
        recognizedOn: "2026-08-13",
        grossRoomAmount: "-25.0000",
        economicEvent: "refund",
        correctsEvidenceId: EVIDENCE,
      }),
    ]);
  });

  it("fails before financial writes when the allocation exceeds its target", async () => {
    const { client, query } = fixture("10.0000");
    const financeTransaction = await financeManualBookingRefundTransaction(client);
    await expect(
      refundPmsManualBooking(
        client,
        command("20.00"),
        "2026-08-13T12:00:00.000Z",
        createFinanceManualBookingRefundPort(),
        financeTransaction,
      ),
    ).rejects.toBeInstanceOf(ManualRefundEvidenceError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE finance.payments"))).toBe(
      false,
    );
  });
});

function command(amountDecimal: string) {
  return {
    propertyId: PROPERTY,
    guestBookingId: BOOKING,
    idempotencyKey: "refund-key",
    paymentEvidenceId: PAYMENT,
    accountingDate: "2026-08-13",
    allocations: [{ evidenceId: EVIDENCE, amount: { amountDecimal, currency: "EUR" } }],
    commandId: "refund-command",
    audit: {
      actor: {
        kind: "user",
        userId: "77777777-7777-4777-8777-777777777777",
        organizationId: "88888888-8888-4888-8888-888888888888",
      },
      requestId: "refund-request",
    },
  };
}

function fixture(availableAmount: string) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes("SELECT source_booking_id"))
      return {
        rows: [
          {
            sourceBookingReference: "manual-command",
            currency: "EUR",
            timezone: "Europe/Athens",
            paymentStatus: "paid",
          },
        ],
      };
    if (sql.includes("payment_kind='refund'")) return { rows: [] };
    if (sql.includes("payment_kind='manual'"))
      return {
        rows: [
          {
            amount: "100.00",
            refundedAmount: "15.00",
            currency: "EUR",
            paymentMethod: "cash",
            organizationId: null,
            status: "partially_refunded",
          },
        ],
      };
    if (sql.includes("FROM booking.nightly_revenue_evidence target"))
      return {
        rows: [
          {
            id: EVIDENCE,
            roomTypeId: ROOM_TYPE,
            stayDate: "2026-08-01",
            recognizedOn: "2026-08-01",
            availableAmount,
            linePosition: 1,
          },
        ],
      };
    if (sql.includes("UPDATE finance.payments") || sql.includes("UPDATE booking.guest_bookings"))
      return { rows: [], rowCount: 1 };
    if (
      sql.includes("INSERT INTO finance.payments") ||
      sql.includes("INSERT INTO platform.product_audit_events")
    )
      return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT room_count"))
      return { rows: [{ roomCount: 1, roomTypeCount: 1, transactionId: "1" }] };
    if (sql.includes('AS "transactionId"')) return { rows: [{ transactionId: "1" }] };
    if (sql.includes("SELECT txid_current")) return { rows: [{ id: "1" }] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("command_key LIKE")) return { rows: [] };
    if (sql.includes("COALESCE(MAX(source_revision)")) return { rows: [{ value: 2 }] };
    if (sql.includes("INSERT INTO booking.nightly_revenue_evidence"))
      return { rows: [{ id: "66666666-6666-4666-8666-666666666666", commandKey: "key" }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, client: { query } as unknown as ExternalRevenueEvidenceClient };
}
