import { requireAuthContext, UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requireActiveEntitlement,
  requirePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  FINANCE_OTA_CHANNELS,
  FINANCE_ROUTE_CONTRACT_VERSION,
  normalizeFinanceOtaCommissionInstant,
  normalizeFinanceOtaCommissionRate,
  type FinanceOtaCommissionRule,
  type FinanceOtaChannel,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createPgFinanceOtaCommissionRuleRepository } from "../domains/financeOtaCommissionRuleRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Params = { propertyId: string; channel?: string };
export type FinanceOtaCommissionSettingsRepository = Pick<
  ReturnType<typeof createPgFinanceOtaCommissionRuleRepository>,
  "list" | "setRule"
>;
const PATH = "/finance/properties/:propertyId/financials/ota-commission-settings";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_KEYS = "commandId,effectiveFrom,expectedRevision,idempotencyKey,percentageRate";

export async function registerFinanceOtaCommissionSettingsRoutes(
  app: FastifyInstance,
  options: {
    repository: FinanceOtaCommissionSettingsRepository;
    propertyAccessRepository?: PropertyAccessRepository;
  },
): Promise<void> {
  const authorize = (request: FastifyRequest, reply: FastifyReply) =>
    authorizeRequest(request, reply, options.propertyAccessRepository);
  app.get<{ Params: Params }>(PATH, { onRequest: authorize }, async (request, reply) => {
    const propertyId = request.params.propertyId.toLowerCase();
    const values = await options.repository.list(propertyId).catch(() => null);
    if (!values) return portViolation(reply);
    const latest = new Map<FinanceOtaChannel, ReturnType<typeof setting>>();
    for (const value of values) {
      if (value.propertyId !== propertyId) return portViolation(reply);
      const rule = setting(value);
      const previous = latest.get(rule.channel);
      if (!previous || previous.revision < rule.revision) latest.set(rule.channel, rule);
    }
    return reply.status(200).send({
      contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
      propertyId,
      settings: FINANCE_OTA_CHANNELS.map(
        (channel) =>
          latest.get(channel) ?? { channel, status: "unconfigured", reason: "not_configured" },
      ),
    });
  });

  app.put<{ Params: Params; Body: unknown }>(
    `${PATH}/:channel`,
    { onRequest: authorize },
    async (request, reply) => {
      const propertyId = request.params.propertyId.toLowerCase();
      const context = requireAuthContext(request);
      const channel = readChannel(request.params.channel);
      if (!channel || !exactBody(request.body)) return invalid(reply);
      const commandId = identifier(request.body.commandId);
      const idempotencyKey = identifier(request.body.idempotencyKey);
      const effectiveFrom =
        typeof request.body.effectiveFrom === "string"
          ? normalizeFinanceOtaCommissionInstant(request.body.effectiveFrom)
          : null;
      const percentageRate =
        typeof request.body.percentageRate === "string"
          ? normalizeFinanceOtaCommissionRate(request.body.percentageRate)
          : null;
      if (
        !commandId ||
        !idempotencyKey ||
        !effectiveFrom ||
        !percentageRate ||
        !Number.isSafeInteger(request.body.expectedRevision) ||
        (request.body.expectedRevision as number) < 0
      )
        return invalid(reply);
      const result = await options.repository
        .setRule({
          commandId,
          idempotencyKey,
          effectiveFrom,
          percentageRate,
          expectedRevision: request.body.expectedRevision as number,
          propertyId,
          channel,
          audit: {
            actor: {
              kind: "user",
              userId: context.actor.internalUserId,
              organizationId: context.selectedOrganization.organizationId,
            },
            requestId: context.audit.requestId,
            correlationId: context.audit.correlationId,
            reason: "ota_commission_settings_update",
            requestedAt: context.audit.receivedAt,
          },
        })
        .catch(() => null);
      if (!result) return portViolation(reply);
      if (result.status === "conflict") return reply.status(409).send({ code: result.reason });
      if (result.rule.propertyId !== propertyId || result.rule.channel !== channel)
        return portViolation(reply);
      const outcome =
        result.status === "replayed"
          ? "replayed"
          : request.body.expectedRevision === 0
            ? "created"
            : "updated";
      return reply.status(outcome === "created" ? 201 : 200).send({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        outcome,
        setting: setting(result.rule),
      });
    },
  );
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyAccessRepository: PropertyAccessRepository | undefined,
) {
  const permission = request.method === "GET" ? "pms.finance.read" : "pms.finance.manage";
  try {
    const propertyId = ((request.params as Partial<Params>).propertyId ?? "").toLowerCase();
    const resource = {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    } as const;
    const base = enforceRoutePolicy(request, {
      permission,
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] },
    });
    if (base.selectedOrganization.kind !== "hotel_group") throw new AuthorizationError();
    requireActiveEntitlement(base, { product: "pms", key: "module:financials", resource });
    if (!UUID.test(propertyId)) return invalid(reply);
    if (!propertyAccessRepository) throw new AuthorizationError();
    await requirePropertyAccess(base, propertyAccessRepository, {
      propertyId,
      targetResource: resource,
      allowedRelationships: ["owner", "finance_manager"],
    });
  } catch (error) {
    if (error instanceof UnauthorizedError)
      return reply.status(401).send({ code: "unauthenticated" });
    if (error instanceof AuthorizationError) return reply.status(403).send({ code: "forbidden" });
    throw error;
  }
}

function setting(rule: FinanceOtaCommissionRule) {
  return {
    channel: rule.channel,
    status: "configured" as const,
    ruleId: rule.ruleId,
    percentageRate: rule.percentageRate,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    revision: rule.revision,
  };
}

function readChannel(value: unknown): FinanceOtaChannel | null {
  return typeof value === "string" && FINANCE_OTA_CHANNELS.includes(value as FinanceOtaChannel)
    ? (value as FinanceOtaChannel)
    : null;
}
function exactBody(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join() === BODY_KEYS;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 200
    ? value
    : null;
}
const invalid = (reply: FastifyReply) => reply.status(400).send({ code: "invalid_request" });
const portViolation = (reply: FastifyReply) =>
  reply.status(500).send({ code: "finance_ota_settings_port_error" });
