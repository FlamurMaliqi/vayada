import {
  parseFinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseAudit,
  type FinanceGeneratedExpenseResult,
} from "@vayada/domain-finance";
import pg from "pg";
import { appendFinanceGeneratedExpense } from "./financeGeneratedExpenseRepository.js";
export type FinanceOtaCommissionExpenseProjectionCommand = {
  commandId: string;
  propertyId: string;
  commissionEvidenceId: string;
  audit: Omit<FinanceGeneratedExpenseAudit, "reasonCode">;
};
// prettier-ignore
type EvidenceRow = { guestBookingId: string; serviceNight: string; recognizedOn: string;
  economicEvent: string; sourceKind: string; channel: string; currency: string;
  commissionAmount: string | null; evidenceState: string; correctsId: string | null;
  categoryId: string | null; categoryActive: boolean | null; currencyOk: boolean };
// prettier-ignore
type ExpenseRow = { id: string; entryKind: string; reversesExpenseId: string | null;
  amount: string; effectiveAmount?: string | null; effectivePositive?: boolean | null;
  effectiveZero?: boolean | null; evidenceId?: string };
const MISSING = {
  missing_gross: "ota_commission_missing_gross",
  missing_rule: "ota_commission_missing_rule",
  missing_rule_and_gross: "ota_commission_missing_rule_and_gross",
  ambiguous_rule: "ota_commission_ambiguous_rule",
  ambiguous_rule_and_gross: "ota_commission_ambiguous_rule_and_gross",
} as const;
const VENDOR: Record<string, string> = {
  booking_com: "Booking.com",
  airbnb: "Airbnb",
  expedia: "Expedia",
  agoda: "Agoda",
  other_ota: "OTA",
};
const SAVEPOINT = "finance_ota_commission_projection";
// prettier-ignore
export function createPgFinanceOtaCommissionExpenseProjection(
  connectionString: string,
  clock: () => Date = () => new Date(),
) {
  const pool = new pg.Pool({ connectionString });
  return {
    async project(raw: FinanceOtaCommissionExpenseProjectionCommand): Promise<FinanceGeneratedExpenseResult> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const result = await projectFinanceOtaCommissionExpense(client, raw, clock);
        await client.query(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        await rollback(client);
        if (transient(error)) return rejected("write_unavailable");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
// prettier-ignore
export async function projectFinanceOtaCommissionExpense(client:pg.PoolClient,raw:FinanceOtaCommissionExpenseProjectionCommand,clock:()=>Date=()=>new Date()):Promise<FinanceGeneratedExpenseResult> {
  const input=parseInput(raw);if(!input)return rejected("invalid_command");
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try{const result=await project(client,input,clock);await client.query(result.ok?`RELEASE SAVEPOINT ${SAVEPOINT}`:`ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`);return result;}
  catch(error){try{await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`);}catch{throw error;}if(transient(error))return rejected("write_unavailable");throw error;}
}
// prettier-ignore
async function project(
  client: pg.PoolClient,
  input: FinanceOtaCommissionExpenseProjectionCommand,
  clock: () => Date,
): Promise<FinanceGeneratedExpenseResult> {
  const property = await client.query(
    "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
    [input.propertyId],
  );
  if (property.rowCount !== 1) return rejected("evidence_mismatch");
  const evidence = (
    await client.query<EvidenceRow>(
      `SELECT ota.guest_booking_id::text AS "guestBookingId", ota.service_night::text AS "serviceNight",
         night.recognized_on::text AS "recognizedOn", night.economic_event AS "economicEvent",
         night.source_kind AS "sourceKind", ota.channel, ota.currency::text,
         ota.commission_amount::text AS "commissionAmount", ota.evidence_state AS "evidenceState",
         ota.corrects_commission_evidence_id::text AS "correctsId", category.id::text AS "categoryId",
         category.archived_at IS NULL AS "categoryActive",
         EXISTS(SELECT 1 FROM pms.property_pricing_settings pricing
           WHERE pricing.property_id=ota.property_id AND pricing.currency=ota.currency) AS "currencyOk"
       FROM finance.ota_commission_evidence ota
       JOIN booking.nightly_revenue_evidence night ON night.id=ota.booking_revenue_evidence_id
         AND night.property_id=ota.property_id
       LEFT JOIN finance.expense_categories category ON category.property_id=ota.property_id
         AND category.system_key='ota_commission'
       WHERE ota.id=$1::uuid AND ota.property_id=$2::uuid FOR SHARE OF ota,night`,
      [input.commissionEvidenceId, input.propertyId],
    )
  ).rows[0];
  if (!evidence || evidence.sourceKind !== "ota" || !validEvent(evidence))
    return rejected("evidence_mismatch");
  const missing = MISSING[evidence.evidenceState as keyof typeof MISSING];
  if (missing) return { ok: true, outcome: "missing_evidence", code: missing };
  if (evidence.evidenceState !== "applied" || evidence.commissionAmount === null)
    return rejected("evidence_mismatch");
  const base = `ota_commission_evidence:${input.commissionEvidenceId}`;
  const projected = (
    await client.query<ExpenseRow>(
      `SELECT id::text,entry_kind AS "entryKind",
         reverses_expense_id::text AS "reversesExpenseId",amount::text
       FROM finance.expenses WHERE property_id=$1::uuid AND origin='ota_commission'
         AND (source_key=$2 OR source_key LIKE $2||':%') ORDER BY id LIMIT 2`,
      [input.propertyId, base],
    )
  ).rows;
  if (projected.length > 1) return rejected("source_conflict");
  const priors = projected[0] ? [] : await activePrior(client, input, evidence.commissionAmount);
  if (priors.length > 1) return rejected("correction_conflict");
  const prior = priors[0] ?? null;
  if (!projected[0] && evidence.correctsId && (await pendingPrior(client, input, Boolean(prior))))
    return rejected("predecessor_not_projected");
  if (!projected[0] && !prior && !evidence.commissionAmount.startsWith("-") && evidence.commissionAmount !== "0.0000") {
    if (!evidence.currencyOk) return rejected("currency_mismatch");
    if (!evidence.categoryId || !evidence.categoryActive) return rejected("evidence_mismatch");
  }
  let action: "create" | "correct" | "reverse";
  let amount: string;
  let reversesExpenseId: string | null;
  const existing = projected[0];
  if (existing) {
    action = existing.entryKind === "expense" ? "create" : existing.entryKind === "correction" ? "correct" : "reverse";
    amount = existing.amount;
    reversesExpenseId = existing.reversesExpenseId;
  } else if (evidence.commissionAmount === "0.0000") {
    return { ok: true, outcome: "ineligible", reason: "non_positive" };
  } else if (!prior) {
    if (evidence.commissionAmount.startsWith("-")) return { ok: true, outcome: "ineligible", reason: "non_positive" };
    action = "create";
    amount = evidence.commissionAmount;
    reversesExpenseId = null;
  } else if (prior.effectivePositive) {
    action = "correct";
    amount = prior.effectiveAmount!;
    reversesExpenseId = prior.id;
  } else if (prior.effectiveZero && evidence.commissionAmount.startsWith("-")) {
    action = "reverse";
    amount = prior.amount;
    reversesExpenseId = prior.id;
  } else {
    return rejected("evidence_mismatch");
  }
  if (!evidence.currencyOk) return rejected("currency_mismatch");
  if (!evidence.categoryId) return rejected("evidence_mismatch");
  if ((action === "create") !== (reversesExpenseId === null)) return rejected("evidence_mismatch");
  const command = parseFinanceGeneratedExpenseCommand({
    commandId: input.commandId,
    propertyId: input.propertyId,
    categoryId: evidence.categoryId,
    origin: "ota_commission",
    action,
    incurredOn: action === "create" ? evidence.serviceNight : evidence.recognizedOn,
    vendor: VENDOR[evidence.channel] ?? "OTA",
    description: null,
    amount: { amount, currency: evidence.currency },
    paymentStatus: "unpaid",
    paidOn: null,
    reversesExpenseId,
    source: {
      kind: "ota_commission",
      commissionEvidenceId: input.commissionEvidenceId,
      guestBookingId: evidence.guestBookingId,
      serviceNight: evidence.serviceNight,
    },
    audit: {
      ...input.audit,
      reasonCode:
        action === "create" ? "scheduled_generation" : action === "correct" ? "source_correction" : "source_reversal",
    },
  });
  return command
    ? appendFinanceGeneratedExpense(client, command, clock)
    : rejected("invalid_command");
}
async function activePrior(
  client: pg.PoolClient,
  input: FinanceOtaCommissionExpenseProjectionCommand,
  commissionAmount: string | null,
): Promise<ExpenseRow[]> {
  const rows = (
    await client.query<ExpenseRow>(
      `WITH RECURSIVE chain AS (
         SELECT prior.id,prior.corrects_commission_evidence_id AS prior
         FROM finance.ota_commission_evidence current
         JOIN finance.ota_commission_evidence prior ON prior.id=current.corrects_commission_evidence_id
           AND prior.property_id=current.property_id
         WHERE current.id=$1::uuid AND current.property_id=$2::uuid
         UNION ALL SELECT evidence.id,evidence.corrects_commission_evidence_id
         FROM finance.ota_commission_evidence evidence JOIN chain ON evidence.id=chain.prior
         WHERE evidence.property_id=$2::uuid)
       SELECT expense.id::text,expense.entry_kind AS "entryKind",chain.id::text AS "evidenceId",
         expense.reverses_expense_id::text AS "reversesExpenseId",expense.amount::text,
         (expense.amount+$3::numeric)::text AS "effectiveAmount",
         expense.amount+$3::numeric>0 AS "effectivePositive",
         expense.amount+$3::numeric=0 AS "effectiveZero"
       FROM chain JOIN finance.expenses expense ON expense.property_id=$2::uuid
         AND expense.origin='ota_commission' AND
         (expense.source_key='ota_commission_evidence:'||chain.id::text
          OR expense.source_key LIKE 'ota_commission_evidence:'||chain.id::text||':%')
       WHERE expense.entry_kind<>'reversal' AND NOT EXISTS
         (SELECT 1 FROM finance.expenses child WHERE child.reverses_expense_id=expense.id)
       ORDER BY expense.created_at DESC LIMIT 2`,
      [input.commissionEvidenceId, input.propertyId, commissionAmount],
    )
  ).rows;
  return rows;
}
async function pendingPrior(
  client: pg.PoolClient,
  input: FinanceOtaCommissionExpenseProjectionCommand,
  includeNegative: boolean,
): Promise<boolean> {
  const row = (
    await client.query<{ pending: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT prior.id,prior.corrects_commission_evidence_id AS prior
         FROM finance.ota_commission_evidence current
         JOIN finance.ota_commission_evidence prior ON prior.id=current.corrects_commission_evidence_id
           AND prior.property_id=current.property_id
         WHERE current.id=$1::uuid AND current.property_id=$2::uuid
         UNION ALL SELECT evidence.id,evidence.corrects_commission_evidence_id
         FROM finance.ota_commission_evidence evidence JOIN chain ON evidence.id=chain.prior
         WHERE evidence.property_id=$2::uuid)
       SELECT EXISTS(SELECT 1 FROM chain JOIN finance.ota_commission_evidence evidence USING(id)
         WHERE evidence.evidence_state='applied' AND
           (evidence.commission_amount>0 OR ($3 AND evidence.commission_amount<>0)) AND NOT EXISTS
           (SELECT 1 FROM finance.expenses expense WHERE expense.property_id=$2::uuid
             AND expense.origin='ota_commission' AND
             (expense.source_key='ota_commission_evidence:'||chain.id::text
              OR expense.source_key LIKE 'ota_commission_evidence:'||chain.id::text||':%'))) AS pending`,
      [input.commissionEvidenceId, input.propertyId, includeNegative],
    )
  ).rows[0];
  return row?.pending ?? false;
}
// prettier-ignore
function parseInput(value: unknown): FinanceOtaCommissionExpenseProjectionCommand | null {
  if (!exact(value, ["commandId", "propertyId", "commissionEvidenceId", "audit"]) ||
      !exact(value.audit, ["actor", "requestId", "correlationId", "causationId", "jobId", "jobAttemptId", "requestedAt"])) return null;
  const parsed = parseFinanceGeneratedExpenseCommand({
    commandId: value.commandId, propertyId: value.propertyId, categoryId: value.propertyId,
    origin: "ota_commission", action: "create", incurredOn: "2000-01-01", vendor: "OTA",
    description: null, amount: { amount: "1", currency: "USD" }, paymentStatus: "unpaid",
    paidOn: null, reversesExpenseId: null, source: { kind: "ota_commission",
      commissionEvidenceId: value.commissionEvidenceId, guestBookingId: value.propertyId,
      serviceNight: "2000-01-01" }, audit: { ...value.audit, reasonCode: "scheduled_generation" },
  });
  if (!parsed || parsed.source.kind !== "ota_commission") return null;
  const { reasonCode, ...audit } = parsed.audit;
  void reasonCode;
  return { commandId: parsed.commandId, propertyId: parsed.propertyId,
    commissionEvidenceId: parsed.source.commissionEvidenceId, audit };
}
function validEvent(row: EvidenceRow): boolean {
  return row.correctsId === null
    ? ["room_night", "retained_charge", "correction"].includes(row.economicEvent)
    : ["correction", "refund", "room_night_reversal", "occupancy_adjustment"].includes(
        row.economicEvent,
      );
}
// prettier-ignore
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function rejected(code: Extract<FinanceGeneratedExpenseResult, { ok: false }>["code"]) {
  return { ok: false as const, outcome: "rejected" as const, code };
}
function transient(value: unknown): boolean {
  return ["55P03", "57014"].includes(String((value as { code?: unknown } | null)?.code));
}
// prettier-ignore
async function rollback(client: pg.PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch {}
}
