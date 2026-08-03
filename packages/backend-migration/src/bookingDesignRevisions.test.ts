import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0053_booking_design_revisions.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("Booking design revision migration contract", () => {
  it("keeps revisions private, immutable, and property-global", () => {
    expect(migration).toContain("CREATE TABLE booking.booking_design_revisions");
    expect(migration).toContain("UNIQUE (property_id, revision_number)");
    expect(migration).toContain("revision_number BETWEEN 1 AND 2147483647");
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(2);
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).not.toMatch(
      /\b(?:ALTER|UPDATE|INSERT INTO|DELETE FROM)\s+booking\.booking_settings\b/i,
    );
    expect(migration).not.toMatch(/\b(?:public|active)_booking_design/i);
  });

  it("allows only the server-owned design vocabulary", () => {
    expect(migration).toContain("contract_version = 'booking-design.v1'");
    for (const color of ["#4F46E5", "#0077B6", "#2D6A4F", "#7B2D8E", "#2D3436"]) {
      expect(migration).toContain(`'${color}'`);
    }
    for (const font of [
      "high-end-serif",
      "modern-minimalist",
      "grand-classic",
      "imperial-serif",
      "italiana-serif",
    ]) {
      expect(migration).toContain(`'${font}'`);
    }
    expect(migration).not.toMatch(/['"]booking_design_revision['"]/);
    expect(migration).not.toContain("booking.design.changed");
    expect(migration).not.toContain("booking.launch-readiness");
  });

  it("keeps one exact current-working pointer per property", () => {
    expect(migration).toContain("CREATE TABLE booking.current_working_design_revisions");
    expect(migration).toContain("property_id       UUID        PRIMARY KEY");
    expect(migration).toContain(
      "FOREIGN KEY (revision_id, organization_id, property_id, revision_number)",
    );
    expect(migration).not.toContain("CREATE VIEW");
  });

  it("requires scope-safe platform record linkage", () => {
    expect(migration).toContain("FOREIGN KEY (idempotency_key_id, scope_key)");
    expect(migration).toContain("REFERENCES platform.idempotency_keys(id, scope_key)");
    expect(migration).toContain("FOREIGN KEY (domain_event_id, property_id)");
    expect(migration).toContain("REFERENCES platform.domain_events(id, property_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, domain_event_id)");
    expect(migration).toContain("REFERENCES platform.outbox_events(id, domain_event_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, scope_key)");
    expect(migration).toContain("REFERENCES platform.outbox_events(id, scope_key)");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking design revision migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS booking CASCADE;
      DROP SCHEMA IF EXISTS platform CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA platform;
      CREATE SCHEMA booking;

      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);

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
        id UUID PRIMARY KEY,
        scope_key TEXT NOT NULL,
        UNIQUE (id, scope_key)
      );
      CREATE TABLE platform.domain_events (
        id UUID PRIMARY KEY,
        property_id UUID NOT NULL,
        UNIQUE (id, property_id)
      );
      CREATE TABLE platform.outbox_events (
        id UUID PRIMARY KEY,
        domain_event_id UUID NOT NULL,
        scope_key TEXT NOT NULL,
        UNIQUE (id, domain_event_id),
        UNIQUE (id, scope_key)
      );

      INSERT INTO identity.organizations VALUES
        ('10000000-0000-4000-8000-000000000001'),
        ('10000000-0000-4000-8000-000000000002');
      INSERT INTO identity.users VALUES ('20000000-0000-4000-8000-000000000001');
      INSERT INTO hotel_catalog.properties VALUES
        ('30000000-0000-4000-8000-000000000001'),
        ('30000000-0000-4000-8000-000000000002');
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
      await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("binds accepted revisions to property-scoped idempotency, event, and outbox rows", async () => {
    await seedPlatformLinks(client, { suffix: "1", propertySuffix: "1" });
    await insertRevision(client, { suffix: "1", revision: 1 });

    await seedPlatformLinks(client, {
      suffix: "2",
      propertySuffix: "1",
      idempotencyPropertySuffix: "2",
    });
    await expect(
      insertRevision(client, { suffix: "2", revision: 2, propertySuffix: "1" }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_design_revision_idempotency_scope",
    });

    await seedPlatformLinks(client, {
      suffix: "3",
      propertySuffix: "1",
      domainEventPropertySuffix: "2",
    });
    await expect(insertRevision(client, { suffix: "3", revision: 2 })).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_design_revision_domain_event_property",
    });

    await seedPlatformLinks(client, {
      suffix: "4",
      propertySuffix: "1",
      outboxDomainEventSuffix: "9",
    });
    await expect(insertRevision(client, { suffix: "4", revision: 2 })).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_design_revision_outbox_event",
    });

    await seedPlatformLinks(client, {
      suffix: "5",
      propertySuffix: "1",
      outboxPropertySuffix: "2",
    });
    await expect(insertRevision(client, { suffix: "5", revision: 2 })).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_design_revision_outbox_scope",
    });
  });

  it("enforces property-global numbering and exact current pointers", async () => {
    await seedPlatformLinks(client, { suffix: "1", propertySuffix: "1" });
    await insertRevision(client, { suffix: "1", revision: 1 });
    await seedPlatformLinks(client, { suffix: "2", propertySuffix: "1" });

    await expect(
      insertRevision(client, { suffix: "2", revision: 1, organizationSuffix: "2" }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_booking_design_revisions_property_revision",
    });

    await client.query(`
      INSERT INTO booking.current_working_design_revisions (
        property_id, organization_id, revision_id, revision_number,
        updated_by_user_id, updated_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', 1,
        '20000000-0000-4000-8000-000000000001', now()
      )
    `);
    await expect(
      client.query(`
        UPDATE booking.current_working_design_revisions
        SET organization_id = '10000000-0000-4000-8000-000000000002'
      `),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_current_working_design_exact_revision",
    });
  });

  it("rejects mutation and truncation of immutable revisions", async () => {
    await seedPlatformLinks(client, { suffix: "1", propertySuffix: "1" });
    await insertRevision(client, { suffix: "1", revision: 1 });

    await expect(
      client.query("UPDATE booking.booking_design_revisions SET revision_number = 2"),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("DELETE FROM booking.booking_design_revisions"),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("TRUNCATE booking.booking_design_revisions CASCADE"),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

async function seedPlatformLinks(
  client: pg.Client,
  input: {
    suffix: string;
    propertySuffix: string;
    idempotencyPropertySuffix?: string;
    domainEventPropertySuffix?: string;
    outboxDomainEventSuffix?: string;
    outboxPropertySuffix?: string;
  },
): Promise<void> {
  const paddedSuffix = input.suffix.padStart(12, "0");
  const idempotencyPropertySuffix = (
    input.idempotencyPropertySuffix ?? input.propertySuffix
  ).padStart(12, "0");
  const domainEventPropertySuffix = (
    input.domainEventPropertySuffix ?? input.propertySuffix
  ).padStart(12, "0");
  const outboxPropertySuffix = (input.outboxPropertySuffix ?? input.propertySuffix).padStart(
    12,
    "0",
  );
  const domainEventId = `60000000-0000-4000-8000-${paddedSuffix}`;
  await client.query("INSERT INTO platform.idempotency_keys VALUES ($1, $2)", [
    `50000000-0000-4000-8000-${paddedSuffix}`,
    `property:30000000-0000-4000-8000-${idempotencyPropertySuffix}`,
  ]);
  await client.query("INSERT INTO platform.domain_events VALUES ($1, $2)", [
    domainEventId,
    `30000000-0000-4000-8000-${domainEventPropertySuffix}`,
  ]);
  await client.query("INSERT INTO platform.outbox_events VALUES ($1, $2, $3)", [
    `70000000-0000-4000-8000-${paddedSuffix}`,
    `60000000-0000-4000-8000-${(input.outboxDomainEventSuffix ?? input.suffix).padStart(12, "0")}`,
    `property:30000000-0000-4000-8000-${outboxPropertySuffix}`,
  ]);
}

async function insertRevision(
  client: pg.Client,
  input: {
    suffix: string;
    revision: number;
    organizationSuffix?: string;
    propertySuffix?: string;
  },
): Promise<void> {
  const organizationSuffix = input.organizationSuffix ?? "1";
  const propertySuffix = input.propertySuffix ?? "1";
  await client.query(
    `INSERT INTO booking.booking_design_revisions (
       id, organization_id, property_id, revision_number, contract_version,
       primary_color, font_pairing, request_fingerprint_hash,
       idempotency_key_id, domain_event_id, outbox_event_id,
       created_by_user_id, created_at
     ) VALUES ($1, $2, $3, $4, 'booking-design.v1', '#4F46E5',
       'high-end-serif', $5, $6, $7, $8, $9, now())`,
    [
      `40000000-0000-4000-8000-${input.suffix.padStart(12, "0")}`,
      `10000000-0000-4000-8000-${organizationSuffix.padStart(12, "0")}`,
      `30000000-0000-4000-8000-${propertySuffix.padStart(12, "0")}`,
      input.revision,
      `sha256:${"a".repeat(64)}`,
      `50000000-0000-4000-8000-${input.suffix.padStart(12, "0")}`,
      `60000000-0000-4000-8000-${input.suffix.padStart(12, "0")}`,
      `70000000-0000-4000-8000-${input.suffix.padStart(12, "0")}`,
      "20000000-0000-4000-8000-000000000001",
    ],
  );
}
