import {
  parseFinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseAudit,
  type FinanceGeneratedExpenseResult,
} from "@vayada/domain-finance";
import type pg from "pg";

import { appendFinanceGeneratedExpense } from "./financeGeneratedExpenseRepository.js";
import { readFinanceProviderFeeEvidence } from "./financeProviderFeeEvidence.js";

// prettier-ignore
export type FinanceProviderFeeExpenseProjectionInput = { commandId: string; propertyId: string; paymentId: string; providerFeeEvidenceId: string; audit: Omit<FinanceGeneratedExpenseAudit, "reasonCode"> };
// prettier-ignore
type Projection = { id: string; entryKind: "expense" | "correction" | "reversal"; categoryId: string; amount: string; currency: string; vendor: string; description: string | null; paymentStatus: "paid" | "unpaid"; paidOn: string | null; reversesExpenseId: string | null; active: boolean };

const SAVEPOINT = "finance_provider_fee_projection";

export async function projectFinanceProviderFeeExpense(
  client: pg.PoolClient,
  raw: FinanceProviderFeeExpenseProjectionInput,
): Promise<FinanceGeneratedExpenseResult> {
  const input = parseInput(raw);
  if (!input) return rejected("invalid_command");
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const result = await project(client, input);
    await client.query(
      result.ok
        ? `RELEASE SAVEPOINT ${SAVEPOINT}`
        : `ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`,
    );
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (["55P03", "57014"].includes(String((error as { code?: unknown }).code)))
      return rejected("write_unavailable");
    throw error;
  }
}

// prettier-ignore
async function project(client:pg.PoolClient,input:FinanceProviderFeeExpenseProjectionInput):Promise<FinanceGeneratedExpenseResult> {
  const property = await client.query(
    "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
    [input.propertyId],
  );
  if (property.rowCount !== 1) return rejected("evidence_mismatch");
  const result = await readFinanceProviderFeeEvidence(client, {
    propertyId: input.propertyId,
    paymentId: input.paymentId,
    evidenceId: input.providerFeeEvidenceId,
  });
  if (result.outcome === "missing") return rejected("evidence_mismatch");
  const evidence = result.evidence;
  const replay = await projection(client, input.propertyId, evidence.evidenceId);
  if (evidence.state === "missing")
    return { ok: true, outcome: "missing_evidence", code: "provider_fee_missing" };
  if (evidence.state === "proven_zero")
    return { ok: true, outcome: "ineligible", reason: "known_zero" };
  let prior: Projection | null = null;
  if (!replay && evidence.correctsEvidenceId) {
    const previous = await readFinanceProviderFeeEvidence(client, {
      propertyId: input.propertyId,
      paymentId: input.paymentId,
      evidenceId: evidence.correctsEvidenceId,
    });
    if (previous.outcome === "missing") return rejected("correction_conflict");
    const projected = await projection(client, input.propertyId, previous.evidence.evidenceId);
    if (positive(previous.evidence.feeAmount)) {
      if (!projected) return rejected("predecessor_not_projected");
      if (!projected?.active || projected.entryKind === "reversal")
        return rejected("correction_conflict");
      prior = projected;
    } else if (["correction", "reversal"].includes(previous.evidence.state)) {
      const hasAncestor = await hasPositiveAncestor(
        client,
        input.propertyId,
        input.paymentId,
        previous.evidence.evidenceId,
      );
      if (!projected && hasAncestor) return rejected("predecessor_not_projected");
      if (projected?.entryKind !== "reversal" && (projected || hasAncestor))
        return rejected("correction_conflict");
    }
  }
  if (!replay && !prior && evidence.feeAmount === "0.0000")
    return { ok: true, outcome: "ineligible", reason: "known_zero" };
  const action = replay
    ? replay.entryKind === "expense"
      ? "create"
      : replay.entryKind === "correction"
        ? "correct"
        : "reverse"
    : prior
      ? evidence.feeAmount === "0.0000" || evidence.state === "reversal"
        ? "reverse"
        : "correct"
      : "create";
  const economics = replay ?? (action === "reverse" ? prior! : null);
  const categoryId =
    economics?.categoryId ?? prior?.categoryId ?? (await activeCategory(client, input.propertyId));
  if (!categoryId) return rejected("evidence_mismatch");
  const amount = economics?.amount ?? evidence.feeAmount!;
  // prettier-ignore
  const command=parseFinanceGeneratedExpenseCommand({commandId:input.commandId,propertyId:input.propertyId,categoryId,origin:"platform_fee",action,incurredOn:evidence.evidenceOn,vendor:economics?.vendor??prior?.vendor??"Payment provider",description:economics?.description??prior?.description??null,amount:{amount,currency:economics?.currency??evidence.currency},paymentStatus:economics?.paymentStatus??"paid",paidOn:economics?.paidOn??evidence.evidenceOn,reversesExpenseId:replay?.reversesExpenseId??prior?.id??null,source:{kind:"platform_fee",providerFeeEvidenceId:evidence.evidenceId,paymentId:evidence.paymentId,evidenceOn:evidence.evidenceOn},audit:{...input.audit,reasonCode:action==="create"?"scheduled_generation":action==="correct"?"source_correction":"source_reversal"}});
  if (!command) return rejected("invalid_command");
  return appendFinanceGeneratedExpense(client, command);
}

