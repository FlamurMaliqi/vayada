import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  readProductionIdentitySnapshot,
  VAY_1350_ACTIVE_SOURCE_TABLES,
} from "./productionIdentitySnapshotReader.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";

const RUN = "vay1351-0123456789abcdef01234567";
const USER = "11111111-1111-4111-8111-111111111111";

describe("production identity snapshot reader", () => {
  it("accepts only ledger-matching immutable rows from all consumed tables", async () => {
    const fixture = new SnapshotFixture();

    const rows = await readProductionIdentitySnapshot(fixture as never, RUN);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.sourceDatabase}.${row.sourceTable}`)).toEqual([
      "auth.users",
      "booking.booking_hotels",
    ]);
    expect(rows[0]?.data["id"]).toBe(USER);
  });

  it("rejects a completed ledger whose staged content is corrupt", async () => {
    const fixture = new SnapshotFixture();
    fixture.snapshots.auth[0]!.rowChecksum = "f".repeat(64);

    await expect(readProductionIdentitySnapshot(fixture as never, RUN)).rejects.toThrow(
      "corrupt auth.users rows",
    );
  });

  it("rejects a missing consumed-table ledger", async () => {
    const fixture = new SnapshotFixture();
    fixture.tables = fixture.tables.filter((row) => row.sourceTable !== "gdpr_requests");

    await expect(readProductionIdentitySnapshot(fixture as never, RUN)).rejects.toThrow(
      "incomplete auth.public.gdpr_requests ledger",
    );
  });

  it("rejects snapshots from a different source-schema inventory", async () => {
    const fixture = new SnapshotFixture();
    fixture.revision = "0".repeat(40);

    await expect(readProductionIdentitySnapshot(fixture as never, RUN)).rejects.toThrow(
      "unsupported schema revision",
    );
  });

  it("rejects source-level row-count or checksum disagreement", async () => {
    const countMismatch = new SnapshotFixture();
    countMismatch.sources[0]!.rowCount = "999";
    await expect(readProductionIdentitySnapshot(countMismatch as never, RUN)).rejects.toThrow(
      "mismatches auth source aggregate",
    );

    const checksumMismatch = new SnapshotFixture();
    checksumMismatch.sources[0]!.checksum = "f".repeat(64);
    await expect(readProductionIdentitySnapshot(checksumMismatch as never, RUN)).rejects.toThrow(
      "mismatches auth source aggregate",
    );
  });
});

class SnapshotFixture {
  revision = VAY_1350_INVENTORY_REVISION;
  snapshots: Record<string, SnapshotRow[]> = {
    auth: [snapshotRow("auth", "users", { id: USER })],
    booking: [snapshotRow("booking", "booking_hotels", { id: USER })],
    marketplace: [],
    pms: [],
  };
  tables = Object.entries(VAY_1350_ACTIVE_SOURCE_TABLES).flatMap(([database, tables]) =>
    tables.map((qualifiedTable) => {
      const [sourceSchema, sourceTable] = qualifiedTable.split(".") as [string, string];
      const rows = this.snapshots[database]!.filter((row) => row.sourceTable === sourceTable);
      const checksum = createHash("sha256");
      for (const row of rows) checksum.update(`${row.rowChecksum}\n`);
      return {
        sourceDatabase: database,
        sourceSchema,
        sourceTable,
        status: "completed",
        rowCount: String(rows.length),
        checksum: checksum.digest("hex"),
      };
    }),
  );
  sources = Object.keys(VAY_1350_ACTIVE_SOURCE_TABLES).map((sourceDatabase) => {
    const tables = this.tables.filter((row) => row.sourceDatabase === sourceDatabase);
    const checksum = createHash("sha256");
    for (const table of tables)
      checksum.update(
        `${table.sourceSchema}.${table.sourceTable}|${table.rowCount}|${table.checksum}\n`,
      );
    return {
      sourceDatabase,
      snapshotIdentifier: `snapshot-${sourceDatabase}`,
      expectedFingerprint: "a".repeat(32),
      actualFingerprint: "a".repeat(32),
      status: "completed",
      rowCount: String(tables.reduce((sum, table) => sum + Number(table.rowCount), 0)),
      checksum: checksum.digest("hex"),
    };
  });

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("source_extraction_runs"))
      return { rows: [{ status: "completed", revision: this.revision }] as T[] };
    if (sql.includes("source_extraction_sources")) return { rows: this.sources as T[] };
    if (sql.includes("source_extraction_tables")) return { rows: this.tables as T[] };
    const database = /migration_source_(auth|booking|marketplace|pms)/.exec(sql)?.[1];
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
function snapshotRow(
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
