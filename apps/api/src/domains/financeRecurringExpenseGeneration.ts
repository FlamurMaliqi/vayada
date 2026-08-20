import { createHash } from "node:crypto";

import {
  FINANCE_GENERATED_EXPENSE_SERVICE,
  parseFinanceGeneratedExpenseCommand,
  type FinanceExpenseCadence,
  type FinanceGeneratedExpenseAudit,
  type FinanceGeneratedExpenseCommand,
} from "@vayada/domain-finance";
import pg from "pg";

import { appendFinanceGeneratedExpense } from "./financeGeneratedExpenseRepository.js";

// prettier-ignore
export type FinanceRecurringGenerationCommand = { propertyId: string; propertyLocalAsOf: string; ruleLimit: number; catchUpLimit: number; audit: FinanceGeneratedExpenseAudit & { reasonCode: "scheduled_generation" } };
// prettier-ignore
export type FinanceRecurringGenerationFailureCode = Extract<Awaited<ReturnType<typeof appendFinanceGeneratedExpense>>,{ok:false}>["code"] | "revision_conflict" | "cadence_exhausted" | "write_failed";
export type FinanceRecurringGenerationOccurrence = {
  ruleId: string;
  occurrenceOn: string;
} & (
  | { outcome: "generated" | "replayed"; expenseId: string }
  | { outcome: "skipped"; reason: "ineligible" | "missing_evidence" }
  | { outcome: "failed"; code: FinanceRecurringGenerationFailureCode }
);
export type FinanceRecurringGenerationResult =
  | { ok: true; occurrences: FinanceRecurringGenerationOccurrence[] }
  | { ok: false; code: "invalid_command" | "property_not_found" | "write_unavailable" };

type Rule = {
  id: string;
  categoryId: string;
  cadence: FinanceExpenseCadence;
  startsOn: string;
  nextDueOn: string;
  endsOn: string | null;
  vendor: string;
  description: string | null;
  amount: string;
  currency: string;
  paymentStatus: "paid" | "unpaid";
  revision: number;
};

