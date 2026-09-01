import { describe, expect, it } from "vitest";

import { writeProductionPmsRecords } from "./productionPmsWriter.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";

describe("production PMS writer", () => {
  it("writes dependencies in order and uses the inventory composite key", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rowCount: JSON.parse(String(values?.[0])).length };
      },
    };
    const counts = await writeProductionPmsRecords(client as never, [
      record("inventory_days", {
        propertyId: "property",
        roomTypeId: "room",
        stayDate: "2026-08-30",
      }),
      record("room_types", { id: "room", propertyId: "property" }),
    ]);
    expect(counts).toEqual({ room_types: 1, inventory_days: 1 });
    expect(calls[0]?.sql).toContain("INSERT INTO pms.room_types");
    expect(calls[1]?.sql).toContain("ON CONFLICT (property_id, room_type_id, stay_date)");
  });

  it("writes retained binding claims before channel connections", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push(sql);
        return { rowCount: JSON.parse(String(values?.[0])).length };
      },
    };
    await writeProductionPmsRecords(client as never, [
      record("channel_connections", { id: "connection", propertyId: "property" }),
      record("channel_binding_claims", {
        propertyId: "property",
        provider: "channex",
      }),
    ]);
    expect(calls[0]).toContain("INSERT INTO pms.channel_binding_claims");
    expect(calls[1]).toContain("INSERT INTO pms.channel_connections");
  });
});

function record(targetTable: string, row: Record<string, unknown>): PmsTargetRecord {
  return {
    targetProduct: "pms",
    targetTable,
    targetId: String(row["id"] ?? "inventory"),
    sourceDatabase: "pms",
    sourceTable: "room_types",
    sourceId: "source",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00Z",
    mutable: true,
    row,
  };
}
