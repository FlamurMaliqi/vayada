import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  PROPERTY_MEDIA_UPLOAD_PURPOSES,
  type HotelMediaResolutionPort,
  type HotelMediaResolutionTarget,
  type PropertyMediaPublicVariant,
  type PropertyMediaPublicVariantName,
  type PropertyMediaUploadPurpose,
  type ResolvedHotelMediaTarget,
  type ResolvedPublicHotelMedia,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PlatformMediaServingConfig } from "./mediaServing.js";

type HotelMediaResolverPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type TargetRow = QueryResultRow & { authorized: boolean };
type MediaRow = QueryResultRow & {
  requestOrdinal: number | string;
  requestedMediaObjectId: string;
  resolution: "scoped" | "not_found" | "not_authorized";
  mediaObjectId: string | null;
  bucket: string | null;
  storageKey: string | null;
  storageKind: string | null;
  visibility: string | null;
  purpose: string | null;
  ownerOrganizationId: string | null;
  propertyId: string | null;
  lifecycleStatus: string | null;
  contentType: string | null;
  publicApproved: boolean | null;
  variants: unknown;
};

type VariantRow = {
  variantName: string;
  visibility: string;
  storageKey: string;
  contentType: string;
  publicUrl: string | null;
};

type MediaResolutionErrorCode = "media_not_found" | "media_not_authorized" | "media_not_ready";

export type PgHotelMediaResolverConfig = {
  connectionString: string;
  serving: Pick<PlatformMediaServingConfig, "bucketName" | "cdnBaseUrl" | "publicPathPrefix">;
  max?: number;
  pool?: HotelMediaResolverPool;
};

export type PersistentHotelMediaResolutionPort = HotelMediaResolutionPort & {
  close?(): Promise<void>;
};

const AUTHORIZED_TARGET_SQL = `
  SELECT property.id AS property_id
  FROM hotel_catalog.properties property
  JOIN identity.organization_resource_links link
    ON link.organization_id = $1::uuid
   AND link.product = 'hotel_catalog'
   AND link.resource_type = 'property'
   AND link.resource_id = property.id::text
   AND link.relationship IN ('owner', 'operator')
   AND link.status = 'active'
  WHERE property.id = $2::uuid
    AND (
      $3::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM pms.room_types room_type
        WHERE room_type.id = $3::uuid
          AND room_type.property_id = property.id
      )
    )
`;

const RESOLVE_TARGET_SQL = `
  SELECT EXISTS (${AUTHORIZED_TARGET_SQL}) AS authorized
  /* hotel_media_target_resolution */
`;

const RESOLVE_MEDIA_SQL = `
  WITH authorized_target AS (${AUTHORIZED_TARGET_SQL}),
  requested AS (
    SELECT
      requested_id AS media_object_id,
      request_ordinal
    FROM unnest($4::uuid[]) WITH ORDINALITY AS input(requested_id, request_ordinal)
  ),
  scoped_media AS (
    SELECT media.*
    FROM platform.media_objects media
    JOIN authorized_target target ON target.property_id = media.property_id
    WHERE media.owner_organization_id = $1::uuid
  )
  SELECT
    requested.request_ordinal AS "requestOrdinal",
    requested.media_object_id::text AS "requestedMediaObjectId",
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM authorized_target) THEN 'not_authorized'
      WHEN media.id IS NOT NULL THEN 'scoped'
      WHEN EXISTS (
        SELECT 1
        FROM platform.media_objects candidate
        WHERE candidate.id = requested.media_object_id
      ) THEN 'not_authorized'
      ELSE 'not_found'
    END AS resolution,
    media.id::text AS "mediaObjectId",
    media.bucket,
    media.storage_key AS "storageKey",
    media.storage_kind AS "storageKind",
    media.visibility,
    media.purpose,
    media.owner_organization_id::text AS "ownerOrganizationId",
    media.property_id::text AS "propertyId",
    media.lifecycle_status AS "lifecycleStatus",
    media.content_type AS "contentType",
    media.public_approved AS "publicApproved",
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'variantName', variant.variant_name,
          'visibility', variant.visibility,
          'storageKey', variant.storage_key,
          'contentType', variant.content_type,
          'publicUrl', variant.public_cdn_url
        )
        ORDER BY variant.created_at, variant.id
      )
      FROM platform.media_variants variant
      WHERE variant.media_object_id = media.id
    ), '[]'::jsonb) AS variants
  FROM requested
  LEFT JOIN scoped_media media ON media.id = requested.media_object_id
  ORDER BY requested.request_ordinal
  /* hotel_media_public_resolution */
`;

