import {
  bestBookingPromotion,
  bookingRoomSelectionParty,
  parseBookingRoomSelection,
  type BookingRoomLine,
} from "@vayada/domain-booking";
import {
  pmsRoomStayRestrictionReason,
  readPmsRoomSelectionConflicts,
} from "../domains/pmsRoomSelectionConflicts.js";
import {
  createHttpError,
  loadTargetCheckoutOffer,
  moneyFromCents,
  moneyToCents,
  objectValue,
  type BookingWebQueryExecutor,
  type TargetCheckoutQuoteOfferRow,
} from "./bookingWebPublic.js";

type RoomLineTotals = Record<
  "roomTotal" | "taxesAndFees" | "discounts" | "promotionDiscount" | "totalAmount",
  string
>;
export type TargetQuotedRoomLine = BookingRoomLine & {
  offer: TargetCheckoutQuoteOfferRow;
  promotion: ReturnType<typeof bestBookingPromotion>;
  totals: RoomLineTotals;
};

/** Inactive until checkout persistence and all lifecycle consumers support selections. */
export async function quoteTargetRoomSelection(
  pool: BookingWebQueryExecutor,
  input: {
    propertyId: string;
    selection: unknown;
    checkIn: string;
    checkOut: string;
    currency: string;
    today: string;
    requestedAt: Date;
    promotionSettings?: unknown;
    credits?: ReadonlyMap<string, { checkIn: string; checkOut: string; roomCount: number }>;
  },
) {
  const selection = parseBookingRoomSelection(input.selection);
  const nights = (Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86_400_000;
  if (
    !selection ||
    !Number.isInteger(nights) ||
    nights < 1 ||
    nights > 365 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.checkIn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.checkOut) ||
    new Date(input.checkIn).toISOString().slice(0, 10) !== input.checkIn ||
    new Date(input.checkOut).toISOString().slice(0, 10) !== input.checkOut
  )
    throw createHttpError(400, "Invalid room selection or stay.");
  const conflicts = await readPmsRoomSelectionConflicts(
    pool,
    input.propertyId,
    selection.lines.map((line) => line.roomTypeId),
  );
  const groups = new Set<string>();
  for (const line of selection.lines) {
    const group = conflicts.get(line.roomTypeId);
    if (group === undefined || (group && groups.has(group)))
      throw createHttpError(409, "These rooms cannot be booked together. Please refresh.");
    if (group) groups.add(group);
  }
  const lines: TargetQuotedRoomLine[] = [];
  for (const line of selection.lines) {
    const offer = await loadTargetCheckoutOffer(pool, {
      propertyId: input.propertyId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      currency: input.currency,
      adults: Math.max(...line.guests.map((room) => room.adults)),
      children: Math.max(...line.guests.map((room) => room.children)),
      maximumRoomGuests: Math.max(...line.guests.map((room) => room.adults + room.children)),
      roomCount: line.guests.length,
      nights,
      roomTypeId: line.roomTypeId,
      exactPublicOfferKey: line.publicOfferKey,
      rateType: "",
      requestedAt: input.requestedAt,
      availabilityCredit: input.credits?.get(line.roomTypeId),
    });
    const restriction = await pmsRoomStayRestrictionReason(pool, {
      ...input,
      roomTypeId: line.roomTypeId,
      ratePlanId: offer.ratePlanId,
    });
    if (restriction)
      throw Object.assign(
        createHttpError(409, "This room's stay restrictions changed. Please refresh."),
        { availabilityReason: restriction },
      );
    const promotion = bestBookingPromotion({
      settings: input.promotionSettings,
      roomTypeId: line.roomTypeId,
      today: input.today,
      nights: nightlyAmounts(offer),
      roomTotal: Number(
        moneyFromCents(moneyToCents(offer.roomTotal) - moneyToCents(offer.discounts)),
      ),
      roomCount: line.guests.length,
    });
    const promotionDiscount = promotion?.discountAmount ?? 0;
    lines.push({
      ...line,
      offer,
      promotion,
      totals: {
        roomTotal: moneyFromCents(moneyToCents(offer.roomTotal)),
        taxesAndFees: moneyFromCents(moneyToCents(offer.taxesAndFees)),
        discounts: moneyFromCents(moneyToCents(offer.discounts)),
        promotionDiscount: moneyFromCents(moneyToCents(promotionDiscount)),
        totalAmount: moneyFromCents(
          moneyToCents(offer.roomTotal) +
            moneyToCents(offer.taxesAndFees) -
            moneyToCents(offer.discounts) -
            moneyToCents(promotionDiscount),
        ),
      },
    });
  }
  const paymentOptions = (lines[0]!.offer.paymentOptions ?? []).filter((method) =>
    lines.every(
      ({ offer }) =>
        offer.paymentOptions?.includes(method) &&
        Array.isArray(offer.nightlyPaymentOptions) &&
        offer.nightlyPaymentOptions.length === nights &&
        offer.nightlyPaymentOptions.every(
          (options: unknown) => Array.isArray(options) && options.includes(method),
        ),
    ),
  );
  if (!paymentOptions.length)
    throw Object.assign(createHttpError(409, "These rooms have no common payment method."), {
      availabilityReason: "payment_disabled",
    });
  const totals = Object.fromEntries(
    (["roomTotal", "taxesAndFees", "discounts", "promotionDiscount", "totalAmount"] as const).map(
      (key) => [
        key,
        moneyFromCents(lines.reduce((sum, line) => sum + moneyToCents(line.totals[key]), 0n)),
      ],
    ),
  );
  return {
    selection,
    party: bookingRoomSelectionParty(selection),
    lines,
    totals,
    paymentOptions,
    currency: input.currency,
  };
}

function nightlyAmounts(offer: TargetCheckoutQuoteOfferRow) {
  const value = offer.promotionNightlyRoomAmounts ?? offer.nightlyRoomAmounts;
  if (!Array.isArray(value)) throw createHttpError(409, "Nightly pricing is unavailable.");
  return value.map((night) => {
    const row = objectValue(night);
    return { stayDate: String(row["stayDate"]), grossRoomAmount: String(row["grossRoomAmount"]) };
  });
}
