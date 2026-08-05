import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0068_finance_invoice_delivery_attempts.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";

describe("Finance invoice delivery attempt migration contract", () => {
  it("stores no raw provider response or document/media contract", () => {
    expect(migration).not.toMatch(/JSONB|provider_response|media_object|storage_key/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance invoice delivery attempts (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS finance CASCADE; CREATE SCHEMA finance;
      CREATE TABLE finance.invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
        archived_at TIMESTAMPTZ, UNIQUE (id, property_id));
      CREATE TABLE finance.invoice_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
        invoice_id UUID NOT NULL, invoice_revision BIGINT NOT NULL);
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

  const createInvoice = async (status = "issued", revision = 3, property = PROPERTY_A) =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO finance.invoices (property_id, revision, status) VALUES ($1, $2, $3) RETURNING id",
        [property, revision, status],
      )
    ).rows[0]!.id;
  const createDocument = async (invoice: string, revision = 3, property = PROPERTY_A) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO finance.invoice_documents (property_id, invoice_id, invoice_revision)
         VALUES ($1, $2, $3) RETURNING id`,
        [property, invoice, revision],
      )
    ).rows[0]!.id;
  const queue = (
    invoice: string,
    document: string,
    key = crypto.randomUUID(),
    property = PROPERTY_A,
    id = crypto.randomUUID(),
    ignoreConflict = false,
    recipient = "guest@example.com",
    provider = "resend",
  ) =>
    client.query(
      `INSERT INTO finance.invoice_delivery_attempts
       (id, property_id, invoice_id, invoice_revision, document_id,
        recipient_email, delivery_provider, idempotency_key)
       VALUES ($1, $2, $3, 3, $4, $6, $7, $5)
       ${ignoreConflict ? "ON CONFLICT (property_id, idempotency_key) DO NOTHING" : ""}`,
      [id, property, invoice, document, key, recipient, provider],
    );
  const markSent = (db: pg.Client, id: string) =>
    db.query(
      `UPDATE finance.invoice_delivery_attempts SET state = 'sent', revision = 2,
       provider_delivery_id = 'provider-123', sent_at = now() WHERE id = $1`,
      [id],
    );

  it("records queued-to-sent evidence and freezes it", async () => {
    const invoice = await createInvoice();
    const document = await createDocument(invoice);
    const id = crypto.randomUUID();
    await queue(invoice, document, crypto.randomUUID(), PROPERTY_A, id);
    await markSent(client, id);
    expect(
      (
        await client.query(
          "SELECT state, revision, provider_delivery_id FROM finance.invoice_delivery_attempts WHERE id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "sent", revision: "2", provider_delivery_id: "provider-123" });
    await expect(
      client.query(
        "UPDATE finance.invoice_delivery_attempts SET provider_delivery_id = 'changed' WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("DELETE FROM finance.invoice_delivery_attempts WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE finance.invoice_delivery_attempts")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("records valid failed evidence", async () => {
    const invoice = await createInvoice();
    const document = await createDocument(invoice);
    const id = crypto.randomUUID();
    await queue(invoice, document, crypto.randomUUID(), PROPERTY_A, id);
    await client.query(
      `UPDATE finance.invoice_delivery_attempts SET state = 'failed', revision = 2,
       failure_reason = 'Mailbox rejected', failed_at = now() WHERE id = $1`,
      [id],
    );
    expect(
      (
        await client.query(
          "SELECT state, failure_reason, failed_at IS NOT NULL AS terminal FROM finance.invoice_delivery_attempts WHERE id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "failed", failure_reason: "Mailbox rejected", terminal: true });
  });

  it("serializes sent completion against stale and voided invoices", async () => {
    const invoice = await createInvoice();
    const document = await createDocument(invoice);
    const attempt = crypto.randomUUID();
    await queue(invoice, document, crypto.randomUUID(), PROPERTY_A, attempt);
    await client.query("UPDATE finance.invoices SET revision = 4 WHERE id = $1", [invoice]);
    await expect(markSent(client, attempt)).rejects.toMatchObject({
      constraint: "chk_finance_invoice_delivery_attempt_issued",
    });
    await client.query(
      "UPDATE finance.invoices SET revision = 5, status = 'voided' WHERE id = $1",
      [invoice],
    );
    await client.query(
      `UPDATE finance.invoice_delivery_attempts SET state = 'failed', revision = 2,
       failure_reason = 'Invoice invalidated', failed_at = now() WHERE id = $1`,
      [attempt],
    );

    const racingInvoice = await createInvoice();
    const racingDocument = await createDocument(racingInvoice);
    const racingAttempt = crypto.randomUUID();
    await queue(racingInvoice, racingDocument, crypto.randomUUID(), PROPERTY_A, racingAttempt);
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE finance.invoices SET revision = 4, status = 'voided' WHERE id = $1",
        [racingInvoice],
      );
      const sent = expect(markSent(peer, racingAttempt)).rejects.toMatchObject({
        constraint: "chk_finance_invoice_delivery_attempt_issued",
      });
      await client.query("COMMIT");
      await sent;
    } finally {
      await client.query("ROLLBACK");
      await peer.end();
    }
  });

  it("rejects invalid initial evidence and transitions", async () => {
    const invoice = await createInvoice();
    const document = await createDocument(invoice);
    for (const [recipient, provider] of [
      [" guest@example.com", "resend"],
      ["guest@example.com", " resend"],
    ]) {
      await expect(
        queue(
          invoice,
          document,
          crypto.randomUUID(),
          PROPERTY_A,
          crypto.randomUUID(),
          false,
          recipient,
          provider,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      client.query(
        `INSERT INTO finance.invoice_delivery_attempts
         (property_id, invoice_id, invoice_revision, document_id, recipient_email,
          delivery_provider, provider_delivery_id, idempotency_key, state, revision, sent_at)
         VALUES ($1, $2, 3, $3, 'guest@example.com', 'resend', 'provider-1', $4, 'sent', 2, now())`,
        [PROPERTY_A, invoice, document, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoice_delivery_attempt_initial" });
    const id = crypto.randomUUID();
    await queue(invoice, document, crypto.randomUUID(), PROPERTY_A, id);
    await expect(
      client.query(
        "UPDATE finance.invoice_delivery_attempts SET state = 'sent', revision = 2, sent_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoice_delivery_attempts_lifecycle" });
    await expect(
      client.query("UPDATE finance.invoice_delivery_attempts SET revision = 2 WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects wrong scope and non-current invoice lifecycle", async () => {
    const invoice = await createInvoice();
    const otherInvoice = await createInvoice();
    const document = await createDocument(invoice);
    await expect(queue(otherInvoice, document)).rejects.toMatchObject({ code: "23503" });
    await expect(queue(invoice, document, crypto.randomUUID(), PROPERTY_B)).rejects.toMatchObject({
      code: "23503",
    });
    for (const [status, revision, attemptedRevision] of [
      ["draft", 3, 3],
      ["voided", 3, 3],
      ["issued", 4, 3],
    ] as const) {
      const invalidInvoice = await createInvoice(status, revision);
      const invalidDocument = await createDocument(invalidInvoice, attemptedRevision);
      await expect(queue(invalidInvoice, invalidDocument)).rejects.toMatchObject({
        constraint: "chk_finance_invoice_delivery_attempt_issued",
      });
    }
  });

  it("deduplicates replay after invoice revision and lifecycle changes", async () => {
    const invoice = await createInvoice();
    const document = await createDocument(invoice);
    const key = crypto.randomUUID();
    const id = crypto.randomUUID();
    await queue(invoice, document, key, PROPERTY_A, id);
    await expect(queue(invoice, document, key)).rejects.toMatchObject({
      constraint: "uq_finance_invoice_delivery_attempts_idempotency",
    });
    await client.query(
      "UPDATE finance.invoices SET revision = 4, status = 'voided' WHERE id = $1",
      [invoice],
    );
    expect((await queue(invoice, document, key, PROPERTY_A, id, true)).rowCount).toBe(0);
  });
});
