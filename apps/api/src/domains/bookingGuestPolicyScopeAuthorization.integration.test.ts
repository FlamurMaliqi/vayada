import { BOOKING_GUEST_POLICY_AUTHORIZATION } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./bookingGuestPolicyScopeAuthorization.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "19500000-0000-4000-8000-000000000001";
const propertyId = "19500000-0000-4000-8000-000000000002";
const actorUserId = "19500000-0000-4000-8000-000000000003";
const roleKey = "vay1049_booking_guest_policy_owner";

describe.skipIf(!TEST_DATABASE_URL)("Booking guest-policy PostgreSQL scope authorization", () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const authorization = createPgBookingGuestPolicyScopeAuthorizationPort({ pool: client });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1049-booking-policy@example.test', 'VAY-1049 Booking Policy', 'active')`,
      [actorUserId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1049 Booking Policy',
               'vay1049-booking-policy', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1049-booking-policy', 'VAY-1049 Booking Policy')`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await client.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'booking.settings.manage')`,
      [roleKey],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'booking', 'booking-engine', 'active',
               'booking', 'booking_hotel', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("authorizes the exact active tenant boundary and fails closed after revocation", async () => {
    await expect(authorization.authorizeGuestPolicyScope(input())).resolves.toBe(true);

    await client.query(
      `UPDATE identity.organization_memberships
          SET status = 'suspended'
        WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await expect(authorization.authorizeGuestPolicyScope(input())).resolves.toBe(false);

    await client.query(
      `UPDATE identity.organization_memberships
          SET status = 'active'
        WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await client.query(
      `UPDATE identity.product_entitlements
          SET status = 'suspended'
        WHERE organization_id = $1::uuid
          AND product = 'booking'
          AND entitlement_key = 'booking-engine'`,
      [organizationId],
    );
    await expect(authorization.authorizeGuestPolicyScope(input())).resolves.toBe(false);
  });
});

function input() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
    entitlement: BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement,
    resource: BOOKING_GUEST_POLICY_AUTHORIZATION.resource,
    checkedAt: "2026-08-05T14:00:00.000Z",
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
