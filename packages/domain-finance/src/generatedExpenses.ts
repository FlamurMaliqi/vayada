import { createHash } from "node:crypto";

import {
  FINANCE_EXPENSE_PAYMENT_STATUSES,
  normalizeFinanceExpenseAmount,
  type FinanceExpenseMoney,
  type FinanceExpensePaymentStatus,
} from "./financialExpenses.js";

export const FINANCE_GENERATED_EXPENSE_ACTIONS = ["create", "correct", "reverse"] as const;
// prettier-ignore
export const FINANCE_GENERATED_EXPENSE_ORIGINS = ["recurring", "ota_commission", "platform_fee"] as const;
// prettier-ignore
export const FINANCE_GENERATED_EXPENSE_OUTCOMES = ["created", "replayed", "corrected", "reversed", "ineligible", "missing_evidence", "rejected"] as const;
// prettier-ignore
export const FINANCE_GENERATED_EXPENSE_MISSING_EVIDENCE = ["ota_commission_missing_gross", "ota_commission_missing_rule", "ota_commission_missing_rule_and_gross", "ota_commission_ambiguous_rule", "ota_commission_ambiguous_rule_and_gross", "provider_fee_missing"] as const;
// prettier-ignore
export const FINANCE_GENERATED_EXPENSE_AUDIT_REASONS = ["scheduled_generation", "source_correction", "source_reversal"] as const;
export const FINANCE_GENERATED_EXPENSE_SERVICE = "finance-expense-automation" as const;

export type FinanceGeneratedExpenseAction = (typeof FINANCE_GENERATED_EXPENSE_ACTIONS)[number];
export type FinanceGeneratedExpenseOrigin = (typeof FINANCE_GENERATED_EXPENSE_ORIGINS)[number];
export type FinanceGeneratedExpenseMissingEvidence =
  (typeof FINANCE_GENERATED_EXPENSE_MISSING_EVIDENCE)[number];
export type FinanceGeneratedExpenseAuditReason =
  (typeof FINANCE_GENERATED_EXPENSE_AUDIT_REASONS)[number];
// prettier-ignore
export type FinanceGeneratedExpenseAudit = { actor: { kind: "system"; service: typeof FINANCE_GENERATED_EXPENSE_SERVICE }; requestId: string; correlationId: string; causationId: string; jobId: string; jobAttemptId: string; reasonCode: FinanceGeneratedExpenseAuditReason; requestedAt: string };
// prettier-ignore
export type FinanceRecurringExpenseSource = { kind: "recurring"; recurringRuleId: string; ruleRevision: number; occurrenceOn: string };
// prettier-ignore
export type FinanceOtaCommissionExpenseSource = { kind: "ota_commission"; commissionEvidenceId: string; guestBookingId: string; serviceNight: string };
// prettier-ignore
export type FinanceProviderFeeExpenseSource = { kind: "platform_fee"; providerFeeEvidenceId: string; paymentId: string; evidenceOn: string };
// prettier-ignore
export type FinanceGeneratedExpenseSource = FinanceRecurringExpenseSource | FinanceOtaCommissionExpenseSource | FinanceProviderFeeExpenseSource;
// prettier-ignore
type FinanceGeneratedExpenseBase = { commandId: string; propertyId: string; categoryId: string; incurredOn: string; vendor: string; description: string | null; amount: FinanceExpenseMoney; paymentStatus: FinanceExpensePaymentStatus; paidOn: string | null; audit: FinanceGeneratedExpenseAudit };
// prettier-ignore
export type FinanceGeneratedExpenseCommand = FinanceGeneratedExpenseBase & ({ action: "create"; reversesExpenseId: null } | { action: "correct" | "reverse"; reversesExpenseId: string }) & ({ origin: "recurring"; source: FinanceRecurringExpenseSource } | { origin: "ota_commission"; source: FinanceOtaCommissionExpenseSource } | { origin: "platform_fee"; source: FinanceProviderFeeExpenseSource });
// prettier-ignore
export type FinanceGeneratedExpenseResult =
  | { ok: true; outcome: "created" | "replayed" | "corrected" | "reversed"; expenseId: string }
  | { ok: true; outcome: "ineligible"; reason: "not_due" | "known_zero" | "non_positive" }
  | { ok: true; outcome: "missing_evidence"; code: FinanceGeneratedExpenseMissingEvidence }
  | { ok: false; outcome: "rejected"; code: "invalid_command" | "evidence_mismatch" | "currency_mismatch" | "source_conflict" | "correction_conflict" | "predecessor_not_projected" | "write_unavailable" };

