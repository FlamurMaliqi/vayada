import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0093_booking_guest_nationality_review.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("Booking guest nationality review expand migration contract", () => {
  it("adds review evidence without quarantining or scanning existing rows", () => {
    expect(migration).toContain("country_code_raw TEXT");
    expect(migration).toContain("country_code_review_required BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migration).toContain("chk_booking_guests_country_review_evidence");
    expect(migration).toContain(") NOT VALID");
    expect(migration).not.toContain("UPDATE booking.booking_guests");
    expect(migration).not.toContain("VALIDATE CONSTRAINT");
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "Booking guest nationality review expand migration (PostgreSQL)",
  () => {
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
          ('10000000-0000-4000-8000-000000000002', 'ZZ'),
          ('10000000-0000-4000-8000-000000000003', NULL);
      `);
      await client.query(migration);
    });

    afterEach(async () => {
      try {
        await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
      } finally {
        await client.end();
      }
    });

    it("preserves every existing value for deployed readers and writers", async () => {
      const result = await client.query(
        `SELECT BTRIM(country_code) AS "countryCode",
                country_code_raw AS "rawValue",
                country_code_review_required AS "reviewRequired"
         FROM booking.booking_guests
         ORDER BY id`,
      );
      expect(result.rows).toEqual([
        { countryCode: "NL", rawValue: null, reviewRequired: false },
        { countryCode: "ZZ", rawValue: null, reviewRequired: false },
        { countryCode: null, rawValue: null, reviewRequired: false },
      ]);
    });

    it("keeps old writes compatible while enforcing new raw review evidence", async () => {
      await client.query(
        `UPDATE booking.booking_guests SET country_code = 'NL'
         WHERE id = '10000000-0000-4000-8000-000000000002'`,
      );
      await client.query(
        `INSERT INTO booking.booking_guests
           (id, country_code_raw, country_code_review_required)
         VALUES ('10000000-0000-4000-8000-000000000006', 'Holland', TRUE)`,
      );
      await expect(
        client.query(
          `INSERT INTO booking.booking_guests
             (id, country_code, country_code_raw, country_code_review_required)
           VALUES ('10000000-0000-4000-8000-000000000007', 'NL', 'Holland', TRUE)`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_booking_guests_country_review_evidence",
      });
    });
  },
);
