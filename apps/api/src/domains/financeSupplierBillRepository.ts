import { createHash } from "node:crypto";

import {
  FINANCE_EXPENSE_PAYMENT_STATUSES,
  normalizeFinanceExpenseAmount,
  type FinanceCommandAudit,
  type FinanceExpense,
  type FinanceExpenseCommandResult,
  type FinanceExpenseMoney,
  type FinanceExpensePaymentStatus,
} from "@vayada/domain-finance";
import pg from "pg";

// prettier-ignore
export type FinanceSupplierBillLine = { description: string; quantity: string; unitAmount: FinanceExpenseMoney };
// prettier-ignore
export type CreateFinanceSupplierBillCommand = { commandId: string; expenseId: string; idempotencyKey: string; propertyId: string; supplierReference: string; vendor: string; supplierEmail?: string; dueOn?: string; incurredOn: string; categoryId: string; amount: FinanceExpenseMoney; paymentStatus: FinanceExpensePaymentStatus; paidOn?: string; notes?: string; lines: readonly FinanceSupplierBillLine[]; audit: FinanceCommandAudit };
// prettier-ignore
export type FinanceSupplierBillPair = { invoice: { id: string; number: string; supplierReference: string; dueOn: string | null; status: "draft"; total: FinanceExpenseMoney; revision: number }; expense: FinanceExpense };
export type CreateFinanceSupplierBillResult = FinanceExpenseCommandResult<FinanceSupplierBillPair>;

// prettier-ignore
type KeyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };
type InvoiceRow = FinanceSupplierBillPair["invoice"];
const OPERATION = "finance.supplier_bill.create";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
// prettier-ignore
const KEYS = ["commandId","expenseId","idempotencyKey","propertyId","supplierReference","vendor","supplierEmail","dueOn","incurredOn","categoryId","amount","paymentStatus","paidOn","notes","lines","audit"];
const EXPENSE_COLUMNS = `id::text,category_id::text AS "categoryId",origin,
  incurred_on::text AS "incurredOn",paid_on::text AS "paidOn",vendor,
  jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,
  payment_status AS "paymentStatus",recurring_rule_id::text AS "recurringRuleId",
  source_key AS "sourceKey",reverses_expense_id::text AS "reversesExpenseId",revision::int`;

// prettier-ignore
export function createPgFinanceSupplierBillRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { create: (command: CreateFinanceSupplierBillCommand) => execute(pool, command), close: () => pool.end() };
}

