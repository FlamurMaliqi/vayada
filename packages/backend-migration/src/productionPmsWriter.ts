import type pg from "pg";

import type { PmsTargetRecord } from "./productionPmsTypes.js";
import { PRODUCTION_PMS_TABLES, PRODUCTION_PMS_WRITE_ORDER } from "./productionPmsTables.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function writeProductionPmsRecords(
  client: QueryClient,
  records: PmsTargetRecord[],
): Promise<Record<string, number>> {
  const grouped = new Map<string, PmsTargetRecord[]>();
  for (const record of records) {
    const rows = grouped.get(record.targetTable);
    if (rows) rows.push(record);
    else grouped.set(record.targetTable, [record]);
  }
  const counts: Record<string, number> = {};
  for (const [targetTable, rows] of [...grouped].sort(
    ([left], [right]) => order(left) - order(right),
  )) {
    const definition = PRODUCTION_PMS_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported PMS writer ${targetTable}`);
    const aliases = definition.columns
      .map(([jsonKey, , type]) => `"${jsonKey}" ${type}`)
      .join(", ");
    const names = definition.columns.map(([, sqlName]) => sqlName).join(", ");
    const values = definition.columns.map(([jsonKey]) => `source."${jsonKey}"`).join(", ");
    const updates = definition.columns
      .filter(([, sqlName]) => !definition.key.includes(sqlName) && sqlName !== "created_at")
      .map(([, sqlName]) => `${sqlName} = EXCLUDED.${sqlName}`)
      .join(", ");
    const conflict = definition.mutable
      ? `ON CONFLICT (${definition.key.join(", ")}) DO UPDATE SET ${updates}`
      : `ON CONFLICT (${definition.key.join(", ")}) DO NOTHING`;
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

function order(table: string): number {
  const index = PRODUCTION_PMS_WRITE_ORDER.indexOf(
    table as (typeof PRODUCTION_PMS_WRITE_ORDER)[number],
  );
  if (index < 0) throw new Error(`PMS write order is missing ${table}`);
  return index;
}
