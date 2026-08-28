import type { QueryResult, QueryResultRow } from "pg";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export async function lockStripeProviderAccountReference(
  client: Client,
  providerAccountRef: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 1345))`, [
    `finance:stripe-provider-account:${providerAccountRef}`,
  ]);
}

export async function stripeProviderAccountReferenceIsDurable(
  client: Client,
  providerAccountRef: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM finance.payment_provider_accounts
     WHERE provider = 'stripe' AND provider_account_id = $1
     LIMIT 1`,
    [providerAccountRef],
  );
  return Boolean(result.rows[0]);
}