// prettier-ignore
const COMMAND_KEYS = ["commandId", "propertyId", "categoryId", "origin", "action", "incurredOn", "vendor", "description", "amount", "paymentStatus", "paidOn", "reversesExpenseId", "source", "audit"] as const;

export function parseFinanceGeneratedExpenseCommand(
  value: unknown,
): FinanceGeneratedExpenseCommand | null {
  if (!exact(value, COMMAND_KEYS)) return null;
  const source = parseSource(value.source);
  const amount = parseMoney(value.amount);
  const action = oneOf(value.action, FINANCE_GENERATED_EXPENSE_ACTIONS);
  const paymentStatus = oneOf(value.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES);
  const audit = parseAudit(value.audit);
  // prettier-ignore
  if (!source || value.origin !== source.kind || !uuid(value.commandId) ||
    !uuid(value.propertyId) || !uuid(value.categoryId) || !action ||
    !localDate(value.incurredOn) || (action === "create" && value.incurredOn !== sourceDate(source)) ||
    !trimmed(value.vendor, 1, 200) || !(value.description === null || trimmed(value.description, 1, 2_000)) ||
    !amount || !paymentStatus || !(value.paidOn === null || localDate(value.paidOn)) ||
    (paymentStatus === "paid") !== (value.paidOn !== null) || !audit ||
    audit.reasonCode !== actionReason(action)) return null;
  const reverses = value.reversesExpenseId;
  if (
    (action === "create" && reverses !== null) ||
    (action !== "create" && (!uuid(reverses) || lower(reverses) === lower(value.commandId)))
  )
    return null;
  // prettier-ignore
  const base = { commandId: lower(value.commandId), propertyId: lower(value.propertyId), categoryId: lower(value.categoryId), action, incurredOn: value.incurredOn, vendor: value.vendor, description: value.description, amount, paymentStatus, paidOn: value.paidOn, reversesExpenseId: typeof reverses === "string" ? lower(reverses) : null, audit };
  return { ...base, origin: source.kind, source } as FinanceGeneratedExpenseCommand;
}

export function financeGeneratedExpenseSourceKey(command: FinanceGeneratedExpenseCommand): string {
  const source = command.source;
  // prettier-ignore
  const base = source.kind === "recurring" ? `recurring_rule:${lower(source.recurringRuleId)}:occurrence:${source.occurrenceOn}` : source.kind === "ota_commission" ? `ota_commission_evidence:${lower(source.commissionEvidenceId)}` : `provider_fee_evidence:${lower(source.providerFeeEvidenceId)}`;
  return command.action === "create"
    ? base
    : `${base}:${command.action}:${lower(command.reversesExpenseId)}`;
}

export function financeGeneratedExpenseJobKey(command: FinanceGeneratedExpenseCommand): string {
  const source = command.source;
  // prettier-ignore
  const aggregate = source.kind === "recurring" ? ["recurring_rule", source.recurringRuleId, `occurrence-${source.occurrenceOn}`] : source.kind === "ota_commission" ? ["ota_commission_evidence", source.commissionEvidenceId, "project"] : ["provider_fee_evidence", source.providerFeeEvidenceId, "project"];
  const action =
    command.action === "create"
      ? aggregate[2]
      : `${command.action}-${lower(command.reversesExpenseId)}`;
  return `finance.generate-expense:${aggregate[0]}:${lower(aggregate[1]!)}:${action}:v1`;
}

export function financeGeneratedExpenseFingerprint(value: unknown): string | null {
  const command = parseFinanceGeneratedExpenseCommand(value);
  if (!command) return null;
  return (
    createHash("sha256")
      // prettier-ignore
      .update(
        JSON.stringify([
          command.commandId,
          command.propertyId,
          command.categoryId,
          command.origin,
          command.action,
          command.incurredOn,
          command.vendor,
          command.description,
          command.amount.amount,
          command.amount.currency,
          command.paymentStatus,
          command.paidOn,
          command.reversesExpenseId,
          command.source,
        ]),
      )
      .digest("hex")
  );
}

