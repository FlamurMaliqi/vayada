import {
  bookingAddonMediaFor,
  bookingHeaderLogoMediaFor,
  bookingHeroMediaFor,
  propertyFor,
} from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { BookingBuildContext, BookingTargetRecord } from "./productionBookingTypes.js";
import {
  bool,
  currency,
  integer,
  iso,
  money,
  optionalArray,
  optionalDate,
  optionalObject,
  optionalText,
  redactPrivate,
  requiredText,
  sha256,
  sourceId,
  uuid,
} from "./productionBookingValues.js";

export function buildBookingCatalogRecords(context: BookingBuildContext): BookingTargetRecord[] {
  return context.rows.flatMap((row) => {
    try {
      if (row.sourceDatabase === "booking" && row.sourceTable === "booking_hotels")
        return [settings(context, row)];
      if (row.sourceDatabase === "booking" && row.sourceTable === "booking_addons")
        return [addon(context, row)];
      if (row.sourceDatabase === "booking" && row.sourceTable === "booking_promo_codes")
        return [promo(context, row)];
      if (row.sourceDatabase === "booking" && row.sourceTable === "booking_events")
        return [auditEvent(context, row)];
      return [];
    } catch (error) {
      context.blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: `${row.sourceDatabase}.${row.sourceTable}`,
        sourceId: safeSourceId(row),
        message: error instanceof Error ? error.message : "Invalid Booking source row",
      });
      return [];
    }
  });
}

function settings(context: BookingBuildContext, source: IdentitySourceRow): BookingTargetRecord {
  const data = source.data;
  const propertyId = propertyFor(context, "booking", "booking_hotels", data["id"]);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const primaryColor = String(data["branding_primary_color"] ?? "").trim();
  const headerLogoMediaObjectId = bookingHeaderLogoMediaFor(context, source, propertyId);
  const heroImageUrl = bookingHeroMediaFor(context, source, propertyId);
  return record(source, "booking", "booking_settings", propertyId, updatedAt, true, {
    propertyId,
    showAddonsStep: bool(data["show_addons_step"], "show_addons_step", true),
    groupAddonsByCategory: bool(data["group_addons_by_category"], "group_addons_by_category", true),
    specialRequestsEnabled: bool(
      data["special_requests_enabled"],
      "special_requests_enabled",
      true,
    ),
    arrivalTimeEnabled: bool(data["arrival_time_enabled"], "arrival_time_enabled", false),
    guestCountEnabled: bool(data["guest_count_enabled"], "guest_count_enabled", false),
    phoneRequired: bool(data["phone_required"], "phone_required", true),
    adultAgeThreshold: integer(data["adult_age_threshold"], "adult_age_threshold", 18),
    childrenEnabled: bool(data["children_enabled"], "children_enabled", true),
    benefits: optionalArray(data["benefits"]),
    defaultCurrency: currency(data["currency"] ?? "EUR"),
    defaultLanguage: requiredText(data["default_language"] ?? "en", "default_language"),
    supportedCurrencies: textArray(data["supported_currencies"]),
    supportedLanguages: textArray(data["supported_languages"], ["en"]),
    bookingFilters: optionalArray(data["booking_filters"]),
    customFilters: optionalObject(data["custom_filters"]),
    filterRooms: optionalObject(data["filter_rooms"]),
    sourceFreshness: { migrationRunId: context.sourceRunId, sourceUpdatedAt: updatedAt },
    headerLogoMediaObjectId,
    heroImageUrl,
    primaryColor: primaryColorValue(primaryColor),
    fontPairing: fontPairing(data["branding_font_pairing"]),
    acceptanceMode: bool(data["instant_book"], "instant_book", false) ? "instant" : "request",
    updatedAt,
  });
}

function addon(context: BookingBuildContext, source: IdentitySourceRow): BookingTargetRecord {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyFor(context, "booking", "booking_hotels", data["hotel_id"]);
  const media = bookingAddonMediaFor(context, source, propertyId);
  const updatedAt = iso(data["updated_at"], "updated_at");
  return record(source, "booking", "addon_definitions", id, updatedAt, true, {
    id,
    propertyId,
    sourceSystem: "booking",
    sourceAddonId: id,
    name: requiredText(data["name"], "name"),
    description: optionalText(data["description"], "description"),
    category: optionalText(data["category"], "category"),
    pricingModel: bool(data["per_person"], "per_person", false) ? "per_guest" : "per_stay",
    priceAmount: money(data["price"], "price", "0.00"),
    currency: currency(data["currency"] ?? "EUR"),
    publicVisible: true,
    status: "active",
    metadata: {
      migrationRunId: context.sourceRunId,
      imageUrl: media?.publicUrl ?? null,
      mediaObjectId: media?.mediaObjectId ?? null,
      duration: optionalText(data["duration"], "duration"),
      sortOrder: integer(data["sort_order"], "sort_order", 0),
    },
    createdAt: iso(data["created_at"], "created_at"),
    updatedAt,
  });
}

