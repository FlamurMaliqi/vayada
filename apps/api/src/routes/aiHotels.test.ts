import { findForbiddenPublicBookabilityKeys } from "@vayada/domain-distribution";
import Fastify from "fastify";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPublicHotelProfileRepository,
  registerAiHotelRoutes,
  type PublicHotelProfileReadPool,
} from "./aiHotels.js";

const NOW = new Date("2026-07-22T10:00:00.000Z");

function targetProfileRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    propertyId: "0fb98a96-9dbd-4917-8e61-40ec59348a99",
    contractVersion: "public-bookability.v1",
    publicVisibility: "public_safe",
    publicId: "prop_alpenrose",
    canonicalSlug: "hotel-alpenrose",
    canonicalUrl: "https://hotel-alpenrose.booking.vayada.com/en",
    bookingBaseUrl: "https://hotel-alpenrose.booking.vayada.com",
    customDomainUrl: null,
    timezone: "Etc/UTC",
    defaultLocale: "en",
    supportedLocales: ["en", "de"],
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR"],
    profileStatus: "public",
    publicIdentity: {
      propertyId: "prop_alpenrose",
      slug: "hotel-alpenrose",
      name: "Hotel Alpenrose",
    },
    location: { country: "AT", city: "Innsbruck" },
    media: [],
    amenities: [],
    publicContacts: [],
    policies: {},
    capabilities: {
      instantBook: true,
      onlinePayment: true,
      payAtProperty: false,
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
    bookingAdultAgeThreshold: 18,
    bookingChildrenEnabled: true,
    bookingHeaderLogo: null,
    bookingHeroImage: null,
    bookingHeroHeading: null,
    bookingHeroSubtext: null,
    bookingPrimaryColor: null,
    bookingFontPairing: null,
    publicSetupCompleteness: { status: "ready", missing: [] },
    sourceFreshness: {
      hotel_catalog: { status: "fresh", generatedAt: "2026-07-22T09:55:00.000Z" },
      booking: { status: "fresh", generatedAt: "2026-07-22T09:56:00.000Z" },
      pms: { status: "fresh", generatedAt: "2026-07-22T09:57:00.000Z" },
      finance: { status: "fresh", generatedAt: "2026-07-22T09:58:00.000Z" },
      distribution: { status: "fresh", generatedAt: "2026-07-22T09:59:00.000Z" },
    },
    freshnessStatus: "fresh",
    dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    generatedAt: "2026-07-22T09:59:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function targetRepository(row: QueryResultRow | null) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pool: PublicHotelProfileReadPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: row ? ([row] as T[]) : [] };
    },
    async end() {},
  };
  return {
    queries,
    repository: createTargetPublicHotelProfileRepository({
      connectionString: "postgresql://target",
      pool,
      now: () => NOW,
    }),
  };
}

