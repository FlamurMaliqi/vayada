import type { SourceEntityRevision } from "@vayada/domain-hotels";
import type { PmsPricingSourceEntityRevision } from "@vayada/domain-pms";

import type { BookingPricingSourceFingerprint } from "./bookingPricingEvidence.js";

export const BOOKING_GUEST_POLICY_CONTRACT_VERSION = "booking-guest-policy.v1" as const;
export const BOOKING_GUEST_POLICY_SOURCE_ENTITY_TYPE = "guest_policy_revision" as const;
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
  }
>;

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
    !localTime(value.checkOutTime)
  ) {
    return null;
  }
  return deepFreeze({ ...value }) as BookingGuestPolicyChoices;
}

export function parseBookingGuestPolicyHash(value: unknown): BookingGuestPolicyHash | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
    ? (value as BookingGuestPolicyHash)
    : null;
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

function age(value: unknown, required: boolean): boolean {
  return value === null
    ? !required
    : Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 21;
}

function localTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
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
