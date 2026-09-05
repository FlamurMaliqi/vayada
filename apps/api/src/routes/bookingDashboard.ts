import type {
  BookingDashboardMetricsPeriodInput,
  BookingDashboardMetricsReadModel,
  BookingDashboardMetricsReadPort,
  BookingPageViewTimelineReadModel,
  BookingSourceMixReadModel,
  BookingSparklineReadModel,
} from "@vayada/domain-booking";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

export const BOOKING_DASHBOARD_CONTRACT_VERSION = "booking-dashboard.v1" as const;

export type BookingDashboardContractVersion = typeof BOOKING_DASHBOARD_CONTRACT_VERSION;

export type BookingDashboardRoutesOptions = {
  metricsReadPort: BookingDashboardMetricsReadPort & {
    resolveCanonicalPropertyId(propertyId: string): Promise<string | null>;
    close?(): Promise<void>;
  };
  propertyAccessRepository: PropertyAccessRepository;
};

type BookingDashboardPropertyParams = {
  propertyId: string;
};

type DashboardPeriodQuery = {
  periodStart?: string;
  periodEnd?: string;
  previousPeriodStart?: string;
  previousPeriodEnd?: string;
};

type DashboardWindowQuery = {
  windowStart?: string;
  windowEnd?: string;
};

export type BookingDashboardStatsResponse = {
  contractVersion: BookingDashboardContractVersion;
  propertyId: string;
  metrics: BookingDashboardMetricsReadModel;
};

export type BookingDashboardSourceMixResponse = {
  contractVersion: BookingDashboardContractVersion;
  propertyId: string;
  sourceMix: BookingSourceMixReadModel;
};

export type BookingDashboardSparklinesResponse = {
  contractVersion: BookingDashboardContractVersion;
  propertyId: string;
  sparklines: BookingSparklineReadModel;
};

export type BookingDashboardPageViewsResponse = {
  contractVersion: BookingDashboardContractVersion;
  propertyId: string;
  pageViews: BookingPageViewTimelineReadModel;
};

type BookingDashboardErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_query"
  | "read_model_not_found"
  | "read_model_unavailable";

type BookingDashboardError = {
  code: BookingDashboardErrorCode;
  category: "authentication" | "authorization" | "validation" | "not_found" | "read_model";
  message: string;
};

