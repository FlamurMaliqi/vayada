import type { ChannexRatePlanMapping, ChannexRoomTypeMapping } from "@vayada/domain-pms-channex";

import type {
  ChannexManagementJob,
  ChannexManagementProvider,
  ChannexManagementProviderFailure,
  ChannexManagementProviderSuccess,
} from "../jobs/pmsChannexManagementWorker.js";

type ChannexRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

export type ChannexManagementActionPlan = {
  requests: ChannexRequest[];
  externalPropertyId?: string;
  roomTypeMappings?: ChannexRoomTypeMapping[];
  ratePlanMappings?: ChannexRatePlanMapping[];
  bookingRevisionHandoff?: (revisions: unknown[]) => Promise<void>;
};

export type ChannexManagementPlanPort = {
  plan(job: ChannexManagementJob): Promise<ChannexManagementActionPlan>;
};

export function createChannexManagementProvider(config: {
  apiBaseUrl: string;
  apiKey: string;
  plans: ChannexManagementPlanPort;
  fetch?: typeof fetch;
}): ChannexManagementProvider {
  const apiBaseUrl = requiredUrl(config.apiBaseUrl);
  const apiKey = required(config.apiKey, "Channex apiKey");
  const fetcher = config.fetch ?? fetch;
  return {
    async execute(job) {
      let plan: ChannexManagementActionPlan;
      try {
        plan = await config.plans.plan(job);
      } catch (error) {
        return failure("invalid_state", error);
      }
      let lastRequestId: string | undefined;
      let revisions: unknown[] = [];
      for (const request of plan.requests) {
        try {
          const response = await fetcher(requestUrl(apiBaseUrl, request), {
            method: request.method,
            headers: {
              "content-type": "application/json",
              "user-api-key": apiKey,
              "idempotency-key": job.input.idempotencyKey,
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: AbortSignal.timeout(30_000),
          });
          lastRequestId = response.headers.get("x-request-id") ?? lastRequestId;
          if (!response.ok) return await responseFailure(response, lastRequestId);
          if (request.path === "/api/v1/booking_revisions/feed") {
            revisions = dataList(await response.json());
          }
        } catch (error) {
          return failure(isTimeout(error) ? "timeout" : "provider_unavailable", error);
        }
      }
      if (plan.bookingRevisionHandoff) {
        try {
          await plan.bookingRevisionHandoff(revisions);
        } catch (error) {
          return failure("provider_unavailable", error);
        }
      }
      return {
        ok: true,
        providerRequestId: lastRequestId,
        externalPropertyId: plan.externalPropertyId,
        roomTypeMappings: plan.roomTypeMappings,
        ratePlanMappings: plan.ratePlanMappings,
      } satisfies ChannexManagementProviderSuccess;
    },
  };
}

async function responseFailure(
  response: Response,
  providerRequestId?: string,
): Promise<ChannexManagementProviderFailure> {
  const message = await safeResponseMessage(response);
  const code =
    response.status === 429
      ? "rate_limited"
      : response.status >= 500
        ? "provider_unavailable"
        : response.status === 400 || response.status === 422
          ? "invalid_payload"
          : "provider_rejected";
  return { ok: false, code, message, statusCode: response.status, providerRequestId };
}

async function safeResponseMessage(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `Channex request failed with HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    return JSON.stringify(parsed.errors ?? parsed).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function failure(
  code: ChannexManagementProviderFailure["code"],
  error: unknown,
): ChannexManagementProviderFailure {
  return {
    ok: false,
    code,
    message: (error instanceof Error ? error.message : "Channex request failed").slice(0, 500),
  };
}

function requestUrl(base: string, request: ChannexRequest): string {
  const url = new URL(request.path, `${base}/`);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function dataList(value: unknown): unknown[] {
  return value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
    ? ((value as { data: unknown[] }).data ?? [])
    : [];
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function requiredUrl(value: string): string {
  const url = new URL(required(value, "Channex apiBaseUrl"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Channex apiBaseUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export const channexRequests = {
  createProperty: (property: Record<string, unknown>): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/properties",
    body: { property },
  }),
  deleteProperty: (externalPropertyId: string): ChannexRequest => ({
    method: "DELETE",
    path: `/api/v1/properties/${encodeURIComponent(externalPropertyId)}`,
  }),
  createRoomType: (roomType: Record<string, unknown>): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/room_types",
    body: { room_type: roomType },
  }),
  createRatePlan: (ratePlan: Record<string, unknown>): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/rate_plans",
    body: { rate_plan: ratePlan },
  }),
  availability: (values: unknown[]): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/availability",
    body: { values },
  }),
  restrictions: (values: unknown[]): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/restrictions",
    body: { values },
  }),
  bookingRevisionFeed: (externalPropertyId: string): ChannexRequest => ({
    method: "GET",
    path: "/api/v1/booking_revisions/feed",
    query: { "filter[property_id]": externalPropertyId, "order[inserted_at]": "asc" },
  }),
  installMessaging: (externalPropertyId: string): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/applications/install",
    body: {
      application_installation: {
        property_id: externalPropertyId,
        application_code: "channex_messages",
      },
    },
  }),
};
