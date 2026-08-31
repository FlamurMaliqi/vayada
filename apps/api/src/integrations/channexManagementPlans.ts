import pg from "pg";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { applyPmsChannexManagementProgress } from "../jobs/pmsChannexManagementTargetState.js";
import {
  channexRequests,
  type ChannexManagementActionPlan,
  type ChannexManagementPlanPort,
} from "./channexManagement.js";

type Pool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<Pick<Pool, "query"> & { release(): void }>;
  end(): Promise<void>;
};
type PropertyRow = {
  title: string;
  currency: string;
  propertyType: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
};
type RoomRow = {
  roomTypeId: string;
  name: string;
  currency: string;
  countOfRooms: number;
  adults: number;
  children: number;
};
type RateRow = {
  roomTypeId: string;
  roomTypeName: string;
  ratePlanId: string;
  name: string;
  currency: string;
  sellMode: "per_room" | "per_person";
  baseRate: number;
  channel: string;
  channelLabel: string;
  markupPercent: number;
  defaultOccupancy: number;
  externalRoomTypeId: string | null;
};
type AriRow = {
  stayDate: string | Date;
  available: number;
  externalRoomTypeId: string;
  externalRatePlanId: string;
  rate: number;
  channel: string;
  markupPercent: number;
};
type BindingRow = {
  externalPropertyId: string | null;
  claimExternalPropertyId: string | null;
  claimState: string | null;
};

export type ChannexBookingRevisionHandoff = (input: {
  propertyId: string;
  providerPropertyId: string;
  revisions: unknown[];
}) => Promise<void>;

export function createPgChannexManagementPlanPort(config: {
  connectionString: string;
  bookingRevisionHandoff: ChannexBookingRevisionHandoff;
  pool?: Pool;
}): ChannexManagementPlanPort & { close(): Promise<void> } {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  return {
    plan: (job) => plan(pool, config.bookingRevisionHandoff, job),
    async close() {
      await pool.end();
    },
  };
}

