import type { BookingGuestPolicyCurrentSourceRevision } from "./bookingGuestPolicy.js";

export const BOOKING_GUEST_POLICY_CURRENT_BASE_REVISION_KEYS = Object.freeze([
  "booking.guest_experience",
  "pms.pricing_settings",
  "pms.rate_plans",
  "pms.room_types",
  "hotel_catalog.location",
  "hotel_catalog.policy",
] as const);

export type BookingGuestPolicyCurrentBaseRevisionKey =
  (typeof BOOKING_GUEST_POLICY_CURRENT_BASE_REVISION_KEYS)[number];

export type BookingGuestPolicyCurrentBaseRevisions = Readonly<{
  "booking.guest_experience": BookingGuestPolicyCurrentSourceRevision["revision"];
  "pms.pricing_settings": string;
  "pms.rate_plans": string;
  "pms.room_types": string;
  "hotel_catalog.location": string;
  "hotel_catalog.policy": string;
}>;

export type BookingGuestPolicyPmsCurrentBaseRevisions = Readonly<
  Pick<
    BookingGuestPolicyCurrentBaseRevisions,
    "pms.pricing_settings" | "pms.rate_plans" | "pms.room_types"
  >
>;

export type BookingGuestPolicyCatalogCurrentBaseRevisions = Readonly<
  Pick<BookingGuestPolicyCurrentBaseRevisions, "hotel_catalog.location" | "hotel_catalog.policy">
>;

export type BookingGuestPolicyCurrentOwnerEvidenceScope = Readonly<{
  organizationId: string;
  propertyId: string;
}>;

export type BookingGuestPolicyOwnerBaseRevisionEvidence<
  Revisions extends Readonly<Record<string, string>>,
> = Readonly<{
  organizationId: string;
  propertyId: string;
  revisions: Revisions;
}>;

export type BookingGuestPolicyOwnerBaseRevisionEvidenceResult<
  Revisions extends Readonly<Record<string, string>>,
> =
  | Readonly<{
      outcome: "available";
      evidence: BookingGuestPolicyOwnerBaseRevisionEvidence<Revisions>;
    }>
  | Readonly<{ outcome: "missing" }>
  | Readonly<{ outcome: "unavailable"; errorSource: "provider" | "system" }>
  | Readonly<{ outcome: "malformed" }>;

export interface BookingGuestPolicyPmsCurrentOwnerEvidencePort {
  readonly bookingGuestPolicyCurrentOwnerEvidencePort: "pms";
  getCurrentGuestPolicyBaseRevisions(
    scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
  ): Promise<
    BookingGuestPolicyOwnerBaseRevisionEvidenceResult<BookingGuestPolicyPmsCurrentBaseRevisions>
  >;
}

export interface BookingGuestPolicyCatalogCurrentOwnerEvidencePort {
  readonly bookingGuestPolicyCurrentOwnerEvidencePort: "hotel_catalog";
  getCurrentGuestPolicyBaseRevisions(
    scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
  ): Promise<
    BookingGuestPolicyOwnerBaseRevisionEvidenceResult<BookingGuestPolicyCatalogCurrentBaseRevisions>
  >;
}

export type BookingGuestPolicyCurrentOwnerEvidenceFailure =
  | Readonly<{
      owner: "booking" | "pms" | "hotel_catalog";
      outcome: "missing" | "malformed";
    }>
  | Readonly<{
      owner: "booking" | "pms" | "hotel_catalog";
      outcome: "unavailable";
      errorSource: "provider" | "system";
    }>;

export type BookingGuestPolicyCurrentOwnerEvidenceResult =
  | Readonly<{
      outcome: "available";
      organizationId: string;
      propertyId: string;
      currentBaseRevisions: BookingGuestPolicyCurrentBaseRevisions;
    }>
  | Readonly<{
      outcome: "unavailable";
      organizationId: string;
      propertyId: string;
      failures: readonly BookingGuestPolicyCurrentOwnerEvidenceFailure[];
    }>;

export interface BookingGuestPolicyCurrentOwnerEvidencePort {
  getCurrentGuestPolicyOwnerEvidence(
    scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
  ): Promise<BookingGuestPolicyCurrentOwnerEvidenceResult>;
}

export function parseBookingGuestPolicyCurrentOwnerEvidenceScope(
  value: unknown,
): BookingGuestPolicyCurrentOwnerEvidenceScope | null {
  if (
    !exactDataRecord(value, ["organizationId", "propertyId"]) ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId)
  )
    return null;
  return Object.freeze({
    organizationId: value.organizationId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
  });
}

export function parseBookingGuestPolicyPmsCurrentOwnerEvidence(
  value: unknown,
  scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
): BookingGuestPolicyOwnerBaseRevisionEvidenceResult<BookingGuestPolicyPmsCurrentBaseRevisions> | null {
  return parseOwnerResult(value, scope, [
    "pms.pricing_settings",
    "pms.rate_plans",
    "pms.room_types",
  ]);
}

export function parseBookingGuestPolicyCatalogCurrentOwnerEvidence(
  value: unknown,
  scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
): BookingGuestPolicyOwnerBaseRevisionEvidenceResult<BookingGuestPolicyCatalogCurrentBaseRevisions> | null {
  return parseOwnerResult(value, scope, ["hotel_catalog.location", "hotel_catalog.policy"]);
}

function parseOwnerResult<Revisions extends Readonly<Record<string, string>>>(
  value: unknown,
  scope: BookingGuestPolicyCurrentOwnerEvidenceScope,
  revisionKeys: readonly string[],
): BookingGuestPolicyOwnerBaseRevisionEvidenceResult<Revisions> | null {
  if (!dataRecord(value)) return null;
  if (value.outcome === "missing" || value.outcome === "malformed") {
    return exactDataRecord(value, ["outcome"])
      ? (Object.freeze({
          outcome: value.outcome,
        }) as BookingGuestPolicyOwnerBaseRevisionEvidenceResult<Revisions>)
      : null;
  }
  if (value.outcome === "unavailable") {
    return exactDataRecord(value, ["outcome", "errorSource"]) &&
      (value.errorSource === "provider" || value.errorSource === "system")
      ? Object.freeze({ outcome: "unavailable", errorSource: value.errorSource })
      : null;
  }
  if (
    value.outcome !== "available" ||
    !exactDataRecord(value, ["outcome", "evidence"]) ||
    !exactDataRecord(value.evidence, ["organizationId", "propertyId", "revisions"]) ||
    value.evidence.organizationId !== scope.organizationId ||
    value.evidence.propertyId !== scope.propertyId ||
    !exactDataRecord(value.evidence.revisions, revisionKeys) ||
    !Object.values(value.evidence.revisions).every(baseRevision)
  )
    return null;
  const revisions = value.evidence.revisions;
  return Object.freeze({
    outcome: "available",
    evidence: Object.freeze({
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      revisions: Object.freeze(
        Object.fromEntries(revisionKeys.map((key) => [key, revisions[key]])),
      ) as Revisions,
    }),
  });
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!dataRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  return (
    names.length === keys.length &&
    names.every((name) => keys.includes(name)) &&
    Object.values(descriptors).every(
      (descriptor) => "value" in descriptor && descriptor.enumerable === true,
    )
  );
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function baseRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
