import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const [mediaRegistry, restoredPurposes, receiptMedia, documents] = await Promise.all([
  readMigration("0015_platform_media_registry.sql"),
  readMigration("0033_restore_identity_profile_media_purpose.sql"),
  readMigration("0061_finance_expense_receipt_media.sql"),
  readMigration("0067_finance_invoice_documents.sql"),
]);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";

describe("Finance invoice document migration contract", () => {
  it("adds no delivery state or copied content", () => {
    expect(documents).not.toMatch(/CREATE TABLE finance\.invoice_deliver|BYTEA|provider_response/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance invoice documents (PostgreSQL)", () => {
  let client: pg.Client;
  const rejects = (query: Promise<unknown>, match: Record<string, string>) =>
    expect(query).rejects.toMatchObject(match);

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE; DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog; CREATE SCHEMA finance;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
    `);
    await client.query(mediaRegistry);
    await client.query(restoredPurposes);
    await client.query(receiptMedia);
    await client.query(`CREATE TABLE finance.invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      archived_at TIMESTAMPTZ, UNIQUE (id, property_id));`);
    await client.query(documents);
  });

  afterAll(() =>
    client
      .query("DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE")
      .finally(() => client.end()),
  );

  const createInvoice = async (status = "issued", revision = 3, property = PROPERTY_A) =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO finance.invoices (property_id, revision, status) VALUES ($1, $2, $3) RETURNING id",
        [property, revision, status],
      )
    ).rows[0]!.id;

  const createMedia = async (
    documentId: string,
    overrides: {
      property?: string;
      purpose?: string;
      product?: string;
      type?: string;
      visibility?: string;
      contentType?: string;
      lifecycle?: string;
    } = {},
  ) => {
    const media = crypto.randomUUID();
    const values = {
      property: PROPERTY_A,
      purpose: "finance.invoice.document",
      product: "finance",
      type: "invoice_document",
      visibility: "private",
      contentType: "application/pdf",
      lifecycle: "active",
      ...overrides,
    };
    await client.query(
      `INSERT INTO platform.media_objects
       (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
        resource_type, resource_id, lifecycle_status, content_type, size_bytes, checksum_sha256)
       VALUES ($1, 'private', $2, $3, $4, $5, $6, $7, $8, $9, $10, 123, repeat('a', 64))`,
      [
        media,
        media,
        values.visibility,
        values.purpose,
        values.property,
        values.product,
        values.type,
        documentId,
        values.lifecycle,
        values.contentType,
      ],
    );
    return media;
  };

  const insertDocument = (
    id: string,
    invoice: string,
    media: string,
    revision: number,
    version: number,
    key: string,
    property = PROPERTY_A,
  ) =>
    client.query(
      `INSERT INTO finance.invoice_documents
       (id, property_id, invoice_id, invoice_revision, document_version, generation_key, media_object_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, property, invoice, revision, version, key, media],
    );

  const createDocument = async (key = crypto.randomUUID()) => {
    const invoice = await createInvoice();
    const document = crypto.randomUUID();
    const media = await createMedia(document);
    await insertDocument(document, invoice, media, 3, 1, key);
    return { invoice, document, media };
  };

  it("stores one immutable active private PDF version", async () => {
    const { document, media } = await createDocument();
    expect(
      (
        await client.query(
          `SELECT d.document_version, d.invoice_revision, m.visibility, m.content_type
         FROM finance.invoice_documents d JOIN platform.media_objects m ON m.id = d.media_object_id
         WHERE d.id = $1`,
          [document],
        )
      ).rows[0],
    ).toEqual({
      document_version: "1",
      invoice_revision: "3",
      visibility: "private",
      content_type: "application/pdf",
    });
    await rejects(
      client.query("UPDATE finance.invoice_documents SET document_version = 2 WHERE id = $1", [
        document,
      ]),
      { code: "23514" },
    );
    await rejects(client.query("DELETE FROM finance.invoice_documents WHERE id = $1", [document]), {
      code: "23514",
    });
    await rejects(
      client.query(
        "UPDATE platform.media_objects SET lifecycle_status = 'retained' WHERE id = $1",
        [media],
      ),
      { code: "23503" },
    );
    await rejects(
      client.query(
        "UPDATE platform.media_objects SET storage_key = 'replacement.pdf', checksum_sha256 = repeat('b', 64) WHERE id = $1",
        [media],
      ),
      { constraint: "chk_platform_invoice_document_content_immutable" },
    );
    await rejects(client.query("TRUNCATE finance.invoice_documents"), { code: "23514" });
  });

  it("rejects public, non-PDF, inactive, wrong-purpose, and cross-property media", async () => {
    await rejects(createMedia(crypto.randomUUID(), { visibility: "public" }), { code: "23514" });
    await expect(
      createMedia(crypto.randomUUID(), { contentType: "image/png" }),
    ).rejects.toMatchObject({ constraint: "chk_platform_media_objects_finance_evidence" });
    const incomplete = await createMedia(crypto.randomUUID());
    for (const column of ["size_bytes", "checksum_sha256"]) {
      await expect(
        client.query(`UPDATE platform.media_objects SET ${column} = NULL WHERE id = $1`, [
          incomplete,
        ]),
      ).rejects.toMatchObject({ constraint: "chk_platform_media_objects_finance_evidence" });
    }
    const invoice = await createInvoice();
    for (const overrides of [
      { lifecycle: "retained" },
      { purpose: "finance.expense.receipt", type: "expense" },
      { property: PROPERTY_B },
    ]) {
      const document = crypto.randomUUID();
      const media = await createMedia(document, overrides);
      await expect(
        insertDocument(document, invoice, media, 3, 1, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("serializes media updates with document binding", async () => {
    const invoice = await createInvoice();
    const document = crypto.randomUUID();
    const media = await createMedia(document);
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    try {
      await client.query("BEGIN");
      await insertDocument(document, invoice, media, 3, 1, crypto.randomUUID());
      const update = rejects(
        peer.query("UPDATE platform.media_objects SET storage_key='raced.pdf' WHERE id=$1", [
          media,
        ]),
        { constraint: "chk_platform_invoice_document_content_immutable" },
      );
      await client.query("COMMIT");
      await update;
    } finally {
      await client.query("ROLLBACK");
      await peer.end();
    }
  });

  it("rejects draft, voided, and stale invoice revisions", async () => {
    for (const [status, storedRevision, documentRevision] of [
      ["draft", 1, 1],
      ["voided", 4, 4],
      ["issued", 3, 2],
    ] as const) {
      const invoice = await createInvoice(status, storedRevision);
      const document = crypto.randomUUID();
      const media = await createMedia(document);
      await expect(
        insertDocument(document, invoice, media, documentRevision, 1, crypto.randomUUID()),
      ).rejects.toMatchObject({ constraint: "chk_finance_invoice_document_issued_revision" });
    }
  });

  it("deduplicates document versions and generation commands", async () => {
    const key = crypto.randomUUID();
    const { invoice, document: originalDocument, media: originalMedia } = await createDocument(key);
    for (const [version, generationKey, constraint] of [
      [1, crypto.randomUUID(), "uq_finance_invoice_documents_invoice_version"],
      [2, key, "uq_finance_invoice_documents_generation"],
    ] as const) {
      const document = crypto.randomUUID();
      const media = await createMedia(document);
      await expect(
        insertDocument(document, invoice, media, 3, version, generationKey),
      ).rejects.toMatchObject({ constraint });
    }
    const document = crypto.randomUUID();
    const media = await createMedia(document);
    await expect(insertDocument(document, invoice, media, 3, 2, " padded ")).rejects.toMatchObject({
      constraint: "chk_finance_invoice_documents_generation",
    });
    const replay = () =>
      client.query(
        `INSERT INTO finance.invoice_documents
         (id, property_id, invoice_id, invoice_revision, document_version, generation_key, media_object_id)
         VALUES ($1, $2, $3, 3, 1, $4, $5)
         ON CONFLICT (property_id, generation_key) DO NOTHING`,
        [originalDocument, PROPERTY_A, invoice, key, originalMedia],
      );
    await client.query("UPDATE finance.invoices SET revision = 4 WHERE id = $1", [invoice]);
    expect((await replay()).rowCount).toBe(0);
    await client.query(
      "UPDATE finance.invoices SET revision = 5, status = 'voided' WHERE id = $1",
      [invoice],
    );
    expect((await replay()).rowCount).toBe(0);
  });
});
