import { createHash } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";

type RoomOrderClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export async function lockPmsRoomOrder(client: RoomOrderClient, propertyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('pms.room-order:' || $1::uuid::text, 0)
     )`,
    [propertyId],
  );
}

export function pmsRoomOrderVersion(roomIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(roomIds)).digest("hex");
}
