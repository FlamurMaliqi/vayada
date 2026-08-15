import type {
  SourceEntityRevision,
  SourceManifest,
  SourceManifestHash,
} from "@vayada/domain-hotels";

import type { PublicBookabilityProducerInputs } from "./index.js";
import type {
  BookingPublicCalendarSnapshot,
  BookingPublicPaymentMethod,
  BookingPublicRoom,
} from "./bookingPublication.js";

export const BOOKING_OWNER_SNAPSHOT_VERSION = "booking-publication-owner-snapshot.v1" as const;
const DERIVED_BINDING_ENTITY_TYPE = "booking_launch_dependency_set.v1";
const PMS_CALENDAR_ENTITY_TYPE = "pms_operating_calendar.v1";

export type BookingPublicationSnapshotOwner = "hotel_catalog" | "booking" | "pms" | "finance";
type FreshContent = Readonly<{ freshness: Readonly<{ status: "fresh"; lastUpdatedAt: string }> }>;
export type BookingPublicationSnapshotContent = {
  hotel_catalog: PublicBookabilityProducerInputs["hotelCatalog"] & FreshContent;
  booking: PublicBookabilityProducerInputs["booking"] & FreshContent;
  pms: PublicBookabilityProducerInputs["pms"] &
    FreshContent & {
      rooms: readonly BookingPublicRoom[];
      calendar: BookingPublicCalendarSnapshot;
    };
  finance: PublicBookabilityProducerInputs["finance"] &
    FreshContent & { readyPaymentMethods: readonly BookingPublicPaymentMethod[] };
};

export type BookingPublicationOwnerSnapshot<Owner extends BookingPublicationSnapshotOwner> =
  Readonly<{
    outcome: "snapshot";
    contractVersion: typeof BOOKING_OWNER_SNAPSHOT_VERSION;
    owner: Owner;
    organizationId: string;
    propertyId: string;
    sourceManifestHash: SourceManifestHash;
    resolvedSources: readonly (Omit<SourceEntityRevision, "ownerDomain"> & {
      ownerDomain: Owner;
    })[];
    content: BookingPublicationSnapshotContent[Owner];
  }>;

export type BookingPublicationSnapshotRequest = Readonly<{
  organizationId: string;
  propertyId: string;
  sourceManifest: SourceManifest;
  sourceManifestHash: SourceManifestHash;
}>;

type SnapshotResult<Owner extends BookingPublicationSnapshotOwner> =
  | BookingPublicationOwnerSnapshot<Owner>
  | Readonly<{ outcome: "unavailable"; owner: Owner }>;

export interface BookingPublicationOwnerSnapshotPort<
  Owner extends BookingPublicationSnapshotOwner,
> {
  readonly owner: Owner;
  getSnapshot(request: BookingPublicationSnapshotRequest): Promise<SnapshotResult<Owner>>;
}

/** Checks envelope/provenance only; the consuming builder validates owner content. */
export function bookingPublicationOwnerSnapshotProvenanceMatches<
  Owner extends BookingPublicationSnapshotOwner,
>(snapshot: unknown, owner: Owner, request: BookingPublicationSnapshotRequest): boolean {
  if (
    request.sourceManifest.sources.some(
      (source) =>
        source.entityType === DERIVED_BINDING_ENTITY_TYPE && source.ownerDomain !== "booking",
    ) ||
    !isRecord(snapshot) ||
    snapshot["outcome"] !== "snapshot" ||
    snapshot["contractVersion"] !== BOOKING_OWNER_SNAPSHOT_VERSION ||
    snapshot["owner"] !== owner ||
    snapshot["organizationId"] !== request.organizationId ||
    snapshot["propertyId"] !== request.propertyId ||
    snapshot["sourceManifestHash"] !== request.sourceManifestHash ||
    !isRecord(snapshot["content"]) ||
    !sameSources(
      snapshot["resolvedSources"],
      request.sourceManifest.sources.filter(
        (source) =>
          source.ownerDomain === owner &&
          !(owner === "booking" && source.entityType === DERIVED_BINDING_ENTITY_TYPE),
      ),
    )
  )
    return false;
  if (owner !== "pms") return true;
  const content = snapshot["content"];
  const sources = snapshot["resolvedSources"] as SourceEntityRevision[];
  const calendarSources = sources.filter(
    ({ entityType }) => entityType === PMS_CALENDAR_ENTITY_TYPE,
  );
  const sourceRevision = isRecord(content["calendar"])
    ? content["calendar"]["sourceRevision"]
    : null;
  return (
    calendarSources.length === 1 &&
    calendarSources[0]?.entityId === request.propertyId &&
    typeof sourceRevision === "string" &&
    sourceRevision.trim().length > 0 &&
    sourceRevision === calendarSources[0].revision
  );
}

function sameSources(left: unknown, right: readonly SourceEntityRevision[]) {
  if (!Array.isArray(left) || !left.every(isSource)) return false;
  return sourceKeys(left).join("\0") === sourceKeys(right).join("\0");
}

const sourceKeys = (sources: readonly SourceEntityRevision[]) =>
  sources
    .map(({ ownerDomain, entityType, entityId, revision }) =>
      JSON.stringify([ownerDomain, entityType, entityId, revision]),
    )
    .sort();

const isSource = (value: unknown): value is SourceEntityRevision =>
  isRecord(value) &&
  ["ownerDomain", "entityType", "entityId", "revision"].every(
    (field) => typeof value[field] === "string" && value[field].trim(),
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
