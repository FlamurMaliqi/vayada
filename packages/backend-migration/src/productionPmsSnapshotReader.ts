import { createHash } from "node:crypto";
import type pg from "pg";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type SourceEvidence = {
  sourceDatabase: "pms";
  snapshotIdentifier: string;
  status: string;
};
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

export type ProductionPmsSnapshot = { rows: IdentitySourceRow[]; completedAt: string };

export const PRODUCTION_PMS_SOURCE_TABLES = [
  "booking_checkin_records",
  "booking_checkout_charges",
  "booking_checkout_records",
  "booking_drafts",
  "booking_events",
  "booking_notes",
  "booking_notification_deliveries",
  "booking_rooms",
  "bookings",
  "cancellation_policies",
  "channex_booking_mappings",
  "channex_channel_markups",
  "channex_connections",
  "channex_rate_plan_mappings",
  "channex_room_type_mappings",
  "channex_webhook_events",
  "checkin_checklist_templates",
  "checkout_inspection_templates",
  "linked_inventory_group_members",
  "linked_inventory_groups",
  "message_attachments",
  "message_threads",
  "messages",
  "room_blocks",
  "room_types",
  "rooms",
] as const;

export async function readProductionPmsSnapshot(
  client: QueryClient,
  runId: string,
  services: { validateRun: typeof readProductionIdentitySnapshot } = {
    validateRun: readProductionIdentitySnapshot,
  },
): Promise<ProductionPmsSnapshot> {
  await services.validateRun(client, runId);
  const run = await client.query<{ completedAt: string | null }>(
    `SELECT completed_at::text AS "completedAt"
     FROM platform.source_extraction_runs WHERE id = $1`,
    [runId],
  );
  if (!run.rows[0]?.completedAt)
    throw new Error(`Source extraction ${runId} has no completion time`);

  const sourceResult = await client.query<SourceEvidence>(
    `SELECT source_database AS "sourceDatabase", snapshot_identifier AS "snapshotIdentifier", status
     FROM platform.source_extraction_sources
     WHERE run_id = $1 AND source_database = 'pms'`,
    [runId],
  );
  const source = sourceResult.rows[0];
  if (sourceResult.rows.length !== 1 || source?.status !== "completed")
    throw new Error(`Source extraction ${runId} has incomplete PMS source evidence`);

  const tableResult = await client.query<TableEvidence>(
    `SELECT source_table AS "sourceTable", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_tables
     WHERE run_id = $1 AND source_database = 'pms' AND source_schema = 'public'
       AND source_table = ANY($2::text[])
     ORDER BY source_table`,
    [runId, PRODUCTION_PMS_SOURCE_TABLES],
  );
  const evidence = new Map(tableResult.rows.map((row) => [row.sourceTable, row]));
  const snapshot = await client.query<SnapshotRow>(
    `SELECT snapshot_identifier AS "snapshotIdentifier", source_table AS "sourceTable",
            row_ordinal::text AS "rowOrdinal", row_checksum_sha256 AS "rowChecksum",
            row_data::text AS "rowData"
     FROM migration_source_pms.snapshot_rows
     WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
     ORDER BY source_table, row_ordinal`,
    [runId, PRODUCTION_PMS_SOURCE_TABLES],
  );
  const grouped = new Map(PRODUCTION_PMS_SOURCE_TABLES.map((table) => [table, [] as SnapshotRow[]]));
  for (const row of snapshot.rows) grouped.get(row.sourceTable as (typeof PRODUCTION_PMS_SOURCE_TABLES)[number])?.push(row);

  const loaded: IdentitySourceRow[] = [];
  for (const table of PRODUCTION_PMS_SOURCE_TABLES) {
    const ledger = evidence.get(table);
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
      throw new Error(`Source extraction ${runId} has incomplete pms.${table} evidence`);
    const checksum = createHash("sha256");
    for (const [index, row] of rows.entries()) {
      const actual = createHash("sha256").update(row.rowData).digest("hex");
      if (
        row.snapshotIdentifier !== source.snapshotIdentifier ||
        row.rowOrdinal !== String(index + 1) ||
        row.rowChecksum !== actual
      )
        throw new Error(`Source extraction ${runId} has corrupt pms.${table} rows`);
      checksum.update(`${actual}\n`);
      const data = JSON.parse(row.rowData) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(`Source extraction ${runId} has invalid pms.${table} JSON`);
      loaded.push({
        sourceDatabase: "pms",
        sourceTable: table,
        rowOrdinal: index + 1,
        data: data as Record<string, unknown>,
      });
    }
    if (checksum.digest("hex") !== ledger.checksum)
      throw new Error(`Source extraction ${runId} mismatches pms.${table} checksum`);
  }
  return { rows: loaded, completedAt: new Date(run.rows[0].completedAt).toISOString() };
}
