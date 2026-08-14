import { describe, expect, it, vi } from "vitest";

import { createFinancePlatformAffiliatePayoutReadRepository } from "./financePlatformAffiliatePayoutRepository.js";

const summary = {
  affiliateId: "affiliate-42",
  organizationId: "10000000-0000-4000-8000-000000000001",
  affiliateLifecycleStatus: "active" as const,
  currency: "EUR",
  payoutMethod: "bank_transfer",
  outstandingAmount: "50.00",
  payableAmount: "50.00",
  paidAmount: "25.00",
  payoutCount: 2,
  payableCount: 1,
  lastPaidAt: new Date("2026-08-12T09:00:00.000Z"),
  total: "1",
};

describe("Platform Finance affiliate payout reads", () => {
  it("returns stable affiliate-and-currency summaries without profile or bank data", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [summary] });
    const repository = createFinancePlatformAffiliatePayoutReadRepository(pool(query));

    const result = await repository.listPlatformAffiliatePayoutSummaries({ limit: 25, offset: 0 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY "affiliateId", currency'),
      [25, 0],
    );
    expect(result).toEqual({
      summaries: [
        expect.objectContaining({
          affiliateId: "affiliate-42",
          currency: "EUR",
          lastPaidAt: "2026-08-12T09:00:00.000Z",
        }),
      ],
      total: 1,
      limit: 25,
      offset: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/iban|bankAccount|email|name/i);
  });

  it("preserves the true total for an empty page", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "7" }] });
    const repository = createFinancePlatformAffiliatePayoutReadRepository(pool(query));

    const result = await repository.listPlatformAffiliatePayoutSummaries({ limit: 2, offset: 8 });

    expect(result).toMatchObject({ summaries: [], total: 7, limit: 2, offset: 8 });
  });

  it("returns ledger lines and immutable evidence for the scoped detail", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes('AS "payoutId"')) {
        return {
          rows: [
            {
              payoutId: "payout-1",
              relatedPropertyId: null,
              guestBookingId: null,
              payoutStatus: "pending",
              amount: "50.00",
              feeAmount: "0.00",
              netAmount: "50.00",
              currency: "EUR",
              payoutMethod: "bank_transfer",
              providerPayoutId: null,
              scheduledAt: null,
              paidAt: null,
              failedAt: null,
              failureCode: null,
              retryCount: 0,
              manualMarkPaidEligible: true,
              paymentEvidenceId: null,
            },
          ],
        };
      }
      if (sql.includes("affiliate_payout_payment_evidence evidence")) {
        return {
          rows: [
            {
              evidenceId: "evidence-1",
              affiliateId: "affiliate-42",
              organizationId: summary.organizationId,
              payoutIds: ["payout-paid"],
              amount: "25.00",
              currency: "EUR",
              paymentMethod: "manual",
              externalReference: "receipt-1",
              evidenceReference: "vault://receipt-1",
              note: null,
              paidAt: new Date("2026-08-12T09:00:00.000Z"),
              recordedAt: new Date("2026-08-12T09:01:00.000Z"),
            },
          ],
        };
      }
      return { rows: [summary] };
    });
    const repository = createFinancePlatformAffiliatePayoutReadRepository(pool(query));

    const result = await repository.getPlatformAffiliatePayoutDetail("affiliate-42", "EUR");

    expect(result?.payouts[0]).toMatchObject({
      payoutId: "payout-1",
      manualMarkPaidEligible: true,
    });
    expect(result?.history[0]).toMatchObject({
      evidenceId: "evidence-1",
      paidAt: "2026-08-12T09:00:00.000Z",
    });
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
  });
});

function pool(query: ReturnType<typeof vi.fn>) {
  return {
    query: query as any,
    connect: async () => ({ query: query as any, release: vi.fn() }),
  };
}
