import type pg from "pg";

import {
  PRODUCTION_FINANCE_TABLES,
  PRODUCTION_FINANCE_WRITE_ORDER,
} from "./productionFinanceTables.js";
import type {
  FinanceTargetRecord,
  ProductionFinanceDisposition,
} from "./productionFinanceTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function writeProductionFinanceRecords(
  client: QueryClient,
  records: FinanceTargetRecord[],
): Promise<Record<string, number>> {
  const grouped = new Map<string, FinanceTargetRecord[]>();
  for (const record of records) {
    const rows = grouped.get(record.targetTable);
    if (rows) rows.push(record);
    else grouped.set(record.targetTable, [record]);
  }
  const counts: Record<string, number> = {};
  for (const [targetTable, rows] of [...grouped].sort(
    ([left], [right]) => order(left) - order(right),
  )) {
    const definition = PRODUCTION_FINANCE_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported Finance writer ${targetTable}`);
    const aliases = definition.columns
      .map(([jsonKey, , type]) => `"${jsonKey}" ${type}`)
      .join(", ");
    const names = definition.columns.map(([, sqlName]) => sqlName).join(", ");
    const values = definition.columns.map(([jsonKey]) => `source."${jsonKey}"`).join(", ");
    const updates = definition.columns
      .filter(([, sqlName]) => !definition.key.includes(sqlName) && sqlName !== "created_at")
      .map(([, sqlName]) => `${sqlName} = EXCLUDED.${sqlName}`)
      .join(", ");
    const conflict = rows.every((row) => !row.mutable)
      ? `ON CONFLICT (${definition.key.join(", ")}) DO NOTHING`
      : `ON CONFLICT (${definition.key.join(", ")}) DO UPDATE SET ${updates}`;
    const result = await client.query(
      `INSERT INTO ${definition.table} (${names})
       SELECT ${values} FROM jsonb_to_recordset($1::jsonb) AS source(${aliases})
       ${conflict}`,
      [JSON.stringify(rows.map((row) => row.row))],
    );
    counts[targetTable] = result.rowCount ?? 0;
  }
  return counts;
}

export async function writeProductionFinanceDispositions(
  client: QueryClient,
  dispositions: ProductionFinanceDisposition[],
  sourceRunId: string,
): Promise<number> {
  const values = [JSON.stringify(dispositions), sourceRunId];
  if (dispositions.length)
    await client.query(
      `INSERT INTO platform.production_finance_migration_dispositions
         (source_run_id, source_database, source_table, source_id, source_field,
          source_value_sha256, reason_code, disposition, target_table, target_id)
       SELECT $2, "sourceDatabase", "sourceTable", "sourceId", "sourceField",
              "sourceValueSha256", "reasonCode", "disposition", "targetTable", "targetId"
       FROM jsonb_to_recordset($1::jsonb) AS source(
         "sourceDatabase" text, "sourceTable" text, "sourceId" text,
         "sourceField" text, "sourceValueSha256" text, "reasonCode" text,
         "disposition" text, "targetTable" text, "targetId" uuid
       )
       ON CONFLICT DO NOTHING`,
      values,
    );
  const result = await client.query<{ matched_count: number; total_count: number }>(
    `WITH planned AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS source(
       "sourceDatabase" text, "sourceTable" text, "sourceId" text,
       "sourceField" text, "sourceValueSha256" text, "reasonCode" text,
       "disposition" text, "targetTable" text, "targetId" uuid
       )
     ), matched AS (
       SELECT count(*)::int AS count
       FROM platform.production_finance_migration_dispositions disposition
       JOIN planned source ON disposition.source_run_id = $2
         AND disposition.source_database = source."sourceDatabase"
         AND disposition.source_table = source."sourceTable"
         AND disposition.source_id = source."sourceId"
         AND disposition.source_field = source."sourceField"
         AND disposition.reason_code = source."reasonCode"
         AND disposition.source_value_sha256 = source."sourceValueSha256"
         AND disposition.disposition = source."disposition"
         AND disposition.target_table IS NOT DISTINCT FROM source."targetTable"
         AND disposition.target_id IS NOT DISTINCT FROM source."targetId"
     )
     SELECT matched.count AS matched_count,
            count(disposition.*)::int AS total_count
     FROM matched
     LEFT JOIN platform.production_finance_migration_dispositions disposition
       ON disposition.source_run_id = $2
     GROUP BY matched.count`,
    values,
  );
  const matchedCount = result.rows[0]?.matched_count ?? 0;
  const totalCount = result.rows[0]?.total_count ?? 0;
  if (matchedCount !== dispositions.length || totalCount !== dispositions.length)
    throw new Error(
      `Finance disposition replay mismatch: ${matchedCount} planned rows matched and ${totalCount} total rows persisted for ${dispositions.length} planned rows`,
    );
  return matchedCount;
}

function order(table: string): number {
  const index = PRODUCTION_FINANCE_WRITE_ORDER.indexOf(
    table as (typeof PRODUCTION_FINANCE_WRITE_ORDER)[number],
  );
  if (index < 0) throw new Error(`Finance write order is missing ${table}`);
  return index;
}
