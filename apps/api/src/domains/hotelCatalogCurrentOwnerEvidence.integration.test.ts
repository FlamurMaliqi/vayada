import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogCurrentOwnerEvidencePorts } from "./hotelCatalogCurrentOwnerEvidence.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "10000000-0000-4000-8000-000000001150";
const otherOrganizationId = "10000000-0000-4000-8000-000000001151";
const propertyId = "30000000-0000-4000-8000-000000001150";
const otherPropertyId = "30000000-0000-4000-8000-000000001151";
const scope = { organizationId, propertyId };

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Catalog current-owner evidence ports", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    connectionTimeoutMillis: 5_000,
    max: 2,
  });
  const ports = createPgHotelCatalogCurrentOwnerEvidencePorts({ pool });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await admin.end();
  });

  it("returns exact independent current revisions and fails closed across organization scope", async () => {
    await expect(ports.location.getCurrentLocationOwnerEvidence(scope)).resolves.toMatchObject({
      outcome: "available",
      evidence: { ...scope, revision: 1, baseRevision: `hotel_catalog.location:${propertyId}:r1` },
    });
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toMatchObject({
      outcome: "available",
      evidence: { ...scope, revision: 1, baseRevision: `hotel_catalog.policy:${propertyId}:r1` },
    });
    await expect(
      ports.location.getCurrentLocationOwnerEvidence({
        organizationId: otherOrganizationId,
        propertyId,
      }),
    ).resolves.toEqual({ outcome: "missing", reason: "property_scope" });
  });

  it("distinguishes a missing policy row without hiding the available location owner", async () => {
    await admin.query(
      "DELETE FROM hotel_catalog.property_policy_summaries WHERE property_id = $1::uuid",
      [propertyId],
    );
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toEqual({
      outcome: "missing",
      reason: "owner_state",
    });
    await admin.query(
      `INSERT INTO hotel_catalog.property_policy_summaries (property_id, check_in_time)
       VALUES ($1::uuid, '16:00')`,
      [propertyId],
    );
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toMatchObject({
      outcome: "available",
      evidence: { revision: 3, baseRevision: `hotel_catalog.policy:${propertyId}:r3` },
    });
    await expect(ports.location.getCurrentLocationOwnerEvidence(scope)).resolves.toMatchObject({
      outcome: "available",
      evidence: { revision: 1 },
    });
  });

  it("observes owner-only changes without aliasing the profile or the other owner revision", async () => {
    const beforeLocation = await ports.location.getCurrentLocationOwnerEvidence(scope);
    const beforePolicy = await ports.policy.getCurrentPolicyOwnerEvidence(scope);
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET city = 'Hamburg' WHERE property_id = $1::uuid",
      [propertyId],
    );
    const afterLocation = await ports.location.getCurrentLocationOwnerEvidence(scope);
    const unchangedPolicy = await ports.policy.getCurrentPolicyOwnerEvidence(scope);
    expect(afterLocation).toMatchObject({ outcome: "available", evidence: { revision: 2 } });
    expect(afterLocation).not.toEqual(beforeLocation);
    expect(unchangedPolicy).toEqual(beforePolicy);

    await admin.query(
      `UPDATE hotel_catalog.property_policy_summaries
       SET check_out_time = '10:00' WHERE property_id = $1::uuid`,
      [propertyId],
    );
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toMatchObject({
      outcome: "available",
      evidence: { revision: 2 },
    });
    await expect(ports.location.getCurrentLocationOwnerEvidence(scope)).resolves.toEqual(
      afterLocation,
    );
  });

  async function seed() {
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
         ($1::uuid, 'hotel_group', 'VAY-1150 Group', 'vay-1150-group', 'active'),
         ($2::uuid, 'hotel_group', 'VAY-1150 Other', 'vay-1150-other', 'active')`,
      [organizationId, otherOrganizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES
         ($1::uuid, 'vay-1150-property', 'VAY-1150 Hotel'),
         ($2::uuid, 'vay-1150-other-property', 'VAY-1150 Other Hotel')`,
      [propertyId, otherPropertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status) VALUES
         ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active'),
         ($3::uuid, 'hotel_catalog', 'property', $4::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId, otherOrganizationId, otherPropertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, city, timezone)
       VALUES ($1::uuid, 'Berlin', 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_policy_summaries
         (property_id, check_in_time, check_out_time, policy_source_owner)
       VALUES ($1::uuid, '15:00', '11:00', 'booking')`,
      [propertyId],
    );
  }

  async function cleanup() {
    await admin.query(
      `DELETE FROM identity.organization_resource_links
       WHERE organization_id = ANY($1::uuid[])`,
      [[organizationId, otherOrganizationId]],
    );
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
      [propertyId, otherPropertyId],
    ]);
    await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
      [organizationId, otherOrganizationId],
    ]);
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName))
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
}
