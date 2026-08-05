export const FINANCE_PAYMENT_READINESS_CONTRACT_VERSION = "finance-payment-readiness.v1" as const;

export const FINANCE_PAYMENT_READINESS_SOURCE_OWNER_DOMAIN = "finance" as const;
export const FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE = "finance_payment_methods.v1" as const;
export const FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION = "booking.payment-source" as const;

export const FINANCE_PAYMENT_READINESS_METHODS = [
  "pay_at_property",
  "card",
  "bank_transfer",
] as const;

export const FINANCE_PAYMENT_READINESS_BLOCKERS = [
  "payment_settings_uncommitted",
  "pricing_currency_unavailable",
  "pricing_currency_mismatch",
  "online_card_execution_unavailable",
  "provider_restricted",
  "provider_capability_lost",
  "bank_transfer_contract_unavailable",
] as const;

export const FINANCE_PAYMENT_READINESS_NEXT_ACTIONS = [
  "select_pay_at_property",
  "reload_payment_settings",
  "edit_pricing",
  "wait_for_online_card_execution",
  "wait_for_bank_transfer_contract",
] as const;

export const FINANCE_PAYMENT_READINESS_AUTHORIZATION = Object.freeze({
  permission: "pms.finance.manage",
  entitlement: Object.freeze({ product: "pms", key: "property-management" }),
  resource: Object.freeze({
    product: "pms",
    resourceType: "pms_property",
    allowedRelationships: Object.freeze(["owner", "finance_manager"] as const),
  }),
} as const);

export type FinancePaymentReadinessMethod = (typeof FINANCE_PAYMENT_READINESS_METHODS)[number];
export type FinancePaymentReadinessBlocker = (typeof FINANCE_PAYMENT_READINESS_BLOCKERS)[number];
export type FinancePaymentNextAction = (typeof FINANCE_PAYMENT_READINESS_NEXT_ACTIONS)[number];

export type FinancePaymentMethodReadiness = Readonly<{
  method: FinancePaymentReadinessMethod;
  selected: boolean;
  availability: "available" | "unavailable";
  readiness: "ready" | "unready";
  consequence: "not_selected" | "ready" | "warning" | "blocking";
  blockers: readonly FinancePaymentReadinessBlocker[];
  nextActions: readonly FinancePaymentNextAction[];
}>;

export type FinancePaymentReadinessSnapshot = Readonly<{
  contractVersion: typeof FINANCE_PAYMENT_READINESS_CONTRACT_VERSION;
  propertyId: string;
  paymentMethodsRevision: number;
  paymentsEnabled: boolean;
  pricingCurrency: Readonly<{
    committed: FinancePricingCurrencyEvidence | null;
    current: FinancePricingCurrencyEvidence | null;
    matchesCurrent: boolean;
  }>;
  bookingPaymentReady: boolean;
  selectedMethodCount: number;
  readyMethodCount: number;
  methods: readonly FinancePaymentMethodReadiness[];
  updatedAt: string | null;
}>;

export type FinancePaymentReadinessInput = Readonly<{
  propertyId: string;
  paymentMethodsRevision: number;
  selectedMethods: readonly FinancePaymentReadinessMethod[];
  committedPricing: FinancePricingCurrencyEvidence | null;
  currentPricing: FinancePricingCurrencyEvidence | null;
  updatedAt: string | null;
}>;

export type FinancePricingCurrencyEvidence = Readonly<{
  contractVersion: string;
  currency: string;
  pricingCurrencyRevision: number;
}>;

export type ReplaceFinancePaymentMethodsCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  idempotencyKey: string;
  expectedPaymentMethodsRevision: number;
  expectedPricingCurrencyRevision: number;
  selectedMethods: readonly FinancePaymentReadinessMethod[];
  audit: Readonly<{
    actor: Readonly<{ kind: "user"; userId: string }>;
    requestId: string;
    correlationId: string | null;
    requestedAt: string;
  }>;
}>;

export type ReplaceFinancePaymentMethodsResponse = Readonly<{
  contractVersion: typeof FINANCE_PAYMENT_READINESS_CONTRACT_VERSION;
  outcome: "created" | "updated";
  paymentReadiness: FinancePaymentReadinessSnapshot;
  acceptedAt: string;
}>;

export type ReplaceFinancePaymentMethodsError =
  | Readonly<{ code: "setup_scope_unavailable" }>
  | Readonly<{ code: "pricing_currency_unavailable" }>
  | Readonly<{ code: "payment_method_unavailable"; method: "bank_transfer" }>
  | Readonly<{
      code: "payment_methods_revision_conflict" | "pricing_currency_revision_conflict";
      currentRevision: number;
    }>
  | Readonly<{ code: "idempotency_key_conflict" | "command_in_progress" }>;

export type ReplaceFinancePaymentMethodsResult =
  | Readonly<{ ok: true; response: ReplaceFinancePaymentMethodsResponse }>
  | Readonly<{ ok: false; error: ReplaceFinancePaymentMethodsError }>;

