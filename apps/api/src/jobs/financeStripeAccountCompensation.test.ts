import type { FinanceStripeConnectProvider } from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";

import { runFinanceStripeAccountCompensationJobs } from "./financeStripeAccountCompensation.js";

const job = {
  id: "13450000-0000-4000-8000-000000000001",
  attemptsCount: 1,
  maxAttempts: 3,
  payload: {
    owner: {
      ownerScope: "property",
      propertyId: "13450000-0000-4000-8000-000000000002",
      organizationId: null,
    },
    providerAccountRef: "acct_orphaned_1345",
    idempotencyKey: "finance.stripe-connect.compensate:test:v1",
  },
};

describe("Finance Stripe account compensation jobs", () => {
  it("claims and completes an orphaned-account cleanup", async () => {
    const queries: string[] = [];
    let claimed = false;
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("RETURNING job.id::text") && !claimed) {
          claimed = true;
          return { rows: [job], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("RETURNING job.id::text") ? 0 : 1 };
      },
      async connect() {
        return { query: pool.query, release() {} };
      },
    };
    const compensate = vi.fn(async () => {});

    await expect(
      runFinanceStripeAccountCompensationJobs(
        "postgresql://unused",
        { compensateAccountCreation: compensate },
        { pool: pool as never, limit: 2 },
      ),
    ).resolves.toEqual({ succeeded: 1, retryScheduled: 0, failed: 0 });
    expect(compensate).toHaveBeenCalledWith({
      ...job.payload,
      reason: "db_write_failed",
    });
    expect(queries.some((sql) => sql.includes("status = 'succeeded'"))).toBe(true);
  });

  it("keeps transient failures pending for a later retry", async () => {
    let claimed = false;
    const updates: Array<readonly unknown[] | undefined> = [];
    const pool = {
      async query(sql: string, values?: readonly unknown[]) {
        if (sql.includes("RETURNING job.id::text") && !claimed) {
          claimed = true;
          return { rows: [job], rowCount: 1 };
        }
        if (sql.includes("UPDATE platform.jobs")) updates.push(values);
        return { rows: [], rowCount: sql.includes("RETURNING job.id::text") ? 0 : 1 };
      },
      async connect() {
        return { query: pool.query, release() {} };
      },
    };
    const provider: Pick<FinanceStripeConnectProvider, "compensateAccountCreation"> = {
      async compensateAccountCreation() {
        throw new Error("temporary Stripe failure");
      },
    };

    await expect(
      runFinanceStripeAccountCompensationJobs("postgresql://unused", provider, {
        pool: pool as never,
        limit: 1,
      }),
    ).resolves.toEqual({ succeeded: 0, retryScheduled: 1, failed: 0 });
    expect(updates).toContainEqual([job.id, false]);
  });

  it("never deletes an account ref that became durably owned before retry", async () => {
    let claimed = false;
    const outcomes: Array<readonly unknown[] | undefined> = [];
    const pool = {
      async query(sql: string, values?: readonly unknown[]) {
        if (sql.includes("RETURNING job.id::text") && !claimed) {
          claimed = true;
          return { rows: [job], rowCount: 1 };
        }
        if (sql.includes("FROM finance.payment_provider_accounts")) {
          return { rows: [{ exists: 1 }], rowCount: 1 };
        }
        if (sql.includes("status = 'succeeded'")) outcomes.push(values);
        return { rows: [], rowCount: sql.includes("RETURNING job.id::text") ? 0 : 1 };
      },
      async connect() {
        return { query: pool.query, release() {} };
      },
    };
    const compensate = vi.fn(async () => {});

    await expect(
      runFinanceStripeAccountCompensationJobs(
        "postgresql://unused",
        { compensateAccountCreation: compensate },
        { pool: pool as never, limit: 1 },
      ),
    ).resolves.toEqual({ succeeded: 1, retryScheduled: 0, failed: 0 });
    expect(compensate).not.toHaveBeenCalled();
    expect(outcomes).toContainEqual([job.id, "provider_account_durably_owned"]);
  });

  it("refuses to run without compensation support", async () => {
    await expect(
      runFinanceStripeAccountCompensationJobs("postgresql://unused", {}, { pool: {} as never }),
    ).rejects.toThrow("Stripe account compensation is not configured");
  });
});
