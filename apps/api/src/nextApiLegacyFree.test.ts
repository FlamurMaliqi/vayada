import { injectJson } from "@vayada/backend-test";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPublicRuntimeRepositories } from "./publicRuntime.js";
import type { PublicHotelQuoteReadPool } from "./routes/aiHotelQuotes.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";
import type { BookingWebCalendarReadPool } from "./routes/bookingWebPublic.js";
import type { MarketplaceDiscoveryReadPool } from "./routes/marketplaceDiscovery.js";

const legacyRuntimeEnvKeys = [
  "BOOKING_DATABASE_URL",
  "BOOKING_RESERVATIONS_READ_DATABASE_URL",
  "BOOKING_PUBLIC_API_URL",
  "PMS_API_URL",
  "PMS_PUBLIC_API_URL",
  "MARKETPLACE_DATABASE_URL",
] as const;

const nextApiLegacyFreeEnv: NodeJS.ProcessEnv = {
  API_RUNTIME: "next",
  TARGET_DATABASE_URL: "postgresql://target-db",
  PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
  BOOKING_DOMAIN_RESOLUTION_SOURCE: "target",
  PUBLIC_BOOKABILITY_SOURCE: "target",
  BOOKING_SETTINGS_SOURCE: "target",
  BOOKING_RESERVATIONS_SOURCE: "target",
  PMS_OPERATIONS_SOURCE: "target",
  FINANCE_SOURCE: "target",
  BOOKING_CHECKOUT_COMMAND_SOURCE: "target",
};

const publicBookabilityFixture = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!;

const publicHotelProfilePool: PublicHotelProfileReadPool = {
  async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
    expect(text).toContain("distribution.active_public_booking_revision");
    expect(text).toContain("distribution.public_booking_content_revisions");
    expect(text).not.toContain("distribution.public_hotel_bookability_profiles");
    expect(text).not.toContain("booking_hotels");

    const fixtureProfile = structuredClone(publicBookabilityFixture.profile);
    if (text.includes("hotel_catalog.property_domains")) {
      const origin = `https://${String(values?.[0])}`;
      fixtureProfile.hotel.canonicalUrl = `${origin}/en`;
      fixtureProfile.hotel.bookingBaseUrl = origin;
      fixtureProfile.hotel.customDomainUrl = origin;
      fixtureProfile.hotel.trust.domainVerified = true;
    }

    return {
      rows: [
        { propertyId: fixtureProfile.hotel.propertyId, profile: fixtureProfile },
      ] as unknown as T[],
    };
  },
  async end() {},
};

const publicHotelQuotePool: PublicHotelQuoteReadPool = {
  async query<T extends QueryResultRow>(text: string) {
    expect(text).toContain("distribution.public_quote_read_models");
    expect(text).not.toContain("PMS_PUBLIC_API_URL");

    return {
      rows: [targetPublicHotelQuoteRow()] as unknown as T[],
    };
  },
  async end() {},
};

const bookingWebCalendarPool: BookingWebCalendarReadPool = {
  async query<T extends QueryResultRow>(text: string) {
    expect(text).toContain("distribution.public_room_offer_snapshots");

    return {
      rows: [
        targetCalendarRow("2026-09-12", true),
        targetCalendarRow("2026-09-13", true),
        targetCalendarRow("2026-09-14", false),
      ] as unknown as T[],
    };
  },
  async end() {},
};

const marketplaceDiscoveryPool: MarketplaceDiscoveryReadPool = {
  async query<T extends QueryResultRow>(text: string) {
    expect(text).toContain("marketplace.");

    return {
      rows: text.includes("COUNT(*)") ? ([{ total: "0" }] as unknown as T[]) : ([] as T[]),
    };
  },
  async end() {},
};

describe("next-api legacy-free runtime check", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("boots and serves migrated public route groups with legacy runtime envs absent", async () => {
    for (const key of legacyRuntimeEnvKeys) {
      expect(nextApiLegacyFreeEnv[key], `${key} must stay unset for VAY-882`).toBeUndefined();
    }

    const config = loadConfig(nextApiLegacyFreeEnv);
    expect(config).toMatchObject({
      apiRuntime: "next",
      bookingDatabaseUrl: undefined,
      bookingReservationsReadDatabaseUrl: undefined,
      publicHotelProfileSource: "active_publication",
      bookingDomainResolutionSource: "target",
      publicBookabilitySource: "target",
      bookingSettingsSource: "target",
      bookingReservationsSource: "target",
      pmsOperationsSource: "target",
      financeSource: "target",
      bookingCheckoutCommandSource: "target",
    });

    const publicRuntime = createPublicRuntimeRepositories(config, {
      publicHotelProfilePool,
      publicHotelQuotePool,
      bookingWebCalendarPool,
      marketplaceDiscoveryPool,
    });

    app = buildApp({
      logger: false,
      ...publicRuntime,
      bookingDomainResolutionSource: config.bookingDomainResolutionSource,
    });
    await app.ready();

    const routes = [
      "/api/ai/hotels/hotel-alpenrose",
      "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
      "/api/booking-web/hosts/book.alpenrose.example",
      "/api/booking-web/hotels/hotel-alpenrose",
      "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2",
      "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-15",
      "/api/marketplace/offers",
      "/api/marketplace/creators",
    ];

    for (const url of routes) {
      const response = await injectJson(app, { method: "GET", url });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it("requires the target database because Marketplace is always enabled", () => {
    expect(() => createPublicRuntimeRepositories(loadConfig({}))).toThrow(
      "TARGET_DATABASE_URL is required for target public runtime repositories",
    );
  });
});

function targetPublicHotelQuoteRow(): QueryResultRow {
  const quote = publicBookabilityFixture.quote!;
  const offer = quote.quote!.offers[0]!;

  return {
    quoteSessionId: "f6898100-0000-0000-0000-000000000001",
    publicQuoteReference: quote.quote!.quoteId,
    quoteHash: quote.quote!.quoteHash,
    requestSnapshot: {},
    quoteStatus: quote.status,
    unavailableReasons: quote.unavailableReasons,
    offers: [
      {
        offerId: offer.offerId,
        roomTypeId: offer.roomTypeId,
        ratePlanId: offer.ratePlanId,
        name: offer.name,
        availableRooms: offer.availableRooms,
        paymentOptions: offer.paymentOptions,
        totals: offer.totals,
        bookingUrl: offer.bookingUrl,
      },
    ],
    totals: {},
    deepLinkUrl: quote.deepLink?.url ?? null,
    priceGuarantee: quote.quote!.priceGuarantee,
    currency: quote.request.currency,
    sourceFreshness: {
      sources: quote.freshness.sources.map((source) => ({
        owner: source.owner,
        status: source.status,
        lastUpdatedAt: source.lastUpdatedAt,
      })),
    },
    freshnessStatus: quote.freshness.status,
    dataSources: quote.dataSources,
    generatedAt: quote.generatedAt,
    expiresAt: quote.quote!.expiresAt,
  };
}

function targetCalendarRow(stayDate: string, hasAvailability: boolean): QueryResultRow {
  return {
    stayDate,
    hasAvailability,
    hasUnavailableState: !hasAvailability,
    sourceFreshnessValues: [
      JSON.stringify({
        sources: [{ owner: "pms", status: "fresh" }],
      }),
    ],
    freshnessStatuses: ["fresh"],
    dataSources: ["pms", "distribution"],
    generatedAt: "2026-06-21T19:00:00.000Z",
  };
}
