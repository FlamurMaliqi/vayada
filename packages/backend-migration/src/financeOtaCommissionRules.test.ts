import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0095_finance_ota_commission_rules.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const OTA_CHANNELS = ["booking_com", "airbnb", "expedia", "agoda", "other_ota"];

describe("Finance OTA commission rule migration contract", () => {
  it("adds typed OTA windows without replacing generic commission rules", () => {
    expect(migration).toContain("ADD COLUMN ota_channel TEXT");
    expect(migration).toContain("ALTER COLUMN percentage_rate TYPE NUMERIC");
    expect(migration).toContain("chk_finance_commission_rules_percentage_rate_precision");
    expect(migration).toContain("chk_finance_ota_commission_rule_shape");
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(migration).toContain("EXCLUDE USING gist");
    expect(migration).not.toContain("DROP TABLE finance.commission_rules");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance OTA commission rules (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS finance CASCADE;
      CREATE SCHEMA finance;
      CREATE TABLE finance.commission_rules (
        id UUID PRIMARY KEY, property_id UUID, organization_id UUID, rule_scope TEXT NOT NULL,
        product TEXT NOT NULL, commission_type TEXT NOT NULL,
        percentage_rate NUMERIC(7, 4)
          CONSTRAINT chk_original_percentage_rate CHECK (
            percentage_rate IS NULL OR percentage_rate BETWEEN 0 AND 100
          ),
        fixed_amount NUMERIC(15, 2), currency CHAR(3),
        status TEXT NOT NULL DEFAULT 'active', starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ, source_system TEXT NOT NULL, source_rule_id TEXT
      );
      INSERT INTO finance.commission_rules
        (id, organization_id, rule_scope, product, commission_type, percentage_rate,
         starts_at, source_system, source_rule_id)
      VALUES ('10000000-0000-4000-8000-000000000001', '${PROPERTY_A}', 'affiliate',
        'affiliate', 'percentage', 10, '2026-01-01', 'pms', 'legacy-affiliate');
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves generic rows and accepts adjacent canonical windows", async () => {
    expect(
      (await client.query("SELECT ota_channel, revision FROM finance.commission_rules")).rows[0],
    ).toEqual({ ota_channel: null, revision: 1 });
    for (const [index, channel] of OTA_CHANNELS.entries()) {
      await insertRule(client, PROPERTY_A, channel, "2026-01-01", "2026-07-01", index + 2);
    }
    await insertRule(client, PROPERTY_A, "booking_com", "2026-07-01", null, 7);
    expect(
      (await client.query("SELECT count(*)::int AS count FROM finance.commission_rules")).rows[0],
    ).toEqual({ count: 7 });
  });

  it("rejects a concurrently inserted overlapping window", async () => {
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      await client.query("BEGIN");
      await other.query("BEGIN");
      await insertRule(client, PROPERTY_A, "booking_com", "2026-01-01", null, 2);
      const competingInsert = insertRule(other, PROPERTY_A, "booking_com", "2026-06-01", null, 3);
      await client.query("COMMIT");
      await expect(competingInsert).rejects.toMatchObject({
        code: "23P01",
        constraint: "ex_finance_ota_commission_rules_window",
      });
      await other.query("ROLLBACK");
    } finally {
      await other.end();
    }
  });

  it("rejects overlapping windows while isolating properties and channels", async () => {
    await insertRule(client, PROPERTY_A, "booking_com", "2026-01-01", null, 2);
    await expect(
      insertRule(client, PROPERTY_A, "booking_com", "2026-06-01", null, 3),
    ).rejects.toMatchObject({
      code: "23P01",
      constraint: "ex_finance_ota_commission_rules_window",
    });
    await insertRule(client, PROPERTY_A, "airbnb", "2026-06-01", null, 4);
    await insertRule(client, PROPERTY_B, "booking_com", "2026-06-01", null, 5);
  });

  it("rejects invalid OTA rule shapes", async () => {
    await expect(
      insertRule(client, PROPERTY_A, "vrbo", "2026-01-01", null, 2),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_ota_commission_rule_shape",
    });
    await expect(
      insertRule(client, PROPERTY_A, "booking_com", "2026-01-01", "2026-01-01", 3),
    ).rejects.toMatchObject({ constraint: "chk_finance_ota_commission_rule_shape" });
    await expect(
      insertRule(client, PROPERTY_A, "booking_com", "2026-01-01", null, 4, "101"),
    ).rejects.toMatchObject({ code: "23514", constraint: "chk_original_percentage_rate" });
    for (const [index, rate] of ["12.12345", "100.00001", "-0.00001"].entries()) {
      await expect(
        insertRule(client, PROPERTY_A, "booking_com", "2026-01-01", null, index + 5, rate),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});

function insertRule(
  client: pg.Client,
  propertyId: string,
  channel: string,
  startsAt: string,
  endsAt: string | null,
  suffix: number,
  percentageRate = "15.25",
) {
  return client.query(
    `INSERT INTO finance.commission_rules
       (id, property_id, rule_scope, product, commission_type, percentage_rate,
        starts_at, ends_at, source_system, ota_channel)
     VALUES ($1, $2, 'property', 'pms', 'percentage', $6, $3, $4, 'finance', $5)`,
    [
      `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      propertyId,
      startsAt,
      endsAt,
      channel,
      percentageRate,
    ],
  );
}
