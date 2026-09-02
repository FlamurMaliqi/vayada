import { importedNationalityMap } from "./importedNationality.js";
import { propertyFor } from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { BookingBuildContext, BookingTargetRecord } from "./productionBookingTypes.js";
import {
  bookingLifecycle,
  bookingPayment,
  currency,
  date,
  deterministicUuid,
  integer,
  iso,
  money,
  optionalIso,
  optionalText,
  requiredText,
  sha256,
  sourceId,
  uuid,
} from "./productionBookingValues.js";

export function buildBookingReservationRecords(
  context: BookingBuildContext,
): BookingTargetRecord[] {
  const materializedDraft = new Map<string, IdentitySourceRow>();
  for (const draft of context.rows.filter(
    (row) => row.sourceDatabase === "pms" && row.sourceTable === "booking_drafts",
  )) {
    const bookingId = optionalText(
      draft.data["materialized_booking_id"],
      "materialized_booking_id",
    );
    if (bookingId) materializedDraft.set(bookingId.toLowerCase(), draft);
  }
  return context.rows.flatMap((source) => {
    if (source.sourceDatabase !== "pms" || source.sourceTable !== "bookings") return [];
    try {
      return reservation(
        context,
        source,
        materializedDraft.get(String(source.data["id"]).toLowerCase()),
      );
    } catch (error) {
      context.blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: "pms.bookings",
        sourceId: safeSourceId(source),
        message: error instanceof Error ? error.message : "Invalid Booking reservation",
      });
      return [];
    }
  });
}

function reservation(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  draft: IdentitySourceRow | undefined,
): BookingTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyFor(context, "pms", "hotels", data["hotel_id"]);
  const lifecycleStatus = bookingLifecycle(data["status"]);
  const paymentStatus = bookingPayment(data["payment_status"] ?? "unpaid");
  const checkIn = date(data["check_in"], "check_in");
  const checkOut = date(data["check_out"], "check_out");
  if (checkIn >= checkOut) throw new Error("check_in must precede check_out");
  const createdAt = iso(data["created_at"], "created_at");
  const updatedAt = iso(data["updated_at"], "updated_at");
  const bookingReference = requiredText(data["booking_reference"], "booking_reference");
  const bookingCurrency = currency(data["currency"] ?? "EUR");
  const totalAmount = money(data["total_amount"], "total_amount");
  const balanceAmount = money(data["balance_amount"], "balance_amount", totalAmount);
  const roomCount = integer(data["number_of_rooms"], "number_of_rooms", 1);
  const billingPlanSnapshot = billingPlan(data["billing_plan_at_creation"]);
  const draftId = draft ? uuid(draft.data["id"], "draft.id") : null;
  const quoteSessionId = draftId
    ? deterministicUuid("production-booking", "draft-quote", draftId)
    : null;
  const bookingRow = {
    id,
    propertyId,
    quoteSessionId,
    checkoutContextId: draftId,
    publicReference: bookingReference,
    sourceSystem: "pms",
    sourceBookingId: id,
    lifecycleStatus,
    paymentStatus,
    checkIn,
    checkOut,
    adults: integer(data["adults"], "adults", 1),
    children: integer(data["children"], "children", 0),
    roomCount,
    currency: bookingCurrency,
    totalAmount,
    balanceAmount,
    cancellationReason: lifecycleStatus === "canceled" ? "legacy_canceled" : null,
    bookingMetadata: bookingMetadata(context, data, billingPlanSnapshot),
    expectedPaymentMethod: expectedPaymentMethod(data["payment_method"]),
    billingPlanSnapshot,
    commissionTermsSnapshot: commissionTerms(data),
    financeTermsCapturedAt: createdAt,
    bookingChannel: bookingChannel(data["channel"]),
    directBookingSource: directBookingSource(data),
    createdAt,
    updatedAt,
  };
  const bookerId = deterministicUuid("production-booking", "booker", id);
  const nationality = importedNationalityMap([
    optionalText(data["guest_country"], "guest_country"),
  ]);
  const guestRow = {
    id: bookerId,
    guestBookingId: id,
    guestRole: "booker",
    firstName: requiredText(data["guest_first_name"], "guest_first_name"),
    lastName: requiredText(data["guest_last_name"], "guest_last_name"),
    email: optionalText(data["guest_email"], "guest_email"),
    phone: optionalText(data["guest_phone"], "guest_phone"),
    countryCode: nationality.countryCodes[0] ?? null,
    countryCodeRaw: nationality.rawValues[0] ?? null,
    countryCodeReviewRequired: nationality.reviewRequired[0] ?? false,
    arrivalTime: optionalText(data["estimated_arrival_time"], "estimated_arrival_time"),
    specialRequests: optionalText(data["special_requests"], "special_requests"),
    piiRetentionUntil: retentionDate(checkOut),
    createdAt,
    updatedAt,
  };
  const eventId = deterministicUuid("production-booking", "lifecycle", id, lifecycleStatus);
  const eventRow = {
    id: eventId,
    guestBookingId: id,
    eventType: "booking.lifecycle.migrated",
    fromStatus: null,
    toStatus: lifecycleStatus,
    actorType: "migration",
    actorUserId: null,
    publicVisible: true,
    publicMessage: null,
    eventPayload: { migrationRunId: context.sourceRunId, sourceStatus: data["status"] },
    occurredAt: updatedAt,
    createdAt: updatedAt,
  };
  const summaryRow = {
    guestBookingId: id,
    propertyId,
    publicReference: bookingReference,
    lifecycleStatus,
    paymentStatus,
    checkIn,
    checkOut,
    guestCounts: {
      adults: bookingRow.adults,
      children: bookingRow.children,
      roomCount,
    },
    roomSummary: {
      roomTypeId: optionalText(data["room_type_id"], "room_type_id"),
      roomCount,
      nights: nights(checkIn, checkOut),
    },
    amountSummary: { currency: bookingCurrency, total: totalAmount, balance: balanceAmount },
    publicPolicy: {
      rateType: optionalText(data["rate_type"], "rate_type"),
      depositRequired: data["deposit_required"] === true,
    },
    sourceFreshness: { migrationRunId: context.sourceRunId, sourceUpdatedAt: updatedAt },
    projectedAt: updatedAt,
  };
  return [
    record(source, "guest_bookings", id, updatedAt, true, bookingRow),
    record(source, "booking_guests", bookerId, updatedAt, true, guestRow),
    record(source, "booking_status_events", eventId, updatedAt, false, eventRow),
    record(source, "direct_booking_summary_read_model", id, updatedAt, true, summaryRow),
  ];
}

