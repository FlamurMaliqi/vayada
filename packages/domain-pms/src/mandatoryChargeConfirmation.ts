import {
  PMS_RECURRING_PRICING_INVALID_REASON_CODES,
  PMS_RECURRING_PRICING_SOURCE_KINDS,
  PMS_RECURRING_PRICING_WEEKDAYS,
  parsePmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingInvalidReason,
  type PmsRecurringPricingSourceSnapshot,
  type RecurringPricingRoomEvidence,
} from "./recurringPricing.js";
import {
  parsePmsPricingSourceSnapshot,
  type PmsPricingCommandAudit,
  type PmsPricingSourceSnapshot,
} from "./pricing.js";

export const PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION =
  "pms-mandatory-charge-pricing-source.v1" as const;
export const PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM = "sha256" as const;
export const PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION =
  "pms-mandatory-charge-confirmation.v1" as const;
export const PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION =
  "pms.confirmMandatoryChargesIncluded" as const;
export const PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE =
  "mandatory_charge_confirmation" as const;
export const PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE =
  "pms.mandatory_charges.confirmed" as const;
export const PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_DESTINATION =
  "booking.pricing-source" as const;
export const PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_METADATA = Object.freeze({
  sourceReadRequired: true,
} as const);
export const PMS_MANDATORY_CHARGE_CONFIRMATION_AUTHORIZATION = Object.freeze({
  permission: "pms.operations.manage",
  entitlement: Object.freeze({ product: "pms", key: "property-management" }),
  resource: Object.freeze({
    product: "pms",
    resourceType: "pms_property",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);
export const PMS_MANDATORY_CHARGE_CONFIRMATION_IDEMPOTENCY = Object.freeze({
  operationScope: "pms",
  operation: PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
  keyScope: "property",
  exactReplay: "original_response",
  replaySideEffects: "none",
  changedFingerprint: "idempotency_key_conflict",
  inProgress: "command_in_progress",
} as const);
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

declare const pmsMandatoryChargePricingSourceFingerprintBrand: unique symbol;

export type PmsMandatoryChargePricingSourceFingerprint = string & {
  readonly [pmsMandatoryChargePricingSourceFingerprintBrand]: true;
};

export type PmsMandatoryChargePricingSourceRevisionManifest = Readonly<{
  pricingCurrencyRevision: number;
  rooms: readonly Readonly<{
    roomTypeId: string;
    roomFactsRevision: number;
  }>[];
  flexibleRatePlans: readonly Readonly<{
    roomTypeId: string;
    flexibleRatePlanId: string;
    flexibleRatePlanRevision: number;
    sourceRoomFactsRevision: number;
  }>[];
  optionalPricingAggregateRevision: number;
  recurringSources: readonly Readonly<{
    sourceKind: PmsRecurringPricingSourceSnapshot["sourceKind"];
    sourceId: string;
    sourceRevision: number;
    validationRevision: number;
    materializationRevision: number;
  }>[];
}>;

export type PmsMandatoryChargePricingSourceInput = Readonly<{
  /** Exact active Room Facts set, projected to only fingerprint-owned fields. */
  rooms: readonly Readonly<{
    roomTypeId: string;
    roomFactsRevision: number;
    occupancy: Readonly<{
      maxGuests: number;
      maxAdults: number;
      maxChildren: number;
    }>;
  }>[];
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
}>;

export type PmsMandatoryChargePricingSourceSnapshot = Readonly<{
  payloadVersion: typeof PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION;
  propertyId: string;
  sourceRevisions: PmsMandatoryChargePricingSourceRevisionManifest;
  serializedPayload: string;
}>;

export type ConfirmMandatoryChargesIncludedCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  expectedConfirmationRevision: number;
  claimedPricingSourceFingerprint: PmsMandatoryChargePricingSourceFingerprint;
  expectedPricingSourceRevisions: PmsMandatoryChargePricingSourceRevisionManifest;
  idempotencyKey: string;
  audit: PmsPricingCommandAudit;
}>;

export type PmsMandatoryChargeConfirmationEvidence = Readonly<{
  organizationId: string;
  propertyId: string;
  pricingSourceFingerprint: PmsMandatoryChargePricingSourceFingerprint;
  confirmationRevision: number;
  confirmedAt: string;
}>;

export type PmsMandatoryChargeConfirmationReadRequest = Readonly<{
  organizationId: string;
  propertyId: string;
}>;

export type PmsMandatoryChargeConfirmationReadResult =
  | (PmsMandatoryChargeConfirmationReadRequest &
      Readonly<{
        outcome: "available";
        evidence: PmsMandatoryChargeConfirmationEvidence;
      }>)
  | (PmsMandatoryChargeConfirmationReadRequest & Readonly<{ outcome: "missing" }>)
  | (PmsMandatoryChargeConfirmationReadRequest & Readonly<{ outcome: "malformed" }>)
  | (PmsMandatoryChargeConfirmationReadRequest &
      Readonly<{
        outcome: "unavailable";
        errorSource: "provider" | "system";
      }>);

export type PmsMandatoryChargeConfirmationCommandError =
  | Readonly<{
      code:
        | "setup_scope_unavailable"
        | "pricing_source_not_configured"
        | "pricing_source_conflict"
        | "idempotency_key_conflict"
        | "command_in_progress";
    }>
  | Readonly<{ code: "confirmation_revision_conflict"; currentRevision: number }>;

export type ConfirmMandatoryChargesIncludedResponse = Readonly<{
  contractVersion: typeof PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION;
  outcome: "confirmed";
  evidence: PmsMandatoryChargeConfirmationEvidence;
  acceptedAt: string;
}>;

export type ConfirmMandatoryChargesIncludedResult =
  | Readonly<{ ok: true; response: ConfirmMandatoryChargesIncludedResponse }>
  | Readonly<{ ok: false; error: PmsMandatoryChargeConfirmationCommandError }>;

export type PmsMandatoryChargeConfirmationCommandPort = {
  /**
   * Every attempt is authorized before idempotency lookup or replay. Exact
   * retries replay the stored serialized response byte-for-byte without
   * advancing revisions or writing another audit, event, or outbox row;
   * changed fingerprints conflict.
   *
   * For a new write, implementations enter the shared pricing guard, acquire
   * the room-facts property lock, and use one database client/transaction to
   * reread the complete active-room, pricing, and retained-recurring state.
   * They compare its canonical manifest and digest before the confirmation CAS.
   * Independent read transactions cannot be used as evidence protected by
   * these locks. The evidence, completed idempotency result, redacted audit,
   * secret-safe event, and source-read-required outbox intent commit atomically.
   */
  confirmMandatoryChargesIncluded(
    command: ConfirmMandatoryChargesIncludedCommand,
  ): Promise<ConfirmMandatoryChargesIncludedResult>;
};

export type PmsMandatoryChargeConfirmationReadPort = {
  /**
   * Every outcome repeats the exact requested scope. Corrupt evidence is
   * malformed, read failures are unavailable, and only consumers determine
   * staleness by comparing the available fingerprint with current source bytes.
   */
  getMandatoryChargeConfirmation(
    request: PmsMandatoryChargeConfirmationReadRequest,
  ): Promise<PmsMandatoryChargeConfirmationReadResult>;
};

/** Secret-safe notification. Consumers obtain evidence through the read port. */
export type PmsMandatoryChargesConfirmedEvent = Readonly<{
  contractVersion: typeof PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION;
  eventType: typeof PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE;
  organizationId: string;
  propertyId: string;
  confirmationRevision: number;
  pricingCurrencyRevision: number;
  optionalPricingAggregateRevision: number;
  outcome: "confirmed";
}>;

/**
 * PMS owns these canonical bytes. Callers apply lower-hex SHA-256 outside this
 * browser-safe package, then parse the digest through the exported parser.
 */
export function createPmsMandatoryChargePricingSourceSnapshot(
  input: PmsMandatoryChargePricingSourceInput,
): PmsMandatoryChargePricingSourceSnapshot {
  try {
    const sources = snapshotPricingSources(input);
    const serializedPayload = JSON.stringify(canonicalPricingSourcePayload(sources));
    return deepFreeze({
      payloadVersion: PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION,
      propertyId: sources.propertyId,
      sourceRevisions: createRevisionManifest(sources),
      serializedPayload,
    });
  } catch {
    throw new TypeError("PMS mandatory-charge pricing source input is invalid");
  }
}

export function serializePmsMandatoryChargePricingSourcePayload(
  input: PmsMandatoryChargePricingSourceInput,
): string {
  return createPmsMandatoryChargePricingSourceSnapshot(input).serializedPayload;
}

export function parsePmsMandatoryChargePricingSourceFingerprint(
  value: unknown,
): PmsMandatoryChargePricingSourceFingerprint | null {
  return typeof value === "string" && SHA_256_PATTERN.test(value)
    ? (value as PmsMandatoryChargePricingSourceFingerprint)
    : null;
}

export function parseConfirmMandatoryChargesIncludedCommand(
  value: unknown,
): ConfirmMandatoryChargesIncludedCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "expectedConfirmationRevision",
      "claimedPricingSourceFingerprint",
      "expectedPricingSourceRevisions",
      "idempotencyKey",
      "audit",
    ]) ||
    !isUuid(value.organizationId) ||
    !isUuid(value.propertyId) ||
    !isIntegerInRange(value.expectedConfirmationRevision, 0, 2_147_483_647) ||
    !isTrimmedText(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const claimedPricingSourceFingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
    value.claimedPricingSourceFingerprint,
  );
  const expectedPricingSourceRevisions = parseRevisionManifest(
    value.expectedPricingSourceRevisions,
  );
  const audit = parseCommandAudit(value.audit);
  return claimedPricingSourceFingerprint && expectedPricingSourceRevisions && audit
    ? deepFreeze({
        organizationId: value.organizationId.toLowerCase(),
        propertyId: value.propertyId.toLowerCase(),
        expectedConfirmationRevision: value.expectedConfirmationRevision,
        claimedPricingSourceFingerprint,
        expectedPricingSourceRevisions,
        idempotencyKey: value.idempotencyKey,
        audit,
      })
    : null;
}

