import { createHash } from "node:crypto";
import type pg from "pg";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export const PRODUCTION_MARKETPLACE_SOURCE_TABLES = [
  "chat_messages",
  "collaboration_deliverables",
  "collaborations",
  "creator_platforms",
  "creator_ratings",
  "creators",
  "external_collaborations",
  "hotel_listings",
  "hotel_profiles",
  "invite_codes",
  "listing_collaboration_offerings",
  "listing_creator_requirements",
  "newsletter_preferences",
  "notifications",
  "trips",
] as const;

type SourceEvidence = { snapshotIdentifier: string; status: string };
type TableEvidence = {
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

export type ProductionMarketplaceSnapshot = {
  rows: IdentitySourceRow[];
  completedAt: string;
};

export async function readProductionMarketplaceSnapshot(
  client: QueryClient,
  runId: string,
  services: { validateRun: (client: QueryClient, runId: string) => Promise<unknown> } = {
    validateRun: readProductionIdentitySnapshot,
  },
): Promise<ProductionMarketplaceSnapshot> {
  await services.validateRun(client, runId);
  const run = await client.query<{ completedAt: string | null }>(
    `SELECT finished_at::text AS "completedAt"
     FROM platform.source_extraction_runs WHERE run_id = $1`,
    [runId],
  );
  if (!run.rows[0]?.completedAt)
    throw new Error(`Source extraction ${runId} has no completion time`);

  const sourceResult = await client.query<SourceEvidence>(
    `SELECT snapshot_identifier AS "snapshotIdentifier", status
     FROM platform.source_extraction_sources
     WHERE run_id = $1 AND source_database = 'marketplace'`,
    [runId],
  );
  const source = sourceResult.rows[0];
  if (sourceResult.rows.length !== 1 || source?.status !== "completed")
    throw new Error(`Source extraction ${runId} has incomplete Marketplace source evidence`);

  const tableResult = await client.query<TableEvidence>(
    `SELECT source_table AS "sourceTable", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_tables
     WHERE run_id = $1 AND source_database = 'marketplace' AND source_schema = 'public'
       AND source_table = ANY($2::text[])
     ORDER BY source_table`,
    [runId, PRODUCTION_MARKETPLACE_SOURCE_TABLES],
  );
  const evidence = new Map(tableResult.rows.map((row) => [row.sourceTable, row]));
  const snapshot = await client.query<SnapshotRow>(
    `SELECT snapshot_identifier AS "snapshotIdentifier", source_table AS "sourceTable",
            row_ordinal::text AS "rowOrdinal", row_checksum_sha256 AS "rowChecksum",
            row_data::text AS "rowData"
     FROM migration_source_marketplace.snapshot_rows
     WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
     ORDER BY source_table, row_ordinal`,
    [runId, PRODUCTION_MARKETPLACE_SOURCE_TABLES],
  );
  const grouped = new Map<string, SnapshotRow[]>(
    PRODUCTION_MARKETPLACE_SOURCE_TABLES.map((table) => [table, [] as SnapshotRow[]]),
  );
  for (const row of snapshot.rows) grouped.get(row.sourceTable)?.push(row);

  const rows: IdentitySourceRow[] = [];
  for (const table of PRODUCTION_MARKETPLACE_SOURCE_TABLES) {
    const ledger = evidence.get(table);
    const tableRows = grouped.get(table)!;
    const expectedCount = Number(ledger?.rowCount);
    if (
      ledger?.status !== "completed" ||
      ledger.rowCount === null ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      !/^[0-9a-f]{64}$/.test(ledger.checksum ?? "") ||
      tableRows.length !== expectedCount
    )
      throw new Error(`Source extraction ${runId} has incomplete marketplace.${table} evidence`);
    const checksum = createHash("sha256");
    for (const [index, row] of tableRows.entries()) {
      const actual = createHash("sha256").update(row.rowData).digest("hex");
      if (
        row.snapshotIdentifier !== source.snapshotIdentifier ||
        row.rowOrdinal !== String(index + 1) ||
        row.rowChecksum !== actual
      )
        throw new Error(`Source extraction ${runId} has corrupt marketplace.${table} rows`);
      checksum.update(`${actual}\n`);
      const data = JSON.parse(row.rowData) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(`Source extraction ${runId} has invalid marketplace.${table} JSON`);
      rows.push({
        sourceDatabase: "marketplace",
        sourceTable: table,
        rowOrdinal: index + 1,
        data: data as Record<string, unknown>,
      });
    }
    if (checksum.digest("hex") !== ledger.checksum)
      throw new Error(`Source extraction ${runId} mismatches marketplace.${table} checksum`);
  }
  return { rows, completedAt: new Date(run.rows[0].completedAt).toISOString() };
}