async function plan(
  pool: Pool,
  handoff: ChannexBookingRevisionHandoff,
  job: ChannexManagementJob,
): Promise<ChannexManagementActionPlan> {
  const binding = await connectionBinding(pool, job.propertyId);
  const externalPropertyId = activeExternalPropertyId(binding);
  if (job.input.operationType === "enable") {
    if (!externalPropertyId && binding?.claimExternalPropertyId)
      throw new Error("A retained Channex binding claim requires audited repair");
    return externalPropertyId ? { externalPropertyId, requests: [] } : enablePlan(pool, job);
  }
  if (job.input.operationType === "disable") {
    return externalPropertyId
      ? {
          externalPropertyId,
          requests: [channexRequests.deleteProperty(externalPropertyId)],
          checkpoint: checkpoint(pool, job),
        }
      : { requests: [] };
  }
  if (!externalPropertyId) throw new Error("Channex connection is not enabled");
  if (job.input.operationType === "provision") {
    return provisioningPlan(pool, job, externalPropertyId);
  }
  if (job.input.operationType === "sync_ari" || job.input.operationType === "update_markups") {
    return ariPlan(pool, job, externalPropertyId);
  }
  if (job.input.operationType === "sync_bookings") {
    return {
      externalPropertyId,
      requests: [channexRequests.bookingRevisionFeed(externalPropertyId)],
      bookingRevisionHandoff: (revisions) =>
        handoff({ propertyId: job.propertyId, providerPropertyId: externalPropertyId, revisions }),
    };
  }
  return {
    externalPropertyId,
    requests: [
      channexRequests.listInstalledApplications(externalPropertyId),
      channexRequests.installMessaging(externalPropertyId),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function enablePlan(
  pool: Pool,
  job: ChannexManagementJob,
): Promise<ChannexManagementActionPlan> {
  const result = await pool.query<PropertyRow>(
    `SELECT property.display_name AS title, COALESCE(room.currency, 'EUR') AS currency,
       property.property_type AS "propertyType", location.country_code AS country,
       location.city, location.street_address AS address, location.postal_code AS "zipCode",
       location.latitude::float8 AS latitude, location.longitude::float8 AS longitude,
       location.timezone
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN LATERAL (
       SELECT currency FROM pms.room_types WHERE property_id = property.id AND active LIMIT 1
     ) room ON TRUE WHERE property.id = $1::uuid`,
    [job.propertyId],
  );
  const property = result.rows[0];
  if (!property) throw new Error("Target property was not found");
  const providerPropertyTitle = providerTitle(property.title, job.propertyId);
  return {
    requests: [
      channexRequests.findProperty(providerPropertyTitle),
      channexRequests.createProperty(
        compact({
          title: providerPropertyTitle,
          currency: property.currency,
          property_type: property.propertyType,
          country: property.country,
          city: property.city,
          address: property.address,
          zip_code: property.zipCode,
          latitude: property.latitude,
          longitude: property.longitude,
          timezone: property.timezone,
        }),
      ),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function provisioningPlan(
  pool: Pool,
  job: ChannexManagementJob,
  externalPropertyId: string,
): Promise<ChannexManagementActionPlan> {
  const [rooms, rates] = await Promise.all([
    pool.query<RoomRow>(
      `SELECT room.id::text AS "roomTypeId", room.name, room.currency,
         count(unit.id)::integer AS "countOfRooms",
         COALESCE((room.occupancy_limits ->> 'maxAdults')::integer, 2) AS adults,
         COALESCE((room.occupancy_limits ->> 'maxChildren')::integer, 0) AS children
       FROM pms.room_types room LEFT JOIN pms.rooms unit
         ON unit.room_type_id = room.id AND unit.status <> 'retired'
       LEFT JOIN pms.channel_connections connection
         ON connection.property_id = room.property_id AND connection.provider = 'channex'
       LEFT JOIN pms.channel_room_type_mappings mapping
         ON mapping.connection_id = connection.id AND mapping.room_type_id = room.id
       WHERE room.property_id = $1::uuid AND room.active
         AND (mapping.id IS NULL OR mapping.status <> 'active')
       GROUP BY room.id ORDER BY room.sort_order, room.name`,
      [job.propertyId],
    ),
    pool.query<RateRow>(
      `SELECT plan.room_type_id::text AS "roomTypeId", room.name AS "roomTypeName",
         plan.id::text AS "ratePlanId",
         plan.name, plan.currency, 'per_room' AS "sellMode", plan.base_rate_amount::float8 AS "baseRate",
         channel.key AS channel, channel.label AS "channelLabel", 0::float8 AS "markupPercent",
         LEAST(2, GREATEST(1, COALESCE((room.occupancy_limits ->> 'maxAdults')::integer, 2))) AS "defaultOccupancy",
         room_mapping.external_room_type_id AS "externalRoomTypeId"
       FROM pms.rate_plans plan
       JOIN pms.room_types room ON room.id = plan.room_type_id
       CROSS JOIN (VALUES ('direct', 'Standard'), ('booking_com', 'BDC Standard'),
         ('airbnb', 'Airbnb Standard')) AS channel(key, label)
       LEFT JOIN pms.channel_connections connection
         ON connection.property_id = plan.property_id AND connection.provider = 'channex'
       LEFT JOIN pms.channel_rate_plan_mappings mapping
         ON mapping.connection_id = connection.id AND mapping.rate_plan_id = plan.id
           AND mapping.channel = channel.key
       LEFT JOIN pms.channel_room_type_mappings room_mapping
         ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = plan.room_type_id
           AND room_mapping.status = 'active'
       WHERE plan.property_id = $1::uuid AND plan.active
         AND (mapping.id IS NULL OR mapping.status <> 'active')
       ORDER BY plan.name, channel.key`,
      [job.propertyId],
    ),
  ]);
  const roomIds = new Set(rooms.rows.map(({ roomTypeId }) => roomTypeId));
  const plannedRates = rates.rows.map((rate) => ({
    ...rate,
    providerTitle: providerRateTitle(rate),
  }));
  return {
    externalPropertyId,
    requests: [
      ...rooms.rows.flatMap((room) => {
        const title = providerTitle(room.name, room.roomTypeId);
        return [
          channexRequests.listRoomTypes(externalPropertyId, [
            { roomTypeId: room.roomTypeId, roomTypeName: title },
          ]),
          channexRequests.createRoomType({
            roomTypeId: room.roomTypeId,
            roomTypeName: title,
            roomType: {
              property_id: externalPropertyId,
              title,
              count_of_rooms: Math.max(1, room.countOfRooms),
              occ_adults: Math.max(1, room.adults),
              occ_children: Math.max(0, room.children),
              occ_infants: 0,
              default_occupancy: Math.min(2, Math.max(1, room.adults)),
              room_kind: "room",
            },
          }),
        ];
      }),
      ...plannedRates
        .filter(
          ({ roomTypeId, externalRoomTypeId }) =>
            roomIds.has(roomTypeId) || Boolean(externalRoomTypeId),
        )
        .flatMap((rate) => [
          channexRequests.listRatePlans(externalPropertyId, [
            {
              roomTypeId: rate.roomTypeId,
              ratePlanId: rate.ratePlanId,
              ratePlanName: rate.name,
              providerTitle: rate.providerTitle,
              channel: rate.channel,
              sellMode: rate.sellMode,
              markupPercent: rate.markupPercent,
              externalRoomTypeId: rate.externalRoomTypeId ?? undefined,
            },
          ]),
          channexRequests.createRatePlan({
            ...rate,
            ratePlanName: rate.name,
            externalRoomTypeId: rate.externalRoomTypeId ?? undefined,
            ratePlan: {
              property_id: externalPropertyId,
              title: rate.providerTitle,
              sell_mode: rate.sellMode,
              rate_mode: "manual",
              currency: rate.currency,
              options: [
                { occupancy: rate.defaultOccupancy, is_primary: true, rate: rate.baseRate },
              ],
              meal_type: "room_only",
            },
          }),
        ]),
      channexRequests.listChannels(externalPropertyId),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function ariPlan(
  pool: Pool,
  job: ChannexManagementJob,
  externalPropertyId: string,
): Promise<ChannexManagementActionPlan> {
  const result = await pool.query<AriRow>(
    `SELECT inventory.stay_date AS "stayDate", inventory.available_count AS available,
       room_mapping.external_room_type_id AS "externalRoomTypeId",
       rate_mapping.external_rate_plan_id AS "externalRatePlanId",
       plan.base_rate_amount::float8 AS rate, rate_mapping.channel,
       rate_mapping.markup_percent::float8 AS "markupPercent"
     FROM pms.inventory_days inventory
     JOIN pms.channel_connections connection
       ON connection.property_id = inventory.property_id AND connection.provider = 'channex'
     JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = inventory.room_type_id
     JOIN pms.channel_rate_plan_mappings rate_mapping
       ON rate_mapping.connection_id = connection.id AND rate_mapping.room_type_id = inventory.room_type_id
     JOIN pms.rate_plans plan ON plan.id = rate_mapping.rate_plan_id
     WHERE inventory.property_id = $1::uuid AND inventory.stay_date BETWEEN current_date AND current_date + 365
       AND room_mapping.status = 'active' AND rate_mapping.status = 'active'
     ORDER BY inventory.stay_date`,
    [job.propertyId],
  );
  const overrides = new Map(
    (job.input.markups ?? []).map((item) => [item.channel, item.markupPercent]),
  );
  const availability = [
    ...new Map(
      result.rows.map((row) => [
        `${row.externalRoomTypeId}:${date(row.stayDate)}`,
        {
          property_id: externalPropertyId,
          room_type_id: row.externalRoomTypeId,
          date_from: date(row.stayDate),
          date_to: date(row.stayDate),
          availability: row.available,
        },
      ]),
    ).values(),
  ];
  return {
    externalPropertyId,
    requests: [
      channexRequests.availability(availability),
      channexRequests.restrictions(
        result.rows.map((row) => ({
          property_id: externalPropertyId,
          rate_plan_id: row.externalRatePlanId,
          date_from: date(row.stayDate),
          date_to: date(row.stayDate),
          rate: roundCurrency(
            row.rate * (1 + (overrides.get(row.channel) ?? row.markupPercent) / 100),
          ),
        })),
      ),
    ],
  };
}

function checkpoint(pool: Pool, job: ChannexManagementJob) {
  return async (progress: Parameters<typeof applyPmsChannexManagementProgress>[2]) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyPmsChannexManagementProgress(client, job, progress, new Date());
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

function providerTitle(title: string, identity: string) {
  const marker = ` [Vayada:${identity}]`;
  return `${Array.from(title)
    .slice(0, Math.max(0, 255 - marker.length))
    .join("")}${marker}`;
}

function providerRateTitle(rate: RateRow) {
  return providerTitle(
    `${rate.roomTypeName} - ${rate.name} - ${rate.channelLabel}`,
    `${rate.roomTypeId}:${rate.channel}:${rate.ratePlanId}`,
  );
}

async function connectionBinding(pool: Pool, propertyId: string): Promise<BindingRow | null> {
  const result = await pool.query<BindingRow>(
    `SELECT connection.external_property_id AS "externalPropertyId",
       claim.external_property_id AS "claimExternalPropertyId", claim.claim_state AS "claimState"
     FROM hotel_catalog.properties property
     LEFT JOIN pms.channel_connections connection
       ON connection.property_id = property.id AND connection.provider = 'channex'
     LEFT JOIN pms.channel_binding_claims claim
       ON claim.property_id = property.id AND claim.provider = 'channex'
     WHERE property.id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function activeExternalPropertyId(binding: BindingRow | null): string | null {
  if (!binding?.externalPropertyId) return null;
  if (
    binding.claimState !== "active" ||
    binding.claimExternalPropertyId !== binding.externalPropertyId
  )
    throw new Error("Channex binding claim is not active");
  return binding.externalPropertyId;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  );
}

function date(value: string | Date) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}
function required(value: string) {
  if (!value.trim()) throw new Error("Channex connectionString must not be empty");
  return value;
}
