import {
  buildPublicBookabilityQuoteProjection,
  findForbiddenPublicBookabilityKeys,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityAvailabilityOfferInput,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityQuoteProjection,
} from "@vayada/domain-distribution";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import type { PublicHotelQuoteQuery, PublicHotelQuoteRepository } from "./aiHotelQuotes.js";
import {
  toPublicHotelProfileProjection,
  type BookingHotelProfileRow,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";
import type {
  BookingWebAffiliateRegistrationRequest,
  BookingWebAffiliateRepository,
  BookingWebAffiliateStripeConnectRequest,
} from "./bookingWebAffiliate.js";
import {
  createTargetBookingWebCheckoutAdapter,
  createUnavailableBookingWebCheckoutAdapter,
  recordTargetCheckoutCommand,
  resolveTargetCheckoutAmountSnapshot,
  targetCardPaymentIdempotencyKey,
  type BookingWebCalendarProjection,
  type BookingWebCalendarRepository,
  type BookingWebCalendarReadPool,
  type BookingWebCheckoutAdapter,
} from "./bookingWebPublic.js";

type LegacyHotelResponse = {
  id: string;
  name: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  description: string;
  location: string;
  country: string;
  currency: string;
  supportedCurrencies: string[];
  heroImage: string;
  images: string[];
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  timezone: string;
  defaultLanguage: string;
  supportedLanguages: string[];
  instantBook: boolean;
};

type LegacyRoomResponse = {
  id: string;
  name: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  nightlyRates: number[];
  nonRefundableNightlyRates?: number[];
  currency: string;
  remainingRooms: number;
  flexibleRateEnabled: boolean;
  cancellationPolicy: string;
  nonRefundableCancellationPolicy?: string;
  ratePaymentMethods?: Record<string, string[]>;
  rateDepositSettings?: Record<string, { enabled: boolean; percentage: number | null }>;
};

type LegacyUnavailableDatesResponse = {
  dates: string[];
  min_stay_by_arrival: Record<string, number>;
  max_stay_by_arrival: Record<string, number>;
};

type ParityMismatch = {
  caseId: string;
  field: string;
  expected: unknown;
  actual: unknown;
};

const ACCEPTED_BOOTSTRAP_PARITY_DIFFERENCES = [
  {
    legacyField: "HotelResponse.currency",
    targetField: "hotel.defaultCurrency",
    reason: "Distribution exposes the default checkout currency under the public profile.",
  },
  {
    legacyField: "HotelResponse.supportedLanguages",
    targetField: "hotel.supportedLocales",
    reason: "The target contract uses locale terminology consistently across profile and quote.",
  },
  {
    legacyField: "RoomTypeResponse[]",
    targetField: "quote.offers[]",
    reason:
      "Offers are checkout-ready room/rate choices; room marketing fields stay outside the offers route.",
  },
  {
    legacyField: "UnavailableDatesResponse.dates",
    targetField: "calendar.unavailableDates",
    reason: "Calendar fields are camel-cased and grouped under the target calendar projection.",
  },
  {
    legacyField: "HotelResponse.contact/socialLinks",
    targetField: "omitted",
    reason:
      "These fields are not required by the read-only bootstrap adapters and remain outside this public-safe parity slice.",
  },
] as const;

it("namespaces Stripe idempotency by property without exposing the public key", () => {
  const publicKey = "guest-controlled-retry-key";
  const first = targetCardPaymentIdempotencyKey("a9fccec2-eb4c-4c35-bfd3-02a748c2e117", publicKey);
  const second = targetCardPaymentIdempotencyKey("b9fccec2-eb4c-4c35-bfd3-02a748c2e952", publicKey);

  expect(first).not.toBe(second);
  expect(first).not.toContain(publicKey);
  expect(second).not.toContain(publicKey);
});

const legacyHotel: LegacyHotelResponse = {
  id: "booking_hotel_alpenrose",
  name: "Hotel Alpenrose",
  slug: "hotel-alpenrose",
  canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
  bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
  customDomainUrl: null,
  description: "Independent alpine hotel near the old town.",
  location: "Innsbruck",
  country: "AT",
  currency: "CHF",
  supportedCurrencies: ["CHF", "EUR"],
  heroImage: "https://cdn.vayada.example/hotels/alpenrose/front.jpg",
  images: ["https://cdn.vayada.example/hotels/alpenrose/room.jpg"],
  amenities: ["wifi", "breakfast", "parking"],
  checkInTime: "15:00",
  checkOutTime: "11:00",
  timezone: "Europe/Vienna",
  defaultLanguage: "de",
  supportedLanguages: ["de", "en"],
  instantBook: true,
};

const legacyCustomDomainHotel: LegacyHotelResponse = {
  ...legacyHotel,
  canonicalUrl: "https://book.alpenrose.example/de",
  bookingBaseUrl: "https://book.alpenrose.example",
  customDomainUrl: "https://book.alpenrose.example",
};

const legacyRenamedHotel: LegacyHotelResponse = {
  ...legacyHotel,
  name: "Alpenrose Resort",
  slug: "alpenrose-resort",
  canonicalUrl: "https://alpenrose-resort.booking.localhost/de",
  bookingBaseUrl: "https://alpenrose-resort.booking.localhost",
};

const legacyRooms: LegacyRoomResponse[] = [
  {
    id: "room_deluxe",
    name: "Deluxe Double Room",
    maxOccupancy: 3,
    maxAdults: 2,
    maxChildren: 1,
    nightlyRates: [210, 220, 230],
    nonRefundableNightlyRates: [189, 198, 207],
    currency: "CHF",
    remainingRooms: 2,
    flexibleRateEnabled: true,
    cancellationPolicy: "Free cancellation until 7 days before arrival.",
    nonRefundableCancellationPolicy: "Non-refundable from booking",
    ratePaymentMethods: {
      flexible: ["card", "pay_at_property"],
      nonrefundable: ["card", "bank_transfer"],
    },
    rateDepositSettings: {
      flexible: { enabled: false, percentage: null },
      nonrefundable: { enabled: true, percentage: 50 },
    },
  },
];

const legacyUnavailableDates: LegacyUnavailableDatesResponse = {
  dates: ["2026-09-14"],
  min_stay_by_arrival: { "2026-09-12": 2 },
  max_stay_by_arrival: { "2026-09-15": 7 },
};

describe("Booking Web public bootstrap parity", () => {
  it("records affiliate click attribution through the configured sink", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
      bookingWebAttributionSink: {
        async recordAffiliateClick(event) {
          events.push(event);
        },
        async recordTelemetryEvent() {},
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/attribution/clicks",
      payload: {
        referralCode: "REF-123",
        sessionId: "sid_123",
        landingUrl: "https://hotel-alpenrose.booking.localhost/?ref=REF-123",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(events).toMatchObject([
      {
        slug: "hotel-alpenrose",
        referralCode: "REF-123",
        sessionId: "sid_123",
        landingUrl: "https://hotel-alpenrose.booking.localhost/?ref=REF-123",
      },
    ]);
    await app.close();
  });

  it("records booking-web telemetry through the configured sink without legacy forwarding", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
      bookingWebAttributionSink: {
        async recordAffiliateClick() {},
        async recordTelemetryEvent(event) {
          events.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/events",
      payload: {
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        eventId: "event_page_visit_001",
        sessionId: "sid_123",
        metadata: { locale: "de" },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(events).toMatchObject([
      {
        propertyId: "booking_hotel_alpenrose",
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        eventId: "event_page_visit_001",
        sessionId: "sid_123",
        metadata: { locale: "de" },
      },
    ]);
    await app.close();
  });

  it("rejects telemetry that cannot be resolved to a canonical property", async () => {
    const events: unknown[] = [];
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebAttributionSink: {
        async recordAffiliateClick() {},
        async recordTelemetryEvent(event) {
          events.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/events",
      payload: { hotelSlug: "unknown-hotel", eventType: "page_visit" },
    });

    expect(response.statusCode).toBe(404);
    expect(events).toEqual([]);
    await app.close();
  });

  it("fails closed for public affiliate registration without a target repository", async () => {
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates",
      payload: { email: "guest@example.com", fullName: "Guest Example" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      message: "Booking Web affiliate adapter is not configured.",
    });
    await app.close();
  });

  it("preserves hotel page bootstrap fields across the target adapter", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(
      compareHotelBootstrapParity("hotel-page-localized-currency", legacyHotel, target),
    ).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("preserves host and custom-domain canonical behavior", async () => {
    const app = buildParityApp({
      hotel: legacyCustomDomainHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareHostParity("custom-domain-canonical", legacyCustomDomainHotel, target)).toEqual(
      [],
    );
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("preserves old-host canonical redirects when the projection is already canonical", async () => {
    const app = buildParityApp({
      hotel: legacyRenamedHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      slugAliases: {
        "hotel-alpenrose": legacyRenamedHotel,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.booking.localhost",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareCanonicalRedirectParity("renamed-property-canonical", target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("passes target-mode host parity for known subdomain, renamed, and custom-domain hotels", async () => {
    const knownHostApp = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      domainResolutionSource: "target",
    });
    const knownHostResponse = await knownHostApp.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.booking.localhost",
    });
    expect(knownHostResponse.statusCode).toBe(200);
    expect(
      compareHostParity("target-known-subdomain", legacyHotel, knownHostResponse.json()),
    ).toEqual([]);
    await knownHostApp.close();

    const renamedApp = buildParityApp({
      hotel: legacyRenamedHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      slugAliases: {
        "hotel-alpenrose": legacyRenamedHotel,
      },
      domainResolutionSource: "target",
    });
    const renamedResponse = await renamedApp.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.booking.localhost",
    });
    expect(renamedResponse.statusCode).toBe(200);
    expect(
      compareCanonicalRedirectParity("target-renamed-property", renamedResponse.json()),
    ).toEqual([]);
    await renamedApp.close();

    const customDomainApp = buildParityApp({
      hotel: legacyCustomDomainHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
      domainResolutionSource: "target",
    });
    const customDomainResponse = await customDomainApp.inject({
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });
    expect(customDomainResponse.statusCode).toBe(200);
    expect(
      compareHostParity(
        "target-custom-domain",
        legacyCustomDomainHotel,
        customDomainResponse.json(),
      ),
    ).toEqual([]);
    await customDomainApp.close();
  });

  it("maps legacy rooms to target offers for localized currency searches", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=CHF&locale=de",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareOffersParity("rooms-offers-localized-currency", legacyRooms, target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("maps sold-out or empty legacy room responses to unavailable target offers", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: [],
      unavailableDates: { dates: [], min_stay_by_arrival: {}, max_stay_by_arrival: {} },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-10-01&check_out=2026-10-02&adults=2&children=0&rooms=1&currency=CHF&locale=de",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(compareSoldOutParity("sold-out-empty-rooms", target)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("maps legacy unavailable dates to target calendar summaries", async () => {
    const app = buildParityApp({
      hotel: legacyHotel,
      rooms: legacyRooms,
      unavailableDates: legacyUnavailableDates,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-20",
    });
    const target = response.json();

    expect(response.statusCode).toBe(200);
    expect(
      compareCalendarParity("calendar-unavailable-dates", legacyUnavailableDates, target),
    ).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(target)).toEqual([]);
    await app.close();
  });

  it("fails closed for checkout lifecycle routes without a target checkout adapter", async () => {
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
    });

    const checkoutConfig = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/checkout-config",
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
      payload: {
        roomTypeId: "room_deluxe",
        guestEmail: "guest@example.com",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        paymentMethod: "pay_at_property",
      },
    });
    const quote = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/quote",
      payload: {
        roomTypeId: "room_deluxe",
        guestEmail: "guest@example.com",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        paymentMethod: "pay_at_property",
      },
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/draft_1/confirm-authorization",
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/status?reference=ALP-1001&email=guest%40example.com",
    });
    const lookup = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
      payload: { bookingReference: "ALP-1001", guestEmail: "guest@example.com" },
    });
    const paymentInstructions = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/ALP-1001/payment-instructions",
    });
    const promo = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/promo/validate",
      payload: { code: "SUMMER10" },
    });

    expect([
      checkoutConfig.statusCode,
      create.statusCode,
      quote.statusCode,
      confirm.statusCode,
      status.statusCode,
      lookup.statusCode,
      promo.statusCode,
    ]).toEqual([404, 404, 404, 400, 404, 404, 404]);
    expect(paymentInstructions.statusCode).toBe(404);
    expect(create.json()).toMatchObject({
      message: "Booking Web checkout command adapter is not configured.",
    });
    expect(promo.json()).toMatchObject({
      message: "Booking Web promo validation adapter is not configured.",
    });
    await app.close();
  });

  it("does not proxy checkout commands to legacy PMS unless explicitly enabled", async () => {
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
      payload: { guestEmail: "guest@example.com" },
    });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/draft_1/confirm-authorization",
    });
    const withdraw = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_pending/withdraw",
      payload: { guestEmail: "guest@example.com" },
    });
    const cancelPreview = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_1/cancel-preview",
      payload: { guestEmail: "guest@example.com" },
    });
    const changePreview = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/booking_1/change-request/preview",
      payload: changeRequestPayload(),
    });

    expect(create.statusCode).toBe(404);
    expect(confirm.statusCode).toBe(400);
    expect(withdraw.statusCode).toBe(404);
    expect(cancelPreview.statusCode).toBe(404);
    expect(changePreview.statusCode).toBe(404);
    await app.close();
  });

  it("serves target-owned affiliate routes without PMS public API config", async () => {
    const affiliateRepository = new InMemoryAffiliateRepository();
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebAffiliateRepository: affiliateRepository,
    });

    const before = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates/check-email?email=creator%40example.com",
    });
    const firstRegister = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates",
      payload: {
        fullName: "Creator Example",
        email: "Creator@Example.com",
        socialMedia: "@creator",
        userType: "creator",
        paymentMethod: "stripe",
      },
    });
    const secondRegister = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates",
      payload: {
        fullName: "Creator Example",
        email: "creator@example.com",
        socialMedia: "@creator",
        userType: "creator",
        paymentMethod: "stripe",
      },
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates/check-email?email=creator%40example.com",
    });

    const affiliate = firstRegister.json() as { id: string; referralCode: string };
    const firstConnect = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/hotel-alpenrose/affiliates/${affiliate.id}/stripe/connect`,
      payload: { email: "creator@example.com" },
    });
    const wrongEmailConnect = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/hotel-alpenrose/affiliates/${affiliate.id}/stripe/connect`,
      payload: { email: "other@example.com" },
    });
    const wrongSlugConnect = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/legacy-alpenrose/affiliates/${affiliate.id}/stripe/connect`,
      payload: { email: "creator@example.com" },
    });
    const secondConnect = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/hotel-alpenrose/affiliates/${affiliate.id}/stripe/connect`,
      payload: { email: "creator@example.com" },
    });

    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ exists: false });
    expect([firstRegister.statusCode, secondRegister.statusCode, after.statusCode]).toEqual([
      200, 200, 200,
    ]);
    expect(secondRegister.json()).toEqual(firstRegister.json());
    expect(after.json()).toEqual({ exists: true });
    expect(affiliate).toEqual({
      id: expect.stringMatching(/^aff_/),
      referralCode: expect.stringMatching(/^VA[A-F0-9]{8}$/),
    });
    expect(wrongEmailConnect.statusCode).toBe(404);
    expect(wrongSlugConnect.statusCode).toBe(404);
    expect(firstConnect.statusCode).toBe(503);
    expect(secondConnect.statusCode).toBe(503);
    expect(firstConnect.json()).toEqual(secondConnect.json());
    expect(firstConnect.json()).toEqual({
      error: "Service Unavailable",
      message: "Stripe Connect onboarding is not configured.",
      statusCode: 503,
    });
    expect(affiliateRepository.identityCount).toBe(1);
    expect(affiliateRepository.stripeAccountCount).toBe(0);
    await app.close();
  });

  it("mounts target-owned affiliate routes with an explicit target hotel resolver", async () => {
    const app = buildApp({
      logger: false,
      bookingWebAffiliateRepository: new InMemoryAffiliateRepository(),
      bookingWebAffiliateHotelResolver: createProfileRepository(legacyHotel, {}),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates/check-email?email=creator%40example.com",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ exists: false });
    await app.close();
  });

  it("fails closed for target-owned affiliate routes without a hotel resolver", async () => {
    const app = buildApp({
      logger: false,
      bookingWebAffiliateRepository: new InMemoryAffiliateRepository(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/affiliates",
      payload: {
        fullName: "Creator Example",
        email: "creator@example.com",
      },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("passes command context through target checkout adapter paths without legacy URLs", async () => {
    const operations: Array<{
      operation: string | undefined;
      requestId: string | undefined;
      correlationId: string | undefined;
      idempotencyKey: string | undefined;
      fingerprint: string | undefined;
      occurredAt: string | undefined;
    }> = [];
    let closed = 0;
    const lookupAdmissionHashes: string[] = [];
    const record = (context: Parameters<BookingWebCheckoutAdapter["getCheckoutConfig"]>[1]) => {
      operations.push({
        operation: context?.operation,
        requestId: context?.requestId,
        correlationId: context?.correlationId,
        idempotencyKey: context?.idempotencyKey,
        fingerprint: context?.fingerprint,
        occurredAt: context?.occurredAt.toISOString(),
      });
    };
    const checkoutAdapter: BookingWebCheckoutAdapter = {
      async consumeLookupAttempt(clientAddressHash) {
        lookupAdmissionHashes.push(clientAddressHash);
      },
      async getCheckoutConfig(_slug, context) {
        record(context);
        return { payAtPropertyEnabled: true, bankTransfer: true, paypalEnabled: false };
      },
      async quoteBooking(_slug, _request, context) {
        record(context);
        return {
          roomTypeId: "room_deluxe",
          paymentMethod: "pay_at_property",
          totalAmount: 562.5,
          currency: "EUR",
        };
      },
      async createBooking(_slug, _request, context) {
        record(context);
        return {
          bookingReference: "VAY-TARGET-1",
          booking: { bookingReference: "VAY-TARGET-1", status: "confirmed" },
          paymentInstructions: { bankTransfer: { enabled: true, details: null } },
        };
      },
      async confirmAuthorization(_slug, _handle, context) {
        record(context);
        return { bookingReference: "VAY-TARGET-1", status: "confirmed" };
      },
      async getStatus(_slug, _query, context) {
        record(context);
        return { status: "confirmed", paymentStatus: "paid" };
      },
      async lookup(_slug, _request, context) {
        record(context);
        return { bookingReference: "VAY-TARGET-1" };
      },
      async withdraw(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "withdrawn" };
      },
      async cancelPreview(_slug, _bookingId, _request, context) {
        record(context);
        return { refundAmount: 100, refundPercentage: 100, currency: "CHF" };
      },
      async cancel(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "cancelled" };
      },
      async previewChangeRequest(_slug, _bookingId, _request, context) {
        record(context);
        return { oldTotal: 100, newTotal: 100, priceDifference: 0, available: true };
      },
      async submitChangeRequest(_slug, _bookingId, _request, context) {
        record(context);
        return { status: "pending", priceDifference: 0 };
      },
      async getChangeRequest(_slug, _bookingId, _query, context) {
        record(context);
        return { status: "pending" };
      },
      async getPaymentInstructions(_slug, _handle, context) {
        record(context);
        return {
          bankTransfer: { enabled: true, details: null },
          paypal: { enabled: false, email: null, paymentWindowHours: null },
        };
      },
      async validatePromo(_slug, _request, context) {
        record(context);
        return { valid: false, code: "SUMMER10" };
      },
      async close() {
        closed += 1;
      },
    };
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: checkoutAdapter,
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
    });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/booking-web/hotels/hotel-alpenrose/checkout-config" }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings",
        headers: { "Idempotency-Key": "guest-create-1", "X-Correlation-Id": "corr-create-1" },
        payload: { guestEmail: "guest@example.com", checkIn: "2026-09-12", checkOut: "2026-09-15" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/quote",
        payload: { guestEmail: "guest@example.com", checkIn: "2026-09-12", checkOut: "2026-09-15" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/b9fccec2-eb4c-4c35-bfd3-02a748c2e951/confirm-authorization",
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/status?reference=VAY-TARGET-1&email=guest%40example.com",
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
        payload: { bookingReference: "VAY-TARGET-1", guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/withdraw",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/withdraw",
        payload: { guest_email: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/cancel-preview",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/cancel",
        payload: { guestEmail: "guest@example.com" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request/preview",
        payload: changeRequestPayload(),
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request/preview",
        payload: {
          ...changeRequestPayload(),
          guestEmail: undefined,
          guest_email: "guest@example.com",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request",
        payload: changeRequestPayload(),
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/change-request?email=guest%40example.com",
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/payment-instructions",
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/promo/validate",
        payload: { code: "SUMMER10" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual(Array(16).fill(200));
    expect(operations.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining([
        "checkout-config",
        "booking-quote",
        "booking-create",
        "booking-confirm-authorization",
        "booking-status",
        "booking-lookup",
        "booking-withdraw",
        "booking-cancel-preview",
        "booking-cancel",
        "booking-change-preview",
        "booking-change-submit",
        "booking-change-get",
        "booking-payment-instructions",
        "promo-validate",
      ]),
    );
    expect(operations).toHaveLength(16);
    expect(operations.find((entry) => entry.operation === "booking-create")?.idempotencyKey).toBe(
      "guest-create-1",
    );
    expect(operations.find((entry) => entry.operation === "booking-create")).toMatchObject({
      correlationId: "corr-create-1",
      occurredAt: "2026-06-06T11:00:00.000Z",
    });
    expect(
      operations.every(
        (entry) =>
          typeof entry.requestId === "string" &&
          typeof entry.correlationId === "string" &&
          /^[a-f0-9]{64}$/.test(entry.fingerprint ?? "") &&
          entry.occurredAt === "2026-06-06T11:00:00.000Z",
      ),
    ).toBe(true);
    expect(operations.every((entry) => entry.idempotencyKey)).toBe(true);
    expect(lookupAdmissionHashes).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const withdrawContexts = operations.filter((entry) => entry.operation === "booking-withdraw");
    const changePreviewContexts = operations.filter(
      (entry) => entry.operation === "booking-change-preview",
    );
    expect(withdrawContexts).toHaveLength(2);
    expect(changePreviewContexts).toHaveLength(2);
    expect(new Set(withdrawContexts.map((entry) => entry.fingerprint))).toHaveLength(1);
    expect(new Set(withdrawContexts.map((entry) => entry.idempotencyKey))).toHaveLength(1);
    expect(new Set(changePreviewContexts.map((entry) => entry.fingerprint))).toHaveLength(1);
    expect(new Set(changePreviewContexts.map((entry) => entry.idempotencyKey))).toHaveLength(1);
    await app.close();
    expect(closed).toBe(1);
  });

  it("admits five booking lookups per minute per client address", async () => {
    const auditInserts: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes("count(*)::text AS count")) {
          return { rows: [{ count: String(auditInserts.length) }] };
        }
        if (text.includes("INSERT INTO platform.product_audit_events")) {
          auditInserts.push({ text, values });
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });
    const context = (attempt: number) => ({
      operation: "booking-lookup",
      requestId: "lookup-restarted-process",
      correlationId: `lookup-${attempt}`,
      idempotencyKey: `lookup-${attempt}`,
      fingerprint: String(attempt).padStart(64, "0"),
      occurredAt: new Date("2026-09-02T10:00:30.000Z"),
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        adapter.consumeLookupAttempt("client-address-hash", context(attempt)),
      ).resolves.toBeUndefined();
    }
    await expect(adapter.consumeLookupAttempt("client-address-hash", context(6))).rejects.toThrow(
      "Too many booking lookup attempts",
    );
    expect(auditInserts).toHaveLength(5);
    expect(new Set(auditInserts.map((entry) => entry.values?.[0]))).toHaveLength(5);
    expect(auditInserts[0]?.text).toContain("'security', 'restricted'");
    expect(auditInserts[0]?.values).not.toContain("198.51.100.1");

    let lookupCalled = false;
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: {
        ...createUnavailableBookingWebCheckoutAdapter(),
        async consumeLookupAttempt() {
          throw Object.assign(new Error("Too many booking lookup attempts."), { statusCode: 429 });
        },
        async lookup() {
          lookupCalled = true;
          return {};
        },
      },
    });
    const limited = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
      payload: { bookingReference: "VAY-ABC123", guestEmail: "guest@example.test" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(lookupCalled).toBe(false);
    await app.close();
  });

  it("only trusts forwarding headers from known proxies for booking lookup limits", async () => {
    const hashes: string[] = [];
    const app = buildApp({
      logger: false,
      trustProxy: ["10.0.0.1"],
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: {
        ...createUnavailableBookingWebCheckoutAdapter(),
        async consumeLookupAttempt(hash) {
          hashes.push(hash);
        },
        async lookup() {
          return {};
        },
      },
    });
    const injectLookup = (remoteAddress: string, forwardedFor: string) =>
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        remoteAddress,
        headers: { "x-forwarded-for": forwardedFor },
        payload: { bookingReference: "VAY-ABC123", guestEmail: "guest@example.test" },
      });

    await injectLookup("198.51.100.44", "192.0.2.1");
    await injectLookup("198.51.100.44", "192.0.2.2");
    await injectLookup("10.0.0.1", "198.51.100.1, 203.0.113.9");

    const hash = (address: string) =>
      createHash("sha256").update(`booking-lookup-client:${address}`).digest("hex");
    expect(hashes).toEqual([hash("198.51.100.44"), hash("198.51.100.44"), hash("203.0.113.9")]);
    await app.close();
  });

  it("rejects public booking references as authorization handles", async () => {
    let called = false;
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: {
        ...createUnavailableBookingWebCheckoutAdapter(),
        async confirmAuthorization() {
          called = true;
          return {};
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-ABC123/confirm-authorization",
    });

    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it("keeps one checkout attempt replayable while distinct attempt tokens create distinct quotes", async () => {
    const keys: string[] = [];
    const checkoutAdapter: BookingWebCheckoutAdapter = {
      ...createUnavailableBookingWebCheckoutAdapter(),
      async quoteBooking(_slug, _request, context) {
        if (!context) throw new Error("Missing checkout command context");
        keys.push(context.idempotencyKey);
        return {
          quoteId: context.idempotencyKey === "quote-attempt-a" ? "Q-A" : "Q-B",
          roomTypeId: "room-deluxe",
          paymentMethod: "pay_at_property",
          totalAmount: 100,
          currency: "EUR",
        };
      },
    };
    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: checkoutAdapter,
    });
    const request = {
      method: "POST" as const,
      url: "/api/booking-web/hotels/hotel-alpenrose/bookings/quote",
      payload: {
        roomTypeId: "room-deluxe",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
      },
    };

    const responses = await Promise.all([
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-a" } }),
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-a" } }),
      app.inject({ ...request, headers: { "Idempotency-Key": "quote-attempt-b" } }),
    ]);

    expect(responses.map((response) => [response.statusCode, response.json()])).toEqual([
      [200, expect.objectContaining({ quoteId: "Q-A" })],
      [200, expect.objectContaining({ quoteId: "Q-A" })],
      [200, expect.objectContaining({ quoteId: "Q-B" })],
    ]);
    expect(keys).toEqual(["quote-attempt-a", "quote-attempt-a", "quote-attempt-b"]);
    await app.close();
  });

  it("completes reserved checkout idempotency rows with response fields", async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [] };
      },
    } as unknown as BookingWebCalendarReadPool;

    await recordTargetCheckoutCommand(pool, {
      propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      resourceType: "guest_booking",
      resourceId: "booking_123",
      body: { bookingReference: "VAY-123" },
      context: {
        operation: "booking-create",
        requestId: "req-1",
        correlationId: "corr-1",
        idempotencyKey: "idem-1",
        fingerprint: "f".repeat(64),
        occurredAt: new Date("2026-06-20T21:07:48.453Z"),
      },
    });

    expect(calls[0]?.text).toContain("response_status_code = EXCLUDED.response_status_code");
    expect(calls[0]?.text).toContain(
      "response_resource_product = EXCLUDED.response_resource_product",
    );
    expect(calls[0]?.text).toContain("response_resource_type = EXCLUDED.response_resource_type");
    expect(calls[0]?.text).toContain("response_resource_id = EXCLUDED.response_resource_id");
    expect(calls[0]?.text).toContain("idempotency_metadata = CASE");
    expect(JSON.parse(String(calls[0]?.values?.[10]))).toMatchObject({
      responseBody: { bookingReference: "VAY-123" },
    });
  });

  it("replays an identical completed checkout response without repeating side effects", async () => {
    const replayBody = {
      bookingReference: "B-REPLAY123",
      booking: { bookingReference: "B-REPLAY123", paymentStatus: "unpaid" },
      pmsHandoff: { status: "pending_handoff" },
    };
    const calls: string[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return { rows: [{ phoneRequired: false, acceptedMethods: ["pay_at_property"] }] };
        }
        if (text.includes("FROM booking.guest_bookings booking")) {
          return {
            rows: [
              {
                guestBookingId: "b9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                publicReference: "B-PAYPAL-1",
                lifecycleStatus: "pending_payment",
                paymentStatus: "unpaid",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                bookingMetadata: { paymentMethod: "paypal" },
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) return { rows: [] };
        if (text.includes("FROM platform.idempotency_keys")) {
          return {
            rows: [
              {
                requestFingerprintHash: "c".repeat(64),
                status: "completed",
                idempotencyMetadata: { responseBody: replayBody },
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(
      adapter.createBooking(
        "hotel-alpenrose",
        { guestEmail: "guest@example.test" },
        {
          operation: "booking-create",
          requestId: "req-replay",
          correlationId: "corr-replay",
          idempotencyKey: "idem-replay",
          fingerprint: "c".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).resolves.toEqual(replayBody);
    expect(calls.some((text) => text.includes("FROM booking.quote_sessions"))).toBe(false);
    expect(calls.some((text) => text.includes("INSERT INTO booking.guest_bookings"))).toBe(false);
    expect(calls.some((text) => text.includes("INSERT INTO platform.jobs"))).toBe(false);
  });

  it("creates target checkout quotes from public offer snapshots", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    let ended = 0;
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                acceptanceMode: "request",
                defaultCurrency: "EUR",
                depositPolicy: {},
              },
            ],
          };
        }
        if (text.includes("FROM distribution.public_room_offer_snapshots")) {
          return {
            rows: [
              {
                publicOfferKey: "room_deluxe:flexible",
                roomTypeId: "room_deluxe",
                ratePlanId: "flexible",
                roomSummary: { name: "Deluxe Double Room" },
                rateSummary: { name: "Flexible" },
                occupancy: { maxAdults: 2, maxChildren: 1 },
                publicPolicy: {
                  type: "free_until_days_before_arrival",
                  freeCancellationDeadlineDays: 7,
                  afterDeadlinePenalty: "full_booking_amount",
                  noShowPenalty: "full_booking_amount",
                  cancellation: "Free cancellation until 7 days before arrival.",
                  deposit: "50% deposit required.",
                },
                paymentOptions: ["pay_at_property"],
                availableRooms: 2,
                nightlyRoomAmounts: nights("187.20"),
                roomTotal: "561.60",
                taxesAndFees: "0.00",
                discounts: "0.00",
                currency: "EUR",
                generatedAt: "2026-06-25T10:00:00.000Z",
                sourceFreshness: { pms: { status: "fresh" } },
                profileCapabilities: { onlinePayment: false, payAtProperty: true },
              },
            ],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "799e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.includes("INSERT INTO booking.quote_sessions")) {
          return {
            rows: [
              {
                quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
                publicQuoteReference: "Q-TARGETQUOTE1",
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {
        ended += 1;
      },
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    const quote = await adapter.quoteBooking(
      "hotel-alpenrose",
      {
        roomTypeId: "room_deluxe",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        paymentMethod: "pay_at_property",
        rateType: "flexible",
      },
      {
        operation: "booking-quote",
        requestId: "req-quote",
        correlationId: "corr-quote",
        idempotencyKey: "quote-key",
        fingerprint: "a".repeat(64),
        occurredAt: new Date("2026-06-25T12:00:00.000Z"),
      },
    );

    const quoteSessionWrites = calls.filter((call) =>
      call.text.includes("INSERT INTO booking.quote_sessions"),
    ).length;
    await expect(
      adapter.quoteBooking("hotel-alpenrose", {
        roomTypeId: "room_deluxe",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        paymentMethod: "pay_at_property",
        rateType: "flexible",
        addonIds: ["airport_transfer"],
      }),
    ).rejects.toThrow("add-on pricing");

    expect(quote).toMatchObject({
      quoteId: "Q-TARGETQUOTE1",
      roomTypeId: "room_deluxe",
      roomName: "Deluxe Double Room",
      paymentMethod: "pay_at_property",
      acceptanceMode: "request",
      roomTotal: 561.6,
      totalAmount: 561.6,
      depositRequired: false,
      depositPercentage: 0,
      depositAmount: 0,
      balanceAmount: 561.6,
      currency: "EUR",
    });
    expect(
      calls.filter((call) => call.text.includes("INSERT INTO booking.quote_sessions")),
    ).toHaveLength(quoteSessionWrites);
    const reserveIndex = calls.findIndex(
      (call) =>
        call.text.includes("INSERT INTO platform.idempotency_keys") &&
        call.text.includes("'in_progress'"),
    );
    const quoteIndex = calls.findIndex((call) =>
      call.text.includes("INSERT INTO booking.quote_sessions"),
    );
    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(reserveIndex).toBeLessThan(quoteIndex);
    const propertyRead = calls.find((call) =>
      call.text.includes("FROM hotel_catalog.property_slugs"),
    );
    expect(propertyRead?.text).toContain("profile.freshness_status = 'fresh'");
    expect(propertyRead?.text).toContain(
      "profile.public_setup_completeness ->> 'status' = 'ready'",
    );
    expect(propertyRead?.text).not.toContain("profile.capabilities ->> 'onlinePayment'");
    expect(propertyRead?.text).not.toContain("profile.capabilities ->> 'payAtProperty'");
    expect(propertyRead?.text).not.toContain("profile.capabilities ->> 'instantBook'");
    expect(propertyRead?.text).toContain(
      "jsonb_array_length(profile.capabilities -> 'paymentMethods') > 0",
    );
    const offerRead = calls.find((call) =>
      call.text.includes("FROM distribution.public_room_offer_snapshots"),
    );
    expect(offerRead?.text).toContain("offer.freshness_status = 'fresh'");
    expect(offerRead?.text).toContain(
      "jsonb_agg(offer.payment_options ORDER BY offer.stay_date)->0",
    );
    expect(offerRead?.text).not.toContain("array_agg(offer.payment_options");
    expect(offerRead?.text).toContain("offer.rate_summary ->> 'minStayNights'");
    expect(offerRead?.text).toContain("offer.rate_summary ->> 'maxStayNights'");
    expect(offerRead?.text).toContain("<= $11::int");
    expect(offerRead?.text).toContain(">= $11::int");
    const quoteWrite = calls.find((call) =>
      call.text.includes("INSERT INTO booking.quote_sessions"),
    );
    expect(JSON.parse(String(quoteWrite?.values?.[9]))).toMatchObject({
      paymentOptions: ["pay_at_property"],
      paymentMethod: "pay_at_property",
      acceptanceMode: "request",
      publicPolicy: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
      },
    });
    expect(JSON.parse(String(quoteWrite?.values?.[11]))).toMatchObject({
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
    });
    expect(calls.some((call) => call.text.includes("platform.product_audit_events"))).toBe(true);
    await adapter.close?.();
    expect(ended).toBe(0);
  });

  it("exposes target checkout phone required settings", async () => {
    const calls: string[] = [];
    let termsText: string | null = "Hotel Alpenrose booking terms.";
    let paypalConfigured = true;
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                defaultCurrency: "EUR",
                phoneRequired: false,
                termsText,
                cancellationPolicyText: "Free cancellation until seven days before arrival.",
                paymentsEnabled: true,
                acceptedMethods: [
                  "card",
                  "xendit",
                  "wallet",
                  "manual_card",
                  "bank_transfer",
                  "paypal",
                  "pay_at_property",
                ].filter((method) => paypalConfigured || method !== "paypal"),
                depositPolicy: {
                  bankTransferInstructions: "Bank: Vayada Bank\nIBAN: DE123",
                  paypalEmail: paypalConfigured ? "payments@alpenrose.test" : "",
                  paypalPaymentWindowHours: 48,
                },
                refundPolicy: {},
              },
            ],
          };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return {
            rows: [
              {
                guestBookingId: "booking-paypal-1",
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                publicReference: "B-PAYPAL-1",
                lifecycleStatus: "pending_payment",
                paymentStatus: "unpaid",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                bookingMetadata: {
                  paymentMethod: "paypal",
                  paymentInstructions: {
                    paypalEmail: "payments@alpenrose.test",
                    paypalPaymentWindowHours: 48,
                  },
                },
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      phoneRequired: false,
      termsText: "Hotel Alpenrose booking terms.",
      cancellationPolicyText: "Free cancellation until seven days before arrival.",
      paymentsEnabled: true,
      acceptedPaymentMethods: ["bank_transfer", "paypal", "pay_at_property"],
      bankTransfer: true,
      paypalEnabled: true,
      paypalPaymentWindowHours: 48,
    });
    paypalConfigured = false;
    await expect(
      adapter.getPaymentInstructions("hotel-alpenrose", "B-PAYPAL-1"),
    ).resolves.toMatchObject({
      paypal: {
        enabled: true,
        email: "payments@alpenrose.test",
        paymentWindowHours: 48,
      },
    });
    termsText = null;
    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      termsText: "",
    });
    expect(calls.find((call) => call.includes("FROM hotel_catalog.properties p"))).toContain(
      "hotel_catalog.property_policy_summaries",
    );
  });

  it("validates target booking phone and atomically reserves fresh inventory", async () => {
    const createAdapter = (
      phoneRequired: boolean,
      quotedAcceptanceMode: "instant" | "request" = "request",
    ) => {
      const calls: string[] = [];
      let bookingWriteValues: readonly unknown[] | undefined;
      const pool = {
        async query(text: string, values?: readonly unknown[]) {
          calls.push(text);
          if (text.includes("FROM hotel_catalog.property_slugs")) {
            return {
              rows: [
                {
                  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  displayName: "Hotel Alpenrose",
                  defaultLocale: "en",
                },
              ],
            };
          }
          if (text.includes("INSERT INTO platform.idempotency_keys")) {
            return { rows: [{ id: "899e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
          }
          if (
            text.trimStart().startsWith("SELECT") &&
            text.includes("FROM booking.quote_sessions")
          ) {
            return {
              rows: [
                {
                  quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
                  publicQuoteReference: "Q-TARGETQUOTE1",
                  requestedCheckIn: "2026-09-12",
                  requestedCheckOut: "2026-09-15",
                  adults: 2,
                  children: 0,
                  roomCount: 1,
                  currency: "EUR",
                  status: "active",
                  selectedOfferSnapshot: {
                    roomTypeId: "room_deluxe",
                    publicOfferKey: "room_deluxe:flexible",
                    paymentMethod: "pay_at_property",
                    acceptanceMode: quotedAcceptanceMode,
                    nightlyRoomAmounts: nights("33.34", "33.33", "33.33"),
                  },
                  totals: { totalAmount: "100.00", balanceAmount: "100.00" },
                  policySnapshot: { freeUntilDays: 7 },
                  expiresAt: "2026-09-12T12:00:00.000Z",
                },
              ],
            };
          }
          if (text.includes("FROM hotel_catalog.properties p")) {
            return {
              rows: [
                {
                  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  acceptanceMode: quotedAcceptanceMode === "request" ? "instant" : "request",
                  defaultCurrency: "EUR",
                  phoneRequired,
                  paymentsEnabled: true,
                  acceptedMethods: ["pay_at_property", "cash"],
                  depositPolicy: {},
                  refundPolicy: {},
                },
              ],
            };
          }
          if (text.includes("UPDATE pms.inventory_days")) {
            return { rows: [{ reserved: true }] };
          }
          if (text.includes("SELECT * FROM booking_row")) {
            bookingWriteValues = values;
            return {
              rows: [
                {
                  guestBookingId: "3c6a35e2-1436-455a-bf05-96d2f4559421",
                  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  publicReference: "B-OPTIONAL",
                  lifecycleStatus: String(values?.[9]),
                  paymentStatus: "unpaid",
                  checkIn: "2026-09-12",
                  checkOut: "2026-09-15",
                  adults: 2,
                  children: 0,
                  roomCount: 1,
                  currency: "EUR",
                  totalAmount: "100.00",
                  balanceAmount: "100.00",
                  bookingMetadata: JSON.parse(String(values?.[18])),
                  createdAt: "2026-06-25T12:00:00.000Z",
                },
              ],
            };
          }
          if (text.includes('AS "hostEmail"')) {
            return {
              rows: [
                {
                  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  guestBookingId: "3c6a35e2-1436-455a-bf05-96d2f4559421",
                  bookingReference: "B-OPTIONAL",
                  guestEmail: "guest@example.com",
                  guestName: "Guest Guest",
                  hostEmail: "reservations@example.test",
                  propertyName: "Hotel Alpenrose",
                  checkIn: "2026-09-12",
                  checkOut: "2026-09-15",
                  totalAmount: "100.00",
                  balanceAmount: "100.00",
                  currency: "EUR",
                  paymentMethod: "pay_at_property",
                  bookingMetadata: { acceptanceMode: quotedAcceptanceMode },
                },
              ],
            };
          }
          if (text.includes("INSERT INTO platform.domain_events")) {
            return { rows: [{ eventId: "4c6a35e2-1436-455a-bf05-96d2f4559421" }] };
          }
          if (text.includes('RETURNING id::text AS "jobId"')) {
            return {
              rows: [{ jobId: "5c6a35e2-1436-455a-bf05-96d2f4559421", replay: false }],
            };
          }
          return { rows: [] };
        },
        async end() {},
      };
      return {
        adapter: createTargetBookingWebCheckoutAdapter({
          connectionString: "postgres://unused",
          inventoryReservationPort: createTargetPmsInventoryReservationPort(),
          billingConfigReadPortFactory: (executor) => ({
            async getBillingConfig() {
              expect(executor).toBe(pool);
              return {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                activePlan: "fixed",
                bookingEngineFeePercent: 0,
                channelManagerFeePercent: 0,
                affiliatePlatformFeePercent: 7,
                updatedAt: "2026-06-25T11:59:00.000Z",
              };
            },
          }),
          pool: pool as never,
        }),
        calls,
        get bookingWriteValues() {
          return bookingWriteValues;
        },
      };
    };
    const request = {
      quoteId: "Q-TARGETQUOTE1",
      roomTypeId: "room_deluxe",
      guestEmail: "guest@example.com",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      numberOfRooms: 1,
      paymentMethod: "pay_at_property",
      expectedTotalAmount: 100,
      balanceAmount: 100,
      paymentStatus: "paid",
    };
    const context = {
      operation: "booking-create",
      requestId: "req-create",
      correlationId: "corr-create",
      idempotencyKey: "create-key",
      fingerprint: "b".repeat(64),
      occurredAt: new Date("2026-06-25T12:00:00.000Z"),
    };

    const requiredPhone = createAdapter(true);
    await expect(
      requiredPhone.adapter.createBooking("hotel-alpenrose", request, context),
    ).rejects.toThrow("Guest phone is required");
    expect(
      requiredPhone.calls.some((text) => text.includes("INSERT INTO platform.idempotency_keys")),
    ).toBe(true);
    expect(requiredPhone.calls).toContain("ROLLBACK");
    expect(
      requiredPhone.calls.some((text) => text.includes("INSERT INTO booking.guest_bookings")),
    ).toBe(false);

    const optionalPhone = createAdapter(false);
    await expect(
      optionalPhone.adapter.createBooking("hotel-alpenrose", request, context),
    ).resolves.toMatchObject({
      bookingReference: "B-OPTIONAL",
    });
    expect(optionalPhone.calls.some((text) => text.includes("platform.idempotency_keys"))).toBe(
      true,
    );
    expect(optionalPhone.bookingWriteValues?.[10]).toBe("unpaid");
    expect(optionalPhone.bookingWriteValues?.[9]).toBe("pending_payment");
    expect(JSON.parse(String(optionalPhone.bookingWriteValues?.[18]))).toMatchObject({
      acceptanceMode: "request",
      hostResponseDeadlineAt: "2026-06-26T12:00:00.000Z",
      policySnapshot: { freeUntilDays: 7 },
      inventoryReservation: {
        contractVersion: "pms.inventory-reservation.v1",
        owner: "pms",
        source: "booking_engine",
        quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
        propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
        roomTypeId: "room_deluxe",
        publicOfferKey: "room_deluxe:flexible",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        roomCount: 1,
      },
    });
    expect(
      optionalPhone.calls.find((text) => text.includes("INSERT INTO booking.guest_bookings")),
    ).toContain("billing_plan_snapshot");
    expect(optionalPhone.bookingWriteValues?.[29]).toBe("fixed");
    expect(JSON.parse(String(optionalPhone.bookingWriteValues?.[30]))).toEqual({
      bookingEngineFeePercent: 0,
      channelManagerFeePercent: 0,
      affiliatePlatformFeePercent: 7,
      financeConfigUpdatedAt: "2026-06-25T11:59:00.000Z",
    });
    expect(
      optionalPhone.calls.filter((text) => text.includes("INSERT INTO platform.domain_events")),
    ).toHaveLength(2);
    const inventoryReservation = optionalPhone.calls.find((text) =>
      text.includes("UPDATE pms.inventory_days"),
    );
    expect(inventoryReservation).toContain("pg_advisory_xact_lock");
    expect(inventoryReservation).toContain(
      "assigned_count = inventory.assigned_count + $6::integer",
    );
    expect(inventoryReservation).toContain("UPDATE distribution.public_room_offer_snapshots");
    expect(inventoryReservation).toContain("HAVING COUNT(DISTINCT offer.stay_date)");
    expect(inventoryReservation).toContain("BOOL_AND(offer.available_rooms >= $6::integer)");
    expect(inventoryReservation).toContain("COUNT(DISTINCT stay_date)");
    expect(
      optionalPhone.calls.find((text) => text.includes("SELECT * FROM booking_row")),
    ).not.toContain("pms.inventory_days");
    expect(
      optionalPhone.calls.find((text) => text.includes("FROM booking.quote_sessions")),
    ).toContain('requested_check_in::text AS "requestedCheckIn"');
    expect(
      optionalPhone.calls.find((text) => text.includes("SELECT * FROM booking_row")),
    ).toContain('check_in::text AS "checkIn"');

    const instant = createAdapter(false, "instant");
    await expect(
      instant.adapter.createBooking("hotel-alpenrose", request, context),
    ).resolves.toMatchObject({ booking: { status: "confirmed" } });
    expect(instant.bookingWriteValues?.[9]).toBe("confirmed");
  });

  it("validates quote dates before reserving the booking-create idempotency key", async () => {
    const calls: string[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [
              {
                propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
              },
            ],
          };
        }
        if (text.includes("FROM platform.idempotency_keys")) return { rows: [] };
        if (text.includes("FROM hotel_catalog.properties p")) {
          return { rows: [{ phoneRequired: false, acceptedMethods: ["pay_at_property"] }] };
        }
        if (text.includes("FROM booking.quote_sessions")) {
          return {
            rows: [
              {
                quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
                publicQuoteReference: "Q-STALE-DATES",
                requestedCheckIn: "2026-09-11",
                requestedCheckOut: "2026-09-14",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                status: "active",
                selectedOfferSnapshot: {
                  roomTypeId: "room_deluxe",
                  publicOfferKey: "room_deluxe:flexible",
                  paymentMethod: "pay_at_property",
                },
                totals: { totalAmount: "100.00", balanceAmount: "100.00" },
                policySnapshot: {},
                expiresAt: "2026-09-12T12:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "899e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(
      adapter.createBooking(
        "hotel-alpenrose",
        {
          quoteId: "Q-STALE-DATES",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          children: 0,
          numberOfRooms: 1,
          expectedTotalAmount: 100,
          guestEmail: "guest@example.test",
        },
        {
          operation: "booking-create",
          requestId: "req-stale-dates",
          correlationId: "corr-stale-dates",
          idempotencyKey: "idem-stale-dates",
          fingerprint: "d".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("Booking details changed");
    expect(calls.some((text) => text.includes("INSERT INTO platform.idempotency_keys"))).toBe(true);
    expect(calls).toContain("ROLLBACK");
    expect(calls.some((text) => text.includes("INSERT INTO booking.guest_bookings"))).toBe(false);
  });

  it("restores authoritative PMS inventory exactly once when a confirmed booking is cancelled", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e951";
    const calls: string[] = [];
    let inventoryWriteValues: readonly unknown[] | undefined;
    let lifecycleStatus = "confirmed";
    let policySnapshot: Record<string, unknown> = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
      freeCancellationDays: 14,
      refund: "none",
      tiers: [{ days: 30, refundPercentage: 50 }],
    };
    const booking = () => ({
      guestBookingId,
      propertyId,
      publicReference: "B-CANCEL951",
      lifecycleStatus,
      paymentStatus: "unpaid",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "300.00",
      bookingMetadata: {
        selectedOffer: {
          roomTypeId: "room-from-current-booking",
          publicOfferKey: "room-deluxe:flexible",
          rateType: "flexible",
          rateSummary: { refundable: true },
        },
        policySnapshot,
        inventoryReservation: {
          contractVersion: "pms.inventory-reservation.v1",
          owner: "pms",
          source: "booking_engine",
          quoteSessionId: "49b3e1e1-95f8-47f2-8bf1-c2d18e3d7a66",
          propertyId,
          roomTypeId: "room-deluxe",
          publicOfferKey: "room-deluxe:flexible",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          roomCount: 1,
        },
      },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push(text);
        if (text.includes("UPDATE pms.inventory_days")) inventoryWriteValues = values;
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking()] };
        }
        if (text.includes("WITH updated AS")) {
          if (lifecycleStatus !== "confirmed") return { rows: [] };
          lifecycleStatus = "canceled";
          return { rows: [booking()] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });
    const request = { guest_email: "guest@example.test" };
    const context = {
      operation: "booking-cancel",
      requestId: "req-cancel",
      correlationId: "corr-cancel",
      idempotencyKey: "cancel-key",
      fingerprint: "d".repeat(64),
      occurredAt: new Date("2026-09-01T10:00:00.000Z"),
    };

    await expect(
      adapter.cancelPreview("hotel-alpenrose", guestBookingId, request, context),
    ).resolves.toMatchObject({
      amountPaid: 0,
      cancellationFeeAmount: 0,
      refundAmount: 0,
      refundPercentage: 0,
      freeCancellationDays: 7,
      daysUntilCheckIn: 11,
      currency: "EUR",
      policy: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
        freeCancellationDays: 14,
        refund: "none",
        tiers: [{ days: 30, refundPercentage: 50 }],
      },
    });

    policySnapshot = {};
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = { refund: "none" };
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-non-refundable",
        fingerprint: "a".repeat(64),
      }),
    ).rejects.toThrow("non-refundable");

    policySnapshot = {
      type: "unknown",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
    };
    await expect(adapter.cancelPreview("hotel-alpenrose", guestBookingId, request)).rejects.toThrow(
      "free-cancellation period cannot be verified",
    );

    policySnapshot = {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    };
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-expired",
        fingerprint: "c".repeat(64),
        occurredAt: new Date("2026-09-06T10:00:00.000Z"),
      }),
    ).rejects.toThrow("free-cancellation period has expired");

    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, context),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        ...context,
        idempotencyKey: "cancel-key-2",
        fingerprint: "e".repeat(64),
      }),
    ).rejects.toThrow("Booking can no longer be changed");

    const inventoryWrites = calls.filter((text) => text.includes("UPDATE pms.inventory_days"));
    expect(inventoryWrites).toHaveLength(1);
    expect(inventoryWrites[0]).toContain("assigned_count - $5::integer");
    expect(inventoryWrites[0]).toContain("UPDATE distribution.public_room_offer_snapshots");
    expect(inventoryWriteValues?.slice(0, 5)).toEqual([
      propertyId,
      "room-deluxe",
      "2026-09-12",
      "2026-09-15",
      1,
    ]);
    expect(calls.some((text) => text.includes("'pms-reservation-handoff'"))).toBe(true);
    expect(calls.filter((text) => text === "COMMIT")).toHaveLength(1);
    expect(calls.filter((text) => text === "ROLLBACK")).toHaveLength(3);
  });

  it("rejects paid inventory-releasing guest mutations until refunds are integrated", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e953";
    const calls: string[] = [];
    let lifecycleStatus = "confirmed";
    let paymentStatus = "paid";
    const booking = () => ({
      guestBookingId,
      propertyId,
      publicReference: "B-PAID953",
      lifecycleStatus,
      paymentStatus,
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "0.00",
      bookingMetadata: {
        paymentMethod: "card",
        inventoryReservation: {
          contractVersion: "pms.inventory-reservation.v1",
          owner: "pms",
        },
      },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a68" }] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking()] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });
    const request = { guest_email: "guest@example.test" };

    await expect(
      adapter.cancelPreview("hotel-alpenrose", guestBookingId, request),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      adapter.cancel("hotel-alpenrose", guestBookingId, request, {
        operation: "booking-cancel",
        requestId: "req-cancel-paid",
        correlationId: "corr-cancel-paid",
        idempotencyKey: "cancel-paid-key",
        fingerprint: "9".repeat(64),
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    lifecycleStatus = "pending_payment";
    paymentStatus = "partially_paid";
    await expect(
      adapter.withdraw("hotel-alpenrose", guestBookingId, request, {
        operation: "booking-withdraw",
        requestId: "req-withdraw-paid",
        correlationId: "corr-withdraw-paid",
        idempotencyKey: "withdraw-paid-key",
        fingerprint: "8".repeat(64),
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(calls.some((text) => text.includes("WITH updated AS"))).toBe(false);
    expect(calls.some((text) => text.includes("UPDATE pms.inventory_days"))).toBe(false);
  });

  it("fails closed for a booking without persisted inventory and cancellation policy markers", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e952";
    const calls: string[] = [];
    const booking = {
      guestBookingId,
      propertyId,
      publicReference: "B-LEGACY952",
      lifecycleStatus: "confirmed",
      paymentStatus: "unpaid",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "300.00",
      balanceAmount: "300.00",
      bookingMetadata: { selectedOffer: { roomTypeId: "room-deluxe" } },
      createdAt: "2026-09-01T10:00:00.000Z",
    };
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a67" }] };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          return { rows: [booking] };
        }
        if (text.includes("WITH updated AS")) {
          return { rows: [{ ...booking, lifecycleStatus: "canceled" }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      pool: pool as never,
    });

    await expect(
      adapter.cancel(
        "hotel-alpenrose",
        guestBookingId,
        { guest_email: "guest@example.test" },
        {
          operation: "booking-cancel",
          requestId: "req-cancel-legacy",
          correlationId: "corr-cancel-legacy",
          idempotencyKey: "cancel-key-legacy",
          fingerprint: "f".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(calls.some((text) => text.includes("UPDATE pms.inventory_days"))).toBe(false);
    expect(calls.some((text) => text.includes("WITH updated AS"))).toBe(false);
    expect(calls.filter((text) => text === "ROLLBACK")).toHaveLength(1);
  });

  it("requires target checkout creates to snapshot the expected quote total", () => {
    const quote = {
      totalAmount: "561600.00",
      balanceAmount: "280800.00",
    };

    expect(
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          totalAmount: 561600,
          balanceAmount: 561600,
        },
        quote,
      ),
    ).toEqual({
      totalAmount: "561600.00",
      balanceAmount: "561600.00",
    });

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          balanceAmount: 280800,
        },
        quote,
      ),
    ).toThrow("Booking balance changed");

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 497250,
          totalAmount: 497250,
        },
        quote,
      ),
    ).toThrow("Booking total changed");

    expect(() =>
      resolveTargetCheckoutAmountSnapshot(
        {
          expectedTotalAmount: 561600,
          balanceAmount: 700000,
        },
        quote,
      ),
    ).toThrow("Booking balance changed");

    expect(() => resolveTargetCheckoutAmountSnapshot({ totalAmount: 561600 })).toThrow(
      "expectedTotalAmount is required",
    );
  });

  it("creates a pending bank-transfer booking without emailing details before host acceptance", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e951";
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return {
            rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }],
          };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.trimStart().startsWith("SELECT") && text.includes("FROM booking.quote_sessions")) {
          return {
            rows: [
              {
                quoteSessionId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e951",
                publicQuoteReference: "Q-BANK951",
                requestedCheckIn: "2026-09-12",
                requestedCheckOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                status: "active",
                selectedOfferSnapshot: {
                  roomTypeId: "room_deluxe",
                  publicOfferKey: "room_deluxe:flexible",
                  paymentMethod: "bank_transfer",
                },
                totals: { totalAmount: "600.00", balanceAmount: "600.00" },
                policySnapshot: {},
                expiresAt: "2026-09-01T10:15:00.000Z",
              },
            ],
          };
        }
        if (text.includes("WITH inventory_lock AS")) {
          return { rows: [{ reserved: true }] };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return {
            rows: [
              {
                propertyId,
                defaultCurrency: "EUR",
                phoneRequired: true,
                paymentsEnabled: true,
                acceptedMethods: ["bank_transfer"],
                depositPolicy: {
                  bankTransferInstructions: "IBAN: DE89370400440532013000",
                },
              },
            ],
          };
        }
        if (text.includes("INSERT INTO booking.guest_bookings")) {
          return {
            rows: [
              {
                guestBookingId,
                propertyId,
                publicReference: "B-BANK951",
                lifecycleStatus: "pending_payment",
                paymentStatus: "unpaid",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                bookingMetadata: { paymentMethod: "bank_transfer" },
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes('AS "hostEmail"')) {
          return {
            rows: [
              {
                propertyId,
                guestBookingId,
                bookingReference: "B-BANK951",
                guestEmail: "guest@example.test",
                guestName: "Ada Guest",
                hostEmail: "reservations@example.test",
                propertyName: "Hotel Alpenrose",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                totalAmount: "600.00",
                balanceAmount: "600.00",
                currency: "EUR",
                paymentMethod: "bank_transfer",
                bookingMetadata: { paymentMethod: "bank_transfer" },
              },
            ],
          };
        }
        if (text.includes("INSERT INTO platform.domain_events")) {
          return { rows: [{ eventId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e951" }] };
        }
        if (text.includes("INSERT INTO platform.jobs") && text.includes("source_domain_event_id")) {
          return {
            rows: [{ jobId: "e9fccec2-eb4c-4c35-bfd3-02a748c2e951", replay: false }],
          };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      billingConfigReadPortFactory: () => ({
        async getBillingConfig() {
          return {
            propertyId,
            activePlan: "commission",
            bookingEngineFeePercent: 5,
            channelManagerFeePercent: 0,
            affiliatePlatformFeePercent: 0,
            updatedAt: "2026-09-01T10:00:00.000Z",
          };
        },
      }),
      pool: pool as never,
    });

    await expect(
      adapter.createBooking(
        "hotel-alpenrose",
        {
          quoteId: "Q-BANK951",
          roomTypeId: "room_deluxe",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          children: 0,
          numberOfRooms: 1,
          paymentMethod: "bank_transfer",
          expectedTotalAmount: 600,
          totalAmount: 600,
          balanceAmount: 600,
          guestEmail: "guest@example.test",
          phone: "+491701234567",
          firstName: "Ada",
          lastName: "Guest",
        },
        {
          operation: "booking-create",
          requestId: "req-bank-951",
          correlationId: "corr-bank-951",
          idempotencyKey: "idem-bank-951",
          fingerprint: "b".repeat(64),
          occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      booking: {
        id: guestBookingId,
        paymentMethod: "bank_transfer",
        status: "pending",
      },
    });

    const quoteRead = calls.find((call) => call.text.includes("FROM booking.quote_sessions"));
    expect(quoteRead?.text).toContain("profile.freshness_status = 'fresh'");
    expect(quoteRead?.text).toContain("profile.public_setup_completeness ->> 'status' = 'ready'");
    expect(quoteRead?.text).not.toContain("profile.capabilities ->> 'onlinePayment'");
    expect(quoteRead?.text).not.toContain("profile.capabilities ->> 'payAtProperty'");
    expect(quoteRead?.values?.[2]).toBe("2026-09-01T10:00:00.000Z");
    expect(calls.some((call) => call.text.includes("INSERT INTO booking.guest_bookings"))).toBe(
      true,
    );
    const bookingInsert = calls.find((call) =>
      call.text.includes("INSERT INTO booking.guest_bookings"),
    );
    expect(JSON.parse(String(bookingInsert?.values?.[18]))).toMatchObject({
      paymentMethod: "bank_transfer",
      pendingExpiresAt: "2026-09-02T10:00:00.000Z",
      paymentInstructions: {
        bankTransferDetails: "IBAN: DE89370400440532013000",
      },
    });
    expect(
      calls.some((call) => call.values?.includes("email.booking-reserved-pending-payment")),
    ).toBe(false);
    expect(calls.some((call) => call.values?.includes("email.booking-request-received"))).toBe(
      true,
    );
    expect(calls.some((call) => call.values?.includes("email.booking-host-review-required"))).toBe(
      true,
    );
  });

  it("creates and settles a target Stripe Connect card booking", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e952";
    let lifecycleStatus = "draft";
    let paymentStatus = "unpaid";
    let balanceAmount = "600.00";
    let cardBrand: string | null = null;
    let cardLast4: string | null = null;
    let operationalStatus: string | null = null;
    let retrievedIntentStatus = "canceled";
    let cardPaymentInput: Record<string, unknown> | null = null;
    let retrievePaymentIntentCalls = 0;
    let createCommandReserved = false;
    let completedCreateBody: unknown;
    let confirmationMetadata: Record<string, unknown> = {};
    let lookupAuditBody: unknown;
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const booking = () => ({
      guestBookingId,
      propertyId,
      publicReference: "B-CARD952",
      lifecycleStatus,
      paymentStatus,
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "600.00",
      balanceAmount,
      expectedPaymentMethod: "manual_card",
      bookingMetadata: {
        paymentMethod: "card",
        acceptedPaymentDeadlineAt: "2026-09-03T10:00:00.000Z",
        pendingExpiresAt: "2026-09-02T10:00:00.000Z",
        paymentInstructions: { bankTransferDetails: "IBAN: DE123" },
        selectedOffer: {
          roomTypeId: "room_deluxe",
          nightlyRoomAmounts: nights("200"),
        },
        requestFingerprint: "2".repeat(64),
        ...confirmationMetadata,
      },
      cardBrand,
      cardLast4,
      operationalStatus,
      assignedRoomTypeName: "Deluxe Suite",
      unitNames: ["Suite 204", "Suite 205"],
      cancelledAt: "2026-09-04T12:30:00.000Z",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return values?.[0] === "hotel-alpenrose"
            ? { rows: [{ propertyId, displayName: "Hotel Alpenrose", defaultLocale: "en" }] }
            : { rows: [] };
        }
        if (text.trimStart().startsWith("INSERT INTO platform.idempotency_keys")) {
          if (values?.[0] === "booking-create" && createCommandReserved) return { rows: [] };
          if (values?.[0] === "booking-create") createCommandReserved = true;
          return { rows: [{ id: "999e6c2a-95f8-47f2-8bf1-c2d18e3d7a66" }] };
        }
        if (text.includes("FROM platform.idempotency_keys")) {
          return {
            rows: [
              {
                requestFingerprintHash: "2".repeat(64),
                status: "completed",
                idempotencyMetadata: { responseBody: completedCreateBody },
              },
            ],
          };
        }
        if (text.includes("WITH upserted_key AS")) {
          if (values?.[0] === "booking-create") {
            completedCreateBody = JSON.parse(String(values[10])).responseBody;
          }
          if (values?.[0] === "booking-lookup") {
            lookupAuditBody = JSON.parse(String(values[10])).responseBody;
          }
          return { rows: [] };
        }
        if (text.includes("FROM hotel_catalog.properties p")) {
          return {
            rows: [
              {
                propertyId,
                defaultCurrency: "EUR",
                phoneRequired: true,
                paymentsEnabled: true,
                acceptedMethods: ["card"],
                depositPolicy: {},
                providerAccountId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                providerAccountRef: "acct_property_952",
                providerReady: true,
              },
            ],
          };
        }
        if (text.trimStart().startsWith("SELECT") && text.includes("FROM booking.quote_sessions")) {
          return {
            rows: [
              {
                quoteSessionId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                publicQuoteReference: "Q-CARD952",
                requestedCheckIn: "2026-09-12",
                requestedCheckOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                currency: "EUR",
                status: "active",
                selectedOfferSnapshot: {
                  roomTypeId: "room_deluxe",
                  publicOfferKey: "room_deluxe:flexible",
                  paymentMethod: "card",
                  nightlyRoomAmounts: nights("200"),
                },
                totals: { totalAmount: "600.00", balanceAmount: "600.00" },
                policySnapshot: {},
                expiresAt: "2026-09-01T10:15:00.000Z",
              },
            ],
          };
        }
        if (text.includes("WITH inventory_lock AS")) return { rows: [{ reserved: true }] };
        if (text.includes("INSERT INTO booking.guest_bookings")) return { rows: [booking()] };
        if (
          text.startsWith("UPDATE booking.guest_bookings") &&
          text.includes("'{confirmationTokens}'")
        ) {
          const confirmationTokens = {
            ...((confirmationMetadata.confirmationTokens as Record<string, unknown>) ?? {}),
            [String(values?.[2])]: values?.[4],
          };
          confirmationMetadata = {
            confirmationTokens,
          };
          return { rows: [] };
        }
        if (text.includes('account.provider_account_id AS "providerAccountRef"')) {
          return {
            rows: [
              {
                paymentId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                providerPaymentIntentId: "pi_card_952",
                providerAccountRef: "acct_property_952",
                cardBrand,
                cardLast4,
              },
            ],
          };
        }
        if (text.includes("FOR UPDATE OF payment, booking")) {
          return {
            rows: [
              {
                paymentId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e952",
                paymentStatus: "requires_action",
                propertyId,
                guestBookingId,
                amount: "600.00",
                currency: "EUR",
                lifecycleStatus,
                bookingPaymentStatus: paymentStatus,
                publicReference: "B-CARD952",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                adults: 2,
                children: 0,
                roomCount: 1,
                totalAmount: "600.00",
                bookingMetadata: booking().bookingMetadata,
              },
            ],
          };
        }
        if (
          text.includes("WHERE provider_payment_intent_id = $1") &&
          text.includes("payment_metadata = payment_metadata || $2::jsonb")
        ) {
          const details = JSON.parse(String(values?.[1])) as {
            cardBrand: string;
            cardLast4: string;
          };
          cardBrand = details.cardBrand;
          cardLast4 = details.cardLast4;
          return { rows: [] };
        }
        if (text.startsWith("UPDATE booking.guest_bookings") && text.includes("RETURNING id")) {
          lifecycleStatus = "confirmed";
          paymentStatus = "paid";
          balanceAmount = "0.00";
          return { rows: [{ id: guestBookingId }] };
        }
        if (text.includes("WITH payment AS") && text.includes("guest_booking.payment_received")) {
          lifecycleStatus = "confirmed";
          paymentStatus = "paid";
          balanceAmount = "0.00";
          return { rows: [{ guestBookingId }] };
        }
        if (text.includes('from_status AS "fromStatus"')) {
          return { rows: [{ fromStatus: "draft", toStatus: "confirmed" }] };
        }
        if (text.includes('AS "hostEmail"')) {
          return {
            rows: [
              {
                propertyId,
                guestBookingId,
                bookingReference: "B-CARD952",
                guestEmail: "guest@example.test",
                guestName: "Guest Guest",
                hostEmail: "reservations@example.test",
                propertyName: "Hotel Alpenrose",
                checkIn: "2026-09-12",
                checkOut: "2026-09-15",
                totalAmount: "600.00",
                balanceAmount: balanceAmount,
                currency: "EUR",
                paymentMethod: "card",
                bookingMetadata: booking().bookingMetadata,
              },
            ],
          };
        }
        if (text.includes("FROM booking.guest_bookings b")) {
          if (text.includes("JOIN booking.booking_guests booker")) {
            const suppliedEmail = values?.[2];
            const suppliedTokenHash = values?.[3];
            const tokenMatches =
              typeof suppliedTokenHash === "string" &&
              suppliedTokenHash in
                ((confirmationMetadata.confirmationTokens as Record<string, unknown>) ?? {});
            if (
              values?.[0] !== propertyId ||
              values?.[1] !== "B-CARD952" ||
              (suppliedEmail !== "guest@example.test" && !tokenMatches)
            ) {
              return { rows: [] };
            }
          }
          return {
            rows: [
              {
                ...booking(),
                hotelName: "Hotel Alpenrose",
                guestFirstName: "Guest",
                guestLastName: "Guest",
                guestEmail: "guest@example.test",
              },
            ],
          };
        }
        if (text.includes("FROM booking.guest_bookings booking")) return { rows: [booking()] };
        if (text.includes("INSERT INTO platform.domain_events")) {
          return { rows: [{ eventId: "e9fccec2-eb4c-4c35-bfd3-02a748c2e952" }] };
        }
        if (text.includes("INSERT INTO platform.jobs") && text.includes("source_domain_event_id")) {
          return { rows: [{ jobId: "f9fccec2-eb4c-4c35-bfd3-02a748c2e952", replay: false }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const stripePaymentProvider = {
      async createPaymentIntent(input: Record<string, unknown>) {
        cardPaymentInput = input;
        return {
          paymentIntentId: "pi_card_952",
          clientSecret: "pi_card_952_secret_test",
          status: "requires_payment_method",
          amountMinor: 60_000,
          currency: "EUR",
          propertyId,
          bookingReference: "B-CARD952",
          providerAccountRef: "acct_property_952",
        };
      },
      async retrievePaymentIntent() {
        retrievePaymentIntentCalls += 1;
        return {
          paymentIntentId: "pi_card_952",
          clientSecret: "pi_card_952_secret_test",
          status: retrievedIntentStatus,
          amountMinor: 60_000,
          currency: "EUR",
          propertyId,
          bookingReference: "B-CARD952",
          providerAccountRef: "acct_property_952",
          cardBrand: "visa",
          cardLast4: "4242",
        };
      },
      async capturePaymentIntent() {
        throw new Error("not used");
      },
      async cancelPaymentIntent() {
        throw new Error("not used");
      },
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      stripePaymentProvider,
      billingConfigReadPortFactory: () => ({
        async getBillingConfig() {
          return {
            propertyId,
            activePlan: "commission",
            bookingEngineFeePercent: 5,
            channelManagerFeePercent: 5,
            affiliatePlatformFeePercent: 0,
            updatedAt: "2026-09-01T09:00:00.000Z",
          };
        },
      }),
      pool: pool as never,
    });

    const createRequest = {
      quoteId: "Q-CARD952",
      roomTypeId: "room_deluxe",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      numberOfRooms: 1,
      paymentMethod: "card",
      expectedTotalAmount: 600,
      totalAmount: 600,
      balanceAmount: 600,
      guestEmail: "guest@example.test",
      phone: "+491701234567",
    };
    const createContext = {
      operation: "booking-create" as const,
      requestId: "req-card-create-952",
      correlationId: "corr-card-952",
      idempotencyKey: "idem-card-create-952",
      fingerprint: "2".repeat(64),
      occurredAt: new Date("2026-09-01T10:00:00.000Z"),
    };
    const created = (await adapter.createBooking(
      "hotel-alpenrose",
      createRequest,
      createContext,
    )) as { confirmationToken: string; confirmationTokenExpiresAt: string };
    expect(created).toMatchObject({
      clientSecret: "pi_card_952_secret_test",
      draftId: guestBookingId,
      confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      confirmationTokenExpiresAt: "2026-09-02T10:00:00.000Z",
      booking: { id: guestBookingId, status: "draft", paymentMethod: "card" },
    });
    expect(calls.some((call) => call.text.includes("INSERT INTO finance.payments"))).toBe(true);
    expect(cardPaymentInput).toMatchObject({
      propertyId,
      amountMinor: 60_000,
      applicationFeeAmountMinor: 3_000,
      captureMethod: "automatic",
      idempotencyKey: expect.stringMatching(new RegExp(`^booking-card:${propertyId}:`)),
    });
    const cardPropertyRead = calls.find((call) =>
      call.text.includes("FROM hotel_catalog.property_slugs"),
    );
    expect(cardPropertyRead?.text).not.toContain("profile.capabilities ->> 'payAtProperty'");
    expect(cardPropertyRead?.text).toContain(
      "jsonb_array_length(profile.capabilities -> 'paymentMethods') > 0",
    );
    const paymentInsert = calls.find((call) => call.text.includes("INSERT INTO finance.payments"));
    expect(paymentInsert?.values?.slice(4, 7)).toEqual(["600.00", "30.00", "570.00"]);
    const bookingInsert = calls.find((call) =>
      call.text.includes("INSERT INTO booking.guest_bookings"),
    );
    expect(bookingInsert?.values).toContainEqual(expect.stringMatching(/^VAY-[A-F0-9]{6}$/));
    expect(calls.some((call) => call.text.includes("'pms-reservation-handoff'"))).toBe(false);

    await expect(
      adapter.createBooking("hotel-alpenrose", createRequest, createContext),
    ).resolves.toMatchObject({
      authorizationExpired: true,
      authorizationComplete: false,
      clientSecret: null,
      draftId: guestBookingId,
    });
    expect(lifecycleStatus).toBe("draft");

    retrievedIntentStatus = "succeeded";
    await expect(
      adapter.createBooking("hotel-alpenrose", createRequest, createContext),
    ).resolves.toMatchObject({
      authorizationComplete: true,
      clientSecret: null,
      booking: {
        id: guestBookingId,
        status: "confirmed",
        paymentStatus: "paid",
        cardBrand: "visa",
        cardLast4: "4242",
      },
    });
    expect(calls.some((call) => call.text.includes("guest_booking.payment_received"))).toBe(true);
    expect(calls.some((call) => call.text.includes("'pms-reservation-handoff'"))).toBe(true);

    cardBrand = null;
    cardLast4 = null;
    const retrieveCallsBeforeConfirm = retrievePaymentIntentCalls;
    await expect(
      adapter.confirmAuthorization("hotel-alpenrose", guestBookingId, {
        operation: "booking-confirm-authorization",
        requestId: "req-card-confirm-952",
        correlationId: "corr-card-confirm-952",
        idempotencyKey: "idem-card-confirm-952",
        fingerprint: "3".repeat(64),
        occurredAt: new Date("2026-09-01T10:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: guestBookingId,
      status: "confirmed",
      paymentStatus: "paid",
      cardBrand: "visa",
      cardLast4: "4242",
    });
    expect(retrievePaymentIntentCalls).toBe(retrieveCallsBeforeConfirm + 1);

    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        {
          bookingReference: "B-CARD952",
          confirmationToken: created.confirmationToken,
        },
        {
          operation: "booking-confirmation",
          requestId: "req-card-confirmation-952",
          correlationId: "corr-card-confirmation-952",
          idempotencyKey: "idem-card-confirmation-952",
          fingerprint: "4".repeat(64),
          occurredAt: new Date("2026-09-02T09:59:59.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      id: guestBookingId,
      status: "confirmed",
      cardBrand: "visa",
      cardLast4: "4242",
    });

    const lookup = (await adapter.lookup(
      "hotel-alpenrose",
      { bookingReference: "B-CARD952", guestEmail: "guest@example.test" },
      {
        operation: "booking-lookup",
        requestId: "req-card-lookup-952",
        correlationId: "corr-card-lookup-952",
        idempotencyKey: "idem-card-lookup-952",
        fingerprint: "5".repeat(64),
        occurredAt: new Date("2026-09-02T09:00:00.000Z"),
      },
    )) as { confirmationToken: string; confirmationTokenExpiresAt: string };
    expect(lookup).toMatchObject({
      bookingReference: "B-CARD952",
      confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      confirmationTokenExpiresAt: "2026-09-03T09:00:00.000Z",
    });
    const lookupRead = calls.find(
      (call) =>
        call.text.includes("FROM booking.guest_bookings b") &&
        call.values?.includes("guest@example.test"),
    );
    expect(lookupRead?.text).toContain("b.property_id = $1::uuid");
    expect(lookupRead?.text).toContain("lower(booker.email) = lower($3)");
    expect(lookupRead?.text).toContain("FROM pms.operational_booking_assignments assignment");
    expect(lookupRead?.text).toContain("assignment.property_id = b.property_id");
    expect(lookupRead?.text).toContain('b.expected_payment_method AS "expectedPaymentMethod"');
    expect(lookupRead?.text).toContain("LEFT JOIN pms.room_types assigned_room_type");
    expect(lookupRead?.text).toContain("jsonb_agg(room.room_number");
    expect(lookupRead?.text).toContain("event.to_status = 'canceled'");
    expect(JSON.stringify(lookupAuditBody)).not.toContain(lookup.confirmationToken);

    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: created.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-original-token-952",
          correlationId: "corr-card-original-token-952",
          idempotencyKey: "idem-card-original-token-952",
          fingerprint: "7".repeat(64),
          occurredAt: new Date("2026-09-02T09:00:01.000Z"),
        },
      ),
    ).resolves.toMatchObject({ bookingReference: "B-CARD952" });

    operationalStatus = "checked_in";
    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: created.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-checked-in-952",
          correlationId: "corr-card-checked-in-952",
          idempotencyKey: "idem-card-checked-in-952",
          fingerprint: "b".repeat(64),
          occurredAt: new Date("2026-09-02T09:00:01.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      status: "checked_in",
      roomName: "Deluxe Suite",
      unitNames: ["Suite 204", "Suite 205"],
    });
    operationalStatus = "checked_out";
    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: created.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-checked-out-952",
          correlationId: "corr-card-checked-out-952",
          idempotencyKey: "idem-card-checked-out-952",
          fingerprint: "c".repeat(64),
          occurredAt: new Date("2026-09-02T09:00:01.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      status: "checked_out",
      roomName: "Deluxe Suite",
      unitNames: ["Suite 204", "Suite 205"],
    });
    operationalStatus = null;

    confirmationMetadata = { ...confirmationMetadata, paymentMethod: undefined };
    await expect(
      adapter.confirmation?.("hotel-alpenrose", {
        bookingReference: "B-CARD952",
        confirmationToken: created.confirmationToken,
      }),
    ).resolves.toMatchObject({
      roomName: "Deluxe Suite",
      paymentMethod: "manual_card",
      paymentDeadline: "2026-09-03T10:00:00.000Z",
      unitNames: ["Suite 204", "Suite 205"],
    });
    confirmationMetadata = { ...confirmationMetadata, paymentMethod: "card" };

    lifecycleStatus = "pending_payment";
    await expect(
      adapter.getStatus("hotel-alpenrose", {
        reference: "B-CARD952",
        email: "guest@example.test",
      }),
    ).resolves.toMatchObject({ status: "pending" });
    lifecycleStatus = "canceled";
    await expect(
      adapter.getStatus("hotel-alpenrose", {
        reference: "B-CARD952",
        email: "guest@example.test",
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    lifecycleStatus = "confirmed";
    paymentStatus = "unpaid";
    cardBrand = "visa";
    cardLast4 = "4242";
    const unpaidLookup = (await adapter.lookup(
      "hotel-alpenrose",
      { bookingReference: "B-CARD952", guestEmail: "guest@example.test" },
      {
        operation: "booking-lookup",
        requestId: "req-card-unpaid-lookup-952",
        correlationId: "corr-card-unpaid-lookup-952",
        idempotencyKey: "idem-card-unpaid-lookup-952",
        fingerprint: "8".repeat(64),
        occurredAt: new Date("2026-09-02T09:00:02.000Z"),
      },
    )) as { confirmationToken: string };
    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: unpaidLookup.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-unpaid-confirmation-952",
          correlationId: "corr-card-unpaid-confirmation-952",
          idempotencyKey: "idem-card-unpaid-confirmation-952",
          fingerprint: "9".repeat(64),
          occurredAt: new Date("2026-09-02T09:00:03.000Z"),
        },
      ),
    ).resolves.toMatchObject({ status: "confirmed", paymentStatus: "unpaid" });
    lifecycleStatus = "pending_payment";
    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: unpaidLookup.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-pending-confirmation-952",
          correlationId: "corr-card-pending-confirmation-952",
          idempotencyKey: "idem-card-pending-confirmation-952",
          fingerprint: "a".repeat(64),
          occurredAt: new Date("2026-09-02T09:00:04.000Z"),
        },
      ),
    ).resolves.toMatchObject({ status: "pending", paymentStatus: "unpaid" });

    await expect(
      adapter.confirmation?.(
        "hotel-alpenrose",
        { bookingReference: "B-CARD952", confirmationToken: lookup.confirmationToken },
        {
          operation: "booking-confirmation",
          requestId: "req-card-expired-952",
          correlationId: "corr-card-expired-952",
          idempotencyKey: "idem-card-expired-952",
          fingerprint: "6".repeat(64),
          occurredAt: new Date("2026-09-03T09:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("Booking confirmation link has expired");

    const app = buildApp({
      logger: false,
      publicHotelProfileRepository: createProfileRepository(legacyHotel, {}),
      bookingWebCheckoutAdapter: adapter,
      bookingWebPublicNow: () => new Date("2026-09-02T10:00:00.000Z"),
    });
    const missing = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        payload: { bookingReference: "VAY-WRONG", guestEmail: "guest@example.test" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
        payload: { bookingReference: "B-CARD952", guestEmail: "wrong@example.test" },
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/other-hotel/bookings/lookup",
        payload: { bookingReference: "B-CARD952", guestEmail: "guest@example.test" },
      }),
    ]);
    expect(missing.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(new Set(missing.map((response) => response.body))).toEqual(new Set([missing[0].body]));
    await app.close();
  });

  it("reports actionable parity mismatches by fixture case and field", () => {
    const mismatches = compareCalendarParity("calendar-unavailable-dates", legacyUnavailableDates, {
      calendar: {
        unavailableDates: [],
        minStayByArrival: {},
        maxStayByArrival: {},
      },
    });

    expect(formatParityMismatches(mismatches)).toContain(
      "calendar-unavailable-dates: calendar.unavailableDates",
    );
  });

  it("documents accepted intentional differences from legacy bootstrap payloads", () => {
    expect(ACCEPTED_BOOTSTRAP_PARITY_DIFFERENCES).toEqual([
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        legacyField: expect.any(String),
        targetField: expect.any(String),
        reason: expect.any(String),
      }),
    ]);
  });
});

