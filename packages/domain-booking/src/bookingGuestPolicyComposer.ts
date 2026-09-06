import { createHash } from "node:crypto";

import {
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  serializePmsPricingSourceEntityRevision,
  type PmsPricingSourceEntityRevision,
  type PmsRecurringPricingSourceSnapshot,
} from "@vayada/domain-pms";

import {
  composeBookingPricingReadiness,
  parseBookingMandatoryChargeConfirmationEvidenceResult,
  parseBookingPricingEvidenceRequest,
  type BookingPricingEvidenceRequest,
  type BookingPricingOwnerEvidenceInput,
  type BookingPricingReadinessBlocker,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";
import {
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  parseBookingGuestPolicyChoices,
  bookingArrivalBounds,
  type BookingGuestPolicyBundle,
  type BookingGuestPolicyCatalogProfileEvidence,
  type BookingGuestPolicyCatalogProfileEvidenceResult,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyCompositionBlocker,
  type BookingGuestPolicyHash,
  type BookingGuestPolicyRateDisclosure,
  type BookingGuestPolicyRecurringSourceBinding,
  type BookingGuestPolicySourceBinding,
} from "./bookingGuestPolicy.js";

export type BookingGuestPolicyCompositionInput = Readonly<{
  request: BookingPricingEvidenceRequest;
  choices: BookingGuestPolicyChoices;
  catalogProfile: BookingGuestPolicyCatalogProfileEvidenceResult;
  pricing: BookingPricingOwnerEvidenceInput | null;
  mandatoryChargeConfirmation: unknown;
}>;

export function composeBookingGuestPolicy(
  input: BookingGuestPolicyCompositionInput,
): BookingGuestPolicyComposition {
  const request = parseBookingPricingEvidenceRequest(input.request);
  const choices = parseBookingGuestPolicyChoices(input.choices);
  if (!request || !choices)
    throw new TypeError("Booking guest-policy composition input is invalid");

  const blockers: BookingGuestPolicyCompositionBlocker[] = [];
  const sourceBindings: BookingGuestPolicySourceBinding[] = [];
  if (input.catalogProfile.outcome === "available")
    sourceBindings.push(input.catalogProfile.evidence.source);
  else if (
    input.catalogProfile.outcome === "timezone_missing" ||
    input.catalogProfile.outcome === "timezone_invalid"
  )
    sourceBindings.push(input.catalogProfile.source);
  const catalog = catalogEvidence(request.propertyId, input.catalogProfile, blockers);
  const pricing = input.pricing ? structuredClone(input.pricing) : null;
  if (!pricing) blockers.push(blocker("pricing_source_missing"));
  else preflightPricing(pricing, choices, blockers);

  let pricingFingerprint: BookingPricingSourceFingerprint | null = null;
  if (
    pricing &&
    !blockers.some(({ code }) => code.startsWith("pricing_") || code.includes("capacity"))
  ) {
    try {
      const readiness = composeBookingPricingReadiness(
        request,
        pricing,
        input.mandatoryChargeConfirmation,
        null,
      );
      pricingFingerprint = readiness.sourceFingerprint;
      blockers.push(...pricingGraphBlockers(readiness.blockers));
    } catch {
      blockers.push(blocker("pricing_source_invalid"));
    }
  }

  let rates: readonly BookingGuestPolicyRateDisclosure[] = [];
  if (pricing && pricingFingerprint) {
    const composed = composeRates(pricing, choices, catalog?.timeZone ?? null);
    rates = composed.rates;
    blockers.push(...composed.blockers);
    sourceBindings.push(...ownerBindings(pricing));
  }

  let confirmationRevision: number | null = null;
  if (pricingFingerprint) {
    const confirmation = parseBookingMandatoryChargeConfirmationEvidenceResult(
      input.mandatoryChargeConfirmation,
    );
    if (confirmation.outcome === "missing")
      blockers.push(blocker("mandatory_charge_confirmation_missing"));
    else if (confirmation.outcome === "unavailable")
      blockers.push(blocker("mandatory_charge_confirmation_unavailable"));
    else if (confirmation.outcome === "malformed")
      blockers.push(blocker("mandatory_charge_confirmation_malformed"));
    else if (
      confirmation.evidence.organizationId !== request.organizationId ||
      confirmation.evidence.propertyId !== request.propertyId
    )
      blockers.push(blocker("mandatory_charge_confirmation_malformed"));
    else if (confirmation.evidence.pricingSourceFingerprint !== pricingFingerprint)
      blockers.push(blocker("mandatory_charge_confirmation_stale"));
    else {
      confirmationRevision = confirmation.evidence.confirmationRevision;
      sourceBindings.push({
        ownerDomain: "pms",
        entityType: "pms_mandatory_charge_confirmation.v1",
        entityId: request.propertyId,
        revision: String(confirmationRevision),
      });
    }
  }

  const canonical = canonicalBindings(sourceBindings);
  if (canonical.conflict) blockers.push(blocker("pricing_source_invalid"));
  const bindings = canonical.bindings;
  const finalBlockers = canonicalBlockers(blockers);
  const sourceFingerprint = digest([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    pricingFingerprint,
    confirmationRevision,
    bindings,
    rates.map(({ roomTypeId, roomFactsRevision, flexible, nonRefundable, additionalGuest }) => [
      roomTypeId,
      roomFactsRevision,
      flexible.source,
      nonRefundable?.source ?? null,
      additionalGuest?.source ?? null,
    ]),
  ]);
  if (
    finalBlockers.length > 0 ||
    !catalog ||
    !pricing ||
    !pricingFingerprint ||
    !confirmationRevision
  ) {
    return deepFreeze({
      outcome: "blocked",
      organizationId: request.organizationId,
      propertyId: request.propertyId,
      sourceBindings: bindings,
      sourceFingerprint,
      blockers: finalBlockers,
    });
  }

  const bundle: BookingGuestPolicyBundle = {
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId: request.organizationId,
    propertyId: request.propertyId,
    choices,
    pricingCurrency: pricing.pricing.pricingCurrency.currency,
    propertyTimeZone: catalog.timeZone,
    pricingSourceFingerprint: pricingFingerprint,
    mandatoryChargeConfirmationRevision: confirmationRevision,
    sourceBindings: bindings,
    sourceFingerprint,
    rates,
    bundleHash: digest([
      BOOKING_GUEST_POLICY_CONTRACT_VERSION,
      sourceFingerprint,
      {
        childrenEnabled: choices.childrenEnabled,
        adultAgeThreshold: choices.childrenEnabled ? choices.adultAgeThreshold : null,
        checkInTime: choices.checkInTime,
        checkOutTime: choices.checkOutTime,
        ...bookingArrivalBounds(choices),
      },
      pricing.pricing.pricingCurrency.currency,
      catalog.timeZone,
      rates,
    ]),
  };
  return deepFreeze({ outcome: "ready", bundle });
}

function catalogEvidence(
  propertyId: string,
  result: BookingGuestPolicyCatalogProfileEvidenceResult,
  blockers: BookingGuestPolicyCompositionBlocker[],
): BookingGuestPolicyCatalogProfileEvidence | null {
  switch (result.outcome) {
    case "timezone_missing":
      blockers.push(blocker("property_timezone_missing"));
      return null;
    case "timezone_invalid":
      blockers.push(blocker("property_timezone_invalid"));
      return null;
    case "unavailable":
      blockers.push(blocker("property_profile_unavailable"));
      return null;
    case "malformed":
      blockers.push(blocker("property_profile_malformed"));
      return null;
  }
  const { source, timeZone } = result.evidence;
  if (
    source.ownerDomain === "hotel_catalog" &&
    source.entityType === "property_profile" &&
    source.entityId === propertyId &&
    /^profile:[1-9][0-9]*$/.test(source.revision) &&
    validTimeZone(timeZone)
  )
    return structuredClone(result.evidence);
  blockers.push(blocker("property_profile_malformed"));
  return null;
}

function preflightPricing(
  input: BookingPricingOwnerEvidenceInput,
  choices: BookingGuestPolicyChoices,
  blockers: BookingGuestPolicyCompositionBlocker[],
): void {
  if (
    input.pricing.pricingCurrency.currency !== input.recurringPricing.currency ||
    input.pricing.pricingCurrency.pricingCurrencyRevision !==
      input.recurringPricing.pricingCurrencyRevision
  )
    blockers.push(blocker("pricing_currency_mismatch"));
  if (input.roomPublication.rooms.length === 0) blockers.push(blocker("room_capacity_missing"));
  for (const room of input.roomPublication.rooms) {
    const occupancy = room.facts?.occupancy;
    if (!occupancy) blockers.push(blocker("room_capacity_missing", room.roomTypeId));
    else if (
      !positive(occupancy.maxGuests) ||
      !positive(occupancy.maxAdults) ||
      !nonNegative(occupancy.maxChildren) ||
      occupancy.maxAdults > occupancy.maxGuests
    )
      blockers.push(blocker("room_capacity_invalid", room.roomTypeId));
    else if (
      choices.childrenEnabled &&
      occupancy.maxAdults + occupancy.maxChildren < occupancy.maxGuests
    )
      blockers.push(blocker("child_policy_capacity_incompatible", room.roomTypeId));
  }
}

function composeRates(
  input: BookingPricingOwnerEvidenceInput,
  choices: BookingGuestPolicyChoices,
  timeZone: string | null,
): Readonly<{
  rates: readonly BookingGuestPolicyRateDisclosure[];
  blockers: readonly BookingGuestPolicyCompositionBlocker[];
}> {
  const blockers: BookingGuestPolicyCompositionBlocker[] = [];
  if (!timeZone) return { rates: [], blockers };
  const plans = new Map(input.pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]));
  const recurring = input.recurringPricing.sources.filter(
    ({ lifecycle }) => lifecycle !== "disabled",
  );
  for (const source of recurring) {
    if (source.lifecycle === "invalid")
      blockers.push(blocker("optional_rate_policy_invalid", undefined, source.sourceId));
  }
  const nonRefundable = recurring.filter(
    (
      source,
    ): source is Extract<PmsRecurringPricingSourceSnapshot, { sourceKind: "non_refundable" }> =>
      source.lifecycle === "active" && source.sourceKind === "non_refundable",
  );
  if (nonRefundable.length > 1)
    blockers.push(
      ...nonRefundable.map(({ sourceId }) =>
        blocker("optional_rate_policy_invalid", undefined, sourceId),
      ),
    );

  const rates = [...input.roomPublication.rooms]
    .sort((left, right) => compare(left.roomTypeId, right.roomTypeId))
    .flatMap((room): BookingGuestPolicyRateDisclosure[] => {
      const plan = plans.get(room.roomTypeId);
      if (!plan || plan.sourceRoomFactsRevision !== room.sourceRevisions.roomFactsRevision) {
        blockers.push(blocker("flexible_rate_policy_missing", room.roomTypeId));
        return [];
      }
      if (plan.cancellationTerms.flexibleCancellationType === "partial_refund") {
        blockers.push(blocker("pricing_source_invalid", room.roomTypeId));
        return [];
      }
      const flexibleSource = pmsSource(
        PMS_PRICING_SOURCE_ENTITY_TYPES.flexibleRatePlan,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
      );
      const additional = recurring.filter(
        (
          source,
        ): source is Extract<
          PmsRecurringPricingSourceSnapshot,
          { sourceKind: "additional_guest" }
        > =>
          source.lifecycle === "active" &&
          source.sourceKind === "additional_guest" &&
          source.roomTypeId === room.roomTypeId,
      );
      if (additional.length > 1)
        blockers.push(
          ...additional.map(({ sourceId }) =>
            blocker("optional_rate_policy_invalid", room.roomTypeId, sourceId),
          ),
        );
      const extra = additional.length === 1 ? additional[0]! : null;
      const nonRefund = nonRefundable.length === 1 ? nonRefundable[0]! : null;
      if (
        extra &&
        (!matchesRoom(
          extra,
          room.roomTypeId,
          room.sourceRevisions.roomFactsRevision,
          plan.flexibleRatePlanId,
          plan.flexibleRatePlanRevision,
        ) ||
          extra.maximumAdultGuests !== room.facts.occupancy.maxAdults)
      )
        blockers.push(blocker("optional_rate_policy_invalid", room.roomTypeId, extra.sourceId));
      if (
        nonRefund &&
        !nonRefund.roomPlans.some((binding) =>
          matchesRoom(
            binding,
            room.roomTypeId,
            room.sourceRevisions.roomFactsRevision,
            plan.flexibleRatePlanId,
            plan.flexibleRatePlanRevision,
          ),
        )
      )
        blockers.push(blocker("optional_rate_policy_invalid", room.roomTypeId, nonRefund.sourceId));
      return [
        {
          roomTypeId: room.roomTypeId,
          roomFactsRevision: room.sourceRevisions.roomFactsRevision,
          flexible: {
            source: flexibleSource,
            freeCancellationDeadlineDays: plan.cancellationTerms.freeCancellationDeadlineDays,
            cutoff: { localTime: choices.checkInTime, timeZone },
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
          nonRefundable: nonRefund
            ? {
                source: recurringBinding(nonRefund),
                refundPolicy: "no_refund",
                noShowPenalty: "full_booking_amount",
                paymentTiming: "prepay_full",
              }
            : null,
          additionalGuest: extra
            ? {
                source: recurringBinding(extra),
                includedGuestsPerRoom: extra.includedGuests,
                amountDecimal: extra.amountDecimal,
                currency: extra.currency,
                countedGuestTypes: choices.childrenEnabled ? ["adult", "child"] : ["adult"],
              }
            : null,
        },
      ];
    });
  return deepFreeze({ rates, blockers });
}

