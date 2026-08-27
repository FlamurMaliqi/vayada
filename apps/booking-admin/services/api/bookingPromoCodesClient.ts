import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
} from "./bookingSettingsClientError";

export const BOOKING_PROMO_CODES_PATH = "/api/booking/hotels/:hotelId/promo-codes";

type ReadClient = Pick<ApiClient, "get">;
type CreateClient = Pick<ApiClient, "post">;
type UpdateClient = Pick<ApiClient, "patch">;
type DeleteClient = Pick<ApiClient, "delete">;

export type BookingPromoDiscountType = "percentage" | "fixed";

export interface BookingPromoCode {
  promoCodeId: string;
  hotelId: string;
  propertyId: string;
  code: string;
  discountType: BookingPromoDiscountType;
  discountValue: string;
  minBookingValue: string | null;
  applicableRoomIds: string[] | null;
  validFrom: string | null;
  validUntil: string | null;
  stayDateFrom: string | null;
  stayDateUntil: string | null;
  isActive: boolean;
  maxUses: number;
  currentUses: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListBookingPromoCodesResponse {
  promoCodes: BookingPromoCode[];
}

export type CreateBookingPromoCodeBody = {
  code: string;
  discountType: BookingPromoDiscountType;
  discountValue: string;
  minBookingValue?: string | null;
  applicableRoomIds?: string[] | null;
  validFrom?: string | null;
  validUntil?: string | null;
  stayDateFrom?: string | null;
  stayDateUntil?: string | null;
  isActive?: boolean;
  maxUses: number;
};

export type UpdateBookingPromoCodeBody = Partial<CreateBookingPromoCodeBody>;

export class BookingPromoCodesClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingSettingsClientErrorCode;
  category: BookingSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingPromoCodesClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function listBookingPromoCodes(
  input: { hotelId: string },
  client: ReadClient = apiClient,
): Promise<BookingPromoCode[]> {
  try {
    const response = await client.get<ListBookingPromoCodesResponse>(
      buildBookingPromoCodesEndpoint(input.hotelId),
      omitHotelContext,
    );
    return response.promoCodes;
  } catch (error) {
    throw toBookingPromoCodesClientError(error, "read");
  }
}

export async function createBookingPromoCode(
  input: { hotelId: string; body: CreateBookingPromoCodeBody },
  client: CreateClient = apiClient,
): Promise<BookingPromoCode> {
  try {
    return await client.post<BookingPromoCode>(
      buildBookingPromoCodesEndpoint(input.hotelId),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingPromoCodesClientError(error, "write");
  }
}

export async function updateBookingPromoCode(
  input: { hotelId: string; promoCodeId: string; body: UpdateBookingPromoCodeBody },
  client: UpdateClient = apiClient,
): Promise<BookingPromoCode> {
  try {
    return await client.patch<BookingPromoCode>(
      buildBookingPromoCodeEndpoint(input.hotelId, input.promoCodeId),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingPromoCodesClientError(error, "write");
  }
}

export async function deleteBookingPromoCode(
  input: { hotelId: string; promoCodeId: string },
  client: DeleteClient = apiClient,
): Promise<void> {
  try {
    await client.delete<void>(
      buildBookingPromoCodeEndpoint(input.hotelId, input.promoCodeId),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingPromoCodesClientError(error, "write");
  }
}

export function buildBookingPromoCodesEndpoint(hotelId: string): string {
  const trimmed = hotelId.trim();
  if (!trimmed) throw missingHotelIdError();
  return BOOKING_PROMO_CODES_PATH.replace(":hotelId", encodeURIComponent(trimmed));
}

export function buildBookingPromoCodeEndpoint(hotelId: string, promoCodeId: string): string {
  const trimmedPromoCodeId = promoCodeId.trim();
  if (!trimmedPromoCodeId) throw missingPromoCodeIdError();
  return `${buildBookingPromoCodesEndpoint(hotelId)}/${encodeURIComponent(trimmedPromoCodeId)}`;
}

function toBookingPromoCodesClientError(
  error: unknown,
  operation: "read" | "write",
): BookingPromoCodesClientError {
  if (error instanceof BookingPromoCodesClientError) return error;
  return new BookingPromoCodesClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking promo codes are unavailable.",
      readNotFound: true,
    }),
  );
}

function missingHotelIdError(): BookingPromoCodesClientError {
  return new BookingPromoCodesClientError({
    statusCode: 422,
    code: "invalid_payload",
    category: "validation",
    detail: "Booking hotel id is required.",
  });
}

function missingPromoCodeIdError(): BookingPromoCodesClientError {
  return new BookingPromoCodesClientError({
    statusCode: 422,
    code: "invalid_payload",
    category: "validation",
    detail: "Booking promo-code id is required.",
  });
}
