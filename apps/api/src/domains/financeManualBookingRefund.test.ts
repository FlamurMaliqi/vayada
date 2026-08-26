import { describe, expect, it, vi } from "vitest";

import {
  createFinanceManualBookingRefundPort,
  FinanceManualBookingRefundError,
  financeManualBookingRefundTransaction,
} from "./financeManualBookingRefund.js";

const BOOKING = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION = "44444444-4444-4444-8444-444444444444";

describe("Finance manual booking refund owner", () => {
  it("rejects a transaction capability after its caller transaction ends", async () => {
    let transactionId = "1";
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("txid_current")) return { rows: [{ transactionId }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = await financeManualBookingRefundTransaction({
      query,
    } as unknown as Parameters<typeof financeManualBookingRefundTransaction>[0]);
    transactionId = "2";
    await expect(
      createFinanceManualBookingRefundPort().record({
        transaction,
        command: command("11111111-1111-4111-8111-111111111111"),
      }),
    ).rejects.toBeInstanceOf(FinanceManualBookingRefundError);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("scopes refund identities and audits independently per property", async () => {
    const first = await run("11111111-1111-4111-8111-111111111111");
    const second = await run("99999999-9999-4999-8999-999999999999");
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(first.auditKey).not.toBe(second.auditKey);
    expect(first.sourceId).toContain(first.propertyId);
    expect(first.auditKey).toContain(first.propertyId);
  });

  it("preserves ownership and replays with the current aggregate status", async () => {
    const result = await run("11111111-1111-4111-8111-111111111111", true);
    expect(result.organizationId).toBe(ORGANIZATION);
    expect(result.statuses).toEqual([
      "partially_refunded",
      "partially_refunded",
      "refunded",
      "refunded",
    ]);
    expect(result.refundInserts).toBe(2);
    expect(result.updates).toBe(2);
  });
});

async function run(propertyId: string, replay = false) {
  const stored = new Map<unknown, Record<string, unknown>>();
  let refundedAmount = "0.00";
  let paymentStatus = "paid";
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes("txid_current")) return { rows: [{ transactionId: "1" }] };
    if (sql.includes("payment_kind='refund'")) {
      const row = stored.get(values?.[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("payment_kind='manual'"))
      return {
        rows: [
          {
            amount: "100.00",
            refundedAmount,
            currency: "EUR",
            paymentMethod: "cash",
            organizationId: ORGANIZATION,
            status: paymentStatus,
          },
        ],
      };
    if (sql.includes("UPDATE finance.payments")) {
      refundedAmount = String(values?.[1]);
      paymentStatus = String(values?.[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO finance.payments")) {
      stored.set(values?.[3], {
        guestBookingId: BOOKING,
        amount: values?.[6],
        currency: values?.[7],
        idempotencyKey: values?.[4],
        metadata: JSON.parse(String(values?.[8])),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const transaction = await financeManualBookingRefundTransaction({
    query,
  } as unknown as Parameters<typeof financeManualBookingRefundTransaction>[0]);
  const port = createFinanceManualBookingRefundPort();
  const statuses = [await port.record({ transaction, command: command(propertyId) })];
  if (replay) {
    statuses.push(await port.record({ transaction, command: command(propertyId) }));
    statuses.push(
      await port.record({ transaction, command: command(propertyId, "75.0000", "final-key") }),
    );
    statuses.push(await port.record({ transaction, command: command(propertyId) }));
  }
  const refund = query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO finance.payments"),
  );
  const audit = query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO platform.product_audit_events"),
  );
  return {
    propertyId,
    sourceId: refund?.[1]?.[3],
    organizationId: refund?.[1]?.[1],
    auditKey: audit?.[1]?.[0],
    statuses,
    refundInserts: query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO finance.payments"),
    ).length,
    updates: query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE finance.payments"))
      .length,
  };
}

function command(propertyId: string, amount = "25.0000", idempotencyKey = "shared-key") {
  return {
    propertyId,
    guestBookingId: BOOKING,
    paymentEvidenceId: PAYMENT,
    commandId: idempotencyKey,
    idempotencyKey,
    amount,
    currency: "EUR",
    accountingDate: "2026-08-13",
    acceptedAt: "2026-08-13T12:00:00.000Z",
    reason: "guest refund",
    audit: {
      actor: { kind: "user", userId: "77777777-7777-4777-8777-777777777777" },
      requestId: "refund-request",
    },
  };
}
