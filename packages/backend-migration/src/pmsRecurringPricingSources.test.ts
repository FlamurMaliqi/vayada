import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const MIGRATION_PATH = join(
  import.meta.dirname,
  "../migrations/0052_pms_recurring_pricing_sources.sql",
);
const migration = await readFile(MIGRATION_PATH, "utf8");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS recurring-pricing source migration contract", () => {
  it("keeps four typed owner sources separate from legacy dated rules", () => {
    expect(migration).toContain("CREATE TABLE pms.recurring_pricing_sources");
    expect(migration).toContain("source_kind = 'additional_guest'");
    expect(migration).toContain("source_kind = 'non_refundable'");
    expect(migration).toContain("source_kind = 'weekend_surcharge'");
    expect(migration).toContain("CREATE TABLE pms.recurring_pricing_source_room_values");
    expect(migration).toContain("seasonal_nightly_amount           NUMERIC(15, 2)");
    expect(migration).toContain("weekend_surcharge_amount          NUMERIC(15, 2)");
    expect(migration).toContain("additional_guest_amount           NUMERIC(15, 2)");
    expect(migration).toContain("maximum_adult_guests              SMALLINT");
    expect(migration).not.toMatch(
      /(?:ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM) pms\.rate_rules/i,
    );
  });

  it("stores independent source, validation, and materialization revisions", () => {
    expect(migration).toContain(
      "ADD COLUMN optional_pricing_aggregate_revision BIGINT NOT NULL DEFAULT 0",
    );
    expect(migration).toContain("chk_pms_property_optional_pricing_aggregate_revision");
    expect(migration).toContain("source_revision                   BIGINT      NOT NULL");
    expect(migration).toContain("validation_revision               BIGINT      NOT NULL");
    expect(migration).toContain("validated_at                      TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("materialization_revision          BIGINT      NOT NULL DEFAULT 0");
    expect(migration).toContain("configured_state = 'disabled' THEN 'disabled'");
    expect(migration).toContain("validation_state = 'invalid' THEN 'invalid'");
    expect(migration).toContain("recurring_pricing_invalid_reasons_are_canonical");
    for (const reason of [
      "pricing_currency_mismatch",
      "pricing_currency_revision_stale",
      "room_type_missing",
      "room_facts_revision_stale",
      "flexible_rate_plan_missing",
      "flexible_rate_plan_revision_stale",
      "recurring_pricing_room_plan_missing",
      "season_overlap",
      "additional_guest_capacity_inapplicable",
      "non_refundable_payment_timing_invalid",
      "dependency_unavailable",
    ]) {
      expect(migration).toContain(`'${reason}'`);
    }
  });

  it("binds currency exactly and serializes every owner-source write", () => {
    expect(migration).toContain("fk_pms_recurring_pricing_sources_currency_revision");
    expect(migration).toContain("property_id, currency, source_pricing_currency_revision");
    expect(migration).toContain("pms-pricing-currency:");
    expect(migration).toContain("trg_pms_recurring_pricing_sources_currency_lock");
    expect(migration).toContain("trg_pms_recurring_pricing_room_values_currency_lock");
    expect(migration).toContain("trg_pms_non_refundable_rate_plan_source_rooms_currency_lock");
    expect(migration).toContain("chk_pms_recurring_pricing_source_identity_immutable");
    expect(migration).toContain("old_row->>'source_pricing_currency_revision'");
    expect(migration).toContain("uq_pms_recurring_pricing_sources_season_name");
    expect(migration).toContain("(property_id, lower(season_name))");
  });

  it("models a canonical non-refundable child without a derived amount", () => {
    const sourceRoot = migration.slice(
      migration.indexOf("CREATE TABLE pms.recurring_pricing_sources"),
      migration.indexOf("CREATE UNIQUE INDEX uq_pms_recurring_pricing_sources_weekend"),
    );
    const nonRefundableRoomTable = migration.slice(
      migration.indexOf("CREATE TABLE pms.non_refundable_rate_plan_source_rooms"),
      migration.indexOf("CREATE INDEX idx_pms_non_refundable_rate_plan_source_rooms_flexible"),
    );
    expect(sourceRoot).toContain("source_kind = 'non_refundable'");
    expect(sourceRoot).toContain("discount_percent BETWEEN 1 AND 50");
    expect(sourceRoot).toContain("cancellation_terms_type = 'non_refundable'");
    expect(sourceRoot).toContain("refund_policy = 'no_refund'");
    expect(sourceRoot).toContain("no_show_penalty = 'full_booking_amount'");
    expect(sourceRoot).toContain("payment_timing = 'prepay_full'");
    expect(nonRefundableRoomTable).toContain("PRIMARY KEY (source_id, room_type_id)");
    expect(nonRefundableRoomTable).toContain(
      "flexible_pricing_contract_version = 'pms-pricing.v1'",
    );
    expect(nonRefundableRoomTable).not.toMatch(
      /base_rate|derived_amount|discount_percent|cancellation_terms_type|refund_policy|payment_timing/i,
    );
    expect(migration).toContain("uq_pms_recurring_pricing_sources_non_refundable");
  });

  it("keeps immutable receipts and replaceable current rows within 366 dates", () => {
    expect(migration).toContain("CREATE TABLE pms.recurring_pricing_materialization_receipts");
    expect(migration).toContain(
      "CREATE TABLE pms.recurring_pricing_materialization_source_receipts",
    );
    expect(migration).toContain("CREATE TABLE pms.recurring_pricing_materialized_rows");
    expect(migration).toContain("CHECK ((horizon_end - horizon_start) BETWEEN 0 AND 365)");
    expect(migration).toContain("result = 'skipped_disabled'");
    expect(migration).toContain("result = 'skipped_invalid'");
    expect(migration).toContain("materialized_rows_sha256 ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("reject_recurring_pricing_receipt_mutation");
    expect(migration).toContain("PRIMARY KEY (property_id, source_id, room_type_id, stay_date)");
    expect(migration).toContain("fk_pms_recurring_pricing_materialized_rows_source");
    expect(migration).toContain("fk_pms_recurring_pricing_materialized_rows_room_type");
    expect(migration).not.toContain("fk_pms_recurring_pricing_materialized_rows_source_room");
    expect(migration).toContain("optional_pricing_aggregate_revision BIGINT NOT NULL");
    expect(migration).toContain(
      "chk_pms_recurring_pricing_materialization_receipt_aggregate_revision",
    );
    expect(migration).toContain(
      "source_id, property_id, source_kind, currency,\n      source_pricing_currency_revision",
    );
  });

  it("does not invent money, currency, optional rules, or adjacent-domain state", () => {
    expect(migration).not.toMatch(
      /(?:seasonal_nightly_amount|weekend_surcharge_amount|additional_guest_amount)\s+NUMERIC\(15, 2\)\s+[^,\n]*DEFAULT/i,
    );
    expect(migration).not.toMatch(/currency\s+CHAR\(3\)\s+[^,\n]*DEFAULT/i);
    expect(migration).not.toMatch(/INSERT INTO pms\.(?:recurring_pricing|non_refundable)/i);
    expect(migration).not.toMatch(/\b(?:booking|finance|distribution|marketplace)\./);
    expect(migration).not.toMatch(/pms\.(?:inventory_days|room_blocks)/);
    expect(migration).not.toContain("IF NOT EXISTS");
    expect(migration).not.toContain("vayada:no-transaction");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS recurring-pricing sources (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    await createPre0052Schema(client);
    await seedPricingFoundation(client);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("persists normalized season, weekend, additional-guest, and child-plan sources", async () => {
    await insertSeasonSource(client);
    await client.query(`
      INSERT INTO pms.recurring_pricing_sources (
        id, property_id, source_kind, source_revision, configured_state,
        validation_state, validation_revision, validated_at, invalid_reasons,
        currency, source_pricing_currency_revision, weekend_days
      ) VALUES (
        '${WEEKEND_SOURCE}', '${PROPERTY_ID}', 'weekend_surcharge', 1, 'active',
        'valid', 1, '${NOW}', '[]', 'EUR', 2, ARRAY['friday', 'saturday']
      );
      INSERT INTO pms.recurring_pricing_source_room_values (
        source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
        flexible_rate_plan_id, flexible_pricing_contract_version,
        source_flexible_plan_revision, currency, source_pricing_currency_revision,
        weekend_surcharge_amount
      ) VALUES (
        '${WEEKEND_SOURCE}', '${PROPERTY_ID}', 'weekend_surcharge', '${ROOM_ID}', 4,
        '${FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 3, 'EUR', 2, 15.00
      );
    `);
    await insertAdditionalGuestSource(client);
    await insertNonRefundableSource(client);

    const { rows: sources } = await client.query(`
      SELECT source_kind AS kind, lifecycle, source_revision::text AS revision,
             validation_revision::text AS "validationRevision",
             materialization_revision::text AS "materializationRevision"
      FROM pms.recurring_pricing_sources ORDER BY source_kind
    `);
    expect(sources).toEqual([
      {
        kind: "additional_guest",
        lifecycle: "active",
        revision: "1",
        validationRevision: "1",
        materializationRevision: "0",
      },
      {
        kind: "non_refundable",
        lifecycle: "active",
        revision: "1",
        validationRevision: "1",
        materializationRevision: "0",
      },
      {
        kind: "season",
        lifecycle: "active",
        revision: "1",
        validationRevision: "1",
        materializationRevision: "0",
      },
      {
        kind: "weekend_surcharge",
        lifecycle: "active",
        revision: "1",
        validationRevision: "1",
        materializationRevision: "0",
      },
    ]);

    const { rows: aggregate } = await client.query(`
      SELECT optional_pricing_aggregate_revision::text AS revision
      FROM pms.property_pricing_settings WHERE property_id = '${PROPERTY_ID}'
    `);
    expect(aggregate).toEqual([{ revision: "0" }]);

    const { rows: values } = await client.query(`
      SELECT source_kind AS kind,
             seasonal_nightly_amount::text AS seasonal,
             weekend_surcharge_amount::text AS weekend,
             maximum_adult_guests AS "maximumAdults",
             included_guest_count AS included,
             additional_guest_amount::text AS additional
      FROM pms.recurring_pricing_source_room_values ORDER BY source_kind
    `);
    expect(values).toEqual([
      {
        kind: "additional_guest",
        seasonal: null,
        weekend: null,
        maximumAdults: 4,
        included: 2,
        additional: "20.00",
      },
      {
        kind: "season",
        seasonal: "210.00",
        weekend: null,
        maximumAdults: null,
        included: null,
        additional: null,
      },
      {
        kind: "weekend_surcharge",
        seasonal: null,
        weekend: "15.00",
        maximumAdults: null,
        included: null,
        additional: null,
      },
    ]);

    const { rows: child } = await client.query(`
      SELECT child.room_type_id::text AS "roomTypeId",
             source.discount_percent AS discount,
             source.cancellation_terms_type AS type,
             source.refund_policy AS "refundPolicy",
             source.payment_timing AS "paymentTiming"
      FROM pms.non_refundable_rate_plan_source_rooms child
      JOIN pms.recurring_pricing_sources source
        ON source.id = child.source_id
       AND source.property_id = child.property_id
       AND source.source_kind = child.source_kind
      ORDER BY child.room_type_id
    `);
    expect(child).toEqual([
      {
        roomTypeId: ROOM_ID,
        discount: 10,
        type: "non_refundable",
        refundPolicy: "no_refund",
        paymentTiming: "prepay_full",
      },
      {
        roomTypeId: SECOND_ROOM_ID,
        discount: 10,
        type: "non_refundable",
        refundPolicy: "no_refund",
        paymentTiming: "prepay_full",
      },
    ]);

    const { rows: receiptForeignKey } = await client.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'fk_pms_recurring_pricing_materialization_source_root'
    `);
    expect(receiptForeignKey).toHaveLength(1);
    expect(receiptForeignKey[0]!.definition).toContain(
      "FOREIGN KEY (source_id, property_id, source_kind, currency, source_pricing_currency_revision)",
    );
    const { rows: materializedRootForeignKey } = await client.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'fk_pms_recurring_pricing_materialized_rows_source'
    `);
    expect(materializedRootForeignKey).toHaveLength(1);
    expect(materializedRootForeignKey[0]!.definition).toContain(
      "FOREIGN KEY (source_id, property_id, source_kind, currency, source_pricing_currency_revision)",
    );

    const { rows: roomPlanReason } = await client.query<{
      canonical: boolean;
      missingRoomTypeId: boolean;
    }>(`
      SELECT
        pms.recurring_pricing_invalid_reasons_are_canonical(
          '[{"code":"recurring_pricing_room_plan_missing","roomTypeId":"${ROOM_ID}"}]'
        ) AS canonical,
        pms.recurring_pricing_invalid_reasons_are_canonical(
          '[{"code":"recurring_pricing_room_plan_missing"}]'
        ) AS "missingRoomTypeId"
    `);
    expect(roomPlanReason).toEqual([{ canonical: true, missingRoomTypeId: false }]);
  });

  it("rejects noncanonical config, invalid evidence, and identity moves", async () => {
    await expectConstraint(
      client,
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         currency, source_pricing_currency_revision, weekend_days
       ) VALUES (
         '${WEEKEND_SOURCE}', '${PROPERTY_ID}', 'weekend_surcharge', 1, 'active',
         'valid', 1, '${NOW}', '[]', 'EUR', 2, ARRAY['saturday', 'friday']
       )`,
      "chk_pms_recurring_pricing_sources_typed_configuration",
      "23514",
    );

    await expectConstraint(
      client,
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         currency, source_pricing_currency_revision
       ) VALUES (
         '${ADDITIONAL_SOURCE}', '${PROPERTY_ID}', 'additional_guest', 1, 'active',
         'invalid', 1, '${NOW}',
         '[{"code":"dependency_unavailable"},{"code":"pricing_currency_mismatch"}]',
         'EUR', 2
       )`,
      "chk_pms_recurring_pricing_sources_states",
      "23514",
    );

    await expectConstraint(
      client,
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         currency, source_pricing_currency_revision
       ) VALUES (
         '${ADDITIONAL_SOURCE}', '${PROPERTY_ID}', 'additional_guest', 1, 'active',
         'valid', 1, '${NOW}', '[]', 'EUR', 99
       )`,
      "fk_pms_recurring_pricing_sources_currency_revision",
      "23503",
    );

    await insertAdditionalGuestSource(client);
    await expectConstraint(
      client,
      `UPDATE pms.recurring_pricing_source_room_values
       SET included_guest_count = maximum_adult_guests
       WHERE source_id = '${ADDITIONAL_SOURCE}'`,
      "chk_pms_recurring_pricing_room_values_shape",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.recurring_pricing_sources SET id = '${SEASON_SOURCE}'
       WHERE id = '${ADDITIONAL_SOURCE}'`,
      "chk_pms_recurring_pricing_source_identity_immutable",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.recurring_pricing_sources SET source_pricing_currency_revision = 3
       WHERE id = '${ADDITIONAL_SOURCE}'`,
      "chk_pms_recurring_pricing_source_identity_immutable",
      "23514",
    );
    await insertNonRefundableSource(client);
    await expectConstraint(
      client,
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         currency, source_pricing_currency_revision, discount_percent,
         cancellation_terms_type, refund_policy, no_show_penalty, payment_timing
       ) VALUES (
         '${DUPLICATE_NON_REFUNDABLE_SOURCE}', '${PROPERTY_ID}',
         'non_refundable', 1, 'active', 'valid', 1, '${NOW}', '[]', 'EUR', 2,
         10, 'non_refundable', 'no_refund', 'full_booking_amount', 'prepay_full'
       )`,
      "uq_pms_recurring_pricing_sources_non_refundable",
      "23505",
    );
  });

  it("fails closed on an uncoordinated currency-revision change", async () => {
    await insertSeasonSource(client);
    await expectConstraint(
      client,
      `UPDATE pms.property_pricing_settings
       SET pricing_currency_revision = 3
       WHERE property_id = '${PROPERTY_ID}'`,
      "fk_pms_recurring_pricing_sources_currency_revision",
      "23503",
    );
  });

  it("replaces only current bounded-horizon rows and retains immutable receipts", async () => {
    await insertSeasonSource(client);
    await client.query(`
      UPDATE pms.property_pricing_settings
      SET optional_pricing_aggregate_revision = 4
      WHERE property_id = '${PROPERTY_ID}';
      UPDATE pms.recurring_pricing_sources
      SET materialization_revision = 1
      WHERE id = '${SEASON_SOURCE}';
      INSERT INTO pms.recurring_pricing_materialization_receipts (
        id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, accepted_at
      ) VALUES (
        '${RECEIPT_A}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4, '${NOW}'
      );
      INSERT INTO pms.recurring_pricing_materialization_source_receipts (
        receipt_id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
        configured_state, validation_state, validation_revision,
        validated_at, invalid_reasons, source_lifecycle, materialization_revision,
        currency, source_pricing_currency_revision, result, materialized_row_count,
        materialized_rows_sha256
      ) VALUES (
        '${RECEIPT_A}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4,
        '${SEASON_SOURCE}', 'season', 1, 'active', 'valid', 1, '${NOW}', '[]',
        'active', 1, 'EUR', 2, 'materialized', 1, repeat('a', 64)
      );
      INSERT INTO pms.recurring_pricing_materialized_rows (
        receipt_id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
        source_lifecycle, materialization_revision, currency,
        source_pricing_currency_revision, room_type_id, stay_date,
        seasonal_nightly_amount
      ) VALUES (
        '${RECEIPT_A}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4,
        '${SEASON_SOURCE}', 'season', 1, 'active', 1, 'EUR', 2,
        '${ROOM_ID}', '2026-07-01', 210.00
      );
    `);

    await client.query(`
      DELETE FROM pms.recurring_pricing_source_room_values
      WHERE source_id = '${SEASON_SOURCE}' AND room_type_id = '${ROOM_ID}';
      INSERT INTO pms.recurring_pricing_source_room_values (
        source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
        flexible_rate_plan_id, flexible_pricing_contract_version,
        source_flexible_plan_revision, currency, source_pricing_currency_revision,
        seasonal_nightly_amount
      ) VALUES (
        '${SEASON_SOURCE}', '${PROPERTY_ID}', 'season', '${ROOM_ID}', 4,
        '${FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 3, 'EUR', 2, 220.00
      );
    `);
    const { rows: preservedEvidence } = await client.query(`
      SELECT current_row.seasonal_nightly_amount::text AS "materializedAmount",
             receipt.currency::text AS currency,
             receipt.source_pricing_currency_revision::text AS "currencyRevision",
             receipt.source_revision::text AS "sourceRevision"
      FROM pms.recurring_pricing_materialized_rows current_row
      JOIN pms.recurring_pricing_materialization_source_receipts receipt
        ON receipt.receipt_id = current_row.receipt_id
       AND receipt.source_id = current_row.source_id
      WHERE current_row.receipt_id = '${RECEIPT_A}'
    `);
    expect(preservedEvidence).toEqual([
      {
        materializedAmount: "210.00",
        currency: "EUR",
        currencyRevision: "2",
        sourceRevision: "1",
      },
    ]);

    await expectConstraint(
      client,
      `INSERT INTO pms.recurring_pricing_materialization_receipts (
         id, property_id, horizon_start, horizon_end,
         optional_pricing_aggregate_revision, accepted_at
       ) VALUES (
         '${RECEIPT_B}', '${PROPERTY_ID}', '2026-01-01', '2027-01-02', 4, '${NOW}'
       )`,
      "chk_pms_recurring_pricing_materialization_receipt_horizon",
      "23514",
    );
    await expectConstraint(
      client,
      `UPDATE pms.recurring_pricing_materialization_receipts
       SET accepted_at = '${LATER}' WHERE id = '${RECEIPT_A}'`,
      "chk_pms_recurring_pricing_materialization_receipt_immutable",
      "23514",
    );

    await client.query(`
      UPDATE pms.recurring_pricing_sources
      SET materialization_revision = 2
      WHERE id = '${SEASON_SOURCE}';
      INSERT INTO pms.recurring_pricing_materialization_receipts (
        id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, accepted_at
      ) VALUES (
        '${RECEIPT_B}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4, '${LATER}'
      );
      INSERT INTO pms.recurring_pricing_materialization_source_receipts (
        receipt_id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
        configured_state, validation_state, validation_revision,
        validated_at, invalid_reasons, source_lifecycle, materialization_revision,
        currency, source_pricing_currency_revision, result, materialized_row_count,
        materialized_rows_sha256
      ) VALUES (
        '${RECEIPT_B}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4,
        '${SEASON_SOURCE}', 'season', 1, 'active', 'valid', 1, '${NOW}', '[]',
        'active', 2, 'EUR', 2, 'materialized', 1, repeat('b', 64)
      );
      DELETE FROM pms.recurring_pricing_materialized_rows
      WHERE property_id = '${PROPERTY_ID}'
        AND stay_date BETWEEN '2026-01-01' AND '2026-12-31';
      INSERT INTO pms.recurring_pricing_materialized_rows (
        receipt_id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
        source_lifecycle, materialization_revision, currency,
        source_pricing_currency_revision, room_type_id, stay_date,
        seasonal_nightly_amount
      ) VALUES (
        '${RECEIPT_B}', '${PROPERTY_ID}', '2026-01-01', '2026-12-31', 4,
        '${SEASON_SOURCE}', 'season', 1, 'active', 2, 'EUR', 2,
        '${ROOM_ID}', '2026-07-01', 220.00
      );
    `);

    const { rows } = await client.query(`
      SELECT
        (SELECT count(*)::integer FROM pms.recurring_pricing_materialization_receipts)
          AS receipts,
        (SELECT count(*)::integer
         FROM pms.recurring_pricing_materialization_source_receipts) AS source_receipts,
        (SELECT seasonal_nightly_amount::text
         FROM pms.recurring_pricing_materialized_rows) AS amount
    `);
    expect(rows).toEqual([{ receipts: 2, source_receipts: 2, amount: "220.00" }]);
  });

  it("leaves legacy dated rules byte-for-byte untouched", async () => {
    const { rows } = await client.query(`
      SELECT id::text AS id, rule_payload::text AS payload
      FROM pms.rate_rules
    `);
    expect(rows).toEqual([{ id: LEGACY_RULE_ID, payload: '{"legacy": true}' }]);
  });
});

