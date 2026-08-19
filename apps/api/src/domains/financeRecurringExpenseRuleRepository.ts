import { createHash } from "node:crypto";

// prettier-ignore
import { FINANCE_EXPENSE_CADENCES, FINANCE_EXPENSE_PAYMENT_STATUSES,
  normalizeFinanceExpenseAmount, type FinanceCommandAudit, type FinanceExpenseCadence,
  type FinanceExpenseCommandResult, type FinanceExpenseMoney,
  type FinanceExpensePaymentStatus, type FinanceRecurringExpenseRule } from "@vayada/domain-finance";
import pg from "pg";

// prettier-ignore
type Base = { commandId: string; idempotencyKey: string; propertyId: string; audit: FinanceCommandAudit };
// prettier-ignore
type Template = { categoryId: string; cadence: FinanceExpenseCadence; startsOn: string;
  endsOn?: string; vendor: string; amount: FinanceExpenseMoney;
  paymentStatus: FinanceExpensePaymentStatus; notes?: string };
export type CreateFinanceRecurringExpenseRuleCommand = Base & Template;
// prettier-ignore
export type UpdateFinanceRecurringExpenseRuleCommand = Base & { ruleId: string; expectedRevision: number;
  categoryId?: string; cadence?: FinanceExpenseCadence; nextDueOn?: string; endsOn?: string | null;
  vendor?: string; amount?: FinanceExpenseMoney; paymentStatus?: FinanceExpensePaymentStatus;
  notes?: string | null };
// prettier-ignore
export type DisableFinanceRecurringExpenseRuleCommand = Base & { ruleId: string; expectedRevision: number };
export type FinanceRecurringExpenseRuleCommandResult =
  FinanceExpenseCommandResult<FinanceRecurringExpenseRule>;
// prettier-ignore
type Command = (CreateFinanceRecurringExpenseRuleCommand & { action: "create" }) |
  (UpdateFinanceRecurringExpenseRuleCommand & { action: "update" }) |
  (DisableFinanceRecurringExpenseRuleCommand & { action: "disable" });
