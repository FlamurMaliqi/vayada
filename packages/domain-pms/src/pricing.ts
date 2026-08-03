export const PMS_PRICING_CONTRACT_VERSION = "pms-pricing.v1" as const;

export const PMS_PRICING_AUTHORIZATION = Object.freeze({
  permission: "pms.operations.manage",
  entitlement: Object.freeze({ product: "pms", key: "property-management" }),
  resource: Object.freeze({
    product: "pms",
    resourceType: "pms_property",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);

export const PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES = Object.freeze([
  "flexible_rate_plan",
  "legacy_room_type_price",
  "legacy_rate_plan",
  "rate_rule",
  "booking_reference",
  "payment_configuration",
  "published_reference",
  "other_pricing_configuration",
  "dependency_check_unavailable",
] as const);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/;

declare const pmsPricingCurrencyBrand: unique symbol;
declare const pmsDecimalAmountBrand: unique symbol;

export type PmsPricingContractVersion = typeof PMS_PRICING_CONTRACT_VERSION;
export type PmsPricingCurrency = string & { readonly [pmsPricingCurrencyBrand]: true };
export type PmsDecimalAmount = string & { readonly [pmsDecimalAmountBrand]: true };
export type PmsPricingCurrencyChangeBlockerCode =
  (typeof PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES)[number];

export type PmsPricingCommandAudit = {
  readonly actor:
    | { readonly kind: "user"; readonly userId: string }
    | { readonly kind: "system"; readonly service: string };
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly requestedAt: string;
};

type PmsPricingCommandContext = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly idempotencyKey: string;
  readonly audit: PmsPricingCommandAudit;
};

export type UpsertPropertyPricingCurrencyCommand = PmsPricingCommandContext & {
  readonly expectedPricingCurrencyRevision: number;
  readonly currency: PmsPricingCurrency;
};

export type FlexibleCancellationTerms = {
  readonly type: "free_until_days_before_arrival";
  readonly freeCancellationDeadlineDays: number;
  readonly afterDeadlinePenalty: "full_booking_amount";
  readonly noShowPenalty: "full_booking_amount";
};

export type UpsertFlexibleRatePlanCommand = PmsPricingCommandContext & {
  readonly roomTypeId: string;
  readonly expectedRoomFactsRevision: number;
  readonly expectedPricingCurrencyRevision: number;
  readonly expectedFlexibleRatePlanRevision: number;
  readonly baseAmountDecimal: PmsDecimalAmount;
  readonly cancellationTerms: FlexibleCancellationTerms;
};

export type PropertyPricingCurrencySnapshot = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly propertyId: string;
  readonly currency: PmsPricingCurrency;
  readonly pricingCurrencyRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type FlexibleRatePlanSnapshot = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly flexibleRatePlanId: string;
  readonly flexibleRatePlanRevision: number;
  readonly sourceRoomFactsRevision: number;
  readonly baseAmount: {
    readonly amountDecimal: PmsDecimalAmount;
    readonly currency: PmsPricingCurrency;
  };
  readonly cancellationTerms: FlexibleCancellationTerms;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Narrow PMS-owned evidence for Booking pricing/policy and Finance currency
 * consumers. The plan list is sorted by roomTypeId. Consumers fingerprint the
 * revisions they use; this contract deliberately contains no readiness claim,
 * quote calculation, payment capability, availability, or public state.
 */
export type PmsPricingSourceSnapshot = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly propertyId: string;
  readonly pricingCurrency: PropertyPricingCurrencySnapshot;
  readonly flexibleRatePlans: readonly FlexibleRatePlanSnapshot[];
  readonly capturedAt: string;
};

export type PmsPricingCurrencyChangeBlocker = {
  readonly code: PmsPricingCurrencyChangeBlockerCode;
  readonly affectedCount?: number;
};

type PmsPricingCoordinationError = {
  readonly code: "idempotency_key_conflict" | "command_in_progress";
};

type PmsPricingScopeError = { readonly code: "setup_scope_unavailable" };

export type PropertyPricingCurrencyCommandError =
  | { readonly code: "unsupported_pricing_currency" }
  | { readonly code: "pricing_currency_unchanged" }
  | {
      readonly code: "pricing_currency_revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly code: "pricing_currency_change_blocked";
      readonly currentRevision: number;
      readonly blockers: readonly PmsPricingCurrencyChangeBlocker[];
    }
  | PmsPricingScopeError
  | PmsPricingCoordinationError;

export type FlexibleRatePlanCommandError =
  | { readonly code: "pricing_currency_not_configured" }
  | {
      readonly code: "pricing_currency_revision_conflict";
      readonly currentRevision: number;
    }
  | { readonly code: "room_type_not_found" }
  | { readonly code: "room_facts_revision_conflict"; readonly currentRevision: number }
  | {
      readonly code: "flexible_rate_plan_revision_conflict";
      readonly currentRevision: number;
    }
  | { readonly code: "ambiguous_legacy_flexible_rate_plans" }
  | PmsPricingScopeError
  | PmsPricingCoordinationError;

export type PropertyPricingCurrencyCommandResponse = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly outcome: "created" | "updated";
  readonly pricingCurrency: PropertyPricingCurrencySnapshot;
  readonly acceptedAt: string;
};

