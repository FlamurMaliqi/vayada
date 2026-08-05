import {
  parsePmsDecimalAmount,
  parsePmsPricingCurrency,
  type PmsDecimalAmount,
  type PmsPricingCommandAudit,
  type PmsPricingCurrency,
} from "./pricing.js";

export const PMS_RECURRING_PRICING_CONTRACT_VERSION = "pms-recurring-pricing.v1" as const;

/** Stable SourceEntityRevision coordinates for Booking/readiness consumers. */
export const PMS_PRICING_SOURCE_IDENTITY_VERSION = "pms-pricing-source-identity.v1" as const;
export const PMS_PRICING_SOURCE_OWNER_DOMAIN = "pms" as const;
export const PMS_PRICING_SOURCE_ENTITY_TYPES = Object.freeze({
  propertyPricingCurrency: "pms_property_pricing_currency.v1",
  flexibleRatePlan: "pms_flexible_rate_plan.v1",
  recurringPricingRule: "pms_recurring_pricing_rule.v1",
  optionalPricingAggregate: "pms_optional_pricing_aggregate.v1",
} as const);

export type PmsPricingSourceEntityType =
  (typeof PMS_PRICING_SOURCE_ENTITY_TYPES)[keyof typeof PMS_PRICING_SOURCE_ENTITY_TYPES];

/** Portable PMS-owned coordinates compatible with domain-hotels SourceEntityRevision. */
export type PmsPricingSourceEntityRevision = {
  readonly ownerDomain: typeof PMS_PRICING_SOURCE_OWNER_DOMAIN;
  readonly entityType: PmsPricingSourceEntityType;
  readonly entityId: string;
  readonly revision: string;
};