function buildParityApp(config: {
  hotel: LegacyHotelResponse;
  rooms: LegacyRoomResponse[];
  unavailableDates: LegacyUnavailableDatesResponse;
  domainResolutionSource?: "legacy" | "target";
  slugAliases?: Record<string, LegacyHotelResponse>;
}): ReturnType<typeof buildApp> {
  const profileRepository = createProfileRepository(config.hotel, config.slugAliases ?? {});
  const quoteRepository = createQuoteRepository(profileRepository, config.rooms);
  const calendarRepository = createCalendarRepository(config.unavailableDates);

  return buildApp({
    logger: false,
    publicHotelProfileRepository: profileRepository,
    publicHotelQuoteRepository: quoteRepository,
    bookingWebCalendarRepository: calendarRepository,
    bookingDomainResolutionSource: config.domainResolutionSource,
    bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
  });
}

class InMemoryAffiliateRepository implements BookingWebAffiliateRepository {
  private readonly affiliates = new Map<
    string,
    {
      id: string;
      referralCode: string;
      email: string;
      slug: string;
      stripeAccountId?: string;
      onboardingUrl?: string;
    }
  >();

  get identityCount(): number {
    return this.affiliates.size;
  }

  get stripeAccountCount(): number {
    return Array.from(this.affiliates.values()).filter((affiliate) => affiliate.stripeAccountId)
      .length;
  }

