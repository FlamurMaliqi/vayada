import { importedNationalityMap } from "./importedNationality.js";
import { propertyFor } from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { BookingBuildContext, BookingTargetRecord } from "./productionBookingTypes.js";
import {
  currency,
  date,
  deterministicUuid,
  integer,
  iso,
  money,
  optionalDate,
  optionalIso,
  optionalText,
  requiredText,
  sha256,
  uuid,
} from "./productionBookingValues.js";

export function buildBookingRelatedRecords(context: BookingBuildContext): BookingTargetRecord[] {
  const promoByCode = promoCodeMap(context);
  const usageReferences = new Set(
    context.rows
      .filter(
        (row) => row.sourceDatabase === "pms" && row.sourceTable === "booking_promo_usage_state",
      )
      .map((row) => String(row.data["booking_reference"] ?? "").toLowerCase()),
  );
  return context.rows.flatMap((source) => {
    try {
      if (source.sourceDatabase === "pms" && source.sourceTable === "booking_additional_guests")
        return [additionalGuest(context, source)];
      if (source.sourceDatabase === "pms" && source.sourceTable === "booking_change_requests")
        return [changeRequest(context, source)];
      if (source.sourceDatabase === "pms" && source.sourceTable === "booking_promo_usage_state")
        return [promoUsage(context, source, promoByCode)];
      if (
        source.sourceDatabase === "booking" &&
        source.sourceTable === "booking_promo_redemptions"
      ) {
        const reference = redemptionBookingReference(context, source);
        return usageReferences.has(reference.toLowerCase())
          ? []
          : [promoRedemption(context, source, reference)];
      }
      if (source.sourceDatabase === "pms" && source.sourceTable === "bookings")
        return addonSelections(context, source);
      return [];
    } catch (error) {
      context.blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: `${source.sourceDatabase}.${source.sourceTable}`,
        sourceId: sourceIdentifier(source),
        message: error instanceof Error ? error.message : "Invalid related Booking row",
      });
      return [];
    }
  });
}

function additionalGuest(
  context: BookingBuildContext,
  source: IdentitySourceRow,
): BookingTargetRecord {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const booking = sourceBooking(context, data["booking_id"], "booking_id");
  const bookingId = uuid(booking.data["id"], "booking.id");
  const country = optionalText(data["nationality"], "nationality");
  const nationality = importedNationalityMap([country]);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const checkout = date(booking.data["check_out"], "booking.check_out");
  return record(source, "booking_guests", id, updatedAt, true, {
    id,
    guestBookingId: bookingId,
    guestRole: "additional_guest",
    firstName: String(data["first_name"] ?? ""),
    lastName: String(data["last_name"] ?? ""),
    email: optionalText(data["email"], "email"),
    phone: optionalText(data["phone"], "phone"),
    countryCode: nationality.countryCodes[0] ?? null,
    countryCodeRaw: nationality.rawValues[0] ?? null,
    countryCodeReviewRequired: nationality.reviewRequired[0] ?? false,
    arrivalTime: null,
    specialRequests: null,
    piiRetentionUntil: retentionDate(checkout),
    createdAt: iso(data["created_at"], "created_at"),
    updatedAt,
  });
}

function changeRequest(
  context: BookingBuildContext,
  source: IdentitySourceRow,
): BookingTargetRecord {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const booking = sourceBooking(context, data["booking_id"], "booking_id");
  const createdAt = iso(data["created_at"], "created_at");
  const decidedAt = optionalIso(data["decided_at"], "decided_at");
  const status = changeStatus(data["status"]);
  if ((status === "accepted" || status === "declined") && !decidedAt)
    throw new Error("decided_at is required for a decided change request");
  const requestType =
    String(data["old_check_in"]) !== String(data["requested_check_in"]) ||
    String(data["old_check_out"]) !== String(data["requested_check_out"])
      ? "date_change"
      : "addon_change";
  return record(source, "booking_change_requests", id, decidedAt ?? createdAt, true, {
    id,
    guestBookingId: uuid(booking.data["id"], "booking.id"),
    requestType,
    requestedBy: "guest",
    status,
    requestedChanges: {
      previous: {
        checkIn: data["old_check_in"],
        checkOut: data["old_check_out"],
        addonIds: data["old_addon_ids"] ?? [],
        addonQuantities: data["old_addon_quantities"] ?? {},
        addonDates: data["old_addon_dates"] ?? {},
        total: data["old_total"],
      },
      requested: {
        checkIn: data["requested_check_in"],
        checkOut: data["requested_check_out"],
        addonIds: data["requested_addon_ids"] ?? [],
        addonQuantities: data["requested_addon_quantities"] ?? {},
        addonDates: data["requested_addon_dates"] ?? {},
        nightlyRate: data["requested_nightly_rate"],
        addonTotal: data["requested_addon_total"],
        total: data["new_total"],
        priceDifference: data["price_difference"],
        currency: data["currency"],
      },
      migrationRunId: context.sourceRunId,
    },
    decisionActorUserId: null,
    decisionNote: optionalText(data["decline_reason"], "decline_reason"),
    decidedAt,
    createdAt,
    updatedAt: decidedAt ?? createdAt,
  });
}

