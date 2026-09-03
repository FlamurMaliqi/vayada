import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const MIGRATION_PATH = join(import.meta.dirname, "../migrations/0050_pms_pricing_source.sql");
const migration = await readFile(MIGRATION_PATH, "utf8");
const HISTORICAL_CURRENCIES_MIGRATION_PATH = join(
  import.meta.dirname,
  "../migrations/0137_pms_historical_pricing_currencies.sql",
);
const historicalCurrenciesMigration = await readFile(HISTORICAL_CURRENCIES_MIGRATION_PATH, "utf8");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS pricing-source migration contract", () => {
  it("adds a pricing-specific authoritative currency and canonical plan marker", () => {
    expect(migration).toContain("CREATE TABLE pms.property_pricing_settings");
    expect(migration).toContain(
      "LOCK TABLE pms.room_types, pms.rate_plans IN SHARE ROW EXCLUSIVE MODE",
    );
    expect(migration).toContain("pricing_currency_revision   BIGINT");
    expect(migration).toContain("chk_pms_property_pricing_currency_consistency");
    expect(migration).toContain("fk_pms_rate_plans_pricing_currency_revision");
    expect(migration).toContain("enforce_configured_pricing_currency_on_legacy_write");
    expect(migration).toContain("enforce_pricing_settings_legacy_currency_consistency");
    expect(migration).toContain("ADD COLUMN pricing_contract_version TEXT");
    expect(migration).toContain("ADD COLUMN flexible_rate_plan_revision BIGINT");
    expect(migration).toContain("ADD COLUMN source_room_facts_revision BIGINT");
    expect(migration).toContain("ADD COLUMN source_pricing_currency_revision BIGINT");
    expect(migration).toContain("uq_pms_rate_plans_room_canonical_flexible");
  });

  it("retains legacy values and does not invent cancellation or adjacent pricing rules", () => {
    expect(migration).not.toMatch(/DELETE FROM pms\.(?:room_types|rate_plans)/i);
    expect(migration).not.toMatch(/UPDATE pms\.(?:room_types|rate_plans)/i);
    expect(migration).not.toMatch(/INSERT INTO pms\.rate_plans/i);
    expect(migration).not.toContain("freeCancellationDeadlineDays', 7");
    expect(migration).not.toMatch(/pms\.(?:rate_rules|inventory_days|room_blocks)/);
    expect(migration).not.toMatch(/\b(?:booking|finance|distribution|marketplace)\./);
    expect(migration).not.toContain("vayada:no-transaction");
    expect(migration).not.toContain("IF NOT EXISTS");
  });

  it("keeps inactive historical currencies while guarding every activation path", () => {
    expect(historicalCurrenciesMigration).toContain("IF NEW.currency IS NULL OR NOT NEW.active");
    expect(historicalCurrenciesMigration).toContain(
      "BEFORE INSERT OR UPDATE OF property_id, currency, active",
    );
    expect(historicalCurrenciesMigration).toMatch(
      /WHERE property_id = NEW\.property_id AND active/,
    );
    expect(historicalCurrenciesMigration).not.toMatch(
      /DELETE FROM pms\.(?:room_types|rate_plans)/i,
    );
    expect(historicalCurrenciesMigration).not.toMatch(/UPDATE pms\.(?:room_types|rate_plans)/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS pricing-source migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    await createPre0050Schema(client);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("backfills one proven currency and preserves every legacy amount and plan", async () => {
    await seedProperties(client);
    await client.query(migration);

    const { rows: settings } = await client.query(`
      SELECT property_id::text AS "propertyId", currency::text AS currency,
             pricing_currency_revision::text AS "revision"
      FROM pms.property_pricing_settings ORDER BY property_id
    `);
    expect(settings).toEqual([
      { propertyId: PROPERTY_A, currency: "EUR", revision: "1" },
      { propertyId: PROPERTY_B, currency: "CHF", revision: "1" },
    ]);

    const { rows: roomTypes } = await client.query(`
      SELECT id::text AS id, base_rate_amount::text AS amount, currency::text AS currency
      FROM pms.room_types ORDER BY id
    `);
    expect(roomTypes).toEqual([
      { id: ROOM_A, amount: "160.00", currency: "EUR" },
      { id: ROOM_B, amount: null, currency: null },
      { id: ROOM_C, amount: "245.00", currency: "EUR" },
      { id: ROOM_D, amount: "90.00", currency: "CHF" },
    ]);

    const { rows: legacyPlans } = await client.query(`
      SELECT id::text AS id, base_rate_amount::text AS amount,
             cancellation_policy_snapshot AS cancellation,
             pricing_contract_version AS "contractVersion"
      FROM pms.rate_plans ORDER BY id
    `);
    expect(legacyPlans).toEqual([
      { id: LEGACY_PLAN_A, amount: "160.00", cancellation: {}, contractVersion: null },
      { id: LEGACY_PLAN_B, amount: "150.00", cancellation: {}, contractVersion: null },
    ]);

    await expectConstraint(
      client,
      `UPDATE pms.room_types SET currency = 'USD' WHERE id = '${ROOM_A}'`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.rate_plans
         (id, property_id, room_type_id, code, name, base_rate_amount, currency)
       VALUES
         ('41000000-0000-4000-8000-000000000099', '${PROPERTY_A}', '${ROOM_A}',
          'USD', 'Wrong currency', 100, 'USD')`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
  });

  it("accepts only one exact canonical flexible plan per room", async () => {
    await seedProperties(client);
    await client.query(migration);

    await client.query(canonicalPlanInsert(CANONICAL_PLAN_A, ROOM_A));
    const { rows } = await client.query(`
      SELECT pricing_contract_version AS "contractVersion",
             flexible_rate_plan_revision::text AS "planRevision",
             source_room_facts_revision::text AS "roomFactsRevision",
             source_pricing_currency_revision::text AS "currencyRevision",
             base_rate_amount::text AS amount,
             cancellation_policy_snapshot AS cancellation
      FROM pms.rate_plans WHERE id = '${CANONICAL_PLAN_A}'
    `);
    expect(rows).toEqual([
      {
        contractVersion: "pms-pricing.v1",
        planRevision: "1",
        roomFactsRevision: "2",
        currencyRevision: "1",
        amount: "175.25",
        cancellation: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
      },
    ]);

    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_A),
      "uq_pms_rate_plans_room_canonical_flexible",
      "23505",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, {
        cancellation: `'{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,"afterDeadlinePenalty":"first_night","noShowPenalty":"full_booking_amount"}'::jsonb`,
      }),
      "chk_pms_rate_plans_canonical_flexible_shape",
      "23514",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, { amount: "0.00" }),
      "chk_pms_rate_plans_canonical_flexible_shape",
      "23514",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, { roomFactsRevision: "NULL" }),
      "chk_pms_rate_plans_pricing_metadata",
      "23514",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, { currencyRevision: "999" }),
      "fk_pms_rate_plans_pricing_currency_revision",
      "23503",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, {
        cancellation: `'${cancellationWithDeadline("1.5")}'::jsonb`,
      }),
      "chk_pms_rate_plans_canonical_flexible_shape",
      "23514",
    );
    await expectConstraint(
      client,
      canonicalPlanInsert(CANONICAL_PLAN_B, ROOM_C, {
        cancellation: `'${cancellationWithDeadline("999999999999999999999999999999")}'::jsonb`,
      }),
      "chk_pms_rate_plans_canonical_flexible_shape",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.rate_plans
       SET flexible_rate_plan_revision = 1
       WHERE id = '${LEGACY_PLAN_A}'`,
      "chk_pms_rate_plans_pricing_metadata",
      "23514",
    );

    await expectConstraint(
      client,
      `UPDATE pms.property_pricing_settings
       SET pricing_currency_revision = 2
       WHERE property_id = '${PROPERTY_A}'`,
      "fk_pms_rate_plans_pricing_currency_revision",
      "23503",
    );
    await client.query(`UPDATE pms.property_pricing_settings
      SET pricing_currency_revision = 2
      WHERE property_id = '${PROPERTY_B}'`);
  });

  it("stages mounted legacy prices without creating authoritative settings", async () => {
    await seedProperties(client);
    await client.query(migration);

    await client.query(`INSERT INTO pms.room_types
      (id, property_id, name, base_rate_amount, currency)
      VALUES ('${ROOM_E}', '${PROPERTY_C}', 'First priced room', 120.00, 'EUR')`);

    const { rows: settings } = await client.query(`
      SELECT currency::text AS currency,
             pricing_currency_revision::text AS revision
      FROM pms.property_pricing_settings
      WHERE property_id = '${PROPERTY_C}'
    `);
    expect(settings).toEqual([]);

    await expectConstraint(
      client,
      `INSERT INTO pms.room_types
        (id, property_id, name, base_rate_amount, currency)
       VALUES ('${ROOM_G}', '${PROPERTY_C}', 'Conflicting legacy room', 140.00, 'USD')`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.property_pricing_settings
        (property_id, currency) VALUES ('${PROPERTY_C}', 'USD')`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await client.query(`INSERT INTO pms.property_pricing_settings
      (property_id, currency) VALUES ('${PROPERTY_C}', 'EUR')`);

    await client.query(`INSERT INTO pms.room_types
      (id, property_id, name, base_rate_amount, currency)
      VALUES ('${ROOM_F}', '${PROPERTY_C}', 'Same currency', 130.00, 'EUR')`);
    await expectConstraint(
      client,
      `UPDATE pms.room_types SET property_id = '${PROPERTY_B}' WHERE id = '${ROOM_F}'`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.property_pricing_settings
       SET property_id = '${PROPERTY_B}' WHERE property_id = '${PROPERTY_C}'`,
      "chk_pms_property_pricing_settings_property_immutable",
      "23514",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.room_types
        (id, property_id, name, base_rate_amount, currency)
       VALUES ('${ROOM_G}', '${PROPERTY_C}', 'Wrong currency', 140.00, 'USD')`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.rate_plans
        (id, property_id, room_type_id, code, name, base_rate_amount, currency)
       VALUES ('${LEGACY_PLAN_C}', '${PROPERTY_C}', '${ROOM_E}', 'USD',
               'Wrong currency', 100.00, 'USD')`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await client.query(`INSERT INTO pms.rate_plans
      (id, property_id, room_type_id, code, name, base_rate_amount, currency)
      VALUES ('${LEGACY_PLAN_C}', '${PROPERTY_C}', '${ROOM_E}', 'FLEX',
              'Same currency', 120.00, 'EUR')`);
  });

  it("serializes authoritative setup against a concurrent mounted legacy price", async () => {
    await seedProperties(client);
    await client.query(migration);
    const competing = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await competing.connect();

    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO pms.room_types
        (id, property_id, name, base_rate_amount, currency)
        VALUES ('${ROOM_E}', '${PROPERTY_C}', 'Concurrent legacy room', 120.00, 'EUR')`);

      const conflictingSetup = expect(
        competing.query(`INSERT INTO pms.property_pricing_settings
          (property_id, currency) VALUES ('${PROPERTY_C}', 'USD')`),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_property_pricing_currency_consistency",
      });
      await client.query("COMMIT");
      await conflictingSetup;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await competing.end();
    }

    const { rows: settings } = await client.query(`
      SELECT property_id FROM pms.property_pricing_settings
      WHERE property_id = '${PROPERTY_C}'
    `);
    expect(settings).toEqual([]);
  });

  it("serializes concurrent first legacy writers to one observed currency", async () => {
    await seedProperties(client);
    await client.query(migration);
    const competing = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await competing.connect();

    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO pms.room_types
        (id, property_id, name, base_rate_amount, currency)
        VALUES ('${ROOM_E}', '${PROPERTY_C}', 'Concurrent EUR room', 120.00, 'EUR')`);

      const conflictingLegacyWrite = expect(
        competing.query(`INSERT INTO pms.room_types
          (id, property_id, name, base_rate_amount, currency)
          VALUES ('${ROOM_F}', '${PROPERTY_C}', 'Concurrent USD room', 120.00, 'USD')`),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_property_pricing_currency_consistency",
      });
      await client.query("COMMIT");
      await conflictingLegacyWrite;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await competing.end();
    }
  });

  it("preserves inactive conflicting prices but rejects reactivation", async () => {
    await seedProperties(client);
    await client.query(migration);
    await client.query(historicalCurrenciesMigration);

    await client.query(`INSERT INTO pms.room_types
      (id, property_id, name, base_rate_amount, currency, active)
      VALUES ('${ROOM_G}', '${PROPERTY_A}', 'Historical USD room', 140.00, 'USD', FALSE)`);
    await client.query(`INSERT INTO pms.rate_plans
      (id, property_id, room_type_id, code, name, base_rate_amount, currency, active)
      VALUES ('${LEGACY_PLAN_C}', '${PROPERTY_A}', '${ROOM_G}', 'OLD-USD',
              'Historical USD rate', 140.00, 'USD', FALSE)`);

    const { rows } = await client.query(`
      SELECT room.base_rate_amount::text AS "roomAmount", room.currency::text AS "roomCurrency",
             plan.base_rate_amount::text AS "planAmount", plan.currency::text AS "planCurrency"
      FROM pms.room_types room
      JOIN pms.rate_plans plan ON plan.room_type_id = room.id
      WHERE room.id = '${ROOM_G}'
    `);
    expect(rows).toEqual([
      { roomAmount: "140.00", roomCurrency: "USD", planAmount: "140.00", planCurrency: "USD" },
    ]);

    await expectConstraint(
      client,
      `UPDATE pms.room_types SET active = TRUE WHERE id = '${ROOM_G}'`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.rate_plans SET active = TRUE WHERE id = '${LEGACY_PLAN_C}'`,
      "chk_pms_property_pricing_currency_consistency",
      "23514",
    );
  });

  it("fails atomically when legacy currencies disagree", async () => {
    await seedProperties(client);
    await client.query(`UPDATE pms.rate_plans SET currency = 'USD' WHERE id = '${LEGACY_PLAN_A}'`);

    await client.query("BEGIN");
    await expect(client.query(migration)).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_property_pricing_currency_consistency",
    });
    await client.query("ROLLBACK");

    const { rows: settingsTables } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'pms' AND table_name = 'property_pricing_settings'
    `);
    expect(settingsTables).toEqual([]);
    const { rows: metadataColumns } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'pms' AND table_name = 'rate_plans'
        AND column_name = 'pricing_contract_version'
    `);
    expect(metadataColumns).toEqual([]);
  });
});

const PROPERTY_A = "30000000-0000-4000-8000-000000000001";
const PROPERTY_B = "30000000-0000-4000-8000-000000000002";
const PROPERTY_C = "30000000-0000-4000-8000-000000000003";
const ROOM_A = "40000000-0000-4000-8000-000000000001";
const ROOM_B = "40000000-0000-4000-8000-000000000002";
const ROOM_C = "40000000-0000-4000-8000-000000000003";
const ROOM_D = "40000000-0000-4000-8000-000000000004";
const ROOM_E = "40000000-0000-4000-8000-000000000005";
const ROOM_F = "40000000-0000-4000-8000-000000000006";
const ROOM_G = "40000000-0000-4000-8000-000000000007";
const LEGACY_PLAN_A = "41000000-0000-4000-8000-000000000001";
const LEGACY_PLAN_B = "41000000-0000-4000-8000-000000000002";
const LEGACY_PLAN_C = "41000000-0000-4000-8000-000000000003";
const CANONICAL_PLAN_A = "42000000-0000-4000-8000-000000000001";
const CANONICAL_PLAN_B = "42000000-0000-4000-8000-000000000002";

async function createPre0050Schema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA hotel_catalog;
    CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    CREATE SCHEMA pms;
    CREATE TABLE pms.room_types (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
      name TEXT NOT NULL,
      base_rate_amount NUMERIC(15, 2),
      currency CHAR(3),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      room_facts_revision BIGINT NOT NULL DEFAULT 1,
      CONSTRAINT uq_pms_room_types_id_property UNIQUE (id, property_id),
      CONSTRAINT chk_pms_room_types_price_currency_pair
        CHECK ((base_rate_amount IS NULL) = (currency IS NULL))
    );
    CREATE TABLE pms.rate_plans (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
      room_type_id UUID NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      rate_type TEXT NOT NULL DEFAULT 'flexible',
      meal_plan TEXT,
      payment_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      deposit_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      cancellation_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      base_rate_amount NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (base_rate_amount >= 0),
      currency CHAR(3) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      CONSTRAINT uq_pms_rate_plans_property_room_code UNIQUE (property_id, room_type_id, code),
      CONSTRAINT fk_pms_rate_plans_room_type_property
        FOREIGN KEY (room_type_id, property_id)
        REFERENCES pms.room_types(id, property_id)
    );
  `);
}

async function seedProperties(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO hotel_catalog.properties (id) VALUES
      ('${PROPERTY_A}'), ('${PROPERTY_B}'), ('${PROPERTY_C}');
    INSERT INTO pms.room_types
      (id, property_id, name, base_rate_amount, currency, room_facts_revision)
    VALUES
      ('${ROOM_A}', '${PROPERTY_A}', 'Deluxe', 160, 'EUR', 2),
      ('${ROOM_B}', '${PROPERTY_A}', 'Unpriced', NULL, NULL, 1),
      ('${ROOM_C}', '${PROPERTY_A}', 'Garden Suite', 245, 'EUR', 3),
      ('${ROOM_D}', '${PROPERTY_B}', 'Alpine Room', 90, 'CHF', 1);
    INSERT INTO pms.rate_plans
      (id, property_id, room_type_id, code, name, base_rate_amount, currency)
    VALUES
      ('${LEGACY_PLAN_A}', '${PROPERTY_A}', '${ROOM_A}', 'FLEX', 'Legacy flexible', 160, 'EUR'),
      ('${LEGACY_PLAN_B}', '${PROPERTY_A}', '${ROOM_A}', 'ADVANCE', 'Legacy advance', 150, 'EUR');
  `);
}

function canonicalPlanInsert(
  planId: string,
  roomTypeId: string,
  overrides: {
    amount?: string;
    cancellation?: string;
    roomFactsRevision?: string;
    currencyRevision?: string;
  } = {},
): string {
  const amount = overrides.amount ?? "175.25";
  const roomFactsRevision = overrides.roomFactsRevision ?? "2";
  const currencyRevision = overrides.currencyRevision ?? "1";
  const cancellation =
    overrides.cancellation ??
    `'{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb`;
  return `INSERT INTO pms.rate_plans (
    id, property_id, room_type_id, code, name, rate_type,
    cancellation_policy_snapshot, base_rate_amount, currency, active,
    pricing_contract_version, flexible_rate_plan_revision,
    source_room_facts_revision, source_pricing_currency_revision
  ) VALUES (
    '${planId}', '${PROPERTY_A}', '${roomTypeId}', 'ONB15-${planId}',
    'Flexible', 'flexible', ${cancellation}, ${amount}, 'EUR', TRUE,
    'pms-pricing.v1', 1, ${roomFactsRevision}, ${currencyRevision}
  )`;
}

function cancellationWithDeadline(deadline: string): string {
  return `{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":${deadline},"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}`;
}

async function expectConstraint(
  client: pg.Client,
  sql: string,
  constraint: string,
  code: string,
): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({ code, constraint });
}
