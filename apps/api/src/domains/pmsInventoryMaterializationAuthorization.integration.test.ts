import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPmsInventoryMaterializationAuthorizationPort } from "./pmsInventoryMaterializationAuthorization.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "19600000-0000-4000-8000-000000000001";
const propertyId = "19600000-0000-4000-8000-000000000002";
const actorUserId = "19600000-0000-4000-8000-000000000003";
const roleKey = "vay1300_inventory_materialization_owner";

describe.skipIf(!TEST_DATABASE_URL)(
  "PMS inventory-materialization PostgreSQL authorization",
  () => {
    const client = new pg.Client({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    });
    const authorization = createPgPmsInventoryMaterializationAuthorizationPort({ pool: client });

    beforeAll(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      await client.connect();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1300-inventory@example.test', 'VAY-1300 Inventory', 'active')`,
        [actorUserId],
      );
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1300 Inventory',
               'vay1300-inventory', 'active')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1300-inventory', 'VAY-1300 Inventory')`,
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
       VALUES ('hotel_group', $1, 'pms.operations.manage')`,
        [roleKey],
      );
      await client.query(
        `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      await client.query(
        `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
        [organizationId, propertyId],
      );
    });

    afterAll(async () => {
      await client.query("ROLLBACK");
      await client.end();
    });

    it("authorizes only the active property scope and fails closed after revocation", async () => {
      await expect(authorization.authorizeInventoryMaterialization(input())).resolves.toBe(true);
      await expect(
        authorization.authorizeInventoryMaterialization({
          ...input(),
          propertyId: "19600000-0000-4000-8000-000000000099",
        }),
      ).resolves.toBe(false);
      await expect(
        authorization.authorizeInventoryMaterialization({
          ...input(),
          audit: { ...input().audit, actor: { kind: "system", service: "test" } },
        }),
      ).resolves.toBe(false);

      await client.query(
        `UPDATE identity.product_entitlements
          SET status = 'suspended'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND entitlement_key = 'property-management'`,
        [organizationId],
      );
      await expect(authorization.authorizeInventoryMaterialization(input())).resolves.toBe(false);
    });
  },
);

function input() {
  return {
    organizationId,
    propertyId,
    audit: {
      actor: { kind: "user" as const, userId: actorUserId },
      requestId: "vay1300-inventory-request",
      correlationId: null,
      requestedAt: "2026-08-15T12:00:00.000Z",
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
