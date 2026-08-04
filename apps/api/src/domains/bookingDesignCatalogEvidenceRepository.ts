import { createHash } from "node:crypto";

import type {
  BookingDesignCatalogCoverAssignmentEvidencePort,
  BookingDesignCatalogEvidenceFailure,
  BookingDesignCatalogProfileEvidencePort,
  BookingDesignCatalogSafeMediaEvidencePort,
} from "@vayada/domain-booking";
import {
  HOTEL_CATALOG_CONTENT_LOCALES,
  HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
  type HotelCatalogContentLocale,
  type HotelMediaResolutionPort,
  type ResolvedPublicHotelMedia,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type QueryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

export type BookingDesignCatalogEvidenceRepository = {
  profile: BookingDesignCatalogProfileEvidencePort;
  coverAssignment: BookingDesignCatalogCoverAssignmentEvidencePort;
  safeMedia: BookingDesignCatalogSafeMediaEvidencePort;
  close(): Promise<void>;
};

type ProfileRow = {
  displayName: string;
  contentLocale: string;
  profileRevision: string | number;
  shortDescription: string | null;
};

type CoverRow = {
  profileRevision: string | number;
  coverCount: string | number;
  mediaObjectId: string | null;
  altText: string | null;
  sourceSystem: string | null;
  publicApproved: boolean | null;
};

export function createPgBookingDesignCatalogEvidenceRepository(config: {
  connectionString: string;
  mediaResolver: HotelMediaResolutionPort;
  pool?: QueryClient & { end(): Promise<void> };
}): BookingDesignCatalogEvidenceRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking design Catalog evidence connectionString must not be empty");
  }
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
    profile: {
      bookingDesignCatalogEvidencePort: "profile",
      async getBookingDesignProfileEvidence(input) {
        const result = await pool.query<ProfileRow>(
          `SELECT property.display_name AS "displayName",
                property.default_locale AS "contentLocale",
                property.profile_revision AS "profileRevision",
                profile.short_description AS "shortDescription"
           FROM hotel_catalog.properties property
           JOIN identity.organizations organization
             ON organization.id = $1::uuid
            AND organization.kind = 'hotel_group'
            AND organization.status = 'active'
           JOIN identity.organization_resource_links resource
             ON resource.organization_id = organization.id
            AND resource.product = 'hotel_catalog'
            AND resource.resource_type = 'property'
            AND resource.resource_id = property.id::text
            AND resource.relationship IN ('owner', 'operator')
            AND resource.status = 'active'
      LEFT JOIN hotel_catalog.property_profiles profile
             ON profile.property_id = property.id
            AND profile.locale = property.default_locale
          WHERE property.id = $2::uuid`,
          [input.organizationId, input.propertyId],
        );
        const row = result.rows[0];
        if (!row || row.shortDescription === null) {
          return failure("profile", "missing", "hotel_catalog_profile_missing");
        }
        const profileRevision = parseRevision(row.profileRevision);
        if (
          profileRevision === null ||
          !HOTEL_CATALOG_CONTENT_LOCALES.includes(row.contentLocale as HotelCatalogContentLocale)
        ) {
          return unavailable("profile", "hotel_catalog_profile_revision_invalid");
        }
        return Object.freeze({
          outcome: "evidence",
          evidencePort: "profile",
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          source: Object.freeze({
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: input.propertyId,
            revision: `profile:${profileRevision}`,
          }),
          profile: Object.freeze({
            contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
            profileRevision,
            displayName: row.displayName,
            contentLocale: row.contentLocale as HotelCatalogContentLocale,
            shortDescription: row.shortDescription,
          }),
        });
      },
    },
    coverAssignment: {
      bookingDesignCatalogEvidencePort: "cover_assignment",
      async getBookingDesignCoverAssignmentEvidence(input) {
        const result = await pool.query<CoverRow>(
          `SELECT property.profile_revision AS "profileRevision",
                (SELECT count(*)
                   FROM hotel_catalog.property_media media
                  WHERE media.property_id = property.id
                    AND media.media_type = 'hero_image') AS "coverCount",
                cover.platform_media_object_id::text AS "mediaObjectId",
                cover.alt_text AS "altText",
                cover.source_system AS "sourceSystem",
                cover.public_approved AS "publicApproved"
           FROM hotel_catalog.properties property
           JOIN identity.organizations organization
             ON organization.id = $1::uuid
            AND organization.kind = 'hotel_group'
            AND organization.status = 'active'
           JOIN identity.organization_resource_links resource
             ON resource.organization_id = organization.id
            AND resource.product = 'hotel_catalog'
            AND resource.resource_type = 'property'
            AND resource.resource_id = property.id::text
            AND resource.relationship IN ('owner', 'operator')
            AND resource.status = 'active'
      LEFT JOIN LATERAL (
                 SELECT media.platform_media_object_id,
                        media.alt_text,
                        media.source_system,
                        media.public_approved
                   FROM hotel_catalog.property_media media
                  WHERE media.property_id = property.id
                    AND media.media_type = 'hero_image'
                  ORDER BY media.sort_order, media.id
                  LIMIT 1
                ) cover ON TRUE
          WHERE property.id = $2::uuid`,
          [input.organizationId, input.propertyId],
        );
        const row = result.rows[0];
        if (!row) return failure("cover_assignment", "missing", "hotel_catalog_property_missing");
        const profileRevision = parseRevision(row.profileRevision);
        if (profileRevision === null) {
          return unavailable("cover_assignment", "hotel_catalog_cover_assignment_revision_invalid");
        }
        const coverCount = parseCount(row.coverCount);
        if (
          coverCount === null ||
          coverCount > 1 ||
          (coverCount === 1 &&
            (row.sourceSystem !== "platform" ||
              row.publicApproved !== true ||
              row.mediaObjectId === null))
        ) {
          return failure(
            "cover_assignment",
            "stale",
            "hotel_catalog_cover_assignment_not_public_safe",
          );
        }
        return Object.freeze({
          outcome: "evidence",
          evidencePort: "cover_assignment",
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          source: Object.freeze({
            ownerDomain: "hotel_catalog",
            entityType: "property_media_assignment",
            entityId: input.propertyId,
            revision: `profile:${profileRevision}`,
          }),
          cover:
            coverCount === 1 && row.mediaObjectId
              ? Object.freeze({ mediaObjectId: row.mediaObjectId, altText: row.altText })
              : null,
        });
      },
    },
    safeMedia: {
      bookingDesignCatalogEvidencePort: "safe_media",
      async getBookingDesignSafeMediaEvidence(input) {
        const resolved = await config.mediaResolver.resolvePublicMedia({
          ownerOrganizationId: input.organizationId,
          target: { kind: "property", propertyId: input.propertyId },
          mediaObjectIds: [input.mediaObjectId],
        });
        if (!resolved.ok) {
          return failure(
            "safe_media",
            "stale",
            resolved.error.code === "media_not_ready"
              ? "hotel_catalog_safe_media_not_ready"
              : "hotel_catalog_safe_media_unavailable",
          );
        }
        const media = resolved.batch.media[0];
        if (
          resolved.batch.media.length !== 1 ||
          !media ||
          media.mediaObjectId !== input.mediaObjectId ||
          media.ownerOrganizationId !== input.organizationId ||
          media.propertyId !== input.propertyId
        ) {
          return unavailable("safe_media", "hotel_catalog_safe_media_contract_violation");
        }
        return Object.freeze({
          outcome: "evidence",
          evidencePort: "safe_media",
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          source: Object.freeze({
            ownerDomain: "hotel_catalog",
            entityType: "property_safe_media",
            entityId: input.mediaObjectId,
            revision: mediaRevision(media),
          }),
          media,
        });
      },
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function parseRevision(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null;
}

function parseCount(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

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
  return `media:${createHash("sha256").update(fingerprint).digest("hex")}`;
}

function failure<Port extends "profile" | "cover_assignment" | "safe_media">(
  evidencePort: Port,
  outcome: "missing" | "stale",
  code: string,
): BookingDesignCatalogEvidenceFailure<Port> {
  return Object.freeze({ outcome, evidencePort, code });
}

function unavailable<Port extends "profile" | "cover_assignment" | "safe_media">(
  evidencePort: Port,
  code: string,
): BookingDesignCatalogEvidenceFailure<Port> {
  return Object.freeze({ outcome: "unavailable", evidencePort, code, errorSource: "provider" });
}
