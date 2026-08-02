import type {
  ProductReadinessResult,
  ReadinessErrorSource,
  ReadinessProviderFailure,
  SourceEntityRevision,
} from "@vayada/domain-hotels";

export const BOOKING_LAUNCH_READINESS_GROUPS = [
  {
    groupId: "booking.hotel_profile",
    owningStepId: "present_hotel",
    port: "catalog",
    entityOwnerDomain: "hotel_catalog",
  },
  {
    groupId: "booking.page_style",
    owningStepId: "booking_design",
    port: "booking",
    entityOwnerDomain: "booking",
  },
  {
    groupId: "booking.rooms",
    owningStepId: "rooms",
    port: "pms",
    entityOwnerDomain: "pms",
  },
  {
    groupId: "booking.pricing",
    owningStepId: "pricing",
    port: "pms",
    entityOwnerDomain: "pms",
  },
  {
    groupId: "booking.calendar",
    owningStepId: "calendar",
    port: "pms",
    entityOwnerDomain: "pms",
  },
  {
    groupId: "booking.guest_experience",
    owningStepId: "guest_experience",
    port: "booking",
    entityOwnerDomain: "booking",
  },
  {
    groupId: "booking.payments",
    owningStepId: "payments",
    port: "finance",
    entityOwnerDomain: "finance",
  },
] as const;

export const BOOKING_LAUNCH_SOURCE_DOMAIN_BY_PORT = {
  catalog: "hotel_catalog",
  booking: "booking",
  pms: "pms",
  finance: "finance",
} as const;

/** Booking-composer provenance only. Publication builders must not resolve it as content. */
export const BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE =
  "booking_launch_dependency_set.v1" as const;

type BookingLaunchReadinessGroupSpec = (typeof BOOKING_LAUNCH_READINESS_GROUPS)[number];

export type BookingLaunchReadinessPortKey = BookingLaunchReadinessGroupSpec["port"];
export type BookingLaunchReadinessGroupId = BookingLaunchReadinessGroupSpec["groupId"];
export type BookingLaunchReadinessGroupIdForPort<Port extends BookingLaunchReadinessPortKey> =
  Extract<BookingLaunchReadinessGroupSpec, { port: Port }>["groupId"];
export type BookingLaunchOwningStepIdForGroup<Group extends BookingLaunchReadinessGroupId> =
  Extract<BookingLaunchReadinessGroupSpec, { groupId: Group }>["owningStepId"];
export type BookingLaunchEntityOwnerDomainForGroup<Group extends BookingLaunchReadinessGroupId> =
  Extract<BookingLaunchReadinessGroupSpec, { groupId: Group }>["entityOwnerDomain"];
export type BookingLaunchSourceOwnerDomainForPort<Port extends BookingLaunchReadinessPortKey> =
  (typeof BOOKING_LAUNCH_SOURCE_DOMAIN_BY_PORT)[Port];
export type BookingLaunchSourceOwnerDomain =
  BookingLaunchSourceOwnerDomainForPort<BookingLaunchReadinessPortKey>;
export type BookingLaunchSourceRevision = Omit<SourceEntityRevision, "ownerDomain"> & {
  ownerDomain: BookingLaunchSourceOwnerDomain;
};

export type BookingLaunchReadinessRequest = Readonly<{
  organizationId: string;
  propertyId: string;
}>;

type OwnerCodeBase = Readonly<{
  code: string;
}>;

export type BookingLaunchOwnerBlocker =
  | (OwnerCodeBase & {
      scope: "launch_configuration";
      kind: "user_fixable" | "external_pending";
    })
  | (OwnerCodeBase & {
      scope: "launch_configuration";
      kind: "system_error";
      errorSource: ReadinessErrorSource;
    });

/** Explicitly non-blocking input. Its runtime contents are ignored, never validated or copied. */
export type BookingLaunchOwnerAdvisory = Readonly<{
  code: string;
  safeMessage?: string;
  scope: "temporary_availability" | "recommendation" | "optional_external_pending";
}>;

export type BookingLaunchSourceBinding = Readonly<{
  expectedSource: BookingLaunchSourceRevision;
  mismatchBlocker: BookingLaunchOwnerBlocker;
}>;

