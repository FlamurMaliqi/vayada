import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0060_hotel_catalog_location_policy_revisions.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "30000000-0000-4000-8000-000000000001";
const maxPropertyId = "30000000-0000-4000-8000-000000000002";

describe("Hotel Catalog location and policy revision migration contract", () => {
  it("adds independent bounded revisions advanced by Catalog-owned triggers", () => {
    expect(migration).toContain("CREATE TABLE hotel_catalog.property_owner_revisions");
    expect(migration).toContain("'hotel_catalog.location', 'hotel_catalog.policy'");
    expect(migration).toContain("CHECK (revision BETWEEN 1 AND 2147483647)");
    expect(migration).toContain("AFTER INSERT OR UPDATE OR DELETE");
    expect(migration).toContain("trg_property_locations_advance_revision");
    expect(migration).toContain("trg_property_policy_summaries_advance_revision");
    expect(migration).not.toMatch(/hash|updated_at.*revision|extract\s*\(\s*epoch/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "Hotel Catalog location and policy revisions (PostgreSQL)",
  () => {
    const admin = client();
    const writerA = client();
    const writerB = client();

    beforeAll(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      await Promise.all([admin.connect(), writerA.connect(), writerB.connect()]);
    });

    beforeEach(async () => {
      await createPredecessorSchema(admin);
      await admin.query(migration);
    });

    afterAll(async () => {
      await admin.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      await Promise.all([admin.end(), writerA.end(), writerB.end()]);
    });

    it("backfills revision one and advances only the owner whose canonical data changes", async () => {
      await expect(revisions()).resolves.toEqual({ location: "1", policy: "1" });
      await admin.query(
        `UPDATE hotel_catalog.property_locations SET city = city, updated_at = now()
       WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await admin.query(
        `UPDATE hotel_catalog.property_policy_summaries
       SET cancellation_summary = cancellation_summary, updated_at = now()
       WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await expect(revisions()).resolves.toEqual({ location: "1", policy: "1" });

      await admin.query(
        `UPDATE hotel_catalog.property_locations SET city = 'Hamburg', updated_at = now()
       WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await expect(revisions()).resolves.toEqual({ location: "2", policy: "1" });
      await admin.query(
        `UPDATE hotel_catalog.property_policy_summaries SET check_in_time = '16:00'
       WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await expect(revisions()).resolves.toEqual({ location: "2", policy: "2" });
    });

    it("advances exactly once for changed upserts and not at all for no-op upserts", async () => {
      await upsertLocation("Berlin");
      await upsertPolicy("15:00");
      await expect(revisions()).resolves.toEqual({ location: "1", policy: "1" });

      await upsertLocation("Hamburg");
      await upsertPolicy("16:00");
      await expect(revisions()).resolves.toEqual({ location: "2", policy: "2" });
    });

    it("serializes concurrent mutations while keeping location and policy independent", async () => {
      await Promise.all([
        writerA.query(
          `UPDATE hotel_catalog.property_locations SET city = 'Cologne'
         WHERE property_id = $1::uuid`,
          [propertyId],
        ),
        writerB.query(
          `UPDATE hotel_catalog.property_locations SET city = 'Munich'
         WHERE property_id = $1::uuid`,
          [propertyId],
        ),
      ]);
      await expect(revisions()).resolves.toEqual({ location: "3", policy: "1" });

      await Promise.all([
        writerA.query(
          `UPDATE hotel_catalog.property_locations SET city = 'Dresden'
         WHERE property_id = $1::uuid`,
          [propertyId],
        ),
        writerB.query(
          `UPDATE hotel_catalog.property_policy_summaries SET check_out_time = '10:00'
         WHERE property_id = $1::uuid`,
          [propertyId],
        ),
      ]);
      await expect(revisions()).resolves.toEqual({ location: "4", policy: "2" });
    });

    it("preserves revision history through explicit absence and recreation", async () => {
      await admin.query(
        `DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await admin.query(
        `DELETE FROM hotel_catalog.property_policy_summaries WHERE property_id = $1::uuid`,
        [propertyId],
      );
      await expect(revisions()).resolves.toEqual({ location: "2", policy: "2" });

      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, city)
       VALUES ($1::uuid, 'Hamburg')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_policy_summaries (property_id, check_in_time)
       VALUES ($1::uuid, '16:00')`,
        [propertyId],
      );
      await expect(revisions()).resolves.toEqual({ location: "3", policy: "3" });
    });

    it("rejects an owner mutation after the bounded revision is exhausted", async () => {
      await admin.query(`INSERT INTO hotel_catalog.properties VALUES ($1::uuid)`, [maxPropertyId]);
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, city)
       VALUES ($1::uuid, 'Berlin')`,
        [maxPropertyId],
      );
      await admin.query(
        `UPDATE hotel_catalog.property_owner_revisions SET revision = 2147483647
       WHERE property_id = $1::uuid AND owner_key = 'hotel_catalog.location'`,
        [maxPropertyId],
      );
      await expect(
        admin.query(
          `UPDATE hotel_catalog.property_locations SET city = 'Hamburg'
         WHERE property_id = $1::uuid`,
          [maxPropertyId],
        ),
      ).rejects.toMatchObject({ code: "22003" });
      const row = await admin.query<{ city: string; revision: string }>(
        `SELECT location.city, owner.revision::text AS revision
       FROM hotel_catalog.property_locations location
       JOIN hotel_catalog.property_owner_revisions owner
         ON owner.property_id = location.property_id
        AND owner.owner_key = 'hotel_catalog.location'
       WHERE location.property_id = $1::uuid`,
        [maxPropertyId],
      );
      expect(row.rows[0]).toEqual({ city: "Berlin", revision: "2147483647" });
    });

    function client() {
      return new pg.Client({
        connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
      });
    }

    async function revisions() {
      const result = await admin.query<{ location: string; policy: string }>(
        `SELECT location.revision::text AS location, policy.revision::text AS policy
       FROM hotel_catalog.property_owner_revisions location
       JOIN hotel_catalog.property_owner_revisions policy USING (property_id)
       WHERE location.property_id = $1::uuid
         AND location.owner_key = 'hotel_catalog.location'
         AND policy.owner_key = 'hotel_catalog.policy'`,
        [propertyId],
      );
      return result.rows[0];
    }

    async function upsertLocation(city: string) {
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, city)
       VALUES ($1::uuid, $2)
       ON CONFLICT (property_id) DO UPDATE
         SET city = EXCLUDED.city, updated_at = now()`,
        [propertyId, city],
      );
    }

    async function upsertPolicy(checkInTime: string) {
      await admin.query(
        `INSERT INTO hotel_catalog.property_policy_summaries (property_id, check_in_time)
       VALUES ($1::uuid, $2::time)
       ON CONFLICT (property_id) DO UPDATE
         SET check_in_time = EXCLUDED.check_in_time, updated_at = now()`,
        [propertyId, checkInTime],
      );
    }
  },
);

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
    CREATE SCHEMA hotel_catalog;
    CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    CREATE TABLE hotel_catalog.property_locations (
      property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
      country_code CHAR(2), region TEXT, city TEXT, street_address TEXT, postal_code TEXT,
      raw_marketplace_location TEXT, latitude NUMERIC, longitude NUMERIC, timezone TEXT,
      address_public BOOLEAN NOT NULL DEFAULT FALSE,
      geo_public BOOLEAN NOT NULL DEFAULT FALSE,
      map_display_mode TEXT NOT NULL DEFAULT 'hidden',
      source_confidence TEXT NOT NULL DEFAULT 'unverified', migration_notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE hotel_catalog.property_policy_summaries (
      property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
      check_in_time TIME, check_out_time TIME, cancellation_summary TEXT,
      cancellation_terms_url TEXT, deposit_policy_summary TEXT, payment_policy_summary TEXT,
      policy_source_owner TEXT NOT NULL DEFAULT 'booking',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO hotel_catalog.properties VALUES ('${propertyId}'::uuid);
    INSERT INTO hotel_catalog.property_locations (property_id, city, timezone)
      VALUES ('${propertyId}'::uuid, 'Berlin', 'Europe/Berlin');
    INSERT INTO hotel_catalog.property_policy_summaries
      (property_id, check_in_time, check_out_time, cancellation_summary)
      VALUES ('${propertyId}'::uuid, '15:00', '11:00', 'Flexible cancellation');
  `);
}
