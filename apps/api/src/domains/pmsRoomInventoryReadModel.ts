import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type RoomInventoryQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export function createTargetPmsRoomInventoryReadPort(config: {
  connectionString: string;
  max?: number;
  pool?: RoomInventoryQueryExecutor & { end?(): Promise<void> };
}): RoomInventoryReadPort & { close?(): Promise<void> } {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 3,
    });

  return {
    async getRoomInventorySnapshot(propertyId) {
      const result = await pool.query<{ activeRoomCount: number; capturedAt: Date | string }>(
        `SELECT count(room.id)::int AS "activeRoomCount", now() AS "capturedAt"
         FROM hotel_catalog.properties property
         LEFT JOIN pms.room_types room_type
           ON room_type.property_id = property.id
          AND room_type.active = TRUE
         LEFT JOIN pms.rooms room
           ON room.property_id = property.id
          AND room.room_type_id = room_type.id
          AND room.status <> 'retired'
         WHERE property.id = $1::uuid
         GROUP BY property.id`,
        [propertyId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        propertyId,
        activeRoomCount: Number(row.activeRoomCount),
        capturedAt: new Date(row.capturedAt).toISOString(),
      };
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}