// prettier-ignore
async function execute(pool: pg.Pool, raw: CreateFinanceSupplierBillCommand): Promise<CreateFinanceSupplierBillResult> {
  if (!valid(raw)) return { ok: false, code: "invalid_command" };
  if (raw.lines.some((line) => line.unitAmount.currency !== raw.amount.currency))
    return { ok: false, code: "currency_mismatch" };
  const keyHash = hash(raw.idempotencyKey);
  const requestHash = fingerprint(raw);
  const acceptedAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const property = await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE", [raw.propertyId]);
    if (property.rowCount !== 1) return stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<KeyRow>(
      `SELECT status,request_fingerprint_hash AS fingerprint,response_body_hash AS "responseHash",
              idempotency_metadata AS metadata FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [OPERATION, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return stop(client, await replay(client, existing.rows[0], raw, requestHash));
    const currency = await client.query("SELECT 1 FROM pms.property_pricing_settings WHERE property_id=$1::uuid AND currency=$2 FOR SHARE", [raw.propertyId, raw.amount.currency]);
    if (currency.rowCount !== 1) return stop(client, { ok: false, code: "currency_mismatch" });
    const category = await client.query("SELECT 1 FROM finance.expense_categories WHERE id=$1::uuid AND property_id=$2::uuid AND archived_at IS NULL FOR SHARE", [raw.categoryId, raw.propertyId]);
    if (category.rowCount !== 1) return stop(client, { ok: false, code: "evidence_mismatch" });
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
          property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [OPERATION, keyHash, requestHash, raw.propertyId, raw.audit.correlationId ?? raw.audit.requestId],
    );
    const reservationId = reserved.rows[0]?.id;
    if (!reservationId) return stop(client, { ok: false, code: "idempotency_conflict" });
    const lineJson = JSON.stringify(raw.lines);
    const calculated = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(round((line->>'quantity')::numeric *
        (line->'unitAmount'->>'amount')::numeric,4)),0)::text AS total
       FROM jsonb_array_elements($1::jsonb) AS rows(line)`,
      [lineJson],
    );
    if (normalizeFinanceExpenseAmount(calculated.rows[0]!.total) !== raw.amount.amount)
      return stop(client, { ok: false, code: "evidence_mismatch" });
    let invoice: InvoiceRow;
    let expense: FinanceExpense;
    try {
      const invoiceResult = await client.query<InvoiceRow>(
        `INSERT INTO finance.invoices
           (id,property_id,recipient_name,recipient_email,currency,due_on,total_amount,
            line_change_xid,invoice_kind,supplier_reference,supplier_expense_id)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::date,$7::numeric,pg_current_xact_id(),
                 'supplier',$8,$9::uuid)
         RETURNING id::text,invoice_number AS number,supplier_reference AS "supplierReference",
           due_on::text AS "dueOn",status,jsonb_build_object('amount',total_amount::text,
           'currency',currency::text) AS total,revision::int`,
        [raw.commandId, raw.propertyId, raw.vendor, raw.supplierEmail ?? null, raw.amount.currency, raw.dueOn ?? null, raw.amount.amount, raw.supplierReference, raw.expenseId],
      );
      invoice = invoiceResult.rows[0]!;
      await client.query(
        `INSERT INTO finance.invoice_lines
           (invoice_id,property_id,currency,position,description,quantity,unit_amount)
         SELECT $1::uuid,$2::uuid,$3,ordinality::int,line->>'description',
           (line->>'quantity')::numeric,(line->'unitAmount'->>'amount')::numeric
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS rows(line,ordinality)`,
        [raw.commandId, raw.propertyId, raw.amount.currency, lineJson],
      );
      const expenseResult = await client.query<FinanceExpense>(
        `INSERT INTO finance.expenses
           (id,property_id,category_id,origin,incurred_on,paid_on,vendor,amount,currency,
            payment_status,source_key,supplier_invoice_id,notes)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'supplier_bill',$4::date,$5::date,$6,$7::numeric,
                 $8,$9,$10,$11::uuid,$12) RETURNING ${EXPENSE_COLUMNS}`,
        [raw.expenseId, raw.propertyId, raw.categoryId, raw.incurredOn, raw.paidOn ?? null, raw.vendor, raw.amount.amount, raw.amount.currency, raw.paymentStatus, `supplier_invoice:${raw.commandId}`, raw.commandId, raw.notes ?? null],
      );
      expense = expenseResult.rows[0]!;
    } catch (error) {
      const name = String(constraint(error));
      if (["invoices_pkey","expenses_pkey","uq_finance_invoices_supplier_reference","uq_finance_expenses_generated_source","uq_finance_expenses_supplier_invoice"].includes(name)) return stop(client, { ok: false, code: "idempotency_conflict" });
      if (["fk_finance_invoices_pricing_currency","fk_finance_expenses_pricing_currency"].includes(name)) return stop(client, { ok: false, code: "currency_mismatch" });
      if (name === "fk_finance_expenses_category_property")
        return stop(client, { ok: false, code: "evidence_mismatch" });
      throw error;
    }
    const item = { invoice, expense };
    const result = { ok: true as const, outcome: "created" as const, item };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
          target_resource_product,target_resource_type,target_resource_id,secondary_resource_product,
          secondary_resource_type,secondary_resource_id,idempotency_key_id,correlation_id,causation_id,
          redacted_payload,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
         'finance','supplier_invoice',$6,'finance','expense',$7,$8::uuid,$9,$10,$11::jsonb,
         'financial','confidential')`,
      [`${OPERATION}.property.${raw.propertyId}.invoice.${raw.commandId}.key.${keyHash}.v1`, OPERATION, acceptedAt, raw.propertyId, actor.kind === "user" ? actor.userId : null, raw.commandId, raw.expenseId, reservationId, raw.audit.correlationId ?? raw.audit.requestId, raw.audit.requestId, JSON.stringify({ commandId: raw.commandId, outcome: result.outcome, invoice, expense, actorOrganizationId: actor.kind === "user" ? actor.organizationId : null, requestedAt: raw.audit.requestedAt, reason: raw.audit.reason })],
    );
    const completed = await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
         response_body_hash=$2,completed_at=$3::timestamptz,response_resource_product='finance',
         response_resource_type='supplier_invoice',response_resource_id=$4,
         idempotency_metadata=jsonb_build_object('propertyId',$5::text,'result',$6::jsonb)
       WHERE id=$1::uuid AND status='in_progress'`,
      [reservationId, resultHash(item), acceptedAt, raw.commandId, raw.propertyId, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) throw new Error("supplier bill idempotency completion failed");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

