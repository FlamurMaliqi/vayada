import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0070_finance_expenses.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "20000000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "20000000-0000-4000-8000-000000000002";
const CATEGORY = "30000000-0000-4000-8000-000000000001";
const BOOKING = "40000000-0000-4000-8000-000000000001";
const PAYMENT = "50000000-0000-4000-8000-000000000001";
const OTHER_EVIDENCE = "80000000-0000-4000-8000-000000000002";

describe("Finance expense ledger migration contract", () => {
  it("stores evidence and adjustments, not invoice or P&L copies", () => {
    expect(migration).not.toMatch(/supplier_invoice_id|CREATE TABLE finance\.invoices/);
    expect(migration).not.toMatch(/CREATE TABLE finance\.(profit|loss)/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance expense ledger (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE; DROP SCHEMA IF EXISTS booking CASCADE; DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog; CREATE SCHEMA pms; CREATE SCHEMA booking; CREATE SCHEMA finance; CREATE SCHEMA platform;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.property_pricing_settings (property_id UUID PRIMARY KEY, currency CHAR(3), UNIQUE (property_id, currency));
      CREATE TABLE booking.guest_bookings (id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE finance.payments (id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE finance.expense_categories (id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE finance.recurring_expense_rules (id UUID PRIMARY KEY, property_id UUID, UNIQUE (id, property_id));
      CREATE TABLE platform.media_objects (id UUID PRIMARY KEY, property_id UUID, purpose TEXT, resource_product TEXT, resource_type TEXT, resource_id TEXT);
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY}'), ('${OTHER_PROPERTY}');
      INSERT INTO pms.property_pricing_settings VALUES ('${PROPERTY}', 'EUR'), ('${OTHER_PROPERTY}', 'USD');
      INSERT INTO booking.guest_bookings VALUES ('${BOOKING}', '${PROPERTY}');
      INSERT INTO finance.payments VALUES ('${PAYMENT}', '${PROPERTY}');
      INSERT INTO finance.expense_categories VALUES ('${CATEGORY}', '${PROPERTY}');
      INSERT INTO booking.guest_bookings VALUES ('${OTHER_EVIDENCE}', '${OTHER_PROPERTY}'); INSERT INTO finance.payments VALUES ('${OTHER_EVIDENCE}', '${OTHER_PROPERTY}'); INSERT INTO finance.recurring_expense_rules VALUES ('${OTHER_EVIDENCE}', '${OTHER_PROPERTY}');
    `);
    await client.query(migration);
  });

  afterAll(async () => {
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS finance CASCADE; DROP SCHEMA IF EXISTS platform CASCADE; DROP SCHEMA IF EXISTS booking CASCADE; DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE`,
      );
    } finally {
      await client.end();
    }
  });

  it("binds a private receipt to the exact property and expense", async () => {
    const expense = "60000000-0000-4000-8000-000000000001";
    const receipt = "70000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO platform.media_objects VALUES ($1, $2, 'finance.expense.receipt', 'finance', 'expense', $3)`,
      [receipt, PROPERTY, expense],
    );
    await client.query(
      `INSERT INTO finance.expenses
        (id, property_id, category_id, origin, incurred_on, vendor, amount, currency, receipt_media_id)
       VALUES ($1, $2, $3, 'manual', '2026-08-05', 'Vendor', 10, 'EUR', $4)`,
      [expense, PROPERTY, CATEGORY, receipt],
    );
    await expect(
      client.query("UPDATE platform.media_objects SET property_id = $1 WHERE id = $2", [
        OTHER_PROPERTY,
        receipt,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("deduplicates generated sources and rejects invalid evidence", async () => {
    const sql = `INSERT INTO finance.expenses
      (property_id, category_id, origin, incurred_on, vendor, amount, currency, source_key, payment_id)
      VALUES ($1, $2, 'platform_fee', '2026-08-05', 'Provider', 4, 'EUR', 'fee-1', $3)`;
    await client.query(sql, [PROPERTY, CATEGORY, PAYMENT]);
    await expect(client.query(sql, [PROPERTY, CATEGORY, PAYMENT])).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_finance_expenses_generated_source",
    });
    await expect(
      client.query(sql.replace("fee-1", " fee-1 "), [PROPERTY, CATEGORY, PAYMENT]),
    ).rejects.toMatchObject({ constraint: "chk_finance_expenses_source_key_format" });
    await expect(
      client.query(sql.replace("'EUR'", "'USD'").replace("fee-1", "fee-usd"), [
        PROPERTY,
        CATEGORY,
        PAYMENT,
      ]),
    ).rejects.toMatchObject({ constraint: "fk_finance_expenses_pricing_currency" });
    await expect(
      client.query(sql.replace("$3)", "NULL)").replace("fee-1", "fee-missing"), [
        PROPERTY,
        CATEGORY,
      ]),
    ).rejects.toMatchObject({ constraint: "chk_finance_expenses_origin_evidence" });
    await expect(
      client.query(
        `INSERT INTO finance.expenses
        (property_id, category_id, origin, incurred_on, vendor, amount, currency, payment_status)
        VALUES ($1, $2, 'manual', '2026-08-05', 'Vendor', 10, 'EUR', 'paid')`,
        [PROPERTY, CATEGORY],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_expenses_paid_state" });
    for (const [incurredOn, paidOn] of [
      ["infinity", null],
      ["2026-08-05", "-infinity"],
    ]) {
      await expect(
        client.query(
          `INSERT INTO finance.expenses
          (property_id, category_id, origin, incurred_on, paid_on, vendor, amount, currency, payment_status)
          VALUES ($1, $2, 'manual', $3, $4, 'Vendor', 10, 'EUR', CASE WHEN $4::date IS NULL THEN 'unpaid' ELSE 'paid' END)`,
          [PROPERTY, CATEGORY, incurredOn, paidOn],
        ),
      ).rejects.toMatchObject({ constraint: "chk_finance_expenses_dates" });
    }
    for (const [origin, field] of [
      ["recurring", "recurring_rule_id"],
      ["ota_commission", "guest_booking_id"],
      ["platform_fee", "payment_id"],
    ]) {
      await expect(
        client.query(
          `INSERT INTO finance.expenses
        (property_id, category_id, origin, incurred_on, vendor, amount, currency, source_key, ${field})
        VALUES ($1, $2, $3, '2026-08-05', 'Vendor', 10, 'EUR', $3 || '-other', $4)`,
          [PROPERTY, CATEGORY, origin, OTHER_EVIDENCE],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("preserves history through one correction link", async () => {
    const original = "60000000-0000-4000-8000-000000000010";
    await client.query(
      `INSERT INTO finance.expenses
       (id, property_id, category_id, origin, incurred_on, vendor, amount, currency)
       VALUES ($1, $2, $3, 'manual', '2026-08-01', 'Vendor', 10, 'EUR')`,
      [original, PROPERTY, CATEGORY],
    );
    await client.query(
      `INSERT INTO finance.expenses
       (property_id, category_id, origin, entry_kind, incurred_on, vendor, amount, currency,
        source_key, reverses_expense_id)
       VALUES ($1, $2, 'manual', 'correction', '2026-08-05', 'Vendor', 2, 'EUR', 'fix-1', $3)`,
      [PROPERTY, CATEGORY, original],
    );
    for (const query of [
      `DELETE FROM finance.expenses WHERE id = '${original}'`,
      "TRUNCATE finance.expenses",
    ])
      await expect(client.query(query)).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "UPDATE finance.expenses SET incurred_on = '2026-08-06', revision = 2 WHERE id = $1",
        [original],
      ),
    ).rejects.toMatchObject({ code: "23514", message: "expense accounting evidence is immutable" });
    await expect(
      client.query("UPDATE finance.expenses SET notes = 'paid' WHERE id = $1", [original]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      "UPDATE finance.expenses SET notes = 'paid', revision = revision + 1 WHERE id = $1",
      [original],
    );
    await expect(
      client.query("UPDATE finance.expenses SET amount = 11, revision = 3 WHERE id = $1", [
        original,
      ]),
    ).rejects.toMatchObject({ message: "expense financial fields require a correction" });
    await expect(
      client.query(
        "UPDATE finance.expenses SET amount = 3, revision = 2 WHERE source_key = 'fix-1'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `INSERT INTO finance.expenses
        (id, property_id, category_id, origin, entry_kind, incurred_on, vendor, amount, currency,
         source_key, reverses_expense_id)
        VALUES ($1, $2, $3, 'manual', 'reversal', '2026-08-05', 'Vendor', 10, 'EUR', 'self', $1)`,
        [crypto.randomUUID(), PROPERTY, CATEGORY],
      ),
    ).rejects.toMatchObject({ constraint: "chk_finance_expenses_reversal" });
    await expect(
      client.query(
        `INSERT INTO finance.expenses
        (property_id, category_id, origin, entry_kind, incurred_on, vendor, amount, currency,
         source_key, reverses_expense_id)
        VALUES ($1, $2, 'manual', 'reversal', '2026-08-05', 'Vendor', 10, 'EUR', 'fix-2', $3)`,
        [PROPERTY, CATEGORY, original],
      ),
    ).rejects.toMatchObject({ constraint: "uq_finance_expenses_reverses" });
  });

  it("keeps supplier bills identifier-only and categories referenced", async () => {
    await client.query(
      `INSERT INTO finance.expenses
      (property_id, category_id, origin, incurred_on, vendor, amount, currency,
       source_key, supplier_invoice_number)
      VALUES ($1, $2, 'supplier_bill', '2026-08-05', 'Supplier', 10, 'EUR', 'bill-1', NULL),
             ($1, $2, 'supplier_bill', '2026-08-05', 'Supplier', 10, 'EUR', 'bill-2', 'SUP-2026-001')`,
      [PROPERTY, CATEGORY],
    );
    const invalidSupplierEvidence = `INSERT INTO finance.expenses
      (property_id, category_id, origin, incurred_on, vendor, amount, currency,
       source_key, supplier_invoice_number)
      VALUES ($1, $2, $3, '2026-08-05', 'Supplier', 10, 'EUR',
        CASE WHEN $3 = 'manual' THEN NULL ELSE $3 || '-invalid' END, $4)`;
    for (const [origin, invoiceNumber, constraint] of [
      ["supplier_bill", " padded ", "chk_finance_expenses_supplier_invoice_number"],
      ["manual", "SUP-OTHER", "chk_finance_expenses_origin_evidence"],
    ]) {
      await expect(
        client.query(invalidSupplierEvidence, [PROPERTY, CATEGORY, origin, invoiceNumber]),
      ).rejects.toMatchObject({ constraint });
    }
    await expect(
      client.query("DELETE FROM finance.expense_categories WHERE id = $1", [CATEGORY]),
    ).rejects.toMatchObject({ constraint: "fk_finance_expenses_category_property" });
  });
});