export const PMS_RECURRING_PRICING_AUTHORIZATION = Object.freeze({
  permission: "pms.operations.manage",
  entitlement: Object.freeze({ product: "pms", key: "property-management" }),
  resource: Object.freeze({
    product: "pms",
    resourceType: "pms_property",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);

export const PMS_RECURRING_PRICING_SOURCE_KINDS = Object.freeze([
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const);

export const PMS_RECURRING_PRICING_WEEKDAYS = Object.freeze([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const);

export const PMS_RECURRING_PRICING_INVALID_REASON_CODES = Object.freeze([
  "pricing_currency_mismatch",
  "pricing_currency_revision_stale",
  "room_type_missing",
  "room_facts_revision_stale",
  "flexible_rate_plan_missing",
  "flexible_rate_plan_revision_stale",
  "recurring_pricing_room_plan_missing",
  "season_overlap",
  "additional_guest_capacity_inapplicable",
  "non_refundable_payment_timing_invalid",
  "dependency_unavailable",
] as const);

/** A materialization request is deliberately bounded and contains no calendar authoring state. */
export const PMS_RECURRING_PRICING_MAX_HORIZON_DAYS = 366 as const;

const NON_NEGATIVE_DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

declare const pmsNonNegativeDecimalAmountBrand: unique symbol;
declare const pmsRecurringDateBrand: unique symbol;
declare const pmsRecurringMonthDayBrand: unique symbol;

export type PmsRecurringPricingContractVersion = typeof PMS_RECURRING_PRICING_CONTRACT_VERSION;
export type PmsRecurringPricingSourceKind = (typeof PMS_RECURRING_PRICING_SOURCE_KINDS)[number];
export type PmsRecurringPricingWeekday = (typeof PMS_RECURRING_PRICING_WEEKDAYS)[number];
export type PmsRecurringPricingInvalidReasonCode =
  (typeof PMS_RECURRING_PRICING_INVALID_REASON_CODES)[number];
export type PmsNonNegativeDecimalAmount = string & {
  readonly [pmsNonNegativeDecimalAmountBrand]: true;
};
export type PmsRecurringDate = string & { readonly [pmsRecurringDateBrand]: true };
export type PmsRecurringMonthDay = string & { readonly [pmsRecurringMonthDayBrand]: true };

type PmsRecurringPricingCommandContext = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly idempotencyKey: string;
  readonly audit: PmsPricingCommandAudit;
};

type PmsRecurringPricingUpsertContext = PmsRecurringPricingCommandContext & {
  /** Stable UUID supplied by the caller on create and every later edit/re-enable. */
  readonly sourceId: string;
  /** Zero creates; a positive compare-and-set revision edits or re-enables. */
  readonly expectedSourceRevision: number;
  readonly expectedPricingCurrencyRevision: number;
};

export type RecurringPricingRoomCommandEvidence = {
  readonly roomTypeId: string;
  readonly expectedRoomFactsRevision: number;
  readonly flexibleRatePlanId: string;
  readonly expectedFlexibleRatePlanRevision: number;
};

export type RecurringPricingRoomEvidence = {
  readonly roomTypeId: string;
  readonly roomFactsRevision: number;
  readonly flexibleRatePlanId: string;
  readonly flexibleRatePlanRevision: number;
};

export type RecurringSeasonRoomPriceCommand = RecurringPricingRoomCommandEvidence & {
  readonly amountDecimal: PmsDecimalAmount;
};

export type RecurringSeasonRoomPrice = RecurringPricingRoomEvidence & {
  readonly amountDecimal: PmsDecimalAmount;
};

export type WeekendRoomSurchargeCommand = RecurringPricingRoomCommandEvidence & {
  readonly amountDecimal: PmsNonNegativeDecimalAmount;
};

export type WeekendRoomSurcharge = RecurringPricingRoomEvidence & {
  readonly amountDecimal: PmsNonNegativeDecimalAmount;
};

export type UpsertRecurringSeasonCommand = PmsRecurringPricingUpsertContext & {
  readonly sourceKind: "season";
  readonly name: string;
  readonly startMonthDay: PmsRecurringMonthDay;
  readonly endMonthDay: PmsRecurringMonthDay;
  readonly roomPrices: readonly RecurringSeasonRoomPriceCommand[];
};

export type UpsertWeekendSurchargeCommand = PmsRecurringPricingUpsertContext & {
  readonly sourceKind: "weekend_surcharge";
  readonly weekdays: readonly PmsRecurringPricingWeekday[];
  readonly roomSurcharges: readonly WeekendRoomSurchargeCommand[];
};

export type UpsertAdditionalGuestPricingCommand = PmsRecurringPricingUpsertContext &
  RecurringPricingRoomCommandEvidence & {
    readonly sourceKind: "additional_guest";
    readonly includedGuests: number;
    readonly amountDecimal: PmsNonNegativeDecimalAmount;
  };

export type NonRefundableCancellationTerms = {
  readonly type: "non_refundable";
  readonly refundPolicy: "no_refund";
  readonly noShowPenalty: "full_booking_amount";
};

export type UpsertNonRefundablePricingCommand = PmsRecurringPricingUpsertContext & {
  readonly sourceKind: "non_refundable";
  readonly discountPercent: number;
  /** Complete active-room/flexible-plan evidence for the hotel-wide default. */
  readonly roomPlans: readonly RecurringPricingRoomCommandEvidence[];
};

export type UpsertRecurringPricingSourceCommand =
  | UpsertRecurringSeasonCommand
  | UpsertWeekendSurchargeCommand
  | UpsertAdditionalGuestPricingCommand
  | UpsertNonRefundablePricingCommand;

export type DisableRecurringPricingSourceCommand = PmsRecurringPricingCommandContext & {
  readonly sourceId: string;
  readonly sourceKind: PmsRecurringPricingSourceKind;
  readonly expectedSourceRevision: number;
};

export type PmsRecurringPricingInvalidReason =
  | {
      readonly code:
        | "pricing_currency_mismatch"
        | "pricing_currency_revision_stale"
        | "non_refundable_payment_timing_invalid"
        | "dependency_unavailable";
    }
  | {
      readonly code:
        | "room_type_missing"
        | "room_facts_revision_stale"
        | "flexible_rate_plan_missing"
        | "flexible_rate_plan_revision_stale"
        | "recurring_pricing_room_plan_missing"
        | "additional_guest_capacity_inapplicable";
      readonly roomTypeId: string;
    }
  | {
      readonly code: "season_overlap";
      readonly conflictingSourceId: string;
    };

export type PmsRecurringPricingConfiguredState = "active" | "disabled";

export type PmsRecurringPricingValidation =
  | {
      readonly state: "valid";
      readonly validationRevision: number;
      readonly validatedAt: string;
    }
  | {
      readonly state: "invalid";
      readonly validationRevision: number;
      readonly validatedAt: string;
      readonly reasons: readonly PmsRecurringPricingInvalidReason[];
    };

/** Derived as configured disabled, then validation invalid, otherwise active. */
export type PmsRecurringPricingSourceLifecycle = "active" | "disabled" | "invalid";

type PmsRecurringPricingSourceSnapshotBase = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly propertyId: string;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly pricingCurrencyRevision: number;
  readonly currency: PmsPricingCurrency;
  readonly configuredState: PmsRecurringPricingConfiguredState;
  readonly validation: PmsRecurringPricingValidation;
  readonly lifecycle: PmsRecurringPricingSourceLifecycle;
  /** Derived-row replacement/revalidation advances this, never sourceRevision. */
  readonly materializationRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RecurringSeasonSnapshot = PmsRecurringPricingSourceSnapshotBase & {
  readonly sourceKind: "season";
  readonly name: string;
  readonly startMonthDay: PmsRecurringMonthDay;
  readonly endMonthDay: PmsRecurringMonthDay;
  readonly roomPrices: readonly RecurringSeasonRoomPrice[];
};

export type WeekendSurchargeSnapshot = PmsRecurringPricingSourceSnapshotBase & {
  readonly sourceKind: "weekend_surcharge";
  readonly weekdays: readonly PmsRecurringPricingWeekday[];
  readonly roomSurcharges: readonly WeekendRoomSurcharge[];
};

export type AdditionalGuestPricingSnapshot = PmsRecurringPricingSourceSnapshotBase &
  RecurringPricingRoomEvidence & {
    readonly sourceKind: "additional_guest";
    readonly maximumAdultGuests: number;
    readonly includedGuests: number;
    readonly amountDecimal: PmsNonNegativeDecimalAmount;
  };

export type NonRefundablePricingSnapshot = PmsRecurringPricingSourceSnapshotBase & {
  readonly sourceKind: "non_refundable";
  readonly discountPercent: number;
  /** Complete active-room/flexible-plan evidence for the hotel-wide default. */
  readonly roomPlans: readonly RecurringPricingRoomEvidence[];
  readonly paymentTiming: "prepay_full";
  readonly cancellationTerms: NonRefundableCancellationTerms;
};

export type PmsRecurringPricingSourceSnapshot =
  | RecurringSeasonSnapshot
  | WeekendSurchargeSnapshot
  | AdditionalGuestPricingSnapshot
  | NonRefundablePricingSnapshot;

/**
 * Booking consumes only PMS-authored source configuration and exact revision
 * evidence. This snapshot makes no quote, payment-readiness, availability, or
 * publication claim. Sources are ordered by source kind and then source UUID;
 * disabled and invalid sources remain visible.
 */
export type PmsRecurringPricingBookingEvidence = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly propertyId: string;
  readonly pricingCurrencyRevision: number;
  /** Advances only when owner-authored optional source configuration changes. */
  readonly optionalPricingAggregateRevision: number;
  readonly currency: PmsPricingCurrency;
  readonly sources: readonly PmsRecurringPricingSourceSnapshot[];
  readonly capturedAt: string;
};

export type MaterializeRecurringPricingCommand = PmsRecurringPricingCommandContext & {
  readonly fromDate: PmsRecurringDate;
  readonly throughDate: PmsRecurringDate;
  /** Compare-and-set for the complete optional-pricing source aggregate. */
  readonly expectedOptionalPricingAggregateRevision: number;
};

export type RecurringPricingMaterializationSourceReceipt = {
  readonly sourceKind: PmsRecurringPricingSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly configuredState: PmsRecurringPricingConfiguredState;
  readonly validation: PmsRecurringPricingValidation;
  readonly lifecycle: PmsRecurringPricingSourceLifecycle;
  readonly materializationRevision: number;
  readonly currency: PmsPricingCurrency;
  readonly pricingCurrencyRevision: number;
  readonly result: "materialized" | "skipped_disabled" | "skipped_invalid";
  readonly materializedRowCount: number;
  /** SHA-256 of the canonical derived rows; empty materializations hash an empty canonical list. */
  readonly materializedRowsSha256: string;
};

export type RecurringPricingMaterializationReceipt = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly receiptId: string;
  readonly propertyId: string;
  readonly optionalPricingAggregateRevision: number;
  readonly fromDate: PmsRecurringDate;
  readonly throughDate: PmsRecurringDate;
  readonly sources: readonly RecurringPricingMaterializationSourceReceipt[];
  readonly acceptedAt: string;
};

type PmsRecurringPricingCoordinationError = {
  readonly code: "idempotency_key_conflict" | "command_in_progress";
};

type PmsRecurringPricingScopeError = { readonly code: "setup_scope_unavailable" };

export type PmsRecurringPricingCommandError =
  | { readonly code: "source_not_found" }
  | { readonly code: "source_kind_conflict" }
  | { readonly code: "pricing_currency_not_configured" }
  | { readonly code: "season_name_conflict"; readonly conflictingSourceId: string }
  | {
      readonly code: "season_overlap";
      readonly conflictingSourceIds: readonly string[];
    }
  | { readonly code: "room_type_not_found"; readonly roomTypeId: string }
  | { readonly code: "flexible_rate_plan_not_found"; readonly roomTypeId: string }
  | {
      readonly code: "additional_guest_capacity_inapplicable";
      readonly roomTypeId: string;
      readonly maximumAdultGuests: number;
    }
  | {
      readonly code: "source_revision_conflict" | "pricing_currency_revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly code: "optional_pricing_aggregate_revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly code: "room_facts_revision_conflict" | "flexible_rate_plan_revision_conflict";
      readonly roomTypeId: string;
      readonly currentRevision: number;
    }
  | {
      readonly code: "recurring_pricing_room_plan_set_incomplete";
      readonly sourceKind: "season" | "weekend_surcharge" | "non_refundable";
      readonly missingRoomTypeIds: readonly string[];
    }
  | PmsRecurringPricingScopeError
  | PmsRecurringPricingCoordinationError;

export type PmsRecurringPricingCommandResponse = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly outcome: "created" | "updated" | "re_enabled" | "disabled";
  readonly source: PmsRecurringPricingSourceSnapshot;
  readonly optionalPricingAggregateRevision: number;
  readonly acceptedAt: string;
};

export type PmsRecurringPricingCommandResult =
  | { readonly ok: true; readonly response: PmsRecurringPricingCommandResponse }
  | { readonly ok: false; readonly error: PmsRecurringPricingCommandError };

export type RecurringPricingMaterializationResult =
  | { readonly ok: true; readonly receipt: RecurringPricingMaterializationReceipt }
  | { readonly ok: false; readonly error: PmsRecurringPricingCommandError };

export type PmsRecurringPricingCommandPort = {
  /**
   * Each method authorizes the current organization/property scope before
   * idempotency replay. A completed matching key replays byte-for-byte; a
   * changed business fingerprint returns idempotency_key_conflict. The same
   * transaction persists source/revision/lifecycle, audit, domain event,
   * outbox intent, and completed idempotency result.
   *
   * Upsert creates, edits, or re-enables exactly one caller-identified source.
   * The adapter locks and verifies VAY-1069 currency/flexible-plan evidence and
   * room-facts revisions. It also validates case-insensitive season-name
   * uniqueness, annual overlap, and additional-guest capacity applicability.
   */
  upsertRecurringSeason(
    command: UpsertRecurringSeasonCommand,
  ): Promise<PmsRecurringPricingCommandResult>;
  upsertWeekendSurcharge(
    command: UpsertWeekendSurchargeCommand,
  ): Promise<PmsRecurringPricingCommandResult>;
  upsertAdditionalGuestPricing(
    command: UpsertAdditionalGuestPricingCommand,
  ): Promise<PmsRecurringPricingCommandResult>;
  upsertNonRefundablePricing(
    command: UpsertNonRefundablePricingCommand,
  ): Promise<PmsRecurringPricingCommandResult>;
  /** Disable preserves the definition and stable ID while advancing its revision. */
  disableRecurringPricingSource(
    command: DisableRecurringPricingSourceCommand,
  ): Promise<PmsRecurringPricingCommandResult>;
  /**
   * Materialization replaces derived dated rows for every optional source in
   * the requested bounded horizon under aggregate compare-and-set. It never
   * edits source identity, revision, definition, or lifecycle and records
   * skipped disabled/invalid sources in the receipt.
   */
  materializeRecurringPricing(
    command: MaterializeRecurringPricingCommand,
  ): Promise<RecurringPricingMaterializationResult>;
};

export type PmsRecurringPricingReadPort = {
  getRecurringPricingSource(
    propertyId: string,
    sourceId: string,
  ): Promise<PmsRecurringPricingSourceSnapshot | null>;
  listRecurringPricingSources(
    propertyId: string,
  ): Promise<readonly PmsRecurringPricingSourceSnapshot[]>;
  getRecurringPricingBookingEvidence(
    propertyId: string,
  ): Promise<PmsRecurringPricingBookingEvidence | null>;
};

export type PmsRecurringPricingSourceChangedEvent = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly eventType: "pms.recurring_pricing_source.changed";
  readonly propertyId: string;
  readonly sourceKind: PmsRecurringPricingSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly optionalPricingAggregateRevision: number;
  readonly lifecycle: PmsRecurringPricingSourceLifecycle;
  readonly outcome: "created" | "updated" | "re_enabled" | "disabled";
};

