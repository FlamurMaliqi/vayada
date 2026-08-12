import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0065_property_terms_and_conditions.sql"),
  "utf8",
);
const revisionsMigration = await readFile(
  join(import.meta.dirname, "../migrations/0060_hotel_catalog_location_policy_revisions.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "65000000-0000-4000-8000-000000000001";

describe("property Terms & Conditions migration", () => {
  it("stores Terms & Conditions with the canonical hotel policy and revisions", () => {
    expect(migration).toContain("ALTER TABLE hotel_catalog.property_policy_summaries");
    expect(migration).toContain("ADD COLUMN terms_and_conditions TEXT");
    expect(migration).toContain("NEW.terms_and_conditions");
    expect(migration).toContain("OLD.terms_and_conditions");
    expect(migration).toContain("'hotel_catalog.policy'");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("property Terms & Conditions (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
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
      INSERT INTO hotel_catalog.property_policy_summaries (property_id)
        VALUES ('${propertyId}'::uuid);
    `);
    await client.query(revisionsMigration);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("persists legal text and advances the canonical policy revision", async () => {
    await client.query(
      `UPDATE hotel_catalog.property_policy_summaries
       SET terms_and_conditions = $2
       WHERE property_id = $1::uuid`,
      [propertyId, "Hotel Alpenrose booking terms."],
    );
    const result = await client.query<{ terms: string; revision: string }>(
      `SELECT policy.terms_and_conditions AS terms, owner.revision::text AS revision
       FROM hotel_catalog.property_policy_summaries policy
       JOIN hotel_catalog.property_owner_revisions owner USING (property_id)
       WHERE policy.property_id = $1::uuid
         AND owner.owner_key = 'hotel_catalog.policy'`,
      [propertyId],
    );

    expect(result.rows[0]).toEqual({
      terms: "Hotel Alpenrose booking terms.",
      revision: "2",
    });
  });
});
