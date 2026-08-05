import type { RoomTypeFacts } from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { pmsRoomFactsSnapshotFromRow } from "./pmsRoomFactsReadModel.js";

export type PropertySetupPmsRoomOwnerFact = Readonly<{
  roomTypeId: string;
  facts: RoomTypeFacts;
  roomFactsRevision: number;
  roomUnitsRevision: number;
  activeUnitCount: number;
  roomMediaRevision: number;
  mediaAssignmentCount: number;
  roomAmenitiesRevision: number;
  amenitiesReviewed: boolean;
}>;

export type PropertySetupPmsRoomOwnerSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  rooms: readonly PropertySetupPmsRoomOwnerFact[];
}>;

export type PropertySetupPmsInventoryOwnerSnapshot = Readonly<{
  organizationId: string;
  propertyId: string;
  calendarRevision: number;
  materializedRevision: number;
}>;

export type PropertySetupPmsOwnerReadPort = {
  getRoomOwnerSnapshot(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<PropertySetupPmsRoomOwnerSnapshot>;
  getInventoryOwnerSnapshot(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<PropertySetupPmsInventoryOwnerSnapshot | null>;
};

export type PropertySetupPmsOwnerRepository = PropertySetupPmsOwnerReadPort & {
  close(): Promise<void>;
};

type QueryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

type RoomRow = {
  authorized: boolean;
  propertyId: string | null;
  roomTypeId: string | null;
  roomFactsRevision: string | number | null;
  roomUnitsRevision: string | number | null;
  roomMediaRevision: string | number | null;
  roomAmenitiesRevision: string | number | null;
  activeUnitCount: string | number | null;
  mediaAssignmentCount: string | number | null;
  name: string | null;
  description: string | null;
  category: string | null;
  occupancyLimits: unknown;
  roomAttributes: unknown;
  amenitiesReviewedAt: Date | string | null;
  active: boolean | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

type InventoryRow = {
  authorized: boolean;
  organizationId: string | null;
  propertyId: string | null;
  calendarRevision: string | number | null;
  materializedRevision: string | number | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AUTHORIZED_SCOPE = `SELECT (
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
) AS authorized`;

export function createPgPropertySetupPmsOwnerRepository(config: {
  connectionString: string;
  pool?: QueryClient & { end(): Promise<void> };
}): PropertySetupPmsOwnerRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Property setup PMS owner repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: 4,
      connectionTimeoutMillis: 5_000,
      options: "-c statement_timeout=5000",
    });

  return {
    async getRoomOwnerSnapshot(input) {
      const scope = parseScope(input);
      const result = await pool.query<RoomRow>(
        `WITH authorized_scope AS (${AUTHORIZED_SCOPE})
         SELECT scope.authorized,
                room_type.property_id::text AS "propertyId",
                room_type.id::text AS "roomTypeId",
                room_type.room_facts_revision AS "roomFactsRevision",
                room_type.room_units_revision AS "roomUnitsRevision",
                room_type.room_media_revision AS "roomMediaRevision",
                room_type.room_amenities_revision AS "roomAmenitiesRevision",
                room_type.name,
                room_type.description,
                room_type.category,
                room_type.occupancy_limits AS "occupancyLimits",
                room_type.room_attributes AS "roomAttributes",
                room_type.room_amenities_reviewed_at AS "amenitiesReviewedAt",
                room_type.active,
                room_type.created_at AS "createdAt",
                room_type.updated_at AS "updatedAt",
                count(DISTINCT room.id) FILTER (WHERE room.status <> 'retired')::integer
                  AS "activeUnitCount",
                count(DISTINCT media.platform_media_object_id)::integer AS "mediaAssignmentCount"
           FROM authorized_scope scope
      LEFT JOIN pms.room_types room_type
             ON scope.authorized
            AND room_type.property_id = $2::uuid
            AND room_type.active
      LEFT JOIN pms.rooms room
             ON room.property_id = room_type.property_id
            AND room.room_type_id = room_type.id
      LEFT JOIN pms.room_type_media media
             ON media.property_id = room_type.property_id
            AND media.room_type_id = room_type.id
       GROUP BY scope.authorized, room_type.id
       ORDER BY room_type.id::text COLLATE "C"`,
        [scope.organizationId, scope.propertyId],
      );
      if (result.rows.length === 0 || result.rows.some((row) => row.authorized !== true)) {
        throw new Error("Property setup PMS room scope is unavailable");
      }
      const rooms = result.rows.flatMap((row) => {
        if (row.roomTypeId === null) {
          if (!validEmptyRoomSentinel(row) || result.rows.length !== 1)
            throw new Error("PMS room owner result contains a sentinel");
          return [];
        }
        return [parseRoomRow(row, scope.propertyId)];
      });
      if (new Set(rooms.map(({ roomTypeId }) => roomTypeId)).size !== rooms.length) {
        throw new Error("Property setup PMS room facts are duplicated");
      }
      return Object.freeze({ ...scope, rooms: Object.freeze(rooms) });
    },

    async getInventoryOwnerSnapshot(input) {
      const scope = parseScope(input);
      const result = await pool.query<InventoryRow>(
        `WITH authorized_scope AS (${AUTHORIZED_SCOPE})
         SELECT scope.authorized,
                coverage.organization_id::text AS "organizationId",
                coverage.property_id::text AS "propertyId",
                coverage.calendar_revision AS "calendarRevision",
                coverage.materialized_revision AS "materializedRevision"
           FROM authorized_scope scope
      LEFT JOIN pms.inventory_materialization_coverage coverage
             ON scope.authorized
            AND coverage.organization_id = $1::uuid
            AND coverage.property_id = $2::uuid`,
        [scope.organizationId, scope.propertyId],
      );
      if (result.rows.length !== 1 || result.rows[0]?.authorized !== true) {
        throw new Error("Property setup PMS inventory scope is unavailable");
      }
      const row = result.rows[0];
      if (row.propertyId === null) {
        if (!validEmptyInventorySentinel(row)) {
          throw new Error("Property setup PMS inventory owner result is malformed");
        }
        return null;
      }
      const calendarRevision = positiveRevision(row.calendarRevision);
      const materializedRevision = positiveRevision(row.materializedRevision);
      if (
        row.organizationId !== scope.organizationId ||
        row.propertyId !== scope.propertyId ||
        calendarRevision === null ||
        materializedRevision === null
      ) {
        throw new Error("Property setup PMS inventory owner result is malformed");
      }
      return Object.freeze({ ...scope, calendarRevision, materializedRevision });
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function validEmptyRoomSentinel(row: RoomRow): boolean {
  return (
    row.propertyId === null &&
    row.roomFactsRevision === null &&
    row.roomUnitsRevision === null &&
    row.roomMediaRevision === null &&
    row.roomAmenitiesRevision === null &&
    nonNegativeInteger(row.activeUnitCount) === 0 &&
    nonNegativeInteger(row.mediaAssignmentCount) === 0 &&
    row.name === null &&
    row.description === null &&
    row.category === null &&
    row.occupancyLimits === null &&
    row.roomAttributes === null &&
    row.amenitiesReviewedAt === null &&
    row.active === null &&
    row.createdAt === null &&
    row.updatedAt === null
  );
}

function validEmptyInventorySentinel(row: InventoryRow): boolean {
  return (
    row.organizationId === null &&
    row.propertyId === null &&
    row.calendarRevision === null &&
    row.materializedRevision === null
  );
}

function parseRoomRow(row: RoomRow, propertyId: string): PropertySetupPmsRoomOwnerFact {
  const roomTypeId = normalizedUuid(row.roomTypeId);
  const roomUnitsRevision = positiveRevision(row.roomUnitsRevision);
  const roomMediaRevision = positiveRevision(row.roomMediaRevision);
  const roomAmenitiesRevision = positiveRevision(row.roomAmenitiesRevision);
  const activeUnitCount = nonNegativeInteger(row.activeUnitCount);
  const mediaAssignmentCount = nonNegativeInteger(row.mediaAssignmentCount);
  const amenitiesReviewed = row.amenitiesReviewedAt !== null;
  if (
    !roomTypeId ||
    row.propertyId !== propertyId ||
    row.active !== true ||
    row.name === null ||
    row.description === null ||
    row.createdAt === null ||
    row.updatedAt === null ||
    roomUnitsRevision === null ||
    roomMediaRevision === null ||
    roomAmenitiesRevision === null ||
    activeUnitCount === null ||
    mediaAssignmentCount === null ||
    (amenitiesReviewed && roomAmenitiesRevision < 2) ||
    (!amenitiesReviewed && roomAmenitiesRevision !== 1)
  ) {
    throw new Error("Property setup PMS room owner result is malformed");
  }
  const roomFacts = pmsRoomFactsSnapshotFromRow({
    propertyId,
    roomTypeId,
    roomFactsRevision: row.roomFactsRevision!,
    active: true,
    name: row.name,
    description: row.description,
    category: row.category,
    occupancyLimits: row.occupancyLimits,
    roomAttributes: row.roomAttributes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return Object.freeze({
    roomTypeId,
    facts: roomFacts.facts,
    roomFactsRevision: roomFacts.roomFactsRevision,
    roomUnitsRevision,
    activeUnitCount,
    roomMediaRevision,
    mediaAssignmentCount,
    roomAmenitiesRevision,
    amenitiesReviewed,
  });
}

function parseScope(input: { organizationId: string; propertyId: string }) {
  const organizationId = normalizedUuid(input.organizationId);
  const propertyId = normalizedUuid(input.propertyId);
  if (!organizationId || !propertyId) throw new Error("Property setup PMS scope is malformed");
  return Object.freeze({ organizationId, propertyId });
}

function normalizedUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function positiveRevision(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : -1;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null;
}
