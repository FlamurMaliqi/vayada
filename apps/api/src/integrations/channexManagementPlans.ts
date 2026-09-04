import {
  evaluateSameDayBooking,
  propertyLocalClock,
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
} from "@vayada/domain-booking";
import pg from "pg";
import {
  CHANNEX_ARI_ACTIVE_ROOM_SQL,
  CHANNEX_ARI_MAPPING_MISSING_SQL,
} from "../domains/pmsChannexAriMapping.js";
import { GOOGLE_FREE_BOOKING_LINKS_SOURCE_FINGERPRINT_SQL } from "../domains/pmsGoogleFreeBookingLinks.js";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import type { ChannexRatePlanMapping, ChannexRoomTypeMapping } from "@vayada/domain-pms-channex";
import { applyPmsChannexManagementProgress } from "../jobs/pmsChannexManagementTargetState.js";
import {
  ChannexAriMappingMissingError,
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
  googleCurrencyCompatible?: boolean;
  googleSourceFingerprint?: string;
  propertyType: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  phone: string | null;
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
  mappingMissing: boolean;
  currencyMismatch: boolean;
  stayDate: string;
  available: number;
  externalRoomTypeId: string;
  externalRatePlanId: string;
  rate: number;
  channel: string;
  markupPercent: number;
};
type SameDayPolicyRow = {
  timezone: string | null;
  enabled: boolean;
  cutoffLocalTime: string | null;
};
type BindingRow = {
  externalPropertyId: string | null;
  claimExternalPropertyId: string | null;
  claimState: string | null;
  googleBusinessProfileConfirmed: boolean;
};

type ProvisioningScope = "non_google" | "google_only" | "all";

export type ChannexBookingRevisionHandoff = (input: {
  propertyId: string;
  providerPropertyId: string;
  revisions: unknown[];
}) => Promise<void>;

export function createPgChannexManagementPlanPort(config: {
  connectionString: string;
  bookingRevisionHandoff: ChannexBookingRevisionHandoff;
  pool?: Pool;
  now?: () => Date;
}): ChannexManagementPlanPort & { close(): Promise<void> } {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  return {
    plan: (job) => plan(pool, config.bookingRevisionHandoff, job, config.now?.() ?? new Date()),
    async close() {
      await pool.end();
    },
  };
}

