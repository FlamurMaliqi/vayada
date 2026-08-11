import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0063_finance_folios.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const BOOKING_B = "40000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

describe("Finance folio migration contract", () => {
  it("stores append-only folios rather than official invoices", () => {
    expect(migration).toContain("CREATE TABLE finance.folios");
    expect(migration).toContain("CREATE TABLE finance.folio_revisions");
    expect(migration).toContain("recipient_snapshot_ciphertext BYTEA");
    expect(migration).toContain("recipient_encryption_scheme");
    expect(migration).toContain("recipient_fingerprint_key_version");
    expect(migration).toContain("protect_folio_history");
    expect(migration).not.toMatch(/property_invoice_sequences|finance\.invoices|'INV-'/);
    expect(migration).not.toMatch(/folio_(lines|payment_references|submissions)/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance folios (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS booking CASCADE;
      DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog; CREATE SCHEMA pms; CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.property_pricing_settings (
        property_id UUID PRIMARY KEY, currency CHAR(3), UNIQUE (property_id, currency));
      CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
      INSERT INTO pms.property_pricing_settings VALUES
        ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
      INSERT INTO booking.guest_bookings VALUES ('${BOOKING_B}', '${PROPERTY_B}');
    `);
    await client.query(migration);
  });

  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
    } finally {
      await client.end();
    }
  });

  const createFolio = async (propertyId = PROPERTY_A, bookingId: string | null = null) =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO finance.folios (property_id, guest_booking_id) VALUES ($1, $2) RETURNING id",
        [propertyId, bookingId],
      )
    ).rows[0]!.id;

  const addRevision = (
    connection: pg.Client,
    folioId: string,
    revision: number,
    overrides: { propertyId?: string; currency?: string; state?: string } = {},
  ) =>
    connection.query(
      `INSERT INTO finance.folio_revisions
        (folio_id, property_id, revision, state, recipient_snapshot_ciphertext,
         recipient_encryption_scheme, recipient_key_version, recipient_fingerprint,
         recipient_fingerprint_key_version,
         service_from, service_to,
         currency, total_amount, source_digest, source_freshness)
       VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'envelope_aead_v1',
         'kms-v1', $5, 'hmac-v1',
         '2026-08-05', '2026-08-06', $6, 125.50, $5, '{"booking":"2026-08-05T00:00:00Z"}')`,
      [
        folioId,
        overrides.propertyId ?? PROPERTY_A,
        revision,
        overrides.state ?? "draft",
        HASH,
        overrides.currency ?? "EUR",
      ],
    );

  it("uses an opaque identity and enforces property-scoped evidence", async () => {
    const folioId = await createFolio();
    expect(folioId).toMatch(/^[0-9a-f-]{36}$/);
    await addRevision(client, folioId, 1, { state: "ready" });

    await expect(createFolio(PROPERTY_A, BOOKING_B)).rejects.toMatchObject({
      constraint: "fk_finance_folios_booking_property",
    });
    await expect(addRevision(client, folioId, 2, { currency: "USD" })).rejects.toMatchObject({
      constraint: "fk_finance_folio_revisions_pricing_currency",
    });
    await expect(addRevision(client, folioId, 2, { propertyId: PROPERTY_B })).rejects.toMatchObject(
      {
        constraint: "fk_finance_folio_revisions_folio_property",
      },
    );
    await expect(
      client.query("UPDATE finance.folio_revisions SET total_amount = 1 WHERE folio_id = $1", [
        folioId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects malformed protected recipient and source evidence", async () => {
    const folioId = await createFolio();
    const invalidCases = [
      {
        ciphertext: Buffer.alloc(28),
        scheme: "envelope_aead_v1",
        key: "kms-v1",
        freshness: {},
        constraint: "chk_finance_folio_revisions_recipient_ciphertext",
      },
      {
        ciphertext: Buffer.alloc(32),
        scheme: "plaintext",
        key: "kms-v1",
        freshness: {},
        constraint: "chk_finance_folio_revisions_recipient_encryption",
      },
      {
        ciphertext: Buffer.alloc(32),
        scheme: "envelope_aead_v1",
        key: " kms-v1 ",
        freshness: {},
        constraint: "chk_finance_folio_revisions_recipient_key",
      },
      {
        ciphertext: Buffer.alloc(32),
        scheme: "envelope_aead_v1",
        key: "kms-v1",
        freshness: [],
        constraint: "chk_finance_folio_revisions_source_freshness",
      },
    ];
    for (const invalid of invalidCases) {
      await expect(
        client.query(
          `INSERT INTO finance.folio_revisions
          (folio_id, property_id, revision, state, recipient_snapshot_ciphertext,
           recipient_encryption_scheme, recipient_key_version, recipient_fingerprint,
           recipient_fingerprint_key_version,
           service_from, service_to,
           currency, total_amount, source_digest, source_freshness)
         VALUES ($1, $2, 1, 'draft', $3, $4, $5, $6, 'hmac-v1',
           '2026-08-05', '2026-08-06', 'EUR', 125.50, $6, $7)`,
          [
            folioId,
            PROPERTY_A,
            invalid.ciphertext,
            invalid.scheme,
            invalid.key,
            HASH,
            JSON.stringify(invalid.freshness),
          ],
        ),
      ).rejects.toMatchObject({ constraint: invalid.constraint });
    }
  });

  it("requires contiguous immutable revisions", async () => {
    const folioId = await createFolio();
    await addRevision(client, folioId, 1);
    await expect(addRevision(client, folioId, 3)).rejects.toMatchObject({
      constraint: "chk_finance_folio_revisions_sequence",
    });
    await addRevision(client, folioId, 2, { state: "ready" });
    await expect(
      client.query("DELETE FROM finance.folio_revisions WHERE folio_id = $1", [folioId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE finance.folios CASCADE")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("serializes competing revision numbers", async () => {
    const folioId = await createFolio();
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    try {
      const results = await Promise.allSettled([
        addRevision(client, folioId, 1),
        addRevision(peer, folioId, 1),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter(({ status }) => status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: { constraint: "chk_finance_folio_revisions_sequence" },
      });
    } finally {
      await peer.end();
    }
  });
});
