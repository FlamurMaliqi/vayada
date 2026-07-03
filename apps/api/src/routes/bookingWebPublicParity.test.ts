import {
  buildPublicBookabilityQuoteProjection,
  findForbiddenPublicBookabilityKeys,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityAvailabilityOfferInput,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityQuoteProjection,
} from "@vayada/domain-distribution";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE } from "../jobs/bookingEmails.js";
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
  recordTargetCheckoutCommand,
  resolveTargetCheckoutAmountSnapshot,
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
    legacyField: "HotelResponse.contact/socialLinks/branding",
    targetField: "omitted",
    reason:
      "These fields are not required by the read-only bootstrap adapters and remain outside this public-safe parity slice.",
  },
] as const;

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
        hotelSlug: "hotel-alpenrose",
        eventType: "page_visit",
        eventId: "event_page_visit_001",
        sessionId: "sid_123",
        metadata: { locale: "de" },
      },
    ]);
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
    ]).toEqual([404, 404, 404, 404, 404, 404, 404]);
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
    expect(confirm.statusCode).toBe(404);
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
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/VAY-TARGET-1/confirm-authorization",
      }),
      app.inject({
        method: "GET",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/status?reference=VAY-TARGET-1&email=guest%40example.com",
      }),
      app.inject({
        method: "POST",
        url: "/api/booking-web/hotels/hotel-alpenrose/bookings/lookup",
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
                publicPolicy: { deposit: "50% deposit required." },
                paymentOptions: ["pay_at_property", "bank_transfer"],
                availableRooms: 2,
                roomTotal: "561.60",
                taxesAndFees: "0.00",
                discounts: "0.00",
                currency: "EUR",
                generatedAt: "2026-06-25T10:00:00.000Z",
                sourceFreshness: { pms: { status: "fresh" } },
              },
            ],
          };
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
      roomTotal: 561.6,
      totalAmount: 561.6,
      depositRequired: true,
      depositPercentage: 50,
      depositAmount: 280.8,
      balanceAmount: 280.8,
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
    expect(calls.some((call) => call.text.includes("platform.product_audit_events"))).toBe(true);
    await adapter.close?.();
    expect(ended).toBe(0);
  });

  it("exposes target checkout phone required settings", async () => {
    const pool = {
      async query(text: string) {
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
                acceptedMethods: ["pay_at_property"],
                depositPolicy: {},
                refundPolicy: {},
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
      pool: pool as never,
    });

    await expect(adapter.getCheckoutConfig("hotel-alpenrose")).resolves.toMatchObject({
      phoneRequired: false,
    });
  });

  it("validates target booking phone against phone required settings", async () => {
    const createAdapter = (phoneRequired: boolean) => {
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
          if (text.includes("FROM booking.quote_sessions")) {
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
                    paymentMethod: "pay_at_property",
                  },
                  totals: { totalAmount: "100.00", balanceAmount: "100.00" },
                  policySnapshot: {},
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
                  defaultCurrency: "EUR",
                  phoneRequired,
                  acceptedMethods: ["pay_at_property"],
                  depositPolicy: {},
                  refundPolicy: {},
                },
              ],
            };
          }
          if (text.includes("SELECT * FROM booking_row")) {
            return {
              rows: [
                {
                  guestBookingId: "3c6a35e2-1436-455a-bf05-96d2f4559421",
                  propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  publicReference: "B-OPTIONAL",
                  lifecycleStatus: "confirmed",
                  paymentStatus: "unpaid",
                  checkIn: "2026-09-12",
                  checkOut: "2026-09-15",
                  adults: 2,
                  children: 0,
                  roomCount: 1,
                  currency: "EUR",
                  totalAmount: "100.00",
                  balanceAmount: "100.00",
                  bookingMetadata: {},
                  createdAt: "2026-06-25T12:00:00.000Z",
                },
              ],
            };
          }
          return { rows: [] };
        },
        async end() {},
      };
      return {
        adapter: createTargetBookingWebCheckoutAdapter({
          connectionString: "postgres://unused",
          pool: pool as never,
        }),
        calls,
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
    expect(requiredPhone.calls.some((text) => text.includes("platform.idempotency_keys"))).toBe(
      false,
    );

    const optionalPhone = createAdapter(false);
    await expect(
      optionalPhone.adapter.createBooking("hotel-alpenrose", request, context),
    ).resolves.toMatchObject({
      bookingReference: "B-OPTIONAL",
    });
    expect(optionalPhone.calls.some((text) => text.includes("platform.idempotency_keys"))).toBe(
      true,
    );
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
          balanceAmount: 280800,
        },
        quote,
      ),
    ).toEqual({
      totalAmount: "561600.00",
      balanceAmount: "280800.00",
    });

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

  it("enqueues reserved-pending-payment email for target bank-transfer pending checkout", async () => {
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
        if (text.includes("FROM platform.idempotency_keys")) return { rows: [] };
        if (text.includes("INSERT INTO platform.idempotency_keys")) return { rows: [] };
        if (text.includes("FROM booking.quote_sessions")) {
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
                  paymentMethod: "bank_transfer",
                },
                totals: { totalAmount: "600.00", balanceAmount: "600.00" },
                policySnapshot: {},
                expiresAt: "2026-09-01T10:15:00.000Z",
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
                bookingMetadata: {},
                createdAt: "2026-09-01T10:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes('accepted_methods AS "acceptedMethods"')) {
          return {
            rows: [
              {
                acceptedMethods: ["bank_transfer"],
                depositPolicy: {
                  bankTransferInstructions:
                    "Account holder: Hotel Alpenrose GmbH\nIBAN: DE89370400440532013000",
                },
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
      pool: pool as never,
    });

    const result = await adapter.createBooking(
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
    );

    expect(result).toMatchObject({ bookingReference: "B-BANK951" });
    const emailJob = calls.find(
      (call) =>
        call.text.includes("INSERT INTO platform.jobs") &&
        call.values?.[2] === BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
    );
    expect(emailJob).toBeDefined();
    const payload = JSON.parse(String(emailJob?.values?.[8]));
    expect(payload).toMatchObject({
      to: "guest@example.test",
      template: "booking_reserved_pending_payment",
      bookingReference: "B-BANK951",
      paymentDeadlineAt: "2026-09-02T10:00:00.000Z",
      bankTransferDetails: "Account holder: Hotel Alpenrose GmbH\nIBAN: DE89370400440532013000",
    });
    expect(payload.text).toContain("We've reserved your room");
    expect(payload.text).toContain("Payment deadline: 2026-09-02T10:00:00.000Z");
    expect(payload.text).toContain("IBAN: DE89370400440532013000");
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
