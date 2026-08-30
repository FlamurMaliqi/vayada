import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_BOOKING_SOURCE_TABLES,
  readProductionBookingSnapshot,
} from "./productionBookingSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Booking snapshot reader", () => {
  it("returns only checksum-verified Booking rows and extraction time", async () => {
    const fixture = new BookingFixture();
    const result = await readProductionBookingSnapshot(fixture as never, RUN, {
      validateRun: async () => [],
    });
    expect(result.completedAt).toBe("2026-08-30T01:02:03.000Z");
    expect(result.rows.map((row) => `${row.sourceDatabase}.${row.sourceTable}`)).toEqual([
      "booking.booking_addons",
      "pms.bookings",
    ]);
  });

  it("rejects corrupt staged rows", async () => {
    const fixture = new BookingFixture();
    fixture.snapshots.pms[0]!.rowChecksum = "f".repeat(64);
    await expect(
      readProductionBookingSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("corrupt pms.bookings rows");
  });

  it("rejects missing table evidence", async () => {
    const fixture = new BookingFixture();
    fixture.tables = fixture.tables.filter((row) => row.sourceTable !== "booking_drafts");
    await expect(
      readProductionBookingSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("incomplete pms.booking_drafts evidence");
  });
});

class BookingFixture {
  snapshots: Record<string, SnapshotRow[]> = {
    booking: [snapshot("booking", "booking_addons", { id: "addon" })],
    pms: [snapshot("pms", "bookings", { id: "booking" })],
  };
  sources = Object.keys(PRODUCTION_BOOKING_SOURCE_TABLES).map((sourceDatabase) => ({
    sourceDatabase,
    snapshotIdentifier: `snapshot-${sourceDatabase}`,
    status: "completed",
  }));
  tables = Object.entries(PRODUCTION_BOOKING_SOURCE_TABLES).flatMap(([database, tables]) =>
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
    if (sql.includes("source_extraction_runs"))
      return { rows: [{ completedAt: "2026-08-30 01:02:03+00" }] as T[] };
    if (sql.includes("source_extraction_sources")) return { rows: this.sources as T[] };
    if (sql.includes("source_extraction_tables")) return { rows: this.tables as T[] };
    const database = /migration_source_(booking|pms)/.exec(sql)?.[1];
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