function pricingGraphBlockers(
  ownerBlockers: readonly BookingPricingReadinessBlocker[],
): BookingGuestPolicyCompositionBlocker[] {
  return ownerBlockers.flatMap((owner) => {
    if (!owner.blocksReadiness) return [];
    switch (owner.code) {
      case "publishable_room_required":
        return [blocker("room_capacity_missing")];
      case "flexible_rate_plan_missing":
        return [blocker("flexible_rate_policy_missing", owner.roomTypeId)];
      case "flexible_rate_plan_room_mismatch":
      case "flexible_rate_plan_room_facts_stale":
        return [blocker("pricing_source_invalid", owner.roomTypeId)];
      case "optional_source_invalid":
      case "optional_source_dependency_mismatch":
        return [blocker("optional_rate_policy_invalid", owner.roomTypeId, owner.sourceId)];
      default:
        return [];
    }
  });
}

function ownerBindings(input: BookingPricingOwnerEvidenceInput): BookingGuestPolicySourceBinding[] {
  const bindings: BookingGuestPolicySourceBinding[] = [
    pmsSource(
      PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
      input.pricing.propertyId,
      input.pricing.pricingCurrency.pricingCurrencyRevision,
    ),
    pmsSource(
      PMS_PRICING_SOURCE_ENTITY_TYPES.optionalPricingAggregate,
      input.recurringPricing.propertyId,
      input.recurringPricing.optionalPricingAggregateRevision,
    ),
  ];
  for (const room of input.roomPublication.rooms)
    bindings.push({
      ownerDomain: "pms",
      entityType: "pms_room_facts.v1",
      entityId: room.roomTypeId,
      revision: String(room.sourceRevisions.roomFactsRevision),
    });
  for (const plan of input.pricing.flexibleRatePlans)
    bindings.push(
      pmsSource(
        PMS_PRICING_SOURCE_ENTITY_TYPES.flexibleRatePlan,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
      ),
    );
  for (const source of input.recurringPricing.sources)
    bindings.push(
      pmsSource(
        PMS_PRICING_SOURCE_ENTITY_TYPES.recurringPricingRule,
        source.sourceId,
        source.sourceRevision,
      ),
    );
  return bindings;
}

