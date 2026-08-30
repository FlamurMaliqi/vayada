import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_CATALOG_SOURCE_TABLES,
  readProductionCatalogSnapshot,
} from "./productionCatalogSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production catalog snapshot reader", () => {
  it("returns only checksum-verified catalog rows", async () => {
    const fixture = new CatalogFixture();
    const rows = await readProductionCatalogSnapshot(fixture as never, RUN, {
      validateRun: async () => [],
    });

    expect(rows.map((row) => `${row.sourceDatabase}.${row.sourceTable}`)).toEqual([
      "booking.booking_hotel_translations",
      "booking.booking_hotels",
    ]);
    expect(rows[1]?.data["name"]).toBe("Hotel Source");
  });

  it("rejects corrupt staged rows", async () => {
    const fixture = new CatalogFixture();
    fixture.snapshots.booking[1]!.rowChecksum = "f".repeat(64);

    await expect(
      readProductionCatalogSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("corrupt booking.booking_hotels rows");
  });

  it("rejects missing table evidence before transforming", async () => {
    const fixture = new CatalogFixture();
    fixture.tables = fixture.tables.filter((row) => row.sourceTable !== "hotel_profiles");

    await expect(
      readProductionCatalogSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("incomplete marketplace.hotel_profiles evidence");
  });
});

class CatalogFixture {
  snapshots: Record<string, SnapshotRow[]> = {
    booking: [
      snapshot("booking", "booking_hotel_translations", { id: "translation" }),
      snapshot("booking", "booking_hotels", { id: "hotel", name: "Hotel Source" }),
    ],
    marketplace: [],
    pms: [],
  };
  sources = Object.keys(PRODUCTION_CATALOG_SOURCE_TABLES).map((sourceDatabase) => ({
    sourceDatabase,
    snapshotIdentifier: `snapshot-${sourceDatabase}`,
    status: "completed",
  }));
  tables = Object.entries(PRODUCTION_CATALOG_SOURCE_TABLES).flatMap(([database, tables]) =>
    tables.map((sourceTable) => {
      const rows = this.snapshots[database]!.filter((row) => row.sourceTable === sourceTable);
      const checksum = createHash("sha256");
      for (const row of rows) checksum.update(`${row.rowChecksum}\n`);
      return {
        sourceDatabase: database,
        sourceTable,
        status: "completed",
        rowCount: String(rows.length),
        checksum: checksum.digest("hex"),
      };
    }),
  );

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("source_extraction_sources")) return { rows: this.sources as T[] };
    if (sql.includes("source_extraction_tables")) return { rows: this.tables as T[] };
    const database = /migration_source_(booking|marketplace|pms)/.exec(sql)?.[1];
    return { rows: (database ? this.snapshots[database] : []) as T[] };
  }
}

type SnapshotRow = {
  snapshotIdentifier: string;
  sourceTable: string;
  rowOrdinal: string;
  rowChecksum: string;
  rowData: string;
};
function snapshot(
  database: string,
  sourceTable: string,
  data: Record<string, unknown>,
): SnapshotRow {
  const rowData = JSON.stringify(data);
  return {
    snapshotIdentifier: `snapshot-${database}`,
    sourceTable,
    rowOrdinal: "1",
    rowChecksum: createHash("sha256").update(rowData).digest("hex"),
    rowData,
  };
}