function promo(context: BookingBuildContext, source: IdentitySourceRow): BookingTargetRecord {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyFor(context, "booking", "booking_hotels", data["hotel_id"]);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const type = requiredText(data["discount_type"], "discount_type").toLowerCase();
  if (type !== "percentage" && type !== "fixed") throw new Error("discount_type is unsupported");
  return record(source, "booking", "promo_definitions", id, updatedAt, true, {
    id,
    propertyId,
    sourceSystem: "booking",
    sourcePromoId: id,
    code: requiredText(data["code"], "code").toUpperCase(),
    discountType: type,
    discountValue: money(data["discount_value"], "discount_value"),
    validFrom: optionalDate(data["valid_from"], "valid_from"),
    validUntil: optionalDate(data["valid_until"], "valid_until"),
    isActive: bool(data["is_active"], "is_active", true),
    maxUses: integer(data["max_uses"], "max_uses", 999),
    currentUses: integer(data["current_uses"] ?? data["use_count"], "current_uses", 0),
    status: bool(data["is_active"], "is_active", true) ? "active" : "retired",
    minBookingValue: data["min_booking_value"] ?? null,
    applicableRoomIds: data["applicable_room_ids"] ?? null,
    stayDateFrom: optionalDate(data["stay_date_from"], "stay_date_from"),
    stayDateUntil: optionalDate(data["stay_date_until"], "stay_date_until"),
    metadata: { migrationRunId: context.sourceRunId },
    createdAt: iso(data["created_at"], "created_at"),
    updatedAt,
  });
}

function auditEvent(context: BookingBuildContext, source: IdentitySourceRow): BookingTargetRecord {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const slug = requiredText(data["hotel_slug"], "hotel_slug").toLowerCase();
  const propertyId = context.propertyBySlug.get(slug);
  if (!propertyId) throw new Error("hotel_slug has no unique active target property");
  const metadata = optionalObject(data["metadata"]);
  const occurredAt = iso(data["created_at"], "created_at");
  const sessionId = optionalText(data["session_id"], "session_id");
  return record(source, "platform", "product_audit_events", id, occurredAt, false, {
    id,
    auditKey: `legacy-booking-event:${id}`,
    product: "booking",
    action: `booking.funnel.${requiredText(data["event_type"], "event_type")}`,
    occurredAt,
    tenantScope: "property",
    propertyId,
    actorType: "migration",
    targetResourceProduct: "booking",
    targetResourceType: "booking_funnel_session",
    targetResourceId: sessionId ?? id,
    correlationId: sessionId,
    redactedPayload: redactPrivate(metadata),
    privatePayload: metadata,
    auditMetadata: { migrationRunId: context.sourceRunId, sourceTable: "booking_events" },
    retentionClass: "guest_pii",
    privacyScope: "restricted",
    aiVisible: false,
  });
}

function record(
  source: IdentitySourceRow,
  targetProduct: "booking" | "platform",
  targetTable: string,
  targetId: string,
  sourceUpdatedAt: string | null,
  mutable: boolean,
  row: Record<string, unknown>,
): BookingTargetRecord {
  return {
    targetProduct,
    targetTable,
    targetId,
    sourceDatabase: source.sourceDatabase as "booking" | "pms",
    sourceTable: source.sourceTable,
    sourceId: sourceId(source),
    sourceChecksum: sha256(source.data),
    sourceUpdatedAt,
    mutable,
    row,
  };
}

function textArray(value: unknown, fallback: string[] = []): string[] {
  const values = Array.isArray(value) ? value : fallback;
  if (!values.every((entry) => typeof entry === "string" && entry.trim()))
    throw new Error("Expected an array of non-empty text values");
  return values.map((entry) => String(entry).trim());
}

function fontPairing(value: unknown): string {
  const key = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const mapped: Record<string, string> = {
    "modern-minimalist": "modern-minimalist",
    "inter-inter": "modern-minimalist",
    "inter-merriweather": "modern-minimalist",
    "grand-classic": "grand-classic",
    "cormorant-garamond-lato": "grand-classic",
    "lora-source-sans-pro": "grand-classic",
    "imperial-serif": "imperial-serif",
    "cinzel-source-sans-pro": "imperial-serif",
    "italiana-serif": "italiana-serif",
    "italiana-source-sans-pro": "italiana-serif",
  };
  if (!key) return "high-end-serif";
  if (!mapped[key]) throw new Error(`branding_font_pairing ${key} is unsupported`);
  return mapped[key];
}

function primaryColorValue(value: string): string {
  if (!value) return "#4F46E5";
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("branding_primary_color is invalid");
  return value.toUpperCase();
}

function safeSourceId(row: IdentitySourceRow): string {
  try {
    return sourceId(row);
  } catch {
    return String(row.rowOrdinal);
  }
}
