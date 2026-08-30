import { describe, expect, it } from "vitest";

import type { MarketplaceTargetRecord } from "./productionMarketplaceTypes.js";
import { writeProductionMarketplaceRecords } from "./productionMarketplaceWriter.js";

describe("production Marketplace writer", () => {
  it("writes dependencies in order and updates only the addressed target key", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rowCount: JSON.parse(String(values?.[0])).length };
      },
    };
    const counts = await writeProductionMarketplaceRecords(client as never, [
      record("collaborations", { id: "collaboration" }),
      record("creator_profiles", { id: "creator" }),
      record("marketplace_hotel_profiles", { propertyId: "property" }, "property"),
    ]);
    expect(counts).toEqual({
      creator_profiles: 1,
      marketplace_hotel_profiles: 1,
      collaborations: 1,
    });
    expect(calls[0]?.sql).toContain("INSERT INTO marketplace.creator_profiles");
    expect(calls[1]?.sql).toContain("ON CONFLICT (property_id)");
    expect(calls[2]?.sql).toContain("INSERT INTO marketplace.collaborations");
  });
});

function record(
  targetTable: string,
  row: Record<string, unknown>,
  targetId = String(row["id"]),
): MarketplaceTargetRecord {
  return {
    targetProduct: "marketplace",
    targetTable,
    targetId,
    sourceDatabase: "marketplace",
    sourceTable: "creators",
    sourceId: "source",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00Z",
    mutable: true,
    row,
  };
}
