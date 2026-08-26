import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NATIONALITY_OPTIONS } from "@vayada/locale-constants";

import { assertSafeTestDatabase } from "./testUtils.js";

const expandMigration = await readFile(
  join(import.meta.dirname, "../migrations/0093_booking_guest_nationality_review.sql"),
  "utf8",
);
const backfillMigration = await readFile(
  join(import.meta.dirname, "../migrations/0094_booking_guest_nationality_backfill.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("Booking guest nationality backfill contract", () => {
  it("quarantines unsupported codes and leaves validation for a later rollout", () => {
    expect(backfillMigration).toContain("UPDATE booking.booking_guests");
    expect(backfillMigration).toContain("country_code_raw = NULLIF(BTRIM(country_code), '')");
    expect(backfillMigration).toContain(
      "country_code_review_required = NULLIF(BTRIM(country_code), '') IS NOT NULL",
    );
    expect(backfillMigration).toContain("chk_booking_guests_country_supported");
    expect(backfillMigration).toContain("NOT VALID");
    expect(backfillMigration).not.toContain("VALIDATE CONSTRAINT");
  });

  it("keeps the database allowlist aligned with the shared nationality vocabulary", () => {
    const migrationCodes = [...backfillMigration.matchAll(/'([A-Z]{2})'/g)]
      .map((match) => match[1])
      .sort();
    const sharedCodes = NATIONALITY_OPTIONS.map((option) => option.code).sort();
    expect(migrationCodes).toEqual(sharedCodes);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking guest nationality backfill (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS booking CASCADE;
      CREATE SCHEMA booking;
      CREATE TABLE booking.booking_guests (
        id UUID PRIMARY KEY,
        country_code CHAR(2),
        CONSTRAINT chk_booking_guests_country_upper
          CHECK (country_code IS NULL OR country_code = upper(country_code))
      );
      INSERT INTO booking.booking_guests (id, country_code) VALUES
        ('10000000-0000-4000-8000-000000000001', 'NL'),
        ('10000000-0000-4000-8000-000000000002', 'XK'),
        ('10000000-0000-4000-8000-000000000003', 'XS'),
        ('10000000-0000-4000-8000-000000000004', 'XX'),
        ('10000000-0000-4000-8000-000000000005', 'ZZ'),
        ('10000000-0000-4000-8000-000000000006', NULL),
        ('10000000-0000-4000-8000-000000000007', '');
    `);
    await client.query(expandMigration);
    await client.query(backfillMigration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    } finally {
      await client.end();
    }
  });

  it("keeps canonical and special values while preserving unsupported evidence for review", async () => {
    const result = await client.query(
      `SELECT BTRIM(country_code) AS "countryCode",
              country_code_raw AS "rawValue",
              country_code_review_required AS "reviewRequired"
       FROM booking.booking_guests
       ORDER BY id`,
    );
    expect(result.rows).toEqual([
      { countryCode: "NL", rawValue: null, reviewRequired: false },
      { countryCode: "XK", rawValue: null, reviewRequired: false },
      { countryCode: "XS", rawValue: null, reviewRequired: false },
      { countryCode: "XX", rawValue: null, reviewRequired: false },
      { countryCode: null, rawValue: "ZZ", reviewRequired: true },
      { countryCode: null, rawValue: null, reviewRequired: false },
      { countryCode: null, rawValue: null, reviewRequired: false },
    ]);
  });

  it("blocks new unsupported codes without blocking reviewed raw evidence", async () => {
    await expect(
      client.query(
        `INSERT INTO booking.booking_guests (id, country_code)
         VALUES ('10000000-0000-4000-8000-000000000008', 'ZZ')`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_booking_guests_country_supported",
    });
    await expect(
      client.query(
        `INSERT INTO booking.booking_guests
           (id, country_code_raw, country_code_review_required)
         VALUES ('10000000-0000-4000-8000-000000000009', 'Atlantis', TRUE)`,
      ),
    ).resolves.toBeDefined();
  });
});
