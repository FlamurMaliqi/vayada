import { createHash } from "node:crypto";

import type {
  BookingLaunchCatalogEvidencePort,
  BookingLaunchOwnerBlocker,
} from "@vayada/domain-booking";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type {
  HotelMediaResolutionPort,
  ResolvedPublicHotelMedia,
  SourceEntityRevision,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type CatalogPool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
  end?(): Promise<void>;
};

type CatalogRow = QueryResultRow & {
  propertyId: string;
  displayName: string;
  defaultLocale: string;
  supportedLocales: string[];
  profileStatus: string;
  profileRevision: number | string;
  sourceUpdatedAt: Date | string;
  timezone: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  localityPublic: boolean | null;
  geoPublic: boolean | null;
  mapDisplayMode: string | null;
  summary: string | null;
  canonicalSlug: string | null;
  verifiedHostname: string | null;
  amenities: unknown;
  contacts: unknown;
  media: unknown;
};

type MediaAssignment = {
  mediaObjectId: string;
  mediaType: "hero_image" | "gallery_image" | "logo";
  altText: string | null;
  sortOrder: number;
};

type CatalogSource = Omit<SourceEntityRevision, "ownerDomain"> & {
  ownerDomain: "hotel_catalog";
};

type LoadedCatalog = {
  sources: CatalogSource[];
  source: CatalogSource;
  content: BookingPublicationSnapshotContent["hotel_catalog"];
  blockers: BookingLaunchOwnerBlocker[];
};

const SOURCE_TYPE = "hotel_catalog_publication.v1";

