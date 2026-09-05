import { readGrowthTelemetry } from "../../../../platform/growthTelemetry.js";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { PlatformPropertyLifecycleStatus } from "@vayada/domain-hotels";

import { enforceRoutePolicy } from "../../../policy.js";
import type {
  PmsManualCancellationCommand,
  PmsOperationsCommandRepository,
} from "../../../pmsOperations.js";

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
  findSmokeRecoveryBookings?(input: {
    emailDomain: string;
    propertyId: string;
    runId: string;
  }): Promise<PlatformAdminSmokeRecoveryBooking[]>;
  listGrowthProperties(input: { excludeTestData: boolean }): Promise<PlatformAdminProperty[]>;
  readGrowthTelemetry?: (
    input: Parameters<typeof readGrowthTelemetry>[1],
  ) => ReturnType<typeof readGrowthTelemetry>;
  close?(): Promise<void>;
};

export type PlatformAdminDashboardRoutesOptions = {
  repository?: PlatformAdminDashboardRepository;
  smokeRecovery?: {
    commandRepository: Pick<PmsOperationsCommandRepository, "cancelManualBooking">;
    receiptSecret: string;
  };
};

export type PlatformAdminSmokeRecoveryBooking = {
  commandId: string | null;
  contractVersion: string | null;
  guestEmail: string;
  id: string;
  lifecycleStatus: string;
  propertyId: string;
  sourceBookingId: string | null;
  sourceSystem: string | null;
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

  if (
    options.repository?.findSmokeRecoveryBookings &&
    options.smokeRecovery?.commandRepository.cancelManualBooking
  ) {
    app.post<{ Body: unknown }>("/bookings/recover-next-stack-smoke", async (request, reply) => {
      requirePlatformAdminManage(request);
      const input = parseSmokeRecovery(request.body);
      if (!input || !validSmokeRecoveryReceipt(options.smokeRecovery!.receiptSecret, input)) {
        return reply.status(400).send({ code: "invalid_smoke_recovery" });
      }
      const bookings = await options.repository!.findSmokeRecoveryBookings!({
        emailDomain: input.emailDomain,
        propertyId: input.propertyId,
        runId: input.runId,
      });
      if (
        new Set(bookings.map(({ id }) => id)).size !== bookings.length ||
        bookings.some((booking) => !isProvenSmokeBooking(booking, input))
      ) {
        return reply.status(409).send({ code: "smoke_recovery_ownership_unproven" });
      }
      if (
        bookings.some(
          ({ lifecycleStatus }) =>
            !["confirmed", "canceled", "completed", "no_show"].includes(lifecycleStatus),
        )
      ) {
        return reply.status(409).send({ code: "smoke_recovery_booking_not_cancellable" });
      }

      const resolvedBookingIds: string[] = [];
      for (const booking of bookings.filter(
        ({ lifecycleStatus }) => lifecycleStatus === "confirmed",
      )) {
        const commandId = `next-smoke:${input.runId}:recover:${booking.id}`;
        const result = await options.smokeRecovery!.commandRepository.cancelManualBooking!({
          propertyId: input.propertyId,
          guestBookingId: booking.id,
          commandId,
          idempotencyKey: commandId,
          reason: "Recover an interrupted next-stack synthetic booking",
          accountingDate: null,
          retainedCharges: [],
          audit: smokeRecoveryAudit(request, commandId),
        });
        if (!result.ok) {
          return reply
            .status(result.statusCode)
            .send({ code: result.code, detail: result.message });
        }
        resolvedBookingIds.push(booking.id);
      }

      return {
        outcome:
          bookings.length === 0
            ? "not_found"
            : resolvedBookingIds.length
              ? "resolved"
              : "already_resolved",
        bookingIds: bookings.map(({ id }) => id),
        resolvedBookingIds,
      };
    });
  }

  app.get<{ Querystring: GrowthQuery }>("/growth", async (request) => {
    requirePlatformAdminRead(request);
    const query = parseGrowthQuery(request.query);
    const properties = options.repository
      ? await options.repository.listGrowthProperties({ excludeTestData: query.excludeTestData })
      : [];

    const dashboard = toGrowthDashboard(query, properties);
    if (options.repository?.readGrowthTelemetry) {
      const propertyIds = query.bookingPropertyId
        ? dashboard.selectedPropertyIds.filter((id) => id === query.bookingPropertyId)
        : dashboard.selectedPropertyIds;
      const telemetry = await options.repository.readGrowthTelemetry({
        propertyIds,
        granularity: query.granularity,
        excludeTestData: query.excludeTestData,
      });
      dashboard.pageViews = telemetry.pageViews;
      dashboard.bookingRequests = telemetry.bookingRequests;
      const views = telemetry.pageViews.reduce((sum, point) => sum + point.value, 0);
      const requests = telemetry.bookingRequests.reduce((sum, point) => sum + point.value, 0);
      dashboard.metrics = [
        metric(
          "live_properties",
          "Live properties",
          properties.filter(
            (property) => propertyIds.includes(property.id) && property.status === "live",
          ).length,
        ),
        metric("page_views", "Page views", views),
        metric("booking_requests", "Booking requests", requests),
        metric(
          "conversion_rate",
          "Conversion rate",
          views ? (requests / views) * 100 : 0,
          `${views ? ((requests / views) * 100).toFixed(1) : "0"}%`,
        ),
      ];
      dashboard.emptyMessage = views || requests ? null : "No data for the selected properties.";
    }
    return dashboard;
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
    readGrowthTelemetry: (input) => readGrowthTelemetry(pool, input),
    async listBookings(input) {
      const result = await pool.query<PlatformAdminBookingDbRow>(TARGET_PLATFORM_BOOKINGS_SQL, [
        input.status ?? null,
        input.limit,
        input.offset,
      ]);
      return result.rows.map(mapBookingRow);
    },
    async findSmokeRecoveryBookings(input) {
      const result = await pool.query<PlatformAdminSmokeRecoveryBooking>(
        TARGET_SMOKE_RECOVERY_BOOKINGS_SQL,
        [input.propertyId, input.runId, input.emailDomain],
      );
      return result.rows;
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

function requirePlatformAdminManage(request: FastifyRequest): void {
  enforceRoutePolicy(request, {
    permission: "platform.property.status.manage",
    resource: PLATFORM_ADMIN_RESOURCE,
  });
}

type SmokeRecoveryInput = {
  emailDomain: string;
  propertyId: string;
  recoveryReceipt: string;
  runId: string;
};

function parseSmokeRecovery(value: unknown): SmokeRecoveryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["emailDomain", "propertyId", "recoveryReceipt", "runId"].includes(key),
    ) ||
    typeof input.runId !== "string" ||
    !/^\d{14}-[a-f0-9]{8}$/.test(input.runId) ||
    typeof input.propertyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.propertyId,
    ) ||
    typeof input.emailDomain !== "string" ||
    !/^[a-z0-9.-]+\.test$/.test(input.emailDomain) ||
    typeof input.recoveryReceipt !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.recoveryReceipt)
  ) {
    return null;
  }
  return input as SmokeRecoveryInput;
}

