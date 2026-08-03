import type { JsonValue, PropertySetupFieldId } from "./propertySetupDraft.js";

type Validator = (value: unknown) => boolean;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const COMPENSATION_TYPES = new Set(["free_stay", "paid", "discount", "affiliate"]);
const CONTENT_PLATFORMS = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "blog",
  "x",
  "other",
]);
const CONTENT_TYPES = new Set([
  "post",
  "story",
  "short_form_video",
  "long_form_video",
  "photography",
  "other",
]);
const FONT_PAIRINGS = new Set([
  "high-end-serif",
  "modern-minimalist",
  "grand-classic",
  "imperial-serif",
  "italiana-serif",
]);
const PAYMENT_METHODS = new Set(["online_card", "pay_at_hotel"]);
const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const nullable =
  (validate: Validator): Validator =>
  (value) =>
    value === null || validate(value);
const text =
  (maxLength: number, pattern?: RegExp): Validator =>
  (value) =>
    typeof value === "string" && value.length <= maxLength && (!pattern || pattern.test(value));
const integer =
  (minimum: number, maximum: number): Validator =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
const decimalAmount = text(32, DECIMAL_AMOUNT_PATTERN);
const positiveDecimalAmount: Validator = (value) =>
  decimalAmount(value) && !/^0(?:\.0{1,2})?$/.test(value as string);
const opaqueId = text(128, OPAQUE_ID_PATTERN);
const token = text(80, TOKEN_PATTERN);