export function financeGeneratedExpenseRedactedAuditEvidence(value: unknown) {
  const command = parseFinanceGeneratedExpenseCommand(value);
  if (!command) return null;
  // prettier-ignore
  return Object.freeze({ commandId: command.commandId, propertyId: command.propertyId,
    origin: command.origin, action: command.action, sourceKey: financeGeneratedExpenseSourceKey(command),
    fingerprint: financeGeneratedExpenseFingerprint(command)!, actorService: command.audit.actor.service,
    reasonCode: command.audit.reasonCode, causationId: command.audit.causationId,
    jobId: command.audit.jobId, jobAttemptId: command.audit.jobAttemptId });
}

function parseSource(value: unknown): FinanceGeneratedExpenseSource | null {
  if (!record(value)) return null;
  if (
    value.kind === "recurring" &&
    exact(value, ["kind", "recurringRuleId", "ruleRevision", "occurrenceOn"]) &&
    uuid(value.recurringRuleId) &&
    revision(value.ruleRevision) &&
    localDate(value.occurrenceOn)
  )
    // prettier-ignore
    return { kind: "recurring", recurringRuleId: lower(value.recurringRuleId), ruleRevision: value.ruleRevision, occurrenceOn: value.occurrenceOn } as FinanceRecurringExpenseSource;
  if (
    value.kind === "ota_commission" &&
    exact(value, ["kind", "commissionEvidenceId", "guestBookingId", "serviceNight"]) &&
    uuid(value.commissionEvidenceId) &&
    uuid(value.guestBookingId) &&
    localDate(value.serviceNight)
  )
    // prettier-ignore
    return { kind: "ota_commission", commissionEvidenceId: lower(value.commissionEvidenceId), guestBookingId: lower(value.guestBookingId), serviceNight: value.serviceNight } as FinanceOtaCommissionExpenseSource;
  if (
    value.kind === "platform_fee" &&
    exact(value, ["kind", "providerFeeEvidenceId", "paymentId", "evidenceOn"]) &&
    uuid(value.providerFeeEvidenceId) &&
    uuid(value.paymentId) &&
    localDate(value.evidenceOn)
  )
    // prettier-ignore
    return { kind: "platform_fee", providerFeeEvidenceId: lower(value.providerFeeEvidenceId), paymentId: lower(value.paymentId), evidenceOn: value.evidenceOn } as FinanceProviderFeeExpenseSource;
  return null;
}

function parseAudit(value: unknown): FinanceGeneratedExpenseAudit | null {
  // prettier-ignore
  if (!exact(value, ["actor", "requestId", "correlationId", "causationId", "jobId", "jobAttemptId", "reasonCode", "requestedAt"]) ||
    !exact(value.actor, ["kind", "service"]) || value.actor.kind !== "system" ||
    value.actor.service !== FINANCE_GENERATED_EXPENSE_SERVICE ||
    !trimmed(value.requestId, 1, 200) || !trimmed(value.correlationId, 1, 200) ||
    !uuid(value.causationId) || !uuid(value.jobId) || !uuid(value.jobAttemptId) ||
    new Set([lower(value.causationId), lower(value.jobId), lower(value.jobAttemptId)]).size !== 3 ||
    !oneOf(value.reasonCode, FINANCE_GENERATED_EXPENSE_AUDIT_REASONS) || !utc(value.requestedAt)) return null;
  // prettier-ignore
  return { ...value, causationId: lower(value.causationId), jobId: lower(value.jobId), jobAttemptId: lower(value.jobAttemptId) } as FinanceGeneratedExpenseAudit;
}

function parseMoney(value: unknown): FinanceExpenseMoney | null {
  if (!exact(value, ["amount", "currency"]) || typeof value.amount !== "string") return null;
  const amount = normalizeFinanceExpenseAmount(value.amount);
  return amount && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)
    ? { amount, currency: value.currency }
    : null;
}
function sourceDate(source: FinanceGeneratedExpenseSource): string {
  // prettier-ignore
  return source.kind === "recurring" ? source.occurrenceOn : source.kind === "ota_commission" ? source.serviceNight : source.evidenceOn;
}
function actionReason(action: FinanceGeneratedExpenseAction): FinanceGeneratedExpenseAuditReason {
  // prettier-ignore
  return action === "create" ? "scheduled_generation" : action === "correct" ? "source_correction" : "source_reversal";
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : null;
}
function uuid(value: unknown): value is string {
  // prettier-ignore
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function lower(value: string): string {
  return value.toLowerCase();
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || value.startsWith("0000-") || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function utc(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.startsWith("0000-") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