export async function registerBookingDashboardRoutes(
  app: FastifyInstance,
  options: BookingDashboardRoutesOptions,
): Promise<void> {
  const { metricsReadPort } = options;

  app.addHook("onClose", async () => {
    await metricsReadPort.close?.();
  });

  app.get<{ Params: BookingDashboardPropertyParams; Querystring: DashboardPeriodQuery }>(
    "/properties/:propertyId/dashboard/stats",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!(await enforceBookingDashboardReadPolicy(request, reply, propertyId, options)))
        return reply;

      const period = parseDashboardPeriodQuery(request.query);
      if (!period.ok) {
        return sendBookingDashboardError(reply, 400, period.error);
      }

      try {
        const metrics = await metricsReadPort.getDashboardMetrics({
          propertyId,
          ...period.value,
        });

        if (!metrics) {
          return sendBookingDashboardError(reply, 404, {
            code: "read_model_not_found",
            category: "not_found",
            message: "Booking dashboard metrics were not found for this property.",
          });
        }

        return {
          contractVersion: BOOKING_DASHBOARD_CONTRACT_VERSION,
          propertyId,
          metrics,
        } satisfies BookingDashboardStatsResponse;
      } catch (error) {
        request.log.error({ err: error }, "Booking dashboard metrics read failed");
        return sendBookingDashboardError(reply, 500, readModelUnavailableError());
      }
    },
  );

  app.get<{ Params: BookingDashboardPropertyParams; Querystring: DashboardPeriodQuery }>(
    "/properties/:propertyId/dashboard/bookings-by-source",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!(await enforceBookingDashboardReadPolicy(request, reply, propertyId, options)))
        return reply;

      const period = parseSourceMixPeriodQuery(request.query);
      if (!period.ok) {
        return sendBookingDashboardError(reply, 400, period.error);
      }

      try {
        return {
          contractVersion: BOOKING_DASHBOARD_CONTRACT_VERSION,
          propertyId,
          sourceMix: await metricsReadPort.getSourceMix({
            propertyId,
            ...period.value,
          }),
        } satisfies BookingDashboardSourceMixResponse;
      } catch (error) {
        request.log.error({ err: error }, "Booking dashboard source-mix read failed");
        return sendBookingDashboardError(reply, 500, readModelUnavailableError());
      }
    },
  );

  app.get<{ Params: BookingDashboardPropertyParams; Querystring: DashboardWindowQuery }>(
    "/properties/:propertyId/dashboard/sparklines",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!(await enforceBookingDashboardReadPolicy(request, reply, propertyId, options)))
        return reply;

      const window = parseSparklineWindowQuery(request.query);
      if (!window.ok) {
        return sendBookingDashboardError(reply, 400, window.error);
      }

      try {
        return {
          contractVersion: BOOKING_DASHBOARD_CONTRACT_VERSION,
          propertyId,
          sparklines: await metricsReadPort.getSparklines({
            propertyId,
            ...window.value,
          }),
        } satisfies BookingDashboardSparklinesResponse;
      } catch (error) {
        request.log.error({ err: error }, "Booking dashboard sparkline read failed");
        return sendBookingDashboardError(reply, 500, readModelUnavailableError());
      }
    },
  );

  app.get<{ Params: BookingDashboardPropertyParams; Querystring: DashboardWindowQuery }>(
    "/properties/:propertyId/dashboard/conversion-funnel",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!(await enforceBookingDashboardReadPolicy(request, reply, propertyId, options))) return reply;
      const window = parsePageViewWindowQuery(request.query);
      if (!window.ok) return sendBookingDashboardError(reply, 400, window.error);
      try {
        const funnel = await metricsReadPort.getConversionFunnel({ propertyId, ...window.value });
        if (!funnel) return sendBookingDashboardError(reply, 404, {
          code: "read_model_not_found", category: "not_found", message: "Booking funnel was not found for this property.",
        });
        return { contractVersion: BOOKING_DASHBOARD_CONTRACT_VERSION, propertyId, funnel };
      } catch (error) {
        request.log.error({ err: error }, "Booking conversion funnel read failed");
        return sendBookingDashboardError(reply, 500, readModelUnavailableError());
      }
    },
  );

  app.get<{ Params: BookingDashboardPropertyParams; Querystring: DashboardWindowQuery }>(
    "/properties/:propertyId/dashboard/page-views",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!(await enforceBookingDashboardReadPolicy(request, reply, propertyId, options)))
        return reply;

      const window = parsePageViewWindowQuery(request.query);
      if (!window.ok) {
        return sendBookingDashboardError(reply, 400, window.error);
      }

      try {
        const pageViews = await metricsReadPort.getPageViewTimeline({
          propertyId,
          ...window.value,
        });
        if (!pageViews) {
          return sendBookingDashboardError(reply, 404, {
            code: "read_model_not_found",
            category: "not_found",
            message: "Booking dashboard page views were not found for this property.",
          });
        }
        return {
          contractVersion: BOOKING_DASHBOARD_CONTRACT_VERSION,
          propertyId,
          pageViews,
        } satisfies BookingDashboardPageViewsResponse;
      } catch (error) {
        request.log.error({ err: error }, "Booking dashboard page-view read failed");
        return sendBookingDashboardError(reply, 500, readModelUnavailableError());
      }
    },
  );
}

async function enforceBookingDashboardReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
  options: BookingDashboardRoutesOptions,
): Promise<boolean> {
  try {
    // Keep unauthorized callers from reaching the property-alias lookup.
    enforceRoutePolicy(request, { permission: "booking.analytics.read" });
    const canonicalPropertyId =
      await options.metricsReadPort.resolveCanonicalPropertyId(propertyId);
    if (!canonicalPropertyId) throw new AuthorizationError();
    await enforcePropertyRoutePolicy(
      request,
      {
        permission: "booking.analytics.read",
        property: {
          propertyId: canonicalPropertyId,
          targetResource: { product: "booking", resourceType: "booking_hotel" },
        },
        entitlement: {
          product: "booking",
          key: "booking-engine",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: propertyId,
          },
        },
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: propertyId,
          allowedRelationships: ["owner", "operator"],
        },
      },
      options.propertyAccessRepository,
    );
  } catch (error) {
    const accessError = toBookingDashboardAccessError(error, request, propertyId);
    if (accessError) {
      sendBookingDashboardError(reply, accessError.statusCode, accessError);
      return false;
    }
    request.log.error({ err: error }, "Booking dashboard property access read failed");
    sendBookingDashboardError(reply, 500, readModelUnavailableError());
    return false;
  }

  return !reply.sent;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: BookingDashboardError };