export type PmsRecurringPricingMaterializedEventSource = {
  readonly sourceKind: PmsRecurringPricingSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly materializationRevision: number;
  readonly lifecycle: PmsRecurringPricingSourceLifecycle;
  readonly result: "materialized" | "skipped_disabled" | "skipped_invalid";
  readonly materializedRowCount: number;
  readonly materializedRowsSha256: string;
};

/** Secret-safe outbox notification; Booking reads current definitions through the read port. */
export type PmsRecurringPricingMaterializedEvent = {
  readonly contractVersion: PmsRecurringPricingContractVersion;
  readonly eventType: "pms.recurring_pricing.materialized";
  readonly receiptId: string;
  readonly propertyId: string;
  readonly optionalPricingAggregateRevision: number;
  readonly fromDate: PmsRecurringDate;
  readonly throughDate: PmsRecurringDate;
  readonly sources: readonly PmsRecurringPricingMaterializedEventSource[];
};

export function parsePmsNonNegativeDecimalAmount(
  value: unknown,
): PmsNonNegativeDecimalAmount | null {
  return typeof value === "string" && NON_NEGATIVE_DECIMAL_AMOUNT_PATTERN.test(value)
    ? (value as PmsNonNegativeDecimalAmount)
    : null;
}

export function parsePmsRecurringDate(value: unknown): PmsRecurringDate | null {
  return isIsoDate(value) ? (value as PmsRecurringDate) : null;
}