export function createHotelCatalogBookingPublicationSource(config: {
  connectionString: string;
  mediaResolver: HotelMediaResolutionPort;
  pool?: CatalogPool;
}): BookingLaunchCatalogEvidencePort &
  BookingPublicationOwnerSnapshotPort<"hotel_catalog"> & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      max: 4,
    });

  return {
    bookingLaunchEvidencePort: "catalog",
    owner: "hotel_catalog",
    async getBookingLaunchEvidence(request) {
      try {
        const loaded = await load(pool, config.mediaResolver, request);
        return loaded
          ? deepFreeze({
              outcome: "evidence",
              port: "catalog",
              ...request,
              sources: loaded.sources,
              entities: [
                {
                  groupId: "booking.hotel_profile",
                  owningStepId: "present_hotel",
                  source: loaded.source,
                  blockers: loaded.blockers,
                },
              ],
            })
          : unavailableEvidence();
      } catch {
        return unavailableEvidence("system");
      }
    },
    async getSnapshot(request) {
      try {
        const loaded = await load(pool, config.mediaResolver, {
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        });
        if (
          !loaded ||
          loaded.blockers.length > 0 ||
          sourceKeys(loaded.sources) !==
            sourceKeys(
              request.sourceManifest.sources.filter(
                ({ ownerDomain }) => ownerDomain === "hotel_catalog",
              ),
            )
        ) {
          return unavailableSnapshot();
        }
        return deepFreeze({
          outcome: "snapshot",
          contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
          owner: "hotel_catalog",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sourceManifestHash: request.sourceManifestHash,
          resolvedSources: loaded.sources,
          content: loaded.content,
        });
      } catch {
        return unavailableSnapshot();
      }
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

async function load(
  pool: CatalogPool,
  resolver: HotelMediaResolutionPort,
  scope: { organizationId: string; propertyId: string },
): Promise<LoadedCatalog | null> {
  const first = await readRow(pool, scope);
  if (!first) return null;
  const assignments = mediaAssignments(first.media);
  if (!assignments) return null;
  let resolvedMedia: readonly ResolvedPublicHotelMedia[] = [];
  const mediaObjectIds = [...new Set(assignments.map(({ mediaObjectId }) => mediaObjectId))];
  if (mediaObjectIds.length > 0) {
    const result = await resolver.resolvePublicMedia({
      ownerOrganizationId: scope.organizationId,
      target: { kind: "property", propertyId: scope.propertyId },
      mediaObjectIds,
    });
    if (!result.ok || result.batch.media.length !== mediaObjectIds.length) return null;
    resolvedMedia = result.batch.media;
  }
  const second = await readRow(pool, scope);
  if (!second || rowToken(first) !== rowToken(second)) return null;

  const mediaById = new Map(resolvedMedia.map((item) => [item.mediaObjectId, item]));
  const images = assignments
    .filter(({ mediaType }) => mediaType !== "logo")
    .map((assignment) => {
      const media = mediaById.get(assignment.mediaObjectId);
      const original = media?.publicVariants.find(
        ({ variantName }) => variantName === "original_safe",
      );
      return original
        ? {
            url: original.publicUrl,
            ...(assignment.altText === null ? {} : { alt: assignment.altText }),
          }
        : null;
    });
  if (images.some((image) => image === null)) return null;

  const profileRevision = positiveRevision(first.profileRevision);
  if (!profileRevision) return null;
  const profileSource = source("property_profile", scope.propertyId, `profile:${profileRevision}`);
  const assignmentSource = source(
    "property_media_assignment",
    scope.propertyId,
    `profile:${profileRevision}`,
  );
  const mediaSources = resolvedMedia.map((media) =>
    source("property_safe_media", media.mediaObjectId, mediaRevision(media)),
  );
  const localityPublic = first.localityPublic === true;
  const geoPublic =
    first.geoPublic === true && ["approximate", "exact"].includes(first.mapDisplayMode ?? "");
  const round = (value: number | string | null) => {
    const parsed = value === null ? null : Number(value);
    if (!Number.isFinite(parsed)) return null;
    return first.mapDisplayMode === "approximate" ? Number(parsed!.toFixed(2)) : parsed;
  };
  const hostname = cleanHostname(first.verifiedHostname);
  const content: BookingPublicationSnapshotContent["hotel_catalog"] = {
    propertyId: scope.propertyId,
    slug: first.canonicalSlug ?? "",
    name: first.displayName,
    timezone: first.timezone ?? "",
    defaultLocale: first.defaultLocale,
    supportedLocales: [...new Set([first.defaultLocale, ...first.supportedLocales])].sort(),
    location: {
      country: localityPublic ? (first.countryCode ?? "") : "",
      city: localityPublic ? (first.city ?? "") : "",
      region: localityPublic ? first.region : null,
      latitude: geoPublic ? round(first.latitude) : null,
      longitude: geoPublic ? round(first.longitude) : null,
    },
    summary: first.summary,
    images: images as { url: string; alt?: string | null }[],
    amenities: stringArray(first.amenities),
    publicContacts: contacts(first.contacts),
    profileComplete: first.profileStatus === "complete",
    profileVerified: first.profileStatus === "complete",
    bookingWeb: {
      customDomainUrl: hostname ? `https://${hostname}` : null,
      domainVerified: Boolean(hostname),
    },
    freshness: { status: "fresh", lastUpdatedAt: iso(first.sourceUpdatedAt) },
  };
  const aggregateSource = source(
    SOURCE_TYPE,
    scope.propertyId,
    `sha256:${sha256(JSON.stringify(content))}`,
  );
  const blockers: BookingLaunchOwnerBlocker[] = [];
  if (!content.profileComplete) blockers.push(blocker("hotel_profile_incomplete"));
  if (!localityPublic || !content.location.country || !content.location.city)
    blockers.push(blocker("hotel_public_locality_missing"));
  if (!content.slug) blockers.push(blocker("hotel_canonical_slug_missing"));
  if (!content.timezone) blockers.push(blocker("hotel_timezone_missing"));
  if (content.images.length === 0) blockers.push(blocker("hotel_public_media_missing"));
  return {
    sources: [profileSource, assignmentSource, ...mediaSources, aggregateSource].sort(
      compareSource,
    ),
    source: aggregateSource,
    content,
    blockers,
  };
}

async function readRow(
  pool: CatalogPool,
  scope: { organizationId: string; propertyId: string },
): Promise<CatalogRow | null> {
  const result = await pool.query<CatalogRow>(CATALOG_SQL, [
    scope.organizationId,
    scope.propertyId,
  ]);
  return result.rows.length === 1 ? result.rows[0]! : null;
}

const CATALOG_SQL = `
SELECT property.id::text AS "propertyId", property.display_name AS "displayName",
       property.default_locale AS "defaultLocale", property.supported_locales AS "supportedLocales",
       property.profile_status AS "profileStatus", property.profile_revision AS "profileRevision",
       GREATEST(property.updated_at, COALESCE(location.updated_at, property.updated_at),
         COALESCE((SELECT max(profile.updated_at) FROM hotel_catalog.property_profiles profile WHERE profile.property_id = property.id), property.updated_at),
         COALESCE((SELECT max(media.updated_at) FROM hotel_catalog.property_media media WHERE media.property_id = property.id), property.updated_at)) AS "sourceUpdatedAt",
       location.timezone, location.country_code AS "countryCode", location.region, location.city,
       location.latitude, location.longitude, location.address_public AS "localityPublic",
       location.geo_public AS "geoPublic", location.map_display_mode AS "mapDisplayMode",
       profile.short_description AS summary, slug.slug AS "canonicalSlug", domain.hostname AS "verifiedHostname",
       COALESCE((SELECT jsonb_agg(amenity.amenity_key ORDER BY amenity.amenity_key) FROM hotel_catalog.property_amenities amenity WHERE amenity.property_id = property.id AND amenity.public_safe), '[]') AS amenities,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('type', contact.channel_type, 'value', contact.value) ORDER BY contact.channel_type, contact.value) FROM hotel_catalog.property_contact_channels contact WHERE contact.property_id = property.id AND contact.is_public), '[]') AS contacts,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('mediaObjectId', media.platform_media_object_id::text, 'mediaType', media.media_type, 'altText', media.alt_text, 'sortOrder', media.sort_order) ORDER BY media.sort_order, media.id) FROM hotel_catalog.property_media media WHERE media.property_id = property.id AND media.public_approved AND media.source_system = 'platform'), '[]') AS media
FROM hotel_catalog.properties property
JOIN identity.organizations organization ON organization.id = $1::uuid AND organization.kind = 'hotel_group' AND organization.status = 'active'
JOIN identity.organization_resource_links resource ON resource.organization_id = organization.id AND resource.product = 'hotel_catalog' AND resource.resource_type = 'property' AND resource.resource_id = property.id::text AND resource.relationship IN ('owner', 'operator') AND resource.status = 'active'
LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
LEFT JOIN hotel_catalog.property_profiles profile ON profile.property_id = property.id AND profile.locale = property.default_locale
LEFT JOIN LATERAL (SELECT candidate.slug FROM hotel_catalog.property_slugs candidate WHERE candidate.property_id = property.id AND candidate.purpose = 'canonical' AND candidate.status = 'active' ORDER BY candidate.updated_at DESC, candidate.id LIMIT 1) slug ON TRUE
LEFT JOIN LATERAL (SELECT candidate.hostname FROM hotel_catalog.property_domains candidate WHERE candidate.property_id = property.id AND candidate.verification_status = 'verified' AND candidate.canonical_when_verified ORDER BY candidate.verified_at DESC NULLS LAST, candidate.id LIMIT 1) domain ON TRUE
WHERE property.id = $2::uuid AND property.lifecycle_status = 'active'`;

function mediaAssignments(value: unknown): MediaAssignment[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => {
    if (!record(item) || typeof item["mediaObjectId"] !== "string") return null;
    const mediaType = item["mediaType"];
    const sortOrder = Number(item["sortOrder"]);
    return ["hero_image", "gallery_image", "logo"].includes(String(mediaType)) &&
      Number.isSafeInteger(sortOrder) &&
      (item["altText"] === null || typeof item["altText"] === "string")
      ? ({
          mediaObjectId: item["mediaObjectId"],
          mediaType,
          altText: item["altText"],
          sortOrder,
        } as MediaAssignment)
      : null;
  });
  return parsed.some((item) => !item) ? null : (parsed as MediaAssignment[]);
}

function contacts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    record(item) && typeof item["type"] === "string" && typeof item["value"] === "string"
      ? [{ type: item["type"], value: item["value"] }]
      : [],
  ) as BookingPublicationSnapshotContent["hotel_catalog"]["publicContacts"];
}

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const source = (entityType: string, entityId: string, revision: string): CatalogSource => ({
  ownerDomain: "hotel_catalog",
  entityType,
  entityId,
  revision,
});
const blocker = (code: string): BookingLaunchOwnerBlocker => ({
  code,
  scope: "launch_configuration",
  kind: "user_fixable",
});
const unavailableEvidence = (errorSource: "provider" | "system" = "provider") => ({
  outcome: "unavailable" as const,
  port: "catalog" as const,
  errorSource,
});
const unavailableSnapshot = () => ({
  outcome: "unavailable" as const,
  owner: "hotel_catalog" as const,
});
const sourceKeys = (sources: readonly SourceEntityRevision[]) =>
  sources.map(sourceKey).sort().join("\0");
const compareSource = (left: SourceEntityRevision, right: SourceEntityRevision) =>
  sourceKey(left).localeCompare(sourceKey(right));
const sourceKey = ({ ownerDomain, entityType, entityId, revision }: SourceEntityRevision) =>
  JSON.stringify([ownerDomain, entityType, entityId, revision]);
const positiveRevision = (value: number | string) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const rowToken = (row: CatalogRow) => sha256(JSON.stringify(row));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: Date | string) => new Date(value).toISOString();
const cleanHostname = (value: string | null) =>
  value && /^[a-z0-9.-]+$/i.test(value) ? value.toLowerCase() : null;
function mediaRevision(media: ResolvedPublicHotelMedia): string {
  const fingerprint = JSON.stringify({
    mediaObjectId: media.mediaObjectId,
    ownerOrganizationId: media.ownerOrganizationId,
    propertyId: media.propertyId,
    purpose: media.purpose,
    publicVariants: media.publicVariants
      .map(({ variantName, publicUrl }) => ({ variantName, publicUrl }))
      .sort((left, right) => left.variantName.localeCompare(right.variantName)),
  });
  return `media:${sha256(fingerprint)}`;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
