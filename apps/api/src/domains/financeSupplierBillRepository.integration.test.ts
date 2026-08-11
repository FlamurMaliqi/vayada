import { createHash } from "node:crypto";

import { normalizeFinanceExpenseAmount } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPgFinanceSupplierBillRepository,
  type CreateFinanceSupplierBillCommand,
} from "./financeSupplierBillRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12110000-0000-4000-8000-000000000001";
const PROPERTY = "12110000-0000-4000-8000-000000000002";
const OTHER_PROPERTY = "12110000-0000-4000-8000-000000000003";
const CATEGORY = "12110000-0000-4000-8000-000000000004";
const OTHER_CATEGORY = "12110000-0000-4000-8000-000000000005";
const INVOICE = "12110000-0000-4000-8000-000000000006";
const EXPENSE = "12110000-0000-4000-8000-000000000007";

describe.skipIf(!URL)("PostgreSQL Finance supplier bill repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceSupplierBillRepository(URL ?? "postgresql://disabled");

  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await admin.query(`INSERT INTO identity.users (id,email,name,status) VALUES ('${ACTOR}','supplier-bill@example.test','Supplier bill','active');
      INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ('${PROPERTY}','supplier-bill','Supplier bill'),('${OTHER_PROPERTY}','supplier-bill-other','Supplier bill other');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${OTHER_PROPERTY}','USD');
      INSERT INTO finance.expense_categories (id,property_id,name,color) VALUES ('${CATEGORY}','${PROPERTY}','Supplies','#123456'),('${OTHER_CATEGORY}','${OTHER_PROPERTY}','Other','#654321')`);
  });
  // prettier-ignore
  afterAll(async () => { await repository.close(); await cleanup(); await admin.end(); });

  it("creates exactly one pair, replays it, and rejects mismatched or duplicate evidence", async () => {
    await expect(repository.create(create("category", "EUR", OTHER_CATEGORY))).resolves.toEqual({
      ok: false,
      code: "evidence_mismatch",
    });
    await expect(repository.create(create("currency", "USD"))).resolves.toEqual({
      ok: false,
      code: "currency_mismatch",
    });
    const mismatch = create("total");
    mismatch.amount = { amount: normalizeFinanceExpenseAmount("41")!, currency: "EUR" };
    await expect(repository.create(mismatch)).resolves.toEqual({
      ok: false,
      code: "evidence_mismatch",
    });
    for (const invalid of [
      { dueOn: "0000-01-01" },
      { lines: [] },
      { paidOn: undefined },
      { extra: true },
    ])
      await expect(
        repository.create({ ...create("invalid"), ...invalid } as never),
      ).resolves.toEqual({ ok: false, code: "invalid_command" });

    const input = create("create");
    const created = await repository.create(input);
    expect(created).toMatchObject({
      ok: true,
      outcome: "created",
      item: {
        invoice: {
          id: INVOICE,
          number: "INV-0001",
          supplierReference: "ACME-42",
          total: { amount: "40.0000", currency: "EUR" },
          revision: 1,
        },
        expense: {
          id: EXPENSE,
          origin: "supplier_bill",
          amount: { amount: "40.0000", currency: "EUR" },
          revision: 1,
        },
      },
    });
    await expect(repository.create(input)).resolves.toEqual({ ...created, outcome: "replayed" });
    await rejectCorruptReplay(input, created);
    await expect(repository.create({ ...input, expenseId: crypto.randomUUID() })).resolves.toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    await expect(
      repository.create({ ...input, idempotencyKey: "supplier-new-key" }),
    ).resolves.toEqual({ ok: false, code: "idempotency_conflict" });

    const concurrent = {
      ...create("concurrent"),
      commandId: crypto.randomUUID(),
      expenseId: crypto.randomUUID(),
      supplierReference: "ACME-43",
    };
    const raced = await Promise.all([repository.create(concurrent), repository.create(concurrent)]);
    expect(raced.map((result) => result.ok && result.outcome).sort()).toEqual([
      "created",
      "replayed",
    ]);
    const evidence = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.invoices WHERE property_id=$1) AS invoices,
        (SELECT count(*)::int FROM finance.expenses WHERE property_id=$1) AS expenses,
        (SELECT count(*)::int FROM finance.invoice_lines WHERE property_id=$1) AS lines,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS keys,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1) AS audits,
        (SELECT redacted_payload FROM platform.product_audit_events WHERE target_resource_id=$2) AS audit`,
      [PROPERTY, INVOICE],
    );
    // prettier-ignore
    expect(evidence.rows[0]).toMatchObject({ invoices:2,expenses:2,lines:4,keys:2,audits:2,audit:{invoice:{id:INVOICE},expense:{id:EXPENSE},actorOrganizationId:expect.any(String)} });
    await expect(
      admin.query("UPDATE finance.invoices SET supplier_expense_id=$2,revision=2 WHERE id=$1", [
        INVOICE,
        crypto.randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query("UPDATE finance.expenses SET supplier_invoice_id=$2,revision=2 WHERE id=$1", [
        EXPENSE,
        crypto.randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back the invoice, expense, lines, sequence, and key when audit persistence fails", async () => {
    const input = {
      ...create("rollback"),
      commandId: crypto.randomUUID(),
      expenseId: crypto.randomUUID(),
      supplierReference: "ACME-rollback",
    };
    input.audit.actor = {
      kind: "user",
      userId: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
    };
    await expect(repository.create(input)).rejects.toMatchObject({ code: "23503" });
    const residue = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.invoices WHERE id=$1) AS invoices,
        (SELECT count(*)::int FROM finance.expenses WHERE id=$2) AS expenses,
        (SELECT count(*)::int FROM finance.invoice_lines WHERE invoice_id=$1) AS lines,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE key_hash=$3) AS keys,
        (SELECT next_number::int FROM finance.property_invoice_sequences WHERE property_id=$4) AS next_number`,
      [input.commandId, input.expenseId, hashKey(input.idempotencyKey), PROPERTY],
    );
    expect(residue.rows[0]).toEqual({
      invoices: 0,
      expenses: 0,
      lines: 0,
      keys: 0,
      next_number: 3,
    });
  });

  // prettier-ignore
  async function rejectCorruptReplay(input:CreateFinanceSupplierBillCommand,created:unknown) { await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{result,item,invoice,unexpected}','true') WHERE key_hash=$1`,[hashKey(input.idempotencyKey)]); await expect(repository.create(input)).rejects.toThrow("supplier bill replay evidence is invalid"); await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_build_object('propertyId',$2::text,'result',$3::jsonb) WHERE key_hash=$1`,[hashKey(input.idempotencyKey),PROPERTY,JSON.stringify(created)]); await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{propertyId}',to_jsonb($2::text)) WHERE key_hash=$1`,[hashKey(input.idempotencyKey),OTHER_PROPERTY]); await expect(repository.create(input)).rejects.toThrow("supplier bill replay evidence is invalid"); await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{propertyId}',to_jsonb($2::text)) WHERE key_hash=$1`,[hashKey(input.idempotencyKey),PROPERTY]); }
  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM finance.invoice_lines WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM finance.invoices WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM finance.property_invoice_sequences WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM finance.expense_categories WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`);
  }
});

// prettier-ignore
function create(key: string, currency="EUR", categoryId=CATEGORY): CreateFinanceSupplierBillCommand {
  return { commandId: key==="create" ? INVOICE : crypto.randomUUID(), expenseId: key==="create" ? EXPENSE : crypto.randomUUID(), idempotencyKey:`supplier-${key}`,propertyId:PROPERTY,supplierReference:key==="create"?"ACME-42":`ACME-${key}`,vendor:"ACME Supplies",supplierEmail:"billing@acme.test",dueOn:"2026-09-10",incurredOn:"2026-08-10",categoryId,amount:{amount:normalizeFinanceExpenseAmount("40")!,currency},paymentStatus:"paid",paidOn:"2026-08-11",notes:"Office supplies",lines:[{description:"Paper",quantity:"2.0000",unitAmount:{amount:normalizeFinanceExpenseAmount("10")!,currency}},{description:"Ink",quantity:"1.0000",unitAmount:{amount:normalizeFinanceExpenseAmount("20")!,currency}}],audit:{actor:{kind:"user",userId:ACTOR,organizationId:crypto.randomUUID()},requestId:`request-${key}`,correlationId:`correlation-${key}`,reason:"Record supplier bill",requestedAt:"2026-08-11T10:00:00.000Z"} };
}
// prettier-ignore
function hashKey(value:string):string { return createHash("sha256").update(value).digest("hex"); }