export type FlexibleRatePlanCommandResponse = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly outcome: "created" | "updated";
  readonly flexibleRatePlan: FlexibleRatePlanSnapshot;
  readonly acceptedAt: string;
};

export type PropertyPricingCurrencyCommandResult =
  | { readonly ok: true; readonly response: PropertyPricingCurrencyCommandResponse }
  | { readonly ok: false; readonly error: PropertyPricingCurrencyCommandError };

export type FlexibleRatePlanCommandResult =
  | { readonly ok: true; readonly response: FlexibleRatePlanCommandResponse }
  | { readonly ok: false; readonly error: FlexibleRatePlanCommandError };

export type PmsPricingCommandPort = {
  /**
   * Every attempt is authorized for the current organization/property scope
   * before any idempotency lookup or replay. The repository rechecks that
   * scope under its property lock and fails closed as setup_scope_unavailable;
   * revoked access can never recover an old result.
   *
   * Keys are hashed and scoped by the exact PMS operation plus property. A
   * completed matching key replays its stored success or typed conflict
   * byte-for-byte without advancing revisions or duplicating audit, domain
   * event, or outbox rows. A matching in-progress key returns
   * command_in_progress. Reusing the scoped key with any changed fingerprint
   * input returns idempotency_key_conflict before aggregate/revision checks.
   *
   * One transaction contains the idempotency reservation, locked scope and
   * expected-revision checks, accepted pricing write, one product audit event,
   * one pms.pricing_source.changed domain event, its required transactional
   * outbox intent for Booking/Finance consumers, and the completed stored
   * result. Any failure rolls every category back. Event/outbox payloads carry
   * only property/plan IDs, revisions, and outcome; consumers obtain currency,
   * amounts, and structured terms through PmsPricingReadPort.
   */
  /**
   * Creates the property currency at revision 1 or compare-and-sets it to the
   * next revision. A different existing currency may change only after the
   * injected dependency guard and the PMS-local locked dependency check both
   * report no blockers. Numeric amounts are never converted or reinterpreted.
   */
  upsertPropertyPricingCurrency(
    command: UpsertPropertyPricingCurrencyCommand,
  ): Promise<PropertyPricingCurrencyCommandResult>;
  /**
   * Creates or updates the one stable flexible plan for an active room type.
   * The amount inherits the locked authoritative property currency; the
   * command cannot submit a second currency or write room/calendar state.
   */
  upsertFlexibleRatePlan(
    command: UpsertFlexibleRatePlanCommand,
  ): Promise<FlexibleRatePlanCommandResult>;
};

export type PmsPricingReadPort = {
  getPropertyPricingCurrency(propertyId: string): Promise<PropertyPricingCurrencySnapshot | null>;
  getFlexibleRatePlan(
    propertyId: string,
    roomTypeId: string,
  ): Promise<FlexibleRatePlanSnapshot | null>;
  listFlexibleRatePlans(propertyId: string): Promise<readonly FlexibleRatePlanSnapshot[]>;
  getPricingSourceSnapshot(propertyId: string): Promise<PmsPricingSourceSnapshot | null>;
};

export type PmsPricingCurrencyValidationPort = {
  isSupportedPricingCurrency(currency: PmsPricingCurrency): Promise<boolean>;
};

