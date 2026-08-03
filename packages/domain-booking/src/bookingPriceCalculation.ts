import {
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentMethodsSourceEntityRevision,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import {
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  type FlexibleRatePlanSnapshot,
  type FlexibleCancellationTerms,
  type NonRefundableCancellationTerms,
  type PmsPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingSourceSnapshot,
  type RecurringPricingRoomEvidence,
  type RoomPublicationSnapshot,
} from "@vayada/domain-pms";

import {
  BOOKING_PRICING_ROUNDING_MODE,
  BOOKING_PRICING_SCALE,
  createBookingPricingSourceFingerprint,
  parseBookingPricingSourceFingerprint,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";

export const BOOKING_PRICE_CALCULATION_CONTRACT_VERSION = "booking-price-calculation.v1" as const;
export const BOOKING_PRICE_V1_ALLOCATION_RULE =
  "single_room_type_aggregate_guest_count.v1" as const;
export const BOOKING_PRICE_MAX_MINOR_UNITS = "9223372036854775807" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,18}))?$/;
const MINOR_UNITS_PATTERN = /^(?:0|[1-9][0-9]*)$/;

declare const bookingPriceMinorUnitsBrand: unique symbol;

export type BookingPriceMinorUnits = string & {
  readonly [bookingPriceMinorUnitsBrand]: true;
};

export type BookingPriceCalculationInput = Readonly<{
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  roomCount: number;
  chargeableGuestCount: number;
  additionalGuestSourceId: string | null;
  selectedRate:
    | Readonly<{ kind: "flexible" }>
    | Readonly<{ kind: "non_refundable"; sourceId: string }>;
  nights: readonly Readonly<{
    stayDate: string;
    appliedSeasonSourceId: string | null;
    appliedWeekendSurchargeSourceId: string | null;
  }>[];
  pricing: PmsPricingSourceSnapshot;
  recurringPricing: PmsRecurringPricingBookingEvidence;
  roomPublication: RoomPublicationSnapshot;
  financePaymentReadiness: FinancePaymentReadinessSnapshot | null;
}>;

export type BookingAppliedSourceRevision = Readonly<{
  sourceId: string;
  sourceRevision: number;
  validationRevision: number;
  materializationRevision: number;
}>;

