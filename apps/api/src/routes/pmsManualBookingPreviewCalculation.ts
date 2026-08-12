import {
  formatBookingPriceMinorUnits,
  roundBookingPriceDecimalToMinorUnits,
  type BookingGuestPolicyReadPort,
  type BookingGuestPolicyRevision,
} from "@vayada/domain-booking";
import type {
  PmsRecurringPricingBookingEvidence,
  PmsRecurringPricingReadPort,
} from "@vayada/domain-pms";

import type {
  PmsManualBookingAvailabilityReadPort,
  PmsOperationsReadRepository,
  PmsRatePlan,
} from "../domains/pmsOperationsReadModel.js";
import type { BookingAddonItem, BookingAddonItemsRepository } from "./bookingAddonItems.js";

export type ManualBookingMoney = { amountDecimal: string; currency: string };
export type ManualBookingStay = {
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  ratePlanId: string | null;
  pricing:
    | { kind: "rate_plan"; manualOverride: ManualBookingMoney | null }
    | { kind: "custom"; nightlyAmount: ManualBookingMoney };
  dates: string[];
};
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
  pricing: Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  booking: Pick<BookingAddonItemsRepository, "listAddonItemsByHotelId"> &
    Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
};

export async function calculateManualBookingPreview(
  scope: { propertyId: string; organizationId: string },
  command: ManualBookingPreviewCommand,
  ports: PmsManualBookingPreviewRoutesOptions,
) {
  const { propertyId } = scope;
  const [rooms, roomTypes, pricing, addons, policy, available] = await Promise.all([
    ports.pms.listRoomsByPropertyId(propertyId),
    ports.pms.listRoomTypesByPropertyId(propertyId),
    ports.pricing.getRecurringPricingBookingEvidence(propertyId),
    ports.booking.listAddonItemsByHotelId(propertyId),
    ports.booking.getCurrentGuestPolicy(scope),
    ports.pms.getPhysicalRoomAvailability(propertyId, command.stays),
  ]);
  if (!pricing || !policy || !addons || pricing.propertyId !== propertyId)
    fail(404, "property_not_found");
  const currency = pricing.currency;
  let grand = 0n;
  const stays = command.stays.map((stay, index) => {
    const room = rooms.items.find((item) => item.roomId === stay.roomId);
    if (!room || available[index] === null) fail(404, "room_not_found", "roomId", stay.position);
    if (!available[index] || overlaps(stay, command.stays))
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
    let plan: PmsRatePlan | undefined;
    if (stay.pricing.kind === "rate_plan") {
      plan = roomType.ratePlans.find((item) => item.ratePlanId === stay.ratePlanId);
      if (!plan) fail(404, "rate_plan_not_found", "ratePlanId", stay.position);
      if (!plan.active) fail(422, "inactive_rate_plan", "ratePlanId", stay.position);
      requireCurrency(plan.baseRate, currency, stay.position);
    }
    const standards = plan
      ? stay.dates.map((date) =>
          standard(
            plan,
            room.roomTypeId,
            date,
            chargeableGuests(stay, room.roomTypeId, plan.ratePlanId, policy),
            pricing,
          ),
        )
      : null;
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
      BigInt(unitFactor(addon, selection, command.stays));
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
  stays: ManualBookingStay[],
): number {
  const units = selection.serviceUnits;
  const occupancy = (date: string) =>
    stays
      .filter((stay) => stay.checkIn <= date && date < stay.checkOut)
      .reduce((sum, stay) => sum + stay.adults + stay.children, 0);
  const dates = units.flatMap((unit) => (unit.serviceDate === null ? [] : [unit.serviceDate]));
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
      units.length > 0 &&
      units.every(
        (unit) =>
          unit.serviceDate !== null && unit.guestCount === null && occupancy(unit.serviceDate) > 0,
      );
  if (addon.pricingModel === "per_guest_night")
    valid &&=
      units.length > 0 &&
      units.every(
        (unit) =>
          unit.serviceDate !== null &&
          !!unit.guestCount &&
          unit.guestCount! <= occupancy(unit.serviceDate),
      );
  if (!valid) fail(422, "invalid_addon_selection", "serviceUnits");
  return units.reduce((sum, unit) => sum + (unit.guestCount ?? 1), 0);
}

function standard(
  plan: PmsRatePlan,
  roomTypeId: string,
  date: string,
  guestCount: number,
  evidence: PmsRecurringPricingBookingEvidence,
): bigint {
  const season = evidence.sources.find(
    (item) =>
      item.sourceKind === "season" &&
      item.lifecycle === "active" &&
      inRange(date.slice(5), item.startMonthDay, item.endMonthDay),
  );
  const seasonAmount =
    season?.sourceKind === "season"
      ? season.roomPrices.find(
          (price) =>
            price.roomTypeId === roomTypeId && price.flexibleRatePlanId === plan.ratePlanId,
        )?.amountDecimal
      : null;
  const weekend = evidence.sources.find(
    (item) =>
      item.sourceKind === "weekend_surcharge" &&
      item.lifecycle === "active" &&
      item.weekdays.includes(weekday(date)),
  );
  const surcharge =
    weekend?.sourceKind === "weekend_surcharge"
      ? weekend.roomSurcharges.find(
          (item) => item.roomTypeId === roomTypeId && item.flexibleRatePlanId === plan.ratePlanId,
        )?.amountDecimal
      : null;
  const extra = evidence.sources.find(
    (item) =>
      item.sourceKind === "additional_guest" &&
      item.lifecycle === "active" &&
      item.roomTypeId === roomTypeId &&
      item.flexibleRatePlanId === plan.ratePlanId,
  );
  return (
    minor(seasonAmount ?? plan.baseRate.amountDecimal) +
    minor(surcharge ?? "0") +
    (extra?.sourceKind === "additional_guest"
      ? minor(extra.amountDecimal) * BigInt(Math.max(0, guestCount - extra.includedGuests))
      : 0n)
  );
}

function chargeableGuests(
  stay: ManualBookingStay,
  roomTypeId: string,
  ratePlanId: string,
  policy: BookingGuestPolicyRevision,
): number {
  const additionalGuest = policy.bundle.rates.find(
    (rate) => rate.roomTypeId === roomTypeId && rate.flexible.source.entityId === ratePlanId,
  )?.additionalGuest;
  return (
    stay.adults +
    (additionalGuest?.countedGuestTypes.some((guestType) => guestType === "child")
      ? stay.children
      : 0)
  );
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
function overlaps(stay: ManualBookingStay, stays: ManualBookingStay[]): boolean {
  return stays.some(
    (other) =>
      other.position < stay.position &&
      other.roomId === stay.roomId &&
      other.checkIn < stay.checkOut &&
      other.checkOut > stay.checkIn,
  );
}