function promoUsage(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  promoByCode: Map<string, IdentitySourceRow>,
): BookingTargetRecord {
  const data = source.data;
  const reference = requiredText(data["booking_reference"], "booking_reference");
  const booking = bookingByReference(context, reference);
  const code = requiredText(data["promo_code"], "promo_code").toUpperCase();
  const propertyId = propertyFor(context, "pms", "hotels", booking.data["hotel_id"]);
  const promo = promoByCode.get(`${propertyId}:${code}`);
  if (!promo) throw new Error(`promo_code ${code} has no source definition`);
  const desired = requiredText(data["desired_state"], "desired_state");
  const applied = requiredText(data["applied_state"], "applied_state");
  if (desired !== applied)
    context.blockers.push({
      code: "PROMO_RECONCILIATION_PENDING",
      source: "pms.booking_promo_usage_state",
      sourceId: reference,
      message: `Promo desired state ${desired} does not match applied state ${applied}`,
    });
  return promoApplication(
    context,
    source,
    booking,
    uuid(promo.data["id"], "promo.id"),
    deterministicUuid("production-booking", "promo-usage", reference),
    desired === "reversed" ? "reversed" : "applied",
    {
      desiredState: desired,
      appliedState: applied,
      attemptCount: integer(data["attempt_count"], "attempt_count", 0),
      completedAt: optionalIso(data["completed_at"], "completed_at"),
    },
  );
}

function promoRedemption(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  reference: string,
): BookingTargetRecord {
  const data = source.data;
  const booking = bookingByReference(context, reference);
  const promoId = uuid(data["promo_id"], "promo_id");
  if (!context.promoById.has(promoId)) throw new Error("promo_id has no source definition");
  const status = requiredText(data["status"], "status");
  return promoApplication(
    context,
    source,
    booking,
    promoId,
    uuid(data["id"], "id"),
    status === "reversed" ? "reversed" : "applied",
    { reversedAt: optionalIso(data["reversed_at"], "reversed_at") },
  );
}

function redemptionBookingReference(
  context: BookingBuildContext,
  source: IdentitySourceRow,
): string {
  const promoId = uuid(source.data["promo_id"], "promo_id");
  const promo = context.promoById.get(promoId);
  if (!promo) throw new Error("promo_id has no source definition");
  const hotelId = uuid(promo.data["hotel_id"], "promo.hotel_id");
  const key = requiredText(source.data["redemption_key"], "redemption_key");
  const prefix = `${hotelId}:`;
  if (!key.toLowerCase().startsWith(prefix))
    throw new Error("redemption_key does not match its promo hotel");
  return requiredText(key.slice(prefix.length), "redemption booking reference");
}

function promoApplication(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  booking: IdentitySourceRow,
  promoId: string,
  id: string,
  status: string,
  evidence: Record<string, unknown>,
): BookingTargetRecord {
  const propertyId = propertyFor(context, "pms", "hotels", booking.data["hotel_id"]);
  const createdAt = iso(source.data["created_at"] ?? booking.data["created_at"], "created_at");
  return record(source, "promo_applications", id, createdAt, false, {
    id,
    propertyId,
    quoteSessionId: null,
    guestBookingId: uuid(booking.data["id"], "booking.id"),
    promoDefinitionId: promoId,
    promoCode: requiredText(
      source.data["promo_code"] ?? context.promoById.get(promoId)!.data["code"],
      "promo_code",
    ).toUpperCase(),
    applicationStatus: status,
    discountAmount: money(booking.data["promo_discount"], "promo_discount", "0.00"),
    currency: currency(booking.data["currency"] ?? "EUR"),
    metadata: { migrationRunId: context.sourceRunId, ...evidence },
    createdAt,
  });
}