function bookingMetadata(
  context: BookingBuildContext,
  data: Record<string, unknown>,
  billingPlanSnapshot: string,
) {
  return {
    migrationRunId: context.sourceRunId,
    sourceHotelId: data["hotel_id"],
    roomTypeId: data["room_type_id"],
    roomId: data["room_id"] ?? null,
    rateType: data["rate_type"] ?? null,
    nightlyRate: data["nightly_rate"] ?? null,
    addonIds: data["addon_ids"] ?? [],
    addonNames: data["addon_names"] ?? [],
    addonQuantities: data["addon_quantities"] ?? {},
    addonDates: data["addon_dates"] ?? {},
    addonTotal: data["addon_total"] ?? 0,
    sourcePaymentStatus: data["payment_status"] ?? "unpaid",
    billingPlanEvidence: {
      sourceField: "billing_plan_at_creation",
      sourceValue: data["billing_plan_at_creation"] ?? null,
      inferredPreSwitchCommission:
        billingPlanSnapshot === "commission" &&
        !String(data["billing_plan_at_creation"] ?? "").trim(),
    },
    promoCode: data["promo_code"] ?? null,
    promoDiscount: data["promo_discount"] ?? 0,
    lastMinuteDiscountPercent: data["last_minute_discount_percent"] ?? 0,
    lastMinuteDiscountAmount: data["last_minute_discount_amount"] ?? 0,
    referralCode: data["referral_code"] ?? null,
    affiliateId: data["affiliate_id"] ?? null,
    deposit: {
      required: data["deposit_required"] ?? false,
      percentage: data["deposit_percentage"] ?? null,
      amount: data["deposit_amount"] ?? 0,
    },
    operationalEvidence: {
      checkedInAt: optionalIso(data["checked_in_at"], "checked_in_at"),
      checkedOutAt: optionalIso(data["checked_out_at"], "checked_out_at"),
      noShow: data["status"] === "no_show",
      isTestBooking: data["is_test_booking"] === true,
    },
  };
}

function commissionTerms(data: Record<string, unknown>) {
  return {
    bookingEngineFeePct: data["booking_engine_fee_pct_at_creation"] ?? null,
    channelManagerFeePct: data["channel_manager_fee_pct_at_creation"] ?? null,
    affiliatePlatformFeePct: data["affiliate_platform_fee_pct_at_creation"] ?? null,
  };
}

function expectedPaymentMethod(value: unknown): string {
  const method = String(value ?? "").toLowerCase();
  if (method === "pay_at_property") return "pay_at_property";
  if (method === "bank_transfer") return "bank_transfer";
  if (method === "card" || method === "xendit") return "manual_card";
  return "unknown";
}

function billingPlan(value: unknown): string {
  const plan =
    String(value ?? "")
      .trim()
      .toLowerCase() || "commission";
  if (plan !== "fixed" && plan !== "commission")
    throw new Error(`billing_plan_at_creation ${plan} is unsupported`);
  return plan;
}

function bookingChannel(value: unknown): string {
  const channel = String(value ?? "").toLowerCase();
  const mapped: Record<string, string> = {
    direct: "direct",
    website: "direct",
    booking_engine: "direct",
    booking_com: "booking_com",
    "booking.com": "booking_com",
    airbnb: "airbnb",
    expedia: "expedia",
    agoda: "agoda",
  };
  if (!channel || channel === "manual") return "unknown";
  if (!mapped[channel]) throw new Error(`channel ${channel} is unsupported`);
  return mapped[channel];
}

function directBookingSource(data: Record<string, unknown>): string | null {
  return bookingChannel(data["channel"]) === "direct" ? "booking_engine" : null;
}

function retentionDate(checkOut: string): string {
  const value = new Date(`${checkOut}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
}

function nights(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
  );
}

function record(
  source: IdentitySourceRow,
  targetTable: string,
  targetId: string,
  sourceUpdatedAt: string,
  mutable: boolean,
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
    mutable,
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
