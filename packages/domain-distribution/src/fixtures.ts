import {
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityProfileProjection,
  type PublicBookabilityQuoteProjection,
} from "./index.js";

export const PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS = [
  "bookable",
  "unavailable",
  "stale_availability",
  "missing_payment_readiness",
  "custom_domain",
  "renamed_property",
  "private_hotel",
] as const;

export type PublicBookabilityFixtureCaseId = (typeof PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS)[number];

export type PublicBookabilityFixtureCase = {
  caseId: PublicBookabilityFixtureCaseId;
  description: string;
  profile: PublicBookabilityProfileProjection;
  quote?: PublicBookabilityQuoteProjection;
};

type PublicBookabilityHotelProfileOverride = Omit<
  Partial<PublicBookabilityProfileProjection["hotel"]>,
  "capabilities" | "trust"
> & {
  capabilities?: Partial<PublicBookabilityProfileProjection["hotel"]["capabilities"]>;
  trust?: Partial<PublicBookabilityProfileProjection["hotel"]["trust"]>;
};

const generatedAt = "2026-06-06T11:00:00.000Z";
const sources: PublicBookabilityDataSourceOwner[] = [
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "distribution",
];

export const PUBLIC_BOOKABILITY_FIXTURES: PublicBookabilityFixtureCase[] = [
  {
    caseId: "bookable",
    description: "Complete profile with one live direct-booking offer.",
    profile: profileFixture(),
    quote: quoteFixture(),
  },
  {
    caseId: "unavailable",
    description: "Public profile is complete but the requested stay is sold out.",
    profile: profileFixture(),
    quote: quoteFixture({
      status: "unavailable",
      unavailableReasons: [
        { code: "sold_out", detail: "No public inventory for requested dates." },
      ],
      quote: undefined,
    }),
  },
  {
    caseId: "stale_availability",
    description: "PMS availability freshness is outside the public quote window.",
    profile: profileFixture({
      freshness: {
        status: "stale",
        generatedAt,
        sources: [
          freshness("hotel_catalog", "fresh"),
          freshness("booking", "fresh"),
          freshness("pms", "stale", "source_stale"),
          freshness("finance", "fresh"),
          freshness("distribution", "fresh"),
        ],
      },
    }),
    quote: quoteFixture({
      status: "stale",
      unavailableReasons: [{ code: "stale_data", detail: "pms availability is stale." }],
      quote: undefined,
    }),
  },
  {
    caseId: "missing_payment_readiness",
    description: "Hotel can be discovered but cannot start checkout until payment is configured.",
    profile: profileFixture({
      hotel: {
        capabilities: {
          onlinePayment: false,
          payAtProperty: false,
        },
        trust: {
          bookabilityStatus: "unavailable",
          reasonCodes: ["payment_disabled"],
        },
      },
    }),
    quote: quoteFixture({
      status: "unavailable",
      unavailableReasons: [{ code: "payment_disabled", detail: "No public payment method." }],
      quote: undefined,
    }),
  },
  {
    caseId: "custom_domain",
    description: "Verified custom domain is canonical for public pages and structured data.",
    profile: profileFixture({
      hotel: {
        canonicalUrl: "https://book.alpenrose.example/en",
        bookingBaseUrl: "https://book.alpenrose.example",
        customDomainUrl: "https://book.alpenrose.example",
        trust: {
          domainVerified: true,
        },
      },
    }),
  },
  {
    caseId: "renamed_property",
    description: "Canonical slug uses the renamed property while old slugs remain redirect inputs.",
    profile: profileFixture({
      hotel: {
        slug: "alpenrose-resort",
        name: "Alpenrose Resort",
        canonicalUrl: "https://alpenrose-resort.booking.localhost/en",
        bookingBaseUrl: "https://alpenrose-resort.booking.localhost",
      },
    }),
  },
  {
    caseId: "private_hotel",
    description:
      "Disabled or unpublished hotel must not appear in public sitemap, " +
      "must not emit indexable JSON-LD, and the quote API must return an " +
      "unavailable status with an 'unpublished' reason code.",
    profile: profileFixture({
      hotel: {
        trust: {
          profileComplete: false,
          profileVerified: false,
          domainVerified: false,
          bookabilityStatus: "unavailable",
          reasonCodes: ["unpublished"],
        },
      },
    }),
    quote: quoteFixture({
      status: "unavailable",
      unavailableReasons: [
        {
          code: "unpublished",
          detail: "Hotel is not published and cannot be booked publicly.",
        },
      ],
      quote: undefined,
    }),
  },
];

