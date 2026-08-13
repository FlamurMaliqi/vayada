import { describe, expect, it, vi } from "vitest";

import type { FinanceAffiliatePayoutMarkPaidCommand } from "@vayada/domain-finance";

import { createFinancePlatformAffiliatePayoutMarkPaidRepository } from "./financePlatformAffiliatePayoutMarkPaid.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_ID = "30000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "40000000-0000-4000-8000-000000000001";

function command(
  change: Partial<FinanceAffiliatePayoutMarkPaidCommand["payload"]> = {},
): FinanceAffiliatePayoutMarkPaidCommand {
  return {
    commandType: "finance.affiliate_payout.mark_paid",
    commandId: "command-42",
    idempotencyKey: "idempotency-42",
    affiliateId: "affiliate-42",
    currency: "EUR",
    audit: {
      actor: { kind: "user", userId: USER_ID, organizationId: ORGANIZATION_ID },
      requestId: "request-42",
      reason: "Platform Admin recorded an external affiliate payout",
      requestedAt: "2026-08-13T09:00:00.000Z",
    },
    payload: {
      payoutIds: evidence().payoutIds,
      expectedAmount: "75.00",
      paymentMethod: "bank_transfer",
      externalReference: "transfer-42",
      evidenceReference: "vault://transfer-42",
      paidAt: "2026-08-13T08:55:00.000Z",
      note: "Bank receipt verified",
      ...change,
    },
  };
}

function evidence() {
  return {
    evidenceId: EVIDENCE_ID,
    affiliateId: "affiliate-42",
    organizationId: ORGANIZATION_ID,
    payoutIds: ["50000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002"],
    amount: "75.00",
    currency: "EUR",
    paymentMethod: "bank_transfer",
    externalReference: "transfer-42",
    evidenceReference: "vault://transfer-42",
    note: "Bank receipt verified",
    paidAt: new Date("2026-08-13T08:55:00.000Z"),
    recordedAt: new Date("2026-08-13T09:00:00.000Z"),
  };
}