// prettier-ignore
function valid(raw: CreateFinanceSupplierBillCommand): boolean {
  const audit = raw.audit;
  const actor = audit?.actor;
  return known(raw, KEYS) && uuid(raw.commandId) && uuid(raw.expenseId) && raw.commandId !== raw.expenseId && trimmed(raw.idempotencyKey,1,200) && uuid(raw.propertyId) && trimmed(raw.supplierReference,1,200) && trimmed(raw.vendor,1,200) && (raw.supplierEmail === undefined || (trimmed(raw.supplierEmail,3,320) && EMAIL.test(raw.supplierEmail))) && (raw.dueOn === undefined || date(raw.dueOn)) && date(raw.incurredOn) && uuid(raw.categoryId) && money(raw.amount,false) && FINANCE_EXPENSE_PAYMENT_STATUSES.includes(raw.paymentStatus) && ((raw.paymentStatus === "paid") === (raw.paidOn !== undefined)) && (raw.paidOn === undefined || date(raw.paidOn)) && (raw.notes === undefined || trimmed(raw.notes,1,2000)) && Array.isArray(raw.lines) && raw.lines.length >= 1 && raw.lines.length <= 1000 && raw.lines.every(line) && actor?.kind === "user" && uuid(actor.userId) && uuid(actor.organizationId) && trimmed(audit.requestId,1,200) && (audit.correlationId === undefined || trimmed(audit.correlationId,1,200)) && trimmed(audit.reason,1,500) && utc(audit.requestedAt);
}
// prettier-ignore
function line(value: unknown): value is FinanceSupplierBillLine { return record(value) && known(value,["description","quantity","unitAmount"]) && Object.keys(value).length===3 && trimmed(value.description,1,500) && decimal(value.quantity,false) && money(value.unitAmount,true); }
// prettier-ignore
function money(value: unknown, zero: boolean): value is FinanceExpenseMoney { return record(value) && Object.keys(value).sort().join()==="amount,currency" && decimal(value.amount,zero) && typeof value.currency==="string" && /^[A-Z]{3}$/.test(value.currency); }
function decimal(value: unknown, zero: boolean): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}` === value && (zero || value !== "0.0000");
}
// prettier-ignore
function fingerprint(raw: CreateFinanceSupplierBillCommand): string { return hash(JSON.stringify([raw.commandId,raw.expenseId,raw.supplierReference,raw.vendor,raw.supplierEmail??null,raw.dueOn??null,raw.incurredOn,raw.categoryId,raw.amount.amount,raw.amount.currency,raw.paymentStatus,raw.paidOn??null,raw.notes??null,raw.lines.map(line => [line.description,line.quantity,line.unitAmount.amount,line.unitAmount.currency])])); }
// prettier-ignore
async function replay(client: pg.PoolClient, row: KeyRow, raw: CreateFinanceSupplierBillCommand, fingerprint: string): Promise<CreateFinanceSupplierBillResult> {
  if (row.fingerprint !== fingerprint || row.status !== "completed") return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) && known(row.metadata,["propertyId","result"]) && row.metadata["propertyId"]===raw.propertyId ? row.metadata["result"] : null;
  const item = storedPair(stored,raw);
  if (!item || row.responseHash !== resultHash(item)) throw new Error("supplier bill replay evidence is invalid");
  const binding = await client.query(`SELECT 1 FROM finance.invoices i JOIN finance.expenses e ON e.id=i.supplier_expense_id AND e.supplier_invoice_id=i.id AND e.property_id=i.property_id WHERE i.id=$1::uuid AND e.id=$2::uuid AND i.property_id=$3::uuid`,[raw.commandId,raw.expenseId,raw.propertyId]);
  if (binding.rowCount!==1) throw new Error("supplier bill replay evidence is invalid");
  return { ok: true, outcome: "replayed", item };
}
// prettier-ignore
function storedPair(value: unknown,raw:CreateFinanceSupplierBillCommand): FinanceSupplierBillPair|null {
  const result=record(value)&&known(value,["ok","outcome","item"])&&value["ok"]===true&&value["outcome"]==="created"&&record(value["item"])?value["item"]:null; const invoice=result&&record(result["invoice"])?result["invoice"]:null; const expense=result&&record(result["expense"])?result["expense"]:null;
  if(!result||!known(result,["invoice","expense"])||!invoice||!known(invoice,["id","number","supplierReference","dueOn","status","total","revision"])||invoice["id"]!==raw.commandId||typeof invoice["number"]!=="string"||!/^INV-\d{4,}$/.test(invoice["number"])||invoice["supplierReference"]!==raw.supplierReference||invoice["dueOn"]!==(raw.dueOn??null)||invoice["status"]!=="draft"||!money(invoice["total"],false)||invoice["total"].amount!==raw.amount.amount||invoice["total"].currency!==raw.amount.currency||invoice["revision"]!==1||!expense||!known(expense,["id","categoryId","origin","incurredOn","paidOn","vendor","amount","paymentStatus","recurringRuleId","sourceKey","reversesExpenseId","revision"])||expense["id"]!==raw.expenseId||expense["categoryId"]!==raw.categoryId||expense["origin"]!=="supplier_bill"||expense["incurredOn"]!==raw.incurredOn||expense["paidOn"]!==(raw.paidOn??null)||expense["vendor"]!==raw.vendor||!money(expense["amount"],false)||expense["amount"].amount!==raw.amount.amount||expense["amount"].currency!==raw.amount.currency||expense["paymentStatus"]!==raw.paymentStatus||expense["recurringRuleId"]!==null||expense["sourceKey"]!==`supplier_invoice:${raw.commandId}`||expense["reversesExpenseId"]!==null||expense["revision"]!==1)return null;
  return {invoice,expense} as FinanceSupplierBillPair;
}
// prettier-ignore
function resultHash(item: FinanceSupplierBillPair): string { const i=item.invoice,e=item.expense; return hash(JSON.stringify([i.id,i.number,i.supplierReference,i.dueOn,i.status,i.total.amount,i.total.currency,i.revision,e.id,e.categoryId,e.origin,e.incurredOn,e.paidOn,e.vendor,e.amount.amount,e.amount.currency,e.paymentStatus,e.recurringRuleId,e.sourceKey,e.reversesExpenseId,e.revision])); }
// prettier-ignore
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
// prettier-ignore
function utc(value: unknown): value is string { return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value)); }
// prettier-ignore
function trimmed(value: unknown,min:number,max:number): value is string { return typeof value === "string" && value===value.trim() && value.length>=min && value.length<=max; }
// prettier-ignore
function record(value: unknown): value is Record<string,unknown> { return value!==null && typeof value==="object" && !Array.isArray(value); }
// prettier-ignore
function known(value: object,allowed:readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
// prettier-ignore
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
// prettier-ignore
function constraint(value: unknown): unknown { return (value as { constraint?: unknown } | null)?.constraint; }
// prettier-ignore
async function stop<T>(client: pg.PoolClient,result:T): Promise<T> { await client.query("ROLLBACK"); return result; }
// prettier-ignore
async function rollback(client: pg.PoolClient): Promise<void> { try { await client.query("ROLLBACK"); } catch {} }