export interface FinancePaymentReadinessReadPort {
  getPaymentReadiness(request: {
    organizationId: string;
    propertyId: string;
  }): Promise<FinancePaymentReadinessSnapshot | null>;
}

export interface FinancePaymentMethodsCommandPort {
  /**
   * Every retry is reauthorized before idempotency lookup. A matching completed
   * key returns the stored result exactly and emits no second audit, event, or
   * outbox intent; changed fingerprint input fails as idempotency_key_conflict.
   *
   * The application service holds the PMS shared currency-dependency guard
   * across the authoritative currency read and this repository call. The
   * repository then atomically reserves the key, locks scope, checks both
   * expected revisions, writes the Finance aggregate, and records audit,
   * finance.payment_readiness.changed, and booking.payment-source outbox rows.
   */
  replacePaymentMethods(
    command: ReplaceFinancePaymentMethodsCommand,
  ): Promise<ReplaceFinancePaymentMethodsResult>;
}

export type FinancePaymentReadinessChangedEvent = Readonly<{
  contractVersion: typeof FINANCE_PAYMENT_READINESS_CONTRACT_VERSION;
  eventType: "finance.payment_readiness.changed";
  organizationId: string;
  propertyId: string;
  paymentMethodsRevision: number;
  sourcePricingCurrencyRevision: number;
  outcome: "readiness_gained" | "readiness_lost" | "selection_changed";
  sourceReadRequired: true;
}>;

export type FinancePaymentMethodsSourceEntityRevision = Readonly<{
  ownerDomain: typeof FINANCE_PAYMENT_READINESS_SOURCE_OWNER_DOMAIN;
  entityType: typeof FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE;
  entityId: string;
  revision: string;
}>;

export function serializeFinancePaymentMethodsSourceRevision(revisionValue: number): string {
  if (!revision(revisionValue, false)) throw new Error("Payment-methods revision is invalid");
  return String(revisionValue);
}

export function createFinancePaymentMethodsSourceEntityRevision(
  propertyId: string,
  paymentMethodsRevision: number,
): FinancePaymentMethodsSourceEntityRevision {
  if (!canonicalUuid(propertyId)) throw new Error("Finance source property ID is invalid");
  return Object.freeze({
    ownerDomain: FINANCE_PAYMENT_READINESS_SOURCE_OWNER_DOMAIN,
    entityType: FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE,
    entityId: propertyId,
    revision: serializeFinancePaymentMethodsSourceRevision(paymentMethodsRevision),
  });
}

export function parseReplaceFinancePaymentMethodsCommand(
  value: unknown,
): ReplaceFinancePaymentMethodsCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "expectedPaymentMethodsRevision",
      "expectedPricingCurrencyRevision",
      "selectedMethods",
      "audit",
    ])
  )
    return null;
  const methods = parseMethods(value.selectedMethods);
  const audit = value.audit;
  if (
    !uuid(value.organizationId) ||
    !uuid(value.propertyId) ||
    !trimmedText(value.idempotencyKey, 1, 200) ||
    !revision(value.expectedPaymentMethodsRevision, true) ||
    !revision(value.expectedPricingCurrencyRevision, false) ||
    !methods ||
    !isExactRecord(audit, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isExactRecord(audit.actor, ["kind", "userId"]) ||
    audit.actor.kind !== "user" ||
    !uuid(audit.actor.userId) ||
    !trimmedText(audit.requestId, 1, 200) ||
    !(audit.correlationId === null || trimmedText(audit.correlationId, 1, 200)) ||
    !isoDate(audit.requestedAt)
  )
    return null;
  return deepFreeze({
    organizationId: normalizeUuid(value.organizationId),
    propertyId: normalizeUuid(value.propertyId),
    idempotencyKey: value.idempotencyKey,
    expectedPaymentMethodsRevision: value.expectedPaymentMethodsRevision,
    expectedPricingCurrencyRevision: value.expectedPricingCurrencyRevision,
    selectedMethods: methods,
    audit: {
      actor: { kind: "user", userId: normalizeUuid(audit.actor.userId) },
      requestId: audit.requestId,
      correlationId: audit.correlationId,
      requestedAt: audit.requestedAt,
    },
  });
}

export function serializeReplaceFinancePaymentMethodsFingerprint(
  command: ReplaceFinancePaymentMethodsCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    expectedPaymentMethodsRevision: command.expectedPaymentMethodsRevision,
    expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    selectedMethods: command.selectedMethods,
  });
}

function parseMethods(value: unknown): readonly FinancePaymentReadinessMethod[] | null {
  if (!Array.isArray(value)) return null;
  const methods = value.filter((item): item is FinancePaymentReadinessMethod =>
    FINANCE_PAYMENT_READINESS_METHODS.includes(item as FinancePaymentReadinessMethod),
  );
  if (methods.length !== value.length || new Set(methods).size !== methods.length) return null;
  return Object.freeze(
    FINANCE_PAYMENT_READINESS_METHODS.filter((method) => methods.includes(method)),
  );
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
function canonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
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
