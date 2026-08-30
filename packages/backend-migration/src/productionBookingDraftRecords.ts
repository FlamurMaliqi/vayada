import { propertyFor } from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { BookingBuildContext, BookingTargetRecord } from "./productionBookingTypes.js";
import {
  currency,
  date,
  deterministicUuid,
  integer,
  iso,
  jsonObject,
  money,
  optionalArray,
  optionalText,
  requiredText,
  sha256,
  sourceId,
  uuid,
} from "./productionBookingValues.js";

export function buildBookingDraftRecords(context: BookingBuildContext): BookingTargetRecord[] {
  return context.rows.flatMap((source) => {
    if (source.sourceDatabase !== "pms" || source.sourceTable !== "booking_drafts") return [];
    try {
      return draftRecords(context, source);
    } catch (error) {
      context.blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: "pms.booking_drafts",
        sourceId: safeSourceId(source),
        message: error instanceof Error ? error.message : "Invalid Booking draft",
      });
      return [];
    }
  });
}

function draftRecords(
  context: BookingBuildContext,
  source: IdentitySourceRow,
): BookingTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyFor(context, "pms", "hotels", data["hotel_id"]);
  const payload = jsonObject(data["payload"], "payload");
  const createdAt = iso(data["created_at"], "created_at");
  const expiresAt = iso(data["expires_at"], "expires_at");
  const materializedId = optionalText(data["materialized_booking_id"], "materialized_booking_id");
  if (materializedId && !context.bookingById.has(materializedId.toLowerCase()))
    throw new Error("materialized_booking_id does not resolve to a source booking");
  const status = materializedId
    ? "converted"
    : Date.parse(expiresAt) <= Date.parse(context.completedAt)
      ? "expired"
      : "active";
  const quoteSessionId = deterministicUuid("production-booking", "draft-quote", id);
  const bookingReference = requiredText(data["booking_reference"], "booking_reference");
  const checkIn = date(data["check_in"], "check_in");
  const checkOut = date(data["check_out"], "check_out");
  const draftCurrency = currency(payload["currency"] ?? "EUR");
  const total = money(payload["total_amount"], "payload.total_amount", "0.00");
  const roomCount = integer(data["number_of_rooms"], "number_of_rooms", 1);
  const quote = {
    id: quoteSessionId,
    propertyId,
    requestHash: sha256(payload),
    publicQuoteReference: `MIG-Q-${bookingReference}`,
    requestedCheckIn: checkIn,
    requestedCheckOut: checkOut,
    adults: integer(payload["adults"], "payload.adults", 1),
    children: integer(payload["children"], "payload.children", 0),
    requestedRoomCount: roomCount,
    currency: draftCurrency,
    status,
    selectedOfferSnapshot: {
      roomTypeId: data["room_type_id"],
      nightlyRate: payload["nightly_rate"] ?? null,
      rateType: payload["rate_type"] ?? null,
      addonIds: payload["addon_ids"] ?? [],
    },
    totals: {
      total,
      addonTotal: payload["addon_total"] ?? 0,
      promoDiscount: payload["promo_discount"] ?? 0,
      depositAmount: payload["deposit_amount"] ?? 0,
      balanceAmount: payload["balance_amount"] ?? total,
    },
    unavailableReasons: [],
    policySnapshot: {
      rateType: payload["rate_type"] ?? null,
      requestFlow: payload["use_request_flow"] === true,
      depositRequired: payload["deposit_required"] === true,
    },
    sourceFreshness: { migrationRunId: context.sourceRunId, sourceCreatedAt: createdAt },
    promoCode: optionalText(payload["promo_code"], "payload.promo_code"),
    referralCode: optionalText(payload["referral_code"], "payload.referral_code"),
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  };
  const checkout = {
    id,
    quoteSessionId,
    propertyId,
    locale: "en",
    currency: draftCurrency,
    status,
    guestInput: guestInput(payload),
    selectedAddons: optionalArray(payload["addon_ids"]).map((addonId) => ({
      addonId,
      quantity: quantity(payload["addon_quantities"], addonId),
      serviceDate: serviceDate(payload["addon_dates"], addonId),
    })),
    paymentContext: {
      provider: "stripe",
      paymentIntentId: data["stripe_payment_intent_id"],
      accountId: data["stripe_account_id"] ?? null,
      applicationFeeAmount: data["stripe_application_fee_amount"] ?? null,
      platformFeeAmount: data["stripe_platform_fee_amount"] ?? null,
      affiliateCommissionAmount: data["stripe_affiliate_commission_amount"] ?? null,
    },
    promoContext: {
      code: payload["promo_code"] ?? null,
      discount: payload["promo_discount"] ?? 0,
    },
    piiRetentionUntil: expiresAt.slice(0, 10),
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  };
  return [
    record(source, "quote_sessions", quoteSessionId, createdAt, quote),
    record(source, "checkout_contexts", id, createdAt, checkout),
  ];
}

function guestInput(payload: Record<string, unknown>) {
  return {
    firstName: payload["guest_first_name"] ?? null,
    lastName: payload["guest_last_name"] ?? null,
    email: payload["guest_email"] ?? null,
    phone: payload["guest_phone"] ?? null,
    country: payload["guest_country"] ?? null,
    specialRequests: payload["special_requests"] ?? null,
    estimatedArrivalTime: payload["estimated_arrival_time"] ?? null,
    numberOfGuests: payload["number_of_guests"] ?? null,
  };
}

function quantity(value: unknown, addonId: unknown): number {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return integer(object[String(addonId)], "addon quantity", 1);
}

function serviceDate(value: unknown, addonId: unknown): unknown {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return object[String(addonId)] ?? null;
}

function record(
  source: IdentitySourceRow,
  targetTable: string,
  targetId: string,
  sourceUpdatedAt: string,
  row: Record<string, unknown>,
): BookingTargetRecord {
  return {
    targetProduct: "booking",
    targetTable,
    targetId,
    sourceDatabase: "pms",
    sourceTable: source.sourceTable,
    sourceId: sourceId(source),
    sourceChecksum: sha256(source.data),
    sourceUpdatedAt,
    mutable: true,
    row,
  };
}

function safeSourceId(row: IdentitySourceRow): string {
  try {
    return sourceId(row);
  } catch {
    return String(row.rowOrdinal);
  }
}