export function serializeConfirmMandatoryChargesIncludedFingerprint(
  command: ConfirmMandatoryChargesIncludedCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    expectedConfirmationRevision: command.expectedConfirmationRevision,
    claimedPricingSourceFingerprint: command.claimedPricingSourceFingerprint,
    expectedPricingSourceRevisions: command.expectedPricingSourceRevisions,
  });
}

export function parsePmsMandatoryChargeConfirmationEvidence(
  value: unknown,
): PmsMandatoryChargeConfirmationEvidence | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "pricingSourceFingerprint",
      "confirmationRevision",
      "confirmedAt",
    ]) ||
    !isUuid(value.organizationId) ||
    !isUuid(value.propertyId) ||
    !isRevision(value.confirmationRevision) ||
    !isCanonicalIsoDateTime(value.confirmedAt)
  ) {
    return null;
  }
  const pricingSourceFingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
    value.pricingSourceFingerprint,
  );
  return pricingSourceFingerprint
    ? Object.freeze({
        organizationId: value.organizationId.toLowerCase(),
        propertyId: value.propertyId.toLowerCase(),
        pricingSourceFingerprint,
        confirmationRevision: value.confirmationRevision,
        confirmedAt: value.confirmedAt,
      })
    : null;
}

export function parsePmsMandatoryChargeConfirmationReadRequest(
  value: unknown,
): PmsMandatoryChargeConfirmationReadRequest | null {
  return isExactRecord(value, ["organizationId", "propertyId"]) &&
    isUuid(value.organizationId) &&
    isUuid(value.propertyId)
    ? Object.freeze({
        organizationId: value.organizationId.toLowerCase(),
        propertyId: value.propertyId.toLowerCase(),
      })
    : null;
}

