import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  bookingHotelChangeDecisionFingerprint,
  type BookingHotelChangeDecisionBinding,
  type BookingHotelChangeDecisionContext,
  type BookingHotelChangeRequestRepository,
} from "./bookingWebPublic.js";
import { enforceRoutePolicy } from "./policy.js";

export type { BookingHotelChangeRequestRepository } from "./bookingWebPublic.js";

type BookingChangeRequestParams = {
  hotelId: string;
  bookingId: string;
};

type BookingChangeDecisionParams = BookingChangeRequestParams & {
  changeRequestId: string;
};

type BookingChangeDeclineBody = {
  reason?: string;
};

export async function registerBookingChangeRequestRoutes(
  app: FastifyInstance,
  repository: BookingHotelChangeRequestRepository,
): Promise<void> {
  app.get<{ Params: BookingChangeRequestParams }>(
    "/hotels/:hotelId/reservations/:bookingId/change-request",
    async (request) => {
      enforceBookingChangePolicy(request, request.params.hotelId, "read");
      return repository.findLatestChangeRequest(request.params.hotelId, request.params.bookingId);
    },
  );

  app.post<{ Params: BookingChangeDecisionParams }>(
    "/hotels/:hotelId/reservations/:bookingId/change-request/:changeRequestId/accept",
    async (request) => {
      const context = enforceBookingChangePolicy(request, request.params.hotelId, "write");
      return repository.acceptChangeRequest(
        request.params.hotelId,
        request.params.bookingId,
        request.params.changeRequestId,
        decisionContext(request, context.actor.internalUserId, {
          propertyId: request.params.hotelId,
          bookingId: request.params.bookingId,
          changeRequestId: request.params.changeRequestId,
          decision: "accept",
          note: null,
        }),
      );
    },
  );

  app.post<{ Params: BookingChangeDecisionParams; Body: BookingChangeDeclineBody }>(
    "/hotels/:hotelId/reservations/:bookingId/change-request/:changeRequestId/decline",
    async (request) => {
      const context = enforceBookingChangePolicy(request, request.params.hotelId, "write");
      const note = optionalDecisionNote(request.body?.reason);
      return repository.declineChangeRequest(
        request.params.hotelId,
        request.params.bookingId,
        request.params.changeRequestId,
        note,
        decisionContext(request, context.actor.internalUserId, {
          propertyId: request.params.hotelId,
          bookingId: request.params.bookingId,
          changeRequestId: request.params.changeRequestId,
          decision: "decline",
          note,
        }),
      );
    },
  );
}

function enforceBookingChangePolicy(
  request: FastifyRequest,
  hotelId: string,
  access: "read" | "write",
) {
  const permission = access === "read" ? "booking.reservation.read" : "pms.booking.update";
  return enforceRoutePolicy(request, {
    permission,
    entitlement: {
      product: "booking",
      key: "booking-engine",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
      },
    },
    resource: {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: hotelId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function decisionContext(
  request: FastifyRequest,
  actorUserId: string,
  decision: BookingHotelChangeDecisionBinding,
): BookingHotelChangeDecisionContext {
  const requestId = String(request.id);
  const idempotencyHeader = request.headers["idempotency-key"];
  const idempotencyKey =
    typeof idempotencyHeader === "string" && idempotencyHeader.trim()
      ? idempotencyHeader.trim()
      : `booking.change.${decision.decision}:${requestId}`;
  return {
    actorUserId,
    requestId,
    correlationId:
      typeof request.headers["x-correlation-id"] === "string"
        ? request.headers["x-correlation-id"]
        : requestId,
    idempotencyKey,
    fingerprint: bookingHotelChangeDecisionFingerprint(decision),
    occurredAt: new Date(),
  };
}

function optionalDecisionNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim();
  if (!note) return null;
  if (note.length > 1000) {
    const error = new Error("Decline reason must be 1000 characters or fewer.") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  }
  return note;
}
