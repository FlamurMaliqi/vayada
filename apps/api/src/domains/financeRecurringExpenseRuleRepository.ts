import { createHash } from "node:crypto";

import {
  FINANCE_EXPENSE_CADENCES,
  FINANCE_EXPENSE_PAYMENT_STATUSES,
  normalizeFinanceExpenseAmount,
  type FinanceCommandAudit,
  type FinanceExpenseCadence,
  type FinanceExpenseCommandResult,
  type FinanceExpenseMoney,
  type FinanceExpensePaymentStatus,
  type FinanceRecurringExpenseRule,
} from "@vayada/domain-finance";
import pg from "pg";

// prettier-ignore
type Base = { commandId: string; idempotencyKey: string; propertyId: string; audit: FinanceCommandAudit };
// prettier-ignore
type Template = { categoryId: string; cadence: FinanceExpenseCadence; startsOn: string; endsOn?: string; vendor: string; amount: FinanceExpenseMoney; paymentStatus: FinanceExpensePaymentStatus; notes?: string };
export type CreateFinanceRecurringExpenseRuleCommand = Base & Template;
// prettier-ignore
export type UpdateFinanceRecurringExpenseRuleCommand = Base & { ruleId: string; expectedRevision: number; cadence?: FinanceExpenseCadence; nextDueOn?: string; endsOn?: string };
// prettier-ignore
export type DisableFinanceRecurringExpenseRuleCommand = Base & { ruleId: string; expectedRevision: number };
export type FinanceRecurringExpenseRuleCommandResult =
  FinanceExpenseCommandResult<FinanceRecurringExpenseRule>;
// prettier-ignore
type Command = (CreateFinanceRecurringExpenseRuleCommand & { action: "create" }) | (UpdateFinanceRecurringExpenseRuleCommand & { action: "update" }) | (DisableFinanceRecurringExpenseRuleCommand & { action: "disable" });
// prettier-ignore
type RuleRow = FinanceRecurringExpenseRule & { categoryId: string; startsOn: string; vendor: string; amount: FinanceExpenseMoney; paymentStatus: FinanceExpensePaymentStatus; notes: string | null };
// prettier-ignore
type KeyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// prettier-ignore
const COMMAND_KEYS = { create: ["action","commandId","idempotencyKey","propertyId","audit","categoryId","cadence","startsOn","endsOn","vendor","amount","paymentStatus","notes"], update: ["action","commandId","idempotencyKey","propertyId","audit","ruleId","expectedRevision","cadence","nextDueOn","endsOn"], disable: ["action","commandId","idempotencyKey","propertyId","audit","ruleId","expectedRevision"] } as const;
const COLUMNS = `id::text,cadence,starts_on::text AS "startsOn",next_due_on::text AS "nextDueOn",
  ends_on::text AS "endsOn",active,revision::int,category_id::text AS "categoryId",vendor,
  jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,
  payment_status AS "paymentStatus",notes`;

// prettier-ignore
export function createPgFinanceRecurringExpenseRuleRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    create: (raw: CreateFinanceRecurringExpenseRuleCommand) => execute(pool, { ...raw, action: "create" }),
    update: (raw: UpdateFinanceRecurringExpenseRuleCommand) => execute(pool, { ...raw, action: "update" }),
    disable: (raw: DisableFinanceRecurringExpenseRuleCommand) => execute(pool, { ...raw, action: "disable" }),
    close: () => pool.end(),
  };
}

