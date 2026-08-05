import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";
const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const [headers, lines, allocations] = await Promise.all([
  readMigration("0063_finance_invoice_headers.sql"),
  readMigration("0064_finance_invoice_lines.sql"),
  readMigration("0065_finance_invoice_payment_allocations.sql"),
]);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
describe.skipIf(!TEST_DATABASE_URL)("Finance invoice payment allocations (PostgreSQL)", () => {
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
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
        currency CHAR(3) NOT NULL, status TEXT NOT NULL, amount NUMERIC(15,2) NOT NULL,
        refunded_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (id, property_id));
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_A}'), ('${PROPERTY_B}');
      INSERT INTO pms.property_pricing_settings VALUES ('${PROPERTY_A}', 'EUR'), ('${PROPERTY_B}', 'USD');
    `);
    await client.query(headers);
    await client.query(lines);
    await client.query(allocations);
  });
  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS finance CASCADE");
    } finally {
      await client.end();
    }
  });
  const createInvoice = async (amount = 100, issue = true) => {
    const invoice = (
      await client.query<{ id: string }>(
        `INSERT INTO finance.invoices (property_id, recipient_name, currency)
         VALUES ($1, 'Guest', 'EUR') RETURNING id`,
        [PROPERTY_A],
      )
    ).rows[0]!.id;
    await client.query("BEGIN");
    await client.query(
      "UPDATE finance.invoices SET total_amount = $2, revision = 2 WHERE id = $1",
      [invoice, amount],
    );
    await client.query(
      `INSERT INTO finance.invoice_lines
       (invoice_id, property_id, currency, position, description, quantity, unit_amount)
       VALUES ($1, $2, 'EUR', 1, 'Stay', 1, $3)`,
      [invoice, PROPERTY_A, amount],
    );
    await client.query("COMMIT");
    if (issue) {
      await client.query(
        "UPDATE finance.invoices SET status = 'issued', issued_on = CURRENT_DATE, revision = 3 WHERE id = $1",
        [invoice],
      );
    }
    return invoice;
  };
  const createPayment = async (amount = 100, status = "paid") =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO finance.payments (property_id, currency, status, amount)
         VALUES ($1, 'EUR', $2, $3) RETURNING id`,
        [PROPERTY_A, status, amount],
      )
    ).rows[0]!.id;
  const allocate = (
    db: pg.Client,
    invoice: string,
    payment: string,
    amount: number | string,
    key: string,
    ignoreConflict = false,
  ) =>
    db.query(
      `INSERT INTO finance.invoice_payment_allocations
       (property_id, invoice_id, payment_id, currency, amount, idempotency_key)
       VALUES ($1, $2, $3, 'EUR', $4, $5) ${ignoreConflict ? "ON CONFLICT (property_id, idempotency_key) DO NOTHING" : ""}`,
      [PROPERTY_A, invoice, payment, amount, key],
    );
  const rejectsCheck = (query: Promise<unknown>) =>
    expect(query).rejects.toMatchObject({ code: "23514" });
  it("initializes database-managed parent totals to zero", async () => {
    const result = await client.query(`
      WITH payment AS (
        INSERT INTO finance.payments (property_id, currency, status, amount, invoice_allocated_amount)
        VALUES ('${PROPERTY_A}', 'EUR', 'paid', 100, 50) RETURNING invoice_allocated_amount
      ), invoice AS (
        INSERT INTO finance.invoices (property_id, recipient_name, currency, allocated_amount)
        VALUES ('${PROPERTY_A}', 'Guest', 'EUR', 50) RETURNING allocated_amount
      ) SELECT payment.invoice_allocated_amount, invoice.allocated_amount FROM payment, invoice`);
    expect(Object.values(result.rows[0])).toEqual(["0.0000", "0.0000"]);
  });
  it("rejects invalid scope, state, amount, and duplicate commands without changing totals", async () => {
    const invoice = await createInvoice();
    const draft = await createInvoice(100, false);
    const paid = await createPayment();
    const pending = await createPayment(100, "pending");
    await expect(
      allocate(client, invoice, pending, 10, `pending-${invoice}`),
    ).rejects.toMatchObject({
      constraint: "chk_finance_invoice_allocation_payment_eligible",
    });
    await expect(allocate(client, draft, paid, 10, `draft-${invoice}`)).rejects.toMatchObject({
      constraint: "chk_finance_invoice_allocation_invoice_eligible",
    });
    await client.query(
      "UPDATE finance.invoices SET status = 'issued', issued_on = CURRENT_DATE, revision = 3 WHERE id = $1",
      [draft],
    );
    await client.query(
      "UPDATE finance.invoices SET status = 'voided', voided_at = now(), void_reason = 'Canceled', revision = 4 WHERE id = $1",
      [draft],
    );
    await expect(allocate(client, draft, paid, 10, `void-${invoice}`)).rejects.toMatchObject({
      constraint: "chk_finance_invoice_allocation_invoice_eligible",
    });
    await expect(
      client.query(
        `INSERT INTO finance.invoice_payment_allocations
         (property_id, invoice_id, payment_id, currency, amount, idempotency_key)
         VALUES ($1, $2, $3, 'EUR', 10, $4)`,
        [PROPERTY_B, invoice, paid, `scope-${invoice}`],
      ),
    ).rejects.toMatchObject({ constraint: "fk_finance_invoice_allocations_invoice_scope" });
    for (const amount of ["NaN", "Infinity", 0, -1]) {
      const rejection = allocate(client, invoice, paid, amount, `invalid-${amount}-${invoice}`);
      await expect(rejection).rejects.toBeDefined();
    }
    const key = `duplicate-${invoice}`;
    await allocate(client, invoice, paid, 10, key);
    await allocate(client, invoice, paid, 10, key, true);
    await expect(allocate(client, invoice, paid, 10, key)).rejects.toMatchObject({
      constraint: "uq_finance_invoice_allocations_idempotency",
    });
    expect(
      (
        await client.query(
          `SELECT invoice_allocated_amount,
           (SELECT count(*)::INT FROM finance.invoice_payment_allocations
            WHERE idempotency_key = $2) AS allocation_count
           FROM finance.payments WHERE id = $1`,
          [paid, key],
        )
      ).rows[0],
    ).toEqual({ invoice_allocated_amount: "10.0000", allocation_count: 1 });
  });
  it("keeps allocation evidence and database-managed totals immutable", async () => {
    const invoice = await createInvoice();
    const payment = await createPayment();
    await allocate(client, invoice, payment, 10, `immutable-${invoice}`);
    await rejectsCheck(
      client.query(
        "UPDATE finance.invoice_payment_allocations SET amount = 9 WHERE invoice_id = $1",
        [invoice],
      ),
    );
    await rejectsCheck(
      client.query("DELETE FROM finance.invoice_payment_allocations WHERE invoice_id = $1", [
        invoice,
      ]),
    );
    await rejectsCheck(
      client.query("UPDATE finance.payments SET status = 'disputed' WHERE id = $1", [payment]),
    );
    await rejectsCheck(client.query("TRUNCATE finance.invoice_payment_allocations"));
  });
  it("serializes concurrent claims against invoice and payment capacity", async () => {
    const peers = [
      new pg.Client({ connectionString: TEST_DATABASE_URL }),
      new pg.Client({ connectionString: TEST_DATABASE_URL }),
    ];
    await Promise.all(peers.map((peer) => peer.connect()));
    try {
      const invoice = await createInvoice();
      const payments = await Promise.all([createPayment(), createPayment()]);
      let outcomes = await Promise.allSettled(
        peers.map((peer, index) =>
          allocate(peer, invoice, payments[index]!, 60, `invoice-race-${invoice}-${index}`),
        ),
      );
      expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(
        (
          await client.query("SELECT allocated_amount FROM finance.invoices WHERE id = $1", [
            invoice,
          ])
        ).rows[0],
      ).toEqual({ allocated_amount: "60.0000" });
      const payment = await createPayment();
      const invoices = await Promise.all([createInvoice(), createInvoice()]);
      outcomes = await Promise.allSettled(
        peers.map((peer, index) =>
          allocate(peer, invoices[index]!, payment, 60, `payment-race-${payment}-${index}`),
        ),
      );
      expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(
        (
          await client.query(
            "SELECT invoice_allocated_amount FROM finance.payments WHERE id = $1",
            [payment],
          )
        ).rows[0],
      ).toEqual({ invoice_allocated_amount: "60.0000" });
    } finally {
      await Promise.all(peers.map((peer) => peer.end()));
    }
  });
});
