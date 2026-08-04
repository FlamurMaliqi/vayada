import { createHash } from "node:crypto";

import {
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentMethodsSourceEntityRevision,
  type FinancePaymentReadinessReadPort,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import {
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM,
  PMS_RECURRING_PRICING_INVALID_REASON_CODES,
  PMS_RECURRING_PRICING_SOURCE_KINDS,
  PMS_RECURRING_PRICING_WEEKDAYS,
  parsePmsMandatoryChargePricingSourceFingerprint,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  serializePmsMandatoryChargePricingSourcePayload,
  type PmsMandatoryChargePricingSourceInput,
  type PmsPricingReadPort,
  type PmsPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingInvalidReason,
  type PmsRecurringPricingReadPort,
  type PmsRecurringPricingSourceSnapshot,
  type RecurringPricingRoomEvidence,
  type RoomPublicationSnapshot,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

export const BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION = "booking-pricing-evidence.v1" as const;
export const BOOKING_PRICING_SCALE = 2 as const;
export const BOOKING_PRICING_ROUNDING_MODE = "decimal_round_half_up" as const;
export const BOOKING_PRICING_FINGERPRINT_ALGORITHM =
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_INPUT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

declare const bookingPricingFingerprintBrand: unique symbol;
declare const bookingPricingEligibilityFingerprintBrand: unique symbol;

export type BookingPricingSourceFingerprint = string & {
  readonly [bookingPricingFingerprintBrand]: true;
};
export type BookingPricingEligibilityFingerprint = string & {
  readonly [bookingPricingEligibilityFingerprintBrand]: true;
};

export type BookingPricingEvidenceRequest = Readonly<{
  organizationId: string;
  propertyId: string;
}>;

export type BookingPricingOwnerEvidenceInput = Readonly<{
  roomPublication: RoomPublicationSnapshot;
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
}>;

export type BookingMandatoryChargeConfirmationEvidence = Readonly<{
  organizationId: string;
  propertyId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  confirmationRevision: number;
  confirmedAt: string;
}>;

export type BookingMandatoryChargeConfirmationEvidenceResult =
  | Readonly<{
      outcome: "available";
      evidence: BookingMandatoryChargeConfirmationEvidence;
    }>
  | Readonly<{ outcome: "missing" }>
  | Readonly<{ outcome: "unavailable"; errorSource: "provider" | "system" }>
  | Readonly<{ outcome: "malformed" }>;

/** VAY-1081 owns the PMS implementation; Booking owns only this fail-closed consumer boundary. */
export interface BookingMandatoryChargeConfirmationEvidencePort {
  readonly bookingPricingConfirmationEvidencePort: "pms_mandatory_charges";
  getMandatoryChargeConfirmation(
    request: BookingPricingEvidenceRequest,
  ): Promise<BookingMandatoryChargeConfirmationEvidenceResult>;
}

/** Concrete adapters are injected later; this contract never opens PMS or Finance tables. */
export type BookingPricingEvidenceOwnerPorts = Readonly<{
  rooms: RoomPublicationSnapshotPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot">;
  recurringPricing: Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  financePaymentReadiness: FinancePaymentReadinessReadPort;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidencePort;
}>;

export type BookingPricingReadinessBlocker = Readonly<{
  code:
    | "publishable_room_required"
    | "flexible_rate_plan_missing"
    | "flexible_rate_plan_room_mismatch"
    | "flexible_rate_plan_room_facts_stale"
    | "optional_source_disabled"
    | "optional_source_invalid"
    | "optional_source_dependency_mismatch"
    | "non_refundable_card_capability_unready"
    | "mandatory_charge_confirmation_missing"
    | "mandatory_charge_confirmation_unavailable"
    | "mandatory_charge_confirmation_malformed"
    | "mandatory_charge_confirmation_stale";
  blocksReadiness: boolean;
  roomTypeId?: string;
  sourceId?: string;
}>;

export type BookingPricingReadiness = Readonly<{
  contractVersion: typeof BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  sourceFingerprint: BookingPricingSourceFingerprint;
  eligibilityFingerprint: BookingPricingEligibilityFingerprint;
  status: "ready" | "blocked";
  flexibleRates: readonly Readonly<{
    roomTypeId: string;
    flexibleRatePlanId: string | null;
    status: "ready" | "blocked";
    blockers: readonly BookingPricingReadinessBlocker[];
  }>[];
  optionalSources: readonly Readonly<{
    sourceId: string;
    sourceKind: PmsRecurringPricingSourceSnapshot["sourceKind"];
    lifecycle: PmsRecurringPricingSourceSnapshot["lifecycle"];
    status: "ready" | "disabled" | "blocked";
    blockers: readonly BookingPricingReadinessBlocker[];
  }>[];
  mandatoryChargeConfirmation:
    | Readonly<{
        status: "current" | "stale";
        confirmationRevision: number;
        confirmedAt: string;
      }>
    | Readonly<{ status: "missing" | "unavailable" | "malformed" }>;
  financePaymentReadiness:
    | Readonly<{
        status: "current";
        source: FinancePaymentMethodsSourceEntityRevision;
      }>
    | Readonly<{ status: "missing" | "malformed" }>;
  blockers: readonly BookingPricingReadinessBlocker[];
}>;

export function parseBookingPricingEvidenceRequest(
  value: unknown,
): BookingPricingEvidenceRequest | null {
  if (
    !isExactRecord(value, ["organizationId", "propertyId"]) ||
    !isUuidInput(value.organizationId) ||
    !isUuidInput(value.propertyId)
  )
    return null;
  return Object.freeze({
    organizationId: value.organizationId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
  });
}

export function parseBookingPricingSourceFingerprint(
  value: unknown,
): BookingPricingSourceFingerprint | null {
  return typeof value === "string" && SHA_256_PATTERN.test(value)
    ? (value as BookingPricingSourceFingerprint)
    : null;
}

export function parseBookingMandatoryChargeConfirmationEvidenceResult(
  value: unknown,
): BookingMandatoryChargeConfirmationEvidenceResult {
  if (isExactRecord(value, ["outcome"]) && value.outcome === "missing")
    return Object.freeze({ outcome: "missing" });
  if (isExactRecord(value, ["outcome"]) && value.outcome === "malformed")
    return Object.freeze({ outcome: "malformed" });
  if (
    isExactRecord(value, ["outcome", "errorSource"]) &&
    value.outcome === "unavailable" &&
    (value.errorSource === "provider" || value.errorSource === "system")
  )
    return Object.freeze({ outcome: "unavailable", errorSource: value.errorSource });
  if (!isExactRecord(value, ["outcome", "evidence"]) || value.outcome !== "available")
    return Object.freeze({ outcome: "malformed" });
  const evidence = value.evidence;
  if (
    !isExactRecord(evidence, [
      "organizationId",
      "propertyId",
      "pricingSourceFingerprint",
      "confirmationRevision",
      "confirmedAt",
    ]) ||
    !isCanonicalUuid(evidence.organizationId) ||
    !isCanonicalUuid(evidence.propertyId) ||
    !isPositiveRevision(evidence.confirmationRevision) ||
    !isCanonicalIsoDateTime(evidence.confirmedAt)
  )
    return Object.freeze({ outcome: "malformed" });
  const pricingSourceFingerprint = parseBookingPricingSourceFingerprint(
    evidence.pricingSourceFingerprint,
  );
  return pricingSourceFingerprint
    ? deepFreeze({
        outcome: "available",
        evidence: {
          organizationId: evidence.organizationId,
          propertyId: evidence.propertyId,
          pricingSourceFingerprint,
          confirmationRevision: evidence.confirmationRevision,
          confirmedAt: evidence.confirmedAt,
        },
      })
    : Object.freeze({ outcome: "malformed" });
}

export function createBookingPricingSourceFingerprint(
  requestValue: BookingPricingEvidenceRequest,
  input: BookingPricingOwnerEvidenceInput,
): BookingPricingSourceFingerprint {
  const request = requireRequest(requestValue);
  const sources = snapshotOwnerEvidence(request, input);
  return createSourceFingerprint(sources);
}

export function composeBookingPricingReadiness(
  requestValue: BookingPricingEvidenceRequest,
  input: BookingPricingOwnerEvidenceInput,
  confirmationValue: unknown,
  financeValue: unknown,
): BookingPricingReadiness {
  const request = requireRequest(requestValue);
  const sources = snapshotOwnerEvidence(request, input);
  const sourceFingerprint = createSourceFingerprint(sources);
  const blockers: BookingPricingReadinessBlocker[] = [];
  const finance = parseFinanceReadiness(request, financeValue);
  const financePaymentReadiness = finance
    ? Object.freeze({
        status: "current" as const,
        source: createFinancePaymentMethodsSourceEntityRevision(
          finance.propertyId,
          finance.paymentMethodsRevision,
        ),
      })
    : Object.freeze({
        status: financeValue === null ? ("missing" as const) : ("malformed" as const),
      });
  const cardReady = finance?.methods.some(
    (method) =>
      method.method === "card" &&
      method.selected &&
      method.availability === "available" &&
      method.readiness === "ready",
  );
  const roomById = new Map(sources.rooms.map((room) => [room.roomTypeId, room]));
  const planByRoomId = new Map(
    sources.pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]),
  );

  if (sources.rooms.length === 0) blockers.push(blocker("publishable_room_required", true));
  const flexibleRates = sources.rooms.map((room) => {
    const plan = planByRoomId.get(room.roomTypeId);
    const rateBlockers: BookingPricingReadinessBlocker[] = [];
    if (!plan) rateBlockers.push(blocker("flexible_rate_plan_missing", true, room.roomTypeId));
    else if (plan.sourceRoomFactsRevision !== room.roomFactsRevision)
      rateBlockers.push(blocker("flexible_rate_plan_room_facts_stale", true, room.roomTypeId));
    blockers.push(...rateBlockers);
    return Object.freeze({
      roomTypeId: room.roomTypeId,
      flexibleRatePlanId: plan?.flexibleRatePlanId ?? null,
      status: rateBlockers.length === 0 ? ("ready" as const) : ("blocked" as const),
      blockers: Object.freeze(rateBlockers),
    });
  });
  for (const plan of sources.pricing.flexibleRatePlans) {
    if (!roomById.has(plan.roomTypeId))
      blockers.push(blocker("flexible_rate_plan_room_mismatch", true, plan.roomTypeId));
  }

  const optionalSources = sources.recurringPricing.sources.map((source) => {
    const sourceBlockers: BookingPricingReadinessBlocker[] = [];
    if (source.lifecycle === "disabled")
      sourceBlockers.push(blocker("optional_source_disabled", false, undefined, source.sourceId));
    if (source.lifecycle === "invalid")
      sourceBlockers.push(blocker("optional_source_invalid", true, undefined, source.sourceId));
    if (!sourceDependenciesMatch(source, sources.rooms, roomById, planByRoomId))
      sourceBlockers.push(
        blocker(
          "optional_source_dependency_mismatch",
          source.lifecycle !== "disabled",
          undefined,
          source.sourceId,
        ),
      );
    if (source.lifecycle === "active" && source.sourceKind === "non_refundable" && !cardReady)
      sourceBlockers.push(
        blocker("non_refundable_card_capability_unready", false, undefined, source.sourceId),
      );
    blockers.push(...sourceBlockers);
    return Object.freeze({
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      lifecycle: source.lifecycle,
      status:
        source.lifecycle === "disabled"
          ? ("disabled" as const)
          : sourceBlockers.length > 0
            ? ("blocked" as const)
            : ("ready" as const),
      blockers: Object.freeze(sourceBlockers),
    });
  });

  const confirmation = parseBookingMandatoryChargeConfirmationEvidenceResult(confirmationValue);
  let confirmationReadiness: BookingPricingReadiness["mandatoryChargeConfirmation"];
  if (confirmation.outcome === "available") {
    if (
      confirmation.evidence.organizationId !== request.organizationId ||
      confirmation.evidence.propertyId !== request.propertyId
    ) {
      confirmationReadiness = Object.freeze({ status: "malformed" });
      blockers.push(blocker("mandatory_charge_confirmation_malformed", true));
    } else if (confirmation.evidence.pricingSourceFingerprint !== sourceFingerprint) {
      confirmationReadiness = Object.freeze({
        status: "stale",
        confirmationRevision: confirmation.evidence.confirmationRevision,
        confirmedAt: confirmation.evidence.confirmedAt,
      });
      blockers.push(blocker("mandatory_charge_confirmation_stale", true));
    } else {
      confirmationReadiness = Object.freeze({
        status: "current",
        confirmationRevision: confirmation.evidence.confirmationRevision,
        confirmedAt: confirmation.evidence.confirmedAt,
      });
    }
  } else {
    confirmationReadiness = Object.freeze({ status: confirmation.outcome });
    blockers.push(
      blocker(
        confirmation.outcome === "missing"
          ? "mandatory_charge_confirmation_missing"
          : confirmation.outcome === "unavailable"
            ? "mandatory_charge_confirmation_unavailable"
            : "mandatory_charge_confirmation_malformed",
        true,
      ),
    );
  }

  blockers.sort(compareBlockers);
  const eligibilityFingerprint = createEligibilityFingerprint(
    sourceFingerprint,
    financePaymentReadiness,
  );
  return deepFreeze({
    contractVersion: BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION,
    organizationId: request.organizationId,
    propertyId: request.propertyId,
    sourceFingerprint,
    eligibilityFingerprint,
    status: blockers.some(({ blocksReadiness }) => blocksReadiness) ? "blocked" : "ready",
    flexibleRates,
    optionalSources,
    mandatoryChargeConfirmation: confirmationReadiness,
    financePaymentReadiness,
    blockers,
  });
}

