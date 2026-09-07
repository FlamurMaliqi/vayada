import { apiClient, ApiErrorResponse, omitHotelContext, type ApiClient } from "./client";

export const BOOKING_RESERVATIONS_LIST_PATH = "/api/booking/hotels/:hotelId/reservations";

type BookingReservationsApiClient = Pick<ApiClient, "get">;

export interface GetBookingReservationsInput {
  hotelId: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BookingAssignedRoom {
  roomId: string | null;
  roomNumber: string | null;
  position: number;
}

export interface BookingReservation {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  roomLines?: Array<{ roomTypeId: string; roomName: string; roomCount: number }>;
  roomMaxOccupancy: number;
  totalRoomCapacity: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string;
  guestGender: string;
  guestDateOfBirth: string | null;
  guestPassportNumber: string;
  specialRequests: string;
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  numberOfRooms: number;
  totalAmount: number;
  currency: string;
  status: string;
  roomId: string | null;
  roomNumber: string | null;
  assignedRooms: BookingAssignedRoom[];
  channel: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number;
  checkInPendingFlags: string[];
  checkedInAt: string | null;
  checkedOutAt: string | null;
  hostResponseDeadline: string | null;
  platformFeeAmount: number | null;
  affiliateCommissionAmount: number | null;
  propertyPayoutAmount: number | null;
  addonIds: string[];
  addonNames: string[];
  addonTotal: number;
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
  guestWithdrawn: boolean;
  promoCode: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookingReservationList {
  bookings: BookingReservation[];
  total: number;
  limit: number;
  offset: number;
}

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

export class BookingReservationListClientError extends Error {
  statusCode: 400 | 401 | 403 | 500;
  code: BookingReservationListErrorCode;
  category: BookingReservationListErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 400 | 401 | 403 | 500;
    code: BookingReservationListErrorCode;
    category: BookingReservationListErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingReservationListClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingReservations(
  input: GetBookingReservationsInput,
  client: BookingReservationsApiClient = apiClient,
): Promise<BookingReservationList> {
  try {
    return await client.get<BookingReservationList>(
      buildBookingReservationsListEndpoint(input),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingReservationListClientError(error);
  }
}

export function buildBookingReservationsListEndpoint(input: GetBookingReservationsInput): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingReservationListClientError({
      statusCode: 400,
      code: "invalid_query",
      category: "validation",
      detail: "Booking hotel id is required.",
    });
  }

  const params = new URLSearchParams();
  appendQueryParam(params, "status", input.status);
  appendQueryParam(params, "search", input.search);
  appendQueryParam(params, "limit", input.limit);
  appendQueryParam(params, "offset", input.offset);

  const query = params.toString();
  const path = BOOKING_RESERVATIONS_LIST_PATH.replace(":hotelId", encodeURIComponent(hotelId));
  return query ? `${path}?${query}` : path;
}

export function toBookingReservationListClientError(
  error: unknown,
): BookingReservationListClientError {
  if (error instanceof BookingReservationListClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingReservationListClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail: error instanceof Error ? error.message : "Booking reservations are unavailable.",
  });
}

function appendQueryParam(
  params: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
): void {
  if (value == null) return;
  const serialized = String(value).trim();
  if (!serialized) return;
  params.set(key, serialized);
}

function mapApiError(error: ApiErrorResponse): BookingReservationListClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingReservationListClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingReservationListClientError({
      statusCode: 401,
      code: detail.toLowerCase().includes("invalid") ? "invalid_token" : "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingReservationListClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  if (error.status === 400) {
    return new BookingReservationListClientError({
      statusCode: 400,
      code: "invalid_query",
      category: "validation",
      detail,
    });
  }

  return new BookingReservationListClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 400 | 401 | 403 | 500;
  code: BookingReservationListErrorCode;
  category: BookingReservationListErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingReservationListErrorCode(data.code)) return null;
  if (!isBookingReservationListErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking reservations are unavailable.",
  };
}

function readApiErrorDetail(error: ApiErrorResponse): string {
  const data = error.data as Partial<{ detail: unknown; message: unknown }> | null;
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((entry) => entry.msg).join(", ");
  if (typeof data?.message === "string") return data.message;
  return error.message || "Booking reservations are unavailable.";
}

function toAuthorizationErrorCode(detail: string): BookingReservationListErrorCode {
  const normalized = detail.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (
    normalized.includes("inactive") ||
    normalized.includes("suspended") ||
    normalized.includes("disabled")
  ) {
    return "inactive_entitlement";
  }
  if (normalized.includes("entitlement")) return "missing_entitlement";
  return "missing_resource_access";
}

function toContractStatusCode(
  bodyStatusCode: unknown,
  responseStatus: number,
): 400 | 401 | 403 | 500 {
  if (
    bodyStatusCode === 400 ||
    bodyStatusCode === 401 ||
    bodyStatusCode === 403 ||
    bodyStatusCode === 500
  ) {
    return bodyStatusCode;
  }
  if (responseStatus === 400 || responseStatus === 401 || responseStatus === 403) {
    return responseStatus;
  }
  return 500;
}

function isBookingReservationListErrorCode(
  value: unknown,
): value is BookingReservationListErrorCode {
  return (
    value === "unauthenticated" ||
    value === "invalid_token" ||
    value === "missing_permission" ||
    value === "missing_entitlement" ||
    value === "inactive_entitlement" ||
    value === "missing_resource_access" ||
    value === "invalid_query" ||
    value === "read_model_unavailable"
  );
}

function isBookingReservationListErrorCategory(
  value: unknown,
): value is BookingReservationListErrorCategory {
  return (
    value === "authentication" ||
    value === "authorization" ||
    value === "validation" ||
    value === "read_model"
  );
}