export function createPgFinanceRecurringExpenseGenerator(
  connectionString: string,
  clock: () => Date = () => new Date(),
) {
  const pool = new pg.Pool({ connectionString });
  return {
    // prettier-ignore
    run: async (command: FinanceRecurringGenerationCommand) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await appendFinanceRecurringExpenseGeneration(client, command, clock);
        await client.query(result.ok ? "COMMIT" : "ROLLBACK"); return result;
      } catch (error) {
        await rollback(client); return transient(error) ? { ok: false as const, code: "write_unavailable" as const } : Promise.reject(error);
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

// prettier-ignore
export async function appendFinanceRecurringExpenseGeneration(client: pg.PoolClient,raw: FinanceRecurringGenerationCommand,clock: () => Date = () => new Date()): Promise<FinanceRecurringGenerationResult> {
  if (!valid(raw)) return { ok: false, code: "invalid_command" };
  const prior=(await client.query<{lock:string;statement:string}>("SELECT current_setting('lock_timeout') lock,current_setting('statement_timeout') statement")).rows[0]!;
  await client.query("SELECT set_config('lock_timeout',CASE WHEN current_setting('lock_timeout')='0' OR current_setting('lock_timeout')::interval>interval '3 seconds' THEN '3s' ELSE current_setting('lock_timeout') END,true),set_config('statement_timeout',CASE WHEN current_setting('statement_timeout')='0' OR current_setting('statement_timeout')::interval>interval '30 seconds' THEN '30s' ELSE current_setting('statement_timeout') END,true)");
  try { const propertyId = raw.propertyId.toLowerCase();
  if ((await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE", [propertyId])).rowCount !== 1)
    return { ok: false, code: "property_not_found" };
    const rules = await client.query<Rule>(
      `SELECT id::text,category_id::text AS "categoryId",cadence,starts_on::text AS "startsOn",
        next_due_on::text AS "nextDueOn",ends_on::text AS "endsOn",vendor,description,
        amount::text,currency::text,payment_status AS "paymentStatus",revision::int
       FROM finance.recurring_expense_rules
       WHERE property_id=$1::uuid AND active AND next_due_on<=$2::date
       ORDER BY next_due_on,id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [propertyId, raw.propertyLocalAsOf, raw.ruleLimit],
    );
    const occurrences: FinanceRecurringGenerationOccurrence[] = [];
    for (const rule of rules.rows) {
      for (let count = 0; count < raw.catchUpLimit && rule.nextDueOn <= raw.propertyLocalAsOf; count++) {
        const occurrenceOn = rule.nextDueOn;
        const next = nextOccurrence(rule.cadence, rule.startsOn, occurrenceOn);
        if (rule.revision >= 2_147_483_647) { occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: "failed", code: "revision_conflict" }); break; }
        if (!next) { occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: "failed", code: "cadence_exhausted" }); break; }
        await client.query("SAVEPOINT finance_recurring_occurrence");
        try {
          const command = expenseCommand(propertyId, rule, occurrenceOn, raw.audit);
          if (!command) throw new Error("invalid_command");
          const result = await appendFinanceGeneratedExpense(client, command, clock);
          if (!result.ok) {
            await restore(client);
            occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: "failed", code: result.code });
            break;
          }
          if (result.outcome !== "created" && result.outcome !== "replayed") {
            await restore(client);
            occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: "skipped", reason: result.outcome === "missing_evidence" ? "missing_evidence" : "ineligible" });
            break;
          }
          const active = rule.endsOn === null || next <= rule.endsOn;
          const advanced = await client.query(
            `UPDATE finance.recurring_expense_rules SET next_due_on=$5::date,active=$6,
               revision=revision+1,updated_at=$7::timestamptz
             WHERE id=$1::uuid AND property_id=$2::uuid AND revision=$3 AND active AND next_due_on=$4::date`,
            [rule.id, propertyId, rule.revision, occurrenceOn, active ? next : occurrenceOn, active, clock().toISOString()],
          );
          if (advanced.rowCount !== 1) throw new Error("revision_conflict");
          await client.query("RELEASE SAVEPOINT finance_recurring_occurrence");
          occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: result.outcome === "created" ? "generated" : "replayed", expenseId: result.expenseId });
          rule.nextDueOn = active ? next : occurrenceOn;
          rule.revision++;
          if (!active) break;
        } catch (error) {
          await restore(client);
          occurrences.push({ ruleId: rule.id, occurrenceOn, outcome: "failed", code: transient(error) ? "write_unavailable" : message(error) });
          break;
        }
      }
    }
  return { ok: true, occurrences };
  } finally { await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",[prior.lock,prior.statement]).catch((error)=>{if(String((error as {code?:unknown}|null)?.code)!=="25P02")throw error;}); }
}

// prettier-ignore
function expenseCommand(propertyId: string, rule: Rule, occurrenceOn: string, audit: FinanceGeneratedExpenseAudit): FinanceGeneratedExpenseCommand | null {
  return parseFinanceGeneratedExpenseCommand({ commandId: stableUuid(`recurring_rule:${rule.id}:occurrence:${occurrenceOn}`), propertyId,
    categoryId: rule.categoryId, origin: "recurring", action: "create", incurredOn: occurrenceOn,
    vendor: rule.vendor, description: rule.description, amount: { amount: rule.amount, currency: rule.currency },
    paymentStatus: rule.paymentStatus, paidOn: rule.paymentStatus === "paid" ? occurrenceOn : null,
    reversesExpenseId: null, source: { kind: "recurring", recurringRuleId: rule.id, ruleRevision: rule.revision, occurrenceOn }, audit });
}

// prettier-ignore
function nextOccurrence(cadence: FinanceExpenseCadence, startsOn: string, occurrenceOn: string): string | null {
  const [year, month, day] = occurrenceOn.split("-").map(Number) as [number, number, number];
  const [, startMonth, startDay] = startsOn.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  switch (cadence) {
    case "weekly": date.setUTCFullYear(year, month - 1, day + 7); break;
    case "monthly": date.setUTCFullYear(year, month, Math.min(startDay, days(year + Number(month === 12), month === 12 ? 1 : month + 1))); break;
    case "yearly": date.setUTCFullYear(year + 1, startMonth - 1, Math.min(startDay, days(year + 1, startMonth))); break;
    default: { const exhaustive: never = cadence; throw new Error(`unsupported cadence: ${exhaustive}`); } }
  const next = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return date.getUTCFullYear() <= 9_999 && next > occurrenceOn ? next : null;
}
// prettier-ignore
function days(year: number, month: number): number { const date = new Date(0); date.setUTCFullYear(year, month, 0); return date.getUTCDate(); }
// prettier-ignore
function stableUuid(value: string): string { const bytes = createHash("sha256").update(value).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
// prettier-ignore
function valid(value: FinanceRecurringGenerationCommand): boolean { const audit = value?.audit; return exact(value, ["propertyId","propertyLocalAsOf","ruleLimit","catchUpLimit","audit"]) && uuid(value.propertyId) && date(value.propertyLocalAsOf) && integer(value.ruleLimit, 50) && integer(value.catchUpLimit, 24) && exact(audit, ["actor","requestId","correlationId","causationId","jobId","jobAttemptId","reasonCode","requestedAt"]) && exact(audit.actor, ["kind","service"]) && audit.actor.kind === "system" && audit.actor.service === FINANCE_GENERATED_EXPENSE_SERVICE && text(audit.requestId) && text(audit.correlationId) && uuid(audit.causationId) && uuid(audit.jobId) && uuid(audit.jobAttemptId) && new Set([audit.causationId.toLowerCase(),audit.jobId.toLowerCase(),audit.jobAttemptId.toLowerCase()]).size === 3 && audit.reasonCode === "scheduled_generation" && utc(audit.requestedAt); }
// prettier-ignore
function exact(value: unknown, keys: readonly string[]): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
// prettier-ignore
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
// prettier-ignore
function date(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; const parsed=new Date(value); return Number.isFinite(parsed.getTime())&&parsed.toISOString() === value; }
// prettier-ignore
function integer(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max; }
// prettier-ignore
function text(value: unknown): value is string { return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 200; }
// prettier-ignore
function transient(error: unknown): boolean { return ["55P03", "57014", "40001", "40P01"].includes(String((error as { code?: unknown } | null)?.code)); }
// prettier-ignore
function message(error: unknown): FinanceRecurringGenerationFailureCode { const value=error instanceof Error?error.message:""; return value==="invalid_command"||value==="revision_conflict"?value:"write_failed"; }
// prettier-ignore
async function restore(client: pg.PoolClient) { await client.query("ROLLBACK TO SAVEPOINT finance_recurring_occurrence; RELEASE SAVEPOINT finance_recurring_occurrence"); }
// prettier-ignore
async function rollback(client: pg.PoolClient) { try { await client.query("ROLLBACK"); } catch {} }
