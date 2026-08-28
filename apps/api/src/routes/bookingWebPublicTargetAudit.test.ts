import { describe, expect, it } from "vitest";

import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { createTargetBookingWebCheckoutAdapter } from "./bookingWebPublic.js";

const propertyA = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
const propertyB = "b9fccec2-eb4c-4c35-bfd3-02a748c2e118";

describe("target Booking public audit regressions", () => {
  it("uses property-bound strong quote references and resolves non-refundable aliases", async () => {
    const first = quoteHarness({ propertyId: propertyA });
    const second = quoteHarness({ propertyId: propertyB });
    const request = {
      roomTypeId: "room-deluxe",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      numberOfRooms: 1,
      paymentMethod: "pay_at_property",
      rateType: "nonrefundable",
    };
    const context = quoteContext();

    await expect(first.adapter.quoteBooking("hotel-a", request, context)).resolves.toMatchObject({
      rateType: "nonrefundable",
    });
    await expect(second.adapter.quoteBooking("hotel-b", request, context)).resolves.toMatchObject({
      rateType: "nonrefundable",
    });

    expect(first.publicQuoteReference).toMatch(/^Q-[A-F0-9]{32}$/);
    expect(second.publicQuoteReference).toMatch(/^Q-[A-F0-9]{32}$/);
    expect(first.publicQuoteReference).not.toBe(second.publicQuoteReference);
    expect(first.offerRead?.values?.[8]).toBe("non_refundable");
    expect(first.offerRead?.text).toContain("lower(offer.public_offer_key) LIKE '%:nrf'");
    expect(first.offerRead?.text).toContain("offer.rate_summary ->> 'rateType'");
    expect(first.quoteWrite?.text).toContain("ON CONFLICT (public_quote_reference) DO NOTHING");
    expect(first.quoteWrite?.text).not.toContain("DO UPDATE");
    expect(JSON.parse(String(first.quoteWrite?.values?.[9]))).toMatchObject({
      rateType: "non_refundable",
      publicOfferKey: "room-deluxe:nrf",
    });
  });

  it("fails closed when a quote public reference already exists", async () => {
    const target = quoteHarness({ propertyId: propertyA, referenceCollision: true });

    await expect(
      target.adapter.quoteBooking(
        "hotel-a",
        {
          roomTypeId: "room-deluxe",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          numberOfRooms: 1,
          rateType: "nrf",
        },
        quoteContext(),
      ),
    ).rejects.toThrow("Checkout quote is no longer available");

    expect(target.calls.map((call) => call.text)).toContain("ROLLBACK");
    expect(target.quoteWrite?.text).toContain("ON CONFLICT (public_quote_reference) DO NOTHING");
  });

  it("trusts Booking publication eligibility when catalog description is the only omission", async () => {
    const target = quoteHarness({ propertyId: propertyA });

    await expect(
      target.adapter.quoteBooking(
        "hotel-a",
        {
          roomTypeId: "room-deluxe",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          children: 0,
          numberOfRooms: 1,
          paymentMethod: "pay_at_property",
          rateType: "flexible",
        },
        quoteContext(),
      ),
    ).resolves.toBeDefined();

    const propertyLookup = target.calls.find((call) =>
      call.text.includes("FROM hotel_catalog.property_slugs"),
    );
    expect(propertyLookup?.text).toContain("profile.profile_status = 'public'");
    expect(propertyLookup?.text).not.toContain("p.profile_status = 'complete'");
  });

  it("bounds transactional retries when short booking references collide", async () => {
    const first = bookingCollisionHarness(propertyA);
    const second = bookingCollisionHarness(propertyB);
    const retry = bookingCollisionHarness(propertyA);
    const request = bookingRequest();
    const context = bookingContext();

    await expect(first.adapter.createBooking("hotel-a", request, context)).rejects.toThrow(
      "Unable to allocate a booking reference",
    );
    await expect(second.adapter.createBooking("hotel-b", request, context)).rejects.toThrow(
      "Unable to allocate a booking reference",
    );
    await expect(retry.adapter.createBooking("hotel-a", request, context)).rejects.toThrow(
      "Unable to allocate a booking reference",
    );

    expect(first.publicBookingReference).toMatch(/^VAY-[A-F0-9]{6}$/);
    expect(second.publicBookingReference).toMatch(/^VAY-[A-F0-9]{6}$/);
    expect(first.publicBookingReference).not.toBe(second.publicBookingReference);
    expect(retry.publicBookingReference).toBe(first.publicBookingReference);
    expect(
      first.calls.filter((call) => call.text.includes("WHERE public_reference = $1")),
    ).toHaveLength(8);
    expect(first.calls.map((call) => call.text)).toContain(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(first.calls.map((call) => call.text)).toContain("ROLLBACK");
    expect(second.calls.map((call) => call.text)).toContain("ROLLBACK");
  });

  it("rejects a check-in before the property's local date", async () => {
    const target = quoteHarness({
      propertyId: propertyA,
      timezone: "Pacific/Kiritimati",
    });

    await expect(
      target.adapter.quoteBooking(
        "hotel-a",
        {
          roomTypeId: "room-deluxe",
          checkIn: "2026-07-20",
          checkOut: "2026-07-21",
          adults: 2,
          numberOfRooms: 1,
          rateType: "flexible",
        },
        {
          ...quoteContext(),
          occurredAt: new Date("2026-07-20T10:30:00.000Z"),
        },
      ),
    ).rejects.toThrow("checkIn cannot be in the past");

    expect(target.calls.some((call) => call.text.includes("public_room_offer_snapshots"))).toBe(
      false,
    );
    expect(target.calls.some((call) => call.text.includes("booking.quote_sessions"))).toBe(false);
    expect(target.calls.map((call) => call.text)).toContain("ROLLBACK");
  });

  it("applies a property-currency promo to the authoritative checkout quote", async () => {
    const target = quoteHarness({ propertyId: propertyA, promo: {} });

    await expect(
      target.adapter.quoteBooking(
        "hotel-a",
        {
          roomTypeId: "room-deluxe",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          numberOfRooms: 1,
          paymentMethod: "pay_at_property",
          rateType: "nonrefundable",
          promoCode: "summer20",
        },
        quoteContext(),
      ),
    ).resolves.toMatchObject({
      promoCode: "SUMMER20",
      promoDiscount: 54,
      totalAmount: 216,
      currency: "EUR",
    });

    expect(target.promoApplicationWrite?.values).toEqual([
      propertyA,
      "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
      "59b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
      "SUMMER20",
      "54.00",
      "EUR",
      expect.any(String),
    ]);
  });

  it.each([
    [{ validUntil: "2026-07-19" }, { code: "SUMMER20" }, "This promo code has expired."],
    [
      { stayDateFrom: "2026-09-13" },
      { code: "SUMMER20", checkIn: "2026-09-12" },
      "This promo code is not valid for your selected dates.",
    ],
    [
      { applicableRoomIds: ["room-suite"] },
      { code: "SUMMER20", roomTypeId: "room-deluxe" },
      "This promo code is not available for the selected room.",
    ],
    [
      { minBookingValue: "500.00" },
      { code: "SUMMER20", bookingTotal: 270 },
      "Your booking must be at least EUR 500 to use this code.",
    ],
    [
      { currentUses: 10, maxUses: 10 },
      { code: "SUMMER20" },
      "This promo code has reached its maximum number of uses.",
    ],
  ])("returns the specific promo rule failure message", async (promo, request, message) => {
    const target = quoteHarness({ propertyId: propertyA, promo });

    await expect(target.adapter.validatePromo("hotel-a", request)).resolves.toMatchObject({
      valid: false,
      code: "SUMMER20",
      message,
    });
  });
});

function quoteHarness(options: {
  propertyId: string;
  timezone?: string;
  referenceCollision?: boolean;
  promo?: Partial<{
    validUntil: string | null;
    stayDateFrom: string | null;
    applicableRoomIds: string[] | null;
    minBookingValue: string | null;
    currentUses: number;
    maxUses: number;
  }>;
}) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let publicQuoteReference: string | undefined;
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (text.includes("FROM hotel_catalog.property_slugs")) {
        return {
          rows: [
            {
              propertyId: options.propertyId,
              displayName: "Hotel Audit",
              defaultLocale: "en",
              timezone: options.timezone ?? "Europe/Berlin",
            },
          ],
        };
      }
      if (text.includes("FROM hotel_catalog.properties p")) {
        return {
          rows: [
            {
              propertyId: options.propertyId,
              defaultCurrency: "EUR",
              acceptedMethods: ["pay_at_property"],
              depositPolicy: {},
            },
          ],
        };
      }
      if (text.includes("FROM distribution.public_room_offer_snapshots")) {
        return {
          rows: [
            {
              publicOfferKey: "room-deluxe:nrf",
              roomTypeId: "room-deluxe",
              ratePlanId: "rate-plan-nrf",
              roomSummary: { name: "Deluxe Room" },
              rateSummary: { name: "Non-refundable", code: "NRF", rateType: "non_refundable" },
              occupancy: { maxAdults: 2, maxChildren: 0 },
              publicPolicy: {},
              paymentOptions: ["pay_at_property"],
              availableRooms: 2,
              nightlyRoomAmounts: [12, 13, 14].map((day) => ({
                stayDate: `2026-09-${day}`,
                grossRoomAmount: 90,
              })),
              roomTotal: "270.00",
              taxesAndFees: "0.00",
              discounts: "0.00",
              currency: "EUR",
              generatedAt: "2026-07-20T08:00:00.000Z",
              sourceFreshness: { pms: { status: "fresh" } },
              profileCapabilities: { payAtProperty: true },
            },
          ],
        };
      }
      if (text.includes("FROM booking.promo_definitions promo")) {
        return {
          rows:
            options.promo === undefined
              ? []
              : [
                  {
                    promoDefinitionId: "59b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
                    code: "SUMMER20",
                    discountType: "percentage",
                    discountValue: "20.00",
                    propertyCurrency: "EUR",
                    minBookingValue: null,
                    applicableRoomIds: null,
                    validFrom: null,
                    validUntil: null,
                    stayDateFrom: null,
                    stayDateUntil: null,
                    isActive: true,
                    maxUses: 10,
                    currentUses: 0,
                    ...options.promo,
                  },
                ],
        };
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return { rows: [{ id: "799e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
      }
      if (text.includes("INSERT INTO booking.quote_sessions")) {
        publicQuoteReference = String(values?.[2]);
        return options.referenceCollision
          ? { rows: [] }
          : {
              rows: [
                {
                  quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
                  publicQuoteReference,
                },
              ],
            };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const adapter = createTargetBookingWebCheckoutAdapter({
    connectionString: "postgresql://unused",
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
    pool: pool as never,
  });
  return {
    adapter,
    calls,
    get publicQuoteReference() {
      return publicQuoteReference;
    },
    get offerRead() {
      return calls.find((call) => call.text.includes("public_room_offer_snapshots"));
    },
    get quoteWrite() {
      return calls.find((call) => call.text.includes("INSERT INTO booking.quote_sessions"));
    },
    get promoApplicationWrite() {
      return calls.find((call) => call.text.includes("INSERT INTO booking.promo_applications"));
    },
  };
}

function bookingCollisionHarness(propertyId: string) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let publicBookingReference: string | undefined;
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (text.includes("FROM hotel_catalog.property_slugs")) {
        return {
          rows: [
            {
              propertyId,
              displayName: "Hotel Audit",
              defaultLocale: "en",
              timezone: "Europe/Berlin",
            },
          ],
        };
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return { rows: [{ id: "899e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
      }
      if (text.includes("FROM hotel_catalog.properties p")) {
        return {
          rows: [
            {
              defaultCurrency: "EUR",
              phoneRequired: false,
              paymentsEnabled: true,
              acceptedMethods: ["pay_at_property", "cash"],
              depositPolicy: {},
              onlineCardReady: false,
            },
          ],
        };
      }
      if (text.trimStart().startsWith("SELECT") && text.includes("FROM booking.quote_sessions")) {
        return {
          rows: [
            {
              quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
              publicQuoteReference: "Q-AUDIT",
              requestedCheckIn: "2026-09-12",
              requestedCheckOut: "2026-09-15",
              adults: 2,
              children: 0,
              roomCount: 1,
              currency: "EUR",
              status: "active",
              selectedOfferSnapshot: {
                roomTypeId: "room-deluxe",
                publicOfferKey: "room-deluxe:nrf",
                paymentMethod: "pay_at_property",
                rateType: "non_refundable",
              },
              totals: { totalAmount: "270.00", balanceAmount: "270.00" },
              policySnapshot: {},
              expiresAt: "2026-09-12T12:00:00.000Z",
            },
          ],
        };
      }
      if (text.includes("UPDATE pms.inventory_days")) return { rows: [{ reserved: true }] };
      if (text.includes("SELECT * FROM booking_row")) {
        publicBookingReference = String(values?.[8]);
        return { rows: [] };
      }
      if (text.includes("WHERE public_reference = $1")) {
        publicBookingReference = String(values?.[0]);
        return { rows: [{ collided: true }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const adapter = createTargetBookingWebCheckoutAdapter({
    connectionString: "postgresql://unused",
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
    billingConfigReadPortFactory: () => ({
      getBillingConfig: async () => ({ propertyId }) as never,
    }),
    pool: pool as never,
  });
  return {
    adapter,
    calls,
    get publicBookingReference() {
      return publicBookingReference;
    },
  };
}

function quoteContext() {
  return {
    operation: "booking-quote",
    requestId: "req-quote-audit",
    correlationId: "corr-quote-audit",
    idempotencyKey: "idem-quote-audit",
    fingerprint: "a".repeat(64),
    occurredAt: new Date("2026-07-20T08:00:00.000Z"),
  };
}

function bookingContext() {
  return {
    operation: "booking-create",
    requestId: "req-booking-audit",
    correlationId: "corr-booking-audit",
    idempotencyKey: "idem-booking-audit",
    fingerprint: "b".repeat(64),
    occurredAt: new Date("2026-09-01T10:00:00.000Z"),
  };
}

function bookingRequest() {
  return {
    quoteId: "Q-AUDIT",
    roomTypeId: "room-deluxe",
    guestEmail: "guest@example.test",
    checkIn: "2026-09-12",
    checkOut: "2026-09-15",
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    paymentMethod: "pay_at_property",
    expectedTotalAmount: 270,
    balanceAmount: 270,
  };
}