export type PmsPricingCurrencyChangeGuardPort = {
  /**
   * Holds the shared exclusive property-pricing-currency dependency guard for
   * the complete callback. Booking, Finance, publication, and every other
   * writer that can create a currency dependency must participate in the same
   * guard protocol. The pricing repository runs its PMS-local transaction and
   * currency compare-and-set inside `guarded`, after inspecting `blockers`.
   *
   * A source that cannot be locked/rechecked or whose state is unavailable
   * contributes dependency_check_unavailable. The guarded callback may then
   * persist only a typed blocked result; it must never change currency. This
   * prevents a point-in-time empty read from racing a new dependent write.
   */
  runWithCurrencyChangeGuard<Result>(
    input: {
      readonly propertyId: string;
      readonly currentCurrency: PmsPricingCurrency;
      readonly requestedCurrency: PmsPricingCurrency;
    },
    guarded: (blockers: readonly PmsPricingCurrencyChangeBlocker[]) => Promise<Result>,
  ): Promise<Result>;
};

/** Secret-safe change notification; consumers obtain current values through PmsPricingReadPort. */
export type PmsPricingSourceChangedEvent = {
  readonly contractVersion: PmsPricingContractVersion;
  readonly eventType: "pms.pricing_source.changed";
  readonly propertyId: string;
  readonly pricingCurrencyRevision: number;
  readonly flexibleRatePlanId: string | null;
  readonly flexibleRatePlanRevision: number | null;
  readonly outcome:
    | "currency_created"
    | "currency_updated"
    | "flexible_plan_created"
    | "flexible_plan_updated";
};

export function parsePmsPricingCurrency(value: unknown): PmsPricingCurrency | null {
  return typeof value === "string" && CURRENCY_PATTERN.test(value)
    ? (value as PmsPricingCurrency)
    : null;
}

/** V1 canonical money is a positive, normalized scale-2 decimal string. */
export function parsePmsDecimalAmount(value: unknown): PmsDecimalAmount | null {
  return typeof value === "string" && DECIMAL_AMOUNT_PATTERN.test(value) && value !== "0.00"
    ? (value as PmsDecimalAmount)
    : null;
}

export function parseFlexibleCancellationTerms(value: unknown): FlexibleCancellationTerms | null {
  if (
    !isExactRecord(value, [
      "type",
      "freeCancellationDeadlineDays",
      "afterDeadlinePenalty",
      "noShowPenalty",
    ]) ||
    value["type"] !== "free_until_days_before_arrival" ||
    !isIntegerInRange(value["freeCancellationDeadlineDays"], 0, 365) ||
    value["afterDeadlinePenalty"] !== "full_booking_amount" ||
    value["noShowPenalty"] !== "full_booking_amount"
  ) {
    return null;
  }
  return Object.freeze({
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: value["freeCancellationDeadlineDays"],
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  });
}

export function parseUpsertPropertyPricingCurrencyCommand(
  value: unknown,
): UpsertPropertyPricingCurrencyCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "audit",
      "expectedPricingCurrencyRevision",
      "currency",
    ]) ||
    !isRevision(value["expectedPricingCurrencyRevision"], true)
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  const currency = parsePmsPricingCurrency(value["currency"]);
  return context && currency
    ? Object.freeze({
        ...context,
        expectedPricingCurrencyRevision: value["expectedPricingCurrencyRevision"],
        currency,
      })
    : null;
}

export function parseUpsertFlexibleRatePlanCommand(
  value: unknown,
): UpsertFlexibleRatePlanCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "audit",
      "roomTypeId",
      "expectedRoomFactsRevision",
      "expectedPricingCurrencyRevision",
      "expectedFlexibleRatePlanRevision",
      "baseAmountDecimal",
      "cancellationTerms",
    ]) ||
    !isUuid(value["roomTypeId"]) ||
    !isRevision(value["expectedRoomFactsRevision"], false) ||
    !isRevision(value["expectedPricingCurrencyRevision"], false) ||
    !isRevision(value["expectedFlexibleRatePlanRevision"], true)
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  const amount = parsePmsDecimalAmount(value["baseAmountDecimal"]);
  const cancellationTerms = parseFlexibleCancellationTerms(value["cancellationTerms"]);
  return context && amount && cancellationTerms
    ? Object.freeze({
        ...context,
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRoomFactsRevision: value["expectedRoomFactsRevision"],
        expectedPricingCurrencyRevision: value["expectedPricingCurrencyRevision"],
        expectedFlexibleRatePlanRevision: value["expectedFlexibleRatePlanRevision"],
        baseAmountDecimal: amount,
        cancellationTerms,
      })
    : null;
}

