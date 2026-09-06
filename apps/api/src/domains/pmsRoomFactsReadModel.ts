import type { QueryResult, QueryResultRow } from "pg";
import pg from "pg";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseDraftRoomId,
  parseDraftRoomTypeBinding,
  parsePhysicalRoomUnitIdentity,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  type DraftRoomTypeBindingReadPort,
  type PhysicalRoomUnitIdentityReadPort,
  type RoomCapacityReadPort,
  type RoomFactsReadPort,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";

export type PmsRoomFactsReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export type PmsRoomFactsReadModel = RoomFactsReadPort &
  DraftRoomTypeBindingReadPort &
  PhysicalRoomUnitIdentityReadPort &
  RoomCapacityReadPort & { close(): Promise<void> };

export type PmsRoomFactsRow = {
  propertyId: string;
  roomTypeId: string;
  roomFactsRevision: number | string;
  active: boolean;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: unknown;
  roomAttributes: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type DraftRoomBindingRow = {
  propertyId: string;
  draftRoomId: string;
  roomTypeId: string;
};

type PhysicalRoomUnitRow = {
  propertyId: string;
  roomTypeId: string;
  roomUnitId: string;
  status: string;
  operationalLabel: string | null;
  operationalLabelStatus: string;
};

type CapacityRow = {
  propertyId: string;
  roomTypeId: string;
  roomUnitsRevision: number | string;
  activeUnitCount: number | string;
  invalidStatusCount: number | string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_PHYSICAL_ROOM_STATUSES = ["available", "maintenance", "out_of_order"] as const;

const ROOM_FACTS_SELECT = `SELECT
  room_type.property_id::text AS "propertyId",
  room_type.id::text AS "roomTypeId",
  room_type.room_facts_revision AS "roomFactsRevision",
  room_type.active,
  room_type.name,
  room_type.description,
  room_type.category,
  room_type.occupancy_limits AS "occupancyLimits",
  room_type.room_attributes AS "roomAttributes",
  room_type.created_at AS "createdAt",
  room_type.updated_at AS "updatedAt"
FROM pms.room_types room_type`;

export function createPgPmsRoomFactsReadModel(config: {
  connectionString: string;
  max?: number;
  pool?: PmsRoomFactsReadPool;
  now?: () => Date;
}): PmsRoomFactsReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS room facts read model connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsRoomFactsReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async getRoomTypeFacts(propertyId, roomTypeId) {
      const scope = roomTypeReadScope(propertyId, roomTypeId);
      const result = await pool.query<PmsRoomFactsRow>(
        `${ROOM_FACTS_SELECT}
         WHERE room_type.property_id = $1::uuid
           AND room_type.id = $2::uuid`,
        [scope.propertyId, scope.roomTypeId],
      );
      if (result.rows.length > 1) throw new Error("PMS room facts read returned duplicate rows");
      if (!result.rows[0]) return null;
      const snapshot = pmsRoomFactsSnapshotFromRow(result.rows[0]);
      assertRoomTypeScope(snapshot, scope);
      return snapshot;
    },

    async listRoomTypeFacts(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      const result = await pool.query<PmsRoomFactsRow>(
        `${ROOM_FACTS_SELECT}
         WHERE room_type.property_id = $1::uuid
           AND room_type.active
         ORDER BY room_type.created_at ASC, room_type.id ASC`,
        [normalizedPropertyId],
      );
      return Object.freeze(
        result.rows.map((row) => {
          const snapshot = pmsRoomFactsSnapshotFromRow(row);
          if (snapshot.propertyId !== normalizedPropertyId) {
            throw new Error("PMS room facts list escaped its property scope");
          }
          return snapshot;
        }),
      );
    },

    async getDraftRoomTypeBinding(propertyId, draftRoomId) {
      const normalizedPropertyId = readUuid(propertyId);
      const normalizedDraftRoomId = parseDraftRoomId(draftRoomId);
      if (!normalizedDraftRoomId) throw new Error("PMS draft-room binding scope is malformed");
      const result = await pool.query<DraftRoomBindingRow>(
        `SELECT
           room_type.property_id::text AS "propertyId",
           room_type.setup_draft_room_id AS "draftRoomId",
           room_type.id::text AS "roomTypeId"
         FROM pms.room_types room_type
         WHERE room_type.property_id = $1::uuid
           AND room_type.setup_draft_room_id = $2`,
        [normalizedPropertyId, normalizedDraftRoomId],
      );
      if (result.rows.length > 1) throw new Error("PMS draft-room binding is not unique");
      if (!result.rows[0]) return null;
      const parsed = parseDraftRoomTypeBinding(result.rows[0]);
      if (!parsed) throw new Error("PMS draft-room binding failed contract validation");
      if (
        parsed.propertyId !== normalizedPropertyId ||
        parsed.draftRoomId !== normalizedDraftRoomId
      ) {
        throw new Error("PMS draft-room binding escaped its requested scope");
      }
      return parsed;
    },

    async listPhysicalRoomUnitIdentities(propertyId, roomTypeId) {
      const scope = roomTypeReadScope(propertyId, roomTypeId);
      const result = await pool.query<PhysicalRoomUnitRow>(
        `SELECT
           room.property_id::text AS "propertyId",
           room.room_type_id::text AS "roomTypeId",
           room.id::text AS "roomUnitId",
           room.status,
           room.room_number AS "operationalLabel",
           room.operational_label_status AS "operationalLabelStatus"
         FROM pms.rooms room
         WHERE room.property_id = $1::uuid
           AND room.room_type_id = $2::uuid
         ORDER BY room.sort_order ASC, room.id ASC`,
        [scope.propertyId, scope.roomTypeId],
      );
      return Object.freeze(
        result.rows.map((row) => {
          const lifecycle = physicalRoomLifecycle(row.status);
          const parsed = parsePhysicalRoomUnitIdentity({
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            propertyId: row.propertyId,
            roomTypeId: row.roomTypeId,
            roomUnitId: row.roomUnitId,
            lifecycle,
            operationalLabel: row.operationalLabel,
            operationalLabelStatus: row.operationalLabelStatus,
          });
          if (!parsed) throw new Error("PMS physical-room identity failed contract validation");
          assertRoomTypeScope(parsed, scope);
          return parsed;
        }),
      );
    },

    async getRoomTypeCapacity(propertyId, roomTypeId) {
      const scope = roomTypeReadScope(propertyId, roomTypeId);
      const result = await pool.query<CapacityRow>(
        `SELECT
           room_type.property_id::text AS "propertyId",
           room_type.id::text AS "roomTypeId",
           room_type.room_units_revision AS "roomUnitsRevision",
           count(room.id) FILTER (WHERE room.status <> 'retired')::integer AS "activeUnitCount",
           count(room.id) FILTER (
             WHERE room.status IS NULL
                OR room.status NOT IN ('available', 'maintenance', 'out_of_order', 'retired')
           )::integer AS "invalidStatusCount"
         FROM pms.room_types room_type
         LEFT JOIN pms.rooms room
           ON room.property_id = room_type.property_id
          AND room.room_type_id = room_type.id
         WHERE room_type.property_id = $1::uuid
           AND room_type.id = $2::uuid
         GROUP BY room_type.property_id, room_type.id, room_type.room_units_revision`,
        [scope.propertyId, scope.roomTypeId],
      );
      if (result.rows.length > 1) throw new Error("PMS room capacity returned duplicate rows");
      const row = result.rows[0];
      if (!row) return null;
      if (nonNegativeInteger(row.invalidStatusCount) !== 0) {
        throw new Error("PMS room capacity contains an invalid physical-room status");
      }
      const capturedAt = now();
      const parsed = parseRoomTypeCapacitySnapshot({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId: row.propertyId,
        roomTypeId: row.roomTypeId,
        roomUnitsRevision: positiveInteger(row.roomUnitsRevision),
        activeUnitCount: nonNegativeInteger(row.activeUnitCount),
        capturedAt: validDate(capturedAt) ? capturedAt.toISOString() : null,
      });
      if (!parsed) throw new Error("PMS room capacity failed contract validation");
      assertRoomTypeScope(parsed, scope);
      return parsed;
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS room facts read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

export function pmsRoomFactsSnapshotFromRow(row: PmsRoomFactsRow): RoomTypeFactsSnapshot {
  if (typeof row.active !== "boolean") {
    throw new Error("PMS room facts lifecycle failed contract validation");
  }
  const occupancy = dataRecord(row.occupancyLimits);
  const attributes = dataRecord(row.roomAttributes);
  const maxGuests = occupancy?.["total"];
  const parsed = parseRoomTypeFactsSnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    roomFactsRevision: positiveInteger(row.roomFactsRevision),
    lifecycle: row.active ? "active" : "inactive",
    facts: {
      name: row.name,
      description: row.description,
      category: row.category,
      occupancy: {
        maxGuests,
        maxAdults: occupancy?.["adults"] ?? maxGuests,
        maxChildren: occupancy?.["children"] ?? maxGuests,
      },
      beds: attributes?.["beds"] ?? legacyBeds(attributes?.["bedType"]),
      bedrooms: attributes?.["bedrooms"],
      bathrooms: attributes?.["bathrooms"],
      bathroomType: attributes?.["bathroomType"],
      size: legacyRoomSize(attributes?.["size"]),
    },
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  });
  if (!parsed) throw new Error("PMS room facts row failed contract validation");
  return parsed;
}

function legacyBeds(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const beds = new Map<string, number>();
  for (const item of value.split(",")) {
    const match = /^([1-9]\d*)\s+(.+)$/.exec(item.trim());
    if (!match) return undefined;
    const type = match[2]!
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!type) return undefined;
    beds.set(type, (beds.get(type) ?? 0) + Number(match[1]));
  }
  return Array.from(beds, ([type, quantity]) => ({ type, quantity }));
}

