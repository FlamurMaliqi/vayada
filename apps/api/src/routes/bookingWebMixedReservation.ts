import { bookingRoomSelectionParty, parseBookingRoomSelection } from "@vayada/domain-booking";
import { lockPmsInventoryMutationScope } from "../domains/pmsInventoryMutationLock.js";
import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";
import { quoteTargetRoomSelection } from "./bookingWebMixedQuote.js";
import {
  createHttpError,
  loadTargetCheckoutConfig,
  objectValue,
  moneyToCents,
  stableJson,
  type BookingWebQueryExecutor,
  type TargetCheckoutPropertyRow,
  type TargetCheckoutQuoteSnapshot,
} from "./bookingWebPublic.js";

/** The caller owns the transaction: failed validation or reserve rolls back every line. */
export async function reserveTargetMixedBooking(
  pool: BookingWebQueryExecutor,
  port: DirectBookingInventoryReservationPort,
  property: TargetCheckoutPropertyRow,
  quote: TargetCheckoutQuoteSnapshot,
  now: Date,
) {
  const selection = parseBookingRoomSelection(quote.selectedOfferSnapshot["roomSelection"]);
  const savedLines = quote.selectedOfferSnapshot["roomLines"];
  const unavailable = () =>
    createHttpError(409, "Room selection changed. Please refresh the checkout quote.");
  if (
    !selection ||
    !Array.isArray(savedLines) ||
    savedLines.length !== selection.lines.length ||
    !port.reserveBundle
  )
    throw unavailable();
  const party = bookingRoomSelectionParty(selection);
  if (
    party.adults !== quote.adults ||
    party.children !== quote.children ||
    party.rooms !== quote.roomCount
  )
    throw unavailable();
  await lockPmsInventoryMutationScope(pool, property.propertyId);
  const config = await loadTargetCheckoutConfig(pool, property.propertyId);
  if ((config?.defaultCurrency ?? "EUR") !== quote.currency) throw unavailable();
  const current = await quoteTargetRoomSelection(pool, {
    propertyId: property.propertyId,
    selection,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    currency: quote.currency,
    requestedAt: now,
    promotionSettings: config?.promotionSettings,
    today: new Intl.DateTimeFormat("en-CA", {
      timeZone: property.timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now),
  });
  if (!quote.paymentMethod || !current.paymentOptions.includes(quote.paymentMethod))
    throw unavailable();
  const couponDiscount = moneyToCents((quote.totals["promoDiscount"] as string) ?? "0");
  const currentAutomatic = moneyToCents(current.totals["promotionDiscount"]!);
  const automaticWins = currentAutomatic > couponDiscount;
  if (
    (automaticWins ? currentAutomatic : 0n) !==
    moneyToCents((quote.totals["promotionDiscount"] as string) ?? "0")
  )
    throw unavailable();
  for (const [index, line] of current.lines.entries()) {
    const saved = objectValue(savedLines[index]);
    const offer = objectValue(saved["offer"]);
    if (
      saved["roomTypeId"] !== line.roomTypeId ||
      saved["publicOfferKey"] !== line.publicOfferKey ||
      stableJson(saved["guests"]) !== stableJson(line.guests)
    )
      throw unavailable();
    for (const key of [
      "ratePlanId",
      "publicPolicy",
      "rateSummary",
      "roomTotal",
      "taxesAndFees",
      "discounts",
      "currency",
    ] as const) {
      if (stableJson(offer[key]) !== stableJson(line.offer[key])) throw unavailable();
    }
    if (stableJson(saved["promotion"]) !== stableJson(automaticWins ? line.promotion : null))
      throw unavailable();
  }
  return port.reserveBundle({
    transaction: pool,
    propertyId: property.propertyId,
    quoteSessionId: quote.quoteSessionId,
    lines: selection.lines.map((line) => ({
      roomTypeId: line.roomTypeId,
      publicOfferKey: line.publicOfferKey,
      roomCount: line.guests.length,
    })),
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    currency: quote.currency,
    occurredAt: now,
  });
}
