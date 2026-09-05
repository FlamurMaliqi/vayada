import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { PmsConfirmationEmails } from "../domains/pmsConfirmationEmails.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";
import { writePmsOperationsCorsHeaders } from "./pmsOperations.js";

type Params = { propertyId: string; guestBookingId: string; jobId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function registerPmsConfirmationEmailRoutes(
  app: FastifyInstance,
  options: {
    emails: PmsConfirmationEmails;
    propertyAccessRepository: PropertyAccessRepository;
    allowedOrigins?: string[];
  },
) {
  const actors = new WeakMap<FastifyRequest, string>();
  const path = "/properties/:propertyId/reservations/:guestBookingId/confirmation-email";
  app.addHook("onClose", () => options.emails.close());
  app.addHook("onRequest", async (request, reply) => {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.code(403).send({ message: "Origin is not allowed." });
    if (request.method === "OPTIONS") return;
    const params = request.params as Params;
    params.propertyId = params.propertyId.toLowerCase();
    params.guestBookingId = params.guestBookingId.toLowerCase();
    if (params.jobId) params.jobId = params.jobId.toLowerCase();
    const { propertyId, guestBookingId, jobId } = params;
    const context = await enforcePmsPropertyRoutePolicy(
      request,
      {
        propertyId,
        permission: "pms.reservation.update",
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
      options.propertyAccessRepository,
    );
    actors.set(request, context.actor.internalUserId);
    if (![propertyId, guestBookingId, ...(jobId ? [jobId] : [])].every((id) => uuid.test(id)))
      return reply.code(400).send({ message: "Invalid reservation identifier." });
  });
  for (const route of [path, `${path}/:jobId`])
    app.options(route, async (_, reply) => reply.code(204).send());
  app.post<{ Params: Params; Body: { idempotencyKey?: string } }>(path, async (request, reply) => {
    const key = request.body?.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 200)
      return reply.code(400).send({ message: "An idempotency key is required." });
    const result = await options.emails.request(
      request.params.propertyId,
      request.params.guestBookingId,
      key,
      actors.get(request)!,
    );
    if ("error" in result) return reply.code(409).send({ message: result.error });
    return reply.code(202).send(result);
  });
  app.get<{ Params: Params }>(`${path}/:jobId`, async (request, reply) => {
    const result = await options.emails.status(
      request.params.propertyId,
      request.params.guestBookingId,
      request.params.jobId!,
    );
    return result ?? reply.code(404).send({ message: "Email request not found." });
  });
}
