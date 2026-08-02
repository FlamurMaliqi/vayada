import type { QueryResult, QueryResultRow } from "pg";

import type { PropertySetupLifecycleScope } from "../platform/propertySetupReviewLifecycleState.js";

export type PropertySetupLifecycleQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type ProductLifecycleAccess = Readonly<{
  product: "marketplace" | "booking";
  permission: "marketplace.collaboration.read" | "booking.settings.read";
  resourceType: "hotel_profile" | "booking_hotel";
  entitlementKey: "marketplace-hotel-profile" | "booking-engine";
}>;

/** Rechecks the owner-specific permission, resource, and entitlement at read time. */
export async function requirePropertySetupLifecycleAccess(
  executor: PropertySetupLifecycleQueryExecutor,
  scope: PropertySetupLifecycleScope,
  access: ProductLifecycleAccess,
): Promise<void> {
  const result = await executor.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid
      AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $4
     WHERE property.id = $2::uuid
       AND EXISTS (
         SELECT 1
         FROM identity.organization_resource_links resource
         WHERE resource.organization_id = organization.id
           AND resource.product = $5
           AND resource.resource_type = $6
           AND resource.resource_id = property.id::text
           AND resource.relationship IN ('owner', 'operator')
           AND resource.status = 'active'
       )
       AND EXISTS (
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = organization.id
           AND entitlement.product = $5
           AND entitlement.entitlement_key = $7
           AND entitlement.status = 'active'
           AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
           AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
           AND (
             entitlement.resource_product IS NULL
             OR (
               entitlement.resource_product = $5
               AND entitlement.resource_type = $6
               AND entitlement.resource_id = property.id::text
             )
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM identity.product_entitlements entitlement
         WHERE entitlement.organization_id = organization.id
           AND entitlement.product = $5
           AND entitlement.entitlement_key = $7
           AND entitlement.status = 'suspended'
           AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
           AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
           AND (
             entitlement.resource_product IS NULL
             OR (
               entitlement.resource_product = $5
               AND entitlement.resource_type = $6
               AND entitlement.resource_id = property.id::text
             )
           )
       )`,
    [
      scope.organizationId,
      scope.propertyId,
      scope.actorUserId,
      access.permission,
      access.product,
      access.resourceType,
      access.entitlementKey,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Property setup lifecycle scope is unavailable");
}