function validSmokeRecoveryReceipt(secret: string, input: SmokeRecoveryInput): boolean {
  const expected = createHmac("sha256", secret)
    .update(`vayada-next-smoke-recovery:v1:${input.runId}:${input.propertyId}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(input.recoveryReceipt, "hex"));
}

function isProvenSmokeBooking(
  booking: PlatformAdminSmokeRecoveryBooking,
  input: SmokeRecoveryInput,
): boolean {
  return (
    booking.propertyId === input.propertyId &&
    booking.guestEmail.startsWith("qa-next-") &&
    booking.guestEmail.endsWith(`-${input.runId}@${input.emailDomain}`) &&
    booking.sourceSystem === "pms" &&
    booking.contractVersion === "pms-manual-booking.v1" &&
    Boolean(booking.commandId) &&
    booking.commandId === booking.sourceBookingId
  );
}

function smokeRecoveryAudit(
  request: FastifyRequest,
  commandId: string,
): PmsManualCancellationCommand["audit"] {
  const context = request.authContext!;
  return {
    actor: {
      kind: "user",
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    requestId: context.audit.requestId,
    ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
    reason: "Recover an interrupted next-stack synthetic booking",
    requestedAt: context.audit.receivedAt,
  };
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

const TARGET_SMOKE_RECOVERY_BOOKINGS_SQL = `SELECT
  booking.id::text AS id,
  booking.property_id::text AS "propertyId",
  booker.email AS "guestEmail",
  booking.lifecycle_status AS "lifecycleStatus",
  booking.source_system AS "sourceSystem",
  booking.source_booking_id AS "sourceBookingId",
  booking.booking_metadata ->> 'contractVersion' AS "contractVersion",
  booking.booking_metadata ->> 'commandId' AS "commandId"
FROM booking.guest_bookings booking
JOIN booking.booking_guests booker
  ON booker.guest_booking_id = booking.id AND booker.guest_role = 'booker'
WHERE booking.property_id = $1::uuid
  AND booker.email LIKE 'qa-next-%-' || $2::text || '@' || $3::text
  AND booking.source_system = 'pms'
  AND booking.booking_metadata ->> 'contractVersion' = 'pms-manual-booking.v1'
  AND booking.source_booking_id = booking.booking_metadata ->> 'commandId'
ORDER BY booking.created_at, booking.id`;

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
