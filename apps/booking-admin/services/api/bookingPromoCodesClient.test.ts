import { describe, expect, it } from "vitest";

import {
  BookingPromoCodesClientError,
  createBookingPromoCode,
  deleteBookingPromoCode,
  listBookingPromoCodes,
  updateBookingPromoCode,
  type BookingPromoCode,
  type CreateBookingPromoCodeBody,
  type UpdateBookingPromoCodeBody,
} from "./bookingPromoCodesClient";
import { ApiErrorResponse, type ApiClient } from "./client";

type ReadClient = Pick<ApiClient, "get">;
type CreateClient = Pick<ApiClient, "post">;
type UpdateClient = Pick<ApiClient, "patch">;
type DeleteClient = Pick<ApiClient, "delete">;

const omitHotelContextOptions = {
  headers: { "X-Vayada-Omit-Hotel-Context": "true" },
};

const promoCode: BookingPromoCode = {
  promoCodeId: "promo_summer20",
  hotelId: "booking_hotel_alpenrose",
  propertyId: "property_alpenrose",
  code: "SUMMER20",
  discountType: "percentage",
  discountValue: "20.00",
  minBookingValue: "500.00",
  applicableRoomIds: ["room-type-1"],
  validFrom: "2026-07-01",
  validUntil: "2026-08-31",
  stayDateFrom: "2026-08-01",
  stayDateUntil: "2026-09-30",
  isActive: true,
  maxUses: 50,
  currentUses: 3,
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

describe("booking promo-code clients", () => {
  it("lists promo codes through the typed target endpoint", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const client: ReadClient = {
      get: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return { promoCodes: [promoCode] } as T;
      },
    };

    const result = await listBookingPromoCodes({ hotelId: " hotel/with space " }, client);

    expect(result).toEqual([promoCode]);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/hotel%2Fwith%20space/promo-codes",
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("creates promo codes through the typed target endpoint", async () => {
    const body: CreateBookingPromoCodeBody = {
      code: "summer25",
      discountType: "percentage",
      discountValue: "25.00",
      validFrom: "2026-07-01",
      validUntil: "2026-08-31",
      isActive: true,
      maxUses: 25,
    };
    const calls: Array<{ endpoint: string; body: unknown; options?: RequestInit }> = [];
    const client: CreateClient = {
      post: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return { ...promoCode, ...body, code: "SUMMER25" } as T;
      },
    };

    const result = await createBookingPromoCode(
      { hotelId: "booking_hotel_alpenrose", body },
      client,
    );

    expect(result.code).toBe("SUMMER25");
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
        body,
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("updates promo codes through the typed target endpoint", async () => {
    const body: UpdateBookingPromoCodeBody = {
      code: "SUMMER30",
      discountValue: "30.00",
    };
    const calls: Array<{ endpoint: string; body: unknown; options?: RequestInit }> = [];
    const client: UpdateClient = {
      patch: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return { ...promoCode, ...body } as T;
      },
    };

    const result = await updateBookingPromoCode(
      {
        hotelId: "booking_hotel_alpenrose",
        promoCodeId: "promo/with space",
        body,
      },
      client,
    );

    expect(result).toMatchObject(body);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes/promo%2Fwith%20space",
        body,
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("deletes promo codes through the typed target endpoint", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const client: DeleteClient = {
      delete: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return undefined as T;
      },
    };

    await deleteBookingPromoCode(
      {
        hotelId: "booking_hotel_alpenrose",
        promoCodeId: "promo/with space",
      },
      client,
    );

    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes/promo%2Fwith%20space",
        options: omitHotelContextOptions,
      },
    ]);
  });

  it("maps duplicate-code contract errors to typed client errors", async () => {
    const client: CreateClient = {
      post: async () => {
        throw new ApiErrorResponse(409, {
          statusCode: 409,
          code: "conflict",
          category: "validation",
          message: "Booking promo-code already exists for this hotel.",
        } as never);
      },
    };

    const error = await catchError(() =>
      createBookingPromoCode(
        {
          hotelId: "booking_hotel_alpenrose",
          body: {
            code: "SUMMER20",
            discountType: "percentage",
            discountValue: "20.00",
            maxUses: 1,
          },
        },
        client,
      ),
    );

    expect(error).toBeInstanceOf(BookingPromoCodesClientError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: "conflict",
      category: "validation",
      detail: "Booking promo-code already exists for this hotel.",
    });
  });

  it("rejects empty hotel and promo-code ids before calling the API", async () => {
    const client: DeleteClient = {
      delete: async () => {
        throw new Error("delete should not be called");
      },
    };

    await expect(
      deleteBookingPromoCode(
        {
          hotelId: "   ",
          promoCodeId: "promo_summer20",
        },
        client,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      detail: "Booking hotel id is required.",
    });

    await expect(
      deleteBookingPromoCode(
        {
          hotelId: "booking_hotel_alpenrose",
          promoCodeId: "   ",
        },
        client,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      detail: "Booking promo-code id is required.",
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
