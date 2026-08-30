import { describe, expect, it } from "vitest";

import type { FinanceTargetRecord } from "./productionFinanceTypes.js";
import { writeProductionFinanceRecords } from "./productionFinanceWriter.js";

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
