import type { FastifyInstance, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { PlatformPropertyLifecycleStatus } from "@vayada/domain-hotels";

import { enforceRoutePolicy } from "../../../policy.js";

export type PlatformAdminBookingStatus = "pending" | "accepted" | "rejected" | "withdrawn";
export type PlatformAdminPropertyStatus = "live" | "demo" | "test";
export type PlatformAdminGrowthGranularity = "daily" | "weekly" | "monthly";

export type PlatformAdminBookingRow = {
  id: string;
  bookingReference: string;
  hotelId: string;
  hotelName: string;
  hotelSlug: string;
  guestName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalAmount: number;
  currency: string;
  status: PlatformAdminBookingStatus;
  rawStatus: string;
  channel: string;
  requestedAt: string;
  respondedAt: string | null;
};

export type PlatformAdminProperty = {
  id: string;
  name: string;
  slug: string;
  status: PlatformAdminPropertyStatus;
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number;
  ownerAccountUserIds: string[];
  createdAt: string;
};

export type PlatformAdminGrowthDashboard = {
  properties: PlatformAdminProperty[];
  selectedPropertyIds: string[];
  excludeTestData: boolean;
  granularity: PlatformAdminGrowthGranularity;
  bookingPropertyId: string | null;
  metrics: {
    key: string;
    label: string;
    value: string;
    rawValue: number | null;
    delta: { value: number | null; label: string } | null;
  }[];
  pageViews: { key: string; label: string; value: number }[];
  bookingRequests: { key: string; label: string; value: number }[];
  liveProperties: { key: string; label: string; value: number }[];
  emptyMessage: string | null;
};

export type PlatformAdminDashboardRepository = {
  listBookings(input: {
    status?: PlatformAdminBookingStatus;
    limit: number;
    offset: number;
  }): Promise<PlatformAdminBookingRow[]>;
  listGrowthProperties(input: { excludeTestData: boolean }): Promise<PlatformAdminProperty[]>;
  close?(): Promise<void>;
};

export type PlatformAdminDashboardRoutesOptions = {
  repository?: PlatformAdminDashboardRepository;
};

export type PlatformAdminDashboardPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type BookingListQuery = {
  status?: string;
  limit?: string;
  offset?: string;
};

type GrowthQuery = {
  granularity?: string;
  exclude_test_data?: string;
  property_ids?: string | string[];
  booking_property_id?: string;
};

type PlatformAdminBookingDbRow = Omit<
  PlatformAdminBookingRow,
  "totalAmount" | "requestedAt" | "respondedAt"
> & {
  totalAmount: string | number | null;
  requestedAt: Date | string;
  respondedAt: Date | string | null;
};

type PlatformAdminPropertyDbRow = Omit<PlatformAdminProperty, "createdAt" | "lifecycleRevision"> & {
  createdAt: Date | string;
  lifecycleRevision: number | string;
};

const PLATFORM_ADMIN_RESOURCE = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;

const BOOKING_LIMIT_DEFAULT = 50;
const BOOKING_LIMIT_MAX = 500;

export async function registerPlatformAdminDashboardRoutes(
  app: FastifyInstance,
  options: PlatformAdminDashboardRoutesOptions = {},
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.repository?.close?.();
  });

  app.get<{ Querystring: BookingListQuery }>("/bookings", async (request) => {
    requirePlatformAdminRead(request);
    const query = parseBookingQuery(request.query);
    const bookings = options.repository ? await options.repository.listBookings(query) : [];
    return { bookings };
  });

  app.get<{ Querystring: GrowthQuery }>("/growth", async (request) => {
    requirePlatformAdminRead(request);
    const query = parseGrowthQuery(request.query);
    const properties = options.repository
      ? await options.repository.listGrowthProperties({ excludeTestData: query.excludeTestData })
      : [];

    return toGrowthDashboard(query, properties);
  });
}

export function createTargetPlatformAdminDashboardRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PlatformAdminDashboardPool;
}): PlatformAdminDashboardRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Platform admin dashboard repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listBookings(input) {
      const result = await pool.query<PlatformAdminBookingDbRow>(TARGET_PLATFORM_BOOKINGS_SQL, [
        input.status ?? null,
        input.limit,
        input.offset,
      ]);
      return result.rows.map(mapBookingRow);
    },
    async listGrowthProperties(input) {
      const result = await pool.query<PlatformAdminPropertyDbRow>(TARGET_PLATFORM_PROPERTIES_SQL, [
        input.excludeTestData,
      ]);
      return result.rows.map((row) => ({
        ...row,
        lifecycleRevision: Number(row.lifecycleRevision),
        createdAt: toIsoString(row.createdAt),
      }));
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function requirePlatformAdminRead(request: FastifyRequest): void {
  enforceRoutePolicy(request, {
    permission: "platform.admin.read",
    resource: PLATFORM_ADMIN_RESOURCE,
  });
}

function parseBookingQuery(query: BookingListQuery): {
  status?: PlatformAdminBookingStatus;
  limit: number;
  offset: number;
} {
  return {
    status: isBookingStatus(query.status) ? query.status : undefined,
    limit: clampInteger(query.limit, BOOKING_LIMIT_DEFAULT, 1, BOOKING_LIMIT_MAX),
    offset: clampInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseGrowthQuery(query: GrowthQuery): {
  granularity: PlatformAdminGrowthGranularity;
  excludeTestData: boolean;
  propertyIds?: string[];
  bookingPropertyId?: string;
} {
  return {
    granularity: isGrowthGranularity(query.granularity) ? query.granularity : "weekly",
    excludeTestData: query.exclude_test_data !== "false",
    propertyIds: parsePropertyIds(query.property_ids),
    bookingPropertyId: query.booking_property_id?.trim() || undefined,
  };
}

function toGrowthDashboard(
  query: ReturnType<typeof parseGrowthQuery>,
  properties: PlatformAdminProperty[],
): PlatformAdminGrowthDashboard {
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const selectedProperties =
    query.propertyIds === undefined
      ? properties
      : query.propertyIds.flatMap((id) => {
          const property = propertiesById.get(id);
          return property ? [property] : [];
        });
  const selectedPropertyIds = selectedProperties.map((property) => property.id);
  const selectedPropertyIdSet = new Set(selectedPropertyIds);
  const liveCount = selectedProperties.filter((property) => property.status === "live").length;

  return {
    properties,
    selectedPropertyIds,
    excludeTestData: query.excludeTestData,
    granularity: query.granularity,
    bookingPropertyId:
      query.bookingPropertyId && selectedPropertyIdSet.has(query.bookingPropertyId)
        ? query.bookingPropertyId
        : null,
    metrics: [
      metric("live_properties", "Live properties", liveCount),
      metric("page_views", "Page views", null),
      metric("booking_requests", "Booking requests", null),
      metric("conversion_rate", "Conversion rate", null),
    ],
    pageViews: [],
    bookingRequests: [],
    liveProperties: [],
    emptyMessage:
      selectedProperties.length === 0
        ? "No target properties match the selected filters."
        : "Target growth telemetry is not available yet for the selected properties.",
  };
}

function metric(
  key: string,
  label: string,
  rawValue: number | null,
  value = rawValue === null ? "N/A" : String(rawValue),
) {
  return {
    key,
    label,
    value,
    rawValue,
    delta: null,
  };
}

function mapBookingRow(row: PlatformAdminBookingDbRow): PlatformAdminBookingRow {
  return {
    ...row,
    totalAmount: Number(row.totalAmount ?? 0),
    requestedAt: toIsoString(row.requestedAt),
    respondedAt: row.respondedAt ? toIsoString(row.respondedAt) : null,
  };
}

function parsePropertyIds(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.map((entry) => entry.trim()).filter(Boolean)));
}

function clampInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function isBookingStatus(value: string | undefined): value is PlatformAdminBookingStatus {
  return (
    value === "pending" || value === "accepted" || value === "rejected" || value === "withdrawn"
  );
}

function isGrowthGranularity(value: string | undefined): value is PlatformAdminGrowthGranularity {
  return value === "daily" || value === "weekly" || value === "monthly";
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const TARGET_BOOKING_STATUS_SQL = `CASE
  WHEN booking.lifecycle_status IN ('draft', 'pending_payment') THEN 'pending'
  WHEN booking.lifecycle_status IN ('confirmed', 'completed', 'no_show') THEN 'accepted'
  WHEN booking.lifecycle_status = 'canceled' THEN 'withdrawn'
  ELSE 'rejected'
END`;

const TARGET_PLATFORM_BOOKINGS_SQL = `WITH booking_rows AS (
  SELECT
    booking.id::text AS id,
    booking.public_reference AS "bookingReference",
    property.id::text AS "hotelId",
    property.display_name AS "hotelName",
    COALESCE(slug.slug, property.public_id) AS "hotelSlug",
    COALESCE(NULLIF(concat_ws(' ', booker.first_name, booker.last_name), ''), 'Guest') AS "guestName",
    COALESCE(booker.email, '') AS "guestEmail",
    booking.check_in::text AS "checkIn",
    booking.check_out::text AS "checkOut",
    GREATEST(booking.check_out - booking.check_in, 1) AS nights,
    booking.total_amount::text AS "totalAmount",
    booking.currency,
    ${TARGET_BOOKING_STATUS_SQL} AS status,
    booking.lifecycle_status AS "rawStatus",
    COALESCE(NULLIF(booking.booking_metadata ->> 'channel', ''), NULLIF(booking.source_system, ''), 'direct') AS channel,
    booking.created_at AS "requestedAt",
    CASE
      WHEN ${TARGET_BOOKING_STATUS_SQL} = 'pending' THEN NULL
      ELSE COALESCE(latest_status.occurred_at, booking.updated_at)
    END AS "respondedAt"
  FROM booking.guest_bookings booking
  JOIN hotel_catalog.properties property ON property.id = booking.property_id
  LEFT JOIN LATERAL (
    SELECT property_slug.slug
    FROM hotel_catalog.property_slugs property_slug
    WHERE property_slug.property_id = property.id
      AND property_slug.purpose = 'canonical'
      AND property_slug.status = 'active'
    ORDER BY property_slug.created_at DESC, property_slug.id
    LIMIT 1
  ) slug ON TRUE
  LEFT JOIN LATERAL (
    SELECT guest.first_name, guest.last_name, guest.email
    FROM booking.booking_guests guest
    WHERE guest.guest_booking_id = booking.id
    ORDER BY
      CASE guest.guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
      guest.created_at,
      guest.id
    LIMIT 1
  ) booker ON TRUE
  LEFT JOIN LATERAL (
    SELECT event.occurred_at
    FROM booking.booking_status_events event
    WHERE event.guest_booking_id = booking.id
    ORDER BY event.occurred_at DESC, event.id
    LIMIT 1
  ) latest_status ON TRUE
)
SELECT *
FROM booking_rows
WHERE ($1::text IS NULL OR status = $1)
ORDER BY "requestedAt" DESC, id
LIMIT $2 OFFSET $3`;

const TARGET_PLATFORM_PROPERTIES_SQL = `SELECT
  property.id::text AS id,
  property.display_name AS name,
  COALESCE(slug.slug, property.public_id) AS slug,
  CASE
    WHEN property.profile_status = 'complete' THEN 'live'
    WHEN property.profile_status = 'disabled' THEN 'test'
    ELSE 'demo'
  END AS status,
  property.lifecycle_status AS "lifecycleStatus",
  property.lifecycle_revision AS "lifecycleRevision",
  ARRAY(
    SELECT DISTINCT membership.user_id::text
    FROM identity.organization_resource_links owner_link
    JOIN identity.organization_memberships membership
      ON membership.organization_id = owner_link.organization_id
     AND membership.status = 'active'
    JOIN identity.users account
      ON account.id = membership.user_id AND account.status = 'active'
    WHERE owner_link.product = 'hotel_catalog'
      AND owner_link.resource_type = 'property'
      AND owner_link.resource_id = property.id::text
      AND owner_link.relationship = 'owner'
      AND owner_link.status = 'active'
    ORDER BY membership.user_id::text
  ) AS "ownerAccountUserIds",
  property.created_at AS "createdAt"
FROM hotel_catalog.properties property
LEFT JOIN LATERAL (
  SELECT property_slug.slug
  FROM hotel_catalog.property_slugs property_slug
  WHERE property_slug.property_id = property.id
    AND property_slug.purpose = 'canonical'
    AND property_slug.status = 'active'
  ORDER BY property_slug.created_at DESC, property_slug.id
  LIMIT 1
) slug ON TRUE
WHERE ($1::boolean = false OR property.profile_status <> 'disabled')
ORDER BY property.display_name, property.id`;
