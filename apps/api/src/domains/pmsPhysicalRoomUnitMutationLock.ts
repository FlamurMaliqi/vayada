import type { QueryResult, QueryResultRow } from "pg";

export type PmsPhysicalRoomUnitMutationLockClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

/**
 * Serializes changes that can alter a room type's physical-unit lifecycle or
 * attach operational references to those units.
 *
 * The database foreign keys preserve opaque room identity, but intentionally
 * do not encode the cross-row rule that a retired room cannot gain a new
 * assignment or room block. Every runtime assignment, block, label, status,
 * and reconciliation writer must therefore take this transaction-scoped lock
 * before locking or checking rooms, then recheck its own eligibility predicate.
 */
export async function lockPmsPhysicalRoomUnitMutationScope(
  client: PmsPhysicalRoomUnitMutationLockClient,
  propertyId: string,
  roomTypeId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(
         'pms.physical-room-unit:' || $1::uuid::text || ':' || $2::uuid::text,
         0
       )
     )`,
    [propertyId, roomTypeId],
  );
}
