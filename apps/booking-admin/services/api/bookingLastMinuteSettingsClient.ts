import type { BookingPromotion } from "@vayada/domain-booking";
export type { BookingPromotion };
import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_LAST_MINUTE_SETTINGS_PATH =
  "/api/booking/hotels/:hotelId/settings/last-minute";

type BookingLastMinuteSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingLastMinuteSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface BookingLastMinuteTier {
  daysBeforeMin: number;
  daysBeforeMax: number | null;
  discountPercent: number;
}

export interface BookingLastMinuteSettings {
  promotions?: BookingPromotion[];
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: BookingLastMinuteTier[];
  updatedAt: string;
}

export type UpdateBookingLastMinuteSettingsBody = Omit<BookingLastMinuteSettings, "updatedAt">;

export interface GetBookingLastMinuteSettingsInput {
  hotelId: string;
}

export interface UpdateBookingLastMinuteSettingsInput {
  hotelId: string;
  body: UpdateBookingLastMinuteSettingsBody;
}

export type BookingLastMinuteSettingsClientErrorCategory = BookingSettingsClientErrorCategory;
export type BookingLastMinuteSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingLastMinuteSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingLastMinuteSettingsClientErrorCode;
  category: BookingLastMinuteSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingLastMinuteSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingLastMinuteSettings(
  input: GetBookingLastMinuteSettingsInput,
  client: BookingLastMinuteSettingsReadApiClient = apiClient,
): Promise<BookingLastMinuteSettings> {
  try {
    return await client.get<BookingLastMinuteSettings>(
      buildBookingLastMinuteSettingsEndpoint(input),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingLastMinuteSettingsClientError(error);
  }
}

export async function updateBookingLastMinuteSettings(
  input: UpdateBookingLastMinuteSettingsInput,
  client: BookingLastMinuteSettingsWriteApiClient = apiClient,
): Promise<BookingLastMinuteSettings> {
  try {
    return await client.put<BookingLastMinuteSettings>(
      buildBookingLastMinuteSettingsEndpoint(input),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingLastMinuteSettingsClientError(error, "write");
  }
}

export function buildBookingLastMinuteSettingsEndpoint(
  input: GetBookingLastMinuteSettingsInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingLastMinuteSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_LAST_MINUTE_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingLastMinuteSettingsClientError(
  error: unknown,
  operation: BookingSettingsClientOperation = "read",
): BookingLastMinuteSettingsClientError {
  if (error instanceof BookingLastMinuteSettingsClientError) {
    return error;
  }

  return new BookingLastMinuteSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking last-minute settings are unavailable.",
      readNotFound: true,
    }),
  );
}
