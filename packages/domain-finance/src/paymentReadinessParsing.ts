import { isDeepStrictEqual } from "node:util";

import {
  FINANCE_PAYMENT_READINESS_BLOCKERS,
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_METHODS,
  FINANCE_PAYMENT_READINESS_NEXT_ACTIONS,
  type FinancePaymentReadinessMethod,
  type FinancePaymentReadinessSnapshot,
  type FinancePricingCurrencyEvidence,
  type ReplaceFinancePaymentMethodsError,
  type ReplaceFinancePaymentMethodsResult,
} from "./paymentReadiness.js";
import { createFinancePaymentReadinessSnapshot } from "./paymentReadinessSnapshot.js";

export function parseFinancePaymentReadinessSnapshot(
  value: unknown,
): FinancePaymentReadinessSnapshot | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "propertyId",
      "paymentMethodsRevision",
      "paymentsEnabled",
      "pricingCurrency",
      "bookingPaymentReady",
      "selectedMethodCount",
      "readyMethodCount",
      "methods",
      "updatedAt",
    ]) ||
    value.contractVersion !== FINANCE_PAYMENT_READINESS_CONTRACT_VERSION ||
    !uuid(value.propertyId) ||
    !revision(value.paymentMethodsRevision, false) ||
    typeof value.paymentsEnabled !== "boolean" ||
    typeof value.bookingPaymentReady !== "boolean" ||
    !count(value.selectedMethodCount) ||
    !count(value.readyMethodCount) ||
    !(value.updatedAt === null || isoDate(value.updatedAt)) ||
    !isExactRecord(value.pricingCurrency, ["committed", "current", "matchesCurrent"]) ||
    typeof value.pricingCurrency.matchesCurrent !== "boolean" ||
    !Array.isArray(value.methods)
  )
    return null;
  const committed = parsePricingEvidence(value.pricingCurrency.committed);
  const current = parsePricingEvidence(value.pricingCurrency.current);
  if (committed === undefined || current === undefined) return null;
  const methods = value.methods;
  if (
    !methods.every(
      (method) =>
        isExactRecord(method, [
          "method",
          "selected",
          "availability",
          "readiness",
          "consequence",
          "blockers",
          "nextActions",
        ]) &&
        isOneOf(method.method, FINANCE_PAYMENT_READINESS_METHODS) &&
        typeof method.selected === "boolean" &&
        isOneOf(method.availability, ["available", "unavailable"] as const) &&
        isOneOf(method.readiness, ["ready", "unready"] as const) &&
        isOneOf(method.consequence, ["not_selected", "ready", "warning", "blocking"] as const) &&
        Array.isArray(method.blockers) &&
        method.blockers.every((blocker) => isOneOf(blocker, FINANCE_PAYMENT_READINESS_BLOCKERS)) &&
        Array.isArray(method.nextActions) &&
        method.nextActions.every((action) =>
          isOneOf(action, FINANCE_PAYMENT_READINESS_NEXT_ACTIONS),
        ),
    )
  )
    return null;
  const selectedMethods = methods
    .filter((method) => method.selected)
    .map((method) => method.method as FinancePaymentReadinessMethod);
  let canonical: FinancePaymentReadinessSnapshot;
  try {
    canonical = createFinancePaymentReadinessSnapshot({
      propertyId: value.propertyId,
      paymentMethodsRevision: value.paymentMethodsRevision,
      selectedMethods,
      committedPricing: committed,
      currentPricing: current,
      updatedAt: value.updatedAt,
    });
  } catch {
    return null;
  }
  return isDeepStrictEqual(canonical, value) ? canonical : null;
}

export function parseReplaceFinancePaymentMethodsResult(
  value: unknown,
): ReplaceFinancePaymentMethodsResult | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) {
    if (!isExactRecord(value, ["ok", "response"])) return null;
    if (
      !isExactRecord(value.response, [
        "contractVersion",
        "outcome",
        "paymentReadiness",
        "acceptedAt",
      ]) ||
      value.response.contractVersion !== FINANCE_PAYMENT_READINESS_CONTRACT_VERSION ||
      !isOneOf(value.response.outcome, ["created", "updated"] as const) ||
      !isoDate(value.response.acceptedAt)
    )
      return null;
    const paymentReadiness = parseFinancePaymentReadinessSnapshot(value.response.paymentReadiness);
    return paymentReadiness
      ? deepFreeze({
          ok: true,
          response: {
            contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
            outcome: value.response.outcome,
            paymentReadiness,
            acceptedAt: value.response.acceptedAt,
          },
        })
      : null;
  }
  if (!isExactRecord(value, ["ok", "error"])) return null;
  const error = parseCommandError(value.error);
  return error ? deepFreeze({ ok: false, error }) : null;
}

function parsePricingEvidence(value: unknown): FinancePricingCurrencyEvidence | null | undefined {
  if (value === null) return null;
  return isExactRecord(value, ["contractVersion", "currency", "pricingCurrencyRevision"]) &&
    trimmedText(value.contractVersion, 1, 200) &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency) &&
    revision(value.pricingCurrencyRevision, false)
    ? Object.freeze({
        contractVersion: value.contractVersion,
        currency: value.currency,
        pricingCurrencyRevision: value.pricingCurrencyRevision,
      })
    : undefined;
}

function parseCommandError(value: unknown): ReplaceFinancePaymentMethodsError | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  if (
    isOneOf(value.code, [
      "setup_scope_unavailable",
      "pricing_currency_unavailable",
      "idempotency_key_conflict",
      "command_in_progress",
    ] as const)
  )
    return isExactRecord(value, ["code"]) ? Object.freeze({ code: value.code }) : null;
  if (
    value.code === "payment_method_unavailable" &&
    value.method === "bank_transfer" &&
    isExactRecord(value, ["code", "method"])
  )
    return Object.freeze({ code: value.code, method: value.method });
  if (
    isOneOf(value.code, [
      "payment_methods_revision_conflict",
      "pricing_currency_revision_conflict",
    ] as const) &&
    isExactRecord(value, ["code", "currentRevision"]) &&
    revision(value.currentRevision, value.code === "payment_methods_revision_conflict")
  )
    return Object.freeze({ code: value.code, currentRevision: value.currentRevision });
  return null;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function revision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (allowZero ? Number(value) >= 0 : Number(value) >= 1) &&
    Number(value) <= 2_147_483_647
  );
}
function count(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}
function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}
function isoDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function trimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value === value.trim()
  );
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
