import { createHash } from "node:crypto";

// prettier-ignore
import { parseFinanceExpenseWrite, type FinanceCommandAudit, type FinanceExpense,
  type FinanceExpenseCommandResult, type FinanceExpenseWrite } from "@vayada/domain-finance";
import pg from "pg";

// prettier-ignore
export type CreateFinanceManualExpenseCommand = Omit<FinanceExpenseWrite,
  "expectedRevision" | "supplierInvoiceNumber" | "recurrence"> &
  { propertyId: string; receiptMediaId?: string; audit: FinanceCommandAudit };
export type CreateFinanceManualExpenseResult = FinanceExpenseCommandResult<FinanceExpense>;

// prettier-ignore
type IdempotencyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };
const OPERATION = "finance.manual_expense.create";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const COLUMNS = `id::text, category_id::text AS "categoryId", origin, incurred_on::text AS "incurredOn",
  paid_on::text AS "paidOn", vendor, jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,
  payment_status AS "paymentStatus", recurring_rule_id::text AS "recurringRuleId", source_key AS "sourceKey",
  reverses_expense_id::text AS "reversesExpenseId", revision::int`;

export function createPgFinanceManualExpenseRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    async create(
      raw: CreateFinanceManualExpenseCommand,
    ): Promise<CreateFinanceManualExpenseResult> {
      if (!valid(raw)) return { ok: false, code: "invalid_command" };
      const acceptedAt = new Date().toISOString();
      const keyHash = hash(raw.idempotencyKey);
      const fingerprint = commandFingerprint(raw);
      const lockKey = `${OPERATION}|${raw.propertyId.toLowerCase()}|${keyHash}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE",
          [raw.propertyId],
        );
        if (property.rowCount !== 1) return await stop(client, { ok: false, code: "not_found" });
        const existing = await client.query<IdempotencyRow>(
          `SELECT status,request_fingerprint_hash AS fingerprint,
                  response_body_hash AS "responseHash",idempotency_metadata AS metadata
           FROM platform.idempotency_keys
           WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
             AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
          [OPERATION, keyHash, raw.propertyId],
        );
        if (existing.rows[0]) return await stop(client, replay(existing.rows[0], fingerprint));
        const reserved = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope,operation,key_hash,request_fingerprint_hash,status,
              tenant_scope,property_id,correlation_id,expires_at)
           VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
           ON CONFLICT DO NOTHING RETURNING id::text`,
          // prettier-ignore
          [OPERATION, keyHash, fingerprint, raw.propertyId, raw.audit.correlationId ?? raw.audit.requestId],
        );
        if (!reserved.rows[0])
          return await stop(client, { ok: false, code: "idempotency_conflict" });

        const category = await client.query<{ archivedAt: unknown; receiptActive: boolean }>(
          `SELECT archived_at AS "archivedAt",$3::uuid IS NULL OR COALESCE((
             SELECT lifecycle_status='active' FROM platform.media_objects
             WHERE id=$3::uuid AND property_id=$2::uuid AND purpose='finance.expense.receipt' AND resource_product='finance' AND resource_type='expense' AND resource_id=$4::uuid::text FOR SHARE),FALSE) AS "receiptActive"
           FROM finance.expense_categories
           WHERE id=$1::uuid AND property_id=$2::uuid`,
          [raw.categoryId, raw.propertyId, raw.receiptMediaId ?? null, raw.commandId],
        );
        // prettier-ignore
        if (!category.rows[0] || category.rows[0].archivedAt !== null || !category.rows[0].receiptActive)
          return await stop(client, { ok: false, code: "evidence_mismatch" });

        let inserted: pg.QueryResult<FinanceExpense>;
        try {
          inserted = await client.query<FinanceExpense>(
            `INSERT INTO finance.expenses
               (id,property_id,category_id,origin,incurred_on,vendor,amount,currency,
                payment_status,paid_on,notes,receipt_media_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,'manual',$4::date,$5,$6::numeric,
                     $7,$8,$9::date,$10,$11::uuid)
             RETURNING ${COLUMNS}`,
            // prettier-ignore
            [raw.commandId, raw.propertyId, raw.categoryId, raw.incurredOn, raw.vendor,
              raw.amount.amount, raw.amount.currency, raw.paymentStatus, raw.paidOn ?? null,
              raw.notes ?? null, raw.receiptMediaId ?? null],
          );
        } catch (error) {
          const name = constraint(error);
          if (name === "expenses_pkey")
            return await stop(client, { ok: false, code: "idempotency_conflict" });
          if (name === "fk_finance_expenses_pricing_currency")
            return await stop(client, { ok: false, code: "currency_mismatch" });
          if (name === "fk_finance_expenses_receipt")
            return await stop(client, { ok: false, code: "evidence_mismatch" });
          throw error;
        }
        const expense = inserted.rows[0]!;
        const result = { ok: true as const, outcome: "created" as const, item: expense };
        const actor = raw.audit.actor;
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
              actor_user_id,target_resource_product,target_resource_type,target_resource_id,
              idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
              audit_metadata,retention_class,privacy_scope)
           VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
                   'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,
                   jsonb_build_object('reason',$11::text),
                   jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
                   'financial','confidential')`,
          [
            `${OPERATION}.property.${raw.propertyId}.expense.${expense.id}.key.${keyHash}.v1`,
            OPERATION,
            acceptedAt,
            raw.propertyId,
            actor.kind === "user" ? actor.userId : null,
            expense.id,
            reserved.rows[0].id,
            raw.audit.correlationId ?? raw.audit.requestId,
            raw.audit.requestId,
            // prettier-ignore
            JSON.stringify({ commandId: raw.commandId, expenseId: expense.id, revision: expense.revision }),
            raw.audit.reason,
            raw.audit.requestedAt,
            actor.kind === "user" ? actor.organizationId : null,
          ],
        );
        const completed = await client.query(
          `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
             response_body_hash=$2,completed_at=$3::timestamptz,
             response_resource_product='finance',response_resource_type='expense',
             response_resource_id=$4,idempotency_metadata=jsonb_build_object('result',$5::jsonb)
           WHERE id=$1::uuid AND status='in_progress'`,
          // prettier-ignore
          [reserved.rows[0].id, resultHash(expense), acceptedAt, expense.id, JSON.stringify(result)],
        );
        if (completed.rowCount !== 1)
          throw new Error("manual expense idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function valid(command: CreateFinanceManualExpenseCommand): boolean {
  // prettier-ignore
  if (!exact(command, "commandId idempotencyKey propertyId categoryId incurredOn vendor amount paymentStatus paidOn notes receiptMediaId audit")) return false;
  const { propertyId, receiptMediaId, audit, ...write } = command;
  const actor = audit?.actor;
  return !(
    !parseFinanceExpenseWrite(write) ||
    !exact(audit, "actor requestId correlationId reason requestedAt") ||
    !exact(actor, "kind userId organizationId") ||
    !uuid(propertyId) ||
    (receiptMediaId !== undefined && !uuid(receiptMediaId)) ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(audit.requestId, 1, 200) ||
    (audit.correlationId !== undefined && !trimmed(audit.correlationId, 1, 200)) ||
    !trimmed(audit.reason, 1, 500) ||
    !utc(audit.requestedAt)
  );
}
function replay(row: IdempotencyRow, fingerprint: string): CreateFinanceManualExpenseResult {
  if (row.fingerprint !== fingerprint) return { ok: false, code: "idempotency_conflict" };
  if (row.status !== "completed") return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const item =
    exact(stored, "ok outcome item") && stored["ok"] === true && stored["outcome"] === "created"
      ? stored["item"]
      : null;
  const parsed = storedExpense(item);
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("manual expense replay evidence is invalid");
  return { ok: true, outcome: "replayed", item: parsed };
}
function storedExpense(value: unknown): FinanceExpense | null {
  if (
    !exact(
      value,
      "id categoryId origin incurredOn paidOn vendor amount paymentStatus recurringRuleId sourceKey reversesExpenseId revision",
    ) ||
    value.origin !== "manual" ||
    value.recurringRuleId !== null ||
    value.sourceKey !== null ||
    value.reversesExpenseId !== null ||
    value.revision !== 1
  )
    return null;
  const write = parseFinanceExpenseWrite({
    commandId: value.id,
    idempotencyKey: "replay",
    categoryId: value.categoryId,
    incurredOn: value.incurredOn,
    vendor: value.vendor,
    amount: value.amount,
    paymentStatus: value.paymentStatus,
    paidOn: value.paidOn,
  });
  return write ? (value as FinanceExpense) : null;
}
function resultHash(value: FinanceExpense): string {
  return hash(JSON.stringify(value, [...Object.keys(value), "amount", "currency"].sort()));
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
// prettier-ignore
function commandFingerprint(raw: CreateFinanceManualExpenseCommand): string { return hash(JSON.stringify([
  raw.commandId, raw.categoryId, raw.incurredOn, raw.vendor, raw.amount.amount, raw.amount.currency,
  raw.paymentStatus, raw.paidOn ?? null, raw.notes ?? null, raw.receiptMediaId ?? null])); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, allowed: string): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.split(" ").includes(key));
}
function constraint(value: unknown): unknown {
  return (value as { constraint?: unknown } | null)?.constraint;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function trimmed(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  return value === value.trim() && value.length >= min && value.length <= max;
}
function utc(value: unknown): value is string {
  if (typeof value !== "string" || value.startsWith("0000-") || !UTC.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
async function stop<T>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}
async function rollback(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {}
}
