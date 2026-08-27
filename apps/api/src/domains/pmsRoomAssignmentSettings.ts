import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsRoomAssignmentSettings = {
  propertyId: string;
  autoRearrangeEnabled: boolean;
  updatedAt: string | null;
};

export type PmsRoomAssignmentSettingsPort = {
  find(propertyId: string): Promise<PmsRoomAssignmentSettings | null>;
  update(propertyId: string, enabled: boolean): Promise<PmsRoomAssignmentSettings | null>;
  close?(): Promise<void>;
};

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type Row = QueryResultRow & {
  propertyId: string;
  autoRearrangeEnabled: boolean;
  updatedAt: Date | string | null;
};

export function createPgPmsRoomAssignmentSettingsPort(config: {
  connectionString?: string;
  max?: number;
  pool?: Pool;
}): PmsRoomAssignmentSettingsPort {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS room-assignment settings connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async find(propertyId) {
      const result = await pool.query<Row>(
        `SELECT property_id::text AS "propertyId",
                auto_rearrange_enabled AS "autoRearrangeEnabled",
                updated_at AS "updatedAt"
         FROM pms.effective_room_assignment_optimization_settings
         WHERE property_id = $1::uuid`,
        [propertyId],
      );
      return result.rows[0] ? toSettings(result.rows[0]) : null;
    },
    async update(propertyId, enabled) {
      const result = await pool.query<Row>(
        `INSERT INTO pms.room_assignment_optimization_settings (
           property_id, auto_rearrange_enabled, updated_at
         )
         SELECT id, $2, now()
         FROM hotel_catalog.properties
         WHERE id = $1::uuid
         ON CONFLICT (property_id) DO UPDATE
         SET auto_rearrange_enabled = EXCLUDED.auto_rearrange_enabled,
             updated_at = EXCLUDED.updated_at
         RETURNING property_id::text AS "propertyId",
                   auto_rearrange_enabled AS "autoRearrangeEnabled",
                   updated_at AS "updatedAt"`,
        [propertyId, enabled],
      );
      return result.rows[0] ? toSettings(result.rows[0]) : null;
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function toSettings(row: Row): PmsRoomAssignmentSettings {
  return {
    propertyId: row.propertyId,
    autoRearrangeEnabled: row.autoRearrangeEnabled,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ?? null),
  };
}
