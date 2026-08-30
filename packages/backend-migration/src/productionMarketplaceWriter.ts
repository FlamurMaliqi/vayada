import type pg from "pg";

import {
  PRODUCTION_MARKETPLACE_TABLES,
  PRODUCTION_MARKETPLACE_WRITE_ORDER,
} from "./productionMarketplaceTables.js";
import type { MarketplaceTargetRecord } from "./productionMarketplaceTypes.js";

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

function order(table: string): number {
  const index = PRODUCTION_MARKETPLACE_WRITE_ORDER.indexOf(
    table as (typeof PRODUCTION_MARKETPLACE_WRITE_ORDER)[number],
  );
  if (index < 0) throw new Error(`Marketplace write order is missing ${table}`);
  return index;
}
