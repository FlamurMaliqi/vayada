import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_MARKETPLACE_SOURCE_TABLES,
  readProductionMarketplaceSnapshot,
} from "./productionMarketplaceSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Marketplace snapshot reader", () => {
  it("returns only checksum-verified Marketplace rows", async () => {
    const fixture = new MarketplaceFixture();
    const result = await readProductionMarketplaceSnapshot(fixture as never, RUN, {
      validateRun: async () => [],
    });
    expect(result.completedAt).toBe("2026-08-30T01:02:03.000Z");
    expect(result.rows.map((row) => row.sourceTable)).toEqual(["creators", "hotel_listings"]);
  });

  it("rejects corrupt staged rows", async () => {
    const fixture = new MarketplaceFixture();
    fixture.snapshots.find((row) => row.sourceTable === "hotel_listings")!.rowChecksum = "f".repeat(
      64,
    );
    await expect(
      readProductionMarketplaceSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("corrupt marketplace.hotel_listings rows");
  });

  it("rejects missing table evidence", async () => {
    const fixture = new MarketplaceFixture();
    fixture.tables = fixture.tables.filter((row) => row.sourceTable !== "trips");
    await expect(
      readProductionMarketplaceSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("incomplete marketplace.trips evidence");
  });
});

class MarketplaceFixture {
  snapshots = [
    snapshot("creators", { id: "creator" }),
    snapshot("hotel_listings", { id: "offer" }),
  ];
  tables = PRODUCTION_MARKETPLACE_SOURCE_TABLES.map((sourceTable) => {
    const rows = this.snapshots.filter((row) => row.sourceTable === sourceTable);
    const checksum = createHash("sha256");
    for (const row of rows) checksum.update(`${row.rowChecksum}\n`);
    return {
      sourceTable,
      status: "completed",
      rowCount: String(rows.length),
      checksum: checksum.digest("hex"),
    };
  });

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("source_extraction_runs"))
      return { rows: [{ completedAt: "2026-08-30 01:02:03+00" }] as T[] };
    if (sql.includes("source_extraction_sources"))
      return {
        rows: [{ snapshotIdentifier: "snapshot-marketplace", status: "completed" }] as T[],
      };
    if (sql.includes("source_extraction_tables")) return { rows: this.tables as T[] };
    return { rows: this.snapshots as T[] };
  }
}

type SnapshotRow = {
  snapshotIdentifier: string;
  sourceTable: string;
  rowOrdinal: string;
  rowChecksum: string;
  rowData: string;
};

function snapshot(sourceTable: string, data: Record<string, unknown>): SnapshotRow {
  const rowData = JSON.stringify(data);
  return {
    snapshotIdentifier: "snapshot-marketplace",
    sourceTable,
    rowOrdinal: "1",
    rowChecksum: createHash("sha256").update(rowData).digest("hex"),
    rowData,
  };
}
