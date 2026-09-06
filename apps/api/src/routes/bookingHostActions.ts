import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { BookingHostActions, HostActionRequest } from "../domains/bookingHostActions.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";
import { writePmsOperationsCorsHeaders } from "./pmsOperations.js";

type Params = { propertyId: string; guestBookingId: string };
const uuid = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};
export async function registerBookingHostActionRoutes(
  app: FastifyInstance,
  options: {
    actions: BookingHostActions;
    propertyAccessRepository: PropertyAccessRepository;
    allowedOrigins?: string[];
  },
) {
  const actors = new WeakMap<FastifyRequest, string>();
  const path = "/properties/:propertyId/reservations/:guestBookingId/host-actions";
  const params = {
    type: "object",
    required: ["propertyId", "guestBookingId"],
    properties: { propertyId: uuid, guestBookingId: uuid },
  };
  app.addHook("onClose", () => options.actions.close());
  app.addHook("onRequest", async (request, reply) => {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.code(403).send({ message: "Origin is not allowed." });
    if (request.method === "OPTIONS") return;
    const route = request.params as Params;
    route.propertyId = route.propertyId.toLowerCase();
    route.guestBookingId = route.guestBookingId.toLowerCase();
    const context = await enforcePmsPropertyRoutePolicy(
      request,
      {
        propertyId: route.propertyId,
        permission: "pms.reservation.update",
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
      options.propertyAccessRepository,
    );
    actors.set(request, context.actor.internalUserId);
  });
  for (const suffix of ["preview", "apply"])
    app.options(`${path}/${suffix}`, async (_, reply) => reply.code(204).send());
  app.post<{ Params: Params; Body: HostActionRequest }>(
    `${path}/preview`,
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "reason"],
          properties: {
            action: { enum: ["edit_dates", "reject", "cancel"] },
            reason: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
            guestMessage: { type: "string", maxLength: 5000 },
            checkIn: { type: "string", format: "date" },
            checkOut: { type: "string", format: "date" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.action !== "edit_dates")
        await enforcePmsPropertyRoutePolicy(
          request,
          {
            propertyId: request.params.propertyId,
            permission: "pms.reservation.cancel",
            allowedRelationships: ["owner", "operator", "front_desk"],
          },
          options.propertyAccessRepository,
        );
      if (
        body.action === "edit_dates"
          ? !body.checkIn || !body.checkOut
          : body.checkIn || body.checkOut
      )
        return reply.code(400).send({ message: "Stay dates are required only for date editing." });
      return options.actions.preview(
        {
          propertyId: request.params.propertyId,
          bookingId: request.params.guestBookingId,
          actorUserId: actors.get(request)!,
        },
        {
          ...body,
          reason: body.reason.trim(),
          guestMessage: body.guestMessage?.replace(/\r\n?/g, "\n").trim() || undefined,
        },
      );
    },
  );
  app.post<{ Params: Params; Body: { previewId: string; idempotencyKey: string } }>(
    `${path}/apply`,
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["previewId", "idempotencyKey"],
          properties: {
            previewId: uuid,
            idempotencyKey: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
          },
        },
      },
    },
    async (request, reply) => {
      const scope = {
        propertyId: request.params.propertyId,
        bookingId: request.params.guestBookingId,
        actorUserId: actors.get(request)!,
      };
      const action = await options.actions.findAction(scope, request.body.previewId);
      if (!action)
        return reply
          .code(409)
          .send({
            code: "stale_preview",
            message: "Preview unavailable. Preview this action again.",
          });
      if (action !== "edit_dates")
        await enforcePmsPropertyRoutePolicy(
          request,
          {
            propertyId: scope.propertyId,
            permission: "pms.reservation.cancel",
            allowedRelationships: ["owner", "operator", "front_desk"],
          },
          options.propertyAccessRepository,
        );
      return options.actions.apply(
        scope,
        request.body.previewId.toLowerCase(),
        request.body.idempotencyKey,
      );
    },
  );
}