export function parsePmsRecurringMonthDay(value: unknown): PmsRecurringMonthDay | null {
  if (typeof value !== "string" || !/^\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`2000-${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(5, 10) === value
    ? (value as PmsRecurringMonthDay)
    : null;
}

export function serializePmsPricingSourceEntityRevision(
  entityType: unknown,
  entityId: unknown,
  revision: unknown,
): PmsPricingSourceEntityRevision | null {
  if (
    !isOneOf(entityType, Object.values(PMS_PRICING_SOURCE_ENTITY_TYPES)) ||
    !isUuid(entityId) ||
    !isRevision(revision, true)
  ) {
    return null;
  }
  return Object.freeze({
    ownerDomain: PMS_PRICING_SOURCE_OWNER_DOMAIN,
    entityType,
    entityId: normalizeUuid(entityId),
    revision: String(revision),
  });
}

export function parsePmsPricingSourceEntityRevision(
  value: unknown,
): PmsPricingSourceEntityRevision | null {
  if (
    !isExactRecord(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    value["ownerDomain"] !== PMS_PRICING_SOURCE_OWNER_DOMAIN ||
    !isOneOf(value["entityType"], Object.values(PMS_PRICING_SOURCE_ENTITY_TYPES)) ||
    !isUuid(value["entityId"]) ||
    typeof value["revision"] !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(value["revision"])
  ) {
    return null;
  }
  const revision = Number(value["revision"]);
  return Number.isSafeInteger(revision) && revision <= 2_147_483_647
    ? Object.freeze({
        ownerDomain: PMS_PRICING_SOURCE_OWNER_DOMAIN,
        entityType: value["entityType"],
        entityId: normalizeUuid(value["entityId"]),
        revision: value["revision"],
      })
    : null;
}

export function parseNonRefundableCancellationTerms(
  value: unknown,
): NonRefundableCancellationTerms | null {
  return isExactRecord(value, ["type", "refundPolicy", "noShowPenalty"]) &&
    value["type"] === "non_refundable" &&
    value["refundPolicy"] === "no_refund" &&
    value["noShowPenalty"] === "full_booking_amount"
    ? Object.freeze({
        type: "non_refundable",
        refundPolicy: "no_refund",
        noShowPenalty: "full_booking_amount",
      })
    : null;
}

export function parseUpsertRecurringSeasonCommand(
  value: unknown,
): UpsertRecurringSeasonCommand | null {
  if (
    !isExactRecord(value, [
      ...UPSERT_CONTEXT_KEYS,
      "sourceKind",
      "name",
      "startMonthDay",
      "endMonthDay",
      "roomPrices",
    ]) ||
    value["sourceKind"] !== "season" ||
    !isTrimmedText(value["name"], 1, 100) ||
    !Array.isArray(value["roomPrices"])
  ) {
    return null;
  }
  const context = parseUpsertContext(value);
  const startMonthDay = parsePmsRecurringMonthDay(value["startMonthDay"]);
  const endMonthDay = parsePmsRecurringMonthDay(value["endMonthDay"]);
  const roomPrices = parseRoomMoneyCommands(value["roomPrices"], false);
  return context && startMonthDay && endMonthDay && roomPrices
    ? Object.freeze({
        ...context,
        sourceKind: "season",
        name: value["name"],
        startMonthDay,
        endMonthDay,
        roomPrices,
      })
    : null;
}

export function parseUpsertWeekendSurchargeCommand(
  value: unknown,
): UpsertWeekendSurchargeCommand | null {
  if (
    !isExactRecord(value, [...UPSERT_CONTEXT_KEYS, "sourceKind", "weekdays", "roomSurcharges"]) ||
    value["sourceKind"] !== "weekend_surcharge" ||
    !Array.isArray(value["weekdays"]) ||
    !Array.isArray(value["roomSurcharges"])
  ) {
    return null;
  }
  const context = parseUpsertContext(value);
  const weekdays = parseWeekdays(value["weekdays"]);
  const roomSurcharges = parseRoomMoneyCommands(value["roomSurcharges"], true);
  return context && weekdays && roomSurcharges
    ? Object.freeze({
        ...context,
        sourceKind: "weekend_surcharge",
        weekdays,
        roomSurcharges,
      })
    : null;
}

export function parseUpsertAdditionalGuestPricingCommand(
  value: unknown,
): UpsertAdditionalGuestPricingCommand | null {
  if (
    !isExactRecord(value, [
      ...UPSERT_CONTEXT_KEYS,
      "sourceKind",
      ...ROOM_COMMAND_EVIDENCE_KEYS,
      "includedGuests",
      "amountDecimal",
    ]) ||
    value["sourceKind"] !== "additional_guest" ||
    !isIntegerInRange(value["includedGuests"], 1, 99)
  ) {
    return null;
  }
  const context = parseUpsertContext(value);
  const room = parseRoomCommandEvidence(value);
  const amountDecimal = parsePmsNonNegativeDecimalAmount(value["amountDecimal"]);
  return context && room && amountDecimal
    ? Object.freeze({
        ...context,
        sourceKind: "additional_guest",
        ...room,
        includedGuests: value["includedGuests"],
        amountDecimal,
      })
    : null;
}

export function parseUpsertNonRefundablePricingCommand(
  value: unknown,
): UpsertNonRefundablePricingCommand | null {
  if (
    !isExactRecord(value, [...UPSERT_CONTEXT_KEYS, "sourceKind", "discountPercent", "roomPlans"]) ||
    value["sourceKind"] !== "non_refundable" ||
    !isIntegerInRange(value["discountPercent"], 1, 50) ||
    !Array.isArray(value["roomPlans"])
  ) {
    return null;
  }
  const context = parseUpsertContext(value);
  const roomPlans = parseRoomCommandEvidenceList(value["roomPlans"]);
  return context && roomPlans
    ? Object.freeze({
        ...context,
        sourceKind: "non_refundable",
        discountPercent: value["discountPercent"],
        roomPlans,
      })
    : null;
}

export function parseUpsertRecurringPricingSourceCommand(
  value: unknown,
): UpsertRecurringPricingSourceCommand | null {
  if (!isRecord(value)) return null;
  switch (value["sourceKind"]) {
    case "season":
      return parseUpsertRecurringSeasonCommand(value);
    case "weekend_surcharge":
      return parseUpsertWeekendSurchargeCommand(value);
    case "additional_guest":
      return parseUpsertAdditionalGuestPricingCommand(value);
    case "non_refundable":
      return parseUpsertNonRefundablePricingCommand(value);
    default:
      return null;
  }
}

export function parseDisableRecurringPricingSourceCommand(
  value: unknown,
): DisableRecurringPricingSourceCommand | null {
  if (
    !isExactRecord(value, [
      ...COMMAND_CONTEXT_KEYS,
      "sourceId",
      "sourceKind",
      "expectedSourceRevision",
    ]) ||
    !isUuid(value["sourceId"]) ||
    !isOneOf(value["sourceKind"], PMS_RECURRING_PRICING_SOURCE_KINDS) ||
    !isRevision(value["expectedSourceRevision"], false)
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  return context
    ? Object.freeze({
        ...context,
        sourceId: normalizeUuid(value["sourceId"]),
        sourceKind: value["sourceKind"],
        expectedSourceRevision: value["expectedSourceRevision"],
      })
    : null;
}

export function parseMaterializeRecurringPricingCommand(
  value: unknown,
): MaterializeRecurringPricingCommand | null {
  if (
    !isExactRecord(value, [
      ...COMMAND_CONTEXT_KEYS,
      "fromDate",
      "throughDate",
      "expectedOptionalPricingAggregateRevision",
    ]) ||
    !isRevision(value["expectedOptionalPricingAggregateRevision"], true)
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  const fromDate = parsePmsRecurringDate(value["fromDate"]);
  const throughDate = parsePmsRecurringDate(value["throughDate"]);
  if (!context || !fromDate || !throughDate || !isBoundedHorizon(fromDate, throughDate)) {
    return null;
  }
  return Object.freeze({
    ...context,
    fromDate,
    throughDate,
    expectedOptionalPricingAggregateRevision: value["expectedOptionalPricingAggregateRevision"],
  });
}

export function serializeRecurringPricingUpsertFingerprint(
  command: UpsertRecurringPricingSourceCommand,
): string {
  const common = {
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    sourceId: command.sourceId,
    sourceKind: command.sourceKind,
    expectedSourceRevision: command.expectedSourceRevision,
    expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision,
  };
  switch (command.sourceKind) {
    case "season":
      return JSON.stringify({
        ...common,
        name: command.name,
        startMonthDay: command.startMonthDay,
        endMonthDay: command.endMonthDay,
        roomPrices: command.roomPrices,
      });
    case "weekend_surcharge":
      return JSON.stringify({
        ...common,
        weekdays: command.weekdays,
        roomSurcharges: command.roomSurcharges,
      });
    case "additional_guest":
      return JSON.stringify({
        ...common,
        roomTypeId: command.roomTypeId,
        expectedRoomFactsRevision: command.expectedRoomFactsRevision,
        flexibleRatePlanId: command.flexibleRatePlanId,
        expectedFlexibleRatePlanRevision: command.expectedFlexibleRatePlanRevision,
        includedGuests: command.includedGuests,
        amountDecimal: command.amountDecimal,
      });
    case "non_refundable":
      return JSON.stringify({
        ...common,
        discountPercent: command.discountPercent,
        roomPlans: command.roomPlans,
      });
  }
}

export function serializeDisableRecurringPricingSourceFingerprint(
  command: DisableRecurringPricingSourceCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    sourceId: command.sourceId,
    sourceKind: command.sourceKind,
    expectedSourceRevision: command.expectedSourceRevision,
  });
}

export function serializeRecurringPricingMaterializationFingerprint(
  command: MaterializeRecurringPricingCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    fromDate: command.fromDate,
    throughDate: command.throughDate,
    expectedOptionalPricingAggregateRevision: command.expectedOptionalPricingAggregateRevision,
  });
}

export function parsePmsRecurringPricingValidation(
  value: unknown,
): PmsRecurringPricingValidation | null {
  if (
    isExactRecord(value, ["state", "validationRevision", "validatedAt"]) &&
    value["state"] === "valid" &&
    isRevision(value["validationRevision"], false) &&
    isIsoDateTime(value["validatedAt"])
  ) {
    return Object.freeze({
      state: "valid",
      validationRevision: value["validationRevision"],
      validatedAt: value["validatedAt"],
    });
  }
  if (
    isExactRecord(value, ["state", "validationRevision", "validatedAt", "reasons"]) &&
    value["state"] === "invalid" &&
    isRevision(value["validationRevision"], false) &&
    isIsoDateTime(value["validatedAt"]) &&
    Array.isArray(value["reasons"])
  ) {
    const reasons = parseInvalidReasons(value["reasons"]);
    return reasons
      ? Object.freeze({
          state: "invalid",
          validationRevision: value["validationRevision"],
          validatedAt: value["validatedAt"],
          reasons,
        })
      : null;
  }
  return null;
}

export function derivePmsRecurringPricingLifecycle(
  configuredState: PmsRecurringPricingConfiguredState,
  validation: PmsRecurringPricingValidation,
): PmsRecurringPricingSourceLifecycle {
  return configuredState === "disabled"
    ? "disabled"
    : validation.state === "invalid"
      ? "invalid"
      : "active";
}

export function parsePmsRecurringPricingSourceSnapshot(
  value: unknown,
): PmsRecurringPricingSourceSnapshot | null {
  if (!isRecord(value)) return null;
  switch (value["sourceKind"]) {
    case "season":
      return parseSeasonSnapshot(value);
    case "weekend_surcharge":
      return parseWeekendSnapshot(value);
    case "additional_guest":
      return parseAdditionalGuestSnapshot(value);
    case "non_refundable":
      return parseNonRefundableSnapshot(value);
    default:
      return null;
  }
}

export function parsePmsRecurringPricingBookingEvidence(
  value: unknown,
): PmsRecurringPricingBookingEvidence | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "propertyId",
      "pricingCurrencyRevision",
      "optionalPricingAggregateRevision",
      "currency",
      "sources",
      "capturedAt",
    ]) ||
    value["contractVersion"] !== PMS_RECURRING_PRICING_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isRevision(value["pricingCurrencyRevision"], false) ||
    !isRevision(value["optionalPricingAggregateRevision"], true) ||
    !Array.isArray(value["sources"]) ||
    !isIsoDateTime(value["capturedAt"])
  ) {
    return null;
  }
  const propertyId = normalizeUuid(value["propertyId"]);
  const currency = parsePmsPricingCurrency(value["currency"]);
  const sources = value["sources"].map(parsePmsRecurringPricingSourceSnapshot);
  if (!currency || sources.some((source) => !source)) return null;
  const parsedSources = sources as PmsRecurringPricingSourceSnapshot[];
  if (
    (value["optionalPricingAggregateRevision"] === 0) !== (parsedSources.length === 0) ||
    parsedSources.some(
      (source) =>
        source.propertyId !== propertyId ||
        source.currency !== currency ||
        source.pricingCurrencyRevision !== value["pricingCurrencyRevision"],
    ) ||
    !isStrictlySortedSources(parsedSources)
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrencyRevision: value["pricingCurrencyRevision"],
    optionalPricingAggregateRevision: value["optionalPricingAggregateRevision"],
    currency,
    sources: Object.freeze(parsedSources),
    capturedAt: value["capturedAt"],
  });
}

export function parseRecurringPricingMaterializationReceipt(
  value: unknown,
): RecurringPricingMaterializationReceipt | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "receiptId",
      "propertyId",
      "optionalPricingAggregateRevision",
      "fromDate",
      "throughDate",
      "sources",
      "acceptedAt",
    ]) ||
    value["contractVersion"] !== PMS_RECURRING_PRICING_CONTRACT_VERSION ||
    !isUuid(value["receiptId"]) ||
    !isUuid(value["propertyId"]) ||
    !isRevision(value["optionalPricingAggregateRevision"], true) ||
    !Array.isArray(value["sources"]) ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const fromDate = parsePmsRecurringDate(value["fromDate"]);
  const throughDate = parsePmsRecurringDate(value["throughDate"]);
  const sources = value["sources"].map(parseMaterializationSourceReceipt);
  if (
    !fromDate ||
    !throughDate ||
    !isBoundedHorizon(fromDate, throughDate) ||
    sources.some((source) => !source)
  ) {
    return null;
  }
  const parsedSources = sources as RecurringPricingMaterializationSourceReceipt[];
  if (!isStrictlySortedSources(parsedSources)) return null;
  return Object.freeze({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    receiptId: normalizeUuid(value["receiptId"]),
    propertyId: normalizeUuid(value["propertyId"]),
    optionalPricingAggregateRevision: value["optionalPricingAggregateRevision"],
    fromDate,
    throughDate,
    sources: Object.freeze(parsedSources),
    acceptedAt: value["acceptedAt"],
  });
}

export function parsePmsRecurringPricingMaterializedEvent(
  value: unknown,
): PmsRecurringPricingMaterializedEvent | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "eventType",
      "receiptId",
      "propertyId",
      "optionalPricingAggregateRevision",
      "fromDate",
      "throughDate",
      "sources",
    ]) ||
    value["contractVersion"] !== PMS_RECURRING_PRICING_CONTRACT_VERSION ||
    value["eventType"] !== "pms.recurring_pricing.materialized" ||
    !isUuid(value["receiptId"]) ||
    !isUuid(value["propertyId"]) ||
    !isRevision(value["optionalPricingAggregateRevision"], true) ||
    !Array.isArray(value["sources"])
  ) {
    return null;
  }
  const fromDate = parsePmsRecurringDate(value["fromDate"]);
  const throughDate = parsePmsRecurringDate(value["throughDate"]);
  const sources = value["sources"].map(parseMaterializedEventSource);
  if (
    !fromDate ||
    !throughDate ||
    !isBoundedHorizon(fromDate, throughDate) ||
    sources.some((source) => !source)
  ) {
    return null;
  }
  const parsedSources = sources as PmsRecurringPricingMaterializedEventSource[];
  if (!isStrictlySortedSources(parsedSources)) return null;
  return Object.freeze({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    eventType: "pms.recurring_pricing.materialized",
    receiptId: normalizeUuid(value["receiptId"]),
    propertyId: normalizeUuid(value["propertyId"]),
    optionalPricingAggregateRevision: value["optionalPricingAggregateRevision"],
    fromDate,
    throughDate,
    sources: Object.freeze(parsedSources),
  });
}

export function parsePmsRecurringPricingCommandResult(
  value: unknown,
): PmsRecurringPricingCommandResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"]) {
    if (!isExactRecord(value, ["ok", "response"])) return null;
    const response = parseCommandResponse(value["response"]);
    return response ? Object.freeze({ ok: true, response }) : null;
  }
  if (!isExactRecord(value, ["ok", "error"])) return null;
  const error = parseCommandError(value["error"]);
  return error ? Object.freeze({ ok: false, error }) : null;
}

export function parseRecurringPricingMaterializationResult(
  value: unknown,
): RecurringPricingMaterializationResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"]) {
    if (!isExactRecord(value, ["ok", "receipt"])) return null;
    const receipt = parseRecurringPricingMaterializationReceipt(value["receipt"]);
    return receipt ? Object.freeze({ ok: true, receipt }) : null;
  }
  if (!isExactRecord(value, ["ok", "error"])) return null;
  const error = parseCommandError(value["error"]);
  return error ? Object.freeze({ ok: false, error }) : null;
}

const COMMAND_CONTEXT_KEYS = ["organizationId", "propertyId", "idempotencyKey", "audit"] as const;
const UPSERT_CONTEXT_KEYS = [
  ...COMMAND_CONTEXT_KEYS,
  "sourceId",
  "expectedSourceRevision",
  "expectedPricingCurrencyRevision",
] as const;
const ROOM_COMMAND_EVIDENCE_KEYS = [
  "roomTypeId",
  "expectedRoomFactsRevision",
  "flexibleRatePlanId",
  "expectedFlexibleRatePlanRevision",
] as const;
const ROOM_SNAPSHOT_EVIDENCE_KEYS = [
  "roomTypeId",
  "roomFactsRevision",
  "flexibleRatePlanId",
  "flexibleRatePlanRevision",
] as const;
const SNAPSHOT_BASE_KEYS = [
  "contractVersion",
  "propertyId",
  "sourceId",
  "sourceRevision",
  "pricingCurrencyRevision",
  "currency",
  "configuredState",
  "validation",
  "lifecycle",
  "materializationRevision",
  "createdAt",
  "updatedAt",
] as const;

function parseUpsertContext(
  value: Record<string, unknown>,
): PmsRecurringPricingUpsertContext | null {
  const context = parseCommandContext(value);
  return context &&
    isUuid(value["sourceId"]) &&
    isRevision(value["expectedSourceRevision"], true) &&
    isRevision(value["expectedPricingCurrencyRevision"], false)
    ? Object.freeze({
        ...context,
        sourceId: normalizeUuid(value["sourceId"]),
        expectedSourceRevision: value["expectedSourceRevision"],
        expectedPricingCurrencyRevision: value["expectedPricingCurrencyRevision"],
      })
    : null;
}

function parseCommandContext(
  value: Record<string, unknown>,
): PmsRecurringPricingCommandContext | null {
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

function parseRoomCommandEvidence(
  value: Record<string, unknown>,
): RecurringPricingRoomCommandEvidence | null {
  return isUuid(value["roomTypeId"]) &&
    isRevision(value["expectedRoomFactsRevision"], false) &&
    isUuid(value["flexibleRatePlanId"]) &&
    isRevision(value["expectedFlexibleRatePlanRevision"], false)
    ? Object.freeze({
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRoomFactsRevision: value["expectedRoomFactsRevision"],
        flexibleRatePlanId: normalizeUuid(value["flexibleRatePlanId"]),
        expectedFlexibleRatePlanRevision: value["expectedFlexibleRatePlanRevision"],
      })
    : null;
}

function parseRoomSnapshotEvidence(
  value: Record<string, unknown>,
): RecurringPricingRoomEvidence | null {
  return isUuid(value["roomTypeId"]) &&
    isRevision(value["roomFactsRevision"], false) &&
    isUuid(value["flexibleRatePlanId"]) &&
    isRevision(value["flexibleRatePlanRevision"], false)
    ? Object.freeze({
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        roomFactsRevision: value["roomFactsRevision"],
        flexibleRatePlanId: normalizeUuid(value["flexibleRatePlanId"]),
        flexibleRatePlanRevision: value["flexibleRatePlanRevision"],
      })
    : null;
}

function parseRoomMoneyCommands(
  values: readonly unknown[],
  allowZero: false,
): readonly RecurringSeasonRoomPriceCommand[] | null;
function parseRoomMoneyCommands(
  values: readonly unknown[],
  allowZero: true,
): readonly WeekendRoomSurchargeCommand[] | null;
function parseRoomMoneyCommands(
  values: readonly unknown[],
  allowZero: boolean,
): readonly (RecurringSeasonRoomPriceCommand | WeekendRoomSurchargeCommand)[] | null {
  if (values.length === 0) return null;
  const parsed = values.map((value) => {
    if (!isExactRecord(value, [...ROOM_COMMAND_EVIDENCE_KEYS, "amountDecimal"])) return null;
    const room = parseRoomCommandEvidence(value);
    const amount = allowZero
      ? parsePmsNonNegativeDecimalAmount(value["amountDecimal"])
      : parsePmsDecimalAmount(value["amountDecimal"]);
    return room && amount ? Object.freeze({ ...room, amountDecimal: amount }) : null;
  });
  if (parsed.some((value) => !value)) return null;
  const result = parsed as (RecurringSeasonRoomPriceCommand | WeekendRoomSurchargeCommand)[];
  return isStrictlySortedUnique(result, ({ roomTypeId }) => roomTypeId)
    ? Object.freeze(result)
    : null;
}

function parseRoomCommandEvidenceList(
  values: readonly unknown[],
): readonly RecurringPricingRoomCommandEvidence[] | null {
  if (values.length === 0) return null;
  const parsed = values.map((value) => (isRecord(value) ? parseRoomCommandEvidence(value) : null));
  if (parsed.some((value) => !value)) return null;
  const result = parsed as RecurringPricingRoomCommandEvidence[];
  return isStrictlySortedUnique(result, ({ roomTypeId }) => roomTypeId)
    ? Object.freeze(result)
    : null;
}

function parseRoomMoneySnapshots(
  values: readonly unknown[],
  allowZero: false,
): readonly RecurringSeasonRoomPrice[] | null;
function parseRoomMoneySnapshots(
  values: readonly unknown[],
  allowZero: true,
): readonly WeekendRoomSurcharge[] | null;
function parseRoomMoneySnapshots(
  values: readonly unknown[],
  allowZero: boolean,
): readonly (RecurringSeasonRoomPrice | WeekendRoomSurcharge)[] | null {
  if (values.length === 0) return null;
  const parsed = values.map((value) => {
    if (!isExactRecord(value, [...ROOM_SNAPSHOT_EVIDENCE_KEYS, "amountDecimal"])) return null;
    const room = parseRoomSnapshotEvidence(value);
    const amount = allowZero
      ? parsePmsNonNegativeDecimalAmount(value["amountDecimal"])
      : parsePmsDecimalAmount(value["amountDecimal"]);
    return room && amount ? Object.freeze({ ...room, amountDecimal: amount }) : null;
  });
  if (parsed.some((value) => !value)) return null;
  const result = parsed as (RecurringSeasonRoomPrice | WeekendRoomSurcharge)[];
  return isStrictlySortedUnique(result, ({ roomTypeId }) => roomTypeId)
    ? Object.freeze(result)
    : null;
}

function parseRoomSnapshotEvidenceList(
  values: readonly unknown[],
): readonly RecurringPricingRoomEvidence[] | null {
  if (values.length === 0) return null;
  const parsed = values.map((value) => (isRecord(value) ? parseRoomSnapshotEvidence(value) : null));
  if (parsed.some((value) => !value)) return null;
  const result = parsed as RecurringPricingRoomEvidence[];
  return isStrictlySortedUnique(result, ({ roomTypeId }) => roomTypeId)
    ? Object.freeze(result)
    : null;
}

function parseWeekdays(values: readonly unknown[]): readonly PmsRecurringPricingWeekday[] | null {
  if (
    values.length === 0 ||
    values.some((value) => !isOneOf(value, PMS_RECURRING_PRICING_WEEKDAYS))
  ) {
    return null;
  }
  const result = values as PmsRecurringPricingWeekday[];
  const positions = result.map((weekday) => PMS_RECURRING_PRICING_WEEKDAYS.indexOf(weekday));
  return positions.some((position, index) => index > 0 && positions[index - 1]! >= position)
    ? null
    : Object.freeze([...result]);
}

function parseSnapshotBase(
  value: Record<string, unknown>,
): PmsRecurringPricingSourceSnapshotBase | null {
  if (
    value["contractVersion"] !== PMS_RECURRING_PRICING_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["sourceId"]) ||
    !isRevision(value["sourceRevision"], false) ||
    !isRevision(value["pricingCurrencyRevision"], false) ||
    !isOneOf(value["configuredState"], ["active", "disabled"] as const) ||
    !isOneOf(value["lifecycle"], ["active", "disabled", "invalid"] as const) ||
    !isRevision(value["materializationRevision"], true) ||
    !isIsoDateTime(value["createdAt"]) ||
    !isIsoDateTime(value["updatedAt"])
  ) {
    return null;
  }
  const currency = parsePmsPricingCurrency(value["currency"]);
  const validation = parsePmsRecurringPricingValidation(value["validation"]);
  const expectedLifecycle = validation
    ? derivePmsRecurringPricingLifecycle(value["configuredState"], validation)
    : null;
  return currency && validation && value["lifecycle"] === expectedLifecycle
    ? Object.freeze({
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        propertyId: normalizeUuid(value["propertyId"]),
        sourceId: normalizeUuid(value["sourceId"]),
        sourceRevision: value["sourceRevision"],
        pricingCurrencyRevision: value["pricingCurrencyRevision"],
        currency,
        configuredState: value["configuredState"],
        validation,
        lifecycle: expectedLifecycle,
        materializationRevision: value["materializationRevision"],
        createdAt: value["createdAt"],
        updatedAt: value["updatedAt"],
      })
    : null;
}

function parseSeasonSnapshot(value: Record<string, unknown>): RecurringSeasonSnapshot | null {
  if (
    !isExactRecord(value, [
      ...SNAPSHOT_BASE_KEYS,
      "sourceKind",
      "name",
      "startMonthDay",
      "endMonthDay",
      "roomPrices",
    ]) ||
    !isTrimmedText(value["name"], 1, 100) ||
    !Array.isArray(value["roomPrices"])
  ) {
    return null;
  }
  const base = parseSnapshotBase(value);
  const startMonthDay = parsePmsRecurringMonthDay(value["startMonthDay"]);
  const endMonthDay = parsePmsRecurringMonthDay(value["endMonthDay"]);
  const roomPrices = parseRoomMoneySnapshots(value["roomPrices"], false);
  return base && startMonthDay && endMonthDay && roomPrices
    ? Object.freeze({
        ...base,
        sourceKind: "season",
        name: value["name"],
        startMonthDay,
        endMonthDay,
        roomPrices,
      })
    : null;
}

function parseWeekendSnapshot(value: Record<string, unknown>): WeekendSurchargeSnapshot | null {
  if (
    !isExactRecord(value, [...SNAPSHOT_BASE_KEYS, "sourceKind", "weekdays", "roomSurcharges"]) ||
    !Array.isArray(value["weekdays"]) ||
    !Array.isArray(value["roomSurcharges"])
  ) {
    return null;
  }
  const base = parseSnapshotBase(value);
  const weekdays = parseWeekdays(value["weekdays"]);
  const roomSurcharges = parseRoomMoneySnapshots(value["roomSurcharges"], true);
  return base && weekdays && roomSurcharges
    ? Object.freeze({ ...base, sourceKind: "weekend_surcharge", weekdays, roomSurcharges })
    : null;
}

function parseAdditionalGuestSnapshot(
  value: Record<string, unknown>,
): AdditionalGuestPricingSnapshot | null {
  if (
    !isExactRecord(value, [
      ...SNAPSHOT_BASE_KEYS,
      "sourceKind",
      ...ROOM_SNAPSHOT_EVIDENCE_KEYS,
      "maximumAdultGuests",
      "includedGuests",
      "amountDecimal",
    ]) ||
    !isIntegerInRange(value["maximumAdultGuests"], 2, 100) ||
    !isIntegerInRange(value["includedGuests"], 1, value["maximumAdultGuests"] - 1)
  ) {
    return null;
  }
  const base = parseSnapshotBase(value);
  const room = parseRoomSnapshotEvidence(value);
  const amountDecimal = parsePmsNonNegativeDecimalAmount(value["amountDecimal"]);
  return base && room && amountDecimal
    ? Object.freeze({
        ...base,
        sourceKind: "additional_guest",
        ...room,
        maximumAdultGuests: value["maximumAdultGuests"],
        includedGuests: value["includedGuests"],
        amountDecimal,
      })
    : null;
}

function parseNonRefundableSnapshot(
  value: Record<string, unknown>,
): NonRefundablePricingSnapshot | null {
  if (
    !isExactRecord(value, [
      ...SNAPSHOT_BASE_KEYS,
      "sourceKind",
      "discountPercent",
      "roomPlans",
      "paymentTiming",
      "cancellationTerms",
    ]) ||
    !isIntegerInRange(value["discountPercent"], 1, 50) ||
    value["paymentTiming"] !== "prepay_full" ||
    !Array.isArray(value["roomPlans"])
  ) {
    return null;
  }
  const base = parseSnapshotBase(value);
  const roomPlans = parseRoomSnapshotEvidenceList(value["roomPlans"]);
  const cancellationTerms = parseNonRefundableCancellationTerms(value["cancellationTerms"]);
  return base && roomPlans && cancellationTerms
    ? Object.freeze({
        ...base,
        sourceKind: "non_refundable",
        discountPercent: value["discountPercent"],
        roomPlans,
        paymentTiming: "prepay_full",
        cancellationTerms,
      })
    : null;
}

function parseInvalidReasons(
  values: readonly unknown[],
): readonly PmsRecurringPricingInvalidReason[] | null {
  if (values.length === 0) return null;
  const parsed = values.map((value) => {
    if (!isRecord(value)) return null;
    if (
      isExactRecord(value, ["code"]) &&
      isOneOf(value["code"], [
        "pricing_currency_mismatch",
        "pricing_currency_revision_stale",
        "non_refundable_payment_timing_invalid",
        "dependency_unavailable",
      ] as const)
    ) {
      return Object.freeze({ code: value["code"] });
    }
    if (
      isExactRecord(value, ["code", "roomTypeId"]) &&
      isOneOf(value["code"], [
        "room_type_missing",
        "room_facts_revision_stale",
        "flexible_rate_plan_missing",
        "flexible_rate_plan_revision_stale",
        "recurring_pricing_room_plan_missing",
        "additional_guest_capacity_inapplicable",
      ] as const) &&
      isUuid(value["roomTypeId"])
    ) {
      return Object.freeze({
        code: value["code"],
        roomTypeId: normalizeUuid(value["roomTypeId"]),
      });
    }
    if (
      isExactRecord(value, ["code", "conflictingSourceId"]) &&
      value["code"] === "season_overlap" &&
      isUuid(value["conflictingSourceId"])
    ) {
      return Object.freeze({
        code: "season_overlap" as const,
        conflictingSourceId: normalizeUuid(value["conflictingSourceId"]),
      });
    }
    return null;
  });
  if (parsed.some((reason) => !reason)) return null;
  const result = parsed as PmsRecurringPricingInvalidReason[];
  return isStrictlySortedUnique(result, invalidReasonSortKey) ? Object.freeze(result) : null;
}

function invalidReasonSortKey(reason: PmsRecurringPricingInvalidReason): string {
  const position = PMS_RECURRING_PRICING_INVALID_REASON_CODES.indexOf(reason.code)
    .toString()
    .padStart(2, "0");
  if ("roomTypeId" in reason) return `${position}:${reason.roomTypeId}`;
  if ("conflictingSourceId" in reason) return `${position}:${reason.conflictingSourceId}`;
  return `${position}:`;
}

function parseMaterializationSourceReceipt(
  value: unknown,
): RecurringPricingMaterializationSourceReceipt | null {
  if (
    !isExactRecord(value, [
      "sourceKind",
      "sourceId",
      "sourceRevision",
      "configuredState",
      "validation",
      "lifecycle",
      "materializationRevision",
      "currency",
      "pricingCurrencyRevision",
      "result",
      "materializedRowCount",
      "materializedRowsSha256",
    ]) ||
    !isOneOf(value["sourceKind"], PMS_RECURRING_PRICING_SOURCE_KINDS) ||
    !isUuid(value["sourceId"]) ||
    !isRevision(value["sourceRevision"], false) ||
    !isOneOf(value["configuredState"], ["active", "disabled"] as const) ||
    !isOneOf(value["lifecycle"], ["active", "disabled", "invalid"] as const) ||
    !isRevision(value["materializationRevision"], false) ||
    !isRevision(value["pricingCurrencyRevision"], false) ||
    !isIntegerInRange(value["materializedRowCount"], 0, 2_147_483_647) ||
    typeof value["materializedRowsSha256"] !== "string" ||
    !SHA_256_PATTERN.test(value["materializedRowsSha256"])
  ) {
    return null;
  }
  const currency = parsePmsPricingCurrency(value["currency"]);
  const validation = parsePmsRecurringPricingValidation(value["validation"]);
  const lifecycle = validation
    ? derivePmsRecurringPricingLifecycle(value["configuredState"], validation)
    : null;
  const expectedResult =
    lifecycle === "active"
      ? "materialized"
      : lifecycle === "disabled"
        ? "skipped_disabled"
        : lifecycle === "invalid"
          ? "skipped_invalid"
          : null;
  if (
    !currency ||
    !validation ||
    !lifecycle ||
    value["lifecycle"] !== lifecycle ||
    value["result"] !== expectedResult ||
    (expectedResult !== "materialized" && value["materializedRowCount"] !== 0)
  ) {
    return null;
  }
  const result = expectedResult as RecurringPricingMaterializationSourceReceipt["result"];
  return Object.freeze({
    sourceKind: value["sourceKind"],
    sourceId: normalizeUuid(value["sourceId"]),
    sourceRevision: value["sourceRevision"],
    configuredState: value["configuredState"],
    validation,
    lifecycle,
    materializationRevision: value["materializationRevision"],
    currency,
    pricingCurrencyRevision: value["pricingCurrencyRevision"],
    result,
    materializedRowCount: value["materializedRowCount"],
    materializedRowsSha256: value["materializedRowsSha256"],
  });
}

function parseMaterializedEventSource(
  value: unknown,
): PmsRecurringPricingMaterializedEventSource | null {
  if (
    !isExactRecord(value, [
      "sourceKind",
      "sourceId",
      "sourceRevision",
      "materializationRevision",
      "lifecycle",
      "result",
      "materializedRowCount",
      "materializedRowsSha256",
    ]) ||
    !isOneOf(value["sourceKind"], PMS_RECURRING_PRICING_SOURCE_KINDS) ||
    !isUuid(value["sourceId"]) ||
    !isRevision(value["sourceRevision"], false) ||
    !isRevision(value["materializationRevision"], false) ||
    !isOneOf(value["lifecycle"], ["active", "disabled", "invalid"] as const) ||
    !isIntegerInRange(value["materializedRowCount"], 0, 2_147_483_647) ||
    typeof value["materializedRowsSha256"] !== "string" ||
    !SHA_256_PATTERN.test(value["materializedRowsSha256"])
  ) {
    return null;
  }
  const expectedResult =
    value["lifecycle"] === "active"
      ? "materialized"
      : value["lifecycle"] === "disabled"
        ? "skipped_disabled"
        : "skipped_invalid";
  if (
    value["result"] !== expectedResult ||
    (expectedResult !== "materialized" && value["materializedRowCount"] !== 0)
  ) {
    return null;
  }
  return Object.freeze({
    sourceKind: value["sourceKind"],
    sourceId: normalizeUuid(value["sourceId"]),
    sourceRevision: value["sourceRevision"],
    materializationRevision: value["materializationRevision"],
    lifecycle: value["lifecycle"],
    result: expectedResult,
    materializedRowCount: value["materializedRowCount"],
    materializedRowsSha256: value["materializedRowsSha256"],
  });
}

function parseCommandResponse(value: unknown): PmsRecurringPricingCommandResponse | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "outcome",
      "source",
      "optionalPricingAggregateRevision",
      "acceptedAt",
    ]) ||
    value["contractVersion"] !== PMS_RECURRING_PRICING_CONTRACT_VERSION ||
    !isOneOf(value["outcome"], ["created", "updated", "re_enabled", "disabled"] as const) ||
    !isRevision(value["optionalPricingAggregateRevision"], false) ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const source = parsePmsRecurringPricingSourceSnapshot(value["source"]);
  if (
    !source ||
    (value["outcome"] === "disabled" && source.lifecycle !== "disabled") ||
    (value["outcome"] === "re_enabled" && source.lifecycle !== "active")
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    outcome: value["outcome"],
    source,
    optionalPricingAggregateRevision: value["optionalPricingAggregateRevision"],
    acceptedAt: value["acceptedAt"],
  });
}

function parseCommandError(value: unknown): PmsRecurringPricingCommandError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    isOneOf(value["code"], [
      "source_not_found",
      "source_kind_conflict",
      "pricing_currency_not_configured",
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
      "source_revision_conflict",
      "pricing_currency_revision_conflict",
      "optional_pricing_aggregate_revision_conflict",
    ] as const) &&
    isRevision(value["currentRevision"], true)
  ) {
    return Object.freeze({ code: value["code"], currentRevision: value["currentRevision"] });
  }
  if (
    isExactRecord(value, ["code", "sourceKind", "missingRoomTypeIds"]) &&
    value["code"] === "recurring_pricing_room_plan_set_incomplete" &&
    isOneOf(value["sourceKind"], ["season", "weekend_surcharge", "non_refundable"] as const) &&
    Array.isArray(value["missingRoomTypeIds"])
  ) {
    const missingRoomTypeIds = parseSortedUuidList(value["missingRoomTypeIds"]);
    return missingRoomTypeIds
      ? Object.freeze({
          code: "recurring_pricing_room_plan_set_incomplete" as const,
          sourceKind: value["sourceKind"],
          missingRoomTypeIds,
        })
      : null;
  }
  if (
    isExactRecord(value, ["code", "conflictingSourceId"]) &&
    value["code"] === "season_name_conflict" &&
    isUuid(value["conflictingSourceId"])
  ) {
    return Object.freeze({
      code: "season_name_conflict",
      conflictingSourceId: normalizeUuid(value["conflictingSourceId"]),
    });
  }
  if (
    isExactRecord(value, ["code", "conflictingSourceIds"]) &&
    value["code"] === "season_overlap" &&
    Array.isArray(value["conflictingSourceIds"])
  ) {
    const ids = parseSortedUuidList(value["conflictingSourceIds"]);
    return ids ? Object.freeze({ code: "season_overlap", conflictingSourceIds: ids }) : null;
  }
  if (
    isExactRecord(value, ["code", "roomTypeId"]) &&
    isOneOf(value["code"], ["room_type_not_found", "flexible_rate_plan_not_found"] as const) &&
    isUuid(value["roomTypeId"])
  ) {
    return Object.freeze({ code: value["code"], roomTypeId: normalizeUuid(value["roomTypeId"]) });
  }
  if (
    isExactRecord(value, ["code", "roomTypeId", "currentRevision"]) &&
    isOneOf(value["code"], [
      "room_facts_revision_conflict",
      "flexible_rate_plan_revision_conflict",
    ] as const) &&
    isUuid(value["roomTypeId"]) &&
    isRevision(value["currentRevision"], true)
  ) {
    return Object.freeze({
      code: value["code"],
      roomTypeId: normalizeUuid(value["roomTypeId"]),
      currentRevision: value["currentRevision"],
    });
  }
  if (
    isExactRecord(value, ["code", "roomTypeId", "maximumAdultGuests"]) &&
    value["code"] === "additional_guest_capacity_inapplicable" &&
    isUuid(value["roomTypeId"]) &&
    isIntegerInRange(value["maximumAdultGuests"], 0, 100)
  ) {
    return Object.freeze({
      code: "additional_guest_capacity_inapplicable",
      roomTypeId: normalizeUuid(value["roomTypeId"]),
      maximumAdultGuests: value["maximumAdultGuests"],
    });
  }
  return null;
}

function parseSortedUuidList(values: readonly unknown[]): readonly string[] | null {
  if (values.length === 0 || values.some((value) => !isUuid(value))) return null;
  const ids = values.map((value) => normalizeUuid(value as string));
  return isStrictlySortedUnique(ids, (value) => value) ? Object.freeze(ids) : null;
}

function isStrictlySortedSources(
  values: readonly { sourceKind: PmsRecurringPricingSourceKind; sourceId: string }[],
): boolean {
  return isStrictlySortedUnique(values, (value) => {
    const position = PMS_RECURRING_PRICING_SOURCE_KINDS.indexOf(value.sourceKind);
    return `${position}:${value.sourceId}`;
  });
}

function isStrictlySortedUnique<Value>(
  values: readonly Value[],
  key: (value: Value) => string,
): boolean {
  const keys = values.map(key);
  return keys.every((value, index) => index === 0 || keys[index - 1]! < value);
}

function isBoundedHorizon(fromDate: PmsRecurringDate, throughDate: PmsRecurringDate): boolean {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const through = Date.parse(`${throughDate}T00:00:00.000Z`);
  const days = Math.floor((through - from) / 86_400_000) + 1;
  return days >= 1 && days <= PMS_RECURRING_PRICING_MAX_HORIZON_DAYS;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
