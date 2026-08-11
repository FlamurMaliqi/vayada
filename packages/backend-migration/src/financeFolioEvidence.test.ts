import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const [folios, evidence] = await Promise.all([
  readMigration("0063_finance_folios.sql"),
  readMigration("0064_finance_folio_evidence.sql"),
]);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const PAYMENT_A = "30000000-0000-4000-8000-000000000001";
const PAYMENT_B = "30000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

describe("Finance folio evidence migration contract", () => {
  it("stores derived folio lines and canonical payment references only", () => {
    expect(evidence).toContain("GENERATED ALWAYS AS (round(quantity * unit_amount, 4))");
    expect(evidence).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(evidence).toContain("chk_finance_folio_evidence_creation_transaction");
    expect(evidence).not.toMatch(/finance\.invoices|invoice_lines|provider_transaction|allocation/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance folio evidence (PostgreSQL)", () => {
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
      CREATE TABLE finance.payments (
        id UUID PRIMARY KEY, property_id UUID NOT NULL, currency CHAR(3) NOT NULL,
        UNIQUE (id, property_id));
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
      INSERT INTO pms.property_pricing_settings VALUES
        ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
      INSERT INTO finance.payments VALUES
        ('${PAYMENT_A}', '${PROPERTY_A}', 'EUR'), ('${PAYMENT_B}', '${PROPERTY_B}', 'USD');
    `);
    await client.query(folios);
    await client.query(evidence);
  });

  afterAll(async () => {
    try {
      await client.query("ROLLBACK");
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
    } finally {
      await client.end();
    }
  });

  const createFolio = async () =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO finance.folios (property_id) VALUES ($1) RETURNING id",
        [PROPERTY_A],
      )
    ).rows[0]!.id;

  const addRevision = async (folioId: string, state: string, total: number) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO finance.folio_revisions
          (folio_id, property_id, revision, state, recipient_snapshot_ciphertext,
           recipient_encryption_scheme, recipient_key_version, recipient_fingerprint,
           recipient_fingerprint_key_version, service_from, service_to, currency,
           total_amount, source_digest, source_freshness)
         VALUES ($1, $2, 1, $3, decode(repeat('ab', 32), 'hex'), 'envelope_aead_v1',
           'kms-v1', $4, 'hmac-v1', '2026-08-05', '2026-08-06', 'EUR', $5, $4, '{}')
         RETURNING id`,
        [folioId, PROPERTY_A, state, HASH, total],
      )
    ).rows[0]!.id;

  const LINE_VALUES = `'${PROPERTY_A}', 1, 'EUR', 1, 'room', 'Stay', 2.5, 10,
    '2026-08-05', 'booking.night', 'night-1', 1, 'room-revenue', 'standard'`;
  const addLine = (folioId: string, revisionId: string, values = LINE_VALUES) =>
    client.query(
      `INSERT INTO finance.folio_lines
        (folio_revision_id, folio_id, property_id, folio_revision, currency, position,
         kind, description, quantity, unit_amount, service_on, source_type, source_id,
         source_revision, accounting_mapping_ref, tax_treatment_ref)
       VALUES ($1, $2, ${values})`,
      [revisionId, folioId],
    );

  it("commits one immutable snapshot with generated totals and payment evidence", async () => {
    const folioId = await createFolio();
    await client.query("BEGIN");
    const revisionId = await addRevision(folioId, "ready", 25);
    await addLine(folioId, revisionId);
    await client.query(
      `INSERT INTO finance.folio_payment_references
        (folio_revision_id, folio_id, property_id, folio_revision, currency, position,
         payment_id, amount) VALUES ($1, $2, $3, 1, 'EUR', 1, $4, 25)`,
      [revisionId, folioId, PROPERTY_A, PAYMENT_A],
    );
    await client.query("COMMIT");
    expect(
      (
        await client.query(
          `SELECT l.line_total, p.amount FROM finance.folio_lines l
           JOIN finance.folio_payment_references p USING (folio_revision_id)
           WHERE l.folio_revision_id = $1`,
          [revisionId],
        )
      ).rows[0],
    ).toEqual({ line_total: "25.0000", amount: "25.0000" });
  });

  it("rejects drifted totals and line-less ready revisions at commit", async () => {
    const folioId = await createFolio();
    await client.query("BEGIN");
    const revisionId = await addRevision(folioId, "ready", 24);
    await addLine(folioId, revisionId);
    await expect(client.query("COMMIT")).rejects.toMatchObject({
      constraint: "chk_finance_folio_revision_total_matches_lines",
    });
    await client.query("ROLLBACK");

    const emptyFolioId = await createFolio();
    await client.query("BEGIN");
    await addRevision(emptyFolioId, "ready", 0);
    await expect(client.query("COMMIT")).rejects.toMatchObject({
      constraint: "chk_finance_ready_folio_has_lines",
    });
    await client.query("ROLLBACK");
  });

  it("requires evidence to be created in the revision transaction", async () => {
    const folioId = await createFolio();
    const revisionId = await addRevision(folioId, "draft", 0);
    await expect(addLine(folioId, revisionId)).rejects.toMatchObject({
      constraint: "chk_finance_folio_evidence_creation_transaction",
    });
    await expect(
      client.query(
        `INSERT INTO finance.folio_payment_references
          (folio_revision_id, folio_id, property_id, folio_revision, currency, position,
           payment_id, amount) VALUES ($1, $2, $3, 1, 'EUR', 1, $4, 1)`,
        [revisionId, folioId, PROPERTY_A, PAYMENT_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_folio_evidence_creation_transaction" });
  });

  it("rejects malformed, duplicate, and cross-scope evidence", async () => {
    const folioId = await createFolio();
    await client.query("BEGIN");
    const revisionId = await addRevision(folioId, "draft", 25);
    await addLine(folioId, revisionId);
    await expect(addLine(folioId, revisionId)).rejects.toMatchObject({
      constraint: "uq_finance_folio_lines_position",
    });
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    const scopedRevisionId = await addRevision(folioId, "draft", 0);
    const invalidLines = [
      [LINE_VALUES.replace("2.5", "'NaN'"), "chk_finance_folio_lines_quantity"],
      [LINE_VALUES.replace("2026-08-05", "infinity"), "chk_finance_folio_lines_service_on"],
      [LINE_VALUES.replace("booking.night", "Bad Source"), "chk_finance_folio_lines_source_type"],
      [LINE_VALUES.replace("room-revenue", " "), "chk_finance_folio_lines_accounting_mapping"],
      [
        LINE_VALUES.replace(PROPERTY_A, PROPERTY_B).replace("EUR", "USD"),
        "fk_finance_folio_lines_revision_scope",
      ],
    ];
    for (const [values, constraint] of invalidLines) {
      await client.query("SAVEPOINT invalid_line");
      await expect(addLine(folioId, scopedRevisionId, values)).rejects.toMatchObject({
        constraint,
      });
      await client.query("ROLLBACK TO SAVEPOINT invalid_line");
    }
    await expect(
      client.query(
        `INSERT INTO finance.folio_payment_references
          (folio_revision_id, folio_id, property_id, folio_revision, currency, position,
           payment_id, amount) VALUES ($1, $2, $3, 1, 'EUR', 1, $4, 1)`,
        [scopedRevisionId, folioId, PROPERTY_A, PAYMENT_B],
      ),
    ).rejects.toMatchObject({ constraint: "fk_finance_folio_payment_refs_payment_scope" });
    await client.query("ROLLBACK");
  });

  it("keeps committed line and payment evidence append-only", async () => {
    const folioId = await createFolio();
    await client.query("BEGIN");
    const revisionId = await addRevision(folioId, "ready", 25);
    await addLine(folioId, revisionId);
    await client.query(
      `INSERT INTO finance.folio_payment_references
        (folio_revision_id, folio_id, property_id, folio_revision, currency, position,
         payment_id, amount) VALUES ($1, $2, $3, 1, 'EUR', 1, $4, 25)`,
      [revisionId, folioId, PROPERTY_A, PAYMENT_A],
    );
    await client.query("COMMIT");
    await expect(
      client.query(
        "UPDATE finance.folio_lines SET description = 'Changed' WHERE folio_revision_id = $1",
        [revisionId],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_folio_evidence_append_only" });
    await expect(client.query("TRUNCATE finance.folio_payment_references")).rejects.toMatchObject({
      constraint: "chk_finance_folio_evidence_append_only",
    });
  });
});
