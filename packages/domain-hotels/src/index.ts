/**
 * domain-hotels — Hotel catalog domain contracts.
 *
 * This package defines the canonical read models and commands for hotel
 * identity, slug, name, and shared property facts.  No other domain package
 * should read hotel identity directly from a Booking Engine or PMS database
 * pool.  Instead, they consume the read ports and read models exported here.
 *
 * Owner: Hotel catalog domain.
 * Migration note: canonical values are currently stored in `booking_hotels`
 * (name, slug, currency) and `pms.hotels` (stale copy).  After VAY-605
 * cutover the hotel catalog will be the single authoritative source.
 */

export * from "./adaptiveHotelSetup.js";
export * from "./hotelCatalogCurrentOwnerEvidence.js";
export * from "./hotelCatalogStep1.js";
export * from "./hotelMediaProjection.js";
export * from "./onboardingLifecycle.js";
export * from "./onboardingReadiness.js";
export * from "./platformPropertyLifecycle.js";
export * from "./propertyMedia.js";
export * from "./propertyMediaWire.js";
export * from "./propertySetupDraft.js";
export * from "./propertySetupDraftFieldValidation.js";
export * from "./propertySetupDraftRequest.js";
export * from "./propertySetupDraftRequestSafety.js";
export * from "./propertySetupDraftReset.js";
export * from "./propertySetupRoute.js";
export * from "./propertyProfile.js";
export * from "./propertyNearby.js";
export * from "./publicPropertyProfile.js";

// ---------------------------------------------------------------------------
// Scalar aliases
// ---------------------------------------------------------------------------

export type HotelId = string;
export type HotelSlug = string;
export type HotelUtcDateTime = string;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Setup completion fields tracked by the hotel catalog.
 *
 * Note: `currency` is intentionally omitted — property pricing currency is
 * owned by PMS operations. Setup wizards and onboarding flows consume its
 * read-only projection; Finance owns supported payment-currency capability,
 * not the property pricing-currency write.
 *
 * `payment` tracks binary setup completion (has at least one payment method
 * configured).  This flag is DERIVED from `@vayada/domain-finance`
 * (PaymentSettingsReadPort.getPaymentSettings → enabledPaymentMethods.length >
 * 0) — it is not a data field owned by the hotel catalog.  The catalog stores
 * only the boolean completion status; the authoritative list of enabled
 * payment methods lives in the Finance domain.
 */
export const HOTEL_CATALOG_SETUP_FIELDS = [
  "name",
  "slug",
  "timezone",
  "address",
  "description",
  "images",
  "policies",
  "payment",
] as const;

export type HotelCatalogSetupField = (typeof HOTEL_CATALOG_SETUP_FIELDS)[number];

export const HOTEL_ACTIVE_STATUSES = ["active", "suspended", "archived"] as const;

