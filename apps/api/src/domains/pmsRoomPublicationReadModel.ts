import {
  createRoomMediaProjectionInput,
  type HotelMediaResolutionPort,
  type ResolvedRoomMediaBatch,
} from "@vayada/domain-hotels";
import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  createRoomPublicationSnapshot,
  parseRoomAmenitiesSnapshot,
  type PmsRoomAmenityKey,
  type RoomCapacityReadPort,
  type RoomFactsReadPort,
  type RoomAmenityVocabularyValidationResult,
  type RoomAmenityVocabularyValidationPort,
  type RoomPublicationMediaSource,
  type RoomPublicationRoomSource,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsRoomPublicationReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export type PmsRoomPublicationReadModel = RoomPublicationSnapshotPort & {
  close(): Promise<void>;
};

export type PmsRoomPublicationReadModelConfig = {
  connectionString: string;
  roomFacts: RoomFactsReadPort;
  roomCapacity: RoomCapacityReadPort;
  amenityVocabulary: RoomAmenityVocabularyValidationPort;
  mediaResolver: HotelMediaResolutionPort;
  max?: number;
  pool?: PmsRoomPublicationReadPool;
};

type AuthorizedScopeRow = { authorized: boolean };
type RoomPublicationSourceRow = {
  propertyId: string;
  roomTypeId: string;
  roomMediaRevision: number | string;
  roomAmenitiesRevision: number | string;
  roomAmenitiesReviewedAt: Date | string | null;
  amenitiesSnapshot: unknown;
  assignments: unknown;
};

