import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0124_repair_hotel_member_roles.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const HOTEL_ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const INITIAL_TIME = new Date("2025-01-01T00:00:00.000Z");

describe("hotel member role repair migration contract", () => {
  it("locks writers before classifying or repairing memberships", () => {
    const lock = migration.indexOf("LOCK TABLE");
    for (const table of [
      "identity.organizations",
      "identity.organization_memberships",
      "identity.membership_property_assignments",
      "identity.staff_invitations",
      "identity.membership_delegations",
      "identity.role_permission_grants",
    ]) {
      expect(migration.slice(lock, migration.indexOf("DO $$"))).toContain(table);
    }
    expect(migration.slice(lock, migration.indexOf("DO $$"))).toContain("IN EXCLUSIVE MODE");
    expect(lock).toBeLessThan(migration.indexOf("DO $$"));
    expect(lock).toBeLessThan(migration.indexOf("UPDATE identity.organization_memberships"));
  });
});

describe.skipIf(!TEST_DATABASE_URL)("hotel member role repair migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY, kind TEXT NOT NULL);
      CREATE TABLE identity.organization_memberships (
        id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES identity.organizations(id),
        status TEXT NOT NULL, role_key TEXT NOT NULL, permission_overrides JSONB,
        workos_membership_id TEXT, workos_role_slugs TEXT[] NOT NULL DEFAULT '{}',
        invited_at TIMESTAMPTZ, property_access_mode TEXT NOT NULL, access_origin TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE identity.membership_property_assignments (membership_id UUID NOT NULL, property_id UUID NOT NULL);
      CREATE TABLE identity.membership_delegations (subject_membership_id UUID NOT NULL, delegator_membership_id UUID NOT NULL, created_by_membership_id UUID);
      CREATE TABLE identity.staff_invitations (organization_id UUID NOT NULL, status TEXT NOT NULL, accepted_membership_id UUID);
      CREATE TABLE identity.role_permission_grants (organization_kind TEXT NOT NULL, role_key TEXT NOT NULL, permission_key TEXT NOT NULL);
      INSERT INTO identity.organizations VALUES
        ('${HOTEL_ORG}', 'hotel_group'),
        ('${OTHER_ORG}', 'creator_workspace');
      INSERT INTO identity.role_permission_grants VALUES
        ('hotel_group', 'hotel_custom', 'hotel_catalog.property_manifest.read');
    `);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("converts only inert hotel memberships and preserves provider state", async () => {
    const statuses = ["active", "pending", "inactive", "suspended"];
    const providerState = [
      { id: "workos-membership-active", slugs: ["hotel_member"] },
      { id: null, slugs: [] },
      { id: "workos-membership-inactive", slugs: ["admin"] },
      { id: "workos-membership-suspended", slugs: ["hotel_member", "legacy"] },
    ];
    for (const [index, status] of statuses.entries()) {
      await insertMembership(client, {
        id: membershipId(index + 1),
        status,
        workosMembershipId: providerState[index]!.id,
        workosRoleSlugs: providerState[index]!.slugs,
      });
    }
    await insertMembership(client, {
      id: membershipId(10),
      organizationId: OTHER_ORG,
    });
    await insertMembership(client, {
      id: membershipId(11),
      roleKey: "front_desk",
    });

    const writer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await writer.connect();
    await client.query("BEGIN");
    try {
      await client.query(migration.slice(0, migration.indexOf("DO $$")));
      await writer.query("SET lock_timeout = '100ms'");
      await expect(
        writer.query(
          `UPDATE identity.organizations SET kind = 'creator_workspace' WHERE id = '${HOTEL_ORG}'`,
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      await writer.end();
    }

    await client.query(migration);

    const repaired = await client.query(
      `SELECT role_key AS "roleKey", status,
              workos_membership_id AS "workosMembershipId",
              workos_role_slugs AS "workosRoleSlugs",
              property_access_mode AS "propertyAccessMode", access_origin AS "accessOrigin",
              permission_overrides AS "permissionOverrides", invited_at AS "invitedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM identity.organization_memberships
       WHERE organization_id = $1
       ORDER BY id`,
      [HOTEL_ORG],
    );
    expect(repaired.rows.slice(0, 4).map(({ roleKey, status }) => ({ roleKey, status }))).toEqual(
      statuses.map((status) => ({ roleKey: "hotel_custom", status })),
    );
    expect(
      repaired.rows.slice(0, 4).map(({ workosMembershipId, workosRoleSlugs }) => ({
        workosMembershipId,
        workosRoleSlugs,
      })),
    ).toEqual(
      providerState.map(({ id, slugs }) => ({
        workosMembershipId: id,
        workosRoleSlugs: slugs,
      })),
    );
    for (const row of repaired.rows.slice(0, 4)) {
      expect(row).toMatchObject({
        accessOrigin: "agency",
        createdAt: INITIAL_TIME,
        invitedAt: null,
        permissionOverrides: null,
        propertyAccessMode: "assigned",
      });
      expect(row.updatedAt.getTime()).toBeGreaterThan(INITIAL_TIME.getTime());
    }
    expect(repaired.rows[4]).toMatchObject({ roleKey: "front_desk", updatedAt: INITIAL_TIME });

    const unrelated = await client.query(
      `SELECT role_key AS "roleKey", updated_at AS "updatedAt"
       FROM identity.organization_memberships
       WHERE id = $1`,
      [membershipId(10)],
    );
    expect(unrelated.rows).toEqual([{ roleKey: "hotel_member", updatedAt: INITIAL_TIME }]);
    expect(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM identity.membership_property_assignments",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it("aborts atomically when any membership could carry access or intent", async () => {
    await insertMembership(client, { id: membershipId(1) });
    await insertMembership(client, { id: membershipId(2), propertyAccessMode: "all" });
    await insertMembership(client, { id: membershipId(3), accessOrigin: "external_owner" });
    await insertMembership(client, {
      id: membershipId(4),
      permissionOverrides: { grant: [], deny: [] },
    });
    await insertMembership(client, { id: membershipId(5) });
    await insertMembership(client, { id: membershipId(6), invitedAt: INITIAL_TIME });
    await insertMembership(client, { id: membershipId(7) });
    await insertMembership(client, { id: membershipId(8) });
    await insertMembership(client, { id: membershipId(9) });
    await insertMembership(client, { id: membershipId(10) });
    await client.query(`UPDATE identity.organization_memberships SET created_at = '2027-01-01'
                        WHERE id = '${membershipId(10)}'`);
    await client.query("INSERT INTO identity.membership_property_assignments VALUES ($1, $2)", [
      membershipId(5),
      membershipId(50),
    ]);
    await client.query(
      "INSERT INTO identity.staff_invitations VALUES ($1, 'accepted', $2), ($1, 'pending', NULL)",
      [HOTEL_ORG, membershipId(7)],
    );
    await client.query(
      "INSERT INTO identity.membership_delegations (subject_membership_id, delegator_membership_id) VALUES ($1, $2)",
      [membershipId(8), membershipId(9)],
    );
    await client.query(
      `INSERT INTO identity.role_permission_grants
       VALUES ('hotel_group', 'hotel_member', 'pms.dashboard.read'),
              ('hotel_group', 'hotel_custom', 'pms.dashboard.read')`,
    );

    await expect(client.query(migration)).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_hotel_member_role_repair_safety",
      message:
        "hotel_member role repair blocked: mode=1 origin=1 overrides=1 assignments=1 invitations=10 delegations=2 post_cutoff=1 source_role_grants=1 unexpected_custom_grants=1 custom_manifest_grants=1",
    });
    const memberships = await client.query(
      `SELECT role_key AS "roleKey", updated_at AS "updatedAt"
       FROM identity.organization_memberships
       ORDER BY id`,
    );
    expect(memberships.rows).toHaveLength(10);
    expect(memberships.rows.every((row) => row.roleKey === "hotel_member")).toBe(true);
    expect(
      memberships.rows.every((row) => row.updatedAt.getTime() === INITIAL_TIME.getTime()),
    ).toBe(true);
  });

  it("is a no-op when replayed after a successful repair", async () => {
    await insertMembership(client, { id: membershipId(1) });
    await client.query(migration);
    const before = await client.query(
      `SELECT xmin::text, role_key AS "roleKey", updated_at AS "updatedAt"
       FROM identity.organization_memberships WHERE id = $1`,
      [membershipId(1)],
    );

    await client.query(migration);

    expect(
      (
        await client.query(
          `SELECT xmin::text, role_key AS "roleKey", updated_at AS "updatedAt"
           FROM identity.organization_memberships WHERE id = $1`,
          [membershipId(1)],
        )
      ).rows,
    ).toEqual(before.rows);
  });
});

async function insertMembership(
  client: pg.Client,
  input: {
    id: string;
    organizationId?: string;
    status?: string;
    roleKey?: string;
    permissionOverrides?: Record<string, unknown> | null;
    workosMembershipId?: string | null;
    workosRoleSlugs?: string[];
    invitedAt?: Date | null;
    propertyAccessMode?: string;
    accessOrigin?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO identity.organization_memberships
       (id, organization_id, status, role_key, permission_overrides,
        workos_membership_id, workos_role_slugs, invited_at,
        property_access_mode, access_origin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      input.id,
      input.organizationId ?? HOTEL_ORG,
      input.status ?? "active",
      input.roleKey ?? "hotel_member",
      input.permissionOverrides ?? null,
      input.workosMembershipId ?? null,
      input.workosRoleSlugs ?? [],
      input.invitedAt ?? null,
      input.propertyAccessMode ?? "assigned",
      input.accessOrigin ?? "agency",
      INITIAL_TIME,
    ],
  );
}

function membershipId(sequence: number): string {
  return `20000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}
