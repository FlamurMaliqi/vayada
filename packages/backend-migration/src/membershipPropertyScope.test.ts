import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0103_membership_property_scope.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const OWNER = "20000000-0000-4000-8000-000000000001";
const STAFF = "20000000-0000-4000-8000-000000000002";
const LATE_OWNER = "20000000-0000-4000-8000-000000000003";
const OWNER_MEMBERSHIP = "30000000-0000-4000-8000-000000000001";
const STAFF_MEMBERSHIP = "30000000-0000-4000-8000-000000000002";
const LATE_OWNER_MEMBERSHIP = "30000000-0000-4000-8000-000000000003";
const PROPERTY_A = "40000000-0000-4000-8000-000000000001";
const PROPERTY_B = "40000000-0000-4000-8000-000000000002";
const PMS_ONLY_PROPERTY = "40000000-0000-4000-8000-000000000003";
const INACTIVE_PROPERTY = "40000000-0000-4000-8000-000000000004";

describe("membership property-scope migration", () => {
  it("keeps the rollout compatible and validates canonical links", () => {
    expect(migration).toContain("DEFAULT 'all'");
    expect(migration).toContain("successor migration must change this transitional default");
    expect(migration).toContain("property_access_mode IN ('all', 'assigned')");
    expect(migration).toContain("organization.kind = 'hotel_group'");
    expect(migration).toContain("link.product = 'hotel_catalog'");
    expect(migration).toContain("link.resource_type = 'property'");
    expect(migration).toContain("link.status = 'active'");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("membership property scope (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await createPredecessorSchema(client);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves owners while staff writers set assigned explicitly", async () => {
    expect(
      (
        await client.query(
          "SELECT property_access_mode FROM identity.organization_memberships WHERE id=$1",
          [OWNER_MEMBERSHIP],
        )
      ).rows[0],
    ).toEqual({ property_access_mode: "all" });

    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode)
       VALUES ($1, $2, $3, 'active', 'front_desk', 'assigned')`,
      [STAFF_MEMBERSHIP, ORG_A, STAFF],
    );
    expect(
      (
        await client.query(
          "SELECT property_access_mode FROM identity.organization_memberships WHERE id=$1",
          [STAFF_MEMBERSHIP],
        )
      ).rows[0],
    ).toEqual({ property_access_mode: "assigned" });

    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key)
       VALUES ($1, $2, $3, 'active', 'hotel_owner')`,
      [LATE_OWNER_MEMBERSHIP, ORG_A, LATE_OWNER],
    );
    expect(
      (
        await client.query(
          "SELECT property_access_mode FROM identity.organization_memberships WHERE id=$1",
          [LATE_OWNER_MEMBERSHIP],
        )
      ).rows[0],
    ).toEqual({ property_access_mode: "all" });

    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET property_access_mode='unknown' WHERE id=$1",
        [STAFF_MEMBERSHIP],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_organization_memberships_property_access_mode",
    });
  });

  it("accepts only canonical properties linked to the membership organization", async () => {
    await insertStaffMembership(client);
    await insertAssignment(client, PROPERTY_A);

    await expect(
      client.query(
        "UPDATE identity.membership_property_assignments SET property_id=$1 WHERE membership_id=$2",
        [PROPERTY_B, STAFF_MEMBERSHIP],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_membership_property_assignment_canonical_scope",
    });
    await expect(insertAssignment(client, PROPERTY_B)).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_membership_property_assignment_canonical_scope",
    });
    await expect(insertAssignment(client, PMS_ONLY_PROPERTY)).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_membership_property_assignment_canonical_scope",
    });
    await expect(insertAssignment(client, INACTIVE_PROPERTY)).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_membership_property_assignment_canonical_scope",
    });
  });

  it("rejects duplicate rows and cascades membership removal", async () => {
    await insertStaffMembership(client);
    await insertAssignment(client, PROPERTY_A);
    await expect(insertAssignment(client, PROPERTY_A)).rejects.toMatchObject({
      code: "23505",
      constraint: "membership_property_assignments_pkey",
    });

    await client.query("DELETE FROM identity.organization_memberships WHERE id=$1", [
      STAFF_MEMBERSHIP,
    ]);
    const remaining = await client.query(
      "SELECT count(*)::int AS count FROM identity.membership_property_assignments",
    );
    expect(remaining.rows[0]).toEqual({ count: 0 });
  });
});

function insertStaffMembership(client: pg.Client): Promise<pg.QueryResult> {
  return client.query(
    `INSERT INTO identity.organization_memberships
       (id, organization_id, user_id, status, role_key, property_access_mode)
     VALUES ($1, $2, $3, 'active', 'front_desk', 'assigned')`,
    [STAFF_MEMBERSHIP, ORG_A, STAFF],
  );
}

function insertAssignment(client: pg.Client, propertyId: string): Promise<pg.QueryResult> {
  return client.query(
    `INSERT INTO identity.membership_property_assignments
       (membership_id, property_id)
     VALUES ($1, $2)`,
    [STAFF_MEMBERSHIP, propertyId],
  );
}

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS identity CASCADE;
    DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
    CREATE SCHEMA identity;
    CREATE SCHEMA hotel_catalog;
    CREATE TABLE identity.users (id UUID PRIMARY KEY);
    CREATE TABLE identity.organizations (id UUID PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE identity.organization_memberships (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES identity.organizations(id),
      user_id UUID NOT NULL REFERENCES identity.users(id),
      status TEXT NOT NULL,
      role_key TEXT NOT NULL,
      UNIQUE (organization_id, user_id)
    );
    CREATE TABLE identity.organization_resource_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES identity.organizations(id),
      product TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    INSERT INTO identity.users VALUES ('${OWNER}'), ('${STAFF}'), ('${LATE_OWNER}');
    INSERT INTO identity.organizations VALUES ('${ORG_A}', 'hotel_group'), ('${ORG_B}', 'hotel_group');
    INSERT INTO identity.organization_memberships
      (id, organization_id, user_id, status, role_key)
    VALUES ('${OWNER_MEMBERSHIP}', '${ORG_A}', '${OWNER}', 'active', 'hotel_owner');
    INSERT INTO hotel_catalog.properties VALUES
      ('${PROPERTY_A}'), ('${PROPERTY_B}'), ('${PMS_ONLY_PROPERTY}'), ('${INACTIVE_PROPERTY}');
    INSERT INTO identity.organization_resource_links
      (organization_id, product, resource_type, resource_id, relationship, status)
    VALUES
      ('${ORG_A}', 'hotel_catalog', 'property', '${PROPERTY_A}', 'owner', 'active'),
      ('${ORG_B}', 'hotel_catalog', 'property', '${PROPERTY_B}', 'owner', 'active'),
      ('${ORG_A}', 'hotel_catalog', 'property', '${INACTIVE_PROPERTY}', 'owner', 'inactive'),
      ('${ORG_A}', 'pms', 'pms_property', '${PMS_ONLY_PROPERTY}', 'operator', 'active');
  `);
}