function addonSelections(
  context: BookingBuildContext,
  source: IdentitySourceRow,
): BookingTargetRecord[] {
  const data = source.data;
  const ids = Array.isArray(data["addon_ids"]) ? data["addon_ids"] : [];
  const quantities = object(data["addon_quantities"]);
  const dates = object(data["addon_dates"]);
  const bookingId = uuid(data["id"], "id");
  const propertyId = propertyFor(context, "pms", "hotels", data["hotel_id"]);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const selections = ids.map((rawId, index) => {
    const addonId = uuid(rawId, `addon_ids[${index}]`);
    const addon = context.addonById.get(addonId);
    if (!addon) throw new Error(`addon ${addonId} has no source definition`);
    const quantity = integer(quantities[addonId], "addon quantity", 1);
    const amount = Number(money(addon.data["price"], "addon.price", "0.00")) * quantity;
    const id = deterministicUuid(
      "production-booking",
      "addon-selection",
      bookingId,
      addonId,
      String(index),
    );
    return record(source, "booking_addon_selections", id, updatedAt, false, {
      id,
      propertyId,
      guestBookingId: bookingId,
      quoteSessionId: null,
      addonDefinitionId: addonId,
      addonSnapshot: {
        name: addon.data["name"],
        category: addon.data["category"],
        pricingModel: addon.data["per_person"] === true ? "per_guest" : "per_stay",
      },
      quantity,
      serviceDate: optionalDate(dates[addonId], "addon service date"),
      totalAmount: amount.toFixed(2),
      currency: currency(data["currency"] ?? addon.data["currency"] ?? "EUR"),
      createdAt: iso(data["created_at"], "created_at"),
    });
  });
  if (data["addon_total"] !== null && data["addon_total"] !== undefined) {
    const expected = money(data["addon_total"], "addon_total");
    const actual = selections
      .reduce((sum, selection) => sum + Number(selection.row["totalAmount"]), 0)
      .toFixed(2);
    if (actual !== expected)
      throw new Error(`addon_total ${expected} does not match selection total ${actual}`);
  }
  return selections;
}

function sourceBooking(
  context: BookingBuildContext,
  value: unknown,
  field: string,
): IdentitySourceRow {
  const id = requiredText(value, field).toLowerCase();
  const booking = context.bookingById.get(id);
  if (!booking) throw new Error(`${field} does not resolve to a source booking`);
  return booking;
}
function bookingByReference(context: BookingBuildContext, value: string): IdentitySourceRow {
  const booking = context.bookingByReference.get(value.toLowerCase());
  if (!booking) throw new Error(`booking reference ${value} does not resolve`);
  return booking;
}
function promoCodeMap(context: BookingBuildContext): Map<string, IdentitySourceRow> {
  const result = new Map<string, IdentitySourceRow>();
  for (const row of context.rows.filter(
    (item) => item.sourceDatabase === "booking" && item.sourceTable === "booking_promo_codes",
  )) {
    try {
      const propertyId = propertyFor(context, "booking", "booking_hotels", row.data["hotel_id"]);
      const key = `${propertyId}:${requiredText(row.data["code"], "code").toUpperCase()}`;
      if (result.has(key))
        context.blockers.push({
          code: "DUPLICATE_PROPERTY_PROMO_CODE",
          source: "booking.booking_promo_codes",
          sourceId: key,
          message: "Promo code is duplicated for one target property",
        });
      else result.set(key, row);
    } catch {
      // Ownership validation already records unresolved source links.
    }
  }
  return result;
}
function changeStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  const mapped = {
    approved: "accepted",
    accepted: "accepted",
    declined: "declined",
    pending: "pending",
    canceled: "canceled",
    cancelled: "canceled",
    expired: "expired",
  } as Record<string, string>;
  if (!mapped[status]) throw new Error(`change request status ${status} is unsupported`);
  return mapped[status];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function retentionDate(checkOut: string): string {
  const value = new Date(`${checkOut}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
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
    sourceDatabase: source.sourceDatabase as "booking" | "pms",
    sourceTable: source.sourceTable,
    sourceId: sourceIdentifier(source),
    sourceChecksum: sha256(source.data),
    sourceUpdatedAt,
    mutable,
    row,
  };
}
function sourceIdentifier(row: IdentitySourceRow): string {
  const field = row.sourceTable === "booking_promo_usage_state" ? "booking_reference" : "id";
  return String(row.data[field] ?? row.rowOrdinal);
}
