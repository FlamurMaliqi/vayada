import { describe, expect, it } from "vitest";

import { createPgFinanceSubscriptionStore } from "./financeSubscriptionStore.js";

describe("Finance subscription store", () => {
  it("holds a session-scoped property advisory lock without an outer transaction", async () => {
    const calls: string[] = [];
    const client = {
      async query(text: string) {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {
        calls.push("RELEASE");
      },
    };
    const store = createPgFinanceSubscriptionStore({
      connectionString: "postgres://unused",
      pool: {
        query: client.query,
        async connect() {
          return client;
        },
      } as never,
    });

    await store.withPlanMutationLock("property-1", async () => {
      calls.push("ACTION");
    });

    expect(calls).toEqual([
      expect.stringContaining("pg_advisory_lock"),
      "ACTION",
      expect.stringContaining("pg_advisory_unlock"),
      "RELEASE",
    ]);
  });

  it("reuses the locked connection for the plan mutation transaction", async () => {
    const calls: string[] = [];
    let connectCount = 0;
    const client = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "idem-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        calls.push("RELEASE");
      },
    };
    const store = createPgFinanceSubscriptionStore({
      connectionString: "postgres://unused",
      pool: {
        query: client.query,
        async connect() {
          connectCount += 1;
          return client;
        },
      } as never,
    });

    await store.withPlanMutationLock("property-1", (lockedStore) =>
      lockedStore.recordCommissionSelection(commissionCommand(), commissionResult()),
    );

    expect(connectCount).toBe(1);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    expect(calls.at(-2)).toContain("pg_advisory_unlock");
    expect(calls.at(-1)).toBe("RELEASE");
  });

  it("destroys a pooled client when the session advisory lock cannot be released", async () => {
    const releases: Array<boolean | undefined> = [];
    const client = {
      async query(text: string) {
        if (text.includes("pg_advisory_unlock")) throw new Error("connection lost");
        return { rows: [], rowCount: 0 };
      },
      release(destroy?: boolean) {
        releases.push(destroy);
      },
    };
    const store = createPgFinanceSubscriptionStore({
      connectionString: "postgres://unused",
      pool: {
        query: client.query,
        async connect() {
          return client;
        },
      } as never,
    });

    await expect(store.withPlanMutationLock("property-1", async () => undefined)).rejects.toThrow(
      "connection lost",
    );
    expect(releases).toEqual([true]);
  });

  it("provisions the canonical 5% booking commission rule with a new plan selection", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("INSERT INTO platform.idempotency_keys"))
          return { rows: [{ id: "idem-1" }] };
        return { rows: [] };
      },
      async end() {},
    };
    const store = createPgFinanceSubscriptionStore({
      connectionString: "postgres://unused",
      pool: pool as never,
    });

    await store.recordCommissionSelection(commissionCommand(), commissionResult());

    const rule = calls.find(({ text }) => text.includes("INSERT INTO finance.commission_rules"));
    expect(rule?.text).toContain("'percentage', 5");
    expect(rule?.text).not.toContain("WHERE NOT EXISTS");
    expect(rule?.text).toContain("ON CONFLICT (source_system, source_rule_id) DO UPDATE SET");
    expect(rule?.text).toContain("commission_type = 'percentage'");
    expect(rule?.text).toContain("percentage_rate = 5");
    expect(rule?.text).toContain("status = 'active'");
    expect(rule?.text).toContain("ends_at = NULL");
    expect(rule?.values).toEqual([
      "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      "2026-09-01T10:00:00.000Z",
      "onboarding-booking:a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
    ]);
  });
});

function commissionCommand() {
  return {
    commandId: "commission-1",
    idempotencyKey: "commission-property-1",
    propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
    organizationId: "b9fccec2-eb4c-4c35-bfd3-02a748c2e117",
    audit: {
      actor: { kind: "system" as const, service: "test" },
      requestId: "request-1",
      reason: "test",
      requestedAt: "2026-09-01T10:00:00.000Z",
    },
  };
}

function commissionResult() {
  return {
    planStatus: {
      propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      plan: "commission" as const,
      status: "commission" as const,
      currency: "EUR" as const,
      activeRoomCount: 1,
      amountMinor: 3_000,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      nextBillingDate: null,
      cancelAtPeriodEnd: false,
      checkoutPending: false,
      customerPortalAvailable: false,
      activatedAt: null,
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
  };
}
