import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const migrations = await Promise.all(
  [
    "0062_finance_expenses.sql",
    "0063_finance_invoice_headers.sql",
    "0064_finance_invoice_lines.sql",
    "0065_finance_invoice_payment_allocations.sql",
    "0066_finance_supplier_invoice_expenses.sql",
  ].map(readMigration),
);
const supplierMigration = migrations.at(-1)!;
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const CATEGORY_A = "30000000-0000-4000-8000-000000000001";
const CATEGORY_B = "30000000-0000-4000-8000-000000000002";
const BOOKING_A = "40000000-0000-4000-8000-000000000001";

describe("Finance supplier invoice expense migration contract", () => {
  it("adds identifier bindings without copying supplier invoice facts", () => {
    expect(supplierMigration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(supplierMigration).toContain("supplier_expense_id");
    expect(supplierMigration).not.toMatch(/supplier_invoice_(number|date|amount)/);
    expect(supplierMigration).not.toMatch(/document|delivery|email/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance supplier invoice expenses (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE;
      DROP SCHEMA IF EXISTS booking CASCADE; DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog; CREATE SCHEMA pms; CREATE SCHEMA booking;
      CREATE SCHEMA finance; CREATE SCHEMA platform;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.property_pricing_settings (
        property_id UUID PRIMARY KEY, currency CHAR(3), UNIQUE (property_id, currency));
      CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE finance.payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
        currency CHAR(3) NOT NULL, status TEXT NOT NULL, amount NUMERIC(15,2) NOT NULL,
        refunded_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (id, property_id));
      CREATE TABLE finance.expense_categories (
        id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE finance.recurring_expense_rules (
        id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE platform.media_objects (
        id UUID PRIMARY KEY, property_id UUID, purpose TEXT, resource_product TEXT,
        resource_type TEXT, resource_id TEXT);
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
      INSERT INTO pms.property_pricing_settings VALUES ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
      INSERT INTO booking.guest_bookings VALUES ('${BOOKING_A}', '${PROPERTY_A}');
      INSERT INTO finance.expense_categories VALUES
        ('${CATEGORY_A}', '${PROPERTY_A}'), ('${CATEGORY_B}', '${PROPERTY_B}');
    `);
    for (const migration of migrations) await client.query(migration);
  });

  afterAll(async () => {
    try {
      await client.query(
        "DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE",
      );
    } finally {
      await client.end();
    }
  });

  const insertInvoice = (
    invoice: string,
    expense: string,
    reference: string,
    property = PROPERTY_A,
  ) =>
    client.query(
      `INSERT INTO finance.invoices
       (id, property_id, recipient_name, currency, invoice_kind, supplier_reference, supplier_expense_id)
       VALUES ($1, $2, 'Supplier', $3, 'supplier', $4, $5)`,
      [invoice, property, property === PROPERTY_A ? "EUR" : "USD", reference, expense],
    );

  const insertExpense = (
    expense: string,
    invoice: string,
    property = PROPERTY_A,
    origin = "supplier_bill",
    entryKind = "expense",
  ) =>
    client.query(
      `INSERT INTO finance.expenses
       (id, property_id, category_id, origin, entry_kind, incurred_on, vendor,
        amount, currency, source_key, supplier_invoice_id)
       VALUES ($1, $2, $3, $4, $5, '2026-08-05', 'Supplier', 40, $6, $7, $8)`,
      [
        expense,
        property,
        property === PROPERTY_A ? CATEGORY_A : CATEGORY_B,
        origin,
        entryKind,
        property === PROPERTY_A ? "EUR" : "USD",
        crypto.randomUUID(),
        invoice,
      ],
    );

  const createPair = async (reference: string = crypto.randomUUID()) => {
    const invoice = crypto.randomUUID();
    const expense = crypto.randomUUID();
    await client.query("BEGIN");
    await insertInvoice(invoice, expense, reference);
    await insertExpense(expense, invoice);
    await client.query("COMMIT");
    return { invoice, expense };
  };

  it("commits one reciprocal supplier invoice and supplier-bill expense", async () => {
    const { invoice, expense } = await createPair("Supplier-42");
    expect(
      (
        await client.query(
          `SELECT i.invoice_kind, i.supplier_reference, e.origin, e.entry_kind
           FROM finance.invoices i JOIN finance.expenses e
             ON e.id = i.supplier_expense_id AND e.supplier_invoice_id = i.id
           WHERE i.id = $1 AND e.id = $2`,
          [invoice, expense],
        )
      ).rows[0],
    ).toEqual({
      invoice_kind: "supplier",
      supplier_reference: "Supplier-42",
      origin: "supplier_bill",
      entry_kind: "expense",
    });
  });

  it("enforces guest/supplier shapes and property-scoped replay identity", async () => {
    await expect(
      client.query(
        `INSERT INTO finance.invoices
         (property_id, recipient_name, currency, supplier_reference)
         VALUES ($1, 'Guest', 'EUR', 'not-guest')`,
        [PROPERTY_A],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoices_party_evidence" });
    await expect(
      client.query(
        `INSERT INTO finance.invoices
         (property_id, recipient_name, currency, guest_booking_id, invoice_kind,
          supplier_reference, supplier_expense_id)
         VALUES ($1, 'Supplier', 'EUR', $2, 'supplier', 'mixed', $3)`,
        [PROPERTY_A, BOOKING_A, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoices_party_evidence" });
    await createPair("Replay-1");
    await expect(
      insertInvoice(crypto.randomUUID(), crypto.randomUUID(), "replay-1"),
    ).rejects.toMatchObject({ constraint: "uq_finance_invoices_supplier_reference" });
    await expect(
      insertInvoice(crypto.randomUUID(), crypto.randomUUID(), " padded "),
    ).rejects.toMatchObject({ constraint: "chk_finance_invoices_supplier_reference" });
  });

  it("rejects missing, cross-property, and invalid expense links", async () => {
    await client.query("BEGIN");
    await insertInvoice(crypto.randomUUID(), crypto.randomUUID(), "missing");
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK");

    const crossInvoice = crypto.randomUUID();
    const crossExpense = crypto.randomUUID();
    await client.query("BEGIN");
    await insertInvoice(crossInvoice, crossExpense, "cross-property");
    await insertExpense(crossExpense, crossInvoice, PROPERTY_B);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK");

    for (const [origin, entryKind] of [
      ["manual", "expense"],
      ["supplier_bill", "correction"],
      ["supplier_bill", "reversal"],
    ]) {
      const invoice = crypto.randomUUID();
      await client.query("BEGIN");
      await insertInvoice(invoice, crypto.randomUUID(), `${origin}-${entryKind}`);
      await expect(
        insertExpense(crypto.randomUUID(), invoice, PROPERTY_A, origin, entryKind),
      ).rejects.toMatchObject({ constraint: "chk_finance_expenses_origin_evidence" });
      await client.query("ROLLBACK");
    }
  });

  it("keeps both sides of the accounting identity immutable", async () => {
    const { invoice, expense } = await createPair();
    await expect(
      client.query(
        "UPDATE finance.invoices SET supplier_reference = 'changed', revision = 2 WHERE id = $1",
        [invoice],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "UPDATE finance.expenses SET supplier_invoice_id = $2, revision = 2 WHERE id = $1",
        [expense, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("DELETE FROM finance.invoices WHERE id = $1", [invoice]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("DELETE FROM finance.expenses WHERE id = $1", [expense]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE finance.expenses")).rejects.toBeDefined();
  });
});
