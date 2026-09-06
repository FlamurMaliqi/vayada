import { describe, expect, it } from "vitest";

import {
  toLegacyHotel,
  toLegacyRooms,
  type BookingWebPublicHotelResponse,
  type BookingWebPublicOffersResponse,
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
    expect(toLegacyHotel(response).referAGuestEnabled).toBe(true);
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

describe("complete public room selections", () => {
  it("keeps combinations with the same first room distinct and drops incomplete selections", () => {
    const lines = [
      {
        roomTypeId: "double",
        publicOfferKey: "double:flex",
        guests: [
          { adults: 2, children: 0 },
          { adults: 1, children: 1 },
        ],
      },
      { roomTypeId: "twin", publicOfferKey: "twin:flex", guests: [{ adults: 2, children: 0 }] },
    ];
    const response: BookingWebPublicOffersResponse = {
      request: {
        nights: 2,
        rooms: 1,
        checkIn: "2027-02-01",
        checkOut: "2027-02-03",
        adults: 5,
        children: 1,
      },
      status: "bookable",
      quote: {
        offers: ["selection-a", "selection-b"].map((offerId) => ({
          offerId,
          roomTypeId: "double",
          ratePlanId: null,
          name: "2 × Double + 1 × Twin",
          expiresAt: "2027-01-01T10:15:00Z",
          roomSelection: { contractVersion: "booking-room-selection.v1", lines },
          roomLines: lines.map((line) => ({
            ...line,
            roomName: line.roomTypeId,
            roomCount: line.guests.length,
            rateSummary: {},
            policy: {},
            totals: { totalAmount: String(line.guests.length * 200) },
          })),
          occupancy: { maxAdults: 5, maxChildren: 1 },
          availableRooms: 3,
          refundable: false,
          mealPlan: null,
          paymentOptions: ["pay_at_property"],
          totals: {
            currency: "EUR",
            roomTotal: 600,
            taxesAndFees: 0,
            discounts: 0,
            grandTotal: 600,
          },
          policies: { cancellation: null, deposit: null },
          bookingUrl: "https://example.test/en/book",
        })),
      },
    };
    const rooms = toLegacyRooms(response);
    expect(rooms.map((room) => room.id)).toEqual(["selection-a", "selection-b"]);
    expect(rooms[0]).toMatchObject({
      name: "2 × Double + 1 × Twin",
      remainingRooms: 3,
      combination: {
        roomSelection: { lines },
        totalAmount: 600,
        checkIn: "2027-02-01",
        adults: 5,
        children: 1,
      },
    });
    delete response.quote!.offers[0].roomLines;
    expect(toLegacyRooms(response).map((room) => room.id)).toEqual(["selection-b"]);
    delete response.quote!.offers[0].roomSelection;
    expect(toLegacyRooms(response).map((room) => room.id)).toEqual(["selection-b"]);
    const savedSelection = response.quote!.offers[1].roomSelection;
    delete response.quote!.offers[1].roomSelection;
    expect(toLegacyRooms(response)).toEqual([]);
    response.quote!.offers[1].roomSelection = savedSelection;
    delete response.request.checkIn;
    expect(toLegacyRooms(response)).toEqual([]);
  });
});
