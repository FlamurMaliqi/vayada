import { createHash } from "node:crypto";
import type pg from "pg";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type BookingDatabase = "booking" | "pms";
type SourceEvidence = {
  sourceDatabase: BookingDatabase;
  snapshotIdentifier: string;
  status: string;
};
type TableEvidence = {
  sourceDatabase: BookingDatabase;
  sourceTable: string;
  status: string;
  rowCount: string | null;
  checksum: string | null;
};
type SnapshotRow = {
  snapshotIdentifier: string;
  sourceTable: string;
  rowOrdinal: string;
  rowChecksum: string;
  rowData: string;
};

export type ProductionBookingSnapshot = { rows: IdentitySourceRow[]; completedAt: string };

export const PRODUCTION_BOOKING_SOURCE_TABLES: Record<BookingDatabase, readonly string[]> = {
  booking: [
    "booking_addons",
    "booking_events",
    "booking_hotels",
    "booking_promo_codes",
  ],
  pms: [
    "booking_additional_guests",
    "booking_change_requests",
    "booking_drafts",
    "booking_promo_usage_state",
    "bookings",
  ],
};

const databases = Object.keys(PRODUCTION_BOOKING_SOURCE_TABLES) as BookingDatabase[];

export async function readProductionBookingSnapshot(
  client: QueryClient,
  runId: string,
  services: { validateRun: typeof readProductionIdentitySnapshot } = {
    validateRun: readProductionIdentitySnapshot,
  },
): Promise<ProductionBookingSnapshot> {
  await services.validateRun(client, runId);
  const run = await client.query<{ completedAt: string | null }>(
    `SELECT finished_at::text AS "completedAt"
     FROM platform.source_extraction_runs WHERE run_id = $1`,
    [runId],
  );
  if (!run.rows[0]?.completedAt)
    throw new Error(`Source extraction ${runId} has no completion time`);
  const sourceResult = await client.query<SourceEvidence>(
    `SELECT source_database AS "sourceDatabase", snapshot_identifier AS "snapshotIdentifier", status
     FROM platform.source_extraction_sources
     WHERE run_id = $1 AND source_database = ANY($2::text[])
     ORDER BY source_database`,
    [runId, databases],
  );
  const sources = new Map(sourceResult.rows.map((row) => [row.sourceDatabase, row]));
  if (
    sourceResult.rows.length !== databases.length ||
    databases.some((database) => sources.get(database)?.status !== "completed")
  )
    throw new Error(`Source extraction ${runId} has incomplete Booking source evidence`);

  const tableResult = await client.query<TableEvidence>(
    `SELECT source_database AS "sourceDatabase", source_table AS "sourceTable", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_tables
     WHERE run_id = $1 AND source_database = ANY($2::text[])
       AND source_schema = 'public' AND source_table = ANY($3::text[])
     ORDER BY source_database, source_table`,
    [runId, databases, [...new Set(Object.values(PRODUCTION_BOOKING_SOURCE_TABLES).flat())]],
  );
  const evidence = new Map(
    tableResult.rows.map((row) => [`${row.sourceDatabase}:${row.sourceTable}`, row]),
  );
  const loaded: IdentitySourceRow[] = [];

  for (const database of databases) {
    const tables = PRODUCTION_BOOKING_SOURCE_TABLES[database];
    const snapshot = await client.query<SnapshotRow>(
      `SELECT snapshot_identifier AS "snapshotIdentifier", source_table AS "sourceTable",
              row_ordinal::text AS "rowOrdinal", row_checksum_sha256 AS "rowChecksum",
              row_data::text AS "rowData"
       FROM migration_source_${database}.snapshot_rows
       WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
       ORDER BY source_table, row_ordinal`,
      [runId, tables],
    );
    const grouped = new Map(tables.map((table) => [table, [] as SnapshotRow[]]));
    for (const row of snapshot.rows) grouped.get(row.sourceTable)?.push(row);

    for (const table of tables) {
      const ledger = evidence.get(`${database}:${table}`);
      const rows = grouped.get(table)!;
      const expectedCount = Number(ledger?.rowCount);
      if (
        ledger?.status !== "completed" ||
        ledger.rowCount === null ||
        !Number.isSafeInteger(expectedCount) ||
        expectedCount < 0 ||
        !/^[0-9a-f]{64}$/.test(ledger.checksum ?? "") ||
        rows.length !== expectedCount
      )
        throw new Error(`Source extraction ${runId} has incomplete ${database}.${table} evidence`);
      const checksum = createHash("sha256");
      for (const [index, row] of rows.entries()) {
        const actual = createHash("sha256").update(row.rowData).digest("hex");
        if (
          row.snapshotIdentifier !== sources.get(database)!.snapshotIdentifier ||
          row.rowOrdinal !== String(index + 1) ||
          row.rowChecksum !== actual
        )
          throw new Error(`Source extraction ${runId} has corrupt ${database}.${table} rows`);
        checksum.update(`${actual}\n`);
        const data = JSON.parse(row.rowData) as unknown;
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error(`Source extraction ${runId} has invalid ${database}.${table} JSON`);
        loaded.push({
          sourceDatabase: database,
          sourceTable: table,
          rowOrdinal: index + 1,
          data: data as Record<string, unknown>,
        });
      }
      if (checksum.digest("hex") !== ledger.checksum)
        throw new Error(`Source extraction ${runId} mismatches ${database}.${table} checksum`);
    }
  }
  return { rows: loaded, completedAt: new Date(run.rows[0].completedAt).toISOString() };
}