type StoredMediaAssignment = {
  mediaObjectId: string;
  altText: string | null;
  sortOrder: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AUTHORIZED_PUBLICATION_SCOPE_SQL = `SELECT (
  EXISTS (
    SELECT 1
    FROM identity.organizations organization
    WHERE organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM hotel_catalog.properties property
    WHERE property.id = $2::uuid
  )
  AND EXISTS (
    SELECT 1
    FROM identity.organization_resource_links link
    WHERE link.organization_id = $1::uuid
      AND link.product = 'pms'
      AND link.resource_type = 'pms_property'
      AND link.resource_id = $2::uuid::text
      AND link.relationship IN ('owner', 'operator', 'front_desk')
      AND link.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM identity.organization_resource_links link
    WHERE link.organization_id = $1::uuid
      AND link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.resource_id = $2::uuid::text
      AND link.relationship IN ('owner', 'operator')
      AND link.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'active'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL
        OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'suspended'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL
        OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
) AS authorized
/* pms_room_publication_scope */`;

const ROOM_PUBLICATION_SOURCE_SQL = `SELECT
  room_type.property_id::text AS "propertyId",
  room_type.id::text AS "roomTypeId",
  room_type.room_media_revision AS "roomMediaRevision",
  room_type.room_amenities_revision AS "roomAmenitiesRevision",
  room_type.room_amenities_reviewed_at AS "roomAmenitiesReviewedAt",
  room_type.amenities_snapshot AS "amenitiesSnapshot",
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'mediaObjectId', assignment.platform_media_object_id::text,
        'altText', assignment.alt_text,
        'sortOrder', assignment.sort_order
      )
      ORDER BY assignment.sort_order, assignment.platform_media_object_id
    ) FILTER (WHERE assignment.platform_media_object_id IS NOT NULL),
    '[]'::jsonb
  ) AS assignments
FROM pms.room_types room_type
LEFT JOIN pms.room_type_media assignment
  ON assignment.property_id = room_type.property_id
 AND assignment.room_type_id = room_type.id
WHERE room_type.property_id = $1::uuid
  AND room_type.id = ANY($2::uuid[])
  AND room_type.active
GROUP BY room_type.property_id, room_type.id
ORDER BY room_type.id
/* pms_room_publication_sources */`;

export function createPgPmsRoomPublicationReadModel(
  config: PmsRoomPublicationReadModelConfig,
): PmsRoomPublicationReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS room publication read model connectionString must not be empty");
  }
  if (
    !config.roomFacts ||
    !config.roomCapacity ||
    !config.amenityVocabulary ||
    !config.mediaResolver
  ) {
    throw new Error("PMS room publication read model requires trusted source ports");
  }
  const ownsPool = !config.pool;
  const pool: PmsRoomPublicationReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  let closed = false;

  return {
    async getRoomPublicationSnapshot(input) {
      const scope = publicationScope(input.organizationId, input.propertyId);
      await requireAuthorizedScope(pool, scope);

      const roomFacts = (await config.roomFacts.listRoomTypeFacts(scope.propertyId)).filter(
        ({ lifecycle }) => lifecycle === "active",
      );
      const roomTypeIds = roomFacts.map(({ roomTypeId }) => roomTypeId);
      const storedRows = await loadPublicationSourceRows(pool, scope.propertyId, roomTypeIds);
      const storedByRoomId = new Map(storedRows.map((row) => [row.roomTypeId, row]));
      if (storedByRoomId.size !== storedRows.length || storedRows.length !== roomFacts.length) {
        throw new Error("PMS room publication sources do not match active room facts");
      }

      const capacities = await Promise.all(
        roomFacts.map(async (facts) => {
          const capacity = await config.roomCapacity.getRoomTypeCapacity(
            scope.propertyId,
            facts.roomTypeId,
          );
          if (
            !capacity ||
            capacity.propertyId !== scope.propertyId ||
            capacity.roomTypeId !== facts.roomTypeId
          ) {
            throw new Error("PMS room publication capacity escaped its requested scope");
          }
          return capacity;
        }),
      );

      // Relationship revocation after source reads must still stop opaque media resolution.
      await requireAuthorizedScope(pool, scope);
      const rooms = await Promise.all(
        roomFacts.map(async (facts, index): Promise<RoomPublicationRoomSource> => {
          if (facts.propertyId !== scope.propertyId) {
            throw new Error("PMS room publication facts escaped their requested scope");
          }
          const stored = storedByRoomId.get(facts.roomTypeId);
          const capacity = capacities[index];
          if (!stored || !capacity) {
            throw new Error("PMS room publication source is incomplete");
          }
          const roomAmenities = roomAmenitiesFromRow(stored, scope.propertyId, facts.roomTypeId);
          if (roomAmenities.reviewed) {
            const vocabulary = parseAmenityVocabularyValidationResult(
              await config.amenityVocabulary.validateRoomAmenities(roomAmenities.amenities),
              roomAmenities.amenities,
            );
            if (!vocabulary) {
              throw new Error("PMS room amenity vocabulary returned an invalid result");
            }
            if (!vocabulary.ok) {
              throw new Error("PMS room amenities vocabulary failed publication validation");
            }
          }
          const media = await resolveRoomMedia(
            config.mediaResolver,
            scope,
            facts.roomTypeId,
            stored.roomMediaRevision,
            stored.assignments,
          );
          return { roomFacts: facts, capacity, media, roomAmenities };
        }),
      );

      // A target revoked by the media resolver must never degrade into a cross-tenant snapshot.
      await requireAuthorizedScope(pool, scope);
      await requireStablePublicationSources(config, pool, scope.propertyId, {
        roomFacts,
        capacities,
        storedRows,
      });

      return createRoomPublicationSnapshot({
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        rooms,
      });
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS room publication read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

async function requireStablePublicationSources(
  config: Pick<PmsRoomPublicationReadModelConfig, "roomFacts" | "roomCapacity">,
  pool: PmsRoomPublicationReadPool,
  propertyId: string,
  initial: {
    roomFacts: Awaited<ReturnType<RoomFactsReadPort["listRoomTypeFacts"]>>;
    capacities: readonly NonNullable<
      Awaited<ReturnType<RoomCapacityReadPort["getRoomTypeCapacity"]>>
    >[];
    storedRows: readonly RoomPublicationSourceRow[];
  },
): Promise<void> {
  const currentFacts = (await config.roomFacts.listRoomTypeFacts(propertyId)).filter(
    ({ lifecycle }) => lifecycle === "active",
  );
  const roomTypeIds = currentFacts.map(({ roomTypeId }) => roomTypeId);
  const currentCapacities = await Promise.all(
    currentFacts.map(async ({ roomTypeId }) => {
      const capacity = await config.roomCapacity.getRoomTypeCapacity(propertyId, roomTypeId);
      if (!capacity || capacity.propertyId !== propertyId || capacity.roomTypeId !== roomTypeId) {
        throw new Error("PMS room publication capacity escaped its requested scope");
      }
      return capacity;
    }),
  );
  const currentStoredRows = await loadPublicationSourceRows(pool, propertyId, roomTypeIds);
  if (
    publicationSourcesToken(propertyId, initial) !==
    publicationSourcesToken(propertyId, {
      roomFacts: currentFacts,
      capacities: currentCapacities,
      storedRows: currentStoredRows,
    })
  ) {
    throw new Error("PMS room publication sources changed while the snapshot was being built");
  }
}

function publicationSourcesToken(
  propertyId: string,
  input: {
    roomFacts: Awaited<ReturnType<RoomFactsReadPort["listRoomTypeFacts"]>>;
    capacities: readonly NonNullable<
      Awaited<ReturnType<RoomCapacityReadPort["getRoomTypeCapacity"]>>
    >[];
    storedRows: readonly RoomPublicationSourceRow[];
  },
): string {
  const facts = [...input.roomFacts]
    .map((snapshot) => {
      if (snapshot.propertyId !== propertyId || snapshot.lifecycle !== "active") {
        throw new Error("PMS room publication facts escaped their requested scope");
      }
      return [snapshot.roomTypeId, snapshot.roomFactsRevision, snapshot.facts] as const;
    })
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const capacities = [...input.capacities]
    .map((snapshot) => {
      if (snapshot.propertyId !== propertyId) {
        throw new Error("PMS room publication capacity escaped its requested scope");
      }
      return [snapshot.roomTypeId, snapshot.roomUnitsRevision, snapshot.activeUnitCount] as const;
    })
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const stored = [...input.storedRows]
    .map((row) => {
      if (row.propertyId !== propertyId) {
        throw new Error("PMS room publication storage escaped its requested scope");
      }
      const amenities = roomAmenitiesFromRow(row, propertyId, row.roomTypeId);
      return [
        row.roomTypeId,
        positiveRevision(row.roomMediaRevision),
        amenities.roomAmenitiesRevision,
        amenities.reviewedAt,
        amenities.amenities,
        snapshotMediaAssignments(row.assignments),
      ] as const;
    })
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return JSON.stringify([facts, capacities, stored]);
}

async function requireAuthorizedScope(
  pool: PmsRoomPublicationReadPool,
  scope: { organizationId: string; propertyId: string },
): Promise<void> {
  const result = await pool.query<AuthorizedScopeRow>(AUTHORIZED_PUBLICATION_SCOPE_SQL, [
    scope.organizationId,
    scope.propertyId,
  ]);
  if (
    result.rows.length !== 1 ||
    !isExactDataRecord(result.rows[0], ["authorized"]) ||
    result.rows[0]?.authorized !== true
  ) {
    throw new Error("PMS room publication scope is unavailable");
  }
}

async function loadPublicationSourceRows(
  pool: PmsRoomPublicationReadPool,
  propertyId: string,
  roomTypeIds: readonly string[],
): Promise<readonly RoomPublicationSourceRow[]> {
  if (roomTypeIds.length === 0) return Object.freeze([]);
  const result = await pool.query<RoomPublicationSourceRow>(ROOM_PUBLICATION_SOURCE_SQL, [
    propertyId,
    roomTypeIds,
  ]);
  return Object.freeze(
    result.rows.map((row) => {
      const normalizedPropertyId = readUuid(row.propertyId);
      const normalizedRoomTypeId = readUuid(row.roomTypeId);
      if (normalizedPropertyId !== propertyId || !roomTypeIds.includes(normalizedRoomTypeId)) {
        throw new Error("PMS room publication storage escaped its requested scope");
      }
      return Object.freeze({
        ...row,
        propertyId: normalizedPropertyId,
        roomTypeId: normalizedRoomTypeId,
      });
    }),
  );
}

async function resolveRoomMedia(
  resolver: HotelMediaResolutionPort,
  scope: { organizationId: string; propertyId: string },
  roomTypeId: string,
  revisionValue: number | string,
  assignmentsValue: unknown,
): Promise<RoomPublicationMediaSource> {
  const roomMediaRevision = positiveRevision(revisionValue);
  const assignments = snapshotMediaAssignments(assignmentsValue);
  const resolved = await resolver.resolvePublicMedia({
    ownerOrganizationId: scope.organizationId,
    target: { kind: "room_type", propertyId: scope.propertyId, roomTypeId },
    mediaObjectIds: assignments.map(({ mediaObjectId }) => mediaObjectId),
  });
  if (!resolved.ok) return Object.freeze({ outcome: "unavailable", roomMediaRevision });
  if (
    resolved.batch.ownerOrganizationId !== scope.organizationId ||
    resolved.batch.target.kind !== "room_type" ||
    resolved.batch.target.propertyId !== scope.propertyId ||
    resolved.batch.target.roomTypeId !== roomTypeId
  ) {
    throw new Error("PMS room publication media escaped its requested scope");
  }
  const projection = createRoomMediaProjectionInput({
    resolvedMedia: resolved.batch as ResolvedRoomMediaBatch,
    roomMediaRevision,
    assignments,
  });
  if (
    !projection ||
    projection.ownerOrganizationId !== scope.organizationId ||
    projection.propertyId !== scope.propertyId ||
    projection.roomTypeId !== roomTypeId ||
    projection.roomMediaRevision !== roomMediaRevision
  ) {
    throw new Error("PMS room publication media proof does not match its snapped scope");
  }
  return Object.freeze({ outcome: "resolved", roomMediaRevision, projection });
}

function roomAmenitiesFromRow(
  row: RoomPublicationSourceRow,
  propertyId: string,
  roomTypeId: string,
) {
  const reviewedAt =
    row.roomAmenitiesReviewedAt === null ? null : isoDate(row.roomAmenitiesReviewedAt);
  const parsed = parseRoomAmenitiesSnapshot({
    contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    roomAmenitiesRevision: positiveRevision(row.roomAmenitiesRevision),
    reviewed: reviewedAt !== null,
    amenities: row.amenitiesSnapshot,
    reviewedAt,
  });
  if (!parsed || parsed.propertyId !== propertyId || parsed.roomTypeId !== roomTypeId) {
    throw new Error("PMS room amenities storage failed publication validation");
  }
  return parsed;
}

function snapshotMediaAssignments(value: unknown): readonly StoredMediaAssignment[] {
  if (!isDensePlainArray(value) || value.length > 20) {
    throw new Error("PMS room media assignments failed publication validation");
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      const mediaObjectId = isExactDataRecord(item, ["mediaObjectId", "altText", "sortOrder"])
        ? String(item["mediaObjectId"]).toLowerCase()
        : "";
      if (
        !isExactDataRecord(item, ["mediaObjectId", "altText", "sortOrder"]) ||
        !UUID_PATTERN.test(mediaObjectId) ||
        seen.has(mediaObjectId) ||
        (item["altText"] !== null &&
          (typeof item["altText"] !== "string" || item["altText"].length > 500)) ||
        item["sortOrder"] !== index
      ) {
        throw new Error("PMS room media assignment failed publication validation");
      }
      seen.add(mediaObjectId);
      return Object.freeze({
        mediaObjectId,
        altText: item["altText"] as string | null,
        sortOrder: index,
      });
    }),
  );
}