const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ROOM_ID = "10000000-0000-4000-8000-000000000002";
const FLEXIBLE_PLAN_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_FLEXIBLE_PLAN_ID = "20000000-0000-4000-8000-000000000002";
const LEGACY_RULE_ID = "40000000-0000-4000-8000-000000000001";
const SEASON_SOURCE = "50000000-0000-4000-8000-000000000001";
const WEEKEND_SOURCE = "50000000-0000-4000-8000-000000000002";
const ADDITIONAL_SOURCE = "50000000-0000-4000-8000-000000000003";
const NON_REFUNDABLE_SOURCE = "50000000-0000-4000-8000-000000000004";
const DUPLICATE_NON_REFUNDABLE_SOURCE = "50000000-0000-4000-8000-000000000005";
const RECEIPT_A = "60000000-0000-4000-8000-000000000001";
const RECEIPT_B = "60000000-0000-4000-8000-000000000002";
const NOW = "2026-08-03T08:30:00.000Z";
const LATER = "2026-08-03T09:30:00.000Z";

async function createPre0052Schema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA hotel_catalog;
    CREATE SCHEMA pms;
    CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    CREATE TABLE pms.property_pricing_settings (
      property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
      currency CHAR(3) NOT NULL,
      pricing_currency_revision BIGINT NOT NULL,
      CONSTRAINT uq_pms_property_pricing_settings_currency
        UNIQUE (property_id, currency),
      CONSTRAINT uq_pms_property_pricing_settings_currency_revision
        UNIQUE (property_id, currency, pricing_currency_revision)
    );
    CREATE TABLE pms.room_types (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
      room_facts_revision BIGINT NOT NULL,
      CONSTRAINT uq_pms_room_types_id_property UNIQUE (id, property_id)
    );
    CREATE TABLE pms.rate_plans (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
      room_type_id UUID NOT NULL,
      pricing_contract_version TEXT,
      flexible_rate_plan_revision BIGINT,
      CONSTRAINT uq_pms_rate_plans_id_property_room_type
        UNIQUE (id, property_id, room_type_id),
      CONSTRAINT fk_pms_rate_plans_room_type
        FOREIGN KEY (room_type_id, property_id)
        REFERENCES pms.room_types(id, property_id)
    );
    CREATE TABLE pms.rate_rules (
      id UUID PRIMARY KEY,
      rule_payload JSONB NOT NULL
    );
  `);
}

async function seedPricingFoundation(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO hotel_catalog.properties (id) VALUES ('${PROPERTY_ID}');
    INSERT INTO pms.property_pricing_settings (
      property_id, currency, pricing_currency_revision
    ) VALUES ('${PROPERTY_ID}', 'EUR', 2);
    INSERT INTO pms.room_types (id, property_id, room_facts_revision)
    VALUES
      ('${ROOM_ID}', '${PROPERTY_ID}', 4),
      ('${SECOND_ROOM_ID}', '${PROPERTY_ID}', 5);
    INSERT INTO pms.rate_plans (
      id, property_id, room_type_id, pricing_contract_version,
      flexible_rate_plan_revision
    ) VALUES
      ('${FLEXIBLE_PLAN_ID}', '${PROPERTY_ID}', '${ROOM_ID}', 'pms-pricing.v1', 3),
      (
        '${SECOND_FLEXIBLE_PLAN_ID}', '${PROPERTY_ID}', '${SECOND_ROOM_ID}',
        'pms-pricing.v1', 2
      );
    INSERT INTO pms.rate_rules (id, rule_payload)
    VALUES ('${LEGACY_RULE_ID}', '{"legacy": true}');
  `);
}