type CanonicalRoom = Readonly<{
  roomTypeId: string;
  roomFactsRevision: number;
  maxGuests: number;
  maxAdults: number;
  maxChildren: number;
}>;

function snapshotOwnerEvidence(
  request: BookingPricingEvidenceRequest,
  input: BookingPricingOwnerEvidenceInput,
) {
  try {
    const rooms = snapshotRooms(request.propertyId, input.roomPublication);
    const pricingCandidate = {
      ...structuredClone(input.pricing),
      flexibleRatePlans: [...structuredClone(input.pricing.flexibleRatePlans)].sort((left, right) =>
        compareCodeUnits(left.roomTypeId, right.roomTypeId),
      ),
    };
    const pricing = parsePmsPricingSourceSnapshot(pricingCandidate);
    const recurringCandidate = {
      ...structuredClone(input.recurringPricing),
      sources: structuredClone(input.recurringPricing.sources)
        .map(canonicalizeRecurringSource)
        .sort(compareRecurringSources),
    };
    const recurringPricing = parsePmsRecurringPricingBookingEvidence(recurringCandidate);
    if (
      !pricing ||
      !recurringPricing ||
      pricing.propertyId !== request.propertyId ||
      recurringPricing.propertyId !== request.propertyId ||
      recurringPricing.currency !== pricing.pricingCurrency.currency ||
      recurringPricing.pricingCurrencyRevision !== pricing.pricingCurrency.pricingCurrencyRevision
    )
      throw new TypeError();
    return { rooms, pricing, recurringPricing };
  } catch {
    throw new TypeError("Booking pricing owner evidence is invalid or outside request scope");
  }
}

