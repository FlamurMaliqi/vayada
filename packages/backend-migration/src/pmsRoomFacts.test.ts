import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const MIGRATION_PATH = join(import.meta.dirname, "../migrations/0048_pms_room_facts.sql");
const migration = await readFile(MIGRATION_PATH, "utf8");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS room facts migration contract", () => {
  it("separates facts, capacity, draft binding, and legacy pricing", () => {
    expect(migration).toContain("ALTER COLUMN base_rate_amount DROP DEFAULT");
    expect(migration).toContain("ALTER COLUMN base_rate_amount DROP NOT NULL");
    expect(migration).toContain("ALTER COLUMN currency DROP NOT NULL");
    expect(migration).toContain("chk_pms_room_types_price_currency_pair");
    expect(migration).toContain("ADD COLUMN room_facts_revision BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("ADD COLUMN room_units_revision BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("ADD COLUMN setup_draft_room_id TEXT");
    expect(migration).toContain("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    expect(migration).toContain("uq_pms_room_types_property_setup_draft_room");
  });

  it("preflights normalized names and constrains physical-unit labels", () => {
    expect(migration).toContain("lower(btrim(name))");
    expect(migration).toContain("btrim(name) ~ '^[[:space:]]'");
    expect(migration).toContain("name !~ '^[[:space:]]'");
    expect(migration).toContain("uq_pms_room_types_property_name_ci");
    expect(migration).toContain("FROM pms.room_types\n  WHERE active\n  GROUP BY property_id");
    expect(migration).toContain("ON pms.room_types (property_id, lower(name))\n  WHERE active");
    expect(migration).toContain("char_length(name) BETWEEN 1 AND 200");
    expect(migration).toContain("ALTER COLUMN room_number DROP NOT NULL");
    expect(migration).toContain("ADD COLUMN operational_label_status TEXT NOT NULL");
    expect(migration).toContain("chk_pms_rooms_operational_label_nonblank");
    expect(migration).toContain("room_number !~ '^[[:space:]]'");
    expect(migration).toContain("room_number !~ '[[:space:]]$'");
    expect(migration).toContain("char_length(room_number) <= 200");
    expect(migration).toContain("chk_pms_rooms_verified_operational_label");
    expect(migration).toContain("uq_pms_rooms_property_verified_label_ci");
    expect(migration).not.toContain("DROP CONSTRAINT uq_pms_rooms_property_number");
  });

  it("does not perform capacity or adjacent-domain work", () => {
    expect(migration.match(/UPDATE pms\.rooms/g)).toHaveLength(1);
    expect(migration).not.toMatch(/\b(?:INSERT INTO|DELETE FROM)\s+pms\.rooms\b/i);
    expect(migration).not.toMatch(
      /pms\.(?:rate_plans|rate_rules|inventory_days|room_blocks|room_type_media)/,
    );
    expect(migration).not.toMatch(/\bdistribution\./);
    expect(migration).not.toContain("vayada:no-transaction");
    expect(migration).not.toContain("IF NOT EXISTS");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS room facts migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    await createLegacySchema(client);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves legacy values while establishing independent facts and unit state", async () => {
    await seedProperties(client);
    await client.query(migration);

    const { rows: roomTypes } = await client.query<{
      name: string;
      base_rate_amount: string | null;
      currency: string | null;
      room_facts_revision: string;
      room_units_revision: string;
    }>(`
      SELECT name, base_rate_amount, currency, room_facts_revision, room_units_revision
      FROM pms.room_types ORDER BY name
    `);
    expect(roomTypes).toEqual([
      {
        name: "Deluxe",
        base_rate_amount: "125.00",
        currency: "EUR",
        room_facts_revision: "1",
        room_units_revision: "1",
      },
      {
        name: "Standard",
        base_rate_amount: "80.00",
        currency: "EUR",
        room_facts_revision: "1",
        room_units_revision: "1",
      },
    ]);

    const { rows: rooms } = await client.query<{
      room_number: string | null;
      operational_label_status: string;
    }>(`
      SELECT room_number, operational_label_status
      FROM pms.rooms ORDER BY id
    `);
    expect(rooms).toEqual([
      { room_number: null, operational_label_status: "unverified" },
      { room_number: "101", operational_label_status: "unverified" },
    ]);

    await client.query(`
      INSERT INTO pms.room_types (id, property_id, name, setup_draft_room_id)
      VALUES
        ('10000000-0000-4000-8000-000000000003', '${PROPERTY_A}', 'Suite', 'draft:room-1'),
        ('10000000-0000-4000-8000-000000000004', '${PROPERTY_B}', 'Suite', 'draft:room-1')
    `);
    const { rows: factsOnly } = await client.query<{
      base_rate_amount: string | null;
      currency: string | null;
    }>(`
      SELECT base_rate_amount, currency
      FROM pms.room_types
      WHERE id = '10000000-0000-4000-8000-000000000003'
    `);
    expect(factsOnly).toEqual([{ base_rate_amount: null, currency: null }]);

    await expectConstraint(
      client,
      `INSERT INTO pms.room_types (id, property_id, name)
       VALUES ('10000000-0000-4000-8000-000000000005', '${PROPERTY_A}', 'suite')`,
      "uq_pms_room_types_property_name_ci",
    );
    await client.query(`
      UPDATE pms.room_types SET active = FALSE
      WHERE id = '10000000-0000-4000-8000-000000000003';
      INSERT INTO pms.room_types (id, property_id, name, setup_draft_room_id)
      VALUES ('10000000-0000-4000-8000-000000000008', '${PROPERTY_A}', 'suite', 'draft:room-2')
    `);
    await expectConstraint(
      client,
      `INSERT INTO pms.room_types (id, property_id, name, setup_draft_room_id)
       VALUES ('10000000-0000-4000-8000-000000000006', '${PROPERTY_A}', 'Twin', 'bad id')`,
      "chk_pms_room_types_setup_draft_room_id",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.room_types (id, property_id, name, setup_draft_room_id)
       VALUES ('10000000-0000-4000-8000-000000000007', '${PROPERTY_A}', 'Twin', 'draft:room-1')`,
      "uq_pms_room_types_property_setup_draft_room",
    );
    await expectConstraint(
      client,
      `INSERT INTO pms.rooms (id, property_id, room_type_id, operational_label_status)
       VALUES ('20000000-0000-4000-8000-000000000003', '${PROPERTY_A}',
         '10000000-0000-4000-8000-000000000001', 'verified')`,
      "chk_pms_rooms_verified_operational_label",
    );

    for (const [id, labelExpression] of [
      ["20000000-0000-4000-8000-000000000006", "E' \\t '"],
      ["20000000-0000-4000-8000-000000000007", "E'\\t102\\t'"],
      ["20000000-0000-4000-8000-000000000008", "repeat('x', 201)"],
    ]) {
      await expectConstraint(
        client,
        `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number)
         VALUES ('${id}', '${PROPERTY_A}',
           '10000000-0000-4000-8000-000000000001', ${labelExpression})`,
        "chk_pms_rooms_operational_label_nonblank",
      );
    }

    await client.query(`
      INSERT INTO pms.rooms (
        id, property_id, room_type_id, room_number, operational_label_status
      ) VALUES (
        '20000000-0000-4000-8000-000000000004',
        '${PROPERTY_A}',
        '10000000-0000-4000-8000-000000000001',
        'A-101',
        'verified'
      )
    `);
    await expectConstraint(
      client,
      `INSERT INTO pms.rooms
         (id, property_id, room_type_id, room_number, operational_label_status)
       VALUES ('20000000-0000-4000-8000-000000000005', '${PROPERTY_A}',
         '10000000-0000-4000-8000-000000000001', 'a-101', 'verified')`,
      "uq_pms_rooms_property_verified_label_ci",
    );
  });

  it("fails before normalization when legacy names would collide", async () => {
    await client.query(`
      INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
      VALUES
        ('10000000-0000-4000-8000-000000000010', '${PROPERTY_A}', ' Deluxe ', 10, 'EUR'),
        ('10000000-0000-4000-8000-000000000011', '${PROPERTY_A}', 'deluxe', 20, 'EUR')
    `);

    await client.query("BEGIN");
    await expect(client.query(migration)).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_pms_room_types_property_name_ci",
    });
    await client.query("ROLLBACK");

    const { rows } = await client.query<{ name: string }>(`
      SELECT name FROM pms.room_types ORDER BY id
    `);
    expect(rows).toEqual([{ name: " Deluxe " }, { name: "deluxe" }]);
    const { rows: columns } = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'pms'
        AND table_name = 'room_types'
        AND column_name IN ('room_facts_revision', 'room_units_revision')
    `);
    expect(columns).toHaveLength(0);
  });

  it("fails closed on legacy names bounded by non-space whitespace", async () => {
    await client.query(`
      INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
      VALUES ('10000000-0000-4000-8000-000000000020', '${PROPERTY_A}', E'\\tDeluxe', 10, 'EUR')
    `);

    await client.query("BEGIN");
    await expect(client.query(migration)).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_room_types_name",
    });
    await client.query("ROLLBACK");

    const { rows } = await client.query<{ name: string }>(`
      SELECT name FROM pms.room_types
    `);
    expect(rows).toEqual([{ name: "\tDeluxe" }]);
  });
});