const FIELD_VALIDATORS = {
  "profile.default_locale": nullable(text(35, LANGUAGE_TAG_PATTERN)),
  "profile.short_description": nullable(text(2_000)),
  "profile.hero_image": nullable(opaqueId),
  "profile.gallery_images": nullable(list(opaqueId, 50, true)),
  "profile.amenities": nullable(list(token, 100, true)),
  "marketplace.preferences.compensation_types": nullable(
    list(enumValue(COMPENSATION_TYPES), COMPENSATION_TYPES.size, true),
  ),
  "marketplace.preferences.content_platforms": nullable(
    list(enumValue(CONTENT_PLATFORMS), CONTENT_PLATFORMS.size, true),
  ),
  "marketplace.preferences.content_types": nullable(
    list(enumValue(CONTENT_TYPES), CONTENT_TYPES.size, true),
  ),
  "marketplace.preferences.availability": nullable(isMarketplaceAvailability),
  // The canonical booking command checks membership in the supported accessible preset palette.
  "booking.primary_color": nullable(text(7, /^#[0-9A-Fa-f]{6}$/)),
  "booking.font_pairing": nullable(enumValue(FONT_PAIRINGS)),
  "room.name": nullable(entityMap(nullable(text(200)))),
  "room.category": nullable(entityMap(nullable(token))),
  "room.max_occupancy": nullable(entityMap(nullable(integer(1, 100)))),
  "room.max_adults": nullable(entityMap(nullable(integer(1, 100)))),
  "room.max_children": nullable(entityMap(nullable(integer(0, 100)))),
  "room.beds": nullable(entityMap(nullable(list(isBed, 20)))),
  "room.bedrooms": nullable(entityMap(nullable(integer(0, 100)))),
  "room.bathrooms": nullable(entityMap(nullable(number(Number.EPSILON, 100)))),
  "room.bathroom_type": nullable(entityMap(nullable(enumValue(new Set(["private", "shared"]))))),
  "room.size": nullable(entityMap(nullable(isRoomSize))),
  "room.description": nullable(entityMap(nullable(text(5_000)))),
  "room.unit_count": nullable(entityMap(nullable(integer(1, 500)))),
  "room.images": nullable(entityMap(nullable(list(opaqueId, 20, true)))),
  "room.amenities": nullable(entityMap(nullable(isReviewedAmenitySelection))),
  "rate.currency": nullable(text(3, /^[A-Z]{3}$/)),
  "rate.base_nightly_rate": nullable(entityMap(nullable(positiveDecimalAmount))),
  "rate.free_cancellation_deadline_days": nullable(integer(0, 365)),
  "rate.non_refundable_enabled": nullable(boolean),
  "rate.non_refundable_discount": nullable(integer(1, 50)),
  "rate.seasons": nullable(list(isSeason, 24)),
  "rate.seasonal_prices": nullable(entityMap(nullable(entityMap(nullable(positiveDecimalAmount))))),
  "rate.weekend_days": nullable(list(enumValue(WEEKDAYS), WEEKDAYS.size, true)),
  "rate.weekend_surcharge": nullable(entityMap(nullable(decimalAmount))),
  "rate.occupancy_prices": nullable(entityMap(nullable(isOccupancyPrice))),
  "rate.mandatory_charges_acknowledged": nullable(boolean),
  "rate.operating_periods": nullable(isOperatingCalendar),
  "rate.minimum_stay": nullable(integer(1, 366)),
  "rate.initial_availability": nullable(isInitialAvailability),
  "guest.default_language": nullable(text(35, LANGUAGE_TAG_PATTERN)),
  "guest.children_enabled": nullable(boolean),
  "guest.adult_age_threshold": nullable(integer(1, 21)),
  "guest.phone_required": nullable(boolean),
  "guest.arrival_time_enabled": nullable(boolean),
  "guest.special_requests_enabled": nullable(boolean),
  "policy.check_in_time": nullable(text(5, TIME_PATTERN)),
  "policy.check_out_time": nullable(text(5, TIME_PATTERN)),
  "policy.cancellation_bundle_confirmation": nullable(boolean),
  "payment.accepted_methods": nullable(
    list(enumValue(PAYMENT_METHODS), PAYMENT_METHODS.size, true),
  ),
} satisfies Record<PropertySetupFieldId, Validator>;

/**
 * Validates bounded resumable-draft shapes. Canonical owner commands still
 * validate completeness, references, server-owned vocabularies, and readiness.
 */
export function isPropertySetupDraftFieldValue(
  field: PropertySetupFieldId,
  value: unknown,
): value is JsonValue {
  if (!Object.hasOwn(FIELD_VALIDATORS, field)) {
    return false;
  }
  return FIELD_VALIDATORS[field](value);
}

function isMarketplaceAvailability(value: unknown): boolean {
  if (
    !closedObject(value, {
      mode: nullable(enumValue(new Set(["year_round", "selected_months"]))),
      months: list(integer(1, 12), 12, true),
    })
  ) {
    return false;
  }
  return value.mode !== "year_round" || !Array.isArray(value.months) || value.months.length === 0;
}

function isBed(value: unknown): boolean {
  return closedObject(value, {
    type: nullable(token),
    quantity: nullable(integer(1, 20)),
  });
}

function isRoomSize(value: unknown): boolean {
  return closedObject(value, {
    value: nullable(number(Number.EPSILON, 100_000)),
    unit: enumValue(new Set(["sqm"])),
  });
}

function isReviewedAmenitySelection(value: unknown): boolean {
  if (
    !closedObject(value, {
      keys: list(token, 100, true),
      reviewedEmpty: nullable(boolean),
    })
  ) {
    return false;
  }
  return value.reviewedEmpty !== true || !Array.isArray(value.keys) || value.keys.length === 0;
}

function isSeason(value: unknown): boolean {
  return closedObject(value, {
    id: nullable(opaqueId),
    name: nullable(text(120)),
    startMonthDay: nullable(isMonthDay),
    endMonthDay: nullable(isMonthDay),
  });
}

function isOccupancyPrice(value: unknown): boolean {
  return closedObject(value, {
    includedGuests: nullable(integer(1, 100)),
    additionalGuestAmount: nullable(decimalAmount),
  });
}

function isOperatingCalendar(value: unknown): boolean {
  if (
    !closedObject(value, {
      mode: nullable(enumValue(new Set(["year_round", "recurring"]))),
      periods: list(isOperatingPeriod, 12),
    })
  ) {
    return false;
  }
  return value.mode !== "year_round" || !Array.isArray(value.periods) || value.periods.length === 0;
}

function isOperatingPeriod(value: unknown): boolean {
  return closedObject(value, {
    startMonthDay: nullable(isMonthDay),
    endMonthDay: nullable(isMonthDay),
  });
}

function isInitialAvailability(value: unknown): boolean {
  return closedObject(value, {
    limits: nullable(entityMap(nullable(integer(1, 500)))),
    confirmed: nullable(boolean),
  });
}

function isMonthDay(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{2}-\d{2}$/.test(value)) return false;
  const [month, day] = value.split("-").map(Number);
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= daysInMonth[month! - 1]!;
}

function boolean(value: unknown): boolean {
  return typeof value === "boolean";
}

function number(minimum: number, maximum: number): Validator {
  return (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function enumValue(values: ReadonlySet<string>): Validator {
  return (value) => typeof value === "string" && values.has(value);
}

function list(validate: Validator, maximum: number, unique = false): Validator {
  return (value) =>
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(validate) &&
    (!unique || new Set(value).size === value.length);
}

function entityMap(validate: Validator): Validator {
  return (value) =>
    isPlainObject(value) &&
    Object.keys(value).length <= 500 &&
    Object.entries(value).every(([entityId, nested]) => opaqueId(entityId) && validate(nested));
}

function closedObject(
  value: unknown,
  fields: Readonly<Record<string, Validator>>,
): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    Object.keys(value).length <= Object.keys(fields).length &&
    Object.entries(value).every(
      ([key, nested]) => Object.hasOwn(fields, key) && fields[key]!(nested),
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
