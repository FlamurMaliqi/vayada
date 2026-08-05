import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const [headers, lines] = await Promise.all([
  readMigration("0063_finance_invoice_headers.sql"),
  readMigration("0064_finance_invoice_lines.sql"),
]);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";

describe("Finance invoice line migration contract", () => {
  it("normalizes decimal lines without later child aggregates", () => {
    expect(lines).toContain("GENERATED ALWAYS AS (round(quantity * unit_amount, 4))");
    expect(lines).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(lines).toContain("chk_finance_invoice_total_matches_lines");
    expect(lines).not.toMatch(/invoice_(allocations|documents|deliveries)/);
    expect(lines).not.toMatch(/supplier_invoice|tax_amount|discount_amount/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance invoice lines (PostgreSQL)", () => {
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
      INSERT INTO pms.property_pricing_settings VALUES ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
    `);
    await client.query(headers);
    await client.query(lines);
  });

  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
    } finally {
      await client.end();
    }
  });

  const createInvoice = async (property = PROPERTY_A, currency = "EUR") =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO finance.invoices
      (property_id, recipient_name, currency) VALUES ($1, 'Guest', $2) RETURNING id`,
        [property, currency],
      )
    ).rows[0]!.id;

  const addLine = (invoiceId: string) =>
    client.query(
      `INSERT INTO finance.invoice_lines
    (invoice_id, property_id, currency, position, description, quantity, unit_amount)
    VALUES ($1, '${PROPERTY_A}', 'EUR', 1, 'Stay', 2.5, 10)`,
      [invoiceId],
    );

  const createPopulatedInvoice = async () => {
    const invoice = await createInvoice();
    await client.query("BEGIN");
    await client.query(
      "UPDATE finance.invoices SET total_amount = 25, revision = 2 WHERE id = $1",
      [invoice],
    );
    await addLine(invoice);
    await client.query("COMMIT");
    return invoice;
  };

  it("commits only a revisioned header total matching generated lines", async () => {
    const invoice = await createPopulatedInvoice();
    expect(
      (
        await client.query(
          `SELECT i.total_amount, l.line_total FROM finance.invoices i
      JOIN finance.invoice_lines l ON l.invoice_id = i.id WHERE i.id = $1`,
          [invoice],
        )
      ).rows[0],
    ).toEqual({ total_amount: "25.0000", line_total: "25.0000" });
  });

  it("rejects mismatched totals at commit", async () => {
    const invoice = await createInvoice();
    await client.query("BEGIN");
    await client.query(
      "UPDATE finance.invoices SET total_amount = 24, revision = 2 WHERE id = $1",
      [invoice],
    );
    await addLine(invoice);
    await expect(client.query("COMMIT")).rejects.toMatchObject({
      constraint: "chk_finance_invoice_total_matches_lines",
    });
    await client.query("ROLLBACK");
  });

  it("rejects cross-scope, duplicate-order, and invalid decimal lines", async () => {
    const invoice = await createInvoice();
    await expect(
      client.query(
        `INSERT INTO finance.invoice_lines
      (invoice_id, property_id, currency, position, description, quantity, unit_amount)
      VALUES ($1, $2, 'USD', 1, 'Stay', 1, 10)`,
        [invoice, PROPERTY_B],
      ),
    ).rejects.toMatchObject({ constraint: "fk_finance_invoice_lines_invoice_scope" });
    await client.query("BEGIN");
    await client.query(
      "UPDATE finance.invoices SET total_amount = 25, revision = 2 WHERE id = $1",
      [invoice],
    );
    await addLine(invoice);
    await expect(addLine(invoice)).rejects.toMatchObject({
      constraint: "uq_finance_invoice_lines_invoice_position",
    });
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("UPDATE finance.invoices SET revision = 2 WHERE id = $1", [invoice]);
    await expect(
      client.query(
        `INSERT INTO finance.invoice_lines
      (invoice_id, property_id, currency, position, description, quantity, unit_amount)
      VALUES ($1, $2, 'EUR', 1, 'Stay', 'NaN', 10)`,
        [invoice, PROPERTY_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoice_lines_quantity" });
    await client.query("ROLLBACK");
  });

  it("requires a same-transaction invoice revision for every line edit", async () => {
    const invoice = await createPopulatedInvoice();
    await expect(
      client.query(
        "UPDATE finance.invoice_lines SET description = 'Changed' WHERE invoice_id = $1",
        [invoice],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoice_line_revision" });
    await client.query("BEGIN");
    await client.query("UPDATE finance.invoices SET revision = 3 WHERE id = $1", [invoice]);
    await client.query(
      "UPDATE finance.invoice_lines SET description = 'Changed' WHERE invoice_id = $1",
      [invoice],
    );
    await client.query("COMMIT");
  });

  it("serializes line edits against invoice issue", async () => {
    const invoice = await createPopulatedInvoice();
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    try {
      await peer.query("BEGIN");
      await peer.query(
        `UPDATE finance.invoices SET status = 'issued',
        issued_on = '2026-08-05', revision = 3 WHERE id = $1`,
        [invoice],
      );
      await client.query("BEGIN");
      const bump = client.query(
        "UPDATE finance.invoices SET revision = revision + 1 WHERE id = $1",
        [invoice],
      );
      await peer.query("COMMIT");
      await bump;
      await expect(
        client.query(
          "UPDATE finance.invoice_lines SET description = 'Late' WHERE invoice_id = $1",
          [invoice],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally {
      await peer.end();
    }
  });

  it("freezes issued lines and totals and refuses line-less issue", async () => {
    const invoice = await createPopulatedInvoice();
    await client.query(
      `UPDATE finance.invoices SET status = 'issued',
      issued_on = '2026-08-05', revision = 3 WHERE id = $1`,
      [invoice],
    );
    await expect(
      client.query(
        "UPDATE finance.invoice_lines SET description = 'Changed' WHERE invoice_id = $1",
        [invoice],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE finance.invoices SET total_amount = 30, revision = 4 WHERE id = $1", [
        invoice,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const empty = await createInvoice();
    await expect(
      client.query(
        `UPDATE finance.invoices SET status = 'issued',
      issued_on = '2026-08-05', revision = 2 WHERE id = $1`,
        [empty],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_issued_invoice_has_lines" });
  });
});
