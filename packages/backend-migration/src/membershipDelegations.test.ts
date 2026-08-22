import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const delegationMigration = await readFile(
  join(import.meta.dirname, "../migrations/0105_external_owner_membership_delegations.sql"),
  "utf8",
);
const membershipWriterPaths = [
  "../../../apps/api/src/platform/identityLifecycle.ts",
  "../../../apps/api/src/platform/workosWebhooks.ts",
  "cases/bookingCheckout/transform.ts",
  "cases/distributionBookability/transform.ts",
  "cases/finance/transform.ts",
  "cases/identityOrganizationLinks/transform.ts",
  "cases/marketplace/transform.ts",
  "cases/platformJobsEventsAudit/transform.ts",
  "cases/pmsOperations/transform.ts",
  "nextSmokeBackfill.ts",
  "platformIdentityBootstrap.ts",
];
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const ADMIN_A = "20000000-0000-4000-8000-000000000001";
const OWNER_A = "20000000-0000-4000-8000-000000000002";
const OWNER_A_2 = "20000000-0000-4000-8000-000000000003";
const STAFF_A = "20000000-0000-4000-8000-000000000004";
const STAFF_A_2 = "20000000-0000-4000-8000-000000000005";
const NEW_STAFF_A = "20000000-0000-4000-8000-000000000006";
const OWNER_B = "20000000-0000-4000-8000-000000000007";
const STAFF_B = "20000000-0000-4000-8000-000000000008";