function snapshotRooms(
  propertyId: string,
  snapshot: RoomPublicationSnapshot,
): readonly CanonicalRoom[] {
  if (snapshot.propertyId !== propertyId || !Array.isArray(snapshot.rooms)) throw new TypeError();
  const rooms = snapshot.rooms.map((room) => {
    const occupancy = room.facts?.occupancy;
    if (
      room.propertyId !== propertyId ||
      !isCanonicalUuid(room.roomTypeId) ||
      !isPositiveRevision(room.sourceRevisions?.roomFactsRevision) ||
      !occupancy ||
      !isPositiveCount(occupancy.maxGuests) ||
      !isPositiveCount(occupancy.maxAdults) ||
      !isNonNegativeCount(occupancy.maxChildren) ||
      occupancy.maxAdults > occupancy.maxGuests ||
      occupancy.maxAdults + occupancy.maxChildren < occupancy.maxGuests
    )
      throw new TypeError();
    return Object.freeze({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: room.sourceRevisions.roomFactsRevision,
      maxGuests: occupancy.maxGuests,
      maxAdults: occupancy.maxAdults,
      maxChildren: occupancy.maxChildren,
    });
  });
  rooms.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  if (new Set(rooms.map(({ roomTypeId }) => roomTypeId)).size !== rooms.length)
    throw new TypeError();
  return Object.freeze(rooms);
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
      return {
        ...source,
        validation,
        roomPlans: [...source.roomPlans].sort(compareRoomEvidence),
      };
  }
}