async function insertSeasonSource(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO pms.recurring_pricing_sources (
      id, property_id, source_kind, source_revision, configured_state,
      validation_state, validation_revision, validated_at, invalid_reasons,
      currency, source_pricing_currency_revision, season_name,
      season_start_month, season_start_day, season_end_month, season_end_day
    ) VALUES (
      '${SEASON_SOURCE}', '${PROPERTY_ID}', 'season', 1, 'active',
      'valid', 1, '${NOW}', '[]', 'EUR', 2, 'Winter', 12, 15, 1, 15
    );
    INSERT INTO pms.recurring_pricing_source_room_values (
      source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
      flexible_rate_plan_id, flexible_pricing_contract_version,
      source_flexible_plan_revision, currency, source_pricing_currency_revision,
      seasonal_nightly_amount
    ) VALUES (
      '${SEASON_SOURCE}', '${PROPERTY_ID}', 'season', '${ROOM_ID}', 4,
      '${FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 3, 'EUR', 2, 210.00
    );
  `);
}

async function insertAdditionalGuestSource(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO pms.recurring_pricing_sources (
      id, property_id, source_kind, source_revision, configured_state,
      validation_state, validation_revision, validated_at, invalid_reasons,
      currency, source_pricing_currency_revision
    ) VALUES (
      '${ADDITIONAL_SOURCE}', '${PROPERTY_ID}', 'additional_guest', 1, 'active',
      'valid', 1, '${NOW}', '[]', 'EUR', 2
    );
    INSERT INTO pms.recurring_pricing_source_room_values (
      source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
      flexible_rate_plan_id, flexible_pricing_contract_version,
      source_flexible_plan_revision, currency, source_pricing_currency_revision,
      maximum_adult_guests, included_guest_count, additional_guest_amount
    ) VALUES (
      '${ADDITIONAL_SOURCE}', '${PROPERTY_ID}', 'additional_guest', '${ROOM_ID}', 4,
      '${FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 3, 'EUR', 2, 4, 2, 20.00
    );
  `);
}