type EntityContributionByGroup = {
  [Group in BookingLaunchReadinessGroupId]: Readonly<{
    groupId: Group;
    owningStepId: BookingLaunchOwningStepIdForGroup<Group>;
    source: Omit<SourceEntityRevision, "ownerDomain"> & {
      ownerDomain: BookingLaunchEntityOwnerDomainForGroup<Group>;
    };
    blockers: readonly BookingLaunchOwnerBlocker[];
    /** Operational availability and recommendations are accepted only as non-blocking inputs. */
    advisories?: readonly BookingLaunchOwnerAdvisory[];
    /**
     * Cross-owner revisions consumed by this contribution. Booking fingerprints this exact set
     * into the source manifest so a changed dependency graph invalidates accepted work.
     */
    bindings?: readonly BookingLaunchSourceBinding[];
  }>;
};

export type BookingLaunchReadinessEntityContribution<
  Port extends BookingLaunchReadinessPortKey = BookingLaunchReadinessPortKey,
> = EntityContributionByGroup[BookingLaunchReadinessGroupIdForPort<Port>];

type OwnerSourceForPort<Port extends BookingLaunchReadinessPortKey> = Omit<
  SourceEntityRevision,
  "ownerDomain"
> & {
  ownerDomain: BookingLaunchSourceOwnerDomainForPort<Port>;
};

export type BookingLaunchOwnerEvidence<
  Port extends BookingLaunchReadinessPortKey = BookingLaunchReadinessPortKey,
> = Port extends BookingLaunchReadinessPortKey
  ? Readonly<{
      outcome: "evidence";
      port: Port;
      organizationId: string;
      propertyId: string;
      /** Current authoritative, publication-relevant sources owned by this port. */
      sources: readonly OwnerSourceForPort<Port>[];
      entities: readonly BookingLaunchReadinessEntityContribution<Port>[];
    }>
  : never;

export type BookingLaunchOwnerUnavailable<
  Port extends BookingLaunchReadinessPortKey = BookingLaunchReadinessPortKey,
> = Port extends BookingLaunchReadinessPortKey
  ? Readonly<{
      outcome: "unavailable";
      port: Port;
      errorSource: ReadinessErrorSource;
    }>
  : never;

export type BookingLaunchOwnerEvidenceResult<
  Port extends BookingLaunchReadinessPortKey = BookingLaunchReadinessPortKey,
> = BookingLaunchOwnerEvidence<Port> | BookingLaunchOwnerUnavailable<Port>;

interface BookingLaunchEvidencePort<Port extends BookingLaunchReadinessPortKey> {
  /** Literal owner identity prevents structurally identical ports from being interchanged. */
  readonly bookingLaunchEvidencePort: Port;
  getBookingLaunchEvidence(
    request: BookingLaunchReadinessRequest,
  ): Promise<BookingLaunchOwnerEvidenceResult<Port>>;
}

export interface BookingLaunchCatalogEvidencePort extends BookingLaunchEvidencePort<"catalog"> {}
export interface BookingLaunchConfigurationEvidencePort extends BookingLaunchEvidencePort<"booking"> {}
export interface BookingLaunchPmsEvidencePort extends BookingLaunchEvidencePort<"pms"> {}
export interface BookingLaunchFinanceEvidencePort extends BookingLaunchEvidencePort<"finance"> {}

export interface BookingLaunchReadinessProviderPort {
  /** Launch gating only; owning step IDs route blockers and never represent setup progress. */
  getBookingReadiness(
    request: BookingLaunchReadinessRequest,
  ): Promise<ProductReadinessResult | ReadinessProviderFailure>;
}

const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/;
const READINESS_SOURCE_DOMAINS = new Set(["hotel_catalog", "booking", "pms", "finance"]);
const READINESS_ERROR_SOURCES = new Set(["provider", "system"]);

export function isBookingLaunchReadinessRequestValid(
  value: unknown,
): value is BookingLaunchReadinessRequest {
  return isRecord(value) && nonEmpty(value["organizationId"]) && nonEmpty(value["propertyId"]);
}

