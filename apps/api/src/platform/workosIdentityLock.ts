import type { PoolClient } from "pg";

export async function lockWorkosProviderIdentity(
  client: Pick<PoolClient, "query">,
  providerUserId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `identity:external-identity:workos:${providerUserId}`,
  ]);
}
