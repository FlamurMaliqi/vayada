import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0060_finance_expense_categories.sql"),
  "utf8",
);
const categorySeeds = migration.match(
  /INSERT INTO finance\.expense_categories[\s\S]+?DO NOTHING;/,
)?.[0];
if (!categorySeeds) throw new Error("0060 category seeds are not replay-safe");

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";

describe("Finance expense category migration contract", () => {
  it("owns categories and recurrence without inventing an expense ledger", () => {
    expect(migration).toContain("CREATE TABLE finance.expense_categories");
    expect(migration).toContain("CREATE TABLE finance.recurring_expense_rules");
    expect(migration).toContain("uq_finance_expense_categories_property_system_key");
    expect(migration).toContain("chk_finance_expense_categories_system_key_immutable");
    expect(migration).toContain("fk_finance_recurring_expense_rules_pricing_currency");
    expect(migration).toContain("amount < 'Infinity'::NUMERIC");
    expect(migration).toContain("fk_finance_recurring_expense_rules_active_category");
    expect(migration).toContain("idx_finance_recurring_expense_rules_category");
    expect(migration).not.toContain("CREATE TABLE finance.expenses");
    expect(migration).not.toMatch(/profit.?loss/i);
  });

  it("seeds the approved stable defaults only", () => {
    for (const key of [
      "staff",
      "ota_commission",
      "utilities",
      "maintenance",
      "supplies",
      "marketing",
      "platform_fees",
    ]) {
      expect(categorySeeds).toContain(`'${key}'`);
    }
    expect(categorySeeds).toContain(
      "ON CONFLICT (property_id, system_key) WHERE system_key IS NOT NULL DO NOTHING",
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance expense categories (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS finance CASCADE;
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA pms;
      CREATE SCHEMA finance;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.property_pricing_settings (
        property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
        currency CHAR(3) NOT NULL,
        UNIQUE (property_id, currency)
      );
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
      INSERT INTO pms.property_pricing_settings VALUES
        ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("seeds defaults replay-safely without overwriting presentation", async () => {
    expect(
      (await client.query("SELECT count(*)::int AS count FROM finance.expense_categories")).rows[0],
    ).toEqual({ count: 14 });
    await client.query(
      "UPDATE finance.expense_categories SET name = 'Team' WHERE property_id = $1 AND system_key = 'staff'",
      [PROPERTY_A],
    );
    await client.query(categorySeeds!);
    expect(
      (
        await client.query(
          "SELECT name FROM finance.expense_categories WHERE property_id = $1 AND system_key = 'staff'",
          [PROPERTY_A],
        )
      ).rows[0],
    ).toEqual({ name: "Team" });
  });

  it("keeps system keys closed and immutable", async () => {
    await expect(
      client.query(
        `INSERT INTO finance.expense_categories
           (property_id, system_key, name, color) VALUES ($1, 'custom_key', 'Fake', '#000000')`,
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_expense_categories_system_key",
    });
    await expect(
      client.query(
        "UPDATE finance.expense_categories SET system_key = NULL WHERE property_id = $1 AND system_key = 'staff'",
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_expense_categories_system_key_immutable",
    });
  });

  it("rejects cross-property categories and currencies", async () => {
    const category = await client.query<{ id: string }>(
      "SELECT id FROM finance.expense_categories WHERE property_id = $1 LIMIT 1",
      [PROPERTY_A],
    );
    const values = [PROPERTY_B, category.rows[0]!.id, "monthly", "2026-08-01", "Vendor", 10];
    await expect(
      client.query(
        `INSERT INTO finance.recurring_expense_rules
           (property_id, category_id, cadence, starts_on, next_due_on, vendor, amount, currency)
         VALUES ($1, $2, $3, $4, $4, $5, $6, 'USD')`,
        values,
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_finance_recurring_expense_rules_category_property",
    });
    await expect(
      client.query(
        `INSERT INTO finance.recurring_expense_rules
           (property_id, category_id, cadence, starts_on, next_due_on, vendor, amount, currency)
         VALUES ($1, $2, $3, $4, $4, $5, $6, 'USD')`,
        [PROPERTY_A, category.rows[0]!.id, "monthly", "2026-08-01", "Vendor", 10],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_finance_recurring_expense_rules_pricing_currency",
    });
  });

  it("prevents active rules from using archived categories", async () => {
    const category = await client.query<{ id: string }>(
      "SELECT id FROM finance.expense_categories WHERE property_id = $1 LIMIT 1",
      [PROPERTY_A],
    );
    await client.query(
      `INSERT INTO finance.recurring_expense_rules
         (property_id, category_id, cadence, starts_on, next_due_on, vendor, amount, currency)
       VALUES ($1, $2, 'monthly', '2026-08-01', '2026-08-01', 'Vendor', 10, 'EUR')`,
      [PROPERTY_A, category.rows[0]!.id],
    );
    await expect(
      client.query("UPDATE finance.expense_categories SET archived_at = now() WHERE id = $1", [
        category.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_finance_recurring_expense_rules_active_category",
    });
    await expect(
      client.query(
        `INSERT INTO finance.recurring_expense_rules
           (property_id, category_id, cadence, starts_on, next_due_on, vendor, amount, currency)
         VALUES ($1, $2, 'monthly', '2026-08-01', '2026-08-01', 'Vendor', 'NaN', 'EUR')`,
        [PROPERTY_A, category.rows[0]!.id],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_recurring_expense_rules_amount",
    });
  });
});