export type HotelActiveStatus = (typeof HOTEL_ACTIVE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Shared property profile catalog
// ---------------------------------------------------------------------------

export const SHARED_PROPERTY_TYPE_OPTIONS = [
  { value: "hotel", label: "Hotel" },
  { value: "resort", label: "Resort" },
  { value: "hostel", label: "Hostel" },
  { value: "apartment", label: "Apartment" },
  { value: "aparthotel", label: "Aparthotel" },
  { value: "guesthouse", label: "Guesthouse" },
  { value: "bed_and_breakfast", label: "Bed and breakfast" },
  { value: "villa", label: "Villa" },
  { value: "vacation_rental", label: "Vacation rental" },
  { value: "motel", label: "Motel" },
  { value: "other", label: "Other" },
] as const;

export type SharedPropertyTypeOption = (typeof SHARED_PROPERTY_TYPE_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Hotel identity read model
//
// Replaces all PMS reads from `booking_hotels.name`, `booking_hotels.slug`,
// and the stale `pms.hotels` copy.  This is a safe, cross-domain read model;
// it does not include financial data, payment credentials, or payout details.
// ---------------------------------------------------------------------------

export type HotelLocation = {
  address?: string | null;
  city?: string | null;
  region?: string | null;
  country: string;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type HotelIdentityReadModel = {
  /** Internal hotel ID shared across PMS, booking, and marketplace. */
  propertyId: HotelId;
  /** URL-safe slug — authoritative in the hotel catalog. */
  slug: HotelSlug;
  /** Display name — authoritative in the hotel catalog. */
  name: string;
  /** IANA timezone identifier, e.g. "Europe/Berlin". */
  timezone: string;
  /** BCP 47 locale, e.g. "en". */
  defaultLocale: string;
  location: HotelLocation;
  status: HotelActiveStatus;
  /** ISO 8601 timestamp of last catalog update. */
  updatedAt: HotelUtcDateTime;
};

// ---------------------------------------------------------------------------
// Guest policy read port
//
// Read port for guest-visible booking terms and cancellation policy.
// Owned by the Booking domain; consumed by PMS checkout flows without direct
// Booking DB access.
//
// Disposition note (VAY-652 / VAY-655): terms_text and
// cancellation_policy_text currently live in `booking_hotels` (Booking DB).
// Serving them through this port decouples PMS from the Booking DB without
// requiring an immediate data migration.  The authoritative move to a
// dedicated Booking-domain table is deferred to the C01 removal slice
// (VAY-655).
// ---------------------------------------------------------------------------

/**
 * Read port for guest-visible booking terms and cancellation policy.
 * Owned by the Booking domain; consumed by PMS checkout flows without direct
 * Booking DB access.
 */
export type GuestPolicyReadPort = {
  getGuestPolicy(
    propertyId: HotelId,
  ): Promise<{ termsText: string | null; cancellationPolicyText: string | null }>;
};

// ---------------------------------------------------------------------------
// Hotel catalog read port
//
// TypeScript PMS code must use this port instead of opening a
// BookingEngineDatabase pool to read hotel identity fields.
// ---------------------------------------------------------------------------

export type HotelIdentityReadPort = {
  /**
   * Look up a hotel by its internal property ID.
   * Returns null when the property is unknown or archived.
   */
  getByPropertyId(propertyId: HotelId): Promise<HotelIdentityReadModel | null>;

  /**
   * Look up a hotel by slug.
   * Returns null when the slug is unknown or the property is archived.
   */
  getBySlug(slug: HotelSlug): Promise<HotelIdentityReadModel | null>;

  /**
   * Resolve a batch of property IDs to identity read models.
   * Unknown IDs are omitted from the result map.
   */
  batchGetByPropertyId(
    propertyIds: readonly HotelId[],
  ): Promise<Map<HotelId, HotelIdentityReadModel>>;
};

// ---------------------------------------------------------------------------
// Hotel catalog command types
//
// These replace direct writes to `booking_hotels` from PMS-side admin flows.
// Each command has an explicit idempotency key and audit trail so cross-domain
// writes remain traceable.
// ---------------------------------------------------------------------------

export type HotelCatalogCommandActor =
  | { kind: "user"; userId: string; organizationId: string }
  | { kind: "system"; service: string }
  | { kind: "migration"; runId: string };

export type HotelCatalogCommandAudit = {
  actor: HotelCatalogCommandActor;
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: HotelUtcDateTime;
};

export type HotelCatalogCommandBase<TCommandType extends string, TPayload> = {
  commandType: TCommandType;
  commandId: string;
  idempotencyKey: string;
  propertyId: HotelId;
  audit: HotelCatalogCommandAudit;
  payload: TPayload;
};

/** Update the canonical hotel name. Owner: hotel catalog. */
export type UpdateHotelNamePayload = {
  name: string;
};

export type UpdateHotelNameCommand = HotelCatalogCommandBase<
  "hotel.catalog.name.update",
  UpdateHotelNamePayload
>;

/** Update the canonical hotel slug. Owner: hotel catalog. */
export type UpdateHotelSlugPayload = {
  slug: HotelSlug;
  /** Previous slug for redirect/audit purposes. */
  previousSlug?: HotelSlug;
};

export type UpdateHotelSlugCommand = HotelCatalogCommandBase<
  "hotel.catalog.slug.update",
  UpdateHotelSlugPayload
>;

export type HotelCatalogCommand = UpdateHotelNameCommand | UpdateHotelSlugCommand;

export const hotelCatalogCommandTypes = [
  "hotel.catalog.name.update",
  "hotel.catalog.slug.update",
] as const satisfies readonly HotelCatalogCommand["commandType"][];

export type HotelCatalogCommandType = (typeof hotelCatalogCommandTypes)[number];

// ---------------------------------------------------------------------------
// Hotel catalog command bus interface
// ---------------------------------------------------------------------------

export type HotelCatalogCommandResult = {
  status: "accepted" | "idempotent_replay";
  commandId: string;
  idempotencyKey: string;
  propertyId: HotelId;
};

export interface HotelCatalogCommandBus {
  execute(command: HotelCatalogCommand): Promise<HotelCatalogCommandResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable idempotency key for hotel catalog commands.
 * Format: `<commandType>:property:<propertyId>:<suffix>`.
 *
 * Example: `hotel.catalog.name.update:property:prop_abc123:admin-rename-2026-06`
 */
export function hotelCatalogIdempotencyKey(
  commandType: HotelCatalogCommandType,
  propertyId: HotelId,
  suffix: string,
): string {
  const trimmedSuffix = suffix.trim();
  if (trimmedSuffix.length === 0) {
    throw new Error("hotelCatalogIdempotencyKey: suffix must not be empty or blank");
  }
  return `${commandType}:property:${propertyId}:${trimmedSuffix}`;
}

export type {
  PlatformMarketplaceAccount,
  PlatformMarketplaceAccountsResponse,
} from "./platformMarketplaceActivation.js";

export * from "./nearbyView.js";
