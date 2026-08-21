import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceFolioQuery,
  type FinanceFolioDetailResponse,
  type FinanceFolioListResponse,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

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
      reply.header("Cache-Control", "private, no-store").header("Vary", "Origin, Authorization");
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

// Runtime decoding protects the HTTP boundary even when an injected repository violates its TS type.
const id = z.string().regex(UUID);
const currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{4}$/);
const instant = z.string().refine(utc);
const date = z.string().refine(localDate);
const money = z.object({ amount: decimal, currency }).strict();
// prettier-ignore
const summaryShape = { folioId: id, bookingId: id.nullable(), revision: z.number().int().positive(), state: z.enum(["draft", "ready", "superseded", "archived"]), serviceFrom: date, serviceTo: date, total: money, createdAt: instant };
const validInterval = (value: { serviceFrom: string; serviceTo: string }) =>
  value.serviceTo >= value.serviceFrom;
const folioSummary = z.object(summaryShape).strict().refine(validInterval);
// prettier-ignore
const envelope = z.object({ contractVersion: z.literal(PMS_FINANCIALS_CONTRACT_VERSION), propertyId: id, currency, timeZone: z.string().refine(zone), generatedAt: instant, sourceFreshness: z.record(z.string(), z.string()), incompleteEvidence: z.array(z.object({ code: z.string(), count: z.number().int().nonnegative(), amount: money.optional() }).strict()) }).strict();
// prettier-ignore
const line = z.object({ lineId: id, position: z.number().int().positive(), kind: z.enum(["room", "addon", "fee", "tax", "adjustment"]), description: z.string(), quantity: decimal, unitAmount: money, total: money, serviceOn: date, source: z.object({ type: z.string(), id: z.string(), revision: z.number().int().positive() }).strict() }).strict();
// prettier-ignore
const folio = z.object({ ...summaryShape, propertyId: id, recipient: z.object({ name: z.string().refine(trimmed), email: z.string().refine(email).nullable() }).strict(), currency, lines: z.array(line), paymentRefs: z.array(z.object({ paymentId: id, amount: money }).strict()), sourceDigest: z.string().regex(/^[0-9a-f]{64}$/), sourceFreshness: z.record(z.string(), instant) }).strict().refine(validInterval);
const listSchema = envelope.extend({
  page: z
    .object({
      items: z.array(folioSummary),
      nextCursor: z.string().min(2).max(4096).nullable(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
});
const detailSchema = envelope.extend({ item: folio });

function listResponse(value: FinanceFolioListResponse, propertyId: string) {
  const parsed = listSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.propertyId !== propertyId ||
    parsed.data.incompleteEvidence.some(
      (item) => item.amount && item.amount.currency !== parsed.data.currency,
    ) ||
    parsed.data.page.items.some((item) => item.total.currency !== parsed.data.currency)
  )
    throw new Error("finance_folio_port_contract_violation");
  return parsed.data;
}

function detailResponse(value: FinanceFolioDetailResponse, propertyId: string) {
  const parsed = detailSchema.safeParse(value);
  if (!parsed.success) throw new Error("finance_folio_port_contract_violation");
  const { data } = parsed;
  const currencies = [
    data.item.total.currency,
    ...data.item.lines.flatMap((item) => [item.unitAmount.currency, item.total.currency]),
    ...data.item.paymentRefs.map((item) => item.amount.currency),
  ];
  if (
    data.propertyId !== propertyId ||
    data.item.propertyId !== propertyId ||
    data.item.currency !== data.currency ||
    data.incompleteEvidence.some((item) => item.amount && item.amount.currency !== data.currency) ||
    currencies.some((value) => value !== data.currency)
  )
    throw new Error("finance_folio_port_contract_violation");
  return data;
}

const canonicalUuid = (value: unknown) =>
  typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
const empty = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
// prettier-ignore
function localDate(value: string) { if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function trimmed(value: string) {
  return value.length > 0 && value === value.trim();
}
function email(value: string) {
  return trimmed(value) && value.includes("@");
}
function zone(value: string) {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}
// prettier-ignore
function utc(value: string) { const match = /^((?!0000)\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value); if (!match) return false; const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),parsed=new Date(0); parsed.setUTCFullYear(year,month-1,day); parsed.setUTCHours(hour,minute,second,0); return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear()===year && parsed.getUTCMonth()===month-1 && parsed.getUTCDate()===day && parsed.getUTCHours()===hour && parsed.getUTCMinutes()===minute && parsed.getUTCSeconds()===second; }

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