describe("explicit membership access origin", () => {
  it("makes every mounted writer explicit without overwriting existing provenance", async () => {
    for (const path of membershipWriterPaths) {
      const writer = await readFile(join(import.meta.dirname, path), "utf8");
      expect(writer, path).toMatch(
        /INSERT INTO identity\.organization_memberships[\s\S]{0,350}access_origin/,
      );
      expect(writer, path).not.toContain("access_origin = EXCLUDED.access_origin");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("membership delegations (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.organization_memberships (
        id UUID PRIMARY KEY,
        organization_id UUID NOT NULL,
        status TEXT NOT NULL,
        role_key TEXT NOT NULL,
        property_access_mode TEXT NOT NULL
      );
      INSERT INTO identity.organization_memberships VALUES
        ('${ADMIN_A}', '${ORG_A}', 'active', 'hotel_owner', 'all'),
        ('${OWNER_A}', '${ORG_A}', 'active', 'external_owner', 'assigned'),
        ('${OWNER_A_2}', '${ORG_A}', 'active', 'external_owner', 'assigned'),
        ('${STAFF_A}', '${ORG_A}', 'active', 'front_desk', 'assigned'),
        ('${STAFF_A_2}', '${ORG_A}', 'active', 'front_desk', 'assigned'),
        ('${OWNER_B}', '${ORG_B}', 'active', 'external_owner', 'assigned'),
        ('${STAFF_B}', '${ORG_B}', 'active', 'front_desk', 'assigned');
    `);
    await client.query(delegationMigration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("backfills agency origin, accepts explicit provenance, and rejects malformed scope", async () => {
    const origins = await client.query(
      "SELECT DISTINCT access_origin FROM identity.organization_memberships",
    );
    expect(origins.rows).toEqual([{ access_origin: "agency" }]);

    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1, $2, 'active', 'front_desk', 'assigned', 'agency')`,
      [NEW_STAFF_A, ORG_A],
    );
    expect(
      (
        await client.query(
          "SELECT access_origin FROM identity.organization_memberships WHERE id=$1",
          [NEW_STAFF_A],
        )
      ).rows[0],
    ).toEqual({ access_origin: "agency" });

    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET property_access_mode='all' WHERE id=$1",
        [OWNER_A],
      ),
    ).rejects.toMatchObject({
      constraint: "chk_organization_memberships_external_owner_scope",
    });
    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET access_origin='external_owner' WHERE id=$1",
        [STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_subject_origin" });
  });

  it("persists one same-organization owner-to-staff edge", async () => {
    await createDelegation(client, ORG_A, STAFF_A, OWNER_A, ADMIN_A);
    const row = await client.query(
      `SELECT delegation.subject_membership_id::text,
              delegation.delegator_membership_id::text,
              membership.access_origin
       FROM identity.membership_delegations delegation
       JOIN identity.organization_memberships membership
         ON membership.id = delegation.subject_membership_id`,
    );
    expect(row.rows).toEqual([
      {
        subject_membership_id: STAFF_A,
        delegator_membership_id: OWNER_A,
        access_origin: "external_owner",
      },
    ]);

    await expect(
      client.query(
        `UPDATE identity.membership_delegations
         SET organization_id=$1, delegator_membership_id=$2, created_by_membership_id=$2
         WHERE subject_membership_id=$3`,
        [ORG_B, OWNER_B, STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "fk_membership_delegations_subject_scope" });
    await expect(
      client.query(
        "UPDATE identity.membership_delegations SET delegator_membership_id=$1 WHERE subject_membership_id=$2",
        [OWNER_B, STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "fk_membership_delegations_delegator_scope" });
    await expect(
      client.query(
        "UPDATE identity.membership_delegations SET created_by_membership_id=$1 WHERE subject_membership_id=$2",
        [OWNER_B, STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "fk_membership_delegations_creator_scope" });
    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET role_key='front_desk' WHERE id=$1",
        [OWNER_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_delegator_role" });

    await client.query("BEGIN");
    await insertEdge(client, ORG_A, STAFF_A_2, OWNER_A_2, ADMIN_A);
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin='external_owner' WHERE id=$1",
      [STAFF_A_2],
    );
    await client.query("COMMIT");
  });

  it("rejects agency subjects, self edges, chains, and cycles", async () => {
    await expect(insertEdge(client, ORG_B, STAFF_B, OWNER_B, OWNER_B)).rejects.toMatchObject({
      constraint: "chk_membership_delegations_subject_origin",
    });

    await createDelegation(client, ORG_A, STAFF_A, OWNER_A, ADMIN_A);
    await expect(
      client.query(
        "UPDATE identity.membership_delegations SET delegator_membership_id=$1 WHERE subject_membership_id=$1",
        [STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_not_self" });

    await createDelegation(client, ORG_A, STAFF_A_2, OWNER_A_2, ADMIN_A);
    await expect(
      client.query(
        "UPDATE identity.membership_delegations SET delegator_membership_id=$1 WHERE subject_membership_id=$2",
        [STAFF_A, STAFF_A_2],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_single_level" });
    await expect(
      client.query(
        "UPDATE identity.membership_delegations SET subject_membership_id=$1 WHERE subject_membership_id=$2",
        [OWNER_A_2, STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_single_level" });
  });

  it("requires atomic adoption and preserves creator provenance", async () => {
    await createDelegation(client, ORG_A, STAFF_A, OWNER_A, ADMIN_A);
    await expect(
      client.query(
        "UPDATE identity.organization_memberships SET access_origin='agency' WHERE id=$1",
        [STAFF_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_subject_origin" });
    await expect(
      client.query("DELETE FROM identity.membership_delegations WHERE subject_membership_id=$1", [
        STAFF_A,
      ]),
    ).rejects.toMatchObject({ constraint: "chk_membership_delegations_subject_origin" });

    await client.query("DELETE FROM identity.organization_memberships WHERE id=$1", [ADMIN_A]);
    expect(
      (
        await client.query(
          "SELECT created_by_membership_id::text FROM identity.membership_delegations",
        )
      ).rows[0],
    ).toEqual({ created_by_membership_id: ADMIN_A });
    await client.query(
      "UPDATE identity.membership_delegations SET delegator_membership_id=$1 WHERE subject_membership_id=$2",
      [OWNER_A_2, STAFF_A],
    );
    await expect(
      client.query("DELETE FROM identity.organization_memberships WHERE id=$1", [OWNER_A_2]),
    ).rejects.toMatchObject({ constraint: "fk_membership_delegations_delegator_scope" });

    await client.query("BEGIN");
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin='agency' WHERE id=$1",
      [STAFF_A],
    );
    await client.query(
      "DELETE FROM identity.membership_delegations WHERE subject_membership_id=$1",
      [STAFF_A],
    );
    await client.query("COMMIT");
    expect(
      (await client.query("SELECT count(*)::int AS count FROM identity.membership_delegations"))
        .rows[0],
    ).toEqual({ count: 0 });

    await createDelegation(client, ORG_A, STAFF_A, OWNER_A, OWNER_A);
    await client.query("DELETE FROM identity.organization_memberships WHERE id=$1", [STAFF_A]);
    expect(
      (await client.query("SELECT count(*)::int AS count FROM identity.membership_delegations"))
        .rows[0],
    ).toEqual({ count: 0 });

    await createDelegation(client, ORG_A, STAFF_A_2, OWNER_A_2, OWNER_A_2);
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM identity.membership_delegations WHERE subject_membership_id=$1",
      [STAFF_A_2],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin='agency' WHERE id=$1",
      [STAFF_A_2],
    );
    await client.query("COMMIT");
  });
});

async function createDelegation(
  client: pg.Client,
  organizationId: string,
  subjectId: string,
  delegatorId: string,
  creatorId: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin='external_owner' WHERE id=$1",
      [subjectId],
    );
    await insertEdge(client, organizationId, subjectId, delegatorId, creatorId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function insertEdge(
  client: pg.Client,
  organizationId: string,
  subjectId: string,
  delegatorId: string,
  creatorId: string,
): Promise<pg.QueryResult> {
  return client.query(
    `INSERT INTO identity.membership_delegations
       (organization_id, subject_membership_id, delegator_membership_id, created_by_membership_id)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, subjectId, delegatorId, creatorId],
  );
}
