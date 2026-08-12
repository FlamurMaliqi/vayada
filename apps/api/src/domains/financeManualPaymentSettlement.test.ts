import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  recordBookingManualPaymentInClient,
  type FinanceBookingManualPaymentSettlementCommand,
} from "./financeManualPaymentSettlement.js";

const propertyId = "f3000000-0000-0000-0000-000000000686";
const guestBookingId = "f6000000-0000-0000-0000-000000000686";

describe("booking manual payment settlement", () => {
  it("records the immutable commission split in the Finance ledger", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[]; rowCount: number }> {
        calls.push({ text, values });
        if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (text.includes("FROM booking.guest_bookings booking")) {
          return {
            rows: [
              {
                guestBookingId,
                currency: "EUR",
                balanceDue: "250.00",
                lifecycleStatus: "confirmed",
                paymentStatus: "unpaid",
                billingPlanSnapshot: "commission",
                commissionTermsSnapshot: { bookingEngineFeePercent: 5 },
              } as unknown as T,
            ],
            rowCount: 1,
          };
        }
        if (text.includes("INSERT INTO finance.payments")) {
          return {
            rows: [
              {
                paymentId: "f9000000-0000-0000-0000-000000000686",
                replay: false,
              } as unknown as T,
            ],
            rowCount: 1,
          };
        }
        throw new Error(`Unhandled SQL: ${text}`);
      },
    };

    const result = await recordBookingManualPaymentInClient(client, command());

    expect(result).toMatchObject({
      ok: true,
      status: "created",
      feeAmount: "12.50",
      netAmount: "237.50",
    });
    const insert = calls.find(({ text }) => text.includes("INSERT INTO finance.payments"));
    expect(insert?.values?.slice(5, 8)).toEqual(["250.00", "12.50", "237.50"]);
    expect(insert?.values?.[3]).toMatch(
      new RegExp(`^finance\\.manual-payment\\.payment\\.property\\.${propertyId}\\.key\\.`),
    );
  });

  it("fails closed when the booking has no immutable commission terms", async () => {
    const calls: string[] = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<{ rows: T[]; rowCount: number }> {
        calls.push(text);
        if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (text.includes("FROM booking.guest_bookings booking")) {
          return {
            rows: [
              {
                guestBookingId,
                currency: "EUR",
                balanceDue: "250.00",
                lifecycleStatus: "confirmed",
                paymentStatus: "unpaid",
                billingPlanSnapshot: "commission",
                commissionTermsSnapshot: {},
              } as unknown as T,
            ],
            rowCount: 1,
          };
        }
        throw new Error(`Unhandled SQL: ${text}`);
      },
    };

    const result = await recordBookingManualPaymentInClient(client, command());

    expect(result).toEqual({
      ok: false,
      code: "invalid_command",
      message: "Booking commission terms are unavailable.",
    });
    expect(calls.some((text) => text.includes("INSERT INTO finance.payments"))).toBe(false);
  });
});

function command(): FinanceBookingManualPaymentSettlementCommand {
  return {
    commandId: "cmd-manual-payment-target",
    idempotencyKey: "finance-manual-payment-inv-2026-abcd-001",
    propertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req-manual-payment-target",
      correlationId: "corr-manual-payment-target",
      reason: "PMS booking settlement test",
      requestedAt: "2026-08-12T12:00:00.000Z",
    },
    payload: {
      invoiceId: "inv-2026-abcd",
      amount: "250.00",
      currency: "EUR",
      paymentMethod: "cash",
      reference: "front desk receipt 8812",
    },
  };
}
