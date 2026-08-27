import type { QueryResult, QueryResultRow } from "pg";

export const PMS_INVENTORY_MUTATION_LOCK_PREFIX = "pms-inventory:" as const;

export type PmsInventoryMutationLockClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

/** Serializes every capacity-changing inventory mutation for one property. */
export async function lockPmsInventoryMutationScope(
  client: PmsInventoryMutationLockClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(concat('${PMS_INVENTORY_MUTATION_LOCK_PREFIX}', $1::uuid::text), 0)
     )`,
    [propertyId],
  );
}
