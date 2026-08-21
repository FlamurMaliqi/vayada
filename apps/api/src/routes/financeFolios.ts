import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceFolioQuery,
  type FinanceFolio,
  type FinanceFolioDetailResponse,
  type FinanceFolioListResponse,
  type FinanceFolioSummary,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  FinanceFolioCursorError,
  FinanceFolioEvidenceError,
  type FinanceFolioReadRepository,
} from "../domains/financeFolioReadRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Params = { propertyId: string; folioId?: string };
type Scope = { propertyId: string };
export type FinanceFolioRoutesOptions = {
  repository: Pick<FinanceFolioReadRepository, "list" | "detail">;
};

const ROOT = "/finance/properties/:propertyId/financials/folios";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function registerFinanceFolioRoutes(
  app: FastifyInstance,
  options: FinanceFolioRoutesOptions,
): Promise<void> {
  const scopes = new WeakMap<FastifyRequest, Scope>();
  const authorize = authorization(scopes);

  app.get(ROOT, { onRequest: authorize }, async (request, reply) =>
    safe(reply, async () => {
      const query = parseFinanceFolioQuery(request.query);
      if (!query) return bad(reply);
      const propertyId = scopes.get(request)!.propertyId;
      const value = await options.repository.list(propertyId, query);
      return value ? reply.send(listResponse(value, propertyId)) : missing(reply);
    }),
  );

  app.get(`${ROOT}/:folioId`, { onRequest: authorize }, async (request, reply) =>
    safe(reply, async () => {
      const folioId = canonicalUuid((request.params as Params).folioId);
      if (!folioId || !empty(request.query)) return bad(reply);
      const propertyId = scopes.get(request)!.propertyId;
      const value = await options.repository.detail(propertyId, folioId);
      return value ? reply.send(detailResponse(value, propertyId)) : missing(reply);
    }),
  );
}

function authorization(scopes: WeakMap<FastifyRequest, Scope>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const permission = "pms.finance.read" as const;
      const base = enforceRoutePolicy(request, { permission });
      if (base.selectedOrganization.kind !== "hotel_group") throw new AuthorizationError();
      const propertyId = canonicalUuid((request.params as Partial<Params>).propertyId);
      if (!propertyId) return void bad(reply);
      const resource = {
        product: "pms" as const,
        resourceType: "pms_property" as const,
        resourceId: propertyId,
      };
      for (const key of ["property-management", "module:financials"])
        enforceRoutePolicy(request, {
          permission,
          entitlement: { product: "pms", key, resource },
          resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] },
        });
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      scopes.set(request, { propertyId });
    } catch (cause) {
      if (cause instanceof UnauthorizedError)
        return void reply.status(401).send({ code: "unauthenticated" });
      if (cause instanceof AuthorizationError)
        return void reply.status(403).send({ code: "forbidden" });
      throw cause;
    }
  };
}

function listResponse(value: FinanceFolioListResponse, propertyId: string) {
  if (!validScope(value, propertyId)) throw new Error("finance_folio_port_contract_violation");
  return {
    ...envelope(value),
    page: {
      items: value.page.items.map(summary),
      nextCursor: value.page.nextCursor,
      limit: value.page.limit,
    },
  };
}

function detailResponse(value: FinanceFolioDetailResponse, propertyId: string) {
  if (!validScope(value, propertyId) || value.item.propertyId !== propertyId)
    throw new Error("finance_folio_port_contract_violation");
  const item = value.item;
  return {
    ...envelope(value),
    item: {
      ...summary(item),
      propertyId: item.propertyId,
      recipient: { name: item.recipient.name, email: item.recipient.email },
      currency: item.currency,
      lines: item.lines.map((line) => ({
        lineId: line.lineId,
        position: line.position,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitAmount: money(line.unitAmount),
        total: money(line.total),
        serviceOn: line.serviceOn,
        source: { type: line.source.type, id: line.source.id, revision: line.source.revision },
      })),
      paymentRefs: item.paymentRefs.map((payment) => ({
        paymentId: payment.paymentId,
        amount: money(payment.amount),
      })),
      sourceDigest: item.sourceDigest,
      sourceFreshness: { ...item.sourceFreshness },
    },
  };
}

function envelope(value: FinanceFolioListResponse | FinanceFolioDetailResponse) {
  return {
    contractVersion: value.contractVersion,
    propertyId: value.propertyId,
    currency: value.currency,
    timeZone: value.timeZone,
    generatedAt: value.generatedAt,
    sourceFreshness: { ...value.sourceFreshness },
    incompleteEvidence: value.incompleteEvidence.map((item) => ({
      code: item.code,
      count: item.count,
      ...(item.amount ? { amount: money(item.amount) } : {}),
    })),
  };
}

function summary(value: FinanceFolioSummary | FinanceFolio) {
  return {
    folioId: value.folioId,
    bookingId: value.bookingId,
    revision: value.revision,
    state: value.state,
    serviceFrom: value.serviceFrom,
    serviceTo: value.serviceTo,
    total: money(value.total),
    createdAt: value.createdAt,
  };
}

const money = (value: { amount: string; currency: string }) => ({
  amount: value.amount,
  currency: value.currency,
});
const validScope = (
  value: FinanceFolioListResponse | FinanceFolioDetailResponse,
  propertyId: string,
) => value.contractVersion === PMS_FINANCIALS_CONTRACT_VERSION && value.propertyId === propertyId;
const canonicalUuid = (value: unknown) =>
  typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
const empty = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

async function safe(reply: FastifyReply, work: () => Promise<unknown>) {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof FinanceFolioCursorError) return bad(reply, cause.code);
    if (cause instanceof FinanceFolioEvidenceError)
      return reply.status(422).send({ code: cause.code });
    return reply.status(500).send({ code: "finance_folio_port_contract_violation" });
  }
}
const bad = (reply: FastifyReply, code = "invalid_request") => reply.status(400).send({ code });
const missing = (reply: FastifyReply) => reply.status(404).send({ code: "not_found" });