function recurringBinding(
  source: PmsRecurringPricingSourceSnapshot,
): BookingGuestPolicyRecurringSourceBinding {
  return {
    source: pmsSource(
      PMS_PRICING_SOURCE_ENTITY_TYPES.recurringPricingRule,
      source.sourceId,
      source.sourceRevision,
    ),
    validationRevision: source.validation.validationRevision,
    materializationRevision: source.materializationRevision,
  };
}

function pmsSource(
  entityType: PmsPricingSourceEntityRevision["entityType"],
  entityId: string,
  revision: number,
): PmsPricingSourceEntityRevision {
  const source = serializePmsPricingSourceEntityRevision(entityType, entityId, revision);
  if (!source) throw new TypeError("PMS pricing source revision is invalid");
  return source;
}

function matchesRoom(
  binding: {
    roomTypeId: string;
    roomFactsRevision: number;
    flexibleRatePlanId: string;
    flexibleRatePlanRevision: number;
  },
  roomTypeId: string,
  roomFactsRevision: number,
  planId: string,
  planRevision: number,
): boolean {
  return (
    binding.roomTypeId === roomTypeId &&
    binding.roomFactsRevision === roomFactsRevision &&
    binding.flexibleRatePlanId === planId &&
    binding.flexibleRatePlanRevision === planRevision
  );
}