export function parsePmsMandatoryChargeConfirmationReadResult(
  value: unknown,
): PmsMandatoryChargeConfirmationReadResult | null {
  if (!isRecord(value)) return null;
  const scope = parsePmsMandatoryChargeConfirmationReadRequest({
    organizationId: value.organizationId,
    propertyId: value.propertyId,
  });
  if (!scope) return null;
  if (
    value.outcome === "available" &&
    isExactRecord(value, ["outcome", "organizationId", "propertyId", "evidence"])
  ) {
    const evidence = parsePmsMandatoryChargeConfirmationEvidence(value.evidence);
    return evidence &&
      evidence.organizationId === scope.organizationId &&
      evidence.propertyId === scope.propertyId
      ? deepFreeze({ ...scope, outcome: "available" as const, evidence })
      : null;
  }
  if (
    (value.outcome === "missing" || value.outcome === "malformed") &&
    isExactRecord(value, ["outcome", "organizationId", "propertyId"])
  ) {
    return Object.freeze({ ...scope, outcome: value.outcome });
  }
  if (
    value.outcome === "unavailable" &&
    isExactRecord(value, ["outcome", "organizationId", "propertyId", "errorSource"]) &&
    (value.errorSource === "provider" || value.errorSource === "system")
  ) {
    return Object.freeze({ ...scope, outcome: "unavailable", errorSource: value.errorSource });
  }
  return null;
}