export function createPgHotelMediaResolutionPort(
  config: PgHotelMediaResolverConfig,
): PersistentHotelMediaResolutionPort {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel media resolver connectionString must not be empty");
  }
  const scope = configuredPublicScope(config.serving);
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async resolvePublicMedia(input) {
      const requestedIds = [...input.mediaObjectIds];
      const target = await pool.query<TargetRow>(RESOLVE_TARGET_SQL, [
        input.ownerOrganizationId,
        input.target.propertyId,
        input.target.kind === "room_type" ? input.target.roomTypeId : null,
      ]);
      if (target.rows[0]?.authorized !== true) {
        return failure("media_not_authorized", requestedIds);
      }

      const resolvedTarget = freezeResolvedTarget(input.ownerOrganizationId, input.target);
      if (requestedIds.length === 0) {
        return { ok: true, resolvedTarget, media: Object.freeze([]) };
      }

      const result = await pool.query<MediaRow>(RESOLVE_MEDIA_SQL, [
        input.ownerOrganizationId,
        input.target.propertyId,
        input.target.kind === "room_type" ? input.target.roomTypeId : null,
        requestedIds,
      ]);
      const rowsByOrdinal = rowsByRequestOrdinal(result.rows);
      const notFound: string[] = [];
      const notAuthorized: string[] = [];
      const notReady: string[] = [];
      const resolved: ResolvedPublicHotelMedia[] = [];

      requestedIds.forEach((requestedId, index) => {
        const row = rowsByOrdinal.get(index + 1);
        if (
          !row ||
          !sameIdentifier(row.requestedMediaObjectId, requestedId) ||
          row.resolution === "not_found"
        ) {
          notFound.push(requestedId);
          return;
        }
        if (
          row.resolution === "not_authorized" ||
          !sameIdentifier(row.ownerOrganizationId, input.ownerOrganizationId) ||
          !sameIdentifier(row.propertyId, input.target.propertyId) ||
          !isSupportedPurpose(row.purpose)
        ) {
          notAuthorized.push(requestedId);
          return;
        }
        const media = toResolvedPublicMedia(row, scope);
        if (!media) {
          notReady.push(requestedId);
          return;
        }
        resolved.push(media);
      });

      if (notFound.length > 0) return failure("media_not_found", notFound);
      if (notAuthorized.length > 0) {
        return failure("media_not_authorized", notAuthorized);
      }
      if (notReady.length > 0) return failure("media_not_ready", notReady);
      return {
        ok: true,
        resolvedTarget,
        media: Object.freeze(resolved),
      };
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export const createPgHotelMediaResolver = createPgHotelMediaResolutionPort;

function toResolvedPublicMedia(
  row: MediaRow,
  scope: ConfiguredPublicScope,
): ResolvedPublicHotelMedia | null {
  const variants = parseReadyVariants(row.variants, scope);
  if (
    row.resolution !== "scoped" ||
    !row.mediaObjectId ||
    !row.ownerOrganizationId ||
    !row.propertyId ||
    !isSupportedPurpose(row.purpose) ||
    row.bucket !== scope.bucketName ||
    row.storageKind !== "vayada_managed" ||
    row.visibility !== "public" ||
    row.publicApproved !== true ||
    row.lifecycleStatus !== "active" ||
    !isImageContentType(row.contentType) ||
    !isPublicStorageKey(row.storageKey, scope.publicPathPrefix) ||
    !variants
  ) {
    return null;
  }

  return Object.freeze({
    mediaObjectId: row.mediaObjectId,
    ownerOrganizationId: row.ownerOrganizationId,
    propertyId: row.propertyId,
    purpose: row.purpose,
    publicVariants: variants,
  }) as ResolvedPublicHotelMedia;
}

function parseReadyVariants(
  value: unknown,
  scope: ConfiguredPublicScope,
): ResolvedPublicHotelMedia["publicVariants"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = new Set<string>();
  const variants: Readonly<PropertyMediaPublicVariant>[] = [];
  for (const candidate of value) {
    if (!isVariantRow(candidate) || names.has(candidate.variantName)) return null;
    if (
      !PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(
        candidate.variantName as PropertyMediaPublicVariantName,
      ) ||
      candidate.visibility !== "public" ||
      !isImageContentType(candidate.contentType) ||
      !isPublicStorageKey(candidate.storageKey, scope.publicPathPrefix) ||
      !isPublicCdnUrl(candidate.publicUrl, scope)
    ) {
      return null;
    }
    names.add(candidate.variantName);
    variants.push(
      Object.freeze({
        variantName: candidate.variantName as PropertyMediaPublicVariantName,
        publicUrl: candidate.publicUrl,
      }),
    );
  }
  if (!names.has("original_safe")) return null;
  return Object.freeze(variants) as ResolvedPublicHotelMedia["publicVariants"];
}

function freezeResolvedTarget(
  ownerOrganizationId: string,
  target: HotelMediaResolutionTarget,
): ResolvedHotelMediaTarget {
  const targetSnapshot =
    target.kind === "property"
      ? Object.freeze({ kind: "property" as const, propertyId: target.propertyId })
      : Object.freeze({
          kind: "room_type" as const,
          propertyId: target.propertyId,
          roomTypeId: target.roomTypeId,
        });
  return Object.freeze({
    ownerOrganizationId,
    target: targetSnapshot,
  }) as ResolvedHotelMediaTarget;
}

function failure(code: MediaResolutionErrorCode, mediaObjectIds: readonly string[]) {
  return {
    ok: false as const,
    error: {
      code,
      mediaObjectIds: orderedUnique(mediaObjectIds),
    },
  };
}

function rowsByRequestOrdinal(rows: readonly MediaRow[]): Map<number, MediaRow> {
  const mapped = new Map<number, MediaRow>();
  for (const row of rows) {
    const ordinal = Number(row.requestOrdinal);
    if (Number.isSafeInteger(ordinal) && ordinal > 0 && !mapped.has(ordinal)) {
      mapped.set(ordinal, row);
    }
  }
  return mapped;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameIdentifier(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function isSupportedPurpose(value: unknown): value is PropertyMediaUploadPurpose {
  return PROPERTY_MEDIA_UPLOAD_PURPOSES.includes(value as PropertyMediaUploadPurpose);
}

function isVariantRow(value: unknown): value is VariantRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["variantName"] === "string" &&
    typeof row["visibility"] === "string" &&
    typeof row["storageKey"] === "string" &&
    typeof row["contentType"] === "string" &&
    (typeof row["publicUrl"] === "string" || row["publicUrl"] === null)
  );
}

function isImageContentType(value: unknown): value is string {
  return typeof value === "string" && /^image\/[a-z0-9.+-]+$/i.test(value.trim());
}

function isPublicStorageKey(value: unknown, publicPathPrefix: string): value is string {
  if (typeof value !== "string" || !value.startsWith(`public/${publicPathPrefix}/`)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

type ConfiguredPublicScope = {
  bucketName: string;
  cdnOrigin: string;
  publicPathPrefix: string;
  publicPathnamePrefix: string;
};

function configuredPublicScope(
  serving: PgHotelMediaResolverConfig["serving"],
): ConfiguredPublicScope {
  const bucketName = serving.bucketName.trim();
  const publicPathPrefix = serving.publicPathPrefix.trim().replace(/^\/+|\/+$/g, "");
  const cdn = new URL(serving.cdnBaseUrl);
  if (!bucketName) throw new Error("Hotel media resolver bucketName must not be empty");
  if (
    cdn.protocol !== "https:" ||
    cdn.pathname !== "/" ||
    cdn.search ||
    cdn.hash ||
    cdn.username ||
    cdn.password
  ) {
    throw new Error("Hotel media resolver cdnBaseUrl must be an HTTPS origin");
  }
  if (
    !publicPathPrefix ||
    publicPathPrefix.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Hotel media resolver publicPathPrefix must be a safe non-empty path");
  }
  return {
    bucketName,
    cdnOrigin: cdn.origin,
    publicPathPrefix,
    publicPathnamePrefix: `/${publicPathPrefix}/`,
  };
}

function isPublicCdnUrl(value: string | null, scope: ConfiguredPublicScope): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.origin === scope.cdnOrigin &&
      url.pathname.startsWith(scope.publicPathnamePrefix)
    );
  } catch {
    return false;
  }
}