  async checkEmail(slug: string, email: string): Promise<{ exists: boolean }> {
    return { exists: this.affiliates.has(this.key(slug, email)) };
  }

  async register(
    slug: string,
    request: BookingWebAffiliateRegistrationRequest,
  ): Promise<{ id: string; referralCode: string }> {
    const key = this.key(slug, request.email ?? "");
    const existing = this.affiliates.get(key);
    if (existing) {
      return { id: existing.id, referralCode: existing.referralCode };
    }

    const id = `aff_${Buffer.from(key).toString("hex").slice(0, 20)}`;
    const referralCode = `VA${Buffer.from(key).toString("hex").slice(0, 8).toUpperCase()}`;
    this.affiliates.set(key, {
      id,
      referralCode,
      email: request.email?.toLowerCase() ?? "",
      slug: slug.toLowerCase(),
    });
    return { id, referralCode };
  }

  async createStripeConnectLink(
    slug: string,
    affiliateId: string,
    request: BookingWebAffiliateStripeConnectRequest,
  ): Promise<{ onboardingUrl: string }> {
    const email = request.email?.toLowerCase() ?? "";
    const affiliate = Array.from(this.affiliates.values()).find(
      (item) => item.id === affiliateId && item.email === email && item.slug === slug.toLowerCase(),
    );
    if (!affiliate || !email) {
      throw Object.assign(new Error("Affiliate not found for this hotel and email."), {
        statusCode: 404,
      });
    }
    throw Object.assign(new Error("Stripe Connect onboarding is not configured."), {
      statusCode: 503,
    });
  }