function parseDashboardPeriodQuery(
  query: DashboardPeriodQuery,
): Parsed<Omit<BookingDashboardMetricsPeriodInput, "propertyId">> {
  const period = parseDateRange(query.periodStart, query.periodEnd, "periodStart", "periodEnd");
  if (!period.ok) return period;

  const previous = parseDateRange(
    query.previousPeriodStart,
    query.previousPeriodEnd,
    "previousPeriodStart",
    "previousPeriodEnd",
  );
  if (!previous.ok) return previous;

  return {
    ok: true,
    value: {
      periodStart: period.value.periodStart,
      periodEnd: period.value.periodEnd,
      previousPeriodStart: previous.value.previousPeriodStart,
      previousPeriodEnd: previous.value.previousPeriodEnd,
    },
  };
}

function parseSourceMixPeriodQuery(
  query: DashboardPeriodQuery,
): Parsed<{ periodStart: string; periodEnd: string }> {
  return parseDateRange(query.periodStart, query.periodEnd, "periodStart", "periodEnd");
}

function parseSparklineWindowQuery(
  query: DashboardWindowQuery,
): Parsed<{ windowStart: string; windowEnd: string }> {
  return parseDateRange(query.windowStart, query.windowEnd, "windowStart", "windowEnd");
}

function parsePageViewWindowQuery(
  query: DashboardWindowQuery,
): Parsed<{ windowStart: string; windowEnd: string }> {
  const parsed = parseSparklineWindowQuery(query);
  if (!parsed.ok) return parsed;
  const days =
    Math.round(
      (Date.parse(`${parsed.value.windowEnd}T00:00:00Z`) -
        Date.parse(`${parsed.value.windowStart}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (days > 31) {
    return {
      ok: false,
      error: {
        code: "invalid_query",
        category: "validation",
        message: "Page-view timelines support requested windows of up to 31 days.",
      },
    };
  }
  return parsed;
}

function parseDateRange<TStart extends string, TEnd extends string>(
  start: string | undefined,
  end: string | undefined,
  startKey: TStart,
  endKey: TEnd,
): Parsed<Record<TStart | TEnd, string>> {
  const parsedStart = parseIsoDate(start);
  const parsedEnd = parseIsoDate(end);
  if (!parsedStart || !parsedEnd || parsedStart.getTime() > parsedEnd.getTime()) {
    return {
      ok: false,
      error: {
        code: "invalid_query",
        category: "validation",
        message: `${startKey} and ${endKey} are required YYYY-MM-DD values with start <= end.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      [startKey]: start,
      [endKey]: end,
    } as Record<TStart | TEnd, string>,
  };
}

function isIsoDate(value: string | undefined): value is string {
  return parseIsoDate(value) !== null;
}

function parseIsoDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

function readModelUnavailableError(): BookingDashboardError {
  return {
    code: "read_model_unavailable",
    category: "read_model",
    message: "Booking dashboard read model is unavailable.",
  };
}

function sendBookingDashboardError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 403 | 404 | 500,
  error: BookingDashboardError,
): FastifyReply {
  return reply.code(statusCode).send(error);
}

function toBookingDashboardAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): (BookingDashboardError & { statusCode: 401 | 403 }) | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toBookingDashboardAuthorizationErrorCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingDashboardAuthorizationMessage(code),
  };
}

function toBookingDashboardAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
):
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access" {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingDashboardEntitlement(request, propertyId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function hasInactiveBookingDashboardEntitlement(
  request: FastifyRequest,
  propertyId: string,
): boolean {
  return Boolean(
    request.authContext?.entitlements.some(
      (entitlement) =>
        entitlement.product === "booking" &&
        entitlement.key === "booking-engine" &&
        entitlement.status !== "active" &&
        (entitlement.resource === undefined ||
          (entitlement.resource.product === "booking" &&
            entitlement.resource.resourceType === "booking_hotel" &&
            entitlement.resource.resourceId === propertyId)),
    ),
  );
}

function toBookingDashboardAuthorizationMessage(
  code:
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access",
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking analytics permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