function database(
  options: {
    idempotencyStatus?: "in_progress" | "completed";
    conflict?: boolean;
    candidates?: Array<Record<string, unknown>>;
    evidenceInserted?: boolean;
    updatedCount?: number;
  } = {},
) {
  const statements: string[] = [];
  let fingerprint = "";
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    statements.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes('AS "organizationId"') && sql.includes("FROM finance.payouts payout")) {
      return { rows: [{ organizationId: ORGANIZATION_ID }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO platform.idempotency_keys")) {
      fingerprint = String(values?.[1]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform.idempotency_keys") && sql.includes("FOR UPDATE")) {
      return {
        rows: [
          {
            id: IDEMPOTENCY_ID,
            requestFingerprintHash: options.conflict ? "different" : fingerprint,
            status: options.idempotencyStatus ?? "in_progress",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("WHERE evidence.idempotency_key_id")) {
      return { rows: [evidence()], rowCount: 1 };
    }
    if (sql.includes("FOR UPDATE OF payout")) {
      return {
        rows:
          options.candidates ??
          evidence().payoutIds.map((payoutId, index) => ({
            payoutId,
            amount: index === 0 ? "50.00" : "25.00",
            payoutStatus: index === 0 ? "pending" : "scheduled",
            providerPayoutId: null,
            payoutMethod: "bank_transfer",
          })),
        rowCount: 2,
      };
    }
    if (sql.includes("INSERT INTO finance.affiliate_payout_payment_evidence (")) {
      return options.evidenceInserted === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ evidenceId: EVIDENCE_ID, amount: "75.00" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE finance.payouts")) {
      return { rows: [], rowCount: options.updatedCount ?? 2 };
    }
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const repository = createFinancePlatformAffiliatePayoutMarkPaidRepository({
    connect: async () => ({ query: query as any, release }),
  });
  return { repository, statements, release };
}

describe("Platform Finance affiliate payout mark-paid transaction", () => {
  it("commits evidence, ledger state, job cancellation, audit, and idempotency together", async () => {
    const { repository, statements, release } = database();

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({
      ok: true,
      status: "updated",
      evidence: { evidenceId: EVIDENCE_ID, amount: "75.00" },
    });
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => sql.includes("UPDATE finance.payouts"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE platform.jobs"))).toBe(true);
    expect(
      statements.some((sql) => sql.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("SET status = 'completed'"))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns the original outcome without mutating the ledger on retry", async () => {
    const { repository, statements } = database({ idempotencyStatus: "completed" });

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({ ok: true, status: "idempotent_replay" });
    expect(statements.some((sql) => sql.includes("UPDATE finance.payouts"))).toBe(false);
    expect(statements).toContain("COMMIT");
  });

  it("rolls back a reused idempotency key with different evidence", async () => {
    const { repository, statements } = database({ conflict: true });

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("UPDATE finance.payouts"))).toBe(false);
  });

  it("rejects processing or provider-dispatched rows before evidence insertion", async () => {
    const { repository, statements } = database({
      candidates: [
        {
          payoutId: evidence().payoutIds[0],
          amount: "50.00",
          payoutStatus: "processing",
          providerPayoutId: "stripe-po-1",
          payoutMethod: "stripe",
        },
      ],
    });

    const result = await repository.markAffiliatePayoutPaid(
      command({ payoutIds: [evidence().payoutIds[0]!], expectedAmount: "50.00" }),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_status_transition" });
    expect(statements).toContain("ROLLBACK");
    expect(
      statements.some((sql) =>
        sql.includes("INSERT INTO finance.affiliate_payout_payment_evidence ("),
      ),
    ).toBe(false);
  });

  it("rolls back a duplicate external reference rejected by the evidence constraint", async () => {
    const { repository, statements } = database({ evidenceInserted: false });

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({ ok: false, code: "duplicate_reference" });
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("UPDATE finance.payouts"))).toBe(false);
  });

  it("rolls back every write when the locked payout set changes unexpectedly", async () => {
    const { repository, statements } = database({ updatedCount: 1 });

    await expect(repository.markAffiliatePayoutPaid(command())).rejects.toThrow(
      "lost its locked candidate set",
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("rejects a stale reviewed payout amount before evidence insertion", async () => {
    const { repository, statements } = database({
      candidates: [
        {
          payoutId: evidence().payoutIds[0],
          amount: "50.00",
          payoutStatus: "pending",
          providerPayoutId: null,
          payoutMethod: "bank_transfer",
        },
        {
          payoutId: evidence().payoutIds[1],
          amount: "30.00",
          payoutStatus: "scheduled",
          providerPayoutId: null,
          payoutMethod: "bank_transfer",
        },
      ],
    });

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({ ok: false, code: "stale_payout_snapshot" });
    expect(statements).toContain("ROLLBACK");
    expect(
      statements.some((sql) =>
        sql.includes("INSERT INTO finance.affiliate_payout_payment_evidence ("),
      ),
    ).toBe(false);
  });

  it("returns the original outcome after affiliate lifecycle changes", async () => {
    const { repository, statements } = database({ idempotencyStatus: "completed" });

    const result = await repository.markAffiliatePayoutPaid(command());

    expect(result).toMatchObject({ ok: true, status: "idempotent_replay" });
    expect(
      statements.some(
        (sql) => sql.includes('AS "organizationId"') && sql.includes("FROM finance.payouts payout"),
      ),
    ).toBe(false);
  });

  it("rejects future payment evidence before opening a transaction", async () => {
    const connect = vi.fn();
    const repository = createFinancePlatformAffiliatePayoutMarkPaidRepository({ connect });

    const result = await repository.markAffiliatePayoutPaid(
      command({ paidAt: "2026-08-13T09:00:01.000Z" }),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_command" });
    expect(connect).not.toHaveBeenCalled();
  });
});