// prettier-ignore
async function projection(client:pg.PoolClient,propertyId:string,evidenceId:string):Promise<Projection|null> {
  const rows = (
    await client.query<Projection>(
      `SELECT expense.id::text,expense.entry_kind AS "entryKind",
    expense.category_id::text AS "categoryId",expense.amount::text,expense.currency::text,expense.vendor,
    expense.description,expense.payment_status AS "paymentStatus",expense.paid_on::text AS "paidOn",
    expense.reverses_expense_id::text AS "reversesExpenseId",
    NOT EXISTS(SELECT 1 FROM finance.expenses child WHERE child.reverses_expense_id=expense.id) AS active
    FROM finance.expenses expense WHERE expense.property_id=$1::uuid AND expense.origin='platform_fee'
      AND (expense.source_key='provider_fee_evidence:'||$2::uuid::text
        OR expense.source_key LIKE 'provider_fee_evidence:'||$2::uuid::text||':%')
    ORDER BY expense.id LIMIT 2 FOR UPDATE OF expense`,
      [propertyId, evidenceId],
    )
  ).rows;
  if (rows.length > 1) throw new Error("provider fee projection lineage is invalid");
  return rows[0] ?? null;
}

// prettier-ignore
async function activeCategory(client:pg.PoolClient,propertyId:string):Promise<string|null>{return (await client.query<{id:string}>(`SELECT id::text FROM finance.expense_categories WHERE property_id=$1::uuid AND system_key='platform_fees' AND archived_at IS NULL FOR SHARE`,[propertyId])).rows[0]?.id??null;}
// prettier-ignore
async function hasPositiveAncestor(client:pg.PoolClient,propertyId:string,paymentId:string,evidenceId:string):Promise<boolean>{return (await client.query(`WITH RECURSIVE chain AS (SELECT corrects_provider_fee_evidence_id AS id FROM finance.provider_fee_evidence WHERE id=$1::uuid AND property_id=$2::uuid AND payment_id=$3::uuid UNION ALL SELECT evidence.corrects_provider_fee_evidence_id FROM finance.provider_fee_evidence evidence JOIN chain ON evidence.id=chain.id WHERE evidence.property_id=$2::uuid AND evidence.payment_id=$3::uuid) SELECT 1 FROM chain JOIN finance.provider_fee_evidence evidence ON evidence.id=chain.id WHERE evidence.fee_amount>0 LIMIT 1`,[evidenceId,propertyId,paymentId])).rowCount===1;}
function positive(amount: string | null): boolean {
  return amount !== null && amount !== "0.0000";
}

function parseInput(value: unknown): FinanceProviderFeeExpenseProjectionInput | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !["commandId", "propertyId", "paymentId", "providerFeeEvidenceId", "audit"].every((key) =>
      Object.hasOwn(value, key),
    )
  )
    return null;
  const input = value as FinanceProviderFeeExpenseProjectionInput;
  if (!input.audit || typeof input.audit !== "object" || Object.keys(input.audit).length !== 7)
    return null;
  // Use the canonical parser to reject hostile job envelopes before any database read.
  const valid = parseFinanceGeneratedExpenseCommand({
    commandId: input.commandId,
    propertyId: input.propertyId,
    categoryId: input.commandId,
    origin: "platform_fee",
    action: "create",
    incurredOn: "2000-01-01",
    vendor: "validate",
    description: null,
    amount: { amount: "1", currency: "USD" },
    paymentStatus: "paid",
    paidOn: "2000-01-01",
    reversesExpenseId: null,
    source: {
      kind: "platform_fee",
      providerFeeEvidenceId: input.providerFeeEvidenceId,
      paymentId: input.paymentId,
      evidenceOn: "2000-01-01",
    },
    audit: { ...input.audit, reasonCode: "scheduled_generation" },
  });
  return valid ? input : null;
}

// prettier-ignore
function rejected(code:Extract<FinanceGeneratedExpenseResult,{ok:false}>["code"]):Extract<FinanceGeneratedExpenseResult,{ok:false}>{return {ok:false,outcome:"rejected",code};}
