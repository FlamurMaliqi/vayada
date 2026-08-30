import type pg from "pg";

import {
  PRODUCTION_FINANCE_TABLES,
  PRODUCTION_FINANCE_WRITE_ORDER,
} from "./productionFinanceTables.js";
import type { FinanceTargetRecord } from "./productionFinanceTypes.js";

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

function order(table: string): number {
  const index = PRODUCTION_FINANCE_WRITE_ORDER.indexOf(
    table as (typeof PRODUCTION_FINANCE_WRITE_ORDER)[number],
  );
  if (index < 0) throw new Error(`Finance write order is missing ${table}`);
  return index;
}
