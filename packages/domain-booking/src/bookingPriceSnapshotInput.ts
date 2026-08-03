import { isDeepStrictEqual } from "node:util";

import {
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentMethodsSourceEntityRevision,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import {
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  serializePmsPricingSourceEntityRevision,
  type FlexibleCancellationTerms,
  type NonRefundableCancellationTerms,
  type PmsPricingSourceEntityRevision,
} from "@vayada/domain-pms";

import {
  BOOKING_PRICE_MAX_MINOR_UNITS,
  calculateBookingPrice,
  type BookingAppliedSourceRevision,
  type BookingPriceCalculation,
  type BookingPriceCalculationInput,
  type BookingPriceMinorUnits,
} from "./bookingPriceCalculation.js";
import {
  parseBookingMandatoryChargeConfirmationEvidenceResult,
  type BookingMandatoryChargeConfirmationEvidence,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";

export const BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION =
  "booking-price-snapshot-input.v1" as const;
export const BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL = "explicit_zero.v1" as const;

const SOURCE_KIND_ORDER = Object.freeze([
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const);

export type BookingPriceRecurringSourceBinding = Readonly<{
  sourceKind: (typeof SOURCE_KIND_ORDER)[number];
  source: PmsPricingSourceEntityRevision;
  validationRevision: number;
  materializationRevision: number;
}>;

export type BookingCancellationDisclosure =
  | Readonly<{
      selectedPlan: "flexible";
      source: PmsPricingSourceEntityRevision;
      paymentTiming: null;
      terms: FlexibleCancellationTerms;
    }>
  | Readonly<{
      selectedPlan: "non_refundable";
      source: BookingPriceRecurringSourceBinding;
      paymentTiming: "prepay_full";
      terms: NonRefundableCancellationTerms;
    }>;

export type BookingAdditionalGuestDisclosure =
  | Readonly<{
      kind: "not_applied";
      includedGuestsPerRoom: null;
      chargeableGuestCount: 0;
      totalMinorUnits: BookingPriceMinorUnits;
    }>
  | Readonly<{
      kind: "per_stay_night";
      source: BookingPriceRecurringSourceBinding;
      unitAmountDecimal: string;
      currency: string;
      includedGuestsPerRoom: number;
      chargeableGuestCount: number;
      totalMinorUnits: BookingPriceMinorUnits;
    }>;

export type BookingPriceSnapshotFactoryInput = Readonly<{
  calculationInput: BookingPriceCalculationInput;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidence;
  adultCount: number;
  childCount: number;
}>;

export type BookingPriceSnapshotInput = Readonly<{
  contractVersion: typeof BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  calculation: BookingPriceCalculation;
  pmsSourceBindings: Readonly<{
    pricingCurrency: PmsPricingSourceEntityRevision;
    flexibleRatePlan: PmsPricingSourceEntityRevision;
    optionalPricingAggregate: PmsPricingSourceEntityRevision;
    roomFacts: Readonly<{ roomTypeId: string; roomFactsRevision: number }>;
    recurringSources: readonly BookingPriceRecurringSourceBinding[];
  }>;
  financePaymentEligibility: Readonly<{
    requiredForSelection: boolean;
    source: FinancePaymentMethodsSourceEntityRevision | null;
    snapshot: FinancePaymentReadinessSnapshot | null;
  }>;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidence;
  guestCounts: Readonly<{
    roomCount: number;
    adultCount: number;
    childCount: number;
    includedGuestsPerRoom: number | null;
    chargeableGuestCount: number;
  }>;
  selectedPlan:
    | Readonly<{
        kind: "flexible";
        flexibleRatePlanId: string;
        paymentTiming: null;
      }>
    | Readonly<{
        kind: "non_refundable";
        flexibleRatePlanId: string;
        nonRefundableSourceId: string;
        paymentTiming: "prepay_full";
      }>;
  cancellationDisclosure: BookingCancellationDisclosure;
  additionalGuestDisclosure: BookingAdditionalGuestDisclosure;
  taxesAndFees: Readonly<{
    model: typeof BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL;
    taxTotalMinorUnits: BookingPriceMinorUnits;
    feeTotalMinorUnits: BookingPriceMinorUnits;
    totalMinorUnits: BookingPriceMinorUnits;
  }>;
  totals: Readonly<{
    priceTotalMinorUnits: BookingPriceMinorUnits;
    taxesAndFeesTotalMinorUnits: BookingPriceMinorUnits;
    grandTotalMinorUnits: BookingPriceMinorUnits;
  }>;
}>;

/** Preview and quote consumers use the exact same immutable monetary evidence. */
export type BookingPricePreviewInput = BookingPriceSnapshotInput;
export type BookingPriceQuoteInput = BookingPriceSnapshotInput;

export function createBookingPriceSnapshotInput(
  input: BookingPriceSnapshotFactoryInput,
): BookingPriceSnapshotInput | null {
  try {
    if (
      !isPlainData(input) ||
      !isExactRecord(input, [
        "calculationInput",
        "mandatoryChargeConfirmation",
        "adultCount",
        "childCount",
      ]) ||
      !count(input.adultCount, 1, 9_999) ||
      !count(input.childCount, 0, 9_999) ||
      input.adultCount + input.childCount > 9_999
    )
      return null;

    const calculationInput = structuredClone(input.calculationInput);
    const calculation = calculateBookingPrice(calculationInput);
    const room = calculationInput.roomPublication.rooms.find(
      ({ roomTypeId }) => roomTypeId === calculation.roomTypeId,
    );
    if (
      !room ||
      input.adultCount > room.facts.occupancy.maxAdults * calculation.roomCount ||
      input.childCount > room.facts.occupancy.maxChildren * calculation.roomCount ||
      input.adultCount + input.childCount >
        room.facts.occupancy.maxGuests * calculation.roomCount ||
      calculation.chargeableGuestCount > input.adultCount + input.childCount
    )
      return null;
    const confirmation = parseBookingMandatoryChargeConfirmationEvidenceResult({
      outcome: "available",
      evidence: structuredClone(input.mandatoryChargeConfirmation),
    });
    if (
      confirmation.outcome !== "available" ||
      confirmation.evidence.organizationId !== calculation.organizationId ||
      confirmation.evidence.propertyId !== calculation.propertyId ||
      confirmation.evidence.pricingSourceFingerprint !== calculation.pricingSourceFingerprint
    )
      return null;

    const finance =
      calculationInput.financePaymentReadiness === null
        ? null
        : parseFinancePaymentReadinessSnapshot(
            structuredClone(calculationInput.financePaymentReadiness),
          );
    if (
      (calculationInput.financePaymentReadiness !== null && !finance) ||
      (finance && finance.propertyId !== calculation.propertyId)
    )
      return null;
    const financeSource = finance
      ? createFinancePaymentMethodsSourceEntityRevision(
          finance.propertyId,
          finance.paymentMethodsRevision,
        )
      : null;
    if (
      calculation.selectedRate.kind === "non_refundable" &&
      (!financeSource ||
        !isDeepStrictEqual(financeSource, calculation.selectedRate.financePaymentMethodsSource))
    )
      return null;

    const pricingCurrency = pricingBinding(
      PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
      calculation.propertyId,
      calculation.sourceRevisions.pricingCurrencyRevision,
    );
    const flexibleRatePlan = pricingBinding(
      PMS_PRICING_SOURCE_ENTITY_TYPES.flexibleRatePlan,
      calculation.flexibleRatePlanId,
      calculation.sourceRevisions.flexibleRatePlanRevision,
    );
    const optionalPricingAggregate = pricingBinding(
      PMS_PRICING_SOURCE_ENTITY_TYPES.optionalPricingAggregate,
      calculation.propertyId,
      calculation.sourceRevisions.optionalPricingAggregateRevision,
    );
    const recurringSources = collectRecurringSourceBindings(calculation);
    if (!pricingCurrency || !flexibleRatePlan || !optionalPricingAggregate || !recurringSources)
      return null;

    const recurringSource = (kind: "additional_guest" | "non_refundable") =>
      recurringSources.find((source) => source.sourceKind === kind) ?? null;
    const nonRefundableSource = recurringSource("non_refundable");
    if (calculation.selectedRate.kind === "non_refundable" && !nonRefundableSource) return null;
    const cancellationDisclosure: BookingCancellationDisclosure =
      calculation.selectedRate.kind === "flexible"
        ? {
            selectedPlan: "flexible",
            source: flexibleRatePlan,
            paymentTiming: null,
            terms: calculation.selectedRate.cancellationTerms,
          }
        : {
            selectedPlan: "non_refundable",
            source: nonRefundableSource!,
            paymentTiming: calculation.selectedRate.paymentTiming,
            terms: calculation.selectedRate.cancellationTerms,
          };
    const additionalGuestDisclosure = createAdditionalGuestDisclosure(
      calculation,
      recurringSource("additional_guest"),
    );
    if (!additionalGuestDisclosure) return null;

    const zero = "0" as BookingPriceMinorUnits;
    return deepFreeze({
      contractVersion: BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION,
      organizationId: calculation.organizationId,
      propertyId: calculation.propertyId,
      pricingSourceFingerprint: calculation.pricingSourceFingerprint,
      calculation,
      pmsSourceBindings: {
        pricingCurrency,
        flexibleRatePlan,
        optionalPricingAggregate,
        roomFacts: {
          roomTypeId: calculation.roomTypeId,
          roomFactsRevision: calculation.sourceRevisions.roomFactsRevision,
        },
        recurringSources,
      },
      financePaymentEligibility: {
        requiredForSelection: calculation.selectedRate.kind === "non_refundable",
        source: calculation.selectedRate.kind === "non_refundable" ? financeSource : null,
        snapshot: calculation.selectedRate.kind === "non_refundable" ? finance : null,
      },
      mandatoryChargeConfirmation: confirmation.evidence,
      guestCounts: {
        roomCount: calculation.roomCount,
        adultCount: input.adultCount,
        childCount: input.childCount,
        includedGuestsPerRoom: calculation.includedGuestsPerRoom,
        chargeableGuestCount: calculation.chargeableGuestCount,
      },
      selectedPlan:
        calculation.selectedRate.kind === "flexible"
          ? {
              kind: "flexible",
              flexibleRatePlanId: calculation.flexibleRatePlanId,
              paymentTiming: null,
            }
          : {
              kind: "non_refundable",
              flexibleRatePlanId: calculation.flexibleRatePlanId,
              nonRefundableSourceId: calculation.selectedRate.source.sourceId,
              paymentTiming: calculation.selectedRate.paymentTiming,
            },
      cancellationDisclosure,
      additionalGuestDisclosure,
      taxesAndFees: {
        model: BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL,
        taxTotalMinorUnits: zero,
        feeTotalMinorUnits: zero,
        totalMinorUnits: zero,
      },
      totals: {
        priceTotalMinorUnits: calculation.stayTotalMinorUnits,
        taxesAndFeesTotalMinorUnits: zero,
        grandTotalMinorUnits: calculation.stayTotalMinorUnits,
      },
    });
  } catch {
    return null;
  }
}

function collectRecurringSourceBindings(
  calculation: BookingPriceCalculation,
): readonly BookingPriceRecurringSourceBinding[] | null {
  const collected = new Map<string, BookingPriceRecurringSourceBinding>();
  const add = (
    sourceKind: BookingPriceRecurringSourceBinding["sourceKind"],
    sourceValue: BookingAppliedSourceRevision,
  ) => {
    const source = pricingBinding(
      PMS_PRICING_SOURCE_ENTITY_TYPES.recurringPricingRule,
      sourceValue.sourceId,
      sourceValue.sourceRevision,
    );
    if (!source) return false;
    const binding = {
      sourceKind,
      source,
      validationRevision: sourceValue.validationRevision,
      materializationRevision: sourceValue.materializationRevision,
    } as const;
    const existing = collected.get(source.entityId);
    if (existing && !isDeepStrictEqual(existing, binding)) return false;
    collected.set(source.entityId, binding);
    return true;
  };
  for (const night of calculation.nights) {
    if (night.baseAmount.kind === "seasonal" && !add("season", night.baseAmount.source))
      return null;
    if (night.weekendSurcharge && !add("weekend_surcharge", night.weekendSurcharge.source))
      return null;
    if (night.additionalGuest && !add("additional_guest", night.additionalGuest.source))
      return null;
  }
  if (
    calculation.selectedRate.kind === "non_refundable" &&
    !add("non_refundable", calculation.selectedRate.source)
  )
    return null;
  return Object.freeze(
    [...collected.values()].sort(
      (left, right) =>
        SOURCE_KIND_ORDER.indexOf(left.sourceKind) - SOURCE_KIND_ORDER.indexOf(right.sourceKind) ||
        compare(left.source.entityId, right.source.entityId),
    ),
  );
}

function createAdditionalGuestDisclosure(
  calculation: BookingPriceCalculation,
  source: BookingPriceRecurringSourceBinding | null,
): BookingAdditionalGuestDisclosure | null {
  const first = calculation.nights[0]!.additionalGuest;
  if (!first)
    return calculation.includedGuestsPerRoom === null && calculation.chargeableGuestCount === 0
      ? {
          kind: "not_applied",
          includedGuestsPerRoom: null,
          chargeableGuestCount: 0,
          totalMinorUnits: "0" as BookingPriceMinorUnits,
        }
      : null;
  if (!source || calculation.includedGuestsPerRoom !== first.includedGuestsPerRoom) return null;
  const total = calculation.nights.reduce(
    (sum, night) => sum + BigInt(night.additionalGuest!.totalMinorUnits),
    0n,
  );
  return total <= BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)
    ? {
        kind: "per_stay_night",
        source,
        unitAmountDecimal: first.amountDecimal,
        currency: calculation.currency,
        includedGuestsPerRoom: first.includedGuestsPerRoom,
        chargeableGuestCount: calculation.chargeableGuestCount,
        totalMinorUnits: String(total) as BookingPriceMinorUnits,
      }
    : null;
}

function pricingBinding(
  entityType: PmsPricingSourceEntityRevision["entityType"],
  entityId: string,
  revision: number,
): PmsPricingSourceEntityRevision | null {
  return serializePmsPricingSourceEntityRevision(entityType, entityId, revision);
}

function count(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.getOwnPropertyNames(value).sort(compare);
  const expected = [...keys].sort(compare);
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) =>
        key === expected[index] && Object.prototype.propertyIsEnumerable.call(value, key),
    )
  );
}

function isPlainData(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (
      prototype !== Array.prototype ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    )
      return false;
    for (let index = 0; index < value.length; index += 1)
      if (
        !Object.prototype.hasOwnProperty.call(value, index) ||
        !Object.prototype.propertyIsEnumerable.call(value, index)
      )
        return false;
  } else if (prototype !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length" && Array.isArray(value)) continue;
    if (!descriptor.enumerable || !("value" in descriptor) || !isPlainData(descriptor.value, seen))
      return false;
  }
  seen.delete(value);
  return true;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