export function parsePmsMandatoryChargesConfirmedEvent(
  value: unknown,
): PmsMandatoryChargesConfirmedEvent | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "eventType",
      "organizationId",
      "propertyId",
      "confirmationRevision",
      "pricingCurrencyRevision",
      "optionalPricingAggregateRevision",
      "outcome",
    ]) ||
    value.contractVersion !== PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION ||
    value.eventType !== PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE ||
    !isUuid(value.organizationId) ||
    !isUuid(value.propertyId) ||
    !isRevision(value.confirmationRevision) ||
    !isRevision(value.pricingCurrencyRevision) ||
    !isIntegerInRange(value.optionalPricingAggregateRevision, 0, 2_147_483_647) ||
    value.outcome !== "confirmed"
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
    eventType: PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
    organizationId: value.organizationId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
    confirmationRevision: value.confirmationRevision,
    pricingCurrencyRevision: value.pricingCurrencyRevision,
    optionalPricingAggregateRevision: value.optionalPricingAggregateRevision,
    outcome: "confirmed",
  });
}

export function parseConfirmMandatoryChargesIncludedResult(
  value: unknown,
): ConfirmMandatoryChargesIncludedResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && isExactRecord(value, ["ok", "response"])) {
    const response = value.response;
    if (
      !isExactRecord(response, ["contractVersion", "outcome", "evidence", "acceptedAt"]) ||
      response.contractVersion !== PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION ||
      response.outcome !== "confirmed" ||
      !isCanonicalIsoDateTime(response.acceptedAt)
    ) {
      return null;
    }
    const evidence = parsePmsMandatoryChargeConfirmationEvidence(response.evidence);
    return evidence && evidence.confirmedAt === response.acceptedAt
      ? deepFreeze({
          ok: true as const,
          response: {
            contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
            outcome: "confirmed" as const,
            evidence,
            acceptedAt: response.acceptedAt,
          },
        })
      : null;
  }
  if (value.ok === false && isExactRecord(value, ["ok", "error"])) {
    const error = parseCommandError(value.error);
    return error ? deepFreeze({ ok: false as const, error }) : null;
  }
  return null;
}

type CanonicalRoom = Readonly<{
  roomTypeId: string;
  roomFactsRevision: number;
  maxGuests: number;
  maxAdults: number;
  maxChildren: number;
}>;

type SnapshottedPricingSources = Readonly<{
  propertyId: string;
  rooms: readonly CanonicalRoom[];
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
}>;

