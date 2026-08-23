import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { transformMarketplace } from "./cases/marketplace/transform.js";
import { transformPlatformJobsEventsAudit } from "./cases/platformJobsEventsAudit/transform.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const compatibilityMigration = await readFile(
  join(import.meta.dirname, "../migrations/0103_membership_property_scope.sql"),
  "utf8",
);
const defaultAssignedMigration = await readFile(
  join(import.meta.dirname, "../migrations/0104_default_membership_property_scope_assigned.sql"),
  "utf8",
);
const membershipWriterPaths = [
  "nextSmokeBackfill.ts",
  "platformIdentityBootstrap.ts",
  "cases/bookingCheckout/transform.ts",
  "cases/distributionBookability/transform.ts",
  "cases/finance/transform.ts",
  "cases/identityOrganizationLinks/transform.ts",
  "cases/marketplace/transform.ts",
  "cases/platformJobsEventsAudit/transform.ts",
  "cases/pmsOperations/transform.ts",
];
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const CREATOR_ORG = "10000000-0000-4000-8000-000000000003";
const OWNER = "20000000-0000-4000-8000-000000000001";
const STAFF = "20000000-0000-4000-8000-000000000002";
const LATE_OWNER = "20000000-0000-4000-8000-000000000003";
const CREATOR = "20000000-0000-4000-8000-000000000004";
const NEW_MEMBER = "20000000-0000-4000-8000-000000000005";
const OWNER_MEMBERSHIP = "30000000-0000-4000-8000-000000000001";
const STAFF_MEMBERSHIP = "30000000-0000-4000-8000-000000000002";
const LATE_OWNER_MEMBERSHIP = "30000000-0000-4000-8000-000000000003";
const CREATOR_MEMBERSHIP = "30000000-0000-4000-8000-000000000004";
const NEW_MEMBERSHIP = "30000000-0000-4000-8000-000000000005";
const PROPERTY_A = "40000000-0000-4000-8000-000000000001";
const PROPERTY_B = "40000000-0000-4000-8000-000000000002";
const PMS_ONLY_PROPERTY = "40000000-0000-4000-8000-000000000003";
const INACTIVE_PROPERTY = "40000000-0000-4000-8000-000000000004";

