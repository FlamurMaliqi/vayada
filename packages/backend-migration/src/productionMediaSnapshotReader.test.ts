import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_MEDIA_SOURCE_TABLES,
  readProductionMediaSnapshot,
} from "./productionMediaSnapshotReader.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production media snapshot reader", () => {
  it("accepts only complete row-count and checksum-bound extraction evidence", async () => {
    const client = new SnapshotClient();
    const validateRun = vi.fn(async () => []);

    const snapshot = await readProductionMediaSnapshot(client as never, RUN, {
      validateRun: validateRun as never,
    });

    expect(validateRun).toHaveBeenCalledWith(client, RUN);
    expect(snapshot.completedAt).toBe("2026-08-30T00:00:00.000Z");
    expect(snapshot.rows).toHaveLength(Object.values(PRODUCTION_MEDIA_SOURCE_TABLES).flat().length);
  });

  it("rejects a row whose bytes no longer match the extraction ledger", async () => {
    await expect(
      readProductionMediaSnapshot(new SnapshotClient(true) as never, RUN, {
        validateRun: vi.fn(async () => []) as never,
      }),
    ).rejects.toThrow("corrupt booking.booking_addons rows");
  });
});

class SnapshotClient {
  constructor(private readonly corrupt = false) {}

  async query(sql: string) {
    if (sql.includes("FROM platform.source_extraction_runs"))
      return { rows: [{ completedAt: "2026-08-30T00:00:00Z" }] };
    if (sql.includes("FROM platform.source_extraction_sources"))
      return {
        rows: databases().map((sourceDatabase) => ({
          sourceDatabase,
          snapshotIdentifier: `snapshot:${sourceDatabase}`,
          status: "completed",
        })),
      };
    if (sql.includes("FROM platform.source_extraction_tables"))
      return {
        rows: databases().flatMap((sourceDatabase) =>
          PRODUCTION_MEDIA_SOURCE_TABLES[sourceDatabase].map((sourceTable) => {
            const evidence = rowEvidence(sourceDatabase, sourceTable);
            return {
              sourceDatabase,
              sourceSchema: "public",
              sourceTable,
              status: "completed",
              rowCount: "1",
              checksum: createHash("sha256").update(`${evidence.rowChecksum}\n`).digest("hex"),
            };
          }),
        ),
      };
    const sourceDatabase = databases().find((database) =>
      sql.includes(`FROM migration_source_${database}.snapshot_rows`),
    );
    if (sourceDatabase) {
      const rows = PRODUCTION_MEDIA_SOURCE_TABLES[sourceDatabase].map((sourceTable) =>
        rowEvidence(sourceDatabase, sourceTable),
      );
      if (this.corrupt && sourceDatabase === "booking") rows[0]!.rowChecksum = "f".repeat(64);
      return { rows };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function rowEvidence(
  sourceDatabase: keyof typeof PRODUCTION_MEDIA_SOURCE_TABLES,
  sourceTable: string,
) {
  const rowData = JSON.stringify({ id: `${sourceDatabase}:${sourceTable}` });
  return {
    snapshotIdentifier: `snapshot:${sourceDatabase}`,
    sourceTable,
    rowOrdinal: "1",
    rowChecksum: createHash("sha256").update(rowData).digest("hex"),
    rowData,
  };
}

function databases(): Array<keyof typeof PRODUCTION_MEDIA_SOURCE_TABLES> {
  return ["booking", "marketplace", "pms"];
}