function snapshotPricingSources(
  input: PmsMandatoryChargePricingSourceInput,
): SnapshottedPricingSources {
  if (
    !isExactRecord(input, ["rooms", "pricing", "recurringPricing"]) ||
    !isDenseArray(input.rooms) ||
    !isDenseArray(input.pricing.flexibleRatePlans) ||
    !isDenseArray(input.recurringPricing.sources)
  ) {
    throw new TypeError();
  }
  const rooms = input.rooms.map(parseCanonicalRoom);
  if (rooms.some(isNull)) throw new TypeError();
  const parsedRooms = rooms as CanonicalRoom[];
  if (hasDuplicate(parsedRooms, ({ roomTypeId }) => roomTypeId)) throw new TypeError();
  parsedRooms.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  const pricingCandidate = {
    ...structuredClone(input.pricing),
    flexibleRatePlans: [...structuredClone(input.pricing.flexibleRatePlans)].sort((left, right) =>
      compareCodeUnits(left.roomTypeId, right.roomTypeId),
    ),
  };
  const recurringCandidate = {
    ...structuredClone(input.recurringPricing),
    sources: structuredClone(input.recurringPricing.sources)
      .map(canonicalizeRecurringSource)
      .sort(compareRecurringSources),
  };
  const pricing = parsePmsPricingSourceSnapshot(pricingCandidate);
  const recurringPricing = parsePmsRecurringPricingBookingEvidence(recurringCandidate);
  const propertyId = pricing?.propertyId;
  if (
    !pricing ||
    !recurringPricing ||
    !propertyId ||
    recurringPricing.propertyId !== propertyId ||
    recurringPricing.currency !== pricing.pricingCurrency.currency ||
    recurringPricing.pricingCurrencyRevision !== pricing.pricingCurrency.pricingCurrencyRevision
  ) {
    throw new TypeError();
  }
  return deepFreeze({ propertyId, rooms: parsedRooms, pricing, recurringPricing });
}

function parseCanonicalRoom(value: unknown): CanonicalRoom | null {
  if (
    !isExactRecord(value, ["roomTypeId", "roomFactsRevision", "occupancy"]) ||
    !isUuid(value.roomTypeId) ||
    !isRevision(value.roomFactsRevision) ||
    !isExactRecord(value.occupancy, ["maxGuests", "maxAdults", "maxChildren"])
  ) {
    return null;
  }
  const { maxGuests, maxAdults, maxChildren } = value.occupancy;
  if (
    !isIntegerInRange(maxGuests, 1, 100) ||
    !isIntegerInRange(maxAdults, 1, maxGuests) ||
    !isIntegerInRange(maxChildren, 0, maxGuests) ||
    maxAdults + maxChildren < maxGuests
  ) {
    return null;
  }
  return Object.freeze({
    roomTypeId: value.roomTypeId.toLowerCase(),
    roomFactsRevision: value.roomFactsRevision,
    maxGuests,
    maxAdults,
    maxChildren,
  });
}

function createRevisionManifest(
  sources: SnapshottedPricingSources,
): PmsMandatoryChargePricingSourceRevisionManifest {
  return deepFreeze({
    pricingCurrencyRevision: sources.pricing.pricingCurrency.pricingCurrencyRevision,
    rooms: sources.rooms.map(({ roomTypeId, roomFactsRevision }) => ({
      roomTypeId,
      roomFactsRevision,
    })),
    flexibleRatePlans: sources.pricing.flexibleRatePlans.map(
      ({ roomTypeId, flexibleRatePlanId, flexibleRatePlanRevision, sourceRoomFactsRevision }) => ({
        roomTypeId,
        flexibleRatePlanId,
        flexibleRatePlanRevision,
        sourceRoomFactsRevision,
      }),
    ),
    optionalPricingAggregateRevision: sources.recurringPricing.optionalPricingAggregateRevision,
    recurringSources: sources.recurringPricing.sources.map((source) => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      validationRevision: source.validation.validationRevision,
      materializationRevision: source.materializationRevision,
    })),
  });
}