describe("membership property-scope migration", () => {
  it("keeps the rollout compatible and validates canonical links", () => {
    expect(compatibilityMigration).toContain("DEFAULT 'all'");
    expect(compatibilityMigration).toContain(
      "successor migration must change this transitional default",
    );
    expect(compatibilityMigration).toContain("property_access_mode IN ('all', 'assigned')");
    expect(compatibilityMigration).toContain("organization.kind = 'hotel_group'");
    expect(compatibilityMigration).toContain("link.product = 'hotel_catalog'");
    expect(compatibilityMigration).toContain("link.resource_type = 'property'");
    expect(compatibilityMigration).toContain("link.status = 'active'");
  });

  it("repairs compatibility rows before changing the default to assigned", () => {
    const writerLock = "LOCK TABLE identity.organization_memberships IN SHARE ROW EXCLUSIVE MODE";
    expect(defaultAssignedMigration).toContain(writerLock);
    expect(defaultAssignedMigration.indexOf(writerLock)).toBeLessThan(
      defaultAssignedMigration.indexOf("INSERT INTO identity.membership_property_assignments"),
    );
    expect(defaultAssignedMigration).toContain(
      "INSERT INTO identity.membership_property_assignments",
    );
    expect(defaultAssignedMigration).toContain("property.id::text = link.resource_id");
    expect(defaultAssignedMigration).toContain(
      "membership.role_key NOT IN ('hotel_owner', 'owner', 'operator')",
    );
    expect(defaultAssignedMigration).toContain("link.status = 'active'");
    expect(defaultAssignedMigration).toContain("SET property_access_mode = 'assigned'");
    expect(defaultAssignedMigration).toContain(
      "ALTER COLUMN property_access_mode SET DEFAULT 'assigned'",
    );
  });
  it("keeps every target membership writer explicit before the default flips", async () => {
    for (const path of membershipWriterPaths) {
      const writer = await readFile(join(import.meta.dirname, path), "utf8");
      expect(writer, path).toMatch(
        /INSERT INTO identity\.organization_memberships[\s\S]{0,250}property_access_mode/,
      );
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("membership property scope (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await createPredecessorSchema(client);
    await client.query(compatibilityMigration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      await client.query("DROP SCHEMA IF EXISTS migration_source_marketplace CASCADE");
      await client.query("DROP SCHEMA IF EXISTS migration_source_platform CASCADE");
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

  it("preserves transitional access explicitly and defaults new rows to assigned", async () => {
    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key)
       VALUES
         ($1, $2, $3, 'active', 'front_desk'),
         ($4, $2, $5, 'active', 'hotel_owner'),
         ($6, $7, $8, 'active', 'creator_owner')`,
      [
        STAFF_MEMBERSHIP,
        ORG_A,
        STAFF,
        LATE_OWNER_MEMBERSHIP,
        LATE_OWNER,
        CREATOR_MEMBERSHIP,
        CREATOR_ORG,
        CREATOR,
      ],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET property_access_mode = 'assigned' WHERE id = $1",
      [LATE_OWNER_MEMBERSHIP],
    );

    await client.query(defaultAssignedMigration);

    const memberships = await client.query(
      `SELECT id::text, property_access_mode
       FROM identity.organization_memberships
       ORDER BY id`,
    );
    expect(memberships.rows).toEqual([
      { id: OWNER_MEMBERSHIP, property_access_mode: "all" },
      { id: STAFF_MEMBERSHIP, property_access_mode: "assigned" },
      { id: LATE_OWNER_MEMBERSHIP, property_access_mode: "assigned" },
      { id: CREATOR_MEMBERSHIP, property_access_mode: "assigned" },
    ]);

    const assignments = await client.query(
      `SELECT membership_id::text, property_id::text
       FROM identity.membership_property_assignments
       ORDER BY membership_id, property_id`,
    );
    expect(assignments.rows).toEqual([
      { membership_id: STAFF_MEMBERSHIP, property_id: PROPERTY_A },
    ]);

    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key)
       VALUES ($1, $2, $3, 'active', 'hotel_owner')`,
      [NEW_MEMBERSHIP, ORG_A, NEW_MEMBER],
    );
    expect(
      (
        await client.query(
          "SELECT property_access_mode FROM identity.organization_memberships WHERE id = $1",
          [NEW_MEMBERSHIP],
        )
      ).rows[0],
    ).toEqual({ property_access_mode: "assigned" });
  });

  it("takes the writer-excluding lock before repairing rows", async () => {
    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key)
       VALUES ($1, $2, $3, 'active', 'front_desk')`,
      [STAFF_MEMBERSHIP, ORG_A, STAFF],
    );
    const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await writer.connect();
    const migrationPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    let migrationRun: Promise<pg.QueryResult> | undefined;

    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE identity.organization_memberships IN ROW EXCLUSIVE MODE");
      migrationRun = client.query(defaultAssignedMigration);

      await expect
        .poll(async () => {
          const result = await writer.query<{ mode: string }>(
            `SELECT mode
             FROM pg_locks
             WHERE pid = $1
               AND relation = 'identity.organization_memberships'::regclass
               AND NOT granted`,
            [migrationPid],
          );
          return result.rows[0]?.mode;
        })
        .toBe("ShareRowExclusiveLock");

      await writer.query("COMMIT");
      await migrationRun;
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
      await migrationRun?.catch(() => undefined);
    }
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
  it.each([
    ["marketplace", transformMarketplace],
    ["platform", transformPlatformJobsEventsAudit],
  ])("rejects orphan %s source memberships instead of dropping them", async (source, transform) => {
    const queries: string[] = [];
    await transform({
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    } as never);
    const membershipInsert = queries.find((query) =>
      query.includes("INSERT INTO identity.organization_memberships"),
    );
    expect(membershipInsert).toBeDefined();

    await createOrphanSourceMembership(client, source);
    await expect(client.query(membershipInsert!)).rejects.toMatchObject({
      code: "23503",
      constraint: "organization_memberships_organization_id_fkey",
    });
  });
});

async function createOrphanSourceMembership(client: pg.Client, source: string): Promise<void> {
  const schema =
    source === "marketplace" ? "migration_source_marketplace" : "migration_source_platform";
  const membershipTable =
    source === "marketplace" ? "organization_memberships" : "identity_organization_memberships";
  const organizationTable = source === "marketplace" ? "organizations" : "identity_organizations";
  await client.query(`
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.${organizationTable} (id UUID PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE ${schema}.${membershipTable} (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      user_id UUID NOT NULL,
      status TEXT NOT NULL,
      role_key TEXT NOT NULL,
      workos_membership_id TEXT,
      workos_role_slugs TEXT[] NOT NULL DEFAULT '{}'
    );
    INSERT INTO ${schema}.${membershipTable}
      (id, organization_id, user_id, status, role_key)
    VALUES ('${STAFF_MEMBERSHIP}', '${PROPERTY_A}', '${STAFF}', 'active', 'hotel_owner');
  `);
}
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
      workos_membership_id TEXT,
      workos_role_slugs TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
    INSERT INTO identity.users VALUES
      ('${OWNER}'), ('${STAFF}'), ('${LATE_OWNER}'), ('${CREATOR}'), ('${NEW_MEMBER}');
    INSERT INTO identity.organizations VALUES
      ('${ORG_A}', 'hotel_group'),
      ('${ORG_B}', 'hotel_group'),
      ('${CREATOR_ORG}', 'creator_workspace');
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
