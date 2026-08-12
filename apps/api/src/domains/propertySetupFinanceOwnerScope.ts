import type { QueryResult, QueryResultRow } from "pg";

export type PropertySetupFinanceOwnerScopePort = {
  hasPaymentOwnerScope(input: { organizationId: string; propertyId: string }): Promise<boolean>;
};

export type PropertySetupFinanceOwnerScopePool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    config: Readonly<{ text: string; values: unknown[]; query_timeout: number }>,
  ): Promise<QueryResult<Row>>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPropertySetupFinanceOwnerScopePort(options: {
  pool: PropertySetupFinanceOwnerScopePool;
}): PropertySetupFinanceOwnerScopePort {
  return Object.freeze({
    async hasPaymentOwnerScope(input) {
      if (!UUID_PATTERN.test(input.organizationId) || !UUID_PATTERN.test(input.propertyId)) {
        return false;
      }
      try {
        const result = await options.pool.query<{ authorized: boolean }>({
          text: AUTHORIZATION_SQL,
          values: [input.organizationId.toLowerCase(), input.propertyId.toLowerCase()],
          query_timeout: 5_000,
        });
        return result.rows.length === 1 && result.rows[0]?.authorized === true;
      } catch {
        return false;
      }
    },
  });
}

const AUTHORIZATION_SQL = `SELECT (
  EXISTS (
    SELECT 1
    FROM identity.organizations organization
    WHERE organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM hotel_catalog.properties property
    WHERE property.id = $2::uuid
  )
  AND EXISTS (
    SELECT 1
    FROM identity.organization_resource_links resource
    WHERE resource.organization_id = $1::uuid
      AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = $2::uuid::text
      AND resource.relationship IN ('owner', 'operator', 'finance_manager')
      AND resource.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'active'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL
        OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'suspended'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL
        OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
) AS authorized`;
