import { describe, expect, it } from "vitest";

import type { FinanceTargetRecord } from "./productionFinanceTypes.js";
import {
  writeProductionFinanceDispositions,
  writeProductionFinanceRecords,
} from "./productionFinanceWriter.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Finance writer", () => {
  it("writes dependencies in order and uses the property key for payment settings", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push(sql);
        return { rowCount: JSON.parse(String(values?.[0])).length };
      },
    };
    const counts = await writeProductionFinanceRecords(client as never, [
      record("payments", { id: "payment" }),
      record("payment_settings", { propertyId: "property" }, "property"),
      record("payment_provider_accounts", { id: "provider" }),
    ]);
    expect(counts).toEqual({ payment_provider_accounts: 1, payment_settings: 1, payments: 1 });
    expect(calls[0]).toContain("INSERT INTO finance.payment_provider_accounts");
    expect(calls[1]).toContain("ON CONFLICT (property_id)");
    expect(calls[2]).toContain("INSERT INTO finance.payments");
  });

  it("never updates immutable Finance history on conflict", async () => {
    let sql = "";
    const client = {
      async query(statement: string) {
        sql = statement;
        return { rowCount: 1 };
      },
    };
    const immutable = record("commission_rate_changes", { id: "change" });
    immutable.mutable = false;

    await writeProductionFinanceRecords(client as never, [immutable]);

    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).not.toContain("DO UPDATE");
  });

  it("stores only hash evidence for unsafe Finance source state", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return sql.includes("WITH planned")
          ? { rows: [{ matched_count: 1, total_count: 1 }] }
          : { rowCount: 1 };
      },
    };

    const count = await writeProductionFinanceDispositions(
      client as never,
      [
        {
          sourceDatabase: "booking",
          sourceTable: "booking_hotels",
          sourceId: "source",
          sourceField: "payout_destination",
          sourceValueSha256: "b".repeat(64),
          reasonCode: "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED",
          disposition: "target_reentry_required",
          targetTable: "payout_settings",
          targetId: "00000000-0000-4000-8000-000000000001",
        },
      ],
      RUN,
    );

    expect(count).toBe(1);
    expect(calls[0]?.sql).toContain("production_finance_migration_dispositions");
    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(JSON.stringify(calls[0]?.values)).not.toContain("bank-secret");
  });

  it("rejects stale immutable dispositions even when the current plan is empty", async () => {
    const client = {
      async query() {
        return { rows: [{ matched_count: 0, total_count: 1 }] };
      },
    };

    await expect(writeProductionFinanceDispositions(client as never, [], RUN)).rejects.toThrow(
      "Finance disposition replay mismatch",
    );
  });
});

function record(
  targetTable: string,
  row: Record<string, unknown>,
  targetId = String(row["id"]),
): FinanceTargetRecord {
  return {
    targetProduct: "finance",
    targetTable,
    targetId,
    sourceDatabase: "pms",
    sourceTable: "payments",
    sourceId: "source",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00Z",
    mutable: true,
    row,
  };
}
