import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0063_finance_invoice_headers.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const PROPERTY_C = "20000000-0000-4000-8000-000000000003";
const PROPERTY_D = "20000000-0000-4000-8000-000000000004";
const PROPERTY_E = "20000000-0000-4000-8000-000000000005";
const BOOKING_B = "40000000-0000-4000-8000-000000000002";

describe("Finance invoice header migration contract", () => {
  it("persists real headers without later child aggregates", () => {
    expect(migration).toContain("finance.reserve_invoice_number");
    expect(migration).toContain("'INV-' || lpad");
    expect(migration).toContain("status IN ('draft', 'issued', 'voided')");
    expect(migration).toContain("protect_invoice_history");
    expect(migration).not.toMatch(
      /CREATE TABLE finance\.invoice_(lines|allocations|documents|deliveries)/,
    );
    expect(migration).not.toMatch(/total_amount|supplier_invoice|pdf|delivery_provider/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance invoice headers (PostgreSQL)", () => {
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
      INSERT INTO hotel_catalog.properties VALUES
        ('${PROPERTY_A}'), ('${PROPERTY_B}'), ('${PROPERTY_C}'), ('${PROPERTY_D}'),
        ('${PROPERTY_E}');
      INSERT INTO pms.property_pricing_settings VALUES
        ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD'),
        ('${PROPERTY_C}', 'EUR'), ('${PROPERTY_D}', 'EUR'), ('${PROPERTY_E}', 'EUR');
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

  const createInvoice = (propertyId: string, currency: string) =>
    client.query<{ id: string; invoice_number: string }>(
      `INSERT INTO finance.invoices (property_id, recipient_name, recipient_email, currency)
       VALUES ($1, 'Guest', 'guest@example.com', $2) RETURNING id, invoice_number`,
      [propertyId, currency],
    );

  it("reserves monotonic numbers that survive archive and reject deletion", async () => {
    const first = (await createInvoice(PROPERTY_A, "EUR")).rows[0]!;
    expect(first.invoice_number).toBe("INV-0001");
    await client.query(
      "UPDATE finance.invoices SET archived_at = now(), revision = 2 WHERE id = $1",
      [first.id],
    );
    expect((await createInvoice(PROPERTY_A, "EUR")).rows[0]!.invoice_number).toBe("INV-0002");
    await expect(
      client.query("DELETE FROM finance.invoices WHERE id = $1", [first.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE finance.invoices SET archived_at = NULL, revision = 3 WHERE id = $1", [
        first.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE finance.property_invoice_sequences")).rejects.toMatchObject(
      { code: "23514" },
    );
    await expect(
      client.query(
        "UPDATE finance.property_invoice_sequences SET next_number = 1 WHERE property_id = $1",
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects cross-property booking, currency, and invalid recipients", async () => {
    await expect(
      client.query(
        `INSERT INTO finance.invoices
      (property_id, guest_booking_id, recipient_name, currency)
      VALUES ($1, $2, 'Guest', 'EUR')`,
        [PROPERTY_A, BOOKING_B],
      ),
    ).rejects.toMatchObject({ constraint: "fk_finance_invoices_booking_property" });
    await expect(createInvoice(PROPERTY_A, "USD")).rejects.toMatchObject({
      constraint: "fk_finance_invoices_pricing_currency",
    });
    await expect(
      client.query(
        `INSERT INTO finance.invoices
      (property_id, recipient_name, currency) VALUES ($1, ' ', 'EUR')`,
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoices_recipient_name" });
    await expect(
      client.query(
        `INSERT INTO finance.invoices
      (property_id, recipient_name, recipient_email, currency)
      VALUES ($1, 'Guest', 'not-an-email', 'EUR')`,
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoices_recipient_email" });
  });

  it("allows only revisioned draft, issue, and void lifecycle changes", async () => {
    const invoice = (await createInvoice(PROPERTY_C, "EUR")).rows[0]!;
    await expect(
      client.query(
        `UPDATE finance.invoices
      SET status = 'issued', issued_on = '2026-08-05', due_on = '2026-08-04', revision = 2
      WHERE id = $1`,
        [invoice.id],
      ),
    ).rejects.toMatchObject({
      constraint: "chk_finance_invoices_due_date",
    });
    await client.query(
      `UPDATE finance.invoices
      SET status = 'issued', issued_on = '2026-08-05', due_on = '2026-08-12', revision = 2
      WHERE id = $1`,
      [invoice.id],
    );
    await expect(
      client.query(
        `UPDATE finance.invoices
      SET recipient_name = 'Changed', revision = 3 WHERE id = $1`,
        [invoice.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      `UPDATE finance.invoices
      SET status = 'voided', voided_at = now(), void_reason = 'Duplicate', revision = 3
      WHERE id = $1`,
      [invoice.id],
    );
    await expect(
      client.query("DELETE FROM finance.invoices WHERE id = $1", [invoice.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE finance.invoices")).rejects.toMatchObject({
      code: "23514",
    });
    const future = (await createInvoice(PROPERTY_B, "USD")).rows[0]!;
    await client.query(
      `UPDATE finance.invoices SET status = 'issued',
      issued_on = '2099-08-05', due_on = '2099-08-12', revision = 2 WHERE id = $1`,
      [future.id],
    );
    await expect(
      client.query(
        `UPDATE finance.invoices SET status = 'voided',
      voided_at = created_at + interval '1 day', void_reason = 'Too early', revision = 3
      WHERE id = $1`,
        [future.id],
      ),
    ).rejects.toMatchObject({
      constraint: "chk_finance_invoices_timestamps",
    });
  });

  it("does not truncate invoice numbers above four digits", async () => {
    await client.query(
      "INSERT INTO finance.property_invoice_sequences (property_id, next_number) VALUES ($1, 10000)",
      [PROPERTY_D],
    );
    expect((await createInvoice(PROPERTY_D, "EUR")).rows[0]!.invoice_number).toBe("INV-10000");
  });

  it("reserves distinct numbers under concurrent draft creation", async () => {
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    try {
      const sql = `INSERT INTO finance.invoices (property_id, recipient_name, currency)
        VALUES ($1, 'Guest', 'EUR') RETURNING invoice_number`;
      const results = await Promise.all([
        client.query<{ invoice_number: string }>(sql, [PROPERTY_E]),
        peer.query<{ invoice_number: string }>(sql, [PROPERTY_E]),
      ]);
      expect(results.flatMap(({ rows }) => rows.map((row) => row.invoice_number)).sort()).toEqual([
        "INV-0001",
        "INV-0002",
      ]);
    } finally {
      await peer.end();
    }
  });
});