export function serializePropertyPricingCurrencyFingerprint(
  command: UpsertPropertyPricingCurrencyCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    currency: command.currency,
  });
}

export function serializeFlexibleRatePlanFingerprint(
  command: UpsertFlexibleRatePlanCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRoomFactsRevision: command.expectedRoomFactsRevision,
    expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    expectedFlexibleRatePlanRevision: command.expectedFlexibleRatePlanRevision,
    baseAmountDecimal: command.baseAmountDecimal,
    cancellationTerms: command.cancellationTerms,
  });
}

export function parsePropertyPricingCurrencySnapshot(
  value: unknown,
): PropertyPricingCurrencySnapshot | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "propertyId",
      "currency",
      "pricingCurrencyRevision",
      "createdAt",
      "updatedAt",
    ]) ||
    value["contractVersion"] !== PMS_PRICING_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isRevision(value["pricingCurrencyRevision"], false) ||
    !isIsoDateTime(value["createdAt"]) ||
    !isIsoDateTime(value["updatedAt"])
  ) {
    return null;
  }
  const currency = parsePmsPricingCurrency(value["currency"]);
  return currency
    ? Object.freeze({
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        propertyId: normalizeUuid(value["propertyId"]),
        currency,
        pricingCurrencyRevision: value["pricingCurrencyRevision"],
        createdAt: value["createdAt"],
        updatedAt: value["updatedAt"],
      })
    : null;
}

export function parseFlexibleRatePlanSnapshot(value: unknown): FlexibleRatePlanSnapshot | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "propertyId",
      "roomTypeId",
      "flexibleRatePlanId",
      "flexibleRatePlanRevision",
      "sourceRoomFactsRevision",
      "baseAmount",
      "cancellationTerms",
      "createdAt",
      "updatedAt",
    ]) ||
    value["contractVersion"] !== PMS_PRICING_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isUuid(value["flexibleRatePlanId"]) ||
    !isRevision(value["flexibleRatePlanRevision"], false) ||
    !isRevision(value["sourceRoomFactsRevision"], false) ||
    !isIsoDateTime(value["createdAt"]) ||
    !isIsoDateTime(value["updatedAt"]) ||
    !isExactRecord(value["baseAmount"], ["amountDecimal", "currency"])
  ) {
    return null;
  }
  const amount = parsePmsDecimalAmount(value["baseAmount"]["amountDecimal"]);
  const currency = parsePmsPricingCurrency(value["baseAmount"]["currency"]);
  const cancellationTerms = parseFlexibleCancellationTerms(value["cancellationTerms"]);
  return amount && currency && cancellationTerms
    ? Object.freeze({
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        propertyId: normalizeUuid(value["propertyId"]),
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        flexibleRatePlanId: normalizeUuid(value["flexibleRatePlanId"]),
        flexibleRatePlanRevision: value["flexibleRatePlanRevision"],
        sourceRoomFactsRevision: value["sourceRoomFactsRevision"],
        baseAmount: Object.freeze({ amountDecimal: amount, currency }),
        cancellationTerms,
        createdAt: value["createdAt"],
        updatedAt: value["updatedAt"],
      })
    : null;
}

export function parsePmsPricingSourceSnapshot(value: unknown): PmsPricingSourceSnapshot | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "propertyId",
      "pricingCurrency",
      "flexibleRatePlans",
      "capturedAt",
    ]) ||
    value["contractVersion"] !== PMS_PRICING_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !Array.isArray(value["flexibleRatePlans"]) ||
    !isIsoDateTime(value["capturedAt"])
  ) {
    return null;
  }
  const propertyId = normalizeUuid(value["propertyId"]);
  const pricingCurrency = parsePropertyPricingCurrencySnapshot(value["pricingCurrency"]);
  const plans = value["flexibleRatePlans"].map(parseFlexibleRatePlanSnapshot);
  if (
    !pricingCurrency ||
    plans.some((plan) => !plan) ||
    pricingCurrency.propertyId !== propertyId
  ) {
    return null;
  }
  const parsedPlans = plans as FlexibleRatePlanSnapshot[];
  const roomIds = parsedPlans.map(({ roomTypeId }) => roomTypeId);
  if (
    new Set(roomIds).size !== roomIds.length ||
    parsedPlans.some(
      (plan) =>
        plan.propertyId !== propertyId || plan.baseAmount.currency !== pricingCurrency.currency,
    ) ||
    roomIds.some((roomTypeId, index) => index > 0 && roomIds[index - 1]! >= roomTypeId)
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrency,
    flexibleRatePlans: Object.freeze(parsedPlans),
    capturedAt: value["capturedAt"],
  });
}