function canonicalPricingSourcePayload(sources: SnapshottedPricingSources): unknown {
  return [
    PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION,
    sources.propertyId,
    [
      "currency",
      sources.pricing.pricingCurrency.currency,
      sources.pricing.pricingCurrency.pricingCurrencyRevision,
    ],
    [
      "rooms",
      sources.rooms.map((room) => [
        room.roomTypeId,
        room.roomFactsRevision,
        room.maxGuests,
        room.maxAdults,
        room.maxChildren,
      ]),
    ],
    [
      "flexible",
      sources.pricing.flexibleRatePlans.map((plan) => [
        plan.roomTypeId,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
        plan.sourceRoomFactsRevision,
        plan.baseAmount.amountDecimal,
        plan.baseAmount.currency,
        plan.cancellationTerms.type,
        plan.cancellationTerms.freeCancellationDeadlineDays,
        plan.cancellationTerms.afterDeadlinePenalty,
        plan.cancellationTerms.noShowPenalty,
      ]),
    ],
    [
      "recurring",
      sources.recurringPricing.optionalPricingAggregateRevision,
      sources.recurringPricing.sources.map(canonicalRecurringPayload),
    ],
  ];
}

function canonicalRecurringPayload(source: PmsRecurringPricingSourceSnapshot): unknown {
  const common = [
    source.sourceKind,
    source.sourceId,
    source.sourceRevision,
    source.pricingCurrencyRevision,
    source.currency,
    source.configuredState,
    source.validation.state,
    source.validation.validationRevision,
    source.validation.state === "invalid" ? source.validation.reasons : [],
    source.lifecycle,
    source.materializationRevision,
  ];
  switch (source.sourceKind) {
    case "season":
      return [
        ...common,
        source.name,
        source.startMonthDay,
        source.endMonthDay,
        source.roomPrices.map((room) => [...roomEvidencePayload(room), room.amountDecimal]),
      ];
    case "weekend_surcharge":
      return [
        ...common,
        source.weekdays,
        source.roomSurcharges.map((room) => [...roomEvidencePayload(room), room.amountDecimal]),
      ];
    case "additional_guest":
      return [
        ...common,
        ...roomEvidencePayload(source),
        source.maximumAdultGuests,
        source.includedGuests,
        source.amountDecimal,
      ];
    case "non_refundable":
      return [
        ...common,
        source.discountPercent,
        source.roomPlans.map(roomEvidencePayload),
        source.paymentTiming,
        source.cancellationTerms.type,
        source.cancellationTerms.refundPolicy,
        source.cancellationTerms.noShowPenalty,
      ];
  }
}

function canonicalizeRecurringSource(
  source: PmsRecurringPricingSourceSnapshot,
): PmsRecurringPricingSourceSnapshot {
  const validation =
    source.validation.state === "invalid"
      ? {
          ...source.validation,
          reasons: [...source.validation.reasons].sort(compareInvalidReasons),
        }
      : source.validation;
  switch (source.sourceKind) {
    case "season":
      return {
        ...source,
        validation,
        roomPrices: [...source.roomPrices].sort(compareRoomEvidence),
      };
    case "weekend_surcharge":
      return {
        ...source,
        validation,
        weekdays: [...source.weekdays].sort(
          (left, right) =>
            PMS_RECURRING_PRICING_WEEKDAYS.indexOf(left) -
            PMS_RECURRING_PRICING_WEEKDAYS.indexOf(right),
        ),
        roomSurcharges: [...source.roomSurcharges].sort(compareRoomEvidence),
      };
    case "additional_guest":
      return { ...source, validation };
    case "non_refundable":
      return { ...source, validation, roomPlans: [...source.roomPlans].sort(compareRoomEvidence) };
  }
}

function roomEvidencePayload(room: RecurringPricingRoomEvidence): unknown[] {
  return [
    room.roomTypeId,
    room.roomFactsRevision,
    room.flexibleRatePlanId,
    room.flexibleRatePlanRevision,
  ];
}

function compareRecurringSources(
  left: PmsRecurringPricingSourceSnapshot,
  right: PmsRecurringPricingSourceSnapshot,
): number {
  return (
    PMS_RECURRING_PRICING_SOURCE_KINDS.indexOf(left.sourceKind) -
      PMS_RECURRING_PRICING_SOURCE_KINDS.indexOf(right.sourceKind) ||
    compareCodeUnits(left.sourceId, right.sourceId)
  );
}

