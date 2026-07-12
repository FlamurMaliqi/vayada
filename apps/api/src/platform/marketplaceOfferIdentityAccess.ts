import type { QueryResult, QueryResultRow } from "pg";

export type IdentityCommandTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type MarketplaceOfferIdentityAccessCommandPort = {
  grantOperator(input: {
    transaction: IdentityCommandTransaction;
    organizationId: string;
    offerId: string;
  }): Promise<void>;
  archiveOperator(input: {
    transaction: IdentityCommandTransaction;
    organizationId: string;
    offerId: string;
  }): Promise<void>;
};

export function createPgMarketplaceOfferIdentityAccessCommandPort(): MarketplaceOfferIdentityAccessCommandPort {
  return {
    async grantOperator(input) {
      await input.transaction.query(
        `INSERT INTO identity.organization_resource_links (
           organization_id,
           product,
           resource_type,
           resource_id,
           relationship,
           status
         )
         VALUES ($1::uuid, 'marketplace', 'marketplace_offer', $2, 'operator', 'active')
         ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
         DO UPDATE SET status = 'active', updated_at = now()`,
        [input.organizationId, input.offerId],
      );
    },
    async archiveOperator(input) {
      await input.transaction.query(
        `UPDATE identity.organization_resource_links
         SET status = 'archived', updated_at = now()
         WHERE organization_id = $1::uuid
           AND product = 'marketplace'
           AND resource_type = 'marketplace_offer'
           AND resource_id = $2
           AND relationship = 'operator'`,
        [input.organizationId, input.offerId],
      );
    },
  };
}
