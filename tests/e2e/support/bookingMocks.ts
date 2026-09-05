import type { Page } from "@playwright/test";

export const SEEDED_BOOKING_SLUG = "hotel-alpenrose";

const hotel = {
  id: "hotel-alpenrose-id",
  name: "Hotel Alpenrose",
  slug: SEEDED_BOOKING_SLUG,
  canonicalUrl: "http://hotel-alpenrose.booking.localhost:3002/en",
  bookingBaseUrl: "http://hotel-alpenrose.booking.localhost:3002",
  customDomainUrl: null,
  description: "A warm alpine retreat for direct booking guests.",
  location: "Zermatt",
  country: "Switzerland",
  starRating: 4,
  currency: "EUR",
  supportedCurrencies: ["EUR", "USD"],
  heroImage: "/vayada-logo.png",
  images: ["/vayada-logo.png"],
  amenities: ["Free WiFi", "Spa", "Breakfast"],
  checkInTime: "15:00",
  checkOutTime: "11:00",
  timezone: "Europe/Zurich",
  contact: {
    address: "Alpenstrasse 1, Zermatt",
    phone: "+41 44 000 00 00",
    email: "stay@alpenrose.test",
  },
  bookingFilters: ["includeBreakfast", "freeCancellation"],
  customFilters: {},
  filterRooms: {},
  branding: {
    primaryColor: "#2563eb",
    accentColor: "#eff6ff",
    fontPairing: "modern-minimalist",
    logoUrl: "/vayada-logo.png",
  },
  defaultLanguage: "en",
  supportedLanguages: ["en", "de", "nl"],
  referAGuestEnabled: true,
  instantBook: true,
  mapViewEnabled: false,
};

const publicHotelProfile = {
  contractVersion: "public-bookability.v1",
  generatedAt: "2026-06-06T11:00:00.000Z",
  publicVisibility: "public_safe",
  hotel: {
    propertyId: hotel.id,
    slug: hotel.slug,
    name: hotel.name,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    timezone: hotel.timezone,
    defaultLocale: hotel.defaultLanguage,
    supportedLocales: hotel.supportedLanguages,
    defaultCurrency: hotel.currency,
    supportedCurrencies: hotel.supportedCurrencies,
    location: {
      country: hotel.country,
      city: hotel.location,
      region: null,
      latitude: null,
      longitude: null,
    },
    summary: hotel.description,
    images: hotel.images.map((url) => ({ url, alt: hotel.name })),
    amenities: hotel.amenities,
    publicContacts: [
      { type: "email", value: hotel.contact.email },
      { type: "phone", value: hotel.contact.phone },
    ],
    policies: {
      checkInFrom: hotel.checkInTime,
      checkOutUntil: hotel.checkOutTime,
      cancellationSummary: null,
      termsUrl: null,
    },
    capabilities: {
      instantBook: hotel.instantBook,
      onlinePayment: true,
      payAtProperty: true,
      promoCodes: true,
      referralCodes: hotel.referAGuestEnabled,
      bookingDeepLinks: true,
    },
    supportedQuoteParameters: {
      minRooms: 1,
      maxRooms: 4,
      minAdults: 1,
      maxAdults: 8,
      childrenSupported: true,
      adultAgeThreshold: 18,
      supportedCurrencies: hotel.supportedCurrencies,
      supportedLocales: hotel.supportedLanguages,
    },
    trust: {
      profileComplete: true,
      profileVerified: true,
      domainVerified: true,
      bookabilityStatus: "bookable",
      reasonCodes: [],
    },
  },
  freshness: {
    status: "fresh",
    generatedAt: "2026-06-06T11:00:00.000Z",
    sources: [],
  },
  dataSources: ["hotel_catalog", "booking", "pms", "distribution"],
};

