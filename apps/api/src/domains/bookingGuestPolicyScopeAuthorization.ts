import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  type BookingGuestPolicyScopeAuthorizationPort,
} from "@vayada/domain-booking";
import type { QueryResult, QueryResultRow } from "pg";

export type BookingGuestPolicyScopeAuthorizationPool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    config: Readonly<{ text: string; values: unknown[]; query_timeout: number }>,
  ): Promise<QueryResult<Row>>;
};

type BookingGuestPolicyScopeAuthorizationInput = Parameters<
  BookingGuestPolicyScopeAuthorizationPort["authorizeGuestPolicyScope"]
>[0];

const AUTHORIZATION_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgBookingGuestPolicyScopeAuthorizationPort(options: {
  pool: BookingGuestPolicyScopeAuthorizationPool;
}): BookingGuestPolicyScopeAuthorizationPort {
  return Object.freeze({
    async authorizeGuestPolicyScope(input: BookingGuestPolicyScopeAuthorizationInput) {
      if (
        !UUID_PATTERN.test(input.organizationId) ||
        !UUID_PATTERN.test(input.propertyId) ||
        !UUID_PATTERN.test(input.actorUserId) ||
        input.permission !== BOOKING_GUEST_POLICY_AUTHORIZATION.permission ||
        input.entitlement.product !== BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.product ||
        input.entitlement.key !== BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement.key ||
        input.resource.product !== BOOKING_GUEST_POLICY_AUTHORIZATION.resource.product ||
        input.resource.resourceType !== BOOKING_GUEST_POLICY_AUTHORIZATION.resource.resourceType ||
        input.resource.allowedRelationships.length !==
          BOOKING_GUEST_POLICY_AUTHORIZATION.resource.allowedRelationships.length ||
        !input.resource.allowedRelationships.every(
          (relationship, index) =>
            relationship ===
            BOOKING_GUEST_POLICY_AUTHORIZATION.resource.allowedRelationships[index],
        ) ||
        !canonicalIso(input.checkedAt)
      )
        return false;
      try {
        const result = await options.pool.query<{ authorized: boolean }>({
          text: AUTHORIZATION_SQL,
          values: [
            input.organizationId.toLowerCase(),
            input.propertyId.toLowerCase(),
            input.actorUserId.toLowerCase(),
            input.permission,
            input.entitlement.product,
            input.entitlement.key,
            input.resource.product,
            input.resource.resourceType,
            [...input.resource.allowedRelationships],
            input.checkedAt,
          ],
          query_timeout: AUTHORIZATION_TIMEOUT_MS,
        });
        return result.rows.length === 1 && result.rows[0]?.authorized === true;
      } catch {
        return false;
      }
    },
  });
}

const AUTHORIZATION_SQL = `
  SELECT true AS authorized
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
    ON permission_grant.organization_kind = organization.kind
   AND permission_grant.role_key = membership.role_key
   AND permission_grant.permission_key = $4
  WHERE property.id = $2::uuid
    AND EXISTS (
      SELECT 1
      FROM identity.organization_resource_links resource
      WHERE resource.organization_id = organization.id
        AND resource.product = $7
        AND resource.resource_type = $8
        AND resource.resource_id = property.id::text
        AND resource.relationship = ANY($9::text[])
        AND resource.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id = organization.id
        AND entitlement.product = $5
        AND entitlement.entitlement_key = $6
        AND entitlement.status = 'active'
        AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= $10::timestamptz)
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > $10::timestamptz)
        AND (
          entitlement.resource_product IS NULL
          OR (
            entitlement.resource_product = $7
            AND entitlement.resource_type = $8
            AND entitlement.resource_id = property.id::text
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id = organization.id
        AND entitlement.product = $5
        AND entitlement.entitlement_key = $6
        AND entitlement.status = 'suspended'
        AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= $10::timestamptz)
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > $10::timestamptz)
        AND (
          entitlement.resource_product IS NULL
          OR (
            entitlement.resource_product = $7
            AND entitlement.resource_type = $8
            AND entitlement.resource_id = property.id::text
          )
        )
    )
  LIMIT 1
`;

function canonicalIso(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
