import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, post: mocks.post },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
  propertyEndpoint: (propertyId: string, path: string) =>
    `/api/pms/properties/${propertyId}/${path}`,
}));

vi.mock("../api/unsupported", () => ({
  unsupportedPmsNextStackFeature: vi.fn(),
}));

import { bookingsService, HIDDEN_GUEST_CONTACT } from ".";

const reservation = {
  guestBookingId: "booking-1",
  bookingReference: "VAY-1",
  status: "confirmed",
  source: "direct_booking" as const,
  stay: { checkIn: "2026-07-23", checkOut: "2026-07-24", adults: 2, children: 0 },
  primaryGuest: {
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    phone: null,
    countryCode: "GB",
  },
  assignments: [],
  checkin: { completedAt: null, pendingFlags: [] },
  checkout: { completedAt: null, pendingFlags: [] },
  bookedOffer: { roomTypeId: "room-type-1", roomName: "Munich Booking Room" },
  roomCount: 1,
  pricing: {
    totalAmount: { amountDecimal: "155.00", currency: "EUR" },
    balanceAmount: { amountDecimal: "155.00", currency: "EUR" },
  },
};

describe("PMS target booking projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/room-types")) {
        return { items: [] };
      }
      return {
        items: [reservation],
        pagination: { total: 1, limit: 50, offset: 0 },
      };
    });
  });

  it("uses the booked offer and authoritative booking amounts when no PMS assignment exists", async () => {
    const result = await bookingsService.list();

    expect(result.bookings[0]).toMatchObject({
      roomTypeId: "room-type-1",
      roomName: "Munich Booking Room",
      checkIn: "2026-07-23",
      checkOut: "2026-07-24",
      nightlyRate: 155,
      numberOfRooms: 1,
      totalAmount: 155,
      balanceAmount: 155,
      currency: "EUR",
      guestCountry: "GB",
    });
  });

  it("keeps an assigned room type authoritative over the booked-offer fallback", async () => {
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/room-types")) {
        return {
          items: [
            {
              roomTypeId: "assigned-room-type",
              name: "Assigned Suite",
              occupancyLimits: { total: 2 },
              baseRate: { amountDecimal: "180.00", currency: "EUR" },
            },
          ],
        };
      }
      return {
        items: [
          {
            ...reservation,
            assignments: [
              {
                assignmentId: "assignment-1",
                roomTypeId: "assigned-room-type",
                roomId: "room-101",
                roomNumber: "101",
                position: 1,
                channel: "direct",
              },
            ],
          },
        ],
        pagination: { total: 1, limit: 50, offset: 0 },
      };
    });

    const result = await bookingsService.list();

    expect(result.bookings[0]).toMatchObject({
      roomTypeId: "assigned-room-type",
      roomName: "Assigned Suite",
      roomId: "room-101",
      roomNumber: "101",
      nightlyRate: 180,
    });
  });
});

describe("PMS guest contact projection", () => {
  it("marks masked additional guest contact as read-only", async () => {
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.get.mockResolvedValue({
      items: [
        {
          guestId: "guest-2",
          guestBookingId: "booking-1",
          role: "additional_guest",
          displayName: "Charles Babbage",
          firstName: "Charles",
          lastName: "Babbage",
          email: HIDDEN_GUEST_CONTACT,
          phone: HIDDEN_GUEST_CONTACT,
          countryCode: "GB",
          arrivalTime: null,
          specialRequests: null,
        },
      ],
    });

    await expect(bookingsService.listAdditionalGuests("booking-1")).resolves.toEqual({
      guests: [
        expect.objectContaining({
          firstName: "Charles",
          nationality: "GB",
          email: HIDDEN_GUEST_CONTACT,
          phone: HIDDEN_GUEST_CONTACT,
          guestContactHidden: true,
        }),
      ],
    });
  });
});

describe("PMS booking date-change requests", () => {
  const changeRequest = {
    id: "change-1",
    bookingId: "booking-1",
    status: "accepted" as const,
    oldCheckIn: "2026-07-23",
    oldCheckOut: "2026-07-24",
    oldAddonIds: [],
    oldAddonQuantities: {},
    oldAddonDates: {},
    oldTotal: 155,
    requestedCheckIn: "2026-07-25",
    requestedCheckOut: "2026-07-26",
    requestedAddonIds: [],
    requestedAddonQuantities: {},
    requestedAddonDates: {},
    requestedAddonNames: [],
    newTotal: 175,
    priceDifference: 20,
    currency: "EUR",
    declineReason: null,
    decidedAt: "2026-07-22T10:00:00.000Z",
    createdAt: "2026-07-22T09:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
  });

  it("loads Booking-domain change requests and maps accepted to approved", async () => {
    mocks.get.mockResolvedValue(changeRequest);

    await expect(bookingsService.getChangeRequest("booking-1")).resolves.toMatchObject({
      id: "change-1",
      status: "approved",
    });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/booking/hotels/property-1/reservations/booking-1/change-request",
      expect.any(Object),
    );
  });

  it("accepts and declines through property-scoped Booking routes with idempotency", async () => {
    mocks.post.mockResolvedValueOnce(changeRequest).mockResolvedValueOnce({
      ...changeRequest,
      status: "declined",
      declineReason: "Dates are closed",
    });

    await expect(
      bookingsService.approveChangeRequest("booking-1", "change-1"),
    ).resolves.toMatchObject({ status: "approved" });
    await expect(
      bookingsService.declineChangeRequest("booking-1", "change-1", "Dates are closed"),
    ).resolves.toMatchObject({ status: "declined", declineReason: "Dates are closed" });

    expect(mocks.post.mock.calls[0]?.[0]).toBe(
      "/api/booking/hotels/property-1/reservations/booking-1/change-request/change-1/accept",
    );
    expect(mocks.post.mock.calls[0]?.[2]).toMatchObject({
      headers: expect.objectContaining({
        "Idempotency-Key": "booking.change:accept:booking-1:change-1",
      }),
    });
    expect(mocks.post.mock.calls[1]?.[0]).toBe(
      "/api/booking/hotels/property-1/reservations/booking-1/change-request/change-1/decline",
    );
    expect(mocks.post.mock.calls[1]?.[1]).toMatchObject({ reason: "Dates are closed" });
    expect(mocks.post.mock.calls[1]?.[2]).toMatchObject({
      headers: expect.objectContaining({
        "Idempotency-Key": "booking.change:decline:booking-1:change-1",
      }),
    });
  });
});
