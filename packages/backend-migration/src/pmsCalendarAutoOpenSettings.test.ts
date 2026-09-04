import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0135_pms_calendar_auto_open_settings.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS calendar auto-open settings migration", () => {
  it("defines one constrained, revisioned property setting and a virtual default", () => {
    expect(migration).toContain("CREATE TABLE pms.calendar_auto_open_settings");
    expect(migration).toContain("REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE");
    expect(migration).toContain("CHECK (rolling_months IN (12, 18, 24))");
    expect(migration).toContain("CREATE VIEW pms.effective_calendar_auto_open_settings");
    expect(migration).toContain("COALESCE(settings.enabled, FALSE)");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS calendar auto-open settings (PostgreSQL)", () => {
  let client: pg.Client;
  const propertyId = "14330000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA pms;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    `);
    await client.query(migration);
    await client.query("INSERT INTO hotel_catalog.properties (id) VALUES ($1)", [propertyId]);
  });

  afterEach(async () => {
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA hotel_catalog CASCADE");
    await client.end();
  });

  it("supports the disabled default, both modes, constraints, and property deletion", async () => {
    const effective = await client.query(
      `SELECT revision, enabled, mode, rolling_months AS "rollingMonths", fixed_end_month
       FROM pms.effective_calendar_auto_open_settings WHERE property_id = $1`,
      [propertyId],
    );
    expect(effective.rows).toEqual([
      { revision: 0, enabled: false, mode: "rolling", rollingMonths: 18, fixed_end_month: null },
    ]);

    await client.query(
      `INSERT INTO pms.calendar_auto_open_settings
         (property_id, revision, enabled, mode, rolling_months)
       VALUES ($1, 1, TRUE, 'rolling', 12)`,
      [propertyId],
    );
    await expect(
      client.query(
        `UPDATE pms.calendar_auto_open_settings
         SET mode = 'fixed', rolling_months = 18, fixed_end_month = DATE '2028-06-01'
         WHERE property_id = $1`,
        [propertyId],
      ),
    ).rejects.toMatchObject({ constraint: "chk_calendar_auto_open_mode_parameter" });

    await client.query(
      `UPDATE pms.calendar_auto_open_settings
       SET revision = 2, mode = 'fixed', rolling_months = NULL,
           fixed_end_month = DATE '2028-06-01'
       WHERE property_id = $1`,
      [propertyId],
    );
    await expect(
      client.query(
        `UPDATE pms.calendar_auto_open_settings SET fixed_end_month = DATE '2028-06-02'
         WHERE property_id = $1`,
        [propertyId],
      ),
    ).rejects.toMatchObject({ constraint: "chk_calendar_auto_open_fixed_month_start" });

    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
    const remaining = await client.query(
      "SELECT count(*)::int AS count FROM pms.calendar_auto_open_settings",
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });
});