const PROPERTY_A = "30000000-0000-4000-8000-000000000001";
const PROPERTY_B = "30000000-0000-4000-8000-000000000002";

async function createLegacySchema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA pms;
    CREATE TABLE pms.room_types (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      base_rate_amount NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (base_rate_amount >= 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      CONSTRAINT uq_pms_room_types_id_property UNIQUE (id, property_id)
    );
    CREATE TABLE pms.rooms (
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      room_type_id UUID NOT NULL,
      room_number TEXT NOT NULL,
      CONSTRAINT uq_pms_rooms_property_number UNIQUE (property_id, room_number),
      CONSTRAINT fk_pms_rooms_room_type_property
        FOREIGN KEY (room_type_id, property_id)
        REFERENCES pms.room_types(id, property_id)
    );
  `);
}

async function seedProperties(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '${PROPERTY_A}', '  Deluxe  ', 125, 'EUR'),
      ('10000000-0000-4000-8000-000000000002', '${PROPERTY_A}', 'Standard', 80, 'EUR');
    INSERT INTO pms.rooms (id, property_id, room_type_id, room_number)
    VALUES
      (
        '20000000-0000-4000-8000-000000000001',
        '${PROPERTY_A}',
        '10000000-0000-4000-8000-000000000001',
        E' \\t '
      ),
      (
        '20000000-0000-4000-8000-000000000002',
        '${PROPERTY_A}',
        '10000000-0000-4000-8000-000000000001',
        '101'
      );
  `);
}

async function expectConstraint(client: pg.Client, sql: string, constraint: string): Promise<void> {
  const code = constraint.startsWith("uq_") ? "23505" : "23514";
  await expect(client.query(sql)).rejects.toMatchObject({ code, constraint });
}
