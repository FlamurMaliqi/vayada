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
  resolveBody?: (externalRoomTypeIds: ReadonlyMap<string, string>) => unknown;
  capture?:
    | { kind: "property" }
    | { kind: "room_type"; roomTypeId: string; roomTypeName: string }
    | {
        kind: "rate_plan";
        roomTypeId: string;
        ratePlanId: string;
        ratePlanName: string;
        channel: string;
        sellMode: "per_room" | "per_person";
        markupPercent: number;
      };
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
      let externalPropertyId = plan.externalPropertyId;
      const externalRoomTypeIds = new Map<string, string>();
      const roomTypeMappings: ChannexRoomTypeMapping[] = [...(plan.roomTypeMappings ?? [])];
      const ratePlanMappings: ChannexRatePlanMapping[] = [...(plan.ratePlanMappings ?? [])];
      for (const request of plan.requests) {
        try {
          const response = await fetcher(requestUrl(apiBaseUrl, request), {
            method: request.method,
            headers: {
              "content-type": "application/json",
              "user-api-key": apiKey,
              "idempotency-key": job.input.idempotencyKey,
            },
            body:
              request.body === undefined && !request.resolveBody
                ? undefined
                : JSON.stringify(request.resolveBody?.(externalRoomTypeIds) ?? request.body),
            signal: AbortSignal.timeout(30_000),
          });
          lastRequestId = response.headers.get("x-request-id") ?? lastRequestId;
          if (!response.ok) return await responseFailure(response, lastRequestId);
          if (response.status !== 204) {
            const responseBody = await response.json();
            if (request.path === "/api/v1/booking_revisions/feed") {
              revisions = dataList(responseBody);
            }
            const externalId = request.capture ? dataId(responseBody) : undefined;
            if (request.capture?.kind === "property") externalPropertyId = externalId;
            if (request.capture?.kind === "room_type") {
              externalRoomTypeIds.set(request.capture.roomTypeId, externalId!);
              roomTypeMappings.push({
                mappingId: job.jobId,
                roomTypeId: request.capture.roomTypeId,
                roomTypeName: request.capture.roomTypeName,
                externalRoomTypeId: externalId!,
                status: "active",
              });
            }
            if (request.capture?.kind === "rate_plan") {
              const externalRoomTypeId = externalRoomTypeIds.get(request.capture.roomTypeId);
              if (!externalRoomTypeId) {
                return failure("invalid_state", new Error("Missing room mapping"));
              }
              ratePlanMappings.push({
                mappingId: job.jobId,
                ...request.capture,
                externalRoomTypeId,
                externalRatePlanId: externalId!,
                status: "active",
              });
            }
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
        externalPropertyId,
        roomTypeMappings,
        ratePlanMappings,
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

function dataId(value: unknown): string {
  const data = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined;
  const id = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Channex response omitted data.id");
  return id;
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
    capture: { kind: "property" },
  }),
  deleteProperty: (externalPropertyId: string): ChannexRequest => ({
    method: "DELETE",
    path: `/api/v1/properties/${encodeURIComponent(externalPropertyId)}`,
  }),
  createRoomType: (input: {
    roomTypeId: string;
    roomTypeName: string;
    roomType: Record<string, unknown>;
  }): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/room_types",
    body: { room_type: input.roomType },
    capture: { kind: "room_type", roomTypeId: input.roomTypeId, roomTypeName: input.roomTypeName },
  }),
  createRatePlan: (input: {
    roomTypeId: string;
    ratePlanId: string;
    ratePlanName: string;
    channel: string;
    sellMode: "per_room" | "per_person";
    markupPercent: number;
    externalRoomTypeId?: string;
    ratePlan: Record<string, unknown>;
  }): ChannexRequest => ({
    method: "POST",
    path: "/api/v1/rate_plans",
    resolveBody: (externalRoomTypeIds) => ({
      rate_plan: {
        ...input.ratePlan,
        room_type_id: required(
          input.externalRoomTypeId ?? externalRoomTypeIds.get(input.roomTypeId) ?? "",
          `External room type ${input.roomTypeId}`,
        ),
      },
    }),
    capture: {
      kind: "rate_plan",
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      ratePlanName: input.ratePlanName,
      channel: input.channel,
      sellMode: input.sellMode,
      markupPercent: input.markupPercent,
    },
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
