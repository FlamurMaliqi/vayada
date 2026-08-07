import { describe, expect, it } from "vitest";

import {
  BookingAddonItemsClientError,
  createBookingAddonItem,
  deleteBookingAddonItem,
  listBookingAddonItems,
  updateBookingAddonItem,
  type BookingAddonItem,
  type CreateBookingAddonItemBody,
  type UpdateBookingAddonItemBody,
} from "./bookingAddonItemsClient";
import { ApiErrorResponse, type ApiClient } from "./client";

type ReadClient = Pick<ApiClient, "get">;
type CreateClient = Pick<ApiClient, "post">;
type UpdateClient = Pick<ApiClient, "patch">;
type DeleteClient = Pick<ApiClient, "delete">;

const omitHotelContextOptions = {
  headers: { "X-Vayada-Omit-Hotel-Context": "true" },
};

const addonItem: BookingAddonItem = {
  addonItemId: "addon_airport_transfer",
  hotelId: "booking_hotel_alpenrose",
  propertyId: "property_alpenrose",
  name: "Airport transfer",
  description: "Private pickup from the airport.",
  price: "45.00",
  currency: "EUR",
  category: "transport",
  imageUrl: null,
  duration: "45 min",
  pricingModel: "per_stay",
  publicVisible: true,
  status: "active",
  sortOrder: 0,
  ownershipKind: "property",
  partnerCommissionRate: null,
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

// @ts-expect-error Commission updates require an ownership kind.
const invalidEconomicUpdate: UpdateBookingAddonItemBody = { partnerCommissionRate: null };
void invalidEconomicUpdate;

describe("booking add-on item clients", () => {
  it("lists add-on items through the typed target endpoint", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const client: ReadClient = {
      get: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return { addonItems: [addonItem] } as T;
      },
    };

    const result = await listBookingAddonItems({ hotelId: " hotel/with space " }, client);

    expect(result).toEqual([addonItem]);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/hotel%2Fwith%20space/addon-items",
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("creates add-on items through the typed target endpoint", async () => {
    const body: CreateBookingAddonItemBody = {
      name: "Spa ritual",
      description: "Private treatment.",
      price: "125.50",
      currency: "EUR",
      category: "wellness",
      pricingModel: "per_guest",
      publicVisible: false,
      status: "disabled",
      ownershipKind: "partner",
      partnerCommissionRate: "20.1250",
    };
    const calls: Array<{ endpoint: string; body: unknown; options?: RequestInit }> = [];
    const client: CreateClient = {
      post: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return { ...addonItem, ...body } as T;
      },
    };

    const result = await createBookingAddonItem(
      { hotelId: "booking_hotel_alpenrose", body },
      client,
    );

    expect(result).toMatchObject(body);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
        body,
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("updates add-on items through the typed target endpoint", async () => {
    const body: UpdateBookingAddonItemBody = {
      name: "Private airport transfer",
      price: "55.00",
      ownershipKind: "property",
      partnerCommissionRate: null,
    };
    const calls: Array<{ endpoint: string; body: unknown; options?: RequestInit }> = [];
    const client: UpdateClient = {
      patch: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return { ...addonItem, ...body } as T;
      },
    };

    const result = await updateBookingAddonItem(
      {
        hotelId: "booking_hotel_alpenrose",
        addonItemId: "addon/with space",
        body,
      },
      client,
    );

    expect(result).toMatchObject(body);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/addon-items/addon%2Fwith%20space",
        body,
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("deletes add-on items through the typed target endpoint", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const client: DeleteClient = {
      delete: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return undefined as T;
      },
    };

    await deleteBookingAddonItem(
      {
        hotelId: "booking_hotel_alpenrose",
        addonItemId: "addon/with space",
      },
      client,
    );

    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/addon-items/addon%2Fwith%20space",
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("maps write contract errors to typed client errors", async () => {
    const details = ["price must be a non-negative decimal string."];
    const client: CreateClient = {
      post: async () => {
        throw new ApiErrorResponse(422, {
          statusCode: 422,
          code: "invalid_payload",
          category: "validation",
          message: "Booking add-on item payload is invalid.",
          details,
        } as never);
      },
    };

    const error = await catchError(() =>
      createBookingAddonItem(
        {
          hotelId: "booking_hotel_alpenrose",
          body: {
            name: "Spa ritual",
            price: "125.50",
            currency: "EUR",
            category: "wellness",
          },
        },
        client,
      ),
    );

    expect(error).toBeInstanceOf(BookingAddonItemsClientError);
    expect(error).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      detail: "Booking add-on item payload is invalid.",
      details,
    });
  });

  it("rejects empty hotel and add-on item ids before calling the API", async () => {
    const client: DeleteClient = {
      delete: async () => {
        throw new Error("delete should not be called");
      },
    };

    await expect(
      deleteBookingAddonItem(
        {
          hotelId: "   ",
          addonItemId: "addon_airport_transfer",
        },
        client,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });

    await expect(
      deleteBookingAddonItem(
        {
          hotelId: "booking_hotel_alpenrose",
          addonItemId: "   ",
        },
        client,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
      category: "write_model",
      detail: "Booking add-on item id is required.",
    });
  });
});

async function catchError(input: () => Promise<unknown>): Promise<unknown> {
  try {
    await input();
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