function legacyRoomSize(value: unknown): unknown {
  return typeof value === "number" ? { value, unit: "sqm" } : value;
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  })
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: number | string): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function nonNegativeInteger(value: number | string): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isoDate(value: Date | string): string | null {
  if (typeof value === "string") return value;
  return validDate(value) ? value.toISOString() : null;
}

function databaseInteger(value: number | string): number {
  if (typeof value === "number") return value;
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("PMS room facts read scope is malformed");
  return value.toLowerCase();
}

function roomTypeReadScope(propertyId: string, roomTypeId: string) {
  return Object.freeze({ propertyId: readUuid(propertyId), roomTypeId: readUuid(roomTypeId) });
}

function assertRoomTypeScope(
  value: { readonly propertyId: string; readonly roomTypeId: string },
  scope: { readonly propertyId: string; readonly roomTypeId: string },
): void {
  if (value.propertyId !== scope.propertyId || value.roomTypeId !== scope.roomTypeId) {
    throw new Error("PMS room facts read escaped its requested scope");
  }
}

function physicalRoomLifecycle(status: string): "active" | "retired" {
  if (status === "retired") return "retired";
  if (
    ACTIVE_PHYSICAL_ROOM_STATUSES.includes(status as (typeof ACTIVE_PHYSICAL_ROOM_STATUSES)[number])
  ) {
    return "active";
  }
  throw new Error("PMS physical-room identity has an invalid status");
}
