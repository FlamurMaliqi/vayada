import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_PMS_SOURCE_TABLES,
  readProductionPmsSnapshot,
} from "./productionPmsSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production PMS snapshot reader", () => {
  it("returns only checksum-verified PMS rows and extraction time", async () => {
    const fixture = new PmsFixture();
    const result = await readProductionPmsSnapshot(fixture as never, RUN, {
      validateRun: async () => [],
    });
    expect(result.completedAt).toBe("2026-08-30T01:02:03.000Z");
    expect(result.snapshotAt).toBe("2026-08-30T00:02:03.000Z");
    expect(result.rows.map((row) => row.sourceTable)).toEqual(["hotels", "room_types"]);
  });

  it("rejects corrupt staged rows", async () => {
    const fixture = new PmsFixture();
    fixture.snapshots.find((row) => row.sourceTable === "room_types")!.rowChecksum = "f".repeat(64);
    await expect(
      readProductionPmsSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("corrupt pms.room_types rows");
  });

  it("rejects missing table evidence", async () => {
    const fixture = new PmsFixture();
    fixture.tables = fixture.tables.filter((row) => row.sourceTable !== "rooms");
    await expect(
      readProductionPmsSnapshot(fixture as never, RUN, { validateRun: async () => [] }),
    ).rejects.toThrow("incomplete pms.rooms evidence");
  });
});

class PmsFixture {
  snapshots = [snapshot("hotels", { id: "hotel" }), snapshot("room_types", { id: "room-type" })];
  tables = PRODUCTION_PMS_SOURCE_TABLES.map((sourceTable) => {
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
        rows: [
          {
            sourceDatabase: "pms",
            snapshotIdentifier: "snapshot-pms",
            snapshotAt: "2026-08-30 00:02:03+00",
            status: "completed",
          },
        ] as T[],
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
    snapshotIdentifier: "snapshot-pms",
    sourceTable,
    rowOrdinal: "1",
    rowChecksum: createHash("sha256").update(rowData).digest("hex"),
    rowData,
  };
}