function profileFixture(
  overrides: {
    hotel?: PublicBookabilityHotelProfileOverride;
    freshness?: PublicBookabilityProfileProjection["freshness"];
  } = {},
): PublicBookabilityProfileProjection {
  const base: PublicBookabilityProfileProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    hotel: {
      propertyId: "prop_alpenrose",
      slug: "hotel-alpenrose",
      name: "Hotel Alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
      bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
      customDomainUrl: null,
      timezone: "Europe/Vienna",
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      location: {
        country: "AT",
        city: "Innsbruck",
        region: "Tyrol",
        latitude: 47.2692,
        longitude: 11.4041,
      },
      summary: "Independent alpine hotel near the old town.",
      images: [{ url: "https://cdn.vayada.example/hotels/alpenrose/front.jpg", alt: "Exterior" }],
      amenities: ["wifi", "breakfast", "parking"],
      publicContacts: [],
      policies: {
        checkInFrom: "15:00",
        checkOutUntil: "11:00",
        cancellationSummary: "Free cancellation until 7 days before arrival.",
        termsUrl: "https://hotel-alpenrose.booking.localhost/en/terms",
      },
      capabilities: {
        instantBook: true,
        onlinePayment: true,
        payAtProperty: true,
        promoCodes: true,
        referralCodes: true,
        bookingDeepLinks: true,
      },
      supportedQuoteParameters: {
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: 8,
        childrenSupported: true,
        adultAgeThreshold: 18,
        supportedCurrencies: ["EUR"],
        supportedLocales: ["en", "de"],
      },
      trust: {
        profileComplete: true,
        profileVerified: true,
        domainVerified: false,
        bookabilityStatus: "bookable",
        reasonCodes: [],
      },
    },
    freshness: {
      status: "fresh",
      generatedAt,
      sources: [
        freshness("hotel_catalog", "fresh"),
        freshness("booking", "fresh"),
        freshness("pms", "fresh"),
        freshness("finance", "fresh"),
        freshness("distribution", "fresh"),
      ],
    },
    dataSources: sources,
  };

  return {
    ...base,
    hotel: {
      ...base.hotel,
      ...overrides.hotel,
      capabilities: {
        ...base.hotel.capabilities,
        ...overrides.hotel?.capabilities,
      },
      trust: {
        ...base.hotel.trust,
        ...overrides.hotel?.trust,
      },
    },
    freshness: overrides.freshness ?? base.freshness,
  };
}

function quoteFixture(
  overrides: Partial<PublicBookabilityQuoteProjection> = {},
): PublicBookabilityQuoteProjection {
  const base: PublicBookabilityQuoteProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request: {
      hotelSlug: "hotel-alpenrose",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      nights: 3,
      adults: 2,
      children: 0,
      rooms: 1,
      currency: "EUR",
      locale: "en",
      promoCode: null,
      referralCode: "creator-anna",
    },
    status: "bookable",
    unavailableReasons: [],
    quote: {
      quoteId: "quote_alpenrose_001",
      quoteHash: "sha256:fixture",
      expiresAt: "2026-06-06T11:15:00.000Z",
      priceGuarantee: "expires_at",
      offers: [
        {
          offerId: "offer_deluxe_flexible",
          roomTypeId: "room_deluxe",
          ratePlanId: "rate_flexible_breakfast",
          name: "Deluxe Double Room",
          occupancy: { maxAdults: 2, maxChildren: 1 },
          availableRooms: 3,
          refundable: true,
          mealPlan: "breakfast",
          amenities: [],
          paymentOptions: ["card", "pay_at_property"],
          totals: {
            currency: "EUR",
            roomTotal: 540,
            taxesAndFees: 54,
            discounts: 0,
            grandTotal: 594,
          },
          policies: {
            cancellation: "Free cancellation until 7 days before arrival.",
            deposit: "No deposit required.",
          },
          bookingUrl:
            "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&room_type=room_deluxe&rate_plan=rate_flexible_breakfast&referral_code=creator-anna&quote_id=quote_alpenrose_001",
        },
      ],
    },
    deepLink: {
      url: "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&referral_code=creator-anna&quote_id=quote_alpenrose_001",
      expiresAt: "2026-06-06T11:15:00.000Z",
      preserves: ["dates", "guests", "rooms", "currency", "locale", "referral_code", "quote_id"],
    },
    freshness: {
      status: "fresh",
      generatedAt,
      sources: [
        freshness("hotel_catalog", "fresh"),
        freshness("booking", "fresh"),
        freshness("pms", "fresh"),
        freshness("finance", "fresh"),
        freshness("distribution", "fresh"),
      ],
    },
    dataSources: sources,
  };

  return { ...base, ...overrides };
}

function freshness(
  owner: PublicBookabilityDataSourceOwner,
  status: "fresh" | "stale" | "unavailable",
  reasonCode?: "source_unavailable" | "source_stale" | "not_configured",
) {
  return {
    owner,
    lastUpdatedAt: status === "unavailable" ? undefined : "2026-06-06T10:55:00.000Z",
    status,
    reasonCode,
  };
}