async function plan(
  pool: Pool,
  handoff: ChannexBookingRevisionHandoff,
  job: ChannexManagementJob,
  now: Date,
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
    return provisioningPlan(
      pool,
      job,
      externalPropertyId,
      binding?.googleBusinessProfileConfirmed ? "all" : "non_google",
    );
  }
  if (job.input.operationType === "setup_google") {
    if (!binding?.googleBusinessProfileConfirmed && !job.input.businessProfileConfirmed) {
      throw new Error("A Google Business Profile confirmation is required");
    }
    return provisioningPlan(pool, job, externalPropertyId, "google_only");
  }
  if (job.input.operationType === "sync_ari" || job.input.operationType === "update_markups") {
    return ariPlan(pool, job, externalPropertyId, now);
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
    `SELECT property.display_name AS title,
       COALESCE(profile.default_currency::text, room.currency, 'EUR') AS currency,
       property.property_type AS "propertyType", location.country_code AS country,
       location.city, location.street_address AS address, location.postal_code AS "zipCode",
       location.latitude::float8 AS latitude, location.longitude::float8 AS longitude,
       location.timezone, contact.phone
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = property.id
     LEFT JOIN LATERAL (
       SELECT value AS phone FROM hotel_catalog.property_contact_channels
       WHERE property_id = property.id AND channel_type = 'phone' AND is_public
       ORDER BY created_at LIMIT 1
     ) contact ON TRUE
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
          phone: property.phone,
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
  scope: ProvisioningScope,
): Promise<ChannexManagementActionPlan> {
  const [propertyResult, rooms, rates, deactivatedRooms, deactivatedRates] = await repeatableRead(
    pool,
    (client) =>
      Promise.all([
        client.query<PropertyRow>(
          `SELECT property.display_name AS title,
         COALESCE(profile.default_currency::text, room.currency, 'EUR') AS currency,
         profile.default_currency IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM pms.rate_plans active_plan
           JOIN pms.room_types active_room ON active_room.id = active_plan.room_type_id
           WHERE active_plan.property_id = property.id AND active_plan.active AND active_room.active
             AND active_plan.currency IS DISTINCT FROM profile.default_currency::text
         ) AS "googleCurrencyCompatible",
         ${GOOGLE_FREE_BOOKING_LINKS_SOURCE_FINGERPRINT_SQL} AS "googleSourceFingerprint",
         property.property_type AS "propertyType", location.country_code AS country,
         location.city, location.street_address AS address, location.postal_code AS "zipCode",
         location.latitude::float8 AS latitude, location.longitude::float8 AS longitude,
         location.timezone, contact.phone
       FROM hotel_catalog.properties property
       LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
       LEFT JOIN distribution.public_hotel_bookability_profiles profile
         ON profile.property_id = property.id
       LEFT JOIN LATERAL (
         SELECT value AS phone FROM hotel_catalog.property_contact_channels
         WHERE property_id = property.id AND channel_type = 'phone' AND is_public
         ORDER BY created_at LIMIT 1
       ) contact ON TRUE
       LEFT JOIN LATERAL (
         SELECT currency FROM pms.room_types WHERE property_id = property.id AND active LIMIT 1
       ) room ON TRUE WHERE property.id = $1::uuid`,
          [job.propertyId],
        ),
        client.query<RoomRow>(
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
        client.query<RateRow>(
          `SELECT plan.room_type_id::text AS "roomTypeId", room.name AS "roomTypeName",
         plan.id::text AS "ratePlanId",
         plan.name, plan.currency, 'per_room' AS "sellMode", plan.base_rate_amount::float8 AS "baseRate",
         channel.key AS channel, channel.label AS "channelLabel", 0::float8 AS "markupPercent",
         LEAST(2, GREATEST(1, COALESCE((room.occupancy_limits ->> 'maxAdults')::integer, 2))) AS "defaultOccupancy",
         room_mapping.external_room_type_id AS "externalRoomTypeId"
       FROM pms.rate_plans plan
       JOIN pms.room_types room ON room.id = plan.room_type_id
       CROSS JOIN (VALUES ('direct', 'Standard'), ('booking_com', 'BDC Standard'),
         ('airbnb', 'Airbnb Standard'), ('google_hotel', 'Google Standard')) AS channel(key, label)
       LEFT JOIN pms.channel_connections connection
         ON connection.property_id = plan.property_id AND connection.provider = 'channex'
       LEFT JOIN pms.channel_rate_plan_mappings mapping
         ON mapping.connection_id = connection.id AND mapping.rate_plan_id = plan.id
           AND mapping.channel = channel.key
       LEFT JOIN pms.channel_room_type_mappings room_mapping
         ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = plan.room_type_id
           AND room_mapping.status = 'active'
       WHERE plan.property_id = $1::uuid AND plan.active
         AND ($2::text = 'all'
           OR ($2::text = 'google_only' AND channel.key = 'google_hotel')
           OR ($2::text = 'non_google' AND channel.key <> 'google_hotel'))
         AND (mapping.id IS NULL OR mapping.status <> 'active')
       ORDER BY plan.name, channel.key`,
          [job.propertyId, scope],
        ),
        client.query<ChannexRoomTypeMapping>(
          `SELECT mapping.id::text AS "mappingId", mapping.room_type_id::text AS "roomTypeId",
         room.name AS "roomTypeName", mapping.external_room_type_id AS "externalRoomTypeId",
         mapping.status
       FROM pms.channel_room_type_mappings mapping
       JOIN pms.room_types room ON room.id = mapping.room_type_id
       JOIN pms.channel_connections connection ON connection.id = mapping.connection_id
         AND connection.property_id = mapping.property_id AND connection.provider = 'channex'
       WHERE mapping.property_id = $1::uuid AND mapping.status = 'active' AND NOT room.active
       ORDER BY mapping.id`,
          [job.propertyId],
        ),
        client.query<ChannexRatePlanMapping>(
          `SELECT mapping.id::text AS "mappingId", mapping.room_type_id::text AS "roomTypeId",
         mapping.rate_plan_id::text AS "ratePlanId", plan.name AS "ratePlanName",
         mapping.channel, mapping.external_room_type_id AS "externalRoomTypeId",
         mapping.external_rate_plan_id AS "externalRatePlanId", mapping.sell_mode AS "sellMode",
         mapping.markup_percent::float8 AS "markupPercent", mapping.status
       FROM pms.channel_rate_plan_mappings mapping
       JOIN pms.rate_plans plan ON plan.id = mapping.rate_plan_id
       JOIN pms.room_types room ON room.id = mapping.room_type_id
       JOIN pms.channel_connections connection ON connection.id = mapping.connection_id
         AND connection.property_id = mapping.property_id AND connection.provider = 'channex'
       WHERE mapping.property_id = $1::uuid AND mapping.status = 'active'
         AND (NOT room.active OR (NOT plan.active AND
           ($2::text = 'all'
             OR ($2::text = 'google_only' AND mapping.channel = 'google_hotel')
             OR ($2::text = 'non_google' AND mapping.channel <> 'google_hotel'))))
       ORDER BY mapping.id`,
          [job.propertyId, scope],
        ),
      ]),
  );
  const property = propertyResult.rows[0];
  if (!property) throw new Error("Target property was not found");
  if (
    scope !== "non_google" &&
    (property.googleCurrencyCompatible !== true ||
      rates.rows.some(
        (rate) => rate.channel === "google_hotel" && rate.currency !== property.currency,
      ))
  ) {
    throw new Error("Google rate plan currency must match the booking engine currency");
  }
  const roomIds = new Set(rooms.rows.map(({ roomTypeId }) => roomTypeId));
  const plannedRates = rates.rows.map((rate) => ({
    ...rate,
    providerTitle: providerRateTitle(rate),
  }));
  return {
    externalPropertyId,
    googleSourceFingerprint: scope === "non_google" ? undefined : property.googleSourceFingerprint,
    requests: [
      ...deactivatedRates.rows.map(channexRequests.deleteRatePlan),
      ...deactivatedRooms.rows.map(channexRequests.deleteRoomType),
      channexRequests.updateProperty(
        externalPropertyId,
        compact({
          title: property.title,
          currency: property.currency,
          property_type: property.propertyType,
          country: property.country,
          city: property.city,
          address: property.address,
          zip_code: property.zipCode,
          latitude: property.latitude,
          longitude: property.longitude,
          timezone: property.timezone,
          phone: property.phone,
        }),
      ),
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
              currency: rate.channel === "google_hotel" ? property.currency : rate.currency,
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
  now: Date,
): Promise<ChannexManagementActionPlan> {
  const policyResult = await pool.query<SameDayPolicyRow>(
    `SELECT location.timezone, COALESCE(policy.enabled, $2::boolean) AS enabled,
       CASE WHEN policy.property_id IS NULL THEN $3::text ELSE policy.cutoff_local_time END
         AS "cutoffLocalTime"
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN booking.same_day_booking_policies policy ON policy.property_id = property.id
     WHERE property.id = $1::uuid`,
    [
      job.propertyId,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.enabled,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.cutoffLocalTime,
    ],
  );
  const policy = policyResult.rows[0];
  if (!policy?.timezone) throw new Error("Canonical property timezone is unavailable");
  const from = propertyLocalClock(now, policy.timezone).date;
  const fallbackThrough = addDays(from, 365);
  const result = await pool.query<AriRow>(
    `SELECT inventory.stay_date::text AS "stayDate",
       ${CHANNEX_ARI_MAPPING_MISSING_SQL} AS "mappingMissing",
       CASE WHEN COALESCE(inventory.rate_gate_open, TRUE)
         THEN inventory.available_count ELSE 0 END AS available,
       room_mapping.external_room_type_id AS "externalRoomTypeId",
       rate_mapping.external_rate_plan_id AS "externalRatePlanId",
       plan.base_rate_amount::float8 AS rate, rate_mapping.channel,
       (rate_mapping.channel = 'google_hotel'
         AND plan.currency IS DISTINCT FROM profile.default_currency::text) AS "currencyMismatch",
       rate_mapping.markup_percent::float8 AS "markupPercent"
     FROM pms.inventory_days inventory
     JOIN pms.channel_connections connection
       ON connection.property_id = inventory.property_id AND connection.provider = 'channex'
     LEFT JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = inventory.room_type_id
       AND room_mapping.status = 'active'
     LEFT JOIN pms.channel_rate_plan_mappings rate_mapping
       ON rate_mapping.connection_id = connection.id AND rate_mapping.room_type_id = inventory.room_type_id
       AND rate_mapping.status = 'active'
     LEFT JOIN pms.rate_plans plan ON plan.id = rate_mapping.rate_plan_id
     LEFT JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = inventory.property_id
     LEFT JOIN pms.inventory_materialization_coverage coverage
       ON coverage.property_id = inventory.property_id
     WHERE inventory.property_id = $1::uuid
       AND ${CHANNEX_ARI_ACTIVE_ROOM_SQL}
       AND inventory.stay_date BETWEEN $2::date
         AND GREATEST($3::date, COALESCE(coverage.coverage_through, $3::date))
     ORDER BY inventory.stay_date`,
    [job.propertyId, from, fallbackThrough],
  );
  if (result.rows.some((row) => row.mappingMissing)) throw new ChannexAriMappingMissingError();
  if (result.rows.some((row) => row.currencyMismatch)) {
    throw new Error("Google rate plan currency no longer matches the booking engine currency");
  }
  const overrides = new Map(
    (job.input.markups ?? []).map((item) => [item.channel, item.markupPercent]),
  );
  const availability = [
    ...new Map(
      result.rows.map((row) => [
        `${row.externalRoomTypeId}:${row.stayDate}`,
        {
          property_id: externalPropertyId,
          room_type_id: row.externalRoomTypeId,
          date_from: row.stayDate,
          date_to: row.stayDate,
          availability: evaluateSameDayBooking({
            checkIn: row.stayDate,
            policy,
            propertyTimeZone: policy.timezone!,
            now,
          }).eligible
            ? row.available
            : 0,
        },
      ]),
    ).values(),
  ];
  return {
    externalPropertyId,
    requests: [
      channexRequests.updateProperty(externalPropertyId, {
        settings: {
          cut_off_time:
            policy.enabled && policy.cutoffLocalTime ? `${policy.cutoffLocalTime}:00` : null,
          cut_off_days: policy.enabled ? (policy.cutoffLocalTime ? 0 : null) : 1,
        },
      }),
      channexRequests.availability(availability),
      channexRequests.restrictions(
        result.rows.map((row) => ({
          property_id: externalPropertyId,
          rate_plan_id: row.externalRatePlanId,
          date_from: row.stayDate,
          date_to: row.stayDate,
          rate: roundCurrency(
            row.rate * (1 + (overrides.get(row.channel) ?? row.markupPercent) / 100),
          ),
        })),
      ),
    ],
  };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

async function repeatableRead<T>(
  pool: Pool,
  work: (client: Pick<Pool, "query">) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
       claim.external_property_id AS "claimExternalPropertyId", claim.claim_state AS "claimState",
       COALESCE(
         connection.connection_metadata #>> '{googleFreeBookingLinks,businessProfileConfirmedAt}',
         ''
       ) <> '' AS "googleBusinessProfileConfirmed"
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

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}
function required(value: string) {
  if (!value.trim()) throw new Error("Channex connectionString must not be empty");
  return value;
}
