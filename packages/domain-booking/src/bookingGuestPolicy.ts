import type { SourceEntityRevision } from "@vayada/domain-hotels";
import type { PmsPricingSourceEntityRevision } from "@vayada/domain-pms";

import type { BookingPricingSourceFingerprint } from "./bookingPricingEvidence.js";

export const BOOKING_GUEST_POLICY_CONTRACT_VERSION = "booking-guest-policy.v1" as const;
export const BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE = "guest_policy_revision" as const;
export const BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION = "guest-policy:absent" as const;
export const BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE = "booking.guest_policy.changed" as const;
export const BOOKING_GUEST_POLICY_OUTBOX_DESTINATION = "hotel-catalog.public-policy" as const;
export const BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES = Object.freeze([
  "en",
  "de",
  "fr",
  "es",
  "id",
  "nl",
] as const);
export const BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS = Object.freeze({
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
} as const);

export type BookingGuestLanguage = (typeof BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES)[number];
export type BookingGuestPolicyHash = `sha256:${string}`;
export type BookingGuestPolicySourceBinding = Readonly<SourceEntityRevision>;
export type BookingGuestPolicySourceRevision = Readonly<
  SourceEntityRevision & {
    ownerDomain: "booking";
    entityType: typeof BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE;
    revision: `guest-policy:${number}`;
  }
>;
export type BookingGuestPolicyAbsentSourceRevision = Readonly<
  SourceEntityRevision & {
    ownerDomain: "booking";
    entityType: typeof BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE;
    revision: typeof BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION;
  }
>;
export type BookingGuestPolicyCurrentSourceRevision =
  | BookingGuestPolicySourceRevision
  | BookingGuestPolicyAbsentSourceRevision;

export type BookingGuestPolicyChoices = Readonly<{
  defaultGuestLanguage: BookingGuestLanguage;
  childrenEnabled: boolean;
  /** Preserved while children are disabled; required when they are enabled. */
  adultAgeThreshold: number | null;
  phoneRequired: boolean;
  arrivalTimeEnabled: boolean;
  specialRequestsEnabled: boolean;
  checkInTime: string;
  checkOutTime: string;
  /** Optional same-day check-in deadline; omission preserves historical from-only policies. */
  checkInUntil?: string;
  /** Optional same-day check-out start; omission preserves historical by-only policies. */
  checkOutFrom?: string;
}>;

export type BookingGuestPolicyCatalogProfileEvidence = Readonly<{
  source: Readonly<
    Omit<SourceEntityRevision, "ownerDomain" | "entityType"> & {
      ownerDomain: "hotel_catalog";
      entityType: "property_profile";
    }
  >;
  timeZone: string;
}>;

export type BookingGuestPolicyCatalogProfileEvidenceResult =
  | Readonly<{ outcome: "available"; evidence: BookingGuestPolicyCatalogProfileEvidence }>
  | Readonly<{
      outcome: "timezone_missing" | "timezone_invalid";
      source: BookingGuestPolicyCatalogProfileEvidence["source"];
    }>
  | Readonly<{ outcome: "unavailable"; errorSource: "provider" | "system" }>
  | Readonly<{ outcome: "malformed" }>;

export type BookingGuestPolicyRecurringSourceBinding = Readonly<{
  source: PmsPricingSourceEntityRevision;
  validationRevision: number;
  materializationRevision: number;
}>;

export type BookingGuestPolicyRateDisclosure = Readonly<{
  roomTypeId: string;
  roomFactsRevision: number;
  flexible: Readonly<{
    source: PmsPricingSourceEntityRevision;
    freeCancellationDeadlineDays: number;
    cutoff: Readonly<{ localTime: string; timeZone: string }>;
    afterDeadlinePenalty: "full_booking_amount";
    noShowPenalty: "full_booking_amount";
  }>;
  nonRefundable: Readonly<{
    source: BookingGuestPolicyRecurringSourceBinding;
    refundPolicy: "no_refund";
    noShowPenalty: "full_booking_amount";
    paymentTiming: "prepay_full";
  }> | null;
  additionalGuest: Readonly<{
    source: BookingGuestPolicyRecurringSourceBinding;
    includedGuestsPerRoom: number;
    amountDecimal: string;
    currency: string;
    countedGuestTypes: readonly ["adult"] | readonly ["adult", "child"];
  }> | null;
}>;