function createSourceFingerprint(
  sources: ReturnType<typeof snapshotOwnerEvidence>,
): BookingPricingSourceFingerprint {
  const input: PmsMandatoryChargePricingSourceInput = {
    rooms: sources.rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: room.roomFactsRevision,
      occupancy: {
        maxGuests: room.maxGuests,
        maxAdults: room.maxAdults,
        maxChildren: room.maxChildren,
      },
    })),
    pricing: sources.pricing,
    recurringPricing: sources.recurringPricing,
  };
  try {
    const digest = createHash(PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM)
      .update(serializePmsMandatoryChargePricingSourcePayload(input))
      .digest("hex");
    const ownerParsed = parsePmsMandatoryChargePricingSourceFingerprint(digest);
    const bookingParsed = parseBookingPricingSourceFingerprint(ownerParsed);
    if (!bookingParsed) throw new TypeError();
    return bookingParsed;
  } catch {
    throw new TypeError("Booking pricing owner evidence is invalid or outside request scope");
  }
}

function parseFinanceReadiness(
  request: BookingPricingEvidenceRequest,
  value: unknown,
): FinancePaymentReadinessSnapshot | null {
  const parsed = parseFinancePaymentReadinessSnapshot(value);
  return parsed?.propertyId === request.propertyId ? parsed : null;
}