const rooms = [
  {
    id: "alpine-suite",
    name: "Alpine Suite",
    category: "Suite",
    description: "A bright suite with mountain views and a private balcony.",
    shortDescription: "Mountain-view suite with balcony.",
    maxOccupancy: 3,
    maxAdults: 3,
    maxChildren: 1,
    size: 42,
    baseRate: 240,
    nonRefundableRate: 210,
    currency: "EUR",
    amenities: [
      "Wi-Fi",
      "Air conditioning",
      "Flat-screen TV",
      "Balcony",
      "Kitchen",
      "Non-smoking",
      "Safe",
      "Coffee machine",
      "Minibar",
      "Laptop-friendly workspace",
    ],
    images: ["/vayada-logo.png"],
    bedType: "King bed",
    remainingRooms: 2,
    features: ["Free Cancellation", "Include Breakfast"],
    benefits: ["Best direct rate"],
    flexibleRateEnabled: true,
    cancellationPolicy: "free_until_7_days",
    flexibleCancellationType: "free",
    originalRate: null,
    lastMinuteDiscountPercent: null,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    locationMarkers: [],
  },
  {
    id: "garden-room",
    name: "Garden Room",
    category: "Double",
    description: "A quiet double room facing the garden.",
    shortDescription: "Quiet garden-facing double room.",
    maxOccupancy: 2,
    maxAdults: 2,
    maxChildren: 1,
    size: 24,
    baseRate: 160,
    nonRefundableRate: null,
    currency: "EUR",
    amenities: ["Wi-Fi"],
    images: ["/vayada-logo.png"],
    bedType: "Queen bed",
    remainingRooms: 0,
    features: [],
    benefits: [],
    flexibleRateEnabled: true,
    cancellationPolicy: "free_until_7_days",
    flexibleCancellationType: "free",
    originalRate: null,
    lastMinuteDiscountPercent: null,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    locationMarkers: [],
  },
];

const addons = [
  {
    id: "airport-transfer",
    name: "Airport Transfer",
    description: "Private arrival transfer to the hotel.",
    price: 45,
    currency: "EUR",
    category: "transport",
    image: "/vayada-logo.png",
    images: ["/vayada-logo.png"],
    duration: "45 minutes",
    perPerson: false,
    perNight: false,
    location: "Luggage claim",
    maxGuests: "4",
    highlights: ["Private pickup", "Flight tracking"],
    includedItems: ["Driver", "Luggage assistance"],
  },
];

const publicOffers = {
  contractVersion: "public-bookability.v1",
  generatedAt: "2026-06-06T11:00:00.000Z",
  publicVisibility: "public_safe",
  request: {
    hotelSlug: SEEDED_BOOKING_SLUG,
    checkIn: "2026-09-12",
    checkOut: "2026-09-15",
    nights: 3,
    adults: 2,
    children: 0,
    rooms: 1,
    currency: "EUR",
    locale: "en",
    promoCode: null,
    referralCode: null,
  },
  status: "bookable",
  unavailableReasons: [],
  quote: {
    quoteId: "quote_alpenrose_001",
    quoteHash: "sha256:booking-web-smoke",
    expiresAt: "2026-09-12T12:00:00.000Z",
    priceGuarantee: "instant",
    offers: [
      {
        offerId: "alpine-suite_flexible",
        roomTypeId: "alpine-suite",
        ratePlanId: "flexible",
        name: "Alpine Suite",
        occupancy: {
          maxAdults: 3,
          maxChildren: 1,
        },
        availableRooms: 2,
        refundable: true,
        mealPlan: "Breakfast",
        amenities: rooms[0].amenities,
        paymentOptions: ["card", "pay_at_property"],
        totals: {
          currency: "EUR",
          roomTotal: 720,
          taxesAndFees: 0,
          discounts: 0,
          grandTotal: 720,
        },
        policies: {
          cancellation: "free_until_7_days",
          deposit: "No deposit required",
        },
        bookingUrl:
          "http://hotel-alpenrose.booking.localhost:3002/en/book?room_type=alpine-suite&rate_plan=flexible&quote_id=quote_alpenrose_001",
      },
      {
        offerId: "alpine-suite_nonrefundable",
        roomTypeId: "alpine-suite",
        ratePlanId: "nonrefundable",
        name: "Alpine Suite - Non-refundable",
        occupancy: {
          maxAdults: 3,
          maxChildren: 1,
        },
        availableRooms: 2,
        refundable: false,
        mealPlan: "Breakfast",
        amenities: rooms[0].amenities,
        paymentOptions: ["card"],
        totals: {
          currency: "EUR",
          roomTotal: 630,
          taxesAndFees: 0,
          discounts: 0,
          grandTotal: 630,
        },
        policies: {
          cancellation: "Non-refundable from booking",
          deposit: "No deposit required",
        },
        bookingUrl:
          "http://hotel-alpenrose.booking.localhost:3002/en/book?room_type=alpine-suite&rate_plan=nonrefundable&quote_id=quote_alpenrose_001",
      },
      {
        offerId: "garden-room_flexible",
        roomTypeId: "garden-room",
        ratePlanId: "flexible",
        name: "Garden Room",
        occupancy: {
          maxAdults: 2,
          maxChildren: 1,
        },
        availableRooms: 0,
        refundable: true,
        mealPlan: null,
        amenities: rooms[1].amenities,
        paymentOptions: ["card", "pay_at_property"],
        totals: {
          currency: "EUR",
          roomTotal: 480,
          taxesAndFees: 0,
          discounts: 0,
          grandTotal: 480,
        },
        policies: {
          cancellation: "free_until_7_days",
          deposit: "No deposit required",
        },
        bookingUrl:
          "http://hotel-alpenrose.booking.localhost:3002/en/book?room_type=garden-room&rate_plan=flexible&quote_id=quote_alpenrose_001",
      },
    ],
  },
  freshness: {
    status: "fresh",
    generatedAt: "2026-06-06T11:00:00.000Z",
    sources: [],
  },
  dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
};

