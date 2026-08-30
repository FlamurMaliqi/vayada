import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_FINANCE_SOURCE_TABLES,
  readProductionFinanceSnapshot,
} from "./productionFinanceSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Finance snapshot reader", () => {
  it("verifies both Booking and PMS snapshot evidence", async () => {
    const fixture = new FinanceFixture();
    const result = await readProductionFinanceSnapshot(fixture as never, RUN, {
      validateRun: async () => [],
    });
    expect(result.completedAt).toBe("2026-08-30T01:02:03.000Z");
    expect(result.rows.map((row) => `${row.sourceDatabase}.${row.sourceTable}`)).toEqual([
      "booking.booking_hotels",
      "pms.payments",
    ]);
  });

  it("rejects corrupt source rows and missing table ledgers", async () => {
    const corrupt = new FinanceFixture();
    corrupt.snapshots.find((row) => row.sourceTable === "payments")!.rowChecksum = "f".repeat(64);
    await expect(
      readProductionFinanceSnapshot(corrupt as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("corrupt pms:payments rows");
    const missing = new FinanceFixture();
    missing.tables = missing.tables.filter((row) => row.sourceTable !== "payouts");
    await expect(
      readProductionFinanceSnapshot(missing as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("incomplete pms:payouts evidence");
  });
});

class FinanceFixture {
  snapshots = [
    snapshot("booking", "booking_hotels", { id: "hotel" }),
    snapshot("pms", "payments", { id: "payment" }),
  ];
  tables = Object.entries(PRODUCTION_FINANCE_SOURCE_TABLES).flatMap(([sourceDatabase, tables]) =>
    tables.map((sourceTable) => {
      const rows = this.snapshots.filter(
        (row) => row.sourceDatabase === sourceDatabase && row.sourceTable === sourceTable,
      );
      const checksum = createHash("sha256");
      for (const row of rows) checksum.update(`${row.rowChecksum}\n`);
      return {
        sourceDatabase,
        sourceTable,
        status: "completed",
        rowCount: String(rows.length),
        checksum: checksum.digest("hex"),
      };
    }),
  );

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("source_extraction_runs"))
      return { rows: [{ completedAt: "2026-08-30 01:02:03+00" }] as T[] };
    if (sql.includes("source_extraction_sources"))
      return {
        rows: [
          {
            sourceDatabase: "booking",
            snapshotIdentifier: "snapshot-booking",
            status: "completed",
          },
          { sourceDatabase: "pms", snapshotIdentifier: "snapshot-pms", status: "completed" },
        ] as T[],
      };
    if (sql.includes("source_extraction_tables")) return { rows: this.tables as T[] };
    return { rows: this.snapshots as T[] };
  }
}

function snapshot(
  sourceDatabase: "booking" | "pms",
  sourceTable: string,
  data: Record<string, unknown>,
) {
  const rowData = JSON.stringify(data);
  return {
    sourceDatabase,
    snapshotIdentifier: `snapshot-${sourceDatabase}`,
    sourceTable,
    rowOrdinal: "1",
    rowChecksum: createHash("sha256").update(rowData).digest("hex"),
    rowData,
  };
}
