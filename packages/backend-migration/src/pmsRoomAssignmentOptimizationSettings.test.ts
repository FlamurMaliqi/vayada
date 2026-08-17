import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0095_pms_room_assignment_optimization_settings.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS room-assignment optimization settings migration", () => {
  it("adds the PMS-owned setting with the product default enabled", () => {
    expect(migration).toContain("CREATE TABLE pms.room_assignment_optimization_settings");
    expect(migration).toContain("CREATE VIEW pms.effective_room_assignment_optimization_settings");
    expect(migration).toContain("auto_rearrange_enabled   BOOLEAN     NOT NULL DEFAULT TRUE");
    expect(migration).toContain("COALESCE(settings.auto_rearrange_enabled, TRUE)");
    expect(migration).toContain("REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE");
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "PMS room-assignment optimization settings (PostgreSQL)",
  () => {
    let client: pg.Client;

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
    });

    afterEach(async () => {
      try {
        await client.query(
          "DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE",
        );
      } finally {
        await client.end();
      }
    });

    it("defaults properties without a settings row to enabled and cascades deletion", async () => {
      const propertyId = "10000000-0000-4000-8000-000000000001";
      await client.query("INSERT INTO hotel_catalog.properties (id) VALUES ($1)", [propertyId]);

      const defaulted = await client.query(
        `SELECT auto_rearrange_enabled AS "enabled"
           FROM pms.effective_room_assignment_optimization_settings
          WHERE property_id = $1`,
        [propertyId],
      );
      expect(defaulted.rows).toEqual([{ enabled: true }]);

      await client.query(
        `INSERT INTO pms.room_assignment_optimization_settings
           (property_id, auto_rearrange_enabled)
         VALUES ($1, FALSE)`,
        [propertyId],
      );
      const disabled = await client.query(
        `SELECT auto_rearrange_enabled AS "enabled"
           FROM pms.effective_room_assignment_optimization_settings
          WHERE property_id = $1`,
        [propertyId],
      );
      expect(disabled.rows).toEqual([{ enabled: false }]);

      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      const remaining = await client.query(
        "SELECT count(*)::int AS count FROM pms.room_assignment_optimization_settings",
      );
      expect(remaining.rows[0]?.count).toBe(0);
    });
  },
);