  private key(slug: string, email: string): string {
    return `${slug.toLowerCase()}:${email.toLowerCase()}`;
  }
}

function changeRequestPayload(): Record<string, unknown> {
  return {
    guestEmail: "guest@example.com",
    checkIn: "2026-09-13",
    checkOut: "2026-09-16",
    addonIds: ["addon_breakfast"],
    addonQuantities: { addon_breakfast: 2 },
    addonDates: { addon_breakfast: ["2026-09-14"] },
  };
}

function createProfileRepository(
  hotel: LegacyHotelResponse,
  slugAliases: Record<string, LegacyHotelResponse>,
): PublicHotelProfileRepository {
  return {
    async findProfileBySlug(slug) {
      const source = slug === hotel.slug ? hotel : slugAliases[slug];
      return source
        ? toPublicHotelProfileProjection(toProfileRow(source), "2026-06-06T11:00:00.000Z", {
            bookingHostBase: "booking.localhost",
          })
        : null;
    },
    async findProfileByCustomDomain(domain) {
      const customDomain = hotel.customDomainUrl?.replace(/^https:\/\//, "");
      return customDomain === domain
        ? toPublicHotelProfileProjection(toProfileRow(hotel), "2026-06-06T11:00:00.000Z", {
            bookingHostBase: "booking.localhost",
          })
        : null;
    },
  };
}

function createQuoteRepository(
  profileRepository: PublicHotelProfileRepository,
  rooms: LegacyRoomResponse[],
): PublicHotelQuoteRepository {
  return {
    async findQuoteBySlug(slug, query) {
      const profile = await profileRepository.findProfileBySlug(slug);
      if (!profile) return null;
      return parityQuoteProjection(profile.hotel, rooms, query);
    },
  };
}

function createCalendarRepository(
  unavailableDates: LegacyUnavailableDatesResponse,
): BookingWebCalendarRepository {
  return {
    async findCalendarByHotel(hotel, query): Promise<BookingWebCalendarProjection> {
      return {
        contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
        generatedAt: "2026-06-06T11:00:00.000Z",
        publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
        request: {
          hotelSlug: hotel.slug,
          start: query.start ?? "",
          end: query.end ?? "",
        },
        calendar: {
          unavailableDates: unavailableDates.dates,
          minStayByArrival: unavailableDates.min_stay_by_arrival,
          maxStayByArrival: unavailableDates.max_stay_by_arrival,
        },
        freshness: {
          status: "fresh",
          generatedAt: "2026-06-06T11:00:00.000Z",
          sources: [
            {
              owner: "pms",
              lastUpdatedAt: "2026-06-06T11:00:00.000Z",
              status: "fresh",
            },
            {
              owner: "distribution",
              lastUpdatedAt: "2026-06-06T11:00:00.000Z",
              status: "fresh",
            },
          ],
        },
        dataSources: ["pms", "distribution"],
      };
    },
  };
}

function parityQuoteProjection(
  hotel: PublicBookabilityHotelProfile,
  rooms: LegacyRoomResponse[],
  query: PublicHotelQuoteQuery,
): PublicBookabilityQuoteProjection {
  const generatedAt = "2026-06-06T11:00:00.000Z";
  const request = {
    hotelSlug: hotel.slug,
    checkIn: query.check_in ?? "2026-09-12",
    checkOut: query.check_out ?? "2026-09-15",
    nights: nightsBetween(query.check_in ?? "2026-09-12", query.check_out ?? "2026-09-15"),
    adults: Number(query.adults ?? 2),
    children: Number(query.children ?? 0),
    rooms: Number(query.rooms ?? 1),
    currency: query.currency ?? hotel.defaultCurrency,
    locale: query.locale ?? hotel.defaultLocale,
    promoCode: query.promo_code ?? null,
    referralCode: query.referral_code ?? null,
  };

  return buildPublicBookabilityQuoteProjection(generatedAt, {
    request,
    hotelCatalog: { lastUpdatedAt: generatedAt },
    booking: {
      lastUpdatedAt: generatedAt,
      offerPolicies: rooms.flatMap((room) => [
        {
          roomTypeId: room.id,
          ratePlanId: "flexible",
          cancellation: room.cancellationPolicy,
          deposit: "No deposit required.",
        },
        {
          roomTypeId: room.id,
          ratePlanId: "nonrefundable",
          cancellation: room.nonRefundableCancellationPolicy ?? room.cancellationPolicy,
          deposit: "50% deposit required.",
        },
      ]),
    },
    pms: {
      availabilityReady: true,
      lastUpdatedAt: generatedAt,
      offers: rooms.flatMap((room) => parityOffers(room)),
    },
    finance: {
      lastUpdatedAt: generatedAt,
      publicPaymentOptions: ["card", "pay_at_property", "bank_transfer", "paypal"],
      supportedCurrencies: hotel.supportedCurrencies,
    },
    bookingWeb: {
      offerBookingUrlBase: `${hotel.bookingBaseUrl}/${request.locale}/book`,
    },
    quote: {
      quoteId: "quote_parity_001",
      quoteHash: "sha256:parity",
      expiresAt: "2026-06-06T11:15:00.000Z",
      priceGuarantee: "expires_at",
    },
  });
}

function parityOffers(room: LegacyRoomResponse): PublicBookabilityAvailabilityOfferInput[] {
  const flexibleTotal = sum(room.nightlyRates);
  const nonRefundableTotal = sum(room.nonRefundableNightlyRates ?? []);
  const flexible = {
    offerId: `${room.id}:flexible`,
    roomTypeId: room.id,
    ratePlanId: "flexible",
    name: room.name,
    occupancy: {
      maxAdults: room.maxAdults,
      maxChildren: room.maxChildren,
    },
    availableRooms: room.remainingRooms,
    refundable: true,
    paymentOptions: parityPaymentOptions(room.ratePaymentMethods?.flexible, [
      "card",
      "pay_at_property",
    ]),
    totals: {
      currency: room.currency,
      roomTotal: flexibleTotal,
      taxesAndFees: 0,
      discounts: 0,
      grandTotal: flexibleTotal,
    },
  };

  if (!room.nonRefundableNightlyRates || room.nonRefundableNightlyRates.length === 0) {
    return [flexible];
  }

  return [
    flexible,
    {
      offerId: `${room.id}:nonrefundable`,
      roomTypeId: room.id,
      ratePlanId: "nonrefundable",
      name: room.name,
      occupancy: {
        maxAdults: room.maxAdults,
        maxChildren: room.maxChildren,
      },
      availableRooms: room.remainingRooms,
      refundable: false,
      paymentOptions: parityPaymentOptions(room.ratePaymentMethods?.nonrefundable, ["card"]),
      totals: {
        currency: room.currency,
        roomTotal: nonRefundableTotal,
        taxesAndFees: 0,
        discounts: 0,
        grandTotal: nonRefundableTotal,
      },
    },
  ];
}

function parityPaymentOptions(
  values: string[] | undefined,
  fallback: NonNullable<PublicBookabilityAvailabilityOfferInput["paymentOptions"]>,
): PublicBookabilityAvailabilityOfferInput["paymentOptions"] {
  const allowed = new Set(["card", "pay_at_property", "bank_transfer", "paypal"]);
  const options = (values ?? fallback).filter((value) => allowed.has(value));
  return options as PublicBookabilityAvailabilityOfferInput["paymentOptions"];
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86400000,
    ),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toProfileRow(hotel: LegacyHotelResponse): BookingHotelProfileRow {
  return {
    id: hotel.id,
    name: hotel.name,
    slug: hotel.slug,
    description: hotel.description,
    location: hotel.location,
    country: hotel.country,
    currency: hotel.currency,
    supported_currencies: hotel.supportedCurrencies,
    hero_image: hotel.heroImage,
    images: hotel.images,
    amenities: hotel.amenities,
    check_in_time: hotel.checkInTime,
    check_out_time: hotel.checkOutTime,
    timezone: hotel.timezone,
    default_language: hotel.defaultLanguage,
    supported_languages: hotel.supportedLanguages,
    custom_domain: hotel.customDomainUrl?.replace(/^https:\/\//, "") ?? null,
    instant_book: hotel.instantBook,
    online_card_payment: true,
    pay_at_property_enabled: true,
    free_cancellation_days: 7,
    terms_text: "Public terms",
    cancellation_policy_text: "Free cancellation until 7 days before arrival.",
    updated_at: "2026-06-06T10:00:00.000Z",
  };
}

function compareHotelBootstrapParity(
  caseId: string,
  legacy: LegacyHotelResponse,
  target: unknown,
): ParityMismatch[] {
  const actual = target as { hotel?: Record<string, unknown> };
  return compareFields(caseId, [
    ["hotel.slug", legacy.slug, actual.hotel?.["slug"]],
    ["hotel.name", legacy.name, actual.hotel?.["name"]],
    ["hotel.canonicalUrl", legacy.canonicalUrl, actual.hotel?.["canonicalUrl"]],
    ["hotel.bookingBaseUrl", legacy.bookingBaseUrl, actual.hotel?.["bookingBaseUrl"]],
    ["hotel.defaultLocale", legacy.defaultLanguage, actual.hotel?.["defaultLocale"]],
    ["hotel.defaultCurrency", legacy.currency, actual.hotel?.["defaultCurrency"]],
    ["hotel.supportedLocales", legacy.supportedLanguages, actual.hotel?.["supportedLocales"]],
    [
      "hotel.supportedCurrencies",
      legacy.supportedCurrencies,
      actual.hotel?.["supportedCurrencies"],
    ],
    [
      "hotel.policies.checkInFrom",
      legacy.checkInTime,
      nested(actual, "hotel.policies.checkInFrom"),
    ],
    [
      "hotel.policies.checkOutUntil",
      legacy.checkOutTime,
      nested(actual, "hotel.policies.checkOutUntil"),
    ],
  ]);
}

function compareHostParity(
  caseId: string,
  legacy: LegacyHotelResponse,
  target: unknown,
): ParityMismatch[] {
  const actual = target as Record<string, unknown>;
  return compareFields(caseId, [
    ["slug", legacy.slug, actual["slug"]],
    ["canonicalUrl", legacy.canonicalUrl, actual["canonicalUrl"]],
    ["bookingBaseUrl", legacy.bookingBaseUrl, actual["bookingBaseUrl"]],
    ["customDomainUrl", legacy.customDomainUrl, actual["customDomainUrl"]],
    ["shouldRedirect", false, actual["shouldRedirect"]],
    ["redirectUrl", null, actual["redirectUrl"]],
  ]);
}

function compareCanonicalRedirectParity(caseId: string, target: unknown): ParityMismatch[] {
  const actual = target as Record<string, unknown>;
  return compareFields(caseId, [
    ["slug", "alpenrose-resort", actual["slug"]],
    ["shouldRedirect", true, actual["shouldRedirect"]],
    ["redirectStatus", 308, actual["redirectStatus"]],
    ["redirectUrl", "https://alpenrose-resort.booking.localhost/de", actual["redirectUrl"]],
  ]);
}

function compareOffersParity(
  caseId: string,
  legacy: LegacyRoomResponse[],
  target: unknown,
): ParityMismatch[] {
  const firstLegacyRoom = legacy[0]!;
  const actual = target as {
    status?: unknown;
    request?: Record<string, unknown>;
    quote?: { offers?: Array<Record<string, unknown>> };
  };
  const firstOffer = actual.quote?.offers?.[0];
  const secondOffer = actual.quote?.offers?.[1];
  return compareFields(caseId, [
    ["status", "bookable", actual.status],
    ["request.currency", firstLegacyRoom.currency, actual.request?.["currency"]],
    ["request.locale", "de", actual.request?.["locale"]],
    ["quote.offers.length", 2, actual.quote?.offers?.length],
    ["quote.offers[0].roomTypeId", firstLegacyRoom.id, firstOffer?.["roomTypeId"]],
    ["quote.offers[0].name", firstLegacyRoom.name, firstOffer?.["name"]],
    [
      "quote.offers[0].availableRooms",
      firstLegacyRoom.remainingRooms,
      firstOffer?.["availableRooms"],
    ],
    ["quote.offers[0].totals.roomTotal", 660, nested(firstOffer, "totals.roomTotal")],
    ["quote.offers[0].paymentOptions", ["card", "pay_at_property"], firstOffer?.["paymentOptions"]],
    [
      "quote.offers[0].policies.deposit",
      "No deposit required.",
      nested(firstOffer, "policies.deposit"),
    ],
    ["quote.offers[1].ratePlanId", "nonrefundable", secondOffer?.["ratePlanId"]],
    ["quote.offers[1].totals.roomTotal", 594, nested(secondOffer, "totals.roomTotal")],
    ["quote.offers[1].paymentOptions", ["card", "bank_transfer"], secondOffer?.["paymentOptions"]],
    [
      "quote.offers[1].policies.deposit",
      "50% deposit required.",
      nested(secondOffer, "policies.deposit"),
    ],
  ]);
}

function compareSoldOutParity(caseId: string, target: unknown): ParityMismatch[] {
  const actual = target as {
    status?: unknown;
    unavailableReasons?: Array<Record<string, unknown>>;
    quote?: unknown;
  };
  return compareFields(caseId, [
    ["status", "unavailable", actual.status],
    ["unavailableReasons[0].code", "sold_out", actual.unavailableReasons?.[0]?.["code"]],
    ["quote", undefined, actual.quote],
  ]);
}

function compareCalendarParity(
  caseId: string,
  legacy: LegacyUnavailableDatesResponse,
  target: unknown,
): ParityMismatch[] {
  return compareFields(caseId, [
    ["calendar.unavailableDates", legacy.dates, nested(target, "calendar.unavailableDates")],
    [
      "calendar.minStayByArrival",
      legacy.min_stay_by_arrival,
      nested(target, "calendar.minStayByArrival"),
    ],
    [
      "calendar.maxStayByArrival",
      legacy.max_stay_by_arrival,
      nested(target, "calendar.maxStayByArrival"),
    ],
  ]);
}

function compareFields(
  caseId: string,
  fields: Array<[field: string, expected: unknown, actual: unknown]>,
): ParityMismatch[] {
  return fields
    .filter(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual))
    .map(([field, expected, actual]) => ({ caseId, field, expected, actual }));
}

function formatParityMismatches(mismatches: ParityMismatch[]): string {
  return mismatches
    .map(
      (mismatch) =>
        `${mismatch.caseId}: ${mismatch.field} expected ${JSON.stringify(
          mismatch.expected,
        )}, received ${JSON.stringify(mismatch.actual)}`,
    )
    .join("\n");
}

function nested(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}
const nights = (...amounts: string[]) =>
  (amounts.length === 1 ? [amounts[0]!, amounts[0]!, amounts[0]!] : amounts).map(
    (grossRoomAmount, day) => ({
      stayDate: `2026-09-${day + 12}`,
      grossRoomAmount,
    }),
  );
