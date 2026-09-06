import { describe, expect, it } from "vitest";

import {
  toLegacyHotel,
  toLegacyRooms,
  type BookingWebPublicHotelResponse,
} from "./bookingWebPublic";

function publicHotelResponse(
  publicContacts?: BookingWebPublicHotelResponse["hotel"]["publicContacts"],
  images: BookingWebPublicHotelResponse["hotel"]["images"] = [],
): BookingWebPublicHotelResponse {
  return {
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
        latitude: null,
        longitude: null,
      },
      summary: "Independent alpine hotel.",
      images,
      amenities: ["wifi"],
      publicContacts,
      policies: {
        checkInFrom: "15:00",
        checkOutUntil: "11:00",
        cancellationSummary: null,
        termsUrl: null,
      },
      capabilities: {
        instantBook: true,
        onlinePayment: false,
        payAtProperty: true,
        promoCodes: false,
        referralCodes: false,
        bookingDeepLinks: true,
      },
      supportedQuoteParameters: {
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: 10,
        childrenSupported: true,
        adultAgeThreshold: 18,
        supportedCurrencies: ["EUR"],
        supportedLocales: ["en", "de"],
      },
    },
  };
}

describe("Booking Web public hotel adapter", () => {
  it("maps the Booking header logo without changing the image fallback", () => {
    const response = publicHotelResponse();
    response.hotel.branding = {
      logoUrl: "https://cdn.vayada.example/alpenrose/logo.webp",
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    const hotel = toLegacyHotel(response);

    expect(hotel.branding?.logoUrl).toBe("https://cdn.vayada.example/alpenrose/logo.webp");
    expect(hotel.heroImage).toBe("/vayada-logo.png");
  });

  it("maps header visibility and keeps Refer a Guest behind the active module", () => {
    const response = publicHotelResponse();
    response.hotel.branding = {
      logoUrl: null,
      showContactButton: false,
      showReferAGuestButton: true,
      showLanguageSelector: false,
      showCurrencySelector: true,
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    expect(toLegacyHotel(response)).toMatchObject({
      headerSettings: {
        showContactButton: false,
        showLanguageSelector: false,
        showCurrencySelector: true,
      },
      referAGuestEnabled: false,
    });

    response.hotel.capabilities.referralCodes = true;
    expect(toLegacyHotel(response).referAGuestEnabled).toBe(false);
  });

  it("preserves target amenity labels and an explicit reviewed-empty list", () => {
    const response = {
      request: { nights: 2, rooms: 1 },
      status: "bookable" as const,
      quote: {
        offers: [
          {
            offerId: "offer-alpine-flexible",
            roomTypeId: "room-alpine",
            ratePlanId: "rate-flexible",
            name: "Alpine Suite",
            occupancy: { maxAdults: 2, maxChildren: 1 },
            availableRooms: 2,
            refundable: true,
            mealPlan: "breakfast",
            amenities: ["Wi-Fi", "Air conditioning", "Balcony"],
            paymentOptions: ["card"],
            totals: {
              currency: "EUR",
              roomTotal: 400,
              taxesAndFees: 0,
              discounts: 0,
              grandTotal: 400,
            },
            policies: { cancellation: null, deposit: null },
            bookingUrl: "https://hotel-alpenrose.booking.localhost/en/book",
          },
        ],
      },
    };

    expect(toLegacyRooms(response)[0]?.amenities).toEqual(["Wi-Fi", "Air conditioning", "Balcony"]);

    response.quote.offers[0].amenities = [];
    expect(toLegacyRooms(response)[0]?.amenities).toEqual([]);
  });

  it("maps public contacts and uses only public city/region/country for the address", () => {
    const hotel = toLegacyHotel(
      publicHotelResponse([
        { type: "phone", value: " +43 512 555 0100 " },
        { type: "email", value: " stay@alpenrose.example " },
        { type: "whatsapp", value: "+43 660 555 0100" },
        { type: "website", value: "https://alpenrose.example" },
        { type: "instagram", value: "https://instagram.com/alpenrose" },
        { type: "facebook", value: "https://facebook.com/alpenrose" },
      ]),
    );

    expect(hotel.contact).toEqual({
      address: "Innsbruck, Tyrol, AT",
      phone: "+43 512 555 0100",
      email: "stay@alpenrose.example",
      whatsapp: "+43 660 555 0100",
      website: "https://alpenrose.example/",
    });
    expect(hotel.socialLinks).toEqual({
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
    });
  });

  it("keeps missing contacts empty and rejects unsafe public-link schemes", () => {
    const empty = toLegacyHotel(publicHotelResponse([]));
    const omitted = toLegacyHotel(publicHotelResponse());
    const unsafe = toLegacyHotel(
      publicHotelResponse([
        { type: "website", value: "javascript:alert(1)" },
        { type: "instagram", value: "javascript:alert(2)" },
      ]),
    );

    expect(empty.contact).toEqual({
      address: "Innsbruck, Tyrol, AT",
      phone: "",
      email: "",
      whatsapp: undefined,
      website: undefined,
    });
    expect(empty.socialLinks).toEqual({ instagram: undefined, facebook: undefined });
    expect(omitted.contact).toEqual(empty.contact);
    expect(omitted.socialLinks).toEqual(empty.socialLinks);
    expect(unsafe.contact.website).toBeUndefined();
    expect(unsafe.socialLinks?.instagram).toBeUndefined();
  });

  it("keeps the hero separate from the property gallery", () => {
    const response = publicHotelResponse(undefined, [
      { url: "https://cdn.vayada.example/pool.jpg", alt: "Pool" },
      { url: "https://cdn.vayada.example/lobby.jpg", alt: "Lobby" },
    ]);
    response.hotel.branding = {
      heroImage: "https://cdn.vayada.example/hero.jpg",
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    const hotel = toLegacyHotel(response);

    expect(hotel.heroImage).toBe("https://cdn.vayada.example/hero.jpg");
    expect(hotel.images).toEqual([
      "https://cdn.vayada.example/pool.jpg",
      "https://cdn.vayada.example/lobby.jpg",
    ]);
    response.hotel.branding = undefined;
    expect(toLegacyHotel(response).heroImage).toBe("/vayada-logo.png");
    expect(toLegacyHotel(publicHotelResponse()).images).toEqual([]);
  });
});
