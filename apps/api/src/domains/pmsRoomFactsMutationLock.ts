import type { QueryResult, QueryResultRow } from "pg";

export const PMS_ROOM_FACTS_MUTATION_LOCK_NAMESPACE = "pms.room_facts" as const;

export type PmsRoomFactsMutationLockClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

/** Serializes every create, update, delete, or complete-set room-facts read for a property. */
export async function lockPmsRoomFactsMutationScope(
  client: PmsRoomFactsMutationLockClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('${PMS_ROOM_FACTS_MUTATION_LOCK_NAMESPACE}'),
       hashtext($1::uuid::text)
     )`,
    [propertyId],
  );
}
