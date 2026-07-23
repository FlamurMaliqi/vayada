import { describe, expect, it } from "vitest";

import {
  buildPublicBookabilityQuoteProjection,
  buildPublicBookabilityProfileProjection,
  findForbiddenPublicBookabilityKeys,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityProducerInputs,
  type PublicBookabilityQuoteProducerInputs,
} from "./index.js";
import { PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS, PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";

describe("@vayada/domain-distribution", () => {
  it("exports the public bookability version and source owners", () => {
    expect(PUBLIC_BOOKABILITY_CONTRACT_VERSION).toBe("public-bookability.v1");
    expect(PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS).toEqual([
      "hotel_catalog",
      "booking",
      "pms",
      "finance",
      "distribution",
    ]);
  });

  it("builds a distribution-owned public profile projection from producer inputs", () => {
    const inputs = {
      hotelCatalog: {
        propertyId: "prop_123",
        slug: "hotel-alpenrose",
        name: "Hotel Alpenrose",
        timezone: "Europe/Vienna",
        defaultLocale: "en",
        supportedLocales: ["en", "de"],
        location: { country: "AT", city: "Innsbruck" },
        summary: "Alpine hotel.",
        images: [],
        amenities: ["wifi"],
        profileComplete: true,
        profileVerified: true,
        lastUpdatedAt: "2026-06-06T10:40:00.000Z",
      },
      booking: {
        policies: { checkInFrom: "15:00", checkOutUntil: "11:00" },
        capabilities: { instantBook: true, promoCodes: true, referralCodes: true },
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
        lastUpdatedAt: "2026-06-06T10:41:00.000Z",
      },
      pms: { availabilityReady: true, lastUpdatedAt: "2026-06-06T10:42:00.000Z" },
      finance: {
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        onlinePayment: true,
        payAtProperty: true,
        lastUpdatedAt: "2026-06-06T10:43:00.000Z",
      },
      bookingWeb: {
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
        bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
        customDomainUrl: null,
        domainVerified: false,
        bookingDeepLinks: true,
      },
    };
    const projection = buildPublicBookabilityProfileProjection("2026-06-06T11:00:00.000Z", inputs);

    expect(projection).toMatchObject({
      contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
      publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
      hotel: {
        propertyId: "prop_123",
        defaultCurrency: "EUR",
        capabilities: {
          instantBook: true,
          onlinePayment: true,
          payAtProperty: true,
          bookingDeepLinks: true,
        },
      },
      dataSources: PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
    });

    const unavailableProjection = buildPublicBookabilityProfileProjection(
      "2026-06-06T11:00:00.000Z",
      {
        ...inputs,
        pms: { availabilityReady: false, lastUpdatedAt: "2026-06-06T10:42:00.000Z" },
      },
    );

    expect(unavailableProjection.hotel.trust).toMatchObject({
      bookabilityStatus: "unavailable",
      reasonCodes: ["unavailable_data"],
    });
    expect(unavailableProjection.freshness.status).toBe("unavailable");
  });

  it("whitelist-copies profile producer inputs and rolls up explicit stale freshness", () => {
    const inputs = profileProducerInputs();
    const projection = buildPublicBookabilityProfileProjection("2026-06-06T11:00:00.000Z", {
      ...inputs,
      hotelCatalog: {
        ...inputs.hotelCatalog,
        location: {
          country: "AT",
          city: "Innsbruck",
          internalNotes: "private",
        } as unknown as PublicBookabilityProducerInputs["hotelCatalog"]["location"],
        images: [
          {
            url: "https://cdn.vayada.example/hotels/alpenrose/front.jpg",
            alt: "Exterior",
            channexMappingId: "chn_123",
          },
        ] as unknown as PublicBookabilityProducerInputs["hotelCatalog"]["images"],
        publicContacts: [
          { type: "email", value: "  stay@alpenrose.example  " },
          {
            type: "phone",
            value: "+43 512 555 0100",
            privateNote: "must not cross the public boundary",
          },
          { type: "admin_email", value: "owner@alpenrose.example" },
          { type: "website", value: "   " },
        ] as unknown as PublicBookabilityProducerInputs["hotelCatalog"]["publicContacts"],
      },
      booking: {
        ...inputs.booking,
        policies: {
          checkInFrom: "15:00",
          checkOutUntil: "11:00",
          processorAccountId: "acct_private",
        } as unknown as PublicBookabilityProducerInputs["booking"]["policies"],
        freshness: { status: "stale", reasonCode: "source_stale" },
      },
    });

    expect(projection.freshness.status).toBe("stale");
    expect(projection.freshness.sources).toContainEqual(
      expect.objectContaining({ owner: "booking", status: "stale", reasonCode: "source_stale" }),
    );
    expect(findForbiddenPublicBookabilityKeys(projection)).toEqual([]);
    expect(projection.hotel.location).not.toHaveProperty("internalNotes");
    expect(projection.hotel.images[0]).not.toHaveProperty("channexMappingId");
    expect(projection.hotel.publicContacts).toEqual([
      { type: "email", value: "stay@alpenrose.example" },
      { type: "phone", value: "+43 512 555 0100" },
    ]);
    expect(projection.hotel.publicContacts[1]).not.toHaveProperty("privateNote");
    expect(projection.hotel.policies).not.toHaveProperty("processorAccountId");
  });

  it("uses an empty public contact list when Catalog has no public channels", () => {
    const projection = buildPublicBookabilityProfileProjection(
      "2026-06-06T11:00:00.000Z",
      profileProducerInputs(),
    );

    expect(projection.hotel.publicContacts).toEqual([]);
  });

  it("builds a public quote projection from producer inputs", () => {
    const inputs = quoteProducerInputs();
    const projection = buildPublicBookabilityQuoteProjection("2026-06-06T11:00:00.000Z", {
      ...inputs,
      pms: {
        ...inputs.pms,
        offers: [
          {
            ...inputs.pms.offers[0],
            bookingUrl: "https://pms.invalid/book",
          } as unknown as PublicBookabilityQuoteProducerInputs["pms"]["offers"][number],
        ],
      },
    });

    expect(projection).toMatchObject({
      contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
      publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
      status: "bookable",
      dataSources: PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
      quote: {
        quoteId: "quote_alpenrose_001",
        offers: [{ offerId: "offer_deluxe_flexible", paymentOptions: ["card"] }],
      },
      deepLink: {
        url: "https://hotel-alpenrose.booking.localhost/en/book?quote_id=quote_alpenrose_001",
      },
    });
    expect(projection.quote?.offers[0]).toMatchObject({
      policies: {
        cancellation: "Free cancellation until 7 days before arrival.",
        deposit: "No deposit required.",
      },
    });
    expect(projection.quote?.offers[0]?.bookingUrl).toContain(
      "https://hotel-alpenrose.booking.localhost/en/book?",
    );
    expect(projection.quote?.offers[0]?.bookingUrl).toContain("room_type=room_deluxe");
    expect(projection.quote?.offers[0]?.bookingUrl).not.toContain("pms.invalid");
  });

  it("keeps quote projections public-safe and unavailable when payments are missing", () => {
    const inputs = quoteProducerInputs();
    const projection = buildPublicBookabilityQuoteProjection("2026-06-06T11:00:00.000Z", {
      ...inputs,
      pms: {
        ...inputs.pms,
        offers: [
          {
            ...inputs.pms.offers[0],
            internalNotes: "private",
            providerAccountId: "acct_private",
            bookingUrl: "https://pms.invalid/book",
          } as unknown as PublicBookabilityQuoteProducerInputs["pms"]["offers"][number],
        ],
      },
      finance: {
        ...inputs.finance,
        publicPaymentOptions: [],
      },
    });

    expect(projection.status).toBe("unavailable");
    expect(projection.unavailableReasons).toContainEqual({ code: "payment_disabled" });
    expect(projection.quote).toBeUndefined();
    expect(findForbiddenPublicBookabilityKeys(projection)).toEqual([]);
  });

  it("flags PMS private-note-shaped keys anywhere in public payloads", () => {
    expect(
      findForbiddenPublicBookabilityKeys({
        hotel: {
          privateNoteCount: 1,
          private_note_body: "sentinel private note body",
          bookingNotesPrivate: [{ privateNoteId: "note_123" }],
          booking_notes_private: [{ privateNoteBody: "sentinel private note body" }],
        },
      }),
    ).toEqual([
      "booking_notes_private",
      "bookingnotesprivate",
      "private_note_body",
      "privatenotebody",
      "privatenotecount",
      "privatenoteid",
    ]);
  });

  it("provides fixtures for every required downstream contract case", () => {
    expect(PUBLIC_BOOKABILITY_FIXTURES.map((fixture) => fixture.caseId).sort()).toEqual(
      [...PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS].sort(),
    );
  });

  it("keeps fixtures public-safe", () => {
    for (const fixture of PUBLIC_BOOKABILITY_FIXTURES) {
      expect(findForbiddenPublicBookabilityKeys(fixture)).toEqual([]);
      expect(fixture.profile.publicVisibility).toBe(PUBLIC_BOOKABILITY_VISIBILITY);
      expect(fixture.profile.contractVersion).toBe(PUBLIC_BOOKABILITY_CONTRACT_VERSION);
    }
  });

  it("marks custom-domain and renamed-property fixtures for canonical URL consumers", () => {
    const customDomain = PUBLIC_BOOKABILITY_FIXTURES.find(
      (fixture) => fixture.caseId === "custom_domain",
    );
    const renamedProperty = PUBLIC_BOOKABILITY_FIXTURES.find(
      (fixture) => fixture.caseId === "renamed_property",
    );

    expect(customDomain?.profile.hotel.customDomainUrl).toBe("https://book.alpenrose.example");
    expect(customDomain?.profile.hotel.trust.domainVerified).toBe(true);
    expect(renamedProperty?.profile.hotel.slug).toBe("alpenrose-resort");
  });
});

function profileProducerInputs(): PublicBookabilityProducerInputs {
  return {
    hotelCatalog: {
      propertyId: "prop_123",
      slug: "hotel-alpenrose",
      name: "Hotel Alpenrose",
      timezone: "Europe/Vienna",
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      location: { country: "AT", city: "Innsbruck" },
      summary: "Alpine hotel.",
      images: [],
      amenities: ["wifi"],
      profileComplete: true,
      profileVerified: true,
      lastUpdatedAt: "2026-06-06T10:40:00.000Z",
    },
    booking: {
      policies: { checkInFrom: "15:00", checkOutUntil: "11:00" },
      capabilities: { instantBook: true, promoCodes: true, referralCodes: true },
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
      lastUpdatedAt: "2026-06-06T10:41:00.000Z",
    },
    pms: { availabilityReady: true, lastUpdatedAt: "2026-06-06T10:42:00.000Z" },
    finance: {
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      onlinePayment: true,
      payAtProperty: true,
      lastUpdatedAt: "2026-06-06T10:43:00.000Z",
    },
    bookingWeb: {
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
      bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
      customDomainUrl: null,
      domainVerified: false,
      bookingDeepLinks: true,
    },
  };
}

function quoteProducerInputs(): PublicBookabilityQuoteProducerInputs {
  return {
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
    hotelCatalog: { lastUpdatedAt: "2026-06-06T10:40:00.000Z" },
    booking: {
      lastUpdatedAt: "2026-06-06T10:41:00.000Z",
      offerPolicies: [
        {
          roomTypeId: "room_deluxe",
          ratePlanId: "rate_flexible_breakfast",
          cancellation: "Free cancellation until 7 days before arrival.",
          deposit: "No deposit required.",
        },
      ],
    },
    pms: {
      availabilityReady: true,
      lastUpdatedAt: "2026-06-06T10:42:00.000Z",
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
          totals: {
            currency: "EUR",
            roomTotal: 540,
            taxesAndFees: 54,
            discounts: 0,
            grandTotal: 594,
          },
        },
      ],
    },
    finance: {
      publicPaymentOptions: ["card"],
      supportedCurrencies: ["EUR"],
      lastUpdatedAt: "2026-06-06T10:43:00.000Z",
    },
    bookingWeb: {
      offerBookingUrlBase: "https://hotel-alpenrose.booking.localhost/en/book",
      deepLink: {
        url: "https://hotel-alpenrose.booking.localhost/en/book?quote_id=quote_alpenrose_001",
        expiresAt: "2026-06-06T11:15:00.000Z",
        preserves: ["dates", "guests", "rooms", "currency", "locale", "referral_code", "quote_id"],
      },
    },
    quote: {
      quoteId: "quote_alpenrose_001",
      quoteHash: "sha256:fixture",
      expiresAt: "2026-06-06T11:15:00.000Z",
      priceGuarantee: "expires_at",
    },
  };
}