function compareRoomEvidence(
  left: RecurringPricingRoomEvidence,
  right: RecurringPricingRoomEvidence,
): number {
  return compareCodeUnits(left.roomTypeId, right.roomTypeId);
}

function compareInvalidReasons(
  left: PmsRecurringPricingInvalidReason,
  right: PmsRecurringPricingInvalidReason,
): number {
  const key = (reason: PmsRecurringPricingInvalidReason) =>
    [
      PMS_RECURRING_PRICING_INVALID_REASON_CODES.indexOf(reason.code),
      "roomTypeId" in reason
        ? reason.roomTypeId
        : "conflictingSourceId" in reason
          ? reason.conflictingSourceId
          : "",
    ] as const;
  const [leftPosition, leftId] = key(left);
  const [rightPosition, rightId] = key(right);
  return leftPosition - rightPosition || compareCodeUnits(leftId, rightId);
}

function parseRevisionManifest(
  value: unknown,
): PmsMandatoryChargePricingSourceRevisionManifest | null {
  if (
    !isExactRecord(value, [
      "pricingCurrencyRevision",
      "rooms",
      "flexibleRatePlans",
      "optionalPricingAggregateRevision",
      "recurringSources",
    ]) ||
    !isRevision(value.pricingCurrencyRevision) ||
    !isDenseArray(value.rooms) ||
    !isDenseArray(value.flexibleRatePlans) ||
    !isIntegerInRange(value.optionalPricingAggregateRevision, 0, 2_147_483_647) ||
    !isDenseArray(value.recurringSources)
  ) {
    return null;
  }
  const rooms = value.rooms.map(parseManifestRoom);
  const plans = value.flexibleRatePlans.map(parseManifestPlan);
  const recurring = value.recurringSources.map(parseManifestRecurringSource);
  if (rooms.some(isNull) || plans.some(isNull) || recurring.some(isNull)) return null;
  const parsedRooms = rooms as PmsMandatoryChargePricingSourceRevisionManifest["rooms"][number][];
  const parsedPlans =
    plans as PmsMandatoryChargePricingSourceRevisionManifest["flexibleRatePlans"][number][];
  const parsedRecurring =
    recurring as PmsMandatoryChargePricingSourceRevisionManifest["recurringSources"][number][];
  if (
    hasDuplicate(parsedRooms, ({ roomTypeId }) => roomTypeId) ||
    hasDuplicate(parsedPlans, ({ roomTypeId }) => roomTypeId) ||
    hasDuplicate(parsedPlans, ({ flexibleRatePlanId }) => flexibleRatePlanId) ||
    hasDuplicate(parsedRecurring, ({ sourceId }) => sourceId) ||
    (value.optionalPricingAggregateRevision === 0) !== (parsedRecurring.length === 0)
  ) {
    return null;
  }
  parsedRooms.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  parsedPlans.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  parsedRecurring.sort(compareManifestRecurringSources);
  return deepFreeze({
    pricingCurrencyRevision: value.pricingCurrencyRevision,
    rooms: parsedRooms,
    flexibleRatePlans: parsedPlans,
    optionalPricingAggregateRevision: value.optionalPricingAggregateRevision,
    recurringSources: parsedRecurring,
  });
}

function parseManifestRoom(
  value: unknown,
): PmsMandatoryChargePricingSourceRevisionManifest["rooms"][number] | null {
  return isExactRecord(value, ["roomTypeId", "roomFactsRevision"]) &&
    isUuid(value.roomTypeId) &&
    isRevision(value.roomFactsRevision)
    ? Object.freeze({
        roomTypeId: value.roomTypeId.toLowerCase(),
        roomFactsRevision: value.roomFactsRevision,
      })
    : null;
}

