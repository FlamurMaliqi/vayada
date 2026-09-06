import { quoteTargetRoomSelection, type TargetQuotedRoomLine } from "./bookingWebMixedQuote.js";
import {
  createHttpError,
  createTargetCheckoutQuote,
  loadTargetCheckoutConfig,
  objectValue,
  moneyToCents,
  moneyFromCents,
  type BookingWebCheckoutRequest,
  type BookingWebQueryExecutor,
  type TargetCheckoutPropertyRow,
  type TargetCheckoutQuoteOfferRow,
} from "./bookingWebPublic.js";

/** Internal preparation; public mixed checkout is enabled only with lifecycle support. */
export async function createTargetMixedCheckoutQuote(
  pool: BookingWebQueryExecutor,
  property: TargetCheckoutPropertyRow,
  request: BookingWebCheckoutRequest,
  now: Date,
  edit?: Parameters<typeof createTargetCheckoutQuote>[4],
  credits?: ReadonlyMap<string, { checkIn: string; checkOut: string; roomCount: number }>,
) {
  const config = await loadTargetCheckoutConfig(pool, property.propertyId);
  const currency = config?.defaultCurrency ?? "EUR";
  if (
    request["currency"] !== undefined &&
    (typeof request["currency"] !== "string" ||
      request["currency"].trim().toUpperCase() !== currency)
  )
    throw createHttpError(409, "Property currency changed. Please refresh the checkout quote.");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: property.timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const mixed = await quoteTargetRoomSelection(pool, {
    propertyId: property.propertyId,
    selection: request["roomSelection"],
    checkIn: String(request["checkIn"] ?? ""),
    checkOut: String(request["checkOut"] ?? ""),
    currency,
    today,
    requestedAt: now,
    promotionSettings: config?.promotionSettings,
    credits,
  });
  if (
    mixed.party.adults !== request["adults"] ||
    mixed.party.children !== request["children"] ||
    mixed.party.rooms !== request["numberOfRooms"]
  )
    throw createHttpError(400, "Room allocations must match the requested guests and room count.");
  return createTargetCheckoutQuote(
    pool,
    property,
    { ...request, currency, roomTypeId: mixed.selection.lines[0]!.roomTypeId },
    now,
    edit,
    mixed,
  );
}

type MixedQuote = Awaited<ReturnType<typeof quoteTargetRoomSelection>>;
export function mixedSelectionOffer(mixed: MixedQuote): TargetCheckoutQuoteOfferRow {
  return {
    ...mixed.lines[0]!.offer,
    paymentOptions: mixed.paymentOptions,
    roomSummary: {
      name: mixed.lines
        .map(
          (line) =>
            `${line.guests.length} × ${
              objectValue(line.offer.roomSummary)["name"] ?? line.roomTypeId
            }`,
        )
        .join(" + "),
    },
    roomTotal: mixed.totals["roomTotal"]!,
    taxesAndFees: mixed.totals["taxesAndFees"]!,
    discounts: mixed.totals["discounts"]!,
  };
}

export function mixedSelectionPromotion(mixed: MixedQuote) {
  const discountAmount = Number(mixed.totals["promotionDiscount"]);
  return discountAmount > 0
    ? {
        name: "Room promotions",
        type: "ROOM_COMBINATION",
        discountAmount,
        discountPercent:
          Number(mixed.totals["roomTotal"]) > 0
            ? (100 * discountAmount) / Number(mixed.totals["roomTotal"])
            : 0,
      }
    : null;
}

/** Allocate one booking discount without losing cents or discounting a zero-value line. */
export function allocateMixedQuoteDiscount(
  lines: TargetQuotedRoomLine[],
  discount: number,
  addonTotal: number,
) {
  const weights = [
    ...lines.map((line) => moneyToCents(line.totals.totalAmount)),
    moneyToCents(addonTotal),
  ];
  const total = weights.reduce((sum, amount) => sum + amount, 0n);
  const cents = moneyToCents(discount);
  if (cents > total) throw createHttpError(409, "Invalid booking discount.");
  const allocated = weights.map((amount) => (total ? (cents * amount) / total : 0n));
  let remainder = cents - allocated.reduce((sum, amount) => sum + amount, 0n);
  for (let index = 0; remainder && index < weights.length; index++) {
    if (allocated[index]! < weights[index]!) {
      allocated[index]! += 1n;
      remainder--;
    }
  }
  return {
    addonDiscount: moneyFromCents(allocated.at(-1)!),
    lines: lines.map((line, index) => ({
      ...line,
      totals: {
        ...line.totals,
        promoDiscount: moneyFromCents(allocated[index]!),
        totalAmount: moneyFromCents(weights[index]! - allocated[index]!),
      },
    })),
  };
}
