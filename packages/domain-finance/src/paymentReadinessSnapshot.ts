import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_METHODS,
  FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
  FINANCE_ONLINE_CARD_READINESS_DECISIONS,
  type FinancePaymentMethodReadiness,
  type FinancePaymentNextAction,
  type FinancePaymentReadinessBlocker,
  type FinancePaymentReadinessInput,
  type FinancePaymentReadinessMethod,
  type FinancePaymentReadinessSnapshot,
  type FinanceOnlineCardReadinessDecision,
  type FinanceOnlineCardReadinessEvidence,
  type FinancePricingCurrencyEvidence,
} from "./paymentReadiness.js";

export function createFinancePaymentReadinessSnapshot(
  input: FinancePaymentReadinessInput,
): FinancePaymentReadinessSnapshot {
  const committedPricing = parsePricing(input.committedPricing);
  const currentPricing = parsePricing(input.currentPricing);
  if (
    !uuid(input.propertyId) ||
    !revision(input.paymentMethodsRevision, false) ||
    !parseMethods(input.selectedMethods, true) ||
    !FINANCE_ONLINE_CARD_READINESS_DECISIONS.includes(input.onlineCardReadiness) ||
    !(input.updatedAt === null || isoDate(input.updatedAt)) ||
    committedPricing === undefined ||
    currentPricing === undefined
  )
    throw new Error("Finance payment readiness input is invalid");
  const selectedMethods = parseMethods(input.selectedMethods, true)!;
  const selected = new Set(selectedMethods);
  const matchesCurrent = Boolean(
    committedPricing &&
    currentPricing &&
    committedPricing.contractVersion === currentPricing.contractVersion &&
    committedPricing.currency === currentPricing.currency &&
    committedPricing.pricingCurrencyRevision === currentPricing.pricingCurrencyRevision,
  );
  const methodInputs = FINANCE_PAYMENT_READINESS_METHODS.map((method) => ({
    method,
    selected: selected.has(method),
    ready:
      selected.has(method) &&
      matchesCurrent &&
      (method === "pay_at_property" ||
        (method === "card" && input.onlineCardReadiness === "ready")),
  }));
  const bookingPaymentReady = methodInputs.some(({ ready }) => ready);
  const methods = methodInputs.map(({ method, selected: isSelected, ready }) => {
    const unavailable = method === "bank_transfer";
    const blockers: FinancePaymentReadinessBlocker[] = [];
    const nextActions: FinancePaymentNextAction[] = [];
    if (method === "card") {
      if (!committedPricing) {
        blockers.push("payment_settings_uncommitted");
        nextActions.push("reload_payment_settings");
      } else if (!currentPricing) {
        blockers.push("pricing_currency_unavailable");
        nextActions.push("edit_pricing");
      } else if (!matchesCurrent) {
        blockers.push("pricing_currency_mismatch");
        nextActions.push("reload_payment_settings", "edit_pricing");
      }
      if (input.onlineCardReadiness !== "ready") {
        blockers.push(
          input.onlineCardReadiness === "execution_unavailable"
            ? "online_card_execution_unavailable"
            : input.onlineCardReadiness === "currency_unsupported"
              ? "online_card_currency_unsupported"
              : input.onlineCardReadiness,
        );
        nextActions.push(
          input.onlineCardReadiness === "currency_unsupported"
            ? "edit_pricing"
            : "wait_for_online_card_execution",
        );
      }
    } else if (method === "bank_transfer") {
      blockers.push("bank_transfer_contract_unavailable");
      nextActions.push("wait_for_bank_transfer_contract");
    } else if (!isSelected) {
      nextActions.push("select_pay_at_property");
    } else if (!committedPricing) {
      blockers.push("payment_settings_uncommitted");
      nextActions.push("reload_payment_settings");
    } else if (!currentPricing) {
      blockers.push("pricing_currency_unavailable");
      nextActions.push("edit_pricing");
    } else if (!matchesCurrent) {
      blockers.push("pricing_currency_mismatch");
      nextActions.push("reload_payment_settings", "edit_pricing");
    }
    return {
      method,
      selected: isSelected,
      availability: unavailable ? "unavailable" : "available",
      readiness: ready ? "ready" : "unready",
      consequence: !isSelected
        ? "not_selected"
        : ready
          ? "ready"
          : bookingPaymentReady
            ? "warning"
            : "blocking",
      blockers,
      nextActions,
    } satisfies FinancePaymentMethodReadiness;
  });
  return deepFreeze({
    contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
    propertyId: normalizeUuid(input.propertyId),
    paymentMethodsRevision: input.paymentMethodsRevision,
    paymentsEnabled: selectedMethods.length > 0,
    pricingCurrency: {
      committed: committedPricing,
      current: currentPricing,
      matchesCurrent,
    },
    bookingPaymentReady,
    selectedMethodCount: selectedMethods.length,
    readyMethodCount: methods.filter(({ readiness }) => readiness === "ready").length,
    methods,
    updatedAt: input.updatedAt,
  });
}

