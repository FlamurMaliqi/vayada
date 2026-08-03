import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0054_pms_operating_calendar.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS operating calendar migration contract", () => {
  it("stores an immutable source revision without owner-domain foreign keys", () => {
    expect(migration).toContain("CREATE TABLE pms.operating_calendar_revisions");
    expect(migration).toContain("'pms_operating_calendar.v1'");
    expect(migration).toContain("'calendar:' || calendar_revision::TEXT");
    expect(migration).toContain("'profile:' || property_profile_revision::TEXT");
    expect(migration).toContain("UNIQUE (\n      source_owner_domain");
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(6);
    expect(migration).not.toMatch(/REFERENCES\s+(?:hotel_catalog|identity|pms\.room_types)/i);
    const pmsReferences = [...migration.matchAll(/REFERENCES\s+(pms\.[a-z_]+)/gi)].map(
      ([, table]) => table,
    );
    expect([...new Set(pmsReferences)]).toEqual(["pms.operating_calendar_revisions"]);
    expect(migration).not.toMatch(/current_(?:operating_)?calendar/i);
  });

  it("keeps configuration independent from availability and pricing", () => {
    expect(migration).not.toMatch(/REFERENCES\s+pms\.(?:rate_rules|inventory|reservations)/i);
    expect(migration).not.toMatch(/CREATE TABLE\s+\S*materializ/i);
    expect(migration).toContain("starting_sellable_limit_count BETWEEN 1");
    expect(migration).toContain("property_time_zone ~");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS operating calendar migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS platform CASCADE;
      CREATE SCHEMA pms;
      CREATE SCHEMA platform;

      CREATE FUNCTION platform.tenant_scope_key(
        tenant_scope TEXT, organization_id UUID, property_id UUID
      ) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
        SELECT CASE
          WHEN tenant_scope = 'property' THEN 'property:' || property_id::TEXT
          ELSE tenant_scope
        END;
      $$;
      CREATE FUNCTION platform.prevent_append_only_mutation()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'append-only' USING ERRCODE = '55000';
      END;
      $$;
      CREATE TABLE platform.idempotency_keys (
        id UUID PRIMARY KEY, scope_key TEXT NOT NULL, UNIQUE (id, scope_key)
      );
      CREATE TABLE platform.domain_events (
        id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE (id, property_id)
      );
      CREATE TABLE platform.outbox_events (
        id UUID PRIMARY KEY, domain_event_id UUID NOT NULL, scope_key TEXT NOT NULL,
        UNIQUE (id, domain_event_id), UNIQUE (id, scope_key)
      );
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
    } finally {
      await client.end();
    }
  });

  it("persists exact generated source identities and canonical child evidence", async () => {
    const result = await insertConfiguration(client, {
      suffix: "1",
      revision: 1,
      periods: [{ index: 0, startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 }],
    });
    expect(result.rows[0]).toEqual({
      source_owner_domain: "pms",
      source_entity_type: "pms_operating_calendar.v1",
      source_entity_id: "30000000-0000-4000-8000-000000000001",
      source_revision: "calendar:1",
      property_profile_owner_domain: "hotel_catalog",
      property_profile_entity_type: "property_profile",
      property_profile_entity_id: "30000000-0000-4000-8000-000000000001",
      property_profile_source_revision: "profile:7",
    });
  });

  it("rejects non-canonical recurring unions", async () => {
    const invalidCases = [
      {
        suffix: "2",
        revision: 2,
        periods: [{ index: 1, startMonth: 4, startDay: 1, endMonth: 4, endDay: 30 }],
      },
      {
        suffix: "3",
        revision: 3,
        periods: [
          { index: 0, startMonth: 11, startDay: 1, endMonth: 11, endDay: 30 },
          { index: 1, startMonth: 3, startDay: 1, endMonth: 3, endDay: 31 },
        ],
      },
      {
        suffix: "4",
        revision: 4,
        periods: [
          { index: 0, startMonth: 1, startDay: 1, endMonth: 2, endDay: 1 },
          { index: 1, startMonth: 1, startDay: 15, endMonth: 3, endDay: 1 },
        ],
      },
      {
        suffix: "5",
        revision: 5,
        periods: [
          { index: 0, startMonth: 1, startDay: 1, endMonth: 1, endDay: 31 },
          { index: 1, startMonth: 12, startDay: 1, endMonth: 12, endDay: 31 },
        ],
      },
      {
        suffix: "6",
        revision: 6,
        periods: [{ index: 0, startMonth: 1, startDay: 1, endMonth: 12, endDay: 31 }],
      },
    ];
    for (const input of invalidCases) {
      await expect(insertConfiguration(client, input)).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_operating_calendar_periods_canonical",
      });
    }
  });

  it("rejects empty recurring, year-round periods, February 29, and excess limits", async () => {
    await expect(
      insertConfiguration(client, { suffix: "7", revision: 7, periods: [] }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operating_calendar_schedule",
    });
    await expect(
      insertConfiguration(client, {
        suffix: "8",
        revision: 8,
        mode: "year_round",
        declaredPeriodCount: 0,
        periods: [{ index: 0, startMonth: 2, startDay: 1, endMonth: 2, endDay: 28 }],
      }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_pms_operating_calendar_recurring_period_parent",
    });
    await expect(
      insertConfiguration(client, {
        suffix: "9",
        revision: 9,
        periods: [{ index: 0, startMonth: 2, startDay: 29, endMonth: 3, endDay: 1 }],
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operating_calendar_period_start",
    });
    await expect(
      insertConfiguration(client, {
        suffix: "10",
        revision: 10,
        periods: [{ index: 0, startMonth: 4, startDay: 1, endMonth: 4, endDay: 30 }],
        capacity: 2,
        limit: 3,
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operating_calendar_sellable_limit",
    });
  });

  it("rejects update, delete, truncate, and late manifest inserts", async () => {
    await insertConfiguration(client, {
      suffix: "11",
      revision: 11,
      periods: [{ index: 0, startMonth: 1, startDay: 1, endMonth: 1, endDay: 31 }],
    });
    for (const table of [
      "operating_calendar_revisions",
      "operating_calendar_recurring_periods",
      "operating_calendar_room_bindings",
    ]) {
      await expect(
        client.query(`UPDATE pms.${table} SET property_id = property_id`),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(client.query(`DELETE FROM pms.${table}`)).rejects.toMatchObject({
        code: "55000",
      });
      await expect(client.query(`TRUNCATE pms.${table} CASCADE`)).rejects.toMatchObject({
        code: "55000",
      });
    }
    await expect(
      client.query(`
        INSERT INTO pms.operating_calendar_recurring_periods (
          property_id, calendar_revision, period_index,
          start_month, start_day, end_month, end_day
        ) VALUES ('30000000-0000-4000-8000-000000000001', 11, 1, 3, 1, 3, 31)
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operating_calendar_manifest_counts",
    });
    await expect(
      client.query(`
        INSERT INTO pms.operating_calendar_room_bindings (
          property_id, calendar_revision, room_type_id,
          source_room_facts_revision, source_room_units_revision,
          physical_capacity_count, starting_sellable_limit_count
        ) VALUES (
          '30000000-0000-4000-8000-000000000001', 11,
          '40000000-0000-4000-8000-000000000002', 1, 1, 1, 1
        )
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operating_calendar_manifest_counts",
    });
    const manifest = await client.query(`
      SELECT
        (SELECT count(*)::INTEGER FROM pms.operating_calendar_recurring_periods
         WHERE calendar_revision = 11) AS periods,
        (SELECT count(*)::INTEGER FROM pms.operating_calendar_room_bindings
         WHERE calendar_revision = 11) AS rooms
    `);
    expect(manifest.rows[0]).toEqual({ periods: 1, rooms: 1 });
  });
});

async function seedPlatformLinks(client: pg.Client, suffix: string): Promise<void> {
  const padded = suffix.padStart(12, "0");
  const propertyId = "30000000-0000-4000-8000-000000000001";
  const domainEventId = `60000000-0000-4000-8000-${padded}`;
  await client.query("INSERT INTO platform.idempotency_keys VALUES ($1, $2)", [
    `50000000-0000-4000-8000-${padded}`,
    `property:${propertyId}`,
  ]);
  await client.query("INSERT INTO platform.domain_events VALUES ($1, $2)", [
    domainEventId,
    propertyId,
  ]);
  await client.query("INSERT INTO platform.outbox_events VALUES ($1, $2, $3)", [
    `70000000-0000-4000-8000-${padded}`,
    domainEventId,
    `property:${propertyId}`,
  ]);
}

type PeriodInput = {
  index: number;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
};

async function insertConfiguration(
  client: pg.Client,
  input: {
    suffix: string;
    revision: number;
    mode?: "year_round" | "recurring";
    declaredPeriodCount?: number;
    periods: PeriodInput[];
    capacity?: number;
    limit?: number;
  },
): Promise<pg.QueryResult> {
  await seedPlatformLinks(client, input.suffix);
  await client.query("BEGIN");
  try {
    const result = await insertRevision(client, {
      ...input,
      periodCount: input.declaredPeriodCount ?? input.periods.length,
    });
    for (const period of input.periods) {
      await client.query(
        `INSERT INTO pms.operating_calendar_recurring_periods (
           property_id, calendar_revision, period_index,
           start_month, start_day, end_month, end_day
         ) VALUES ('30000000-0000-4000-8000-000000000001', $1, $2, $3, $4, $5, $6)`,
        [
          input.revision,
          period.index,
          period.startMonth,
          period.startDay,
          period.endMonth,
          period.endDay,
        ],
      );
    }
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings (
         property_id, calendar_revision, room_type_id,
         source_room_facts_revision, source_room_units_revision,
         physical_capacity_count, starting_sellable_limit_count
       ) VALUES (
         '30000000-0000-4000-8000-000000000001', $1,
         '40000000-0000-4000-8000-000000000001', 3, 5, $2, $3
       )`,
      [input.revision, input.capacity ?? 10, input.limit ?? 8],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertRevision(
  client: pg.Client,
  input: {
    suffix: string;
    revision: number;
    periodCount: number;
    mode?: "year_round" | "recurring";
  },
): Promise<pg.QueryResult> {
  const padded = input.suffix.padStart(12, "0");
  return client.query(
    `INSERT INTO pms.operating_calendar_revisions (
       organization_id, property_id, calendar_revision, contract_version,
       property_profile_revision, property_time_zone, schedule_mode,
       recurring_period_count, room_binding_count, default_minimum_stay_nights,
       idempotency_key_id, domain_event_id,
       outbox_event_id, created_by_user_id, created_at, updated_at
     ) VALUES (
       '10000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000001', $1,
       'pms-operating-calendar.v1', 7, 'Europe/Berlin', $2, $3, 1, 2,
       $4, $5, $6, '20000000-0000-4000-8000-000000000001', now(), now()
     ) RETURNING source_owner_domain, source_entity_type, source_entity_id,
       source_revision, property_profile_owner_domain, property_profile_entity_type,
       property_profile_entity_id, property_profile_source_revision`,
    [
      input.revision,
      input.mode ?? "recurring",
      input.periodCount,
      `50000000-0000-4000-8000-${padded}`,
      `60000000-0000-4000-8000-${padded}`,
      `70000000-0000-4000-8000-${padded}`,
    ],
  );
}
