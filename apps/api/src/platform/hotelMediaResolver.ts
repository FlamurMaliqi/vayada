import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  PROPERTY_MEDIA_UPLOAD_PURPOSES,
  type HotelMediaResolutionAdapter,
  type HotelMediaResolutionTarget,
  type PublicHotelMediaResolutionSnapshot,
  type PropertyMediaPublicVariant,
  type PropertyMediaPublicVariantName,
  type PropertyMediaUploadPurpose,
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

type TargetRow = { authorized: boolean };
type MediaRow = {
  requestOrdinal: number | string;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PUBLIC_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;
const SAFE_HOTEL_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const RESOLVER_CONNECTION_TIMEOUT_MS = 5_000;
const RESOLVER_STATEMENT_TIMEOUT_MS = 10_000;
const RESOLVER_QUERY_TIMEOUT_MS = 12_000;

export type PgHotelMediaResolverConfig = {
  connectionString: string;
  serving: Pick<PlatformMediaServingConfig, "bucketName" | "cdnBaseUrl" | "publicPathPrefix">;
  max?: number;
  pool?: HotelMediaResolverPool;
};

export type PersistentHotelMediaResolutionAdapter = HotelMediaResolutionAdapter & {
  close?(): Promise<void>;
};

const AUTHORIZED_TARGET_SQL = `
  SELECT property.id AS property_id
  FROM hotel_catalog.properties property
  WHERE property.id = $2::uuid
    AND EXISTS (
      SELECT 1
      FROM identity.organization_resource_links link
      WHERE link.organization_id = $1::uuid
        AND link.product = 'hotel_catalog'
        AND link.resource_type = 'property'
        AND link.resource_id = property.id::text
        AND link.relationship IN ('owner', 'operator')
        AND link.status = 'active'
    )
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
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM authorized_target) THEN 'not_authorized'
      WHEN media.id IS NOT NULL THEN 'scoped'
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
): PersistentHotelMediaResolutionAdapter {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel media resolver connectionString must not be empty");
  }
  const scope = configuredPublicScope(config.serving);
  const ownsPool = !config.pool;
  const pool = config.pool ?? createHotelMediaResolverPool(config);

  return {
    async loadPublicMedia(input) {
      const requestedIds = snapshotRequestedIds(input);
      const request = snapshotResolverRequest(input);
      if (!request || !isValidTarget(request.ownerOrganizationId, request.target)) {
        return failure("media_not_authorized", requestedIds);
      }
      const ownerOrganizationId = normalizeUuid(request.ownerOrganizationId)!;
      const targetSnapshot = normalizeTarget(request.target)!;
      const targetResult = await pool.query<TargetRow>(RESOLVE_TARGET_SQL, [
        ownerOrganizationId,
        targetSnapshot.propertyId,
        targetSnapshot.kind === "room_type" ? targetSnapshot.roomTypeId : null,
      ]);
      const targetRows = snapshotQueryRows(targetResult);
      if (
        !targetRows ||
        targetRows.length !== 1 ||
        !isExactDataRecord(targetRows[0], ["authorized"]) ||
        targetRows[0]["authorized"] !== true
      ) {
        return failure("media_not_authorized", requestedIds);
      }

      const resolvedTarget = freezeResolvedTarget(targetSnapshot);
      if (requestedIds.length === 0) {
        return { ok: true, resolvedTarget, media: Object.freeze([]) };
      }
      const malformedIds = requestedIds.filter((mediaObjectId) => !normalizeUuid(mediaObjectId));
      if (malformedIds.length > 0) {
        return failure("media_not_found", malformedIds);
      }
      const canonicalRequestedIds = requestedIds.map(
        (mediaObjectId) => normalizeUuid(mediaObjectId)!,
      );
      if (new Set(canonicalRequestedIds).size !== canonicalRequestedIds.length) {
        return failure("media_not_authorized", canonicalRequestedIds);
      }

      const result = await pool.query<MediaRow>(RESOLVE_MEDIA_SQL, [
        ownerOrganizationId,
        targetSnapshot.propertyId,
        targetSnapshot.kind === "room_type" ? targetSnapshot.roomTypeId : null,
        canonicalRequestedIds,
      ]);
      const resultRows = snapshotQueryRows(result);
      if (!resultRows || resultRows.length !== canonicalRequestedIds.length) {
        return failure("media_not_found", canonicalRequestedIds);
      }
      const notFound: string[] = [];
      const notAuthorized: string[] = [];
      const notReady: string[] = [];
      const resolved: PublicHotelMediaResolutionSnapshot[] = [];

      canonicalRequestedIds.forEach((requestedId, index) => {
        const row = snapshotMediaRow(resultRows[index]);
        if (
          !row ||
          Number(row.requestOrdinal) !== index + 1 ||
          row.resolution === "not_found" ||
          (row.resolution !== "not_authorized" && !sameIdentifier(row.mediaObjectId, requestedId))
        ) {
          notFound.push(requestedId);
          return;
        }
        if (
          row.resolution === "not_authorized" ||
          !sameIdentifier(row.ownerOrganizationId, ownerOrganizationId) ||
          !sameIdentifier(row.propertyId, targetSnapshot.propertyId) ||
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

function createHotelMediaResolverPool(config: PgHotelMediaResolverConfig): HotelMediaResolverPool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: RESOLVER_CONNECTION_TIMEOUT_MS,
    statement_timeout: RESOLVER_STATEMENT_TIMEOUT_MS,
    query_timeout: RESOLVER_QUERY_TIMEOUT_MS,
  });
  pool.on("error", (error) => {
    process.emitWarning("Hotel media resolver PostgreSQL pool emitted an idle-client error", {
      code: "HOTEL_MEDIA_RESOLVER_POOL_ERROR",
      detail: error.message,
    });
  });
  return pool;
}

function toResolvedPublicMedia(
  row: MediaRow,
  scope: ConfiguredPublicScope,
): PublicHotelMediaResolutionSnapshot | null {
  const variants = parseReadyVariants(row.variants, row.mediaObjectId, scope);
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
    !isPublicStorageKey(
      row.storageKey,
      row.mediaObjectId,
      "original_safe",
      scope.publicPathPrefix,
    ) ||
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
  }) as PublicHotelMediaResolutionSnapshot;
}

function parseReadyVariants(
  value: unknown,
  mediaObjectId: string | null,
  scope: ConfiguredPublicScope,
): PublicHotelMediaResolutionSnapshot["publicVariants"] | null {
  if (!mediaObjectId || !isDensePlainArray(value) || value.length === 0) return null;
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
      !isPublicStorageKey(
        candidate.storageKey,
        mediaObjectId,
        candidate.variantName,
        scope.publicPathPrefix,
      ) ||
      !isPublicCdnUrl(candidate.publicUrl, candidate.storageKey, scope)
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
  return Object.freeze(variants) as PublicHotelMediaResolutionSnapshot["publicVariants"];
}

function freezeResolvedTarget(target: HotelMediaResolutionTarget): HotelMediaResolutionTarget {
  return target.kind === "property"
    ? Object.freeze({ kind: "property" as const, propertyId: target.propertyId })
    : Object.freeze({
        kind: "room_type" as const,
        propertyId: target.propertyId,
        roomTypeId: target.roomTypeId,
      });
}

function failure(code: MediaResolutionErrorCode, mediaObjectIds: readonly string[]) {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code,
      mediaObjectIds: Object.freeze([...new Set(mediaObjectIds)]) as unknown as string[],
    }),
  });
}

function snapshotRequestedIds(value: unknown): string[] {
  if (!isExactDataRecord(value, ["ownerOrganizationId", "target", "mediaObjectIds"])) return [];
  const mediaObjectIds = value["mediaObjectIds"];
  return isDensePlainArray(mediaObjectIds) &&
    mediaObjectIds.every((item) => typeof item === "string")
    ? [...(mediaObjectIds as string[])]
    : [];
}

function snapshotResolverRequest(value: unknown): {
  ownerOrganizationId: string;
  target: HotelMediaResolutionTarget;
  mediaObjectIds: readonly string[];
} | null {
  if (!isExactDataRecord(value, ["ownerOrganizationId", "target", "mediaObjectIds"])) return null;
  const ownerOrganizationId = value["ownerOrganizationId"];
  const target = snapshotInputTarget(value["target"]);
  const mediaObjectIds = snapshotRequestedIds(value);
  if (
    typeof ownerOrganizationId !== "string" ||
    !target ||
    !isDensePlainArray(value["mediaObjectIds"]) ||
    mediaObjectIds.length !== value["mediaObjectIds"].length
  ) {
    return null;
  }
  return Object.freeze({
    ownerOrganizationId,
    target,
    mediaObjectIds: Object.freeze(mediaObjectIds),
  });
}

function snapshotInputTarget(value: unknown): HotelMediaResolutionTarget | null {
  if (!isPlainDataRecord(value) || typeof value["kind"] !== "string") return null;
  if (
    value["kind"] === "property" &&
    isExactDataRecord(value, ["kind", "propertyId"]) &&
    typeof value["propertyId"] === "string"
  ) {
    return Object.freeze({ kind: "property", propertyId: value["propertyId"] });
  }
  if (
    value["kind"] === "room_type" &&
    isExactDataRecord(value, ["kind", "propertyId", "roomTypeId"]) &&
    typeof value["propertyId"] === "string" &&
    typeof value["roomTypeId"] === "string"
  ) {
    return Object.freeze({
      kind: "room_type",
      propertyId: value["propertyId"],
      roomTypeId: value["roomTypeId"],
    });
  }
  return null;
}

function normalizeTarget(target: HotelMediaResolutionTarget): HotelMediaResolutionTarget | null {
  const propertyId = normalizeUuid(target.propertyId);
  if (!propertyId) return null;
  if (target.kind === "property") return Object.freeze({ kind: "property", propertyId });
  const roomTypeId = normalizeUuid(target.roomTypeId);
  return roomTypeId ? Object.freeze({ kind: "room_type", propertyId, roomTypeId }) : null;
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function snapshotQueryRows(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  return descriptor && Object.hasOwn(descriptor, "value") && isDensePlainArray(descriptor.value)
    ? [...descriptor.value]
    : null;
}

function snapshotMediaRow(value: unknown): MediaRow | null {
  const keys = [
    "requestOrdinal",
    "resolution",
    "mediaObjectId",
    "bucket",
    "storageKey",
    "storageKind",
    "visibility",
    "purpose",
    "ownerOrganizationId",
    "propertyId",
    "lifecycleStatus",
    "contentType",
    "publicApproved",
    "variants",
  ] as const;
  if (!isExactDataRecord(value, keys)) return null;
  const requestOrdinal = value["requestOrdinal"];
  const resolution = value["resolution"];
  const nullableStrings = keys.slice(2, 12).map((key) => value[key]);
  if (
    !["scoped", "not_found", "not_authorized"].includes(resolution as string) ||
    !["number", "string"].includes(typeof requestOrdinal) ||
    !Number.isSafeInteger(Number(requestOrdinal)) ||
    Number(requestOrdinal) < 1 ||
    nullableStrings.some((item) => item !== null && typeof item !== "string") ||
    (value["publicApproved"] !== null && typeof value["publicApproved"] !== "boolean")
  ) {
    return null;
  }
  return Object.freeze({
    requestOrdinal: requestOrdinal as number | string,
    resolution: resolution as MediaRow["resolution"],
    mediaObjectId: value["mediaObjectId"] as string | null,
    bucket: value["bucket"] as string | null,
    storageKey: value["storageKey"] as string | null,
    storageKind: value["storageKind"] as string | null,
    visibility: value["visibility"] as string | null,
    purpose: value["purpose"] as string | null,
    ownerOrganizationId: value["ownerOrganizationId"] as string | null,
    propertyId: value["propertyId"] as string | null,
    lifecycleStatus: value["lifecycleStatus"] as string | null,
    contentType: value["contentType"] as string | null,
    publicApproved: value["publicApproved"] as boolean | null,
    variants: value["variants"],
  });
}

function isValidTarget(ownerOrganizationId: string, target: HotelMediaResolutionTarget): boolean {
  if (!UUID_PATTERN.test(ownerOrganizationId) || !UUID_PATTERN.test(target.propertyId)) {
    return false;
  }
  if (target.kind === "property") return true;
  if (target.kind === "room_type") return UUID_PATTERN.test(target.roomTypeId);
  return false;
}

function sameIdentifier(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function isSupportedPurpose(value: unknown): value is PropertyMediaUploadPurpose {
  return PROPERTY_MEDIA_UPLOAD_PURPOSES.includes(value as PropertyMediaUploadPurpose);
}

function isVariantRow(value: unknown): value is VariantRow {
  if (
    !isExactDataRecord(value, [
      "variantName",
      "visibility",
      "storageKey",
      "contentType",
      "publicUrl",
    ])
  ) {
    return false;
  }
  const row = value;
  return (
    typeof row["variantName"] === "string" &&
    typeof row["visibility"] === "string" &&
    typeof row["storageKey"] === "string" &&
    typeof row["contentType"] === "string" &&
    (typeof row["publicUrl"] === "string" || row["publicUrl"] === null)
  );
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isPlainDataRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  return Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isImageContentType(value: unknown): value is string {
  return typeof value === "string" && SAFE_HOTEL_IMAGE_CONTENT_TYPES.has(value);
}

function isPublicStorageKey(
  value: unknown,
  mediaObjectId: string,
  variantName: string,
  publicPathPrefix: string,
): value is string {
  const expectedPrefix = `public/${publicPathPrefix}/${mediaObjectId}/${variantName}/`;
  if (typeof value !== "string" || !value.startsWith(expectedPrefix)) return false;
  return SAFE_PUBLIC_FILENAME.test(value.slice(expectedPrefix.length));
}

type ConfiguredPublicScope = {
  bucketName: string;
  cdnOrigin: string;
  publicPathPrefix: string;
};

function configuredPublicScope(
  serving: PgHotelMediaResolverConfig["serving"],
): ConfiguredPublicScope {
  const bucketName = serving.bucketName.trim();
  const publicPathPrefix = serving.publicPathPrefix.trim().replace(/^\/+|\/+$/g, "");
  const configuredCdnBaseUrl = serving.cdnBaseUrl.trim();
  const cdn = new URL(configuredCdnBaseUrl);
  if (!bucketName || bucketName !== serving.bucketName) {
    throw new Error("Hotel media resolver bucketName must be a canonical non-empty value");
  }
  if (
    cdn.protocol !== "https:" ||
    cdn.pathname !== "/" ||
    cdn.search ||
    cdn.hash ||
    cdn.username ||
    cdn.password ||
    configuredCdnBaseUrl !== cdn.origin
  ) {
    throw new Error("Hotel media resolver cdnBaseUrl must be a canonical HTTPS origin");
  }
  if (
    !publicPathPrefix ||
    publicPathPrefix !== serving.publicPathPrefix ||
    publicPathPrefix.split("/").some((segment) => !SAFE_PATH_SEGMENT.test(segment))
  ) {
    throw new Error("Hotel media resolver publicPathPrefix must be a safe non-empty path");
  }
  return {
    bucketName,
    cdnOrigin: cdn.origin,
    publicPathPrefix,
  };
}

function isPublicCdnUrl(
  value: string | null,
  storageKey: string,
  scope: ConfiguredPublicScope,
): value is string {
  if (!value) return false;
  const expected = `${scope.cdnOrigin}/${storageKey.slice("public/".length)}`;
  return value === expected;
}
