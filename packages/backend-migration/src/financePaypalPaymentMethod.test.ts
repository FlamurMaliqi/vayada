import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migrationPath = join(
  import.meta.dirname,
  "../migrations/0066_finance_paypal_payment_method.sql",
);
const migration = await readFile(migrationPath, "utf8");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("Finance PayPal payment method migration contract", () => {
  it("keeps Finance settings, payment records, and public offers on one method vocabulary", async () => {
    expect(migration).toContain("chk_finance_payment_settings_accepted_methods");
    expect(migration).toContain("payments_payment_method_check");
    expect(migration).toContain("chk_distribution_room_offer_snapshots_payment_options");
    expect(migration).toContain("distribution.public_room_offer_snapshots");
    expect(migration.match(/'paypal'/g)).toHaveLength(3);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance PayPal payment method (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS finance CASCADE;
      DROP SCHEMA IF EXISTS distribution CASCADE;
      CREATE SCHEMA finance;
      CREATE SCHEMA distribution;
      CREATE TABLE finance.payment_settings (
        accepted_methods TEXT[] NOT NULL DEFAULT '{}',
        CONSTRAINT chk_finance_payment_settings_accepted_methods
          CHECK (accepted_methods <@ ARRAY['card', 'bank_transfer']::TEXT[])
      );
      CREATE TABLE finance.payments (
        payment_method TEXT NOT NULL,
        CONSTRAINT payments_payment_method_check
          CHECK (payment_method IN ('card', 'bank_transfer'))
      );
      CREATE TABLE distribution.public_room_offer_snapshots (
        payment_options TEXT[] NOT NULL DEFAULT '{}',
        CONSTRAINT chk_distribution_room_offer_snapshots_payment_options
          CHECK (payment_options <@ ARRAY['card', 'bank_transfer']::TEXT[])
      );
    `);
  });

  afterEach(async () => {
    try {
      await client.query(
        "DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS distribution CASCADE",
      );
    } finally {
      await client.end();
    }
  });

  it("persists PayPal in settings, payment records, and public offers", async () => {
    await client.query(migration);
    await client.query("INSERT INTO finance.payment_settings VALUES (ARRAY['paypal'])");
    await client.query("INSERT INTO finance.payments VALUES ('paypal')");
    await client.query(
      "INSERT INTO distribution.public_room_offer_snapshots VALUES (ARRAY['paypal'])",
    );
    await expect(
      client.query("INSERT INTO finance.payments VALUES ('crypto')"),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "payments_payment_method_check",
    });
  });
});
