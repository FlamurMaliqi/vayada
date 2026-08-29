import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthorizationError,
  hasPermission,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import type { HttpRouteContract } from "@vayada/backend-http";
import type {
  BookingAssignedRoom,
  BookingReservationListFilters,
  BookingReservationListResult,
  BookingReservationReadModel,
  BookingReservationsReadRepository,
} from "@vayada/domain-booking";

import { HIDDEN_GUEST_CONTACT } from "../domains/bookingGuestContactAccess.js";
import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

export const BOOKING_RESERVATION_LIST_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/reservations",
  permission: "booking.reservation.read",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_RESERVATION_LIST_DEFAULT_LIMIT = 50;
export const BOOKING_RESERVATION_LIST_MIN_LIMIT = 1;
export const BOOKING_RESERVATION_LIST_MAX_LIMIT = 500;
export const BOOKING_RESERVATION_LIST_DEFAULT_OFFSET = 0;

export type BookingReservationListPathParams = {
  hotelId: string;
};

export type BookingReservationListQuery = {
  status?: string;
  search?: string;
  limit?: string;
  offset?: string;
};

export type BookingReservationQuery = BookingReservationListQuery;

export type BookingReservationListRequest = {
  params: BookingReservationListPathParams;
  query: BookingReservationListQuery;
};

export type {
  BookingReservationListFilters,
  BookingReservationListResult,
  BookingReservationReadModel,
  BookingReservationsReadRepository,
};

export type BookingAssignedRoomResponse = BookingAssignedRoom;

/**
 * Booking Engine reservation read contract.
 *
 * The HTTP route depends on this product-level shape, not on Vayada PMS tables
 * or any specific external PMS schema. Authorized hotels with no matching rows
 * return a successful empty list rather than a 404.
 */
export type BookingReservationResponse = BookingReservationReadModel;

export type BookingReservationListResponse = {
  bookings: BookingReservationResponse[];
  total: number;
  limit: number;
  offset: number;
};

export type BookingReservation = BookingReservationResponse;

export type BookingReservationListErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "read_model";

export type BookingReservationListErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_query"
  | "read_model_unavailable";

export type BookingReservationListError = {
  statusCode: 400 | 401 | 403 | 500;
  code: BookingReservationListErrorCode;
  category: BookingReservationListErrorCategory;
  message: string;
};

export type BookingReservationList = BookingReservationListResponse;

export type BookingReservationListContract = HttpRouteContract<
  BookingReservationListRequest,
  BookingReservationListResponse,
  BookingReservationListError
> & {
  method: typeof BOOKING_RESERVATION_LIST_CONTRACT.method;
  path: typeof BOOKING_RESERVATION_LIST_CONTRACT.path;
};

export async function registerBookingReservationRoutes(
  app: FastifyInstance,
  repository: BookingReservationsReadRepository,
  propertyAccessRepository: PropertyAccessRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{
    Params: BookingReservationListPathParams;
    Querystring: BookingReservationListQuery;
  }>("/hotels/:hotelId/reservations", async (request, reply) => {
    const { hotelId } = request.params;
    let propertyId: string;
    let entitlementResourceId = hotelId;
    let canReadGuestContact = false;

    try {
      enforceRoutePolicy(request, { permission: "booking.reservation.read" });
      const resolvedPropertyId = await repository.resolveCanonicalPropertyId(hotelId);
      if (!resolvedPropertyId) throw new AuthorizationError();
      propertyId = resolvedPropertyId;
      entitlementResourceId = propertyId;
      const context = await enforcePropertyRoutePolicy(
        request,
        {
          permission: "booking.reservation.read",
          property: {
            propertyId,
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
        propertyAccessRepository,
      );
      canReadGuestContact = hasPermission(context, "pms.guest_contact.read");
    } catch (error) {
      const contractError = toBookingReservationListAccessError(
        error,
        request,
        entitlementResourceId,
      );
      if (contractError) {
        return sendBookingReservationListError(reply, contractError);
      }
      request.log.error({ err: error }, "Booking reservation property access read failed");
      return sendBookingReservationListError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Booking reservations are unavailable.",
      });
    }

    const filters = toReservationFilters(request.query, canReadGuestContact);
    let result: BookingReservationListResult;
    try {
      result = await repository.listReservationsByPropertyId(propertyId, filters);
    } catch {
      return sendBookingReservationListError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Booking reservations are unavailable.",
      });
    }

    return {
      bookings: canReadGuestContact
        ? result.reservations
        : result.reservations.map((reservation) => ({
            ...reservation,
            guestEmail: HIDDEN_GUEST_CONTACT,
            guestPhone: HIDDEN_GUEST_CONTACT,
          })),
      total: result.total,
      limit: filters.limit,
      offset: filters.offset,
    } satisfies BookingReservationListResponse;
  });
}

function sendBookingReservationListError(
  reply: FastifyReply,
  error: BookingReservationListError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function toBookingReservationListAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingReservationListError | null {
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

  const code = toBookingReservationAuthorizationErrorCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingReservationAuthorizationMessage(code),
  };
}

function toBookingReservationAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): Exclude<
  BookingReservationListErrorCode,
  "unauthenticated" | "invalid_token" | "invalid_query" | "read_model_unavailable"
> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingReservationEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingReservationAuthorizationMessage(
  code: Exclude<
    BookingReservationListErrorCode,
    "unauthenticated" | "invalid_token" | "invalid_query" | "read_model_unavailable"
  >,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking reservation permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function hasInactiveBookingReservationEntitlement(
  request: FastifyRequest,
  hotelId: string,
): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function toReservationFilters(
  query: BookingReservationListQuery,
  canReadGuestContact: boolean,
): BookingReservationListFilters {
  return {
    status: query.status?.trim() || undefined,
    search: query.search?.trim() || undefined,
    canReadGuestContact,
    limit: clampInteger(
      query.limit,
      BOOKING_RESERVATION_LIST_DEFAULT_LIMIT,
      BOOKING_RESERVATION_LIST_MIN_LIMIT,
      BOOKING_RESERVATION_LIST_MAX_LIMIT,
    ),
    offset: clampInteger(
      query.offset,
      BOOKING_RESERVATION_LIST_DEFAULT_OFFSET,
      BOOKING_RESERVATION_LIST_DEFAULT_OFFSET,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function clampInteger(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}