export function resolveFinanceOnlineCardReadiness(
  input: FinanceOnlineCardReadinessEvidence,
): FinanceOnlineCardReadinessDecision {
  if (
    typeof input.currencyEligible !== "boolean" ||
    !revision(input.propertyReadinessRevision, true)
  ) {
    throw new Error("Finance online-card currency evidence is invalid");
  }
  const account = providerAccount(input.providerAccount);
  const evidence = executionEvidence(input.executionEvidence);
  if (input.providerAccount !== null && !account) {
    throw new Error("Finance online-card provider evidence is invalid");
  }
  if (input.executionEvidence !== null && !evidence) {
    throw new Error("Finance online-card execution evidence is invalid");
  }
  if (!account) return "execution_unavailable";
  if (!input.currencyEligible) return "currency_unsupported";
  if (["restricted", "suspended", "disabled"].includes(account.status)) {
    return "provider_restricted";
  }
  if (
    account.provider !== "stripe" ||
    account.accountScope !== "property" ||
    !account.providerBindingActive ||
    account.status !== "active" ||
    account.onboardingStatus !== "completed" ||
    !account.chargesEnabled ||
    !account.payoutsEnabled ||
    !account.detailsSubmitted ||
    account.cardPaymentsStatus !== "active" ||
    !account.capabilities.includes("card_payments") ||
    account.cardCapabilityRevision < 1
  ) {
    return "provider_capability_lost";
  }
  return evidence &&
    evidence.contractVersion === FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION &&
    evidence.providerAccountId === account.id &&
    evidence.providerCapabilityRevision === account.cardCapabilityRevision &&
    evidence.propertyReadinessRevision === input.propertyReadinessRevision &&
    evidence.revokedAt === null
    ? "ready"
    : "execution_unavailable";
}

function providerAccount(
  value: FinanceOnlineCardReadinessEvidence["providerAccount"],
): FinanceOnlineCardReadinessEvidence["providerAccount"] | null {
  return value &&
    isExactRecord(value, [
      "id",
      "provider",
      "accountScope",
      "providerBindingActive",
      "status",
      "onboardingStatus",
      "chargesEnabled",
      "payoutsEnabled",
      "detailsSubmitted",
      "cardPaymentsStatus",
      "capabilities",
      "cardCapabilityRevision",
    ]) &&
    uuid(value.id) &&
    trimmedText(value.provider, 1, 50) &&
    trimmedText(value.accountScope, 1, 50) &&
    typeof value.providerBindingActive === "boolean" &&
    trimmedText(value.status, 1, 50) &&
    trimmedText(value.onboardingStatus, 1, 50) &&
    typeof value.chargesEnabled === "boolean" &&
    typeof value.payoutsEnabled === "boolean" &&
    typeof value.detailsSubmitted === "boolean" &&
    (value.cardPaymentsStatus === null || trimmedText(value.cardPaymentsStatus, 1, 50)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => trimmedText(capability, 1, 100)) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    revision(value.cardCapabilityRevision, true)
    ? deepFreeze({
        id: normalizeUuid(value.id),
        provider: value.provider,
        accountScope: value.accountScope,
        providerBindingActive: value.providerBindingActive,
        status: value.status,
        onboardingStatus: value.onboardingStatus,
        chargesEnabled: value.chargesEnabled,
        payoutsEnabled: value.payoutsEnabled,
        detailsSubmitted: value.detailsSubmitted,
        cardPaymentsStatus: value.cardPaymentsStatus,
        capabilities: [...value.capabilities],
        cardCapabilityRevision: value.cardCapabilityRevision,
      })
    : null;
}

function executionEvidence(
  value: FinanceOnlineCardReadinessEvidence["executionEvidence"],
): FinanceOnlineCardReadinessEvidence["executionEvidence"] | null {
  return value &&
    isExactRecord(value, [
      "contractVersion",
      "providerAccountId",
      "providerCapabilityRevision",
      "propertyReadinessRevision",
      "revokedAt",
    ]) &&
    trimmedText(value.contractVersion, 1, 200) &&
    uuid(value.providerAccountId) &&
    revision(value.providerCapabilityRevision, false) &&
    revision(value.propertyReadinessRevision, true) &&
    (value.revokedAt === null || isoDate(value.revokedAt))
    ? Object.freeze({
        contractVersion: value.contractVersion,
        providerAccountId: normalizeUuid(value.providerAccountId),
        providerCapabilityRevision: value.providerCapabilityRevision,
        propertyReadinessRevision: value.propertyReadinessRevision,
        revokedAt: value.revokedAt,
      })
    : null;
}

function parseMethods(
  value: unknown,
  allowEmpty: boolean,
): readonly FinancePaymentReadinessMethod[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return null;
  const methods = value.filter((item): item is FinancePaymentReadinessMethod =>
    FINANCE_PAYMENT_READINESS_METHODS.includes(item as FinancePaymentReadinessMethod),
  );
  if (methods.length !== value.length || new Set(methods).size !== methods.length) return null;
  return Object.freeze(
    FINANCE_PAYMENT_READINESS_METHODS.filter((method) => methods.includes(method)),
  );
}

function parsePricing(value: unknown): FinancePricingCurrencyEvidence | null | undefined {
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

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function revision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (allowZero ? Number(value) >= 0 : Number(value) >= 1) &&
    Number(value) <= 2_147_483_647
  );
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
function normalizeUuid(value: string): string {
  return value.toLowerCase();
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