describe("target public hotel profile security", () => {
  it.each([
    ["unpublished", { profileStatus: "unpublished" }],
    ["incomplete identity", { profileStatus: "incomplete" }],
    ["expired", { expiresAt: "2026-07-22T09:59:59.000Z" }],
    ["wrong visibility", { publicVisibility: "private" }],
  ])("does not expose %s profiles", async (_case, overrides) => {
    const { repository } = targetRepository(targetProfileRow(overrides));
    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toBeNull();
  });

  it("returns 404 rather than serializing an unpublished row", async () => {
    const { repository } = targetRepository(targetProfileRow({ profileStatus: "unpublished" }));
    const app = Fastify({ logger: false });
    await app.register(registerAiHotelRoutes, { prefix: "/api/ai", repository });

    const response = await app.inject({ method: "GET", url: "/api/ai/hotels/hotel-alpenrose" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("keeps a fresh sold-out hotel public but marks it unavailable", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        capabilities: {
          instantBook: false,
          onlinePayment: true,
          payAtProperty: false,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        },
        publicSetupCompleteness: {
          status: "incomplete",
          missing: ["sellable_availability"],
        },
      }),
    );

    const profile = await repository.findProfileBySlug("hotel-alpenrose");

    expect(profile?.hotel.trust).toEqual({
      profileComplete: true,
      profileVerified: true,
      domainVerified: false,
      bookabilityStatus: "unavailable",
      reasonCodes: ["sold_out"],
    });
  });

  it("keeps a fresh request-mode hotel bookable when sellable availability exists", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        capabilities: {
          instantBook: false,
          onlinePayment: true,
          payAtProperty: false,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        },
      }),
    );

    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: {
        capabilities: { instantBook: false },
        trust: { bookabilityStatus: "bookable", reasonCodes: [] },
      },
    });
  });

  it("does not report stale or source-incomplete profiles as bookable", async () => {
    const stale = targetRepository(targetProfileRow({ freshnessStatus: "stale" })).repository;
    const missingSource = targetRepository(
      targetProfileRow({
        sourceFreshness: {
          hotel_catalog: { status: "fresh" },
          distribution: { status: "fresh" },
        },
      }),
    ).repository;

    await expect(stale.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: { trust: { bookabilityStatus: "stale", reasonCodes: ["stale_data"] } },
      freshness: { status: "stale" },
    });
    await expect(missingSource.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: {
        trust: {
          bookabilityStatus: "unavailable",
          reasonCodes: ["unavailable_data"],
        },
      },
      freshness: { status: "unknown" },
    });
  });

  it("distinguishes unavailable coverage from a covered sold-out stay", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        freshnessStatus: "unavailable",
        capabilities: {
          instantBook: false,
          onlinePayment: true,
          payAtProperty: false,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        },
        publicSetupCompleteness: {
          status: "incomplete",
          missing: ["availability_source", "sellable_availability", "freshness"],
        },
      }),
    );

    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: {
        trust: {
          bookabilityStatus: "unavailable",
          reasonCodes: ["unavailable_data"],
        },
      },
    });
  });

  it("keeps pay-at-property bookable without an online provider", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        capabilities: {
          instantBook: true,
          onlinePayment: false,
          payAtProperty: true,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        },
      }),
    );

    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: {
        capabilities: { onlinePayment: false, payAtProperty: true },
        trust: { bookabilityStatus: "bookable", reasonCodes: [] },
      },
    });
  });

  it("marks missing payment and timezone readiness unavailable without hiding public identity", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        capabilities: {
          instantBook: true,
          onlinePayment: false,
          payAtProperty: false,
          promoCodes: false,
          referralCodes: false,
          bookingDeepLinks: true,
        },
        publicSetupCompleteness: {
          status: "incomplete",
          missing: ["payment_method", "timezone"],
        },
      }),
    );

    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: {
        name: "Hotel Alpenrose",
        trust: {
          bookabilityStatus: "unavailable",
          reasonCodes: ["payment_disabled", "unavailable_data"],
        },
      },
    });
  });

  it("uses the verified custom domain as the canonical booking origin", async () => {
    const { repository } = targetRepository(
      targetProfileRow({ customDomainUrl: "https://book.alpenrose.example" }),
    );

    const profile = await repository.findProfileBySlug("hotel-alpenrose");

    expect(profile?.hotel).toMatchObject({
      canonicalUrl: "https://book.alpenrose.example/en",
      bookingBaseUrl: "https://book.alpenrose.example",
      customDomainUrl: "https://book.alpenrose.example",
      trust: { domainVerified: true },
    });
    expect(findForbiddenPublicBookabilityKeys(profile)).toEqual([]);
  });

  it("keeps Catalog media and projects only the explicit public Booking branding fields", async () => {
    const approvedImage = {
      type: "gallery_image",
      url: "https://cdn.vayada.example/approved.jpg",
      alt: "Approved exterior",
    };
    const { repository, queries } = targetRepository(
      targetProfileRow({
        media: [
          {
            type: "logo",
            url: "https://cdn.vayada.example/logo.webp",
            alt: "Brand logo",
          },
          {
            type: "gallery_image",
            url: approvedImage.url,
            altText: approvedImage.alt,
          },
        ],
        bookingHeaderLogo: "https://cdn.vayada.example/logo.webp",
        bookingHeroImage: "https://cdn.vayada.example/draft.jpg",
        bookingHeroHeading: "Stay above the clouds",
        bookingHeroSubtext: "Book direct for our best available rates.",
        bookingPrimaryColor: "#3157D5",
        bookingFontPairing: "grand-classic",
      }),
    );

    const profile = await repository.findProfileBySlug("hotel-alpenrose");

    expect(profile?.hotel.images).toEqual([{ url: approvedImage.url, alt: approvedImage.alt }]);
    expect(profile?.hotel.branding).toEqual({
      logoUrl: "https://cdn.vayada.example/logo.webp",
      heroImage: "https://cdn.vayada.example/draft.jpg",
      heroHeading: "Stay above the clouds",
      heroSubtext: "Book direct for our best available rates.",
      primaryColor: "#3157D5",
      fontPairing: "grand-classic",
    });
    expect(queries[0]?.text).toContain('booking_header_logo.public_cdn_url AS "bookingHeaderLogo"');
    expect(queries[0]?.text).toContain("booking_branding.header_logo_media_object_id");
    expect(queries[0]?.text).toContain('booking_branding.hero_image_url AS "bookingHeroImage"');
    expect(queries[0]?.text).toContain('booking_branding.font_pairing AS "bookingFontPairing"');
    expect(queries[0]?.text).not.toContain("booking_branding.*");
    expect(queries[0]?.text).not.toContain("booking_branding.benefits");
    expect(queries[0]?.text).not.toContain("booking_branding.custom_filters");
    expect(findForbiddenPublicBookabilityKeys(profile)).toEqual([]);
  });

  it("exposes only the first ten ordered property gallery images", async () => {
    const gallery = Array.from({ length: 12 }, (_, index) => ({
      type: "gallery_image",
      url: `https://cdn.vayada.example/gallery-${index + 1}.jpg`,
      alt: null,
    }));
    const { repository } = targetRepository(
      targetProfileRow({
        media: [
          { type: "logo", url: "https://cdn.vayada.example/logo.png", alt: null },
          { type: "hero_image", url: "https://cdn.vayada.example/hero.jpg", alt: null },
          ...gallery,
        ],
      }),
    );

    const profile = await repository.findProfileBySlug("hotel-alpenrose");

    expect(profile?.hotel.images).toEqual(
      gallery.slice(0, 10).map(({ url, alt }) => ({ url, alt })),
    );
  });

  it("returns persisted public Booking branding from the AI hotel endpoint", async () => {
    const { repository } = targetRepository(
      targetProfileRow({
        bookingHeaderLogo: "https://cdn.vayada.example/alpenrose/logo.webp",
        bookingHeroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
        bookingHeroHeading: "Stay above the clouds",
        bookingHeroSubtext: "An independent alpine escape.",
        bookingPrimaryColor: "#2563EB",
        bookingFontPairing: "modern-minimalist",
        bookingInternalNotes: "must never be projected",
        bookingPayoutAccount: "must never be projected",
      }),
    );
    const app = Fastify({ logger: false });
    await app.register(registerAiHotelRoutes, { prefix: "/api/ai", repository });

    const response = await app.inject({ method: "GET", url: "/api/ai/hotels/hotel-alpenrose" });

    expect(response.statusCode).toBe(200);
    expect(response.json().hotel.branding).toEqual({
      logoUrl: "https://cdn.vayada.example/alpenrose/logo.webp",
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Stay above the clouds",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#2563EB",
      fontPairing: "modern-minimalist",
    });
    expect(findForbiddenPublicBookabilityKeys(response.json())).toEqual([]);
    await app.close();
  });

  it("serializes only supported public Catalog contacts", async () => {
    const { repository, queries } = targetRepository(
      targetProfileRow({
        publicContacts: [
          { type: "email", value: "stay@alpenrose.example" },
          { type: "phone", value: "+43 512 555 0100", isPublic: true },
          { type: "email", value: "owner@alpenrose.example", isPublic: false },
          { type: "admin_email", value: "admin@alpenrose.example" },
          { type: "website", value: "" },
        ],
      }),
    );

    const profile = await repository.findProfileBySlug("hotel-alpenrose");

    expect(profile?.hotel.publicContacts).toEqual([
      { type: "email", value: "stay@alpenrose.example" },
      { type: "phone", value: "+43 512 555 0100" },
    ]);
    expect(findForbiddenPublicBookabilityKeys(profile)).toEqual([]);
    expect(queries[0]?.text).toContain('catalog_profile.public_contacts AS "publicContacts"');
    expect(queries[0]?.text).toContain("catalog_profile.profile_status = 'complete'");
    expect(queries[0]?.text).not.toContain("property_contact_channels");
  });

  it("returns an empty contact list when Catalog has no public channels", async () => {
    const { repository } = targetRepository(targetProfileRow({ publicContacts: null }));

    await expect(repository.findProfileBySlug("hotel-alpenrose")).resolves.toMatchObject({
      hotel: { publicContacts: [] },
    });
  });

  it("enforces publication status, expiry, and canonical-domain verification in SQL", async () => {
    const { repository, queries } = targetRepository(null);

    await repository.findProfileBySlug("hotel-alpenrose");
    await repository.findProfileByCustomDomain?.("book.alpenrose.example");

    expect(queries[0]?.text).toContain("profile.profile_status = 'public'");
    expect(queries[0]?.text).toContain("profile.expires_at IS NULL");
    expect(queries[1]?.text).toContain("verified_domain.verification_status = 'verified'");
    expect(queries[1]?.text).toContain("verified_domain.canonical_when_verified = TRUE");
  });
});
