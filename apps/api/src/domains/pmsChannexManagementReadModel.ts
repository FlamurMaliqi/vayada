import {
  CHANNEX_MANAGEMENT_CONTRACT_VERSION,
  type ChannexConnectedChannel,
  type ChannexManagementCapabilityModes,
  type ChannexManagementOperation,
  type ChannexManagementOperationStatus,
  type ChannexManagementOperationType,
  type ChannexManagementSnapshot,
  type ChannexSyncDomainState,
} from "@vayada/domain-pms-channex";
import pg from "pg";

export const PMS_CHANNEX_MANAGEMENT_QUEUE = "pms.channex.management";

type Pool = Pick<pg.Pool, "query" | "end">;

type ConnectionRow = {
  status: ChannexManagementSnapshot["connection"]["status"];
  externalPropertyId: string | null;
  messagingAppInstalled: boolean;
  metadata: Record<string, unknown>;
};

export type PmsChannexManagementJobRow = {
  operationId: string;
  propertyId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled" | "dead_lettered";
  attemptsMade: number;
  maxAttempts: number;
  runAfter: string | Date;
  acceptedAt: string | Date;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type PmsChannexManagementReadRepository = {
  getSnapshot(
    propertyId: string,
    capabilityModes: ChannexManagementCapabilityModes,
  ): Promise<ChannexManagementSnapshot>;
  getOperation(propertyId: string, operationId: string): Promise<ChannexManagementOperation | null>;
  close?(): Promise<void>;
};

export function createPgPmsChannexManagementReadRepository(config: {
  connectionString: string;
  pool?: Pool;
}): PmsChannexManagementReadRepository {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });

  return {
    async getSnapshot(propertyId, capabilityModes) {
      const [connection, roomMappings, rateMappings, syncRows, activeOperation] = await Promise.all(
        [
          pool.query<ConnectionRow>(
            `SELECT connection_status AS status,
                    external_property_id AS "externalPropertyId",
                    messaging_app_installed AS "messagingAppInstalled",
                    connection_metadata AS metadata
             FROM pms.channel_connections
             WHERE property_id = $1::uuid AND provider = 'channex'`,
            [propertyId],
          ),
          pool.query(
            `SELECT mapping.id::text AS "mappingId", mapping.room_type_id::text AS "roomTypeId",
                    room.name AS "roomTypeName", mapping.external_room_type_id AS "externalRoomTypeId",
                    mapping.status
             FROM pms.channel_room_type_mappings mapping
             JOIN pms.channel_connections connection
               ON connection.id = mapping.connection_id
              AND connection.property_id = mapping.property_id
              AND connection.provider = 'channex'
             JOIN pms.room_types room ON room.id = mapping.room_type_id
             WHERE mapping.property_id = $1::uuid ORDER BY room.sort_order, room.name`,
            [propertyId],
          ),
          pool.query(
            `SELECT mapping.id::text AS "mappingId", mapping.room_type_id::text AS "roomTypeId",
                    mapping.rate_plan_id::text AS "ratePlanId", plan.name AS "ratePlanName",
                    mapping.channel, mapping.external_room_type_id AS "externalRoomTypeId",
                    mapping.external_rate_plan_id AS "externalRatePlanId", mapping.sell_mode AS "sellMode",
                    mapping.markup_percent::float8 AS "markupPercent", mapping.status
             FROM pms.channel_rate_plan_mappings mapping
             JOIN pms.channel_connections connection
               ON connection.id = mapping.connection_id
              AND connection.property_id = mapping.property_id
              AND connection.provider = 'channex'
             JOIN pms.rate_plans plan ON plan.id = mapping.rate_plan_id
             WHERE mapping.property_id = $1::uuid ORDER BY plan.name, mapping.channel`,
            [propertyId],
          ),
          pool.query<{
            domain: keyof ChannexManagementSnapshot["sync"];
            state: ChannexSyncDomainState;
          }>(
            `SELECT sync_domain AS domain,
                    jsonb_build_object(
                      'status', status, 'lastAttemptAt', last_attempt_at,
                      'lastSuccessAt', last_success_at, 'lastErrorCode', last_error_code,
                      'lastErrorMessage', last_error_message, 'retryAfter', retry_after
                    ) AS state
             FROM pms.channel_sync_status sync
             JOIN pms.channel_connections connection
               ON connection.id = sync.connection_id
              AND connection.property_id = sync.property_id
              AND connection.provider = 'channex'
             WHERE sync.property_id = $1::uuid`,
            [propertyId],
          ),
          pool.query<PmsChannexManagementJobRow>(
            operationSelect("property_id = $1::uuid AND status IN ('pending', 'running')") +
              " LIMIT 1",
            [propertyId],
          ),
        ],
      );

      const row = connection.rows[0];
      const sync = emptySyncState();
      for (const item of syncRows.rows) sync[item.domain] = item.state;

      return {
        contractVersion: CHANNEX_MANAGEMENT_CONTRACT_VERSION,
        propertyId,
        connection: row
          ? {
              status: row.status,
              externalPropertyId: row.externalPropertyId,
              messagingAppInstalled: row.messagingAppInstalled,
            }
          : {
              status: "disconnected",
              externalPropertyId: null,
              messagingAppInstalled: false,
            },
        mappings: {
          roomTypes: roomMappings.rows as ChannexManagementSnapshot["mappings"]["roomTypes"],
          ratePlans: rateMappings.rows as ChannexManagementSnapshot["mappings"]["ratePlans"],
        },
        channels: connectedChannels(row?.metadata),
        markups:
          row && (row.status === "connected" || row.status === "degraded")
            ? uniqueMarkups(
                rateMappings.rows as Array<{
                  channel: string;
                  markupPercent: number;
                  status: string;
                }>,
              )
            : [],
        sync,
        capabilityModes,
        activeOperation: activeOperation.rows[0]
          ? mapPmsChannexManagementOperation(activeOperation.rows[0])
          : null,
      };
    },

    async getOperation(propertyId, operationId) {
      const result = await pool.query<PmsChannexManagementJobRow>(
        operationSelect("property_id = $1::uuid AND id = $2::uuid") + " LIMIT 1",
        [propertyId, operationId],
      );
      return result.rows[0] ? mapPmsChannexManagementOperation(result.rows[0]) : null;
    },

    async close() {
      await pool.end();
    },
  };
}