type MockBookingApisOptions = {
  supportedQuoteParameters?: Partial<typeof publicHotelProfile.hotel.supportedQuoteParameters>;
  supportedLocales?: string[];
  supportedCurrencies?: string[];
  headerLogoUrl?: string;
  headerSettings?: {
    showContactButton: boolean;
    showReferAGuestButton: boolean;
    showLanguageSelector: boolean;
    showCurrencySelector: boolean;
  };
  gardenAmenities?: string[];
  publicContacts?: typeof publicHotelProfile.hotel.publicContacts;
};

export async function mockBookingApis(page: Page, options: MockBookingApisOptions = {}) {
  const gardenAmenities = options.gardenAmenities;
  const profile = {
    ...publicHotelProfile,
    hotel: {
      ...publicHotelProfile.hotel,
      ...(options.headerLogoUrl || options.headerSettings
        ? {
            branding: {
              logoUrl: options.headerLogoUrl ?? null,
              showContactButton: options.headerSettings?.showContactButton ?? true,
              showReferAGuestButton: options.headerSettings?.showReferAGuestButton ?? true,
              showLanguageSelector: options.headerSettings?.showLanguageSelector ?? true,
              showCurrencySelector: options.headerSettings?.showCurrencySelector ?? true,
              heroImage: null,
              heroHeading: null,
              heroSubtext: null,
              primaryColor: null,
              fontPairing: null,
            },
          }
        : {}),
      publicContacts: options.publicContacts ?? publicHotelProfile.hotel.publicContacts,
      supportedLocales: options.supportedLocales ?? publicHotelProfile.hotel.supportedLocales,
      supportedCurrencies:
        options.supportedCurrencies ?? publicHotelProfile.hotel.supportedCurrencies,
      supportedQuoteParameters: {
        ...publicHotelProfile.hotel.supportedQuoteParameters,
        ...options.supportedQuoteParameters,
      },
    },
  };
  const offersResponse =
    gardenAmenities === undefined
      ? publicOffers
      : {
          ...publicOffers,
          quote: {
            ...publicOffers.quote,
            offers: publicOffers.quote.offers.map((offer) =>
              offer.roomTypeId === "garden-room" ? { ...offer, amenities: gardenAmenities } : offer,
            ),
          },
        };

  await page.route("**/api/events", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/booking-web/events", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route(
    new RegExp(`/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}(?:\\\\?.*)?$`),
    async (route) => {
      await route.fulfill({ json: profile });
    },
  );

  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/attribution/clicks`,
    async (route) => {
      await route.fulfill({ status: 204, body: "" });
    },
  );

  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/offers**`, async (route) => {
    await route.fulfill({ json: offersResponse });
  });

  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/calendar**`, async (route) => {
    await route.fulfill({
      json: {
        calendar: {
          unavailableDates: [],
          minStayByArrival: {},
          maxStayByArrival: {},
        },
      },
    });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}`, async (route) => {
    await route.fulfill({ json: hotel });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/rooms**`, async (route) => {
    await route.fulfill({ json: rooms });
  });

  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, async (route) => {
    await route.fulfill({ json: { addons, showAddonsStep: true, payAtPropertyEnabled: true,
      onlineCardPayment: false, freeCancellationDays: 7, phoneRequired: true } });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/addons`, async (route) => {
    await route.fulfill({ json: addons });
  });

  await page.route("**/api/exchange-rates**", async (route) => {
    await route.fulfill({ json: { base: "EUR", rates: { EUR: 1, USD: 1.1 } } });
  });

  await page.route(`**/api/hotels/${SEEDED_BOOKING_SLUG}/unavailable-dates**`, async (route) => {
    await route.fulfill({ json: { dates: [], min_stay_by_arrival: {} } });
  });
}