export type BookingPriceNightBreakdown = Readonly<{
  stayDate: string;
  baseAmount:
    | Readonly<{
        kind: "standard";
        amountDecimal: string;
        flexibleRatePlanId: string;
        flexibleRatePlanRevision: number;
      }>
    | Readonly<{
        kind: "seasonal";
        amountDecimal: string;
        source: BookingAppliedSourceRevision;
      }>;
  baseRoomTotalMinorUnits: BookingPriceMinorUnits;
  weekendSurcharge: Readonly<{
    amountDecimal: string;
    roomTotalMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  additionalGuest: Readonly<{
    amountDecimal: string;
    includedGuestsPerRoom: number;
    chargeableGuestCount: number;
    totalMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  flexibleNightTotalMinorUnits: BookingPriceMinorUnits;
  nonRefundableDiscount: Readonly<{
    discountPercent: number;
    amountMinorUnits: BookingPriceMinorUnits;
    source: BookingAppliedSourceRevision;
  }> | null;
  finalNightTotalMinorUnits: BookingPriceMinorUnits;
}>;

export type BookingPriceCalculation = Readonly<{
  contractVersion: typeof BOOKING_PRICE_CALCULATION_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  currency: string;
  scale: typeof BOOKING_PRICING_SCALE;
  roundingMode: typeof BOOKING_PRICING_ROUNDING_MODE;
  allocationRule: typeof BOOKING_PRICE_V1_ALLOCATION_RULE;
  roomCount: number;
  includedGuestsPerRoom: number | null;
  chargeableGuestCount: number;
  selectedRate:
    | Readonly<{
        kind: "flexible";
        cancellationTerms: FlexibleCancellationTerms;
      }>
    | Readonly<{
        kind: "non_refundable";
        paymentTiming: "prepay_full";
        cancellationTerms: NonRefundableCancellationTerms;
        source: BookingAppliedSourceRevision;
        financePaymentMethodsSource: FinancePaymentMethodsSourceEntityRevision;
      }>;
  sourceRevisions: Readonly<{
    pricingCurrencyRevision: number;
    roomFactsRevision: number;
    flexibleRatePlanRevision: number;
    optionalPricingAggregateRevision: number;
  }>;
  nights: readonly BookingPriceNightBreakdown[];
  stayTotalMinorUnits: BookingPriceMinorUnits;
}>;

/** Decimal round-half-up at Booking's fixed scale without binary floating point. */
export function roundBookingPriceDecimalToMinorUnits(
  value: unknown,
): BookingPriceMinorUnits | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  let minorUnits = BigInt(match[1]!) * 100n + BigInt(fraction.slice(0, 2));
  if (fraction[2]! >= "5") minorUnits += 1n;
  if (minorUnits > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return null;
  return String(minorUnits) as BookingPriceMinorUnits;
}

export function formatBookingPriceMinorUnits(value: unknown): string | null {
  if (typeof value !== "string" || !MINOR_UNITS_PATTERN.test(value)) return null;
  if (BigInt(value) > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return null;
  const padded = value.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

export function applyBookingPricePercentageDiscount(
  flexibleNightMinorUnits: unknown,
  discountPercent: unknown,
): Readonly<{
  discountMinorUnits: BookingPriceMinorUnits;
  finalMinorUnits: BookingPriceMinorUnits;
}> | null {
  if (
    typeof flexibleNightMinorUnits !== "string" ||
    !MINOR_UNITS_PATTERN.test(flexibleNightMinorUnits) ||
    BigInt(flexibleNightMinorUnits) > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS) ||
    !isIntegerInRange(discountPercent, 1, 50)
  )
    return null;
  const flexible = BigInt(flexibleNightMinorUnits);
  const final = roundRatioHalfUp(flexible * BigInt(100 - discountPercent), 100n);
  return Object.freeze({
    discountMinorUnits: minorUnits(flexible - final),
    finalMinorUnits: minorUnits(final),
  });
}

export function calculateBookingPrice(
  input: BookingPriceCalculationInput,
): BookingPriceCalculation {
  const parsed = parseCalculationInput(input);
  const plan = parsed.pricing.flexibleRatePlans.find(
    ({ roomTypeId, flexibleRatePlanId }) =>
      roomTypeId === parsed.roomTypeId && flexibleRatePlanId === parsed.flexibleRatePlanId,
  );
  if (!plan) return invalidInput();
  const room = parsed.roomPublication.rooms.find(
    ({ roomTypeId }) => roomTypeId === parsed.roomTypeId,
  );
  if (!room || room.sourceRevisions.roomFactsRevision !== plan.sourceRoomFactsRevision)
    return invalidInput();

  const sourceById = new Map(
    parsed.recurringPricing.sources.map((source) => [source.sourceId, source]),
  );
  const additionalGuest = parsed.additionalGuestSourceId
    ? requireSource(sourceById, parsed.additionalGuestSourceId, "additional_guest", parsed, plan)
    : null;
  const nonRefundable =
    parsed.selectedRate.kind === "non_refundable"
      ? requireSource(sourceById, parsed.selectedRate.sourceId, "non_refundable", parsed, plan)
      : null;
  if (!additionalGuest && parsed.chargeableGuestCount !== 0) return invalidInput();
  if (
    additionalGuest &&
    parsed.chargeableGuestCount >
      Math.max(0, room.facts.occupancy.maxGuests - additionalGuest.includedGuests) *
        parsed.roomCount
  )
    return invalidInput();
  const finance = parsed.financePaymentReadiness;
  if (
    nonRefundable &&
    (!finance?.pricingCurrency.matchesCurrent ||
      finance.pricingCurrency.current?.currency !== parsed.pricing.pricingCurrency.currency ||
      finance.pricingCurrency.current.pricingCurrencyRevision !==
        parsed.pricing.pricingCurrency.pricingCurrencyRevision ||
      !finance.methods.some(
        (method) =>
          method.method === "card" &&
          method.selected &&
          method.availability === "available" &&
          method.readiness === "ready",
      ))
  )
    return invalidInput();
  const basePerRoom = requireExactMinorUnits(plan.baseAmount.amountDecimal);

  const nights = parsed.nights.map((night) => {
    const season = night.appliedSeasonSourceId
      ? requireSource(sourceById, night.appliedSeasonSourceId, "season", parsed, plan)
      : null;
    const weekend = night.appliedWeekendSurchargeSourceId
      ? requireSource(
          sourceById,
          night.appliedWeekendSurchargeSourceId,
          "weekend_surcharge",
          parsed,
          plan,
        )
      : null;
    const seasonRoom = season?.roomPrices.find(
      ({ roomTypeId }) => roomTypeId === parsed.roomTypeId,
    );
    const weekendRoom = weekend?.roomSurcharges.find(
      ({ roomTypeId }) => roomTypeId === parsed.roomTypeId,
    );
    if ((season && !seasonRoom) || (weekend && !weekendRoom)) return invalidInput();

    const nightlyBasePerRoom = seasonRoom
      ? requireExactMinorUnits(seasonRoom.amountDecimal)
      : basePerRoom;
    const baseRoomTotal = boundedMinorUnits(nightlyBasePerRoom * BigInt(parsed.roomCount));
    const weekendRoomTotal = weekendRoom
      ? boundedMinorUnits(
          requireExactMinorUnits(weekendRoom.amountDecimal) * BigInt(parsed.roomCount),
        )
      : 0n;
    const additionalGuestTotal = additionalGuest
      ? boundedMinorUnits(
          requireExactMinorUnits(additionalGuest.amountDecimal) *
            BigInt(parsed.chargeableGuestCount),
        )
      : 0n;
    const flexibleNightTotal = boundedMinorUnits(
      baseRoomTotal + weekendRoomTotal + additionalGuestTotal,
    );
    const discounted = nonRefundable
      ? applyBookingPricePercentageDiscount(
          String(flexibleNightTotal),
          nonRefundable.discountPercent,
        )
      : null;
    if (nonRefundable && !discounted) return invalidInput();
    const finalNightTotal = discounted ? BigInt(discounted.finalMinorUnits) : flexibleNightTotal;

    return {
      stayDate: night.stayDate,
      baseAmount: seasonRoom
        ? {
            kind: "seasonal" as const,
            amountDecimal: seasonRoom.amountDecimal,
            source: sourceRevision(season!),
          }
        : {
            kind: "standard" as const,
            amountDecimal: plan.baseAmount.amountDecimal,
            flexibleRatePlanId: plan.flexibleRatePlanId,
            flexibleRatePlanRevision: plan.flexibleRatePlanRevision,
          },
      baseRoomTotalMinorUnits: minorUnits(baseRoomTotal),
      weekendSurcharge: weekendRoom
        ? {
            amountDecimal: weekendRoom.amountDecimal,
            roomTotalMinorUnits: minorUnits(weekendRoomTotal),
            source: sourceRevision(weekend!),
          }
        : null,
      additionalGuest: additionalGuest
        ? {
            amountDecimal: additionalGuest.amountDecimal,
            includedGuestsPerRoom: additionalGuest.includedGuests,
            chargeableGuestCount: parsed.chargeableGuestCount,
            totalMinorUnits: minorUnits(additionalGuestTotal),
            source: sourceRevision(additionalGuest),
          }
        : null,
      flexibleNightTotalMinorUnits: minorUnits(flexibleNightTotal),
      nonRefundableDiscount: nonRefundable
        ? {
            discountPercent: nonRefundable.discountPercent,
            amountMinorUnits: discounted!.discountMinorUnits,
            source: sourceRevision(nonRefundable),
          }
        : null,
      finalNightTotalMinorUnits: minorUnits(finalNightTotal),
    };
  });

  return deepFreeze({
    contractVersion: BOOKING_PRICE_CALCULATION_CONTRACT_VERSION,
    organizationId: parsed.organizationId,
    propertyId: parsed.propertyId,
    roomTypeId: parsed.roomTypeId,
    flexibleRatePlanId: parsed.flexibleRatePlanId,
    pricingSourceFingerprint: parsed.pricingSourceFingerprint,
    currency: parsed.pricing.pricingCurrency.currency,
    scale: BOOKING_PRICING_SCALE,
    roundingMode: BOOKING_PRICING_ROUNDING_MODE,
    allocationRule: BOOKING_PRICE_V1_ALLOCATION_RULE,
    roomCount: parsed.roomCount,
    includedGuestsPerRoom: additionalGuest?.includedGuests ?? null,
    chargeableGuestCount: parsed.chargeableGuestCount,
    selectedRate: nonRefundable
      ? {
          kind: "non_refundable",
          paymentTiming: nonRefundable.paymentTiming,
          cancellationTerms: nonRefundable.cancellationTerms,
          source: sourceRevision(nonRefundable),
          financePaymentMethodsSource: createFinancePaymentMethodsSourceEntityRevision(
            finance!.propertyId,
            finance!.paymentMethodsRevision,
          ),
        }
      : { kind: "flexible", cancellationTerms: plan.cancellationTerms },
    sourceRevisions: {
      pricingCurrencyRevision: parsed.pricing.pricingCurrency.pricingCurrencyRevision,
      roomFactsRevision: plan.sourceRoomFactsRevision,
      flexibleRatePlanRevision: plan.flexibleRatePlanRevision,
      optionalPricingAggregateRevision: parsed.recurringPricing.optionalPricingAggregateRevision,
    },
    nights,
    stayTotalMinorUnits: minorUnits(
      nights.reduce(
        (total, night) => boundedMinorUnits(total + BigInt(night.finalNightTotalMinorUnits)),
        0n,
      ),
    ),
  });
}

function parseCalculationInput(input: BookingPriceCalculationInput): BookingPriceCalculationInput {
  try {
    if (
      !isPlainData(input) ||
      !isExactRecord(input, [
        "organizationId",
        "propertyId",
        "roomTypeId",
        "flexibleRatePlanId",
        "pricingSourceFingerprint",
        "roomCount",
        "chargeableGuestCount",
        "additionalGuestSourceId",
        "selectedRate",
        "nights",
        "pricing",
        "recurringPricing",
        "roomPublication",
        "financePaymentReadiness",
      ])
    )
      return invalidInput();
    if (
      !isCanonicalUuid(input.organizationId) ||
      !isCanonicalUuid(input.propertyId) ||
      !isCanonicalUuid(input.roomTypeId) ||
      !isCanonicalUuid(input.flexibleRatePlanId) ||
      !parseBookingPricingSourceFingerprint(input.pricingSourceFingerprint) ||
      !isIntegerInRange(input.roomCount, 1, 99) ||
      !isIntegerInRange(input.chargeableGuestCount, 0, 9_999) ||
      !Array.isArray(input.nights) ||
      input.nights.length < 1 ||
      input.nights.length > 366 ||
      !isNullableUuid(input.additionalGuestSourceId)
    )
      return invalidInput();
    if (
      (!isExactRecord(input.selectedRate, ["kind"]) || input.selectedRate.kind !== "flexible") &&
      (!isExactRecord(input.selectedRate, ["kind", "sourceId"]) ||
        input.selectedRate.kind !== "non_refundable" ||
        !isCanonicalUuid(input.selectedRate.sourceId))
    )
      return invalidInput();

    const pricing = parsePmsPricingSourceSnapshot(structuredClone(input.pricing));
    const recurringPricing = parsePmsRecurringPricingBookingEvidence(
      structuredClone(input.recurringPricing),
    );
    const roomPublication = structuredClone(input.roomPublication);
    const financePaymentReadiness =
      input.financePaymentReadiness === null
        ? null
        : parseFinancePaymentReadinessSnapshot(structuredClone(input.financePaymentReadiness));
    if (
      !pricing ||
      !recurringPricing ||
      pricing.propertyId !== input.propertyId ||
      recurringPricing.propertyId !== input.propertyId ||
      pricing.pricingCurrency.currency !== recurringPricing.currency ||
      pricing.pricingCurrency.pricingCurrencyRevision !==
        recurringPricing.pricingCurrencyRevision ||
      (input.financePaymentReadiness !== null &&
        (!financePaymentReadiness || financePaymentReadiness.propertyId !== input.propertyId))
    )
      return invalidInput();
    if (
      createBookingPricingSourceFingerprint(
        { organizationId: input.organizationId, propertyId: input.propertyId },
        { roomPublication, pricing, recurringPricing },
      ) !== input.pricingSourceFingerprint
    )
      return invalidInput();

    const nights = input.nights.map((night) => {
      if (
        !isExactRecord(night, [
          "stayDate",
          "appliedSeasonSourceId",
          "appliedWeekendSurchargeSourceId",
        ]) ||
        !isIsoDate(night.stayDate) ||
        !isNullableUuid(night.appliedSeasonSourceId) ||
        !isNullableUuid(night.appliedWeekendSurchargeSourceId)
      )
        return invalidInput();
      return {
        stayDate: night.stayDate,
        appliedSeasonSourceId: night.appliedSeasonSourceId,
        appliedWeekendSurchargeSourceId: night.appliedWeekendSurchargeSourceId,
      };
    });
    nights.sort((left, right) => compareCodeUnits(left.stayDate, right.stayDate));
    if (new Set(nights.map(({ stayDate }) => stayDate)).size !== nights.length)
      return invalidInput();

    return {
      ...structuredClone(input),
      pricingSourceFingerprint: input.pricingSourceFingerprint,
      pricing,
      recurringPricing,
      roomPublication,
      financePaymentReadiness,
      nights,
    };
  } catch {
    return invalidInput();
  }
}

function requireSource<Kind extends PmsRecurringPricingSourceSnapshot["sourceKind"]>(
  sourceById: ReadonlyMap<string, PmsRecurringPricingSourceSnapshot>,
  sourceId: string,
  kind: Kind,
  input: BookingPriceCalculationInput,
  plan: FlexibleRatePlanSnapshot,
): Extract<PmsRecurringPricingSourceSnapshot, { sourceKind: Kind }> {
  const source = sourceById.get(sourceId);
  if (
    !source ||
    source.sourceKind !== kind ||
    source.lifecycle !== "active" ||
    source.currency !== input.pricing.pricingCurrency.currency ||
    source.pricingCurrencyRevision !== input.pricing.pricingCurrency.pricingCurrencyRevision ||
    !sourceMatchesRoomPlan(
      source,
      input.roomTypeId,
      input.flexibleRatePlanId,
      plan.flexibleRatePlanRevision,
      plan.sourceRoomFactsRevision,
    )
  )
    return invalidInput();
  return source as Extract<PmsRecurringPricingSourceSnapshot, { sourceKind: Kind }>;
}

function sourceMatchesRoomPlan(
  source: PmsRecurringPricingSourceSnapshot,
  roomTypeId: string,
  flexibleRatePlanId: string,
  flexibleRatePlanRevision: number,
  roomFactsRevision: number,
): boolean {
  const matches = (room: RecurringPricingRoomEvidence) =>
    room.roomTypeId === roomTypeId &&
    room.roomFactsRevision === roomFactsRevision &&
    room.flexibleRatePlanId === flexibleRatePlanId &&
    room.flexibleRatePlanRevision === flexibleRatePlanRevision;
  switch (source.sourceKind) {
    case "season":
      return source.roomPrices.some(matches);
    case "weekend_surcharge":
      return source.roomSurcharges.some(matches);
    case "additional_guest":
      return matches(source);
    case "non_refundable":
      return source.roomPlans.some(matches);
  }
}

function sourceRevision(source: PmsRecurringPricingSourceSnapshot): BookingAppliedSourceRevision {
  return {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    validationRevision: source.validation.validationRevision,
    materializationRevision: source.materializationRevision,
  };
}

function requireExactMinorUnits(value: string): bigint {
  const parsed = roundBookingPriceDecimalToMinorUnits(value);
  if (!parsed || formatBookingPriceMinorUnits(parsed) !== value) return invalidInput();
  return BigInt(parsed);
}

function roundRatioHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return boundedMinorUnits(remainder * 2n >= denominator ? quotient + 1n : quotient);
}

function minorUnits(value: bigint): BookingPriceMinorUnits {
  return String(boundedMinorUnits(value)) as BookingPriceMinorUnits;
}

function boundedMinorUnits(value: bigint): bigint {
  if (value < 0n || value > BigInt(BOOKING_PRICE_MAX_MINOR_UNITS)) return invalidInput();
  return value;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isCanonicalUuid(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.getOwnPropertyNames(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
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
    if (prototype !== Array.prototype) return false;
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (
        !Object.prototype.hasOwnProperty.call(value, index) ||
        !Object.prototype.propertyIsEnumerable.call(value, index)
      )
        return false;
    }
  } else if (prototype !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" && Array.isArray(value)) continue;
    if (!descriptor.enumerable || !("value" in descriptor) || !isPlainData(descriptor.value, seen))
      return false;
  }
  seen.delete(value);
  return true;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidInput(): never {
  throw new TypeError("Booking price calculation input is invalid");
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
