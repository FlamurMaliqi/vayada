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
import { parsePmsPricingSourceSnapshot, type PmsPricingSourceSnapshot } from "./pricing.js";

export const PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION =
  "pms-mandatory-charge-pricing-source.v1" as const;
export const PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM = "sha256" as const;
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
    !isIntegerInRange(maxGuests, 1, 10_000) ||
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
    ownKeys.includes("length") &&
    Array.from({ length: value.length }, (_, index) => String(index)).every((key) =>
      ownKeys.includes(key),
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