export function parsePropertyPricingCurrencyCommandResponse(
  value: unknown,
): PropertyPricingCurrencyCommandResponse | null {
  if (
    !isExactRecord(value, ["contractVersion", "outcome", "pricingCurrency", "acceptedAt"]) ||
    value["contractVersion"] !== PMS_PRICING_CONTRACT_VERSION ||
    !isOneOf(value["outcome"], ["created", "updated"] as const) ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const pricingCurrency = parsePropertyPricingCurrencySnapshot(value["pricingCurrency"]);
  return pricingCurrency
    ? Object.freeze({
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        outcome: value["outcome"],
        pricingCurrency,
        acceptedAt: value["acceptedAt"],
      })
    : null;
}

export function parseFlexibleRatePlanCommandResponse(
  value: unknown,
): FlexibleRatePlanCommandResponse | null {
  if (
    !isExactRecord(value, ["contractVersion", "outcome", "flexibleRatePlan", "acceptedAt"]) ||
    value["contractVersion"] !== PMS_PRICING_CONTRACT_VERSION ||
    !isOneOf(value["outcome"], ["created", "updated"] as const) ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const flexibleRatePlan = parseFlexibleRatePlanSnapshot(value["flexibleRatePlan"]);
  return flexibleRatePlan
    ? Object.freeze({
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        outcome: value["outcome"],
        flexibleRatePlan,
        acceptedAt: value["acceptedAt"],
      })
    : null;
}

export function parsePropertyPricingCurrencyCommandResult(
  value: unknown,
): PropertyPricingCurrencyCommandResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"]) {
    if (!isExactRecord(value, ["ok", "response"])) return null;
    const response = parsePropertyPricingCurrencyCommandResponse(value["response"]);
    return response ? Object.freeze({ ok: true, response }) : null;
  }
  if (!isExactRecord(value, ["ok", "error"])) return null;
  const error = parsePropertyPricingCurrencyCommandError(value["error"]);
  return error ? Object.freeze({ ok: false, error }) : null;
}

export function parseFlexibleRatePlanCommandResult(
  value: unknown,
): FlexibleRatePlanCommandResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"]) {
    if (!isExactRecord(value, ["ok", "response"])) return null;
    const response = parseFlexibleRatePlanCommandResponse(value["response"]);
    return response ? Object.freeze({ ok: true, response }) : null;
  }
  if (!isExactRecord(value, ["ok", "error"])) return null;
  const error = parseFlexibleRatePlanCommandError(value["error"]);
  return error ? Object.freeze({ ok: false, error }) : null;
}

function parsePropertyPricingCurrencyCommandError(
  value: unknown,
): PropertyPricingCurrencyCommandError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    isOneOf(value["code"], [
      "unsupported_pricing_currency",
      "pricing_currency_unchanged",
      "setup_scope_unavailable",
      "idempotency_key_conflict",
      "command_in_progress",
    ] as const)
  ) {
    return Object.freeze({ code: value["code"] });
  }
  if (
    isExactRecord(value, ["code", "currentRevision"]) &&
    value["code"] === "pricing_currency_revision_conflict" &&
    isRevision(value["currentRevision"], true)
  ) {
    return Object.freeze({ code: value["code"], currentRevision: value["currentRevision"] });
  }
  if (
    isExactRecord(value, ["code", "currentRevision", "blockers"]) &&
    value["code"] === "pricing_currency_change_blocked" &&
    isRevision(value["currentRevision"], true) &&
    Array.isArray(value["blockers"])
  ) {
    const blockers = parseCurrencyChangeBlockers(value["blockers"]);
    return blockers
      ? Object.freeze({
          code: value["code"],
          currentRevision: value["currentRevision"],
          blockers,
        })
      : null;
  }
  return null;
}