type RuleRow = FinanceRecurringExpenseRule & { notes: string | null };
// prettier-ignore
type KeyRow = { status: string; fingerprint: string; responseHash: string | null;
  metadata: unknown; resourceProduct: string | null; resourceType: string | null; resourceId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// prettier-ignore
const KEYS = { create: "action commandId idempotencyKey propertyId audit categoryId cadence startsOn endsOn vendor amount paymentStatus notes", update: "action commandId idempotencyKey propertyId audit ruleId expectedRevision categoryId cadence nextDueOn endsOn vendor amount paymentStatus notes", disable: "action commandId idempotencyKey propertyId audit ruleId expectedRevision" } as const;
// prettier-ignore
const PATCH = ["categoryId", "cadence", "nextDueOn", "endsOn", "vendor", "amount", "paymentStatus", "notes"] as const;
const RESOURCE_LOCK = "finance.recurring_expense_rule";
const COLUMNS = `id::text,category_id::text AS "categoryId",vendor,
  jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,notes,
  payment_status AS "paymentStatus",cadence,starts_on::text AS "startsOn",
  next_due_on::text AS "nextDueOn",ends_on::text AS "endsOn",active,revision::int`;

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
  const propertyId = raw.propertyId.toLowerCase();
  const operation = `finance.recurring_expense_rule.${raw.action}`;
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  const requestHash = fingerprint(raw);
  const resourceId = (raw.action === "create" ? raw.commandId : raw.ruleId).toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${operation}|${propertyId}|${keyHash}`]);
    const property = await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE", [propertyId]);
    if (property.rowCount !== 1) return await stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<KeyRow>(
      `SELECT status,request_fingerprint_hash AS fingerprint,response_body_hash AS "responseHash",
              idempotency_metadata AS metadata,response_resource_product AS "resourceProduct",
              response_resource_type AS "resourceType",response_resource_id AS "resourceId"
       FROM platform.idempotency_keys WHERE operation_scope='finance' AND operation=$1
         AND key_hash=$2 AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [operation, keyHash, propertyId],
    );
    if (existing.rows[0]) return await stop(client, replay(existing.rows[0], requestHash, resourceId, raw.action, raw.action === "create" ? null : raw.expectedRevision));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
          property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [operation, keyHash, requestHash, propertyId, raw.audit.correlationId ?? raw.audit.requestId],
    );
    const reservationId = reserved.rows[0]?.id;
    if (!reservationId) return await stop(client, { ok: false, code: "idempotency_conflict" });
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
          [resourceId, propertyId, raw.categoryId.toLowerCase(), raw.cadence, raw.startsOn, raw.endsOn ?? null, raw.vendor, raw.amount.amount, raw.amount.currency, raw.paymentStatus, raw.notes ?? null],
        );
        next = inserted.rows[0]!;
      } else {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${RESOURCE_LOCK}|${propertyId}|${resourceId}`]);
        const found = await client.query<RuleRow>(`SELECT ${COLUMNS} FROM finance.recurring_expense_rules WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`, [resourceId, propertyId]);
        previous = found.rows[0] ?? null;
        if (!previous) return await stop(client, { ok: false, code: "not_found" });
        if (previous.revision !== raw.expectedRevision || !previous.active || previous.revision === 2_147_483_647)
          return await stop(client, { ok: false, code: "revision_conflict" });
        const patch = raw.action === "update" ? raw : {};
        const merged = {
          categoryId: own(patch, "categoryId") ? raw.action === "update" && raw.categoryId!.toLowerCase() : previous.categoryId,
          cadence: own(patch, "cadence") && raw.action === "update" ? raw.cadence! : previous.cadence,
          nextDueOn: own(patch, "nextDueOn") && raw.action === "update" ? raw.nextDueOn! : previous.nextDueOn,
          endsOn: own(patch, "endsOn") && raw.action === "update" ? raw.endsOn! : previous.endsOn,
          vendor: own(patch, "vendor") && raw.action === "update" ? raw.vendor! : previous.vendor,
          amount: own(patch, "amount") && raw.action === "update" ? raw.amount! : previous.amount,
          paymentStatus: own(patch, "paymentStatus") && raw.action === "update" ? raw.paymentStatus! : previous.paymentStatus,
          notes: own(patch, "notes") && raw.action === "update" ? raw.notes! : previous.notes,
        };
        if (!schedule(previous.startsOn, merged.nextDueOn, merged.endsOn))
          return await stop(client, { ok: false, code: "invalid_command" });
        const updated = await client.query<RuleRow>(
          `UPDATE finance.recurring_expense_rules SET category_id=$3::uuid,cadence=$4,
             next_due_on=$5::date,ends_on=$6::date,vendor=$7,amount=$8::numeric,currency=$9,
             payment_status=$10,notes=$11,active=$12,revision=revision+1,updated_at=$13::timestamptz
           WHERE id=$1::uuid AND property_id=$2::uuid RETURNING ${COLUMNS}`,
          [resourceId, propertyId, merged.categoryId, merged.cadence, merged.nextDueOn, merged.endsOn, merged.vendor, merged.amount.amount, merged.amount.currency, merged.paymentStatus, merged.notes, raw.action === "update", acceptedAt],
        );
        next = updated.rows[0]!;
      }
    } catch (error) {
      const name = String(constraint(error));
      if (name === "recurring_expense_rules_pkey") return await stop(client, { ok: false, code: "idempotency_conflict" });
      if (name === "fk_finance_recurring_expense_rules_pricing_currency") return await stop(client, { ok: false, code: "currency_mismatch" });
      if (name === "fk_finance_recurring_expense_rules_category_property" || name === "fk_finance_recurring_expense_rules_active_category")
        return await stop(client, { ok: false, code: "evidence_mismatch" });
      if (name.startsWith("chk_finance_recurring_expense_rules_")) return await stop(client, { ok: false, code: "invalid_command" });
      throw error;
    }
    const item = view(next);
    const outcome = raw.action === "create" ? "created" as const : "updated" as const;
    const result = { ok: true as const, outcome, item };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
          target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,
          correlation_id,causation_id,redacted_payload,private_payload,audit_metadata,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','recurring_expense_rule',$6,$7::uuid,$8,$9,$10::jsonb,
               jsonb_build_object('reason',$11::text,'previous',$12::jsonb,'next',$13::jsonb),
               jsonb_build_object('requestId',$9::text,'requestedAt',$14::text,'actorOrganizationId',$15::text),
               'financial','confidential')`,
      [`${operation}.property.${propertyId}.rule.${item.id}.key.${keyHash}.v1`, operation, acceptedAt, propertyId,
        actor.kind === "user" ? actor.userId.toLowerCase() : null, item.id, reservationId,
        raw.audit.correlationId ?? raw.audit.requestId, raw.audit.requestId,
        JSON.stringify({ commandId: raw.commandId.toLowerCase(), ruleId: item.id, outcome, revision: item.revision, active: item.active }),
        raw.audit.reason, JSON.stringify(previous), JSON.stringify(next), raw.audit.requestedAt,
        actor.kind === "user" ? actor.organizationId.toLowerCase() : null],
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
    return ["55P03", "57014"].includes(String((error as { code?: unknown })?.code))
      ? { ok: false, code: "write_unavailable" }
      : Promise.reject(error);
  } finally { client.release(); }
}