async function insertNonRefundableSource(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO pms.recurring_pricing_sources (
      id, property_id, source_kind, source_revision, configured_state,
      validation_state, validation_revision, validated_at, invalid_reasons,
      currency, source_pricing_currency_revision, discount_percent,
      cancellation_terms_type, refund_policy, no_show_penalty, payment_timing
    ) VALUES (
      '${NON_REFUNDABLE_SOURCE}', '${PROPERTY_ID}', 'non_refundable', 1, 'active',
      'valid', 1, '${NOW}', '[]', 'EUR', 2, 10, 'non_refundable', 'no_refund',
      'full_booking_amount', 'prepay_full'
    );
    INSERT INTO pms.non_refundable_rate_plan_source_rooms (
      source_id, property_id, source_kind, room_type_id, flexible_rate_plan_id,
      flexible_pricing_contract_version, source_flexible_plan_revision,
      source_room_facts_revision, currency, source_pricing_currency_revision
    ) VALUES
      (
        '${NON_REFUNDABLE_SOURCE}', '${PROPERTY_ID}', 'non_refundable', '${ROOM_ID}',
        '${FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 3, 4, 'EUR', 2
      ),
      (
        '${NON_REFUNDABLE_SOURCE}', '${PROPERTY_ID}', 'non_refundable',
        '${SECOND_ROOM_ID}', '${SECOND_FLEXIBLE_PLAN_ID}', 'pms-pricing.v1', 2, 5,
        'EUR', 2
      );
  `);
}

async function expectConstraint(
  client: pg.Client,
  sql: string,
  constraint: string,
  code: string,
): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({ code, constraint });
}