function operationSelect(where: string): string {
  return `SELECT id::text AS "operationId", property_id::text AS "propertyId", status,
                 attempts_count AS "attemptsMade", max_attempts AS "maxAttempts",
                 run_after AS "runAfter", created_at AS "acceptedAt", payload, job_metadata AS metadata
          FROM platform.jobs WHERE queue_name = '${PMS_CHANNEX_MANAGEMENT_QUEUE}' AND ${where}
          ORDER BY created_at DESC`;
}

export function mapPmsChannexManagementOperation(
  row: PmsChannexManagementJobRow,
): ChannexManagementOperation {
  const operationType = row.payload.operationType as ChannexManagementOperationType;
  const status = operationStatus(row);
  return {
    contractVersion: CHANNEX_MANAGEMENT_CONTRACT_VERSION,
    operationId: row.operationId,
    propertyId: row.propertyId,
    operationType,
    status,
    commandId: String(row.payload.commandId ?? ""),
    idempotencyKey: String(row.payload.idempotencyKey ?? ""),
    acceptedAt: iso(row.acceptedAt),
    attemptsMade: row.attemptsMade,
    maxAttempts: row.maxAttempts,
    retryAfter: status === "retry_scheduled" ? iso(row.runAfter) : null,
    lastError:
      typeof row.metadata.lastErrorCode === "string"
        ? {
            code: row.metadata.lastErrorCode,
            message: String(row.metadata.lastErrorMessage ?? "Provider operation failed."),
          }
        : null,
  };
}

function operationStatus(row: PmsChannexManagementJobRow): ChannexManagementOperationStatus {
  if (row.status === "pending") return row.attemptsMade > 0 ? "retry_scheduled" : "queued";
  if (row.status === "canceled") return "failed";
  return row.status;
}

function emptySyncState(): ChannexManagementSnapshot["sync"] {
  const idle = (): ChannexSyncDomainState => ({
    status: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    retryAfter: null,
  });
  return { booking: idle(), ari: idle(), message: idle(), mapping: idle() };
}

function connectedChannels(
  metadata: Record<string, unknown> | undefined,
): ChannexConnectedChannel[] {
  if (!Array.isArray(metadata?.connectedChannels)) return [];
  return metadata.connectedChannels.filter(isConnectedChannel);
}

function isConnectedChannel(value: unknown): value is ChannexConnectedChannel {
  if (!value || typeof value !== "object") return false;
  const channel = value as Record<string, unknown>;
  return (
    typeof channel.key === "string" &&
    typeof channel.application === "string" &&
    (typeof channel.title === "string" || channel.title === null) &&
    typeof channel.isActive === "boolean"
  );
}

function uniqueMarkups(rows: Array<{ channel: string; markupPercent: number; status: string }>) {
  return [
    ...new Map(
      rows
        .filter((row) => row.status === "active" && row.channel !== "direct")
        .map((row) => [row.channel, row.markupPercent]),
    ).entries(),
  ].map(([channel, markupPercent]) => ({ channel, markupPercent }));
}

function required(value: string): string {
  if (!value.trim()) throw new Error("PMS Channex connectionString must not be empty");
  return value;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
