import { describe, expect, it } from "vitest";

import type { MarketplaceTargetRecord } from "./productionMarketplaceTypes.js";
import {
  writeProductionMarketplaceQuarantines,
  writeProductionMarketplaceRecords,
} from "./productionMarketplaceWriter.js";

const RUN = "vay1351-0123456789abcdef01234567";

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

  it("stores only exact hash evidence for Marketplace quarantines", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return sql.includes("SELECT count(*)") ? { rows: [{ count: 1 }] } : { rowCount: 1 };
      },
    };

    const count = await writeProductionMarketplaceQuarantines(
      client as never,
      [
        {
          sourceTable: "invite_codes",
          sourceId: "source",
          sourceField: "data",
          sourceValueSha256: "b".repeat(64),
          reasonCode: "EXPIRED_INVITE_MEDIA_PAYLOAD_OMITTED",
          retentionUntil: "2028-08-03",
        },
      ],
      RUN,
    );

    expect(count).toBe(1);
    expect(calls[0]?.sql).toContain("production_marketplace_migration_quarantines");
    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(JSON.stringify(calls[0]?.values)).not.toContain("legacy-media.example");
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