export type BookingGuestPolicyBundle = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  choices: BookingGuestPolicyChoices;
  pricingCurrency: string;
  propertyTimeZone: string;
  pricingSourceFingerprint: BookingPricingSourceFingerprint;
  mandatoryChargeConfirmationRevision: number;
  sourceBindings: readonly BookingGuestPolicySourceBinding[];
  sourceFingerprint: BookingGuestPolicyHash;
  rates: readonly BookingGuestPolicyRateDisclosure[];
  bundleHash: BookingGuestPolicyHash;
}>;

export type BookingGuestPolicyCompositionBlocker = Readonly<{
  code:
    | "pricing_source_invalid"
    | "pricing_source_missing"
    | "pricing_currency_mismatch"
    | "property_timezone_missing"
    | "property_timezone_invalid"
    | "property_profile_unavailable"
    | "property_profile_malformed"
    | "room_capacity_missing"
    | "room_capacity_invalid"
    | "child_policy_capacity_incompatible"
    | "mandatory_charge_confirmation_missing"
    | "mandatory_charge_confirmation_unavailable"
    | "mandatory_charge_confirmation_malformed"
    | "mandatory_charge_confirmation_stale"
    | "flexible_rate_policy_missing"
    | "optional_rate_policy_invalid";
  roomTypeId?: string;
  sourceId?: string;
}>;

export type BookingGuestPolicyComposition =
  | Readonly<{ outcome: "ready"; bundle: BookingGuestPolicyBundle }>
  | Readonly<{
      outcome: "blocked";
      organizationId: string;
      propertyId: string;
      sourceBindings: readonly BookingGuestPolicySourceBinding[];
      sourceFingerprint: BookingGuestPolicyHash;
      blockers: readonly BookingGuestPolicyCompositionBlocker[];
    }>;

export function parseBookingGuestPolicyChoices(value: unknown): BookingGuestPolicyChoices | null {
  if (
    !exact(value, [
      "defaultGuestLanguage",
      "childrenEnabled",
      "adultAgeThreshold",
      "phoneRequired",
      "arrivalTimeEnabled",
      "specialRequestsEnabled",
      "checkInTime",
      "checkOutTime",
      ...bookingArrivalBoundKeys(value),
    ]) ||
    !BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES.includes(
      value.defaultGuestLanguage as BookingGuestLanguage,
    ) ||
    typeof value.childrenEnabled !== "boolean" ||
    !age(value.adultAgeThreshold, value.childrenEnabled) ||
    typeof value.phoneRequired !== "boolean" ||
    typeof value.arrivalTimeEnabled !== "boolean" ||
    typeof value.specialRequestsEnabled !== "boolean" ||
    !localTime(value.checkInTime) ||
    !localTime(value.checkOutTime) ||
    bookingArrivalTimeErrors(value).length > 0
  ) {
    return null;
  }
  return deepFreeze({ ...value }) as BookingGuestPolicyChoices;
}

/** Only explicitly present bounds participate in historical bundle hashes. */
export function bookingArrivalBoundKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return ["checkInUntil", "checkOutFrom"].filter((key) => Object.hasOwn(value, key));
}

export function bookingArrivalBounds(
  value: Pick<BookingGuestPolicyChoices, "checkInUntil" | "checkOutFrom">,
) {
  return {
    ...(Object.hasOwn(value, "checkInUntil") ? { checkInUntil: value.checkInUntil } : {}),
    ...(Object.hasOwn(value, "checkOutFrom") ? { checkOutFrom: value.checkOutFrom } : {}),
  };
}

/** Check-in and check-out occur on different dates: compare only within each window. */
export function bookingArrivalTimeErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["checkInTime", "checkOutTime", ...bookingArrivalBoundKeys(value)]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !localTime(descriptor.value)) {
      errors.push(`${key} must be a local time in HH:MM format (00:00–23:59).`);
    }
  }
  if (errors.length) return errors;
  if (typeof value.checkInUntil === "string" && value.checkInUntil <= String(value.checkInTime)) {
    errors.push("Check-in until must be later than check-in from on the same day.");
  }
  if (typeof value.checkOutFrom === "string" && value.checkOutFrom >= String(value.checkOutTime)) {
    errors.push("Check-out from must be earlier than check-out by on the same day.");
  }
  return errors;
}

export function parseBookingGuestPolicyHash(value: unknown): BookingGuestPolicyHash | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
    ? (value as BookingGuestPolicyHash)
    : null;
}

