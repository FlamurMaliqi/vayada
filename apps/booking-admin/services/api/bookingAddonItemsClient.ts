import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
} from "./bookingSettingsClientError";

export const BOOKING_ADDON_ITEMS_PATH = "/api/booking/hotels/:hotelId/addon-items";

type ReadClient = Pick<ApiClient, "get">;
type CreateClient = Pick<ApiClient, "post">;
type UpdateClient = Pick<ApiClient, "patch">;
type DeleteClient = Pick<ApiClient, "delete">;

export type BookingAddonPricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";
export type BookingAddonOwnershipKind = "property" | "partner";

export interface BookingAddonItem {
  addonItemId: string;
  hotelId: string;
  propertyId: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  category: "dining" | "experience" | "transport" | "wellness" | "other";
  imageUrl: string | null;
  duration: string | null;
  pricingModel: BookingAddonPricingModel;
  publicVisible: boolean;
  status: "active" | "disabled" | "retired";
  sortOrder: number;
  ownershipKind: BookingAddonOwnershipKind;
  partnerCommissionRate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListBookingAddonItemsResponse {
  addonItems: BookingAddonItem[];
  propertyPlan: BookingPropertyPlan;
}

export interface BookingPropertyPlan {
  propertyId: string;
  plan: "commission" | "fixed";
  limits: {
    maxRoomPhotosPerType: number;
    maxAddons: number;
    guestContactAccess: "after_acceptance" | "always";
  };
}

type BookingAddonItemWriteFields = {
  name: string;
  description?: string;
  price: string;
  currency: string;
  category: BookingAddonItem["category"];
  imageUrl?: string | null;
  duration?: string | null;
  pricingModel?: BookingAddonPricingModel;
  publicVisible?: boolean;
  status?: "active" | "disabled";
  sortOrder?: number;
};

type BookingAddonEconomicTerms =
  | { ownershipKind?: never; partnerCommissionRate?: never }
  | { ownershipKind: "property"; partnerCommissionRate?: null }
  | { ownershipKind: "partner"; partnerCommissionRate: string };

export type CreateBookingAddonItemBody = BookingAddonItemWriteFields & BookingAddonEconomicTerms;

export type UpdateBookingAddonItemBody = Partial<BookingAddonItemWriteFields> &
  BookingAddonEconomicTerms;

export class BookingAddonItemsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingSettingsClientErrorCode;
  category: BookingSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingAddonItemsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function listBookingAddonItems(
  input: { hotelId: string },
  client: ReadClient = apiClient,
): Promise<BookingAddonItem[]> {
  return (await getBookingAddonItemsContext(input, client)).addonItems;
}

export async function getBookingAddonItemsContext(
  input: { hotelId: string },
  client: ReadClient = apiClient,
): Promise<ListBookingAddonItemsResponse> {
  try {
    return await client.get<ListBookingAddonItemsResponse>(
      buildBookingAddonItemsEndpoint(input.hotelId),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingAddonItemsClientError(error, "read");
  }
}

export async function createBookingAddonItem(
  input: { hotelId: string; body: CreateBookingAddonItemBody },
  client: CreateClient = apiClient,
): Promise<BookingAddonItem> {
  try {
    return await client.post<BookingAddonItem>(
      buildBookingAddonItemsEndpoint(input.hotelId),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingAddonItemsClientError(error, "write");
  }
}

export async function updateBookingAddonItem(
  input: { hotelId: string; addonItemId: string; body: UpdateBookingAddonItemBody },
  client: UpdateClient = apiClient,
): Promise<BookingAddonItem> {
  try {
    return await client.patch<BookingAddonItem>(
      buildBookingAddonItemEndpoint(input.hotelId, input.addonItemId),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingAddonItemsClientError(error, "write");
  }
}

export async function deleteBookingAddonItem(
  input: { hotelId: string; addonItemId: string },
  client: DeleteClient = apiClient,
): Promise<void> {
  try {
    await client.delete<void>(
      buildBookingAddonItemEndpoint(input.hotelId, input.addonItemId),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingAddonItemsClientError(error, "write");
  }
}

export function buildBookingAddonItemsEndpoint(hotelId: string): string {
  const trimmed = hotelId.trim();
  if (!trimmed) throw missingHotelIdError();
  return BOOKING_ADDON_ITEMS_PATH.replace(":hotelId", encodeURIComponent(trimmed));
}

export function buildBookingAddonItemEndpoint(hotelId: string, addonItemId: string): string {
  const trimmedAddonItemId = addonItemId.trim();
  if (!trimmedAddonItemId) throw missingAddonItemIdError();
  return `${buildBookingAddonItemsEndpoint(hotelId)}/${encodeURIComponent(trimmedAddonItemId)}`;
}

function toBookingAddonItemsClientError(
  error: unknown,
  operation: "read" | "write",
): BookingAddonItemsClientError {
  if (error instanceof BookingAddonItemsClientError) return error;
  return new BookingAddonItemsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking add-on items are unavailable.",
      readNotFound: true,
    }),
  );
}

function missingHotelIdError(): BookingAddonItemsClientError {
  return new BookingAddonItemsClientError({
    statusCode: 404,
    code: "not_found",
    category: "read_model",
    detail: "Booking hotel id is required.",
  });
}

function missingAddonItemIdError(): BookingAddonItemsClientError {
  return new BookingAddonItemsClientError({
    statusCode: 404,
    code: "not_found",
    category: "write_model",
    detail: "Booking add-on item id is required.",
  });
}
