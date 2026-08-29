import type { QueryResult, QueryResultRow } from "pg";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
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

export async function stripeProviderAccountReferenceIsQuarantined(
  client: Client,
  providerAccountRef: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM finance.stripe_provider_account_compensation_claims
     WHERE provider_account_id = $1
     LIMIT 1`,
    [providerAccountRef],
  );
  return Boolean(result.rows[0]);
}

export async function claimStripeProviderAccountCompensation(
  client: Client,
  providerAccountRef: string,
): Promise<"pending" | "completed"> {
  const result = await client.query<{ status: "pending" | "completed" }>(
    `INSERT INTO finance.stripe_provider_account_compensation_claims (
       provider_account_id, status
     ) VALUES ($1, 'pending')
     ON CONFLICT (provider_account_id) DO UPDATE SET updated_at = now()
     RETURNING status`,
    [providerAccountRef],
  );
  const status = result.rows[0]?.status;
  if (!status) throw new Error("Stripe compensation claim could not be persisted");
  return status;
}

export async function completeStripeProviderAccountCompensation(
  client: Client,
  providerAccountRef: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE finance.stripe_provider_account_compensation_claims
     SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE provider_account_id = $1`,
    [providerAccountRef],
  );
  if (result.rowCount !== 1) {
    throw new Error("Stripe compensation claim could not be completed");
  }
}
