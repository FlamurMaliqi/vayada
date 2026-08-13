import {
  FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION,
  type FinanceAffiliatePayoutMarkPaidCommand,
  type FinancePlatformAffiliatePayoutRepository,
} from "@vayada/domain-finance";
import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type Params = { affiliateId: string };
type DetailQuery = { currency?: unknown };
type ListQuery = { limit?: unknown; offset?: unknown };
type MarkPaidBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  currency?: unknown;
  payoutIds?: unknown;
  expectedAmount?: unknown;
  paymentMethod?: unknown;
  externalReference?: unknown;
  evidenceReference?: unknown;
  paidAt?: unknown;
  note?: unknown;
};

type Options = { repository: Partial<FinancePlatformAffiliatePayoutRepository> };

export async function registerFinancePlatformAffiliatePayoutRoutes(
  app: FastifyInstance,
  options: Options,
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/finance/platform/affiliate-payouts",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      if (!options.repository.listPlatformAffiliatePayoutSummaries) {
        return unavailable(reply, "Platform affiliate payout reads are not configured.");
      }
      const query = request.query ?? {};
      const result = await options.repository.listPlatformAffiliatePayoutSummaries({
        limit: clampLimit(query.limit),
        offset: parseOffset(query.offset),
      });
      return { contractVersion: FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION, ...result };
    },
  );

  app.get<{ Params: Params; Querystring: DetailQuery }>(
    "/finance/platform/affiliate-payouts/:affiliateId",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      if (!options.repository.getPlatformAffiliatePayoutDetail) {
        return unavailable(reply, "Platform affiliate payout reads are not configured.");
      }
      const currency = currencyCode(request.query?.currency);
      if (!currency) return invalid(reply, "currency must be an uppercase ISO-4217 code.");
      const result = await options.repository.getPlatformAffiliatePayoutDetail(
        request.params.affiliateId,
        currency,
      );
      if (!result) {
        return reply.code(404).send({
          statusCode: 404,
          code: "payout_not_found",
          category: "not_found",
          message: "Affiliate payout detail was not found.",
        });
      }
      return { contractVersion: FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION, ...result };
    },
  );

  app.post<{ Params: Params; Body: MarkPaidBody }>(
    "/finance/platform/affiliate-payouts/:affiliateId/mark-paid",
    async (request, reply) => {
      const context = authorize(request, reply, "manage");
      if (!context) return reply;
      if (!options.repository.markAffiliatePayoutPaid) {
        return unavailable(reply, "Platform affiliate payout writes are not configured.");
      }
      const command = markPaidCommand(request, context);
      if (!command) return invalid(reply, "Affiliate payout payment evidence is invalid.");

      const result = await options.repository.markAffiliatePayoutPaid(command);
      if (!result.ok) {
        return reply.code(result.statusCode).send({
          statusCode: result.statusCode,
          code: result.code,
          category:
            result.statusCode === 400
              ? "validation"
              : result.statusCode === 404
                ? "not_found"
                : result.statusCode === 409
                  ? "conflict"
                  : "write_model",
          message: result.message,
        });
      }
      return {
        contractVersion: FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION,
        status: result.status,
        evidence: result.evidence,
        commandMeta: result.commandMeta,
      };
    },
  );
}

function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  access: "read" | "manage",
): RequestContext | null {
  try {
    const context = enforceRoutePolicy(request, {
      permission: access === "read" ? "platform.finance.read" : "platform.finance.manage",
      entitlement: {
        product: "platform",
        key: "finance-admin",
        resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
      },
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator", "finance_manager"],
      },
    });
    if (
      context.selectedOrganization.kind !== "platform" ||
      context.selectedOrganization.status !== "active" ||
      !["platform_admin", "finance_manager"].includes(context.membership.roleKey)
    ) {
      throw Object.assign(new Error("Platform Finance organization scope is required."), {
        statusCode: 403,
      });
    }
    return context;
  } catch (error) {
    const statusCode = status(error);
    if (statusCode !== 401 && statusCode !== 403) throw error;
    const code = authorizationCode(request, statusCode, access);
    reply.code(statusCode).send({
      statusCode,
      code,
      category: statusCode === 401 ? "authentication" : "authorization",
      message:
        statusCode === 401
          ? "A valid access token is required."
          : "Platform Finance access is required.",
    });
    return null;
  }
}