function publicationScope(organizationId: string, propertyId: string) {
  return Object.freeze({
    organizationId: readUuid(organizationId),
    propertyId: readUuid(propertyId),
  });
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("PMS room publication scope is malformed");
  return value.toLowerCase();
}

function positiveRevision(value: number | string): number {
  const parsed =
    typeof value === "number" ? value : /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("PMS room publication revision is invalid");
  }
  return parsed;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("PMS room publication date is invalid");
  return date.toISOString();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseAmenityVocabularyValidationResult(
  value: unknown,
  requestedAmenities: readonly PmsRoomAmenityKey[],
): RoomAmenityVocabularyValidationResult | null {
  if (isExactDataRecord(value, ["ok"]) && value["ok"] === true) {
    return Object.freeze({ ok: true });
  }
  if (
    !isExactDataRecord(value, ["ok", "error"]) ||
    value["ok"] !== false ||
    !isExactDataRecord(value["error"], ["code", "unsupportedAmenityKeys"]) ||
    value["error"]["code"] !== "unsupported_room_amenity_keys"
  ) {
    return null;
  }
  const unsupported = value["error"]["unsupportedAmenityKeys"];
  if (!isDensePlainArray(unsupported) || unsupported.length === 0) return null;
  const requested = new Set<string>(requestedAmenities);
  const parsed: PmsRoomAmenityKey[] = [];
  for (const item of unsupported) {
    if (
      typeof item !== "string" ||
      !requested.has(item) ||
      (parsed.length > 0 && parsed[parsed.length - 1]! >= item)
    ) {
      return null;
    }
    parsed.push(item as PmsRoomAmenityKey);
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "unsupported_room_amenity_keys",
      unsupportedAmenityKeys: Object.freeze(parsed),
    }),
  });
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) return false;
  }
  return ownKeys.every(
    (key) =>
      key === "length" || (/^(?:0|[1-9]\d*)$/.test(String(key)) && Number(key) < value.length),
  );
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}