export function isBookingLaunchOwnerUnavailable<Port extends BookingLaunchReadinessPortKey>(
  value: unknown,
  port: Port,
): value is BookingLaunchOwnerUnavailable<Port> {
  return (
    isRecord(value) &&
    value["outcome"] === "unavailable" &&
    value["port"] === port &&
    typeof value["errorSource"] === "string" &&
    READINESS_ERROR_SOURCES.has(value["errorSource"])
  );
}

export function isBookingLaunchOwnerEvidenceValid<Port extends BookingLaunchReadinessPortKey>(
  value: unknown,
  request: BookingLaunchReadinessRequest,
  port: Port,
): value is BookingLaunchOwnerEvidence<Port> {
  if (
    !isRecord(value) ||
    value["outcome"] !== "evidence" ||
    value["port"] !== port ||
    value["organizationId"] !== request.organizationId ||
    value["propertyId"] !== request.propertyId ||
    !Array.isArray(value["sources"]) ||
    value["sources"].length === 0 ||
    !Array.isArray(value["entities"]) ||
    value["entities"].length === 0
  ) {
    return false;
  }

  const allowedGroups = new Map(
    BOOKING_LAUNCH_READINESS_GROUPS.filter((spec) => spec.port === port).map((spec) => [
      spec.groupId,
      spec,
    ]),
  );
  const sources = new Map<string, string>();
  for (const source of value["sources"]) {
    if (
      !isSourceEntityRevision(source) ||
      source.ownerDomain !== BOOKING_LAUNCH_SOURCE_DOMAIN_BY_PORT[port] ||
      (port === "booking" &&
        source.entityType === BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE)
    ) {
      return false;
    }
    const identity = bookingLaunchSourceKey(source);
    if (sources.has(identity)) return false;
    sources.set(identity, source.revision);
  }

  for (const entity of value["entities"]) {
    if (!isRecord(entity) || typeof entity["groupId"] !== "string") return false;
    const spec = allowedGroups.get(entity["groupId"] as BookingLaunchReadinessGroupId);
    if (
      !spec ||
      entity["owningStepId"] !== spec.owningStepId ||
      !isSourceEntityRevision(entity["source"]) ||
      entity["source"].ownerDomain !== spec.entityOwnerDomain ||
      sources.get(bookingLaunchSourceKey(entity["source"])) !== entity["source"].revision ||
      !Array.isArray(entity["blockers"]) ||
      !entity["blockers"].every(isOwnerBlocker) ||
      !validBindings(entity["bindings"], entity["source"].ownerDomain)
    ) {
      return false;
    }
  }
  return true;
}

export function bookingLaunchSourceKey(source: SourceEntityRevision): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId]);
}

export function sanitizeBookingLaunchSource(source: SourceEntityRevision): SourceEntityRevision {
  return {
    ownerDomain: source.ownerDomain,
    entityType: source.entityType,
    entityId: source.entityId,
    revision: source.revision,
  };
}

function isSourceEntityRevision(value: unknown): value is SourceEntityRevision {
  return (
    isRecord(value) &&
    typeof value["ownerDomain"] === "string" &&
    READINESS_SOURCE_DOMAINS.has(value["ownerDomain"]) &&
    nonEmpty(value["entityType"]) &&
    nonEmpty(value["entityId"]) &&
    nonEmpty(value["revision"])
  );
}

function isOwnerBlocker(value: unknown): value is BookingLaunchOwnerBlocker {
  if (
    !isRecord(value) ||
    typeof value["code"] !== "string" ||
    !CODE_PATTERN.test(value["code"]) ||
    value["scope"] !== "launch_configuration" ||
    !["user_fixable", "external_pending", "system_error"].includes(String(value["kind"]))
  ) {
    return false;
  }
  return value["kind"] === "system_error"
    ? typeof value["errorSource"] === "string" && READINESS_ERROR_SOURCES.has(value["errorSource"])
    : value["errorSource"] === undefined;
}

function validBindings(value: unknown, contributionOwnerDomain: string): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  for (const binding of value) {
    if (
      !isRecord(binding) ||
      !isSourceEntityRevision(binding["expectedSource"]) ||
      binding["expectedSource"].entityType === BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE ||
      binding["expectedSource"].ownerDomain === contributionOwnerDomain ||
      !isOwnerBlocker(binding["mismatchBlocker"])
    ) {
      return false;
    }
    const identity = bookingLaunchSourceKey(binding["expectedSource"]);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