export function parseBookingGuestPolicyCatalogProfileEvidenceResult(
  value: unknown,
  propertyId: string,
): BookingGuestPolicyCatalogProfileEvidenceResult | null {
  if (!uuid(propertyId) || !exact(value, ["outcome", ...catalogResultKeys(value)])) return null;
  if (value.outcome === "malformed") return Object.freeze({ outcome: "malformed" });
  if (value.outcome === "unavailable") {
    return value.errorSource === "provider" || value.errorSource === "system"
      ? Object.freeze({ outcome: "unavailable", errorSource: value.errorSource })
      : null;
  }
  let evidence: Record<string, unknown> | null = null;
  let sourceValue: unknown;
  if (value.outcome === "available") {
    if (!exact(value.evidence, ["source", "timeZone"])) return null;
    evidence = value.evidence;
    sourceValue = evidence.source;
  } else {
    sourceValue = value.source;
  }
  if (
    (value.outcome !== "available" &&
      value.outcome !== "timezone_missing" &&
      value.outcome !== "timezone_invalid") ||
    !exact(sourceValue, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    sourceValue.ownerDomain !== "hotel_catalog" ||
    sourceValue.entityType !== "property_profile" ||
    sourceValue.entityId !== propertyId.toLowerCase() ||
    typeof sourceValue.revision !== "string" ||
    !/^profile:[1-9][0-9]*$/.test(sourceValue.revision)
  )
    return null;
  const source = Object.freeze({
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: sourceValue.entityId,
    revision: sourceValue.revision,
  });
  if (!evidence) {
    if (value.outcome === "timezone_missing")
      return Object.freeze({ outcome: "timezone_missing", source });
    if (value.outcome === "timezone_invalid")
      return Object.freeze({ outcome: "timezone_invalid", source });
    return null;
  }
  if (typeof evidence.timeZone !== "string" || !timeZone(evidence.timeZone)) return null;
  return deepFreeze({
    outcome: "available",
    evidence: { source, timeZone: evidence.timeZone },
  });
}

export function createBookingGuestPolicySourceRevision(
  propertyId: string,
  revision: number,
): BookingGuestPolicySourceRevision {
  if (!uuid(propertyId) || !positiveRevision(revision)) {
    throw new TypeError("Booking guest-policy source revision is invalid");
  }
  return Object.freeze({
    ownerDomain: "booking",
    entityType: BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE,
    entityId: propertyId.toLowerCase(),
    revision: `guest-policy:${revision}`,
  });
}

export function createBookingGuestPolicyAbsentSourceRevision(
  propertyId: string,
): BookingGuestPolicyAbsentSourceRevision {
  if (!uuid(propertyId)) {
    throw new TypeError("Booking guest-policy absent source revision is invalid");
  }
  return Object.freeze({
    ownerDomain: "booking",
    entityType: BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE,
    entityId: propertyId.toLowerCase(),
    revision: BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION,
  });
}

export function parseBookingGuestPolicyCurrentSourceRevision(
  value: unknown,
  expectedPropertyId: string,
): BookingGuestPolicyCurrentSourceRevision | null {
  if (
    !uuid(expectedPropertyId) ||
    !exact(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    value.ownerDomain !== "booking" ||
    value.entityType !== BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE ||
    typeof value.entityId !== "string" ||
    value.entityId !== expectedPropertyId.toLowerCase() ||
    typeof value.revision !== "string"
  )
    return null;
  if (value.revision === BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION) {
    return createBookingGuestPolicyAbsentSourceRevision(expectedPropertyId);
  }
  const match = /^guest-policy:([1-9][0-9]*)$/.exec(value.revision);
  if (!match) return null;
  const revision = Number(match[1]);
  return positiveRevision(revision)
    ? createBookingGuestPolicySourceRevision(expectedPropertyId, revision)
    : null;
}

function age(value: unknown, required: boolean): boolean {
  return value === null
    ? !required
    : Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 21;
}

function localTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function catalogResultKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const outcome = Object.getOwnPropertyDescriptor(value, "outcome")?.value;
  if (outcome === "malformed") return [];
  if (outcome === "unavailable") return ["errorSource"];
  if (outcome === "available") return ["evidence"];
  if (outcome === "timezone_missing" || outcome === "timezone_invalid") return ["source"];
  return [];
}

function timeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value.length > 0;
  } catch {
    return false;
  }
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