// prettier-ignore
function valid(raw: Command): boolean {
  const audit = raw.audit; const actor = audit?.actor;
  const base = exact(raw, KEYS[raw.action]) && exact(audit, "actor requestId correlationId reason requestedAt") && exact(actor, "kind userId organizationId") && uuid(raw.commandId) && trimmed(raw.idempotencyKey, 1, 200) && uuid(raw.propertyId) && actor?.kind === "user" && uuid(actor.userId) && uuid(actor.organizationId) && trimmed(audit.requestId, 1, 200) && (audit.correlationId === undefined || trimmed(audit.correlationId, 1, 200)) && trimmed(audit.reason, 1, 500) && utc(audit.requestedAt);
  if (!base) return false;
  if (raw.action === "create") return uuid(raw.categoryId) && FINANCE_EXPENSE_CADENCES.includes(raw.cadence) && (raw.endsOn === undefined || date(raw.endsOn)) && schedule(raw.startsOn, raw.startsOn, raw.endsOn ?? null) && trimmed(raw.vendor, 1, 200) && money(raw.amount) && FINANCE_EXPENSE_PAYMENT_STATUSES.includes(raw.paymentStatus) && (raw.notes === undefined || trimmed(raw.notes, 1, 2000));
  if (!uuid(raw.ruleId) || !revision(raw.expectedRevision)) return false;
  if (raw.action === "disable") return true;
  return PATCH.some((key) => own(raw, key)) &&
    (!own(raw, "categoryId") || uuid(raw.categoryId)) && (!own(raw, "cadence") || FINANCE_EXPENSE_CADENCES.includes(raw.cadence!)) &&
    (!own(raw, "nextDueOn") || date(raw.nextDueOn)) && (!own(raw, "endsOn") || raw.endsOn === null || date(raw.endsOn)) &&
    (!own(raw, "vendor") || trimmed(raw.vendor, 1, 200)) && (!own(raw, "amount") || money(raw.amount)) &&
    (!own(raw, "paymentStatus") || FINANCE_EXPENSE_PAYMENT_STATUSES.includes(raw.paymentStatus!)) &&
    (!own(raw, "notes") || raw.notes === null || trimmed(raw.notes, 1, 2000));
}
// prettier-ignore
function fingerprint(raw: Command): string {
  if (raw.action === "create") return hash(JSON.stringify([raw.commandId.toLowerCase(),raw.categoryId.toLowerCase(),raw.cadence,raw.startsOn,raw.endsOn ?? null,raw.vendor,raw.amount.amount,raw.amount.currency,raw.paymentStatus,raw.notes ?? null]));
  const values = raw.action === "update" ? PATCH.map((key) => [own(raw, key), own(raw, key) ? key === "categoryId" ? raw.categoryId!.toLowerCase() : key === "amount" ? [raw.amount!.amount,raw.amount!.currency] : raw[key] : null]) : [];
  return hash(JSON.stringify([raw.commandId.toLowerCase(),raw.ruleId.toLowerCase(),raw.expectedRevision,values]));
}
// prettier-ignore
function replay(row: KeyRow, requestHash: string, resourceId: string, action: Command["action"], expectedRevision: number | null): FinanceRecurringExpenseRuleCommandResult {
  if (row.fingerprint !== requestHash || row.status !== "completed") return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const expected = action === "create" ? "created" : "updated";
  const item = exact(stored, "ok outcome item") && stored["ok"] === true && stored["outcome"] === expected ? parseItem(stored["item"]) : null;
  const validAction = action === "create" ? item?.active === true && item.revision === 1 && item.nextDueOn === item.startsOn : item?.active === (action === "update") && item.revision === expectedRevision! + 1;
  if (!item || !validAction || item.id !== resourceId || row.resourceProduct !== "finance" || row.resourceType !== "recurring_expense_rule" || row.resourceId !== resourceId || row.responseHash !== resultHash(item)) throw new Error("recurring expense rule replay evidence is invalid");
  return { ok: true, outcome: "replayed", item };
}
// prettier-ignore
function view(row: RuleRow): FinanceRecurringExpenseRule { const { notes, ...item } = row; return notes === null ? item : { ...item, notes }; }
// prettier-ignore
function parseItem(value: unknown): FinanceRecurringExpenseRule | null {
  if (!exact(value, "id categoryId vendor amount notes paymentStatus cadence startsOn nextDueOn endsOn active revision") || !["id","categoryId","vendor","amount","paymentStatus","cadence","startsOn","nextDueOn","endsOn","active","revision"].every((key) => own(value, key)) || !uuid(value.id) || !uuid(value.categoryId) || !trimmed(value.vendor,1,200) || !money(value.amount) || (value.notes !== undefined && !trimmed(value.notes,1,2000)) || !FINANCE_EXPENSE_PAYMENT_STATUSES.includes(value.paymentStatus as FinanceExpensePaymentStatus) || !FINANCE_EXPENSE_CADENCES.includes(value.cadence as FinanceExpenseCadence) || !schedule(value.startsOn,value.nextDueOn,value.endsOn) || typeof value.active !== "boolean" || !revision(value.revision)) return null;
  return value as FinanceRecurringExpenseRule;
}
// prettier-ignore
function resultHash(item: FinanceRecurringExpenseRule): string { return hash(JSON.stringify([item.id,item.categoryId,item.vendor,item.amount.amount,item.amount.currency,item.notes ?? null,item.paymentStatus,item.cadence,item.startsOn,item.nextDueOn,item.endsOn,item.active,item.revision])); }
// prettier-ignore
function schedule(starts: unknown, next: unknown, ends: unknown): boolean { return date(starts) && date(next) && next >= starts && (ends === null || (date(ends) && ends >= starts && next <= ends)); }
// prettier-ignore
function money(value: unknown): value is FinanceExpenseMoney { return exact(value,"amount currency") && own(value,"amount") && own(value,"currency") && typeof value.amount === "string" && normalizeFinanceExpenseAmount(value.amount) === value.amount && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency); }
// prettier-ignore
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
// prettier-ignore
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647; }
// prettier-ignore
function date(value: unknown): value is string { if (typeof value !== "string" || !DATE.test(value) || value.startsWith("0000-")) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value; }
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string" || value.startsWith("0000-") || !UTC.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,19) === value.slice(0,19); }
// prettier-ignore
function trimmed(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max; }
// prettier-ignore
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
// prettier-ignore
function exact(value: unknown, allowed: string): value is Record<string, unknown> { return record(value) && Object.keys(value).every((key) => allowed.split(" ").includes(key)); }
function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}
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