function authorizationCode(
  request: FastifyRequest,
  statusCode: 401 | 403,
  access: "read" | "manage",
): string {
  if (statusCode === 401) return "unauthenticated";
  const context = request.authContext;
  if (!context) return "unauthenticated";
  const permission = access === "read" ? "platform.finance.read" : "platform.finance.manage";
  if (!context.membership.permissions.includes(permission)) return "missing_permission";
  const entitlements = context.entitlements.filter(
    (entry) => entry.product === "platform" && entry.key === "finance-admin",
  );
  if (entitlements.some((entry) => entry.status !== "active")) return "inactive_entitlement";
  if (!entitlements.some((entry) => entry.status === "active")) return "missing_entitlement";
  return "missing_resource_access";
}

function markPaidCommand(
  request: FastifyRequest<{ Params: Params; Body: MarkPaidBody }>,
  context: RequestContext,
): FinanceAffiliatePayoutMarkPaidCommand | null {
  const body = request.body;
  if (!plainRecord(body)) return null;
  const allowed = [
    "commandId",
    "idempotencyKey",
    "currency",
    "payoutIds",
    "expectedAmount",
    "paymentMethod",
    "externalReference",
    "evidenceReference",
    "paidAt",
    "note",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
  const commandId = trimmed(body.commandId);
  const idempotencyKey = trimmed(body.idempotencyKey);
  const currency = currencyCode(body.currency);
  const payoutIds = uuidList(body.payoutIds);
  const expectedAmount = trimmed(body.expectedAmount);
  const paymentMethod =
    body.paymentMethod === "manual" || body.paymentMethod === "bank_transfer"
      ? body.paymentMethod
      : null;
  const externalReference = trimmed(body.externalReference);
  const evidenceReference = trimmed(body.evidenceReference);
  const paidAt = trimmed(body.paidAt);
  const note = body.note == null ? null : trimmed(body.note);
  if (
    !commandId ||
    !idempotencyKey ||
    !currency ||
    !payoutIds ||
    !expectedAmount ||
    !/^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(expectedAmount) ||
    expectedAmount === "0.00" ||
    !paymentMethod ||
    !externalReference ||
    !evidenceReference ||
    !paidAt ||
    (body.note != null && !note)
  )
    return null;
  return {
    commandType: "finance.affiliate_payout.mark_paid",
    commandId,
    idempotencyKey,
    affiliateId: request.params.affiliateId,
    currency,
    audit: {
      actor: {
        kind: "user",
        userId: context.actor.internalUserId,
        organizationId: context.selectedOrganization.organizationId,
      },
      requestId: context.audit.requestId,
      correlationId: context.audit.correlationId,
      reason: "Platform Admin recorded an external affiliate payout",
      requestedAt: context.audit.receivedAt,
    },
    payload: {
      payoutIds,
      expectedAmount,
      paymentMethod,
      externalReference,
      evidenceReference,
      paidAt,
      note,
    },
  };
}

function unavailable(reply: FastifyReply, message: string) {
  return reply.code(500).send({
    statusCode: 500,
    code: "write_unavailable",
    category: "write_model",
    message,
  });
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  });
}

function status(error: unknown): 401 | 403 | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return value === 401 || value === 403 ? value : null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value && value === value.trim() ? value : null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? Math.min(500, Math.max(1, parsed)) : 50;
}

function parseOffset(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function uuidList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
  const result = value.filter(
    (item): item is string =>
      typeof item === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item),
  );
  return result.length === value.length && new Set(result).size === result.length ? result : null;
}
