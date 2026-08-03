import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0055_finance_payment_readiness.sql"),
  "utf8",
);
const permissionSeeds = migration.match(
  /INSERT INTO identity\.permission_catalog[\s\S]+?ON CONFLICT \(organization_kind, role_key, permission_key\) DO NOTHING;/,
)?.[0];
if (!permissionSeeds) throw new Error("0055 permission seeds are not replay-safe");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";

describe("Finance payment-readiness migration contract", () => {
  it("adds only nullable, exact-versioned Finance readiness bindings", () => {
    expect(migration).toContain("ADD COLUMN payment_readiness_contract_version TEXT");
    expect(migration).toContain("ADD COLUMN payment_methods_revision BIGINT");
    expect(migration).toContain("ADD COLUMN source_pricing_currency_revision BIGINT");
    expect(migration).toContain(
      "payment_readiness_contract_version = 'finance-payment-readiness.v1'",
    );
    expect(migration).toContain("payment_methods_revision BETWEEN 1 AND 2147483647");
    expect(migration).toContain("source_pricing_currency_revision BETWEEN 1 AND 2147483647");
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO)\s+finance\.payment_settings\b/i);
    expect(migration).not.toMatch(/\bDEFAULT\b/i);
  });

  it("binds the exact PMS pricing currency and seeds only approved access", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, default_currency, source_pricing_currency_revision)",
    );
    expect(migration).toContain("REFERENCES pms.property_pricing_settings");
    expect(migration).toContain("'pms.finance.manage', 'pms'");
    for (const role of ["hotel_owner", "owner", "finance_manager"]) {
      expect(migration).toContain(`'hotel_group', '${role}'`);
    }
    expect(migration).not.toContain("'operator',          'pms.finance.manage'");
    expect(migration).not.toContain("'front_desk',        'pms.finance.manage'");
  });

  it("preserves the identity relationship vocabulary and adds finance_manager", () => {
    for (const relationship of [
      "owner",
      "operator",
      "front_desk",
      "finance_manager",
      "promotes",
      "billing_account",
    ]) {
      expect(migration).toContain(`'${relationship}'`);
    }
    expect(migration).toContain("organization_resource_links_relationship_check");
    expect(migration).toContain("chk_organization_resource_links_relationship");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance payment-readiness migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS finance CASCADE;
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA pms;
      CREATE SCHEMA finance;

      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.permission_catalog (
        key TEXT PRIMARY KEY, product TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE identity.role_permission_grants (
        organization_kind TEXT NOT NULL, role_key TEXT NOT NULL,
        permission_key TEXT NOT NULL REFERENCES identity.permission_catalog(key),
        UNIQUE (organization_kind, role_key, permission_key)
      );
      CREATE TABLE identity.organization_resource_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES identity.organizations(id),
        product TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        relationship TEXT NOT NULL CHECK (relationship IN (
          'owner', 'operator', 'front_desk', 'promotes', 'billing_account'
        )),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
        UNIQUE (organization_id, product, resource_type, resource_id, relationship)
      );
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.property_pricing_settings (
        property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
        currency CHAR(3) NOT NULL,
        pricing_currency_revision BIGINT NOT NULL,
        UNIQUE (property_id, currency, pricing_currency_revision)
      );
      CREATE TABLE finance.payment_settings (
        property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
        payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        accepted_methods TEXT[] NOT NULL DEFAULT '{}',
        default_currency CHAR(3) NOT NULL
      );

      INSERT INTO identity.organizations VALUES ('${ORGANIZATION_ID}');
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_ID}');
      INSERT INTO pms.property_pricing_settings VALUES ('${PROPERTY_ID}', 'EUR', 7);
      INSERT INTO finance.payment_settings VALUES ('${PROPERTY_ID}', false, '{}', 'EUR');
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("keeps legacy settings unbound and enforces the exact PMS revision", async () => {
    const legacy = await client.query(
      `SELECT payment_methods_revision, source_pricing_currency_revision
       FROM finance.payment_settings WHERE property_id = $1`,
      [PROPERTY_ID],
    );
    expect(legacy.rows[0]).toEqual({
      payment_methods_revision: null,
      source_pricing_currency_revision: null,
    });

    await client.query(
      `UPDATE finance.payment_settings
       SET payment_readiness_contract_version = 'finance-payment-readiness.v1',
           payment_methods_revision = 1, source_pricing_currency_revision = 7
       WHERE property_id = $1`,
      [PROPERTY_ID],
    );
    await expect(
      client.query(
        `UPDATE finance.payment_settings SET source_pricing_currency_revision = 8
         WHERE property_id = $1`,
        [PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_finance_payment_settings_pricing_currency_revision",
    });
  });

  it("rejects partial, zero, and lookalike readiness bindings", async () => {
    for (const update of [
      "payment_methods_revision = 1",
      "payment_readiness_contract_version = 'finance-payment-readiness.v1', payment_methods_revision = 0, source_pricing_currency_revision = 7",
      "payment_readiness_contract_version = 'lookalike.v1', payment_methods_revision = 1, source_pricing_currency_revision = 7",
    ]) {
      await expect(
        client.query(`UPDATE finance.payment_settings SET ${update} WHERE property_id = $1`, [
          PROPERTY_ID,
        ]),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_finance_payment_settings_readiness_binding",
      });
    }
  });

  it("preserves identity uniqueness/status and accepts finance_manager only as added", async () => {
    for (const [index, relationship] of [
      "owner",
      "operator",
      "front_desk",
      "promotes",
      "billing_account",
      "finance_manager",
    ].entries()) {
      await client.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'pms', 'pms_property', $2, $3, $4)`,
        [
          ORGANIZATION_ID,
          `${PROPERTY_ID}:${index}`,
          relationship,
          index === 5 ? "suspended" : "active",
        ],
      );
    }
    const rows = await client.query<{ relationship: string; status: string }>(
      `SELECT relationship, status FROM identity.organization_resource_links
       ORDER BY relationship`,
    );
    expect(rows.rows).toContainEqual({ relationship: "finance_manager", status: "suspended" });

    await expect(
      client.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ($1, 'pms', 'pms_property', $2, 'unknown')`,
        [ORGANIZATION_ID, PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_organization_resource_links_relationship",
    });
    await expect(
      client.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ($1, 'pms', 'pms_property', $2, 'owner'),
                ($1, 'pms', 'pms_property', $2, 'owner')`,
        [ORGANIZATION_ID, "duplicate"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("seeds the approved permission grants idempotently", async () => {
    const grants = await client.query<{ roleKey: string }>(
      `SELECT role_key AS "roleKey" FROM identity.role_permission_grants
       WHERE permission_key = 'pms.finance.manage' ORDER BY role_key`,
    );
    expect(grants.rows).toEqual([
      { roleKey: "finance_manager" },
      { roleKey: "hotel_owner" },
      { roleKey: "owner" },
    ]);
    await client.query(permissionSeeds);
    expect(
      (await client.query("SELECT count(*)::int AS count FROM identity.role_permission_grants"))
        .rows[0],
    ).toEqual({ count: 3 });
  });
});