function createEligibilityFingerprint(
  sourceFingerprint: BookingPricingSourceFingerprint,
  finance: BookingPricingReadiness["financePaymentReadiness"],
): BookingPricingEligibilityFingerprint {
  const financePayload =
    finance.status === "current"
      ? [
          finance.status,
          finance.source.ownerDomain,
          finance.source.entityType,
          finance.source.entityId,
          finance.source.revision,
        ]
      : [finance.status];
  return createHash(BOOKING_PRICING_FINGERPRINT_ALGORITHM)
    .update(
      JSON.stringify([
        BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION,
        sourceFingerprint,
        financePayload,
      ]),
    )
    .digest("hex") as BookingPricingEligibilityFingerprint;
}

function sourceDependenciesMatch(
  source: PmsRecurringPricingSourceSnapshot,
  rooms: readonly CanonicalRoom[],
  roomById: ReadonlyMap<string, CanonicalRoom>,
  planByRoomId: ReadonlyMap<string, PmsPricingSourceSnapshot["flexibleRatePlans"][number]>,
): boolean {
  const bindings: readonly RecurringPricingRoomEvidence[] =
    source.sourceKind === "season"
      ? source.roomPrices
      : source.sourceKind === "weekend_surcharge"
        ? source.roomSurcharges
        : source.sourceKind === "non_refundable"
          ? source.roomPlans
          : [source];
  if (
    source.sourceKind !== "additional_guest" &&
    rooms.some((room) => !bindings.some((binding) => binding.roomTypeId === room.roomTypeId))
  )
    return false;
  return bindings.every((binding) => {
    const room = roomById.get(binding.roomTypeId);
    const plan = planByRoomId.get(binding.roomTypeId);
    return Boolean(
      room &&
      plan &&
      binding.roomFactsRevision === room.roomFactsRevision &&
      binding.flexibleRatePlanId === plan.flexibleRatePlanId &&
      binding.flexibleRatePlanRevision === plan.flexibleRatePlanRevision,
    );
  });
}

function requireRequest(value: BookingPricingEvidenceRequest): BookingPricingEvidenceRequest {
  const parsed = parseBookingPricingEvidenceRequest(value);
  if (!parsed) throw new TypeError("Booking pricing evidence request is invalid");
  return parsed;
}

function blocker(
  code: BookingPricingReadinessBlocker["code"],
  blocksReadiness: boolean,
  roomTypeId?: string,
  sourceId?: string,
): BookingPricingReadinessBlocker {
  return Object.freeze({
    code,
    blocksReadiness,
    ...(roomTypeId ? { roomTypeId } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
}

function compareBlockers(
  left: BookingPricingReadinessBlocker,
  right: BookingPricingReadinessBlocker,
): number {
  return compareCodeUnits(
    JSON.stringify([left.roomTypeId ?? "", left.sourceId ?? "", left.code]),
    JSON.stringify([right.roomTypeId ?? "", right.sourceId ?? "", right.code]),
  );
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function isUuidInput(value: unknown): value is string {
  return typeof value === "string" && UUID_INPUT_PATTERN.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function isPositiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10_000;
}

function isNonNegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