function parseManifestPlan(
  value: unknown,
): PmsMandatoryChargePricingSourceRevisionManifest["flexibleRatePlans"][number] | null {
  return isExactRecord(value, [
    "roomTypeId",
    "flexibleRatePlanId",
    "flexibleRatePlanRevision",
    "sourceRoomFactsRevision",
  ]) &&
    isUuid(value.roomTypeId) &&
    isUuid(value.flexibleRatePlanId) &&
    isRevision(value.flexibleRatePlanRevision) &&
    isRevision(value.sourceRoomFactsRevision)
    ? Object.freeze({
        roomTypeId: value.roomTypeId.toLowerCase(),
        flexibleRatePlanId: value.flexibleRatePlanId.toLowerCase(),
        flexibleRatePlanRevision: value.flexibleRatePlanRevision,
        sourceRoomFactsRevision: value.sourceRoomFactsRevision,
      })
    : null;
}

function parseManifestRecurringSource(
  value: unknown,
): PmsMandatoryChargePricingSourceRevisionManifest["recurringSources"][number] | null {
  return isExactRecord(value, [
    "sourceKind",
    "sourceId",
    "sourceRevision",
    "validationRevision",
    "materializationRevision",
  ]) &&
    isOneOf(value.sourceKind, PMS_RECURRING_PRICING_SOURCE_KINDS) &&
    isUuid(value.sourceId) &&
    isRevision(value.sourceRevision) &&
    isRevision(value.validationRevision) &&
    isIntegerInRange(value.materializationRevision, 0, 2_147_483_647)
    ? Object.freeze({
        sourceKind: value.sourceKind,
        sourceId: value.sourceId.toLowerCase(),
        sourceRevision: value.sourceRevision,
        validationRevision: value.validationRevision,
        materializationRevision: value.materializationRevision,
      })
    : null;
}

function compareManifestRecurringSources(
  left: PmsMandatoryChargePricingSourceRevisionManifest["recurringSources"][number],
  right: PmsMandatoryChargePricingSourceRevisionManifest["recurringSources"][number],
): number {
  return (
    PMS_RECURRING_PRICING_SOURCE_KINDS.indexOf(left.sourceKind) -
      PMS_RECURRING_PRICING_SOURCE_KINDS.indexOf(right.sourceKind) ||
    compareCodeUnits(left.sourceId, right.sourceId)
  );
}

function parseCommandAudit(value: unknown): PmsPricingCommandAudit | null {
  if (
    !isExactRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isTrimmedText(value.requestId, 1, 200) ||
    !(value.correlationId === null || isTrimmedText(value.correlationId, 1, 200)) ||
    !isCanonicalIsoDateTime(value.requestedAt)
  ) {
    return null;
  }
  const actor = parseCommandActor(value.actor);
  return actor
    ? deepFreeze({
        actor,
        requestId: value.requestId,
        correlationId: value.correlationId,
        requestedAt: value.requestedAt,
      })
    : null;
}

function parseCommandActor(value: unknown): PmsPricingCommandAudit["actor"] | null {
  if (!isRecord(value)) return null;
  if (value.kind === "user" && isExactRecord(value, ["kind", "userId"]) && isUuid(value.userId)) {
    return Object.freeze({ kind: "user", userId: value.userId.toLowerCase() });
  }
  return value.kind === "system" &&
    isExactRecord(value, ["kind", "service"]) &&
    isTrimmedText(value.service, 1, 200)
    ? Object.freeze({ kind: "system", service: value.service })
    : null;
}

function parseCommandError(value: unknown): PmsMandatoryChargeConfirmationCommandError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    isOneOf(value.code, [
      "setup_scope_unavailable",
      "pricing_source_not_configured",
      "pricing_source_conflict",
      "idempotency_key_conflict",
      "command_in_progress",
    ] as const)
  ) {
    return Object.freeze({ code: value.code });
  }
  return isExactRecord(value, ["code", "currentRevision"]) &&
    value.code === "confirmation_revision_conflict" &&
    isIntegerInRange(value.currentRevision, 0, 2_147_483_647)
    ? Object.freeze({ code: value.code, currentRevision: value.currentRevision })
    : null;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) =>
      Object.hasOwn(value, index),
    )
  );
}

function hasDuplicate<T>(values: readonly T[], key: (value: T) => string): boolean {
  return new Set(values.map(key)).size !== values.length;
}

function isNull<T>(value: T | null): value is null {
  return value === null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}

function isTrimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
