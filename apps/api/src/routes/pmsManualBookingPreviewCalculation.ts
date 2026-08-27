import {
  calculateBookingPrice,
  createBookingPricingSourceFingerprint,
  formatBookingPriceMinorUnits,
  roundBookingPriceDecimalToMinorUnits,
  type BookingGuestPolicyReadPort,
  type BookingGuestPolicyRevision,
  type BookingPricingSourceFingerprint,
} from "@vayada/domain-booking";
import type {
  PmsPricingReadPort,
  PmsPricingSourceSnapshot,
  PmsRecurringPricingBookingEvidence,
  PmsRecurringPricingReadPort,
  RoomPublicationSnapshot,
  RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

import type {
  PmsManualBookingAvailabilityReadPort,
  PmsOperationsReadRepository,
} from "../domains/pmsOperationsReadModel.js";
import type { BookingAddonItem, BookingAddonItemsRepository } from "./bookingAddonItems.js";

export type ManualBookingMoney = { amountDecimal: string; currency: string };
type ManualBookingStayBase = {
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};
export type ManualBookingStay = ManualBookingStayBase &
  (
    | {
        ratePlanId: string;
        pricing: { kind: "rate_plan"; manualOverride: ManualBookingMoney | null };
      }
    | { ratePlanId: null; pricing: { kind: "custom"; nightlyAmount: ManualBookingMoney } }
  );
type PricedManualBookingStay = ManualBookingStay & { dates: string[] };
export type ManualBookingAddonSelection = {
  addonId: string;
  packageCount: number;
  serviceUnits: { serviceDate: string | null; guestCount: number | null }[];
};
export type ManualBookingPreviewCommand = {
  contractVersion: "pms-manual-booking.v1";
  stays: ManualBookingStay[];
  addOns: ManualBookingAddonSelection[];
};
export type PmsManualBookingPreviewRoutesOptions = {
  pms: Pick<PmsOperationsReadRepository, "listRoomsByPropertyId" | "listRoomTypesByPropertyId"> &
    PmsManualBookingAvailabilityReadPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot"> &
    Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  roomPublication: Pick<RoomPublicationSnapshotPort, "getRoomPublicationSnapshot">;
  booking: Pick<BookingAddonItemsRepository, "listAddonItemsByHotelId"> &
    Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
};

export async function calculateManualBookingPreview(
  scope: { propertyId: string; organizationId: string },
  command: ManualBookingPreviewCommand,
  ports: PmsManualBookingPreviewRoutesOptions,
) {
  const { propertyId } = scope;
  const pricedStays: PricedManualBookingStay[] = command.stays.map((stay) => ({
    ...stay,
    dates: datesBetween(stay.checkIn, stay.checkOut, stay.position),
  }));
  const [rooms, roomTypes, pricing, recurring, roomPublication, addonContext, policy, available] =
    await Promise.all([
      ports.pms.listRoomsByPropertyId(propertyId),
      ports.pms.listRoomTypesByPropertyId(propertyId),
      ports.pricing.getPricingSourceSnapshot(propertyId),
      ports.pricing.getRecurringPricingBookingEvidence(propertyId),
      ports.roomPublication.getRoomPublicationSnapshot(scope),
      ports.booking.listAddonItemsByHotelId(propertyId),
      ports.booking.getCurrentGuestPolicy(scope),
      ports.pms.getPhysicalRoomAvailability(propertyId, pricedStays),
    ]);
  if (
    !pricing ||
    !recurring ||
    !policy ||
    !addonContext ||
    pricing.propertyId !== propertyId ||
    recurring.propertyId !== propertyId ||
    roomPublication.propertyId !== propertyId
  )
    fail(404, "property_not_found");
  const addons = addonContext.addonItems;
  const currency = pricing.pricingCurrency.currency;
  const fingerprint = createBookingPricingSourceFingerprint(scope, {
    roomPublication,
    pricing,
    recurringPricing: recurring,
  });
  if (policy.bundle.pricingSourceFingerprint !== fingerprint)
    throw new TypeError("Manual booking pricing evidence is stale");
  let grand = 0n;
  const stays = pricedStays.map((stay, index) => {
    const room = rooms.items.find((item) => item.roomId === stay.roomId);
    if (!room || available[index] === null) fail(404, "room_not_found", "roomId", stay.position);
    if (!available[index] || overlaps(stay, pricedStays))
      fail(409, "room_unavailable", "roomId", stay.position);
    const roomType = roomTypes.items.find((item) => item.roomTypeId === room.roomTypeId);
    if (!roomType?.active) fail(404, "room_not_found", "roomId", stay.position);
    const limits = roomType.occupancyLimits;
    if (
      stay.adults > (limits.adults ?? 0) ||
      stay.children > (limits.children ?? 0) ||
      stay.adults + stay.children > (limits.total ?? 0)
    )
      fail(422, "occupancy_exceeded", "stays", stay.position);
    let standards: bigint[] | null = null;
    if (stay.ratePlanId !== null) {
      const plan = roomType.ratePlans.find(
        (item) =>
          item.ratePlanId === stay.ratePlanId && item.pricingContractVersion === "pms-pricing.v1",
      );
      if (!plan) fail(404, "rate_plan_not_found", "ratePlanId", stay.position);
      if (!plan.active) fail(422, "inactive_rate_plan", "ratePlanId", stay.position);
      standards = standardNights(
        scope,
        stay,
        room.roomTypeId,
        policy,
        pricing,
        recurring,
        roomPublication,
        fingerprint,
      );
    }
    const applied = stay.dates.map((_, position) =>
      stay.pricing.kind === "custom"
        ? stay.pricing.nightlyAmount
        : (stay.pricing.manualOverride ?? money(standards![position]!, currency)),
    );
    for (const value of applied) requireCurrency(value, currency, stay.position);
    const standardTotal = standards?.reduce((sum, value) => sum + value, 0n) ?? null;
    const appliedTotal = applied.reduce((sum, value) => sum + minor(value.amountDecimal), 0n);
    grand += appliedTotal;
    return {
      position: stay.position,
      roomId: stay.roomId,
      ratePlanId: stay.ratePlanId,
      nightly: stay.dates.map((serviceDate, position) => ({
        serviceDate,
        standard: standards ? money(standards[position]!, currency) : null,
        applied: money(minor(applied[position]!.amountDecimal), currency),
      })),
      standardTotal: standardTotal === null ? null : money(standardTotal, currency),
      appliedTotal: money(appliedTotal, currency),
    };
  });
  const addOns = command.addOns.map((selection) => {
    const addon = addons.find((item) => item.addonItemId === selection.addonId);
    if (!addon || addon.propertyId !== propertyId) fail(404, "addon_not_found", "addonId");
    if (addon.status !== "active") fail(422, "invalid_addon_selection", "addonId");
    requireCurrency({ amountDecimal: addon.price, currency: addon.currency }, currency);
    const total =
      minor(addon.price) *
      BigInt(selection.packageCount) *
      BigInt(unitFactor(addon, selection, pricedStays));
    grand += total;
    return {
      addonId: selection.addonId,
      pricingModel: addon.pricingModel,
      unitPrice: money(minor(addon.price), currency),
      packageCount: selection.packageCount,
      serviceUnits: selection.serviceUnits,
      total: money(total, currency),
    };
  });
  return {
    contractVersion: command.contractVersion,
    currency,
    stays,
    addOns,
    grandTotal: money(grand, currency),
  };
}

export type ManualBookingPreviewResult = Awaited<ReturnType<typeof calculateManualBookingPreview>>;

function unitFactor(
  addon: BookingAddonItem,
  selection: ManualBookingAddonSelection,
  stays: PricedManualBookingStay[],
): number {
  const units = selection.serviceUnits;
  const occupancy = (date: string) =>
    stays
      .filter((stay) => stay.checkIn <= date && date < stay.checkOut)
      .reduce((sum, stay) => sum + stay.adults + stay.children, 0);
  const dates = units.flatMap((unit) => (unit.serviceDate === null ? [] : [unit.serviceDate]));
  const expectedDates = new Set(stays.flatMap((stay) => stay.dates));
  const totalGuests = stays.reduce((sum, stay) => sum + stay.adults + stay.children, 0);
  let valid = new Set(dates).size === dates.length;
  if (addon.pricingModel === "per_stay")
    valid &&= units.length === 1 && units[0]!.serviceDate === null && units[0]!.guestCount === null;
  if (addon.pricingModel === "per_guest")
    valid &&=
      units.length === 1 &&
      units[0]!.serviceDate === null &&
      !!units[0]!.guestCount &&
      units[0]!.guestCount! <= totalGuests;
  if (addon.pricingModel === "per_night")
    valid &&=
      dates.length === expectedDates.size &&
      dates.every((date) => expectedDates.has(date)) &&
      units.every(
        (unit) =>
          unit.serviceDate !== null && unit.guestCount === null && occupancy(unit.serviceDate) > 0,
      );
  if (addon.pricingModel === "per_guest_night")
    valid &&=
      dates.length === expectedDates.size &&
      dates.every((date) => expectedDates.has(date)) &&
      units.every(
        (unit) =>
          unit.serviceDate !== null &&
          !!unit.guestCount &&
          unit.guestCount! <= occupancy(unit.serviceDate),
      );
  if (!valid) fail(422, "invalid_addon_selection", "serviceUnits");
  return units.reduce((sum, unit) => sum + (unit.guestCount ?? 1), 0);
}

function standardNights(
  scope: { propertyId: string; organizationId: string },
  stay: Extract<PricedManualBookingStay, { pricing: { kind: "rate_plan" } }>,
  roomTypeId: string,
  policy: BookingGuestPolicyRevision,
  pricing: PmsPricingSourceSnapshot,
  recurring: PmsRecurringPricingBookingEvidence,
  roomPublication: RoomPublicationSnapshot,
  fingerprint: BookingPricingSourceFingerprint,
): bigint[] {
  const plan = pricing.flexibleRatePlans.find(
    (item) => item.roomTypeId === roomTypeId && item.flexibleRatePlanId === stay.ratePlanId,
  );
  const disclosure = policy.bundle.rates.find((rate) => rate.roomTypeId === roomTypeId);
  if (
    !plan ||
    !disclosure ||
    policy.organizationId !== scope.organizationId ||
    policy.propertyId !== scope.propertyId ||
    policy.bundle.pricingCurrency !== pricing.pricingCurrency.currency ||
    disclosure.flexible.source.entityId !== stay.ratePlanId ||
    disclosure.flexible.source.revision !== String(plan.flexibleRatePlanRevision)
  )
    throw new TypeError("Manual booking pricing evidence is inconsistent");
  const additional = disclosure.additionalGuest;
  const source = additional
    ? recurring.sources.find((item) => item.sourceId === additional.source.source.entityId)
    : null;
  if (
    additional &&
    (!source ||
      source.sourceKind !== "additional_guest" ||
      String(source.sourceRevision) !== additional.source.source.revision ||
      source.validation.validationRevision !== additional.source.validationRevision ||
      source.materializationRevision !== additional.source.materializationRevision ||
      source.includedGuests !== additional.includedGuestsPerRoom ||
      source.amountDecimal !== additional.amountDecimal ||
      source.currency !== additional.currency)
  )
    throw new TypeError("Manual booking additional-guest evidence is inconsistent");
  const countedGuests =
    stay.adults +
    (additional?.countedGuestTypes.some((guestType) => guestType === "child") ? stay.children : 0);
  const chargeableGuestCount = additional
    ? Math.max(0, countedGuests - additional.includedGuestsPerRoom)
    : 0;
  const choose = (date: string, kind: "season" | "weekend_surcharge") => {
    const matches = recurring.sources.filter(
      (item) =>
        item.lifecycle === "active" &&
        item.sourceKind === kind &&
        (kind === "season"
          ? item.sourceKind === "season" &&
            inRange(date.slice(5), item.startMonthDay, item.endMonthDay)
          : item.sourceKind === "weekend_surcharge" && item.weekdays.includes(weekday(date))),
    );
    if (matches.length > 1) throw new TypeError("Manual booking pricing sources overlap");
    return matches[0]?.sourceId ?? null;
  };
  const calculation = calculateBookingPrice({
    ...scope,
    roomTypeId,
    flexibleRatePlanId: stay.ratePlanId,
    pricingSourceFingerprint: fingerprint,
    roomCount: 1,
    chargeableGuestCount,
    additionalGuestSourceId: source?.sourceId ?? null,
    selectedRate: { kind: "flexible" },
    nights: stay.dates.map((stayDate) => ({
      stayDate,
      appliedSeasonSourceId: choose(stayDate, "season"),
      appliedWeekendSurchargeSourceId: choose(stayDate, "weekend_surcharge"),
    })),
    pricing,
    recurringPricing: recurring,
    roomPublication,
    financePaymentReadiness: null,
  });
  const nights = new Map(
    calculation.nights.map((night) => [night.stayDate, BigInt(night.finalNightTotalMinorUnits)]),
  );
  return stay.dates.map((date) => nights.get(date) ?? invalid());
}

export class PreviewError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly body: { code: string; message: string; field?: string; stayPosition?: number },
  ) {
    super(body.message);
  }
}
export function fail(
  status: 400 | 403 | 404 | 409 | 422,
  code: string,
  field?: string,
  stayPosition?: number,
): never {
  throw new PreviewError(status, {
    code,
    message: `${code.replaceAll("_", " ")}.`,
    ...(field ? { field } : {}),
    ...(stayPosition ? { stayPosition } : {}),
  });
}
export function invalid(): never {
  fail(400, "invalid_body");
}
function minor(value: unknown): bigint {
  const parsed = roundBookingPriceDecimalToMinorUnits(value);
  if (!parsed) invalid();
  return BigInt(parsed);
}
function money(value: bigint, currency: string): ManualBookingMoney {
  const amountDecimal = formatBookingPriceMinorUnits(String(value));
  if (!amountDecimal) invalid();
  return { amountDecimal, currency };
}
function requireCurrency(value: ManualBookingMoney, currency: string, stayPosition?: number): void {
  if (value.currency !== currency) fail(422, "currency_mismatch", "currency", stayPosition);
  minor(value.amountDecimal);
}
function inRange(day: string, start: string, end: string): boolean {
  return start <= end ? start <= day && day <= end : day >= start || day <= end;
}
function weekday(date: string) {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
    new Date(`${date}T00:00:00Z`).getUTCDay()
  ] as "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
}
function datesBetween(from: string, to: string, stayPosition: number): string[] {
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (!valid(from) || !valid(to)) fail(422, "invalid_dates", "stays", stayPosition);
  const start = Date.parse(`${from}T00:00:00Z`);
  const count = (Date.parse(`${to}T00:00:00Z`) - start) / 86_400_000;
  if (!Number.isInteger(count) || count < 1 || count > 366)
    fail(422, "invalid_dates", "stays", stayPosition);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}
function overlaps(stay: ManualBookingStay, stays: ManualBookingStay[]): boolean {
  return stays.some(
    (other) =>
      other.position < stay.position &&
      other.roomId === stay.roomId &&
      other.checkIn < stay.checkOut &&
      other.checkOut > stay.checkIn,
  );
}
