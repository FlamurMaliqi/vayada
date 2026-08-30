import { createHash } from "node:crypto";
import type pg from "pg";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export const PRODUCTION_FINANCE_SOURCE_TABLES = {
  booking: ["booking_hotels", "commission_rate_changes"],
  pms: [
    "affiliate_payout_settings",
    "affiliates",
    "booking_checkout_charges",
    "booking_checkout_records",
    "bookings",
    "hotel_payment_settings",
    "payments",
    "payouts",
    "stripe_billing_webhook_events",
  ],
} as const;

type SourceEvidence = { sourceDatabase: string; snapshotIdentifier: string; status: string };
type TableEvidence = {
  sourceDatabase: string;
  sourceTable: string;
  status: string;
  rowCount: string | null;
  checksum: string | null;
};
type SnapshotRow = {
  sourceDatabase: string;
  snapshotIdentifier: string;
  sourceTable: string;
  rowOrdinal: string;
  rowChecksum: string;
  rowData: string;
};

export type ProductionFinanceSnapshot = { rows: IdentitySourceRow[]; completedAt: string };

export async function readProductionFinanceSnapshot(
  client: QueryClient,
  runId: string,
  services: { validateRun: typeof readProductionIdentitySnapshot } = {
    validateRun: readProductionIdentitySnapshot,
  },
): Promise<ProductionFinanceSnapshot> {
  await services.validateRun(client, runId);
  const run = await client.query<{ completedAt: string | null }>(
    `SELECT finished_at::text AS "completedAt" FROM platform.source_extraction_runs WHERE run_id = $1`,
    [runId],
  );
  if (!run.rows[0]?.completedAt)
    throw new Error(`Source extraction ${runId} has no completion time`);
  const databases = Object.keys(PRODUCTION_FINANCE_SOURCE_TABLES);
  const sources = await client.query<SourceEvidence>(
    `SELECT source_database AS "sourceDatabase", snapshot_identifier AS "snapshotIdentifier", status
     FROM platform.source_extraction_sources WHERE run_id = $1 AND source_database = ANY($2::text[])`,
    [runId, databases],
  );
  const sourceByDatabase = new Map(sources.rows.map((row) => [row.sourceDatabase, row]));
  const requested = Object.entries(PRODUCTION_FINANCE_SOURCE_TABLES).flatMap(
    ([sourceDatabase, tables]) => tables.map((sourceTable) => ({ sourceDatabase, sourceTable })),
  );
  const ledger = await client.query<TableEvidence>(
    `SELECT source_database AS "sourceDatabase", source_table AS "sourceTable", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_tables WHERE run_id = $1 AND source_schema = 'public'
       AND source_database = ANY($2::text[]) ORDER BY source_database, source_table`,
    [runId, databases],
  );
  const evidence = new Map(
    ledger.rows.map((row) => [`${row.sourceDatabase}:${row.sourceTable}`, row]),
  );
  const rowsResult = await client.query<SnapshotRow>(
    `SELECT * FROM (
       SELECT 'booking' AS "sourceDatabase", snapshot_identifier AS "snapshotIdentifier", source_table AS "sourceTable",
              row_ordinal::text AS "rowOrdinal", row_checksum_sha256 AS "rowChecksum", row_data::text AS "rowData"
         FROM migration_source_booking.snapshot_rows WHERE run_id = $1 AND source_schema = 'public'
           AND source_table = ANY($2::text[])
       UNION ALL
       SELECT 'pms', snapshot_identifier, source_table, row_ordinal::text, row_checksum_sha256, row_data::text
         FROM migration_source_pms.snapshot_rows WHERE run_id = $1 AND source_schema = 'public'
           AND source_table = ANY($3::text[])
     ) source_rows
     ORDER BY "sourceDatabase", "sourceTable", "rowOrdinal"::bigint`,
    [runId, PRODUCTION_FINANCE_SOURCE_TABLES.booking, PRODUCTION_FINANCE_SOURCE_TABLES.pms],
  );
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rowsResult.rows) {
    const key = `${row.sourceDatabase}:${row.sourceTable}`;
    const values = grouped.get(key);
    if (values) values.push(row);
    else grouped.set(key, [row]);
  }
  const rows: IdentitySourceRow[] = [];
  for (const item of requested) {
    const key = `${item.sourceDatabase}:${item.sourceTable}`;
    const source = sourceByDatabase.get(item.sourceDatabase);
    const table = evidence.get(key);
    const tableRows = grouped.get(key) ?? [];
    const expectedCount = Number(table?.rowCount);
    if (
      source?.status !== "completed" ||
      table?.status !== "completed" ||
      table.rowCount === null ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      !/^[0-9a-f]{64}$/.test(table.checksum ?? "") ||
      tableRows.length !== expectedCount
    )
      throw new Error(`Source extraction ${runId} has incomplete ${key} evidence`);
    const checksum = createHash("sha256");
    for (const [index, row] of tableRows.entries()) {
      const actual = createHash("sha256").update(row.rowData).digest("hex");
      if (
        row.snapshotIdentifier !== source.snapshotIdentifier ||
        row.rowOrdinal !== String(index + 1) ||
        row.rowChecksum !== actual
      )
        throw new Error(`Source extraction ${runId} has corrupt ${key} rows`);
      checksum.update(`${actual}\n`);
      const data = JSON.parse(row.rowData) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(`Source extraction ${runId} has invalid ${key} JSON`);
      rows.push({
        sourceDatabase: item.sourceDatabase as "booking" | "pms",
        sourceTable: item.sourceTable,
        rowOrdinal: index + 1,
        data: data as Record<string, unknown>,
      });
    }
    if (checksum.digest("hex") !== table.checksum)
      throw new Error(`Source extraction ${runId} mismatches ${key} checksum`);
  }
  return { rows, completedAt: new Date(run.rows[0].completedAt).toISOString() };
}