function canonicalBindings(
  bindings: BookingGuestPolicySourceBinding[],
): Readonly<{ bindings: readonly BookingGuestPolicySourceBinding[]; conflict: boolean }> {
  const sorted = bindings
    .map(({ ownerDomain, entityType, entityId, revision }) =>
      Object.freeze({ ownerDomain, entityType, entityId, revision }),
    )
    .sort((left, right) => compare(bindingTuple(left), bindingTuple(right)));
  const unique: BookingGuestPolicySourceBinding[] = [];
  let conflict = false;
  for (const source of sorted) {
    const prior = unique.at(-1);
    if (!prior || bindingIdentity(prior) !== bindingIdentity(source)) unique.push(source);
    else if (prior.revision !== source.revision) conflict = true;
  }
  return Object.freeze({ bindings: Object.freeze(unique), conflict });
}

function bindingIdentity(source: BookingGuestPolicySourceBinding): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId]);
}

function bindingTuple(source: BookingGuestPolicySourceBinding): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId, source.revision]);
}

function blocker(
  code: BookingGuestPolicyCompositionBlocker["code"],
  roomTypeId?: string,
  sourceId?: string,
): BookingGuestPolicyCompositionBlocker {
  return Object.freeze({
    code,
    ...(roomTypeId ? { roomTypeId } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
}

function compareBlockers(
  left: BookingGuestPolicyCompositionBlocker,
  right: BookingGuestPolicyCompositionBlocker,
): number {
  return compare(
    JSON.stringify([left.roomTypeId ?? "", left.sourceId ?? "", left.code]),
    JSON.stringify([right.roomTypeId ?? "", right.sourceId ?? "", right.code]),
  );
}

function canonicalBlockers(
  blockers: readonly BookingGuestPolicyCompositionBlocker[],
): readonly BookingGuestPolicyCompositionBlocker[] {
  return [
    ...new Map(
      blockers.map((candidate) => [
        JSON.stringify([candidate.roomTypeId ?? "", candidate.sourceId ?? "", candidate.code]),
        candidate,
      ]),
    ).values(),
  ].sort(compareBlockers);
}

function digest(value: unknown): BookingGuestPolicyHash {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value.length > 0;
  } catch {
    return false;
  }
}
function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function nonNegative(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
