import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, patch: mocks.patch, post: mocks.post },
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
import { calendarService } from "../calendar";
import { createElement } from "react";
import { create } from "react-test-renderer";
import MobileCalendar, { calendarLaneTop } from "../../components/calendar/MobileCalendar";
// prettier-ignore
import { bookingSettlementLabel, expectedPaymentMethodLabel } from "../../components/bookings/BookingStaySummary";

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
    specialRequests: null,
  },
  addOns: [],
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

// prettier-ignore
const roomTypes = ["Suite", "Studio"].map((name, index) => ({ roomTypeId: `type-${index + 1}`, name, category: "", occupancyLimits: { total: index ? 4 : 2 }, baseRate: { amountDecimal: "100.00", currency: "EUR" }, roomCount: 1, ratePlans: [{ ratePlanId: `plan-${index + 1}`, name: `Plan ${index + 1}`, rateType: "flexible", baseRate: { amountDecimal: "100.00", currency: "EUR" }, active: true }] }));
// prettier-ignore
const assignments = [
  { assignmentId: "a-1", roomTypeId: "type-1", ratePlanId: "plan-1", roomId: "room-1", roomNumber: "101", position: 1, channel: "direct", stay: { checkIn: "2026-09-10", checkOut: "2026-09-12", adults: 1, children: 0 }, nightly: [{ serviceDate: "2026-09-10", applied: { amountDecimal: "100.00", currency: "EUR" }, evidenceQuality: "exact" }] },
  { assignmentId: "a-2", roomTypeId: "type-2", ratePlanId: "plan-2", roomId: "room-2", roomNumber: "202", position: 2, channel: "direct", stay: { checkIn: "2026-09-12", checkOut: "2026-09-15", adults: 2, children: 1 }, nightly: [{ serviceDate: "2026-09-12", applied: { amountDecimal: "180.00", currency: "EUR" }, evidenceQuality: "exact" }] },
];
// prettier-ignore
const heterogeneousReservation = { ...reservation, stay: { checkIn: "2026-08-01", checkOut: "2026-08-02", adults: 3, children: 1 }, assignments, roomCount: 2, payment: { method: null, expectedMethod: "cash", status: "unpaid" } };
// prettier-ignore
const reservationPage = (item: object) => ({ items: [item], pagination: { total: 1, limit: 500, offset: 0 } });
// prettier-ignore
const calendarResponse = (item: object) => async (endpoint: string) => endpoint.endsWith("/room-types") ? { items: roomTypes } : endpoint.includes("/reservations?") ? reservationPage(item) : { items: [] };

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

  it("maps guest requests and purchased add-ons into booking detail", async () => {
    const detailed = {
      ...reservation,
      primaryGuest: { ...reservation.primaryGuest, specialRequests: "Quiet room" },
      addOns: [{ addonId: "addon-1", name: "Breakfast", quantity: 2 }],
    };
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types") ? { items: [] } : { item: detailed },
    );

    await expect(bookingsService.get("booking-1")).resolves.toMatchObject({
      specialRequests: "Quiet room",
      addonIds: ["addon-1"],
      addonNames: ["Breakfast"],
      addonQuantities: { "addon-1": 2 },
    });
  });

  it("defaults additive booking evidence while an older API instance rolls out", async () => {
    const { addOns: _addOns, ...legacyReservation } = reservation;
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types")
        ? { items: [] }
        : { items: [legacyReservation], pagination: { total: 1, limit: 50, offset: 0 } },
    );

    await expect(bookingsService.list()).resolves.toMatchObject({
      bookings: [{ addonIds: [], addonNames: [], addonQuantities: {} }],
    });
  });

  it("maps the exact Stripe fee, commission, and net payout", async () => {
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types")
        ? { items: [] }
        : {
            items: [
              {
                ...reservation,
                payment: {
                  method: "card",
                  expectedMethod: "manual_card",
                  status: "paid",
                  breakdown: {
                    grossAmount: { amountDecimal: "100.00", currency: "EUR" },
                    stripeFee: { amountDecimal: "3.20", currency: "EUR" },
                    vayadaCommission: { amountDecimal: "5.00", currency: "EUR" },
                    netPayout: { amountDecimal: "91.80", currency: "EUR" },
                  },
                },
              },
            ],
            pagination: { total: 1, limit: 50, offset: 0 },
          },
    );

    await expect(bookingsService.list()).resolves.toMatchObject({
      bookings: [
        {
          paymentBreakdown: {
            grossAmount: 100,
            stripeFee: 3.2,
            vayadaCommission: 5,
            netPayout: 91.8,
            currency: "EUR",
          },
        },
      ],
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

  it("hydrates manual payment state and uses the target acceptance and mark-paid commands", async () => {
    const manualReservation = {
      ...reservation,
      source: "manual" as const,
      status: "pending_payment",
      payment: { method: "bank_transfer", status: "unpaid" },
      hostResponseDeadlineAt: "2026-07-24T10:00:00.000Z",
    };
    mocks.post.mockResolvedValue({});
    mocks.get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/room-types")) return { items: [] };
      if (endpoint.endsWith("/reservations/booking-1")) return { item: manualReservation };
      return {
        items: [manualReservation],
        pagination: { total: 1, limit: 50, offset: 0 },
      };
    });

    await expect(bookingsService.acceptBooking("booking-1")).resolves.toMatchObject({
      channel: "manual",
      paymentMethod: "bank_transfer",
      paymentStatus: "unpaid",
      status: "pending",
      hostResponseDeadline: "2026-07-24T10:00:00.000Z",
    });
    await expect(bookingsService.markPaid("booking-1")).resolves.toMatchObject({
      paymentMethod: "bank_transfer",
    });

    expect(mocks.post.mock.calls[0]?.[0]).toBe(
      "/api/pms/properties/property-1/reservations/booking-1/accept",
    );
    expect(mocks.post.mock.calls[1]?.[0]).toBe(
      "/api/pms/properties/property-1/reservations/booking-1/mark-paid",
    );
    expect(mocks.post.mock.calls[0]?.[1]).toEqual({
      commandId: "pms.booking.accept:booking-1:v1",
      idempotencyKey: "pms.booking.accept:booking-1:v1",
    });
    expect(mocks.post.mock.calls[1]?.[1]).toEqual({
      commandId: "pms.booking.mark-paid:booking-1:v1",
      idempotencyKey: "pms.booking.mark-paid:booking-1:v1",
    });
  });

  it("targets one assignment and forwards the selected move rate policy", async () => {
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types") ? { items: roomTypes } : { item: heterogeneousReservation },
    );
    mocks.patch.mockResolvedValue({});

    await bookingsService.moveRoom("booking-1", "room-9", { assignmentId: "a-2" }, "target_base");
    await bookingsService.unassignRoom("booking-1", { assignmentId: "a-2" });

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/reservations/booking-1/assignments",
      expect.objectContaining({
        action: "move",
        roomId: "room-9",
        assignmentId: "a-2",
        ratePolicy: "target_base",
      }),
      expect.any(Object),
    );
    expect(mocks.patch).toHaveBeenLastCalledWith(
      "/api/pms/properties/property-1/reservations/booking-1/assignments",
      expect.objectContaining({ action: "unassign", assignmentId: "a-2" }),
      expect.any(Object),
    );
  });

  it("uses exact one-based positions when repeated room IDs lack assignment IDs", async () => {
    const reservationWithoutAssignmentIds = {
      ...heterogeneousReservation,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        assignmentId: null,
        roomId: "room-1",
      })),
    };
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types")
        ? { items: roomTypes }
        : { item: reservationWithoutAssignmentIds },
    );
    mocks.patch.mockResolvedValue({});

    await bookingsService.moveRoom("booking-1", "room-9", { position: 1 });
    await bookingsService.unassignRoom("booking-1", { position: 1 });

    expect(mocks.patch.mock.calls[0]?.[1]).toMatchObject({
      action: "move",
      roomId: "room-9",
      position: 2,
    });
    expect(mocks.patch.mock.calls[1]?.[1]).toMatchObject({
      action: "unassign",
      roomId: null,
      position: 2,
    });
  });

  it("omits the assignment selector when the booking has no assignments", async () => {
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/room-types") ? { items: roomTypes } : { item: reservation },
    );
    mocks.patch.mockResolvedValue({});

    await bookingsService.moveRoom("booking-1", "room-9");

    expect(mocks.patch.mock.calls[0]?.[1]).not.toHaveProperty("assignmentId");
    expect(mocks.patch.mock.calls[0]?.[1]).not.toHaveProperty("position");
  });

  it("uses the authoritative Booking correction response without a fallible reload", async () => {
    mocks.patch.mockResolvedValue({
      primaryGuest: {
        guestId: "guest-1",
        guestBookingId: "booking-1",
        role: "booker",
        displayName: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: null,
        countryCode: "NL",
        countryCodeRaw: null,
        countryCodeReviewRequired: false,
        arrivalTime: null,
        specialRequests: null,
      },
    });

    await expect(
      bookingsService.correctPrimaryGuestNationality("booking-1", "NL"),
    ).resolves.toEqual({
      guestCountry: "NL",
      guestCountryRaw: null,
      guestCountryReviewRequired: false,
    });
    expect(mocks.get).not.toHaveBeenCalled();

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/reservations/booking-1/primary-guest/nationality",
      {
        commandId: expect.any(String),
        idempotencyKey: expect.any(String),
        countryCode: "NL",
      },
      expect.any(Object),
    );
  });

  it("maps exact and partial stay evidence without copying booking-wide values", async () => {
    // prettier-ignore
    mocks.get.mockImplementation(async (endpoint: string) => endpoint.endsWith("/room-types") ? { items: roomTypes } : reservationPage(heterogeneousReservation));
    const complete = (await bookingsService.list()).bookings[0]!;
    expect(complete.expectedPaymentMethod).toBe("cash");
    // prettier-ignore
    expect(complete.stays).toMatchObject([{ position: 0, roomName: "Suite", ratePlanName: "Plan 1", checkIn: "2026-09-10", adults: 1, nightly: [{ appliedAmount: 100 }] }, { position: 1, roomName: "Studio", ratePlanName: "Plan 2", checkIn: "2026-09-12", adults: 2, nightly: [{ appliedAmount: 180 }] }]);
    // prettier-ignore
    const partialReservation = { ...heterogeneousReservation, assignments: [assignments[0], { ...assignments[1], stay: undefined, nightly: [] }] };
    // prettier-ignore
    mocks.get.mockImplementation(async (endpoint: string) => endpoint.endsWith("/room-types") ? { items: roomTypes } : reservationPage(partialReservation));
    // prettier-ignore
    expect((await bookingsService.list()).bookings[0]!.stays[1]).toMatchObject({ checkIn: null, checkOut: null, adults: null, children: null, nightly: [] });
  });
  it("surfaces target read errors", async () => {
    mocks.get.mockRejectedValue(new Error("read model unavailable"));
    await expect(bookingsService.get("booking-1")).rejects.toThrow("read model unavailable");
  });
});
describe("PMS target calendar projection", () => {
  it("keeps one reservation identity while placing each exact stay independently", async () => {
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.get.mockImplementation(calendarResponse(heterogeneousReservation));
    const result = await calendarService.getCalendarData("2026-09-10", "2026-09-16");
    // prettier-ignore
    expect(result.bookings).toMatchObject([{ id: "booking-1", bookingReference: "VAY-1", roomPosition: 0, checkIn: "2026-09-10", checkOut: "2026-09-12" }, { id: "booking-1", bookingReference: "VAY-1", roomPosition: 1, checkIn: "2026-09-12", checkOut: "2026-09-15" }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    // prettier-ignore
    const mobile = create(createElement(MobileCalendar, { currentMonth: new Date(), bookings: result.bookings.map((booking) => ({ ...booking, checkIn: "2026-09-10", checkOut: "2026-09-12" })), blocks: [], roomTypes: [], onMonthChange: vi.fn(), onSelectBooking: vi.fn(), onNewBooking: vi.fn(), onBlockRoom: vi.fn(), onSelectBlock: vi.fn() }));
    try {
      expect(JSON.stringify(mobile.toJSON())).toContain("Room 1 of 2");
      expect(JSON.stringify(mobile.toJSON())).toContain("Room 2 of 2");
      expect([0, 1].map(calendarLaneTop)).toEqual([6, 42]);
    } finally {
      mobile.unmount();
      vi.useRealTimers();
    }
  });
  it("labels every expected method without using settlement state", () => {
    // prettier-ignore
    expect((["unknown", "pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const).map(expectedPaymentMethodLabel)).toEqual(["Not specified", "Pay at Property", "Bank Transfer", "Manual Card", "Cash", "Other"]);
    // prettier-ignore
    expect([`${expectedPaymentMethodLabel("bank_transfer")}: ${bookingSettlementLabel({ balanceAmount: 100, currency: "EUR", depositRequired: false, paymentStatus: "unpaid", totalAmount: 100 })}`, `${expectedPaymentMethodLabel("manual_card")}: ${bookingSettlementLabel({ balanceAmount: 0, currency: "EUR", depositRequired: false, paymentStatus: "paid", totalAmount: 100 })}`]).toEqual(["Bank Transfer: €100 outstanding", "Manual Card: Payment recorded"]);
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