function parseFlexibleRatePlanCommandError(value: unknown): FlexibleRatePlanCommandError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    isOneOf(value["code"], [
      "pricing_currency_not_configured",
      "room_type_not_found",
      "ambiguous_legacy_flexible_rate_plans",
      "setup_scope_unavailable",
      "idempotency_key_conflict",
      "command_in_progress",
    ] as const)
  ) {
    return Object.freeze({ code: value["code"] });
  }
  if (
    isExactRecord(value, ["code", "currentRevision"]) &&
    isOneOf(value["code"], [
      "pricing_currency_revision_conflict",
      "room_facts_revision_conflict",
      "flexible_rate_plan_revision_conflict",
    ] as const) &&
    isRevision(value["currentRevision"], value["code"] === "flexible_rate_plan_revision_conflict")
  ) {
    return Object.freeze({ code: value["code"], currentRevision: value["currentRevision"] });
  }
  return null;
}

function parseCurrencyChangeBlockers(
  values: readonly unknown[],
): readonly PmsPricingCurrencyChangeBlocker[] | null {
  if (values.length === 0) return null;
  const blockers = values.map((value) => {
    if (
      !isRecord(value) ||
      !(isExactRecord(value, ["code"]) || isExactRecord(value, ["code", "affectedCount"])) ||
      !isOneOf(value["code"], PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES) ||
      ("affectedCount" in value && !isIntegerInRange(value["affectedCount"], 1, 2_147_483_647))
    ) {
      return null;
    }
    return Object.freeze({
      code: value["code"],
      ...(value["affectedCount"] === undefined
        ? {}
        : { affectedCount: value["affectedCount"] as number }),
    });
  });
  if (blockers.some((blocker) => !blocker)) return null;
  const parsed = blockers as PmsPricingCurrencyChangeBlocker[];
  const positions = parsed.map(({ code }) =>
    PMS_PRICING_CURRENCY_CHANGE_BLOCKER_CODES.indexOf(code),
  );
  if (positions.some((position, index) => index > 0 && positions[index - 1]! >= position)) {
    return null;
  }
  return Object.freeze(parsed);
}

function parseCommandContext(value: Record<string, unknown>): PmsPricingCommandContext | null {
  if (
    !isUuid(value["organizationId"]) ||
    !isUuid(value["propertyId"]) ||
    !isTrimmedText(value["idempotencyKey"], 1, 200) ||
    !isExactRecord(value["audit"], ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isTrimmedText(value["audit"]["requestId"], 1, 200) ||
    !(
      value["audit"]["correlationId"] === null ||
      isTrimmedText(value["audit"]["correlationId"], 1, 200)
    ) ||
    !isIsoDateTime(value["audit"]["requestedAt"])
  ) {
    return null;
  }
  const actor = parseAuditActor(value["audit"]["actor"]);
  return actor
    ? Object.freeze({
        organizationId: normalizeUuid(value["organizationId"]),
        propertyId: normalizeUuid(value["propertyId"]),
        idempotencyKey: value["idempotencyKey"],
        audit: Object.freeze({
          actor,
          requestId: value["audit"]["requestId"],
          correlationId: value["audit"]["correlationId"],
          requestedAt: value["audit"]["requestedAt"],
        }),
      })
    : null;
}

function parseAuditActor(value: unknown): PmsPricingCommandAudit["actor"] | null {
  if (!isRecord(value)) return null;
  if (
    value["kind"] === "user" &&
    isExactRecord(value, ["kind", "userId"]) &&
    isUuid(value["userId"])
  ) {
    return Object.freeze({ kind: "user", userId: normalizeUuid(value["userId"]) });
  }
  if (
    value["kind"] === "system" &&
    isExactRecord(value, ["kind", "service"]) &&
    isTrimmedText(value["service"], 1, 200)
  ) {
    return Object.freeze({ kind: "system", service: value["service"] });
  }
  return null;
}

function isRevision(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (allowZero ? (value as number) >= 0 : (value as number) >= 1) &&
    (value as number) <= 2_147_483_647
  );
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function isIsoDateTime(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function isTrimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
