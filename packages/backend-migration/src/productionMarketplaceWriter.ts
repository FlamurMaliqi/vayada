import type pg from "pg";

import {
  PRODUCTION_MARKETPLACE_TABLES,
  PRODUCTION_MARKETPLACE_WRITE_ORDER,
} from "./productionMarketplaceTables.js";
import type {
  MarketplaceTargetRecord,
  ProductionMarketplaceQuarantine,
} from "./productionMarketplaceTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function writeProductionMarketplaceRecords(
  client: QueryClient,
  records: MarketplaceTargetRecord[],
): Promise<Record<string, number>> {
  const grouped = new Map<string, MarketplaceTargetRecord[]>();
  for (const record of records) {
    const rows = grouped.get(record.targetTable);
    if (rows) rows.push(record);
    else grouped.set(record.targetTable, [record]);
  }
  const counts: Record<string, number> = {};
  for (const [targetTable, rows] of [...grouped].sort(
    ([left], [right]) => order(left) - order(right),
  )) {
    const definition = PRODUCTION_MARKETPLACE_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported Marketplace writer ${targetTable}`);
    const aliases = definition.columns
      .map(([jsonKey, , type]) => `"${jsonKey}" ${type}`)
      .join(", ");
    const names = definition.columns.map(([, sqlName]) => sqlName).join(", ");
    const values = definition.columns.map(([jsonKey]) => `source."${jsonKey}"`).join(", ");
    const updates = definition.columns
      .filter(([, sqlName]) => !definition.key.includes(sqlName) && sqlName !== "created_at")
      .map(([, sqlName]) => `${sqlName} = EXCLUDED.${sqlName}`)
      .join(", ");
    const result = await client.query(
      `INSERT INTO ${definition.table} (${names})
       SELECT ${values} FROM jsonb_to_recordset($1::jsonb) AS source(${aliases})
       ON CONFLICT (${definition.key.join(", ")}) DO UPDATE SET ${updates}`,
      [JSON.stringify(rows.map((row) => row.row))],
    );
    counts[targetTable] = result.rowCount ?? 0;
  }
  return counts;
}

export async function writeProductionMarketplaceQuarantines(
  client: QueryClient,
  quarantines: ProductionMarketplaceQuarantine[],
  sourceRunId: string,
): Promise<number> {
  if (!quarantines.length) return 0;
  const values = [JSON.stringify(quarantines), sourceRunId];
  await client.query(
    `INSERT INTO platform.production_marketplace_migration_quarantines
       (source_run_id, source_table, source_id, source_field,
        source_value_sha256, reason_code, retention_until)
     SELECT $2, "sourceTable", "sourceId", "sourceField",
            "sourceValueSha256", "reasonCode", "retentionUntil"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "sourceTable" text, "sourceId" text, "sourceField" text,
       "sourceValueSha256" text, "reasonCode" text, "retentionUntil" date
     )
     ON CONFLICT DO NOTHING`,
    values,
  );
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM platform.production_marketplace_migration_quarantines quarantine
       JOIN jsonb_to_recordset($1::jsonb) AS source(
         "sourceTable" text, "sourceId" text, "sourceField" text,
         "sourceValueSha256" text, "reasonCode" text, "retentionUntil" date
       ) ON quarantine.source_run_id = $2
          AND quarantine.source_table = source."sourceTable"
          AND quarantine.source_id = source."sourceId"
          AND quarantine.source_field = source."sourceField"
          AND quarantine.reason_code = source."reasonCode"
          AND quarantine.source_value_sha256 = source."sourceValueSha256"
          AND quarantine.retention_until IS NOT DISTINCT FROM source."retentionUntil"`,
    values,
  );
  return result.rows[0]?.count ?? 0;
}

function order(table: string): number {
  const index = PRODUCTION_MARKETPLACE_WRITE_ORDER.indexOf(
    table as (typeof PRODUCTION_MARKETPLACE_WRITE_ORDER)[number],
  );
  if (index < 0) throw new Error(`Marketplace write order is missing ${table}`);
  return index;
}