// prettier-ignore
async function execute(pool: pg.Pool, raw: Command): Promise<FinanceRecurringExpenseRuleCommandResult> {
  if (!valid(raw)) return { ok: false, code: "invalid_command" };
  const operation = `finance.recurring_expense_rule.${raw.action}`;
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  const requestHash = fingerprint(raw);
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
      [operation, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return stop(client, replay(existing.rows[0], requestHash));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
          property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [operation, keyHash, requestHash, raw.propertyId, raw.audit.correlationId ?? raw.audit.requestId],
    );
    const reservationId = reserved.rows[0]?.id;
    if (!reservationId) return stop(client, { ok: false, code: "idempotency_conflict" });
    let previous: RuleRow | null = null;
    let next: RuleRow;
    try {
      if (raw.action === "create") {
        const inserted = await client.query<RuleRow>(
          `INSERT INTO finance.recurring_expense_rules
             (id,property_id,category_id,cadence,starts_on,next_due_on,ends_on,vendor,
              amount,currency,payment_status,notes)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$5::date,$6::date,$7,
                   $8::numeric,$9,$10,$11) RETURNING ${COLUMNS}`,
          [raw.commandId, raw.propertyId, raw.categoryId, raw.cadence, raw.startsOn, raw.endsOn ?? null, raw.vendor, raw.amount.amount, raw.amount.currency, raw.paymentStatus, raw.notes ?? null],
        );
        next = inserted.rows[0]!;
      } else {
        const found = await client.query<RuleRow>(
          `SELECT ${COLUMNS} FROM finance.recurring_expense_rules
           WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
          [raw.ruleId, raw.propertyId],
        );
        previous = found.rows[0] ?? null;
        if (!previous) return stop(client, { ok: false, code: "not_found" });
        if (previous.revision !== raw.expectedRevision || !previous.active || previous.revision === 2_147_483_647) return stop(client, { ok: false, code: "revision_conflict" });
        const cadence = raw.action === "update" ? (raw.cadence ?? previous.cadence) : previous.cadence;
        const nextDue = raw.action === "update" ? (raw.nextDueOn ?? previous.nextDueOn) : previous.nextDueOn;
        const ends = raw.action === "update" ? (raw.endsOn ?? previous.endsOn) : previous.endsOn;
        if (!schedule(previous.startsOn, nextDue, ends)) return stop(client, { ok: false, code: "invalid_command" });
        const updated = await client.query<RuleRow>(
          `UPDATE finance.recurring_expense_rules SET cadence=$3,next_due_on=$4::date,
             ends_on=$5::date,active=$6,revision=revision+1,updated_at=$7::timestamptz
           WHERE id=$1::uuid AND property_id=$2::uuid AND revision=$8 RETURNING ${COLUMNS}`,
          [raw.ruleId, raw.propertyId, cadence, nextDue, ends, raw.action === "update", acceptedAt, raw.expectedRevision],
        );
        if (!updated.rows[0]) return stop(client, { ok: false, code: "revision_conflict" });
        next = updated.rows[0];
      }
    } catch (error) {
      const name = constraint(error);
      if (name === "recurring_expense_rules_pkey") return stop(client, { ok: false, code: "idempotency_conflict" });
      if (name === "fk_finance_recurring_expense_rules_pricing_currency") return stop(client, { ok: false, code: "currency_mismatch" });
      if (["fk_finance_recurring_expense_rules_category_property", "fk_finance_recurring_expense_rules_active_category"].includes(String(name))) return stop(client, { ok: false, code: "evidence_mismatch" });
      if (name === "chk_finance_recurring_expense_rules_dates") return stop(client, { ok: false, code: "invalid_command" });
      throw error;
    }
    const item = view(next);
    const result = {
      ok: true as const,
      outcome: raw.action === "create" ? ("created" as const) : ("updated" as const),
      item,
    };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
          target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,
          correlation_id,causation_id,redacted_payload,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','recurring_expense_rule',$6,$7::uuid,$8,$9,$10::jsonb,'financial','confidential')`,
      [
        `${operation}.property.${raw.propertyId}.rule.${item.id}.key.${keyHash}.v1`,
        operation,
        acceptedAt,
        raw.propertyId,
        actor.kind === "user" ? actor.userId : null,
        item.id,
        reservationId,
        raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId,
        JSON.stringify({
          commandId: raw.commandId,
          outcome: result.outcome,
          previous,
          next,
          actorOrganizationId: actor.kind === "user" ? actor.organizationId : null,
          requestedAt: raw.audit.requestedAt,
          reason: raw.audit.reason,
        }),
      ],
    );
    const completed = await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
         response_body_hash=$2,completed_at=$3::timestamptz,response_resource_product='finance',
         response_resource_type='recurring_expense_rule',response_resource_id=$4,
         idempotency_metadata=jsonb_build_object('result',$5::jsonb)
       WHERE id=$1::uuid AND status='in_progress'`,
      [reservationId, resultHash(item), acceptedAt, item.id, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) throw new Error("recurring expense rule idempotency completion failed");
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
function valid(raw: Command): boolean {
  const audit = raw.audit;
  const actor = audit?.actor;
  const base = known(raw, COMMAND_KEYS[raw.action]) && uuid(raw.commandId) && trimmed(raw.idempotencyKey, 1, 200) && uuid(raw.propertyId) && actor?.kind === "user" && uuid(actor.userId) && uuid(actor.organizationId) && trimmed(audit.requestId, 1, 200) && (audit.correlationId === undefined || trimmed(audit.correlationId, 1, 200)) && trimmed(audit.reason, 1, 500) && utc(audit.requestedAt);
  if (!base) return false;
  if (raw.action === "create") return uuid(raw.categoryId) && FINANCE_EXPENSE_CADENCES.includes(raw.cadence) && (raw.endsOn === undefined || date(raw.endsOn)) && schedule(raw.startsOn, raw.startsOn, raw.endsOn ?? null) && trimmed(raw.vendor, 1, 200) && money(raw.amount) && FINANCE_EXPENSE_PAYMENT_STATUSES.includes(raw.paymentStatus) && (raw.notes === undefined || trimmed(raw.notes, 1, 2000));
  if (!uuid(raw.ruleId) || !revision(raw.expectedRevision)) return false;
  if (raw.action === "disable") return true;
  return (["cadence", "nextDueOn", "endsOn"] as const).some((key) => raw[key] !== undefined) && (raw.cadence === undefined || FINANCE_EXPENSE_CADENCES.includes(raw.cadence)) && (raw.nextDueOn === undefined || date(raw.nextDueOn)) && (raw.endsOn === undefined || date(raw.endsOn));
}
// prettier-ignore
function fingerprint(raw: Command): string {
  return hash(JSON.stringify(raw.action === "create" ? [raw.commandId, raw.categoryId, raw.cadence, raw.startsOn, raw.endsOn ?? null, raw.vendor, raw.amount.amount, raw.amount.currency, raw.paymentStatus, raw.notes ?? null] : [raw.commandId, raw.ruleId, raw.expectedRevision, raw.action === "update" ? (raw.cadence ?? "__absent__") : null, raw.action === "update" ? (raw.nextDueOn ?? "__absent__") : null, raw.action === "update" ? (raw.endsOn ?? "__absent__") : null]));
}
// prettier-ignore
function replay(row: KeyRow, requestHash: string): FinanceRecurringExpenseRuleCommandResult {
  if (row.fingerprint !== requestHash || row.status !== "completed") return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const item = record(stored) && record(stored["item"]) ? (stored["item"] as FinanceRecurringExpenseRule) : null;
  if (!item || row.responseHash !== resultHash(item)) throw new Error("recurring expense rule replay evidence is invalid");
  return { ok: true, outcome: "replayed", item };
}
function view(row: RuleRow): FinanceRecurringExpenseRule {
  return {
    id: row.id,
    cadence: row.cadence,
    nextDueOn: row.nextDueOn,
    endsOn: row.endsOn,
    active: row.active,
    revision: row.revision,
  };
}
// prettier-ignore
function resultHash(item: FinanceRecurringExpenseRule): string {
  return hash(JSON.stringify([item.id, item.cadence, item.nextDueOn, item.endsOn, item.active, item.revision]));
}
// prettier-ignore
function schedule(starts: unknown, next: unknown, ends: unknown): boolean {
  return date(starts) && date(next) && next >= starts && (ends === null || (date(ends) && ends >= starts && next <= ends));
}
// prettier-ignore
function money(value: unknown): value is FinanceExpenseMoney {
  if (!record(value) || Object.keys(value).sort().join() !== "amount,currency" || typeof value.amount !== "string") return false;
  return normalizeFinanceExpenseAmount(value.amount) === value.amount && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function utc(value: unknown): value is string {
  return typeof value === "string" && UTC.test(value) && !Number.isNaN(Date.parse(value));
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// prettier-ignore
function known(value: object, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function constraint(value: unknown): unknown {
  return (value as { constraint?: unknown } | null)?.constraint;
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
