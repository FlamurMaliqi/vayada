import { describe, expect, it } from "vitest";

import {
  normalizeFinanceAffiliatePayoutMarkPaid,
  type FinanceAffiliatePayoutMarkPaidCommand,
} from "./platformAffiliatePayouts.js";

const ACTOR_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_USER_ID = "20000000-0000-4000-8000-000000000001";

function command(
  change: Partial<FinanceAffiliatePayoutMarkPaidCommand["payload"]> = {},
): FinanceAffiliatePayoutMarkPaidCommand {
  return {
    commandType: "finance.affiliate_payout.mark_paid",
    commandId: "affiliate-payout-command-1",
    idempotencyKey: "affiliate-payout-key-1",
    affiliateId: "affiliate-42",
    currency: "EUR",
    audit: {
      actor: {
        kind: "user",
        userId: ACTOR_USER_ID,
        organizationId: ACTOR_ORGANIZATION_ID,
      },
      requestId: "request-1",
      reason: "Platform Admin recorded an external affiliate payout",
      requestedAt: "2026-08-13T09:00:00.000Z",
    },
    payload: {
      payoutIds: ["50000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000001"],
      expectedAmount: "75.00",
      paymentMethod: "bank_transfer",
      externalReference: "bank-transfer-42",
      evidenceReference: "s3://finance-evidence/transfer-42.pdf",
      paidAt: "2026-08-13T08:55:00.000Z",
      note: "Approved by finance",
      ...change,
    },
  };
}

describe("platform affiliate payout contract", () => {
  it("normalizes immutable mark-paid evidence", () => {
    expect(normalizeFinanceAffiliatePayoutMarkPaid(command())).toMatchObject({
      affiliateId: "affiliate-42",
      currency: "EUR",
      payload: {
        payoutIds: ["50000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002"],
        expectedAmount: "75.00",
        paymentMethod: "bank_transfer",
        externalReference: "bank-transfer-42",
        evidenceReference: "s3://finance-evidence/transfer-42.pdf",
        paidAt: "2026-08-13T08:55:00.000Z",
        note: "Approved by finance",
      },
    });
  });

  it.each(["manual", "bank_transfer"] as const)(
    "accepts the supported %s payment method",
    (paymentMethod) => {
      expect(
        normalizeFinanceAffiliatePayoutMarkPaid(command({ paymentMethod })).payload.paymentMethod,
      ).toBe(paymentMethod);
    },
  );

  it.each(["stripe", "xendit", "bank", "cash"])(
    "rejects unsupported payment method %s",
    (paymentMethod) => {
      expect(() =>
        normalizeFinanceAffiliatePayoutMarkPaid(command({ paymentMethod } as never)),
      ).toThrowError(expect.objectContaining({ code: "invalid_command" }));
    },
  );

  it.each([
    "2026-08-13",
    "2026-02-30T09:00:00.000Z",
    "2026-08-13T25:00:00Z",
    "2026-08-13T09:00:00.1234Z",
    "0000-08-13T09:00:00Z",
  ])("rejects invalid RFC 3339 evidence timestamp %s", (paidAt) => {
    expect(() => normalizeFinanceAffiliatePayoutMarkPaid(command({ paidAt }))).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
  });

  it.each([
    (value: any) => (value.currency = "eur"),
    (value: any) => (value.payload.externalReference = " duplicate "),
    (value: any) => (value.payload.evidenceReference = ""),
    (value: any) => (value.audit.actor.kind = "system"),
    (value: any) => (value.audit.actor.userId = "not-a-uuid"),
    (value: any) => (value.payload.unexpected = true),
    (value: any) => (value.payload.payoutIds = []),
    (value: any) => (value.payload.payoutIds[1] = value.payload.payoutIds[0]),
    (value: any) => (value.payload.expectedAmount = "75"),
    (value: any) => delete value.idempotencyKey,
  ])("returns invalid_command for malformed runtime input", (mutate) => {
    const value: any = command();
    mutate(value);
    expect(() => normalizeFinanceAffiliatePayoutMarkPaid(value)).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
  });
});
