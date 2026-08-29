import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0121_hotel_property_manifest_permission.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const permission = "hotel_catalog.property_manifest.read";
const roles = [
  "hotel_owner",
  "owner",
  "operator",
  "hotel_manager",
  "front_desk",
  "housekeeping",
  "hotel_custom",
] as const;

describe("property manifest permission migration contract", () => {
  it("installs the baseline replay-safely for every hotel role", () => {
    expect(migration).toContain(`('${permission}'`);
    for (const role of roles) expect(migration).toContain(`('${role}')`);
    expect(migration.match(/ON CONFLICT/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE)\b/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("property manifest permission migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.permission_catalog (
        key TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        description TEXT
      );
      CREATE TABLE identity.role_permission_grants (
        organization_kind TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permission_key TEXT NOT NULL REFERENCES identity.permission_catalog(key),
        UNIQUE (organization_kind, role_key, permission_key)
      );
      INSERT INTO identity.permission_catalog VALUES
        ('unrelated.permission', 'platform', 'preserve me');
      INSERT INTO identity.role_permission_grants VALUES
        ('hotel_group', 'unrelated_role', 'unrelated.permission');
    `);
    await client.query(migration);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves existing data and installs exactly the seven baseline grants", async () => {
    const catalog = await client.query<{ product: string }>(
      "SELECT product FROM identity.permission_catalog WHERE key = $1",
      [permission],
    );
    expect(catalog.rows).toEqual([{ product: "hotel_catalog" }]);

    const grants = await client.query<{ roleKey: string }>(
      `SELECT role_key AS "roleKey"
       FROM identity.role_permission_grants
       WHERE organization_kind = 'hotel_group' AND permission_key = $1
       ORDER BY role_key`,
      [permission],
    );
    expect(grants.rows.map(({ roleKey }) => roleKey)).toEqual([...roles].sort());

    const unrelated = await client.query(
      "SELECT 1 FROM identity.role_permission_grants WHERE role_key = 'unrelated_role'",
    );
    expect(unrelated.rowCount).toBe(1);
  });
});
