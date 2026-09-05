import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import {
  createPgMarketplaceDiscoveryReadRepository,
  findForbiddenMarketplaceDiscoveryKeys,
  toMarketplaceLocation,
  serializeMarketplaceOffer,
  type MarketplaceCreatorPage,
  type MarketplaceCreatorReadModel,
  type MarketplaceDiscoveryError,
  type MarketplaceDiscoveryPageRequest,
  type MarketplaceDiscoveryReadPool,
  type MarketplaceDiscoveryReadRepository,
  type MarketplaceOfferPage,
  type MarketplaceOfferReadModel,
} from "./routes/marketplaceDiscovery.js";

// In-memory repository mirroring the projection semantics from
// engineering/marketplace-discovery-contract.md: visibility/eligibility
// filtering and the documented createdAt DESC, id ASC ordering live in the
// repository layer, exactly as the pg implementation must behave.
type OfferSeed = MarketplaceOfferReadModel & {
  visibilityStatus: "public" | "unlisted" | "private" | "disabled";
};

type CreatorSeed = Omit<MarketplaceCreatorReadModel, "audienceSize" | "creatorType"> & {
  creatorType: string;
  profileComplete: boolean;
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  displayNameRaw: string | null;
};

function createSeedRepository(seed: {
  offers?: OfferSeed[];
  creators?: CreatorSeed[];
}): MarketplaceDiscoveryReadRepository {
  const byCreatedAtDesc = (a: { createdAt: string }, b: { createdAt: string }, tiebreak: number) =>
    b.createdAt.localeCompare(a.createdAt) || tiebreak;

  return {
    async listPublicOffers(page: MarketplaceDiscoveryPageRequest) {
      const eligible = (seed.offers ?? [])
        .filter((offer) => offer.visibilityStatus === "public")
        .sort((a, b) => byCreatedAtDesc(a, b, a.offerId.localeCompare(b.offerId)))
        .map((row) => {
          const { visibilityStatus, ...offer } = row;
          void visibilityStatus;
          return offer;
        });
      return {
        items: eligible.slice(page.offset, page.offset + page.limit),
        total: eligible.length,
      };
    },
    async listPublicCreators(page: MarketplaceDiscoveryPageRequest) {
      const eligible = (seed.creators ?? [])
        .filter(
          (creator) =>
            creator.profileComplete &&
            creator.profileStatus === "active" &&
            creator.displayNameRaw !== null,
        )
        .sort((a, b) => byCreatedAtDesc(a, b, a.creatorId.localeCompare(b.creatorId)))
        .map((row) => {
          const { profileComplete, profileStatus, displayNameRaw, creatorType, ...creator } = row;
          void profileComplete;
          void profileStatus;
          return {
            ...creator,
            displayName: displayNameRaw as string,
            creatorType: creatorType as MarketplaceCreatorReadModel["creatorType"],
          };
        });
      return {
        items: eligible.slice(page.offset, page.offset + page.limit),
        total: eligible.length,
      };
    },
  };
}

// Migrated offers keep their existing UUIDs per the ID continuity clause.
const LEGACY_OFFER_ID_A = "3f1c2b6a-8a44-4f1e-9a51-1aa001000001";
const LEGACY_OFFER_ID_B = "3f1c2b6a-8a44-4f1e-9a51-1aa001000002";
const LEGACY_CREATOR_ID_A = "9d7e5c4b-1b23-4cde-8f00-2bb002000001";
const LEGACY_CREATOR_ID_B = "9d7e5c4b-1b23-4cde-8f00-2bb002000002";

function offerSeed(overrides: Partial<OfferSeed>): OfferSeed {
  return {
    offerId: LEGACY_OFFER_ID_A,
    offerPublicId: "mlst_alpenrose",
    offerTitle: "Alpine getaway collaboration",
    offerSummary: "Boutique alpine hotel.",
    hotelName: "Hotel Alpenrose",
    hotelSlug: "hotel-alpenrose",
    hotelAccommodationType: "hotel",
    hotelLocation: {
      displayText: "Innsbruck, Austria",
      countryCode: "AT",
      city: "Innsbruck",
    },
    hotelCoverImageUrl: "https://cdn.example.com/alpenrose/cover.jpg",
    hotelImageUrls: ["https://cdn.example.com/alpenrose/1.jpg"],
    deliverables: [
      {
        deliverableId: "deliverable-1",
        platform: "instagram",
        deliverableType: "post",
        quantity: 2,
        timingGuidance: "During the stay",
      },
    ],
    compensationOptions: [
      {
        compensationOptionId: "off-1",
        compensationType: "free_stay",
        availabilityMonths: ["June", "July"],
        platforms: ["instagram", "tiktok"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        currency: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
        termsSummary: "Two nights included",
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT", "DE"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24", "25-34"],
      creatorTypes: ["travel"],
    },
    createdAt: "2026-05-01T10:00:00.000Z",
    projectedAt: "2026-06-09T08:00:00.000Z",
    visibilityStatus: "public",
    ...overrides,
  };
}

function creatorSeed(overrides: Partial<CreatorSeed>): CreatorSeed {
  return {
    creatorId: LEGACY_CREATOR_ID_A,
    displayName: "Anna Alps",
    displayNameRaw: "Anna Alps",
    locationText: "Vienna, Austria",
    shortDescription: "Alpine travel storytelling.",
    portfolioUrl: "https://annaalps.example.com",
    profilePictureUrl: "https://cdn.example.com/anna.jpg",
    creatorType: "travel",
    platforms: [
      {
        platformId: "plat-1",
        platform: "instagram",
        handle: "@annaalps",
        profileUrl: "https://instagram.com/annaalps",
        followerCount: 12000,
        engagementRate: 4.2,
        audienceCountries: [{ country: "AT", percentage: 45 }],
        audienceAgeGroups: [{ ageRange: "25-34", percentage: 40 }],
        audienceGenderSplit: { male: 30, female: 70 },
      },
    ],
    averageRating: 4.5,
    totalReviews: 2,
    createdAt: "2026-04-15T09:00:00.000Z",
    profileComplete: true,
    profileStatus: "active",
    ...overrides,
  };
}

function createFakePool(results: unknown[][]): MarketplaceDiscoveryReadPool & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text) {
      sql.push(text);
      return { rows: (results.shift() ?? []) as never[] };
    },
    async end() {},
  };
}

let app: FastifyInstance | undefined;

async function buildDiscoveryApp(seed: {
  offers?: OfferSeed[];
  creators?: CreatorSeed[];
  allowedOrigins?: string[];
}): Promise<FastifyInstance> {
  app = buildApp({
    logger: false,
    marketplaceDiscoveryRepository: createSeedRepository(seed),
    marketplaceDiscoveryAllowedOrigins: seed.allowedOrigins,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace discovery offers route", () => {
  it("returns public offers with contract fields and no private keys (offers-populated)", async () => {
    const server = await buildDiscoveryApp({
      offers: [
        offerSeed({}),
        offerSeed({
          offerId: LEGACY_OFFER_ID_B,
          offerPublicId: "mlst_seehof",
          hotelSlug: "hotel-seehof",
          createdAt: "2026-05-10T10:00:00.000Z",
        }),
      ],
    });

    const response = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.pagination).toEqual({ limit: 100, offset: 0, total: 2 });

    for (const item of response.body.items) {
      for (const compensationOption of item.compensationOptions) {
        expect(["free_stay", "paid", "discount", "affiliate"]).toContain(
          compensationOption.compensationType,
        );
        for (const platform of compensationOption.platforms) {
          expect(["instagram", "tiktok", "youtube", "facebook", "blog", "x", "other"]).toContain(
            platform,
          );
        }
      }
    }

    const [first] = response.body.items;
    expect(first.offerId).toBe(LEGACY_OFFER_ID_B);
    expect(first.offerPublicId).toBe("mlst_seehof");
    expect(first.hotelSlug).toBe("hotel-seehof");
    expect(first.hotelName).toBe("Hotel Alpenrose");
    expect(first.offerTitle).toBe("Alpine getaway collaboration");
    expect(first.hotelLocation.displayText).toBe("Innsbruck, Austria");
    expect(first.hotelCoverImageUrl).toContain("cover.jpg");
    expect(first.hotelImageUrls).toHaveLength(1);
    expect(first.deliverables[0]).toMatchObject({ deliverableType: "post", quantity: 2 });
    expect(first.compensationOptions[0].compensationType).toBe("free_stay");
    expect(first.compensationOptions[0].platforms).toEqual(["instagram", "tiktok"]);
    expect(first.creatorRequirements?.platforms).toEqual(["instagram"]);
    expect(first.createdAt).toBe("2026-05-10T10:00:00.000Z");
    expect(first.projectedAt).toBeTruthy();
    expect(response.body.items[1].offerId).toBe(LEGACY_OFFER_ID_A);

    expect(findForbiddenMarketplaceDiscoveryKeys(response.body)).toEqual([]);
    const raw = JSON.stringify(response.body);
    for (const forbidden of [
      "owner_email",
      "ownerEmail",
      "owner_user_id",
      "ownerUserId",
      "hotel_profile_id",
      '"status"',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("preserves the canonical fields used by Marketplace discovery filters", async () => {
    const server = await buildDiscoveryApp({
      offers: [
        offerSeed({
          hotelAccommodationType: "boutique_hotel",
          compensationOptions: [
            {
              compensationOptionId: "paid-option",
              compensationType: "paid",
              availabilityMonths: ["July"],
              platforms: ["instagram"],
              freeStayMinNights: null,
              freeStayMaxNights: null,
              paidMaxAmount: "2000.00",
              currency: "EUR",
              discountPercentage: null,
              commissionPercentage: null,
              minFollowers: null,
              termsSummary: null,
            },
            {
              compensationOptionId: "discount-option",
              compensationType: "discount",
              availabilityMonths: ["July"],
              platforms: ["instagram"],
              freeStayMinNights: null,
              freeStayMaxNights: null,
              paidMaxAmount: null,
              currency: null,
              discountPercentage: 20,
              commissionPercentage: null,
              minFollowers: null,
              termsSummary: null,
            },
            {
              compensationOptionId: "affiliate-option",
              compensationType: "affiliate",
              availabilityMonths: ["July"],
              platforms: ["instagram"],
              freeStayMinNights: null,
              freeStayMaxNights: null,
              paidMaxAmount: null,
              currency: null,
              discountPercentage: null,
              commissionPercentage: 12,
              minFollowers: null,
              termsSummary: null,
            },
          ],
        }),
      ],
    });

    const response = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      hotelAccommodationType: "boutique_hotel",
      compensationOptions: [
        { compensationType: "paid", paidMaxAmount: "2000.00", currency: "EUR" },
        { compensationType: "discount", discountPercentage: 20 },
        { compensationType: "affiliate", commissionPercentage: 12 },
      ],
    });
  });

  it("excludes non-public offers (offers-excludes-non-public)", async () => {
    const server = await buildDiscoveryApp({
      offers: [
        offerSeed({}),
        offerSeed({ offerId: "offer-private", visibilityStatus: "private" }),
        offerSeed({ offerId: "offer-unlisted", visibilityStatus: "unlisted" }),
        offerSeed({ offerId: "offer-disabled", visibilityStatus: "disabled" }),
        // Incomplete-profile hotel projects to a non-public visibility status.
        offerSeed({ offerId: "offer-incomplete-profile-hotel", visibilityStatus: "private" }),
      ],
    });

    const response = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.offerId)).toEqual([LEGACY_OFFER_ID_A]);
  });

  it("returns an empty page when no public offers exist (offers-empty)", async () => {
    const server = await buildDiscoveryApp({ offers: [] });

    const response = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("slices the documented ordering with limit/offset (offers-pagination)", async () => {
    const server = await buildDiscoveryApp({
      offers: [
        offerSeed({ offerId: "lst-a", createdAt: "2026-05-03T00:00:00.000Z" }),
        // Same createdAt: offerId ASC is the documented tie-break.
        offerSeed({ offerId: "lst-c", createdAt: "2026-05-02T00:00:00.000Z" }),
        offerSeed({ offerId: "lst-b", createdAt: "2026-05-02T00:00:00.000Z" }),
      ],
    });

    const response = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers?limit=1&offset=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.offerId)).toEqual(["lst-b"]);
    expect(response.body.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
  });

  it("clamps out-of-range pagination values (offers-clamps-out-of-range)", async () => {
    const server = await buildDiscoveryApp({ offers: [offerSeed({})] });

    const overMax = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers?limit=999&offset=-5",
    });
    expect(overMax.statusCode).toBe(200);
    expect(overMax.body.pagination.limit).toBe(200);
    expect(overMax.body.pagination.offset).toBe(0);

    const underMin = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers?limit=0",
    });
    expect(underMin.statusCode).toBe(200);
    expect(underMin.body.pagination.limit).toBe(1);

    const emptyValue = await injectJson<MarketplaceOfferPage>(server, {
      method: "GET",
      url: "/api/marketplace/offers?limit=",
    });
    expect(emptyValue.statusCode).toBe(200);
    expect(emptyValue.body.pagination.limit).toBe(100);
  });

  it("rejects non-numeric and duplicated pagination values (offers-invalid-query)", async () => {
    const server = await buildDiscoveryApp({ offers: [offerSeed({})] });

    for (const url of [
      "/api/marketplace/offers?limit=abc",
      "/api/marketplace/offers?limit=1.5",
      "/api/marketplace/offers?limit=1&limit=2",
      "/api/marketplace/offers?offset=1&offset=2",
    ]) {
      const response = await injectJson<MarketplaceDiscoveryError>(server, { method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.body.code).toBe("invalid_query");
      expect(response.body.category).toBe("validation");
      expect(response.body.message).not.toContain("trim");
    }
  });

  it("reflects allowlisted origins, varies on Origin, and stays scoped (CORS)", async () => {
    const server = await buildDiscoveryApp({
      offers: [offerSeed({})],
      allowedOrigins: ["https://marketplace.localhost", "https://admin.localhost"],
    });

    for (const origin of ["https://marketplace.localhost", "https://admin.localhost"]) {
      const allowed = await server.inject({
        method: "GET",
        url: "/api/marketplace/offers",
        headers: { origin },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
      expect(allowed.headers.vary).toContain("Origin");
      expect(allowed.headers["cache-control"]).toBe(
        "public, max-age=60, stale-while-revalidate=300",
      );
    }

    const denied = await server.inject({
      method: "GET",
      url: "/api/marketplace/offers",
      headers: { origin: "https://evil.example.com" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    // Vary must be present even on non-allowlisted responses so shared
    // caches never replay an un-CORSed body to a browser consumer.
    expect(denied.headers.vary).toContain("Origin");

    const otherGroup = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://marketplace.localhost" },
    });
    expect(otherGroup.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("marketplace discovery creators route", () => {
  it("returns eligible creators with contract fields and no private keys (creators-populated)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({}),
        creatorSeed({
          creatorId: LEGACY_CREATOR_ID_B,
          displayNameRaw: "Migrated Max",
          creatorType: "migration",
          createdAt: "2026-04-20T09:00:00.000Z",
        }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(2);

    const [migrated, anna] = response.body.items;
    expect(migrated.creatorId).toBe(LEGACY_CREATOR_ID_B);
    expect(migrated.creatorType).toBe("other");
    expect(migrated.displayName).toBe("Migrated Max");
    expect(anna.creatorId).toBe(LEGACY_CREATOR_ID_A);
    expect(anna.displayName).toBe("Anna Alps");
    expect(anna.creatorType).toBe("travel");
    expect(anna.platforms[0].platform).toBe("instagram");
    expect(anna.platforms[0].handle).toBe("@annaalps");
    expect(anna.platforms[0].profileUrl).toBe("https://instagram.com/annaalps");
    expect(anna.platforms[0].followerCount).toBe(12000);
    expect(anna.platforms[0].engagementRate).toBe(4.2);
    expect(anna.audienceSize).toBe(12000);
    expect(anna.averageRating).toBe(4.5);
    expect(anna.totalReviews).toBe(2);
    expect(anna.createdAt).toBe("2026-04-15T09:00:00.000Z");

    expect(findForbiddenMarketplaceDiscoveryKeys(response.body)).toEqual([]);
    const raw = JSON.stringify(response.body);
    for (const forbidden of ["user_id", "userId", "email", "phone"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("computes audience and rating aggregates (creators-audience-aggregates)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({
          platforms: [
            { ...creatorSeed({}).platforms[0], platformId: "p1", followerCount: 12000 },
            {
              ...creatorSeed({}).platforms[0],
              platformId: "p2",
              platform: "tiktok",
              followerCount: 8000,
            },
          ],
          averageRating: 4.33,
          totalReviews: 3,
        }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0].audienceSize).toBe(20000);
    expect(response.body.items[0].averageRating).toBe(4.33);
    expect(response.body.items[0].totalReviews).toBe(3);
  });

  it("returns creators with no platforms (creators-empty-platforms)", async () => {
    const server = await buildDiscoveryApp({
      creators: [creatorSeed({ platforms: [] })],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0].platforms).toEqual([]);
    expect(response.body.items[0].audienceSize).toBe(0);
  });

  it("excludes ineligible creators (creators-excludes-ineligible)", async () => {
    const server = await buildDiscoveryApp({
      creators: [
        creatorSeed({}),
        creatorSeed({ creatorId: "creator-incomplete-profile", profileComplete: false }),
        creatorSeed({ creatorId: "creator-pending-status", profileStatus: "pending" }),
        creatorSeed({ creatorId: "creator-rejected-status", profileStatus: "rejected" }),
        creatorSeed({ creatorId: "creator-suspended-status", profileStatus: "suspended" }),
        creatorSeed({ creatorId: "creator-archived-status", profileStatus: "archived" }),
        creatorSeed({ creatorId: "creator-null-display-name", displayNameRaw: null }),
      ],
    });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.creatorId)).toEqual([LEGACY_CREATOR_ID_A]);
  });

  it("returns an empty page when no eligible creators exist (creators-empty)", async () => {
    const server = await buildDiscoveryApp({ creators: [] });

    const response = await injectJson<MarketplaceCreatorPage>(server, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("returns the contract error envelope on repository failure", async () => {
    app = buildApp({
      logger: false,
      marketplaceDiscoveryRepository: {
        async listPublicOffers() {
          throw new Error("boom");
        },
        async listPublicCreators() {
          throw new Error("boom");
        },
      },
    });
    await app.ready();

    const creators = await injectJson<MarketplaceDiscoveryError>(app, {
      method: "GET",
      url: "/api/marketplace/creators",
    });
    expect(creators.statusCode).toBe(500);
    expect(creators.body).toEqual({
      statusCode: 500,
      code: "internal_error",
      category: "internal",
      message: "Failed to fetch marketplace creators.",
    });

    const offers = await injectJson<MarketplaceDiscoveryError>(app, {
      method: "GET",
      url: "/api/marketplace/offers",
    });
    expect(offers.statusCode).toBe(500);
    expect(offers.body).toEqual({
      statusCode: 500,
      code: "internal_error",
      category: "internal",
      message: "Failed to fetch marketplace offers.",
    });
  });
});

describe("marketplace discovery public-safety guard", () => {
  it("flags forbidden keys anywhere in a payload", () => {
    expect(
      findForbiddenMarketplaceDiscoveryKeys({
        items: [{ ownerEmail: "x@example.com" }],
      }),
    ).toEqual(["$.items[0].ownerEmail"]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ nested: { owner_user_id: "u1" } })).toEqual([
      "$.nested.owner_user_id",
    ]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ status: "pending" })).toEqual(["$.status"]);
    expect(findForbiddenMarketplaceDiscoveryKeys({ phone: "+43" })).toEqual(["$.phone"]);
  });

  it("does not register the routes when no repository is provided", async () => {
    app = buildApp({ logger: false });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/marketplace/offers" });
    expect(response.statusCode).toBe(404);
  });

  it("mounts offers and creators from the target database without the legacy marketplace DB", async () => {
    const pool = createFakePool([
      [
        {
          offerId: LEGACY_OFFER_ID_A,
          offerPublicId: "mlst_alpenrose",
          offerTitle: "Alpine getaway collaboration",
          offerSummary: "Boutique alpine hotel.",
          hotelName: "Hotel Alpenrose",
          hotelSlug: "hotel-alpenrose",
          hotelAccommodationType: "hotel",
          hotelLocation: {
            display: "Innsbruck, Austria",
            countryCode: "AT",
            city: "Innsbruck",
          },
          hotelCoverImageUrl: "https://cdn.example.com/cover.jpg",
          hotelImageUrls: ["https://cdn.example.com/offer.jpg"],
          deliverables: [],
          compensationOptions: [],
          creatorRequirements: null,
          createdAt: new Date("2026-05-01T10:00:00.000Z"),
          projectedAt: new Date("2026-06-01T10:00:00.000Z"),
        },
      ],
      [{ total: "1" }],
      [
        {
          creatorId: LEGACY_CREATOR_ID_A,
          displayName: "Anna Alps",
          locationText: "Vienna, Austria",
          shortDescription: "Alpine travel storytelling.",
          portfolioUrl: "https://annaalps.example.com",
          profilePictureUrl: "https://cdn.example.com/anna.jpg",
          creatorType: "travel",
          platforms: [],
          averageRating: "0",
          totalReviews: "0",
          createdAt: "2026-04-15T09:00:00.000Z",
        },
      ],
      [{ total: "1" }],
    ]);
    app = buildApp({
      logger: false,
      marketplaceDiscoveryRepository: createPgMarketplaceDiscoveryReadRepository({
        connectionString: "postgresql://target-db",
        pool,
      }),
    });

    const offers = await injectJson<MarketplaceOfferPage>(app, {
      method: "GET",
      url: "/api/marketplace/offers",
    });
    const creators = await injectJson<MarketplaceCreatorPage>(app, {
      method: "GET",
      url: "/api/marketplace/creators",
    });

    expect(offers.statusCode).toBe(200);
    expect(offers.body.items[0]?.offerId).toBe(LEGACY_OFFER_ID_A);
    expect(creators.statusCode).toBe(200);
    expect(creators.body.items[0]?.creatorId).toBe(LEGACY_CREATOR_ID_A);
    const sql = pool.sql.join("\n");
    expect(sql).toContain('offer.id::text AS "offerId"');
    expect(sql).toContain('property.property_type AS "hotelAccommodationType"');
    expect(sql).toContain("marketplace.offer_deliverables");
    expect(sql).toContain('creator.source_creator_id AS "creatorId"');
    expect(sql).toContain("creator.source_creator_id IS NOT NULL");
    expect(sql).not.toContain("offer.source_offer_id");
    expect(sql).not.toContain("COALESCE(creator.source_creator_id");
  });
});

describe("pg marketplace discovery repository", () => {
  it("maps public offer read-model rows with legacy IDs and total", async () => {
    const pool = createFakePool([
      [
        {
          offerId: LEGACY_OFFER_ID_A,
          offerPublicId: "mlst_alpenrose",
          offerTitle: "Alpine getaway collaboration",
          offerSummary: "Boutique alpine hotel.",
          hotelName: "Hotel Alpenrose",
          hotelSlug: "hotel-alpenrose",
          hotelAccommodationType: "hotel",
          hotelLocation: {
            display: "Innsbruck, Austria",
            countryCode: "AT",
            city: "Innsbruck",
          },
          hotelCoverImageUrl: "https://cdn.example.com/cover.jpg",
          hotelImageUrls: ["https://cdn.example.com/offer.jpg"],
          deliverables: [
            {
              deliverableId: "deliverable-1",
              platform: "instagram",
              deliverableType: "reel",
              quantity: 1,
              timingGuidance: null,
            },
          ],
          compensationOptions: [
            {
              id: "compensationOption-1",
              type: "affiliate",
              months: ["June"],
              platforms: ["instagram"],
              commissionPercent: 12,
              minFollowers: 5000,
              termsSummary: "Affiliate commission available",
            },
          ],
          creatorRequirements: {
            platforms: ["instagram"],
            countries: ["AT"],
            targetAgeMin: 20,
            targetAgeMax: 40,
            ageGroups: ["25-34"],
            creatorTypes: ["travel"],
          },
          createdAt: new Date("2026-05-01T10:00:00.000Z"),
          projectedAt: new Date("2026-06-01T10:00:00.000Z"),
        },
      ],
      [{ total: "3" }],
    ]);
    const repository = createPgMarketplaceDiscoveryReadRepository({
      connectionString: "postgresql://marketplace-db",
      pool,
    });

    const result = await repository.listPublicOffers({ limit: 1, offset: 2 });

    expect(result.total).toBe(3);
    expect(result.items[0]).toMatchObject({
      offerId: LEGACY_OFFER_ID_A,
      offerPublicId: "mlst_alpenrose",
      hotelSlug: "hotel-alpenrose",
      hotelAccommodationType: "hotel",
      hotelCoverImageUrl: "https://cdn.example.com/cover.jpg",
      hotelLocation: {
        displayText: "Innsbruck, AT",
        countryCode: "AT",
        city: "Innsbruck",
      },
      hotelImageUrls: ["https://cdn.example.com/offer.jpg"],
      deliverables: [{ deliverableId: "deliverable-1", deliverableType: "reel" }],
      compensationOptions: [
        {
          compensationOptionId: "compensationOption-1",
          compensationType: "affiliate",
          availabilityMonths: ["June"],
          platforms: ["instagram"],
          commissionPercentage: 12,
          minFollowers: 5000,
          termsSummary: "Affiliate commission available",
        },
      ],
      creatorRequirements: {
        platforms: ["instagram"],
        targetCountries: ["AT"],
        targetAgeMin: 20,
        targetAgeMax: 40,
        targetAgeGroups: ["25-34"],
        creatorTypes: ["travel"],
      },
      createdAt: "2026-05-01T10:00:00.000Z",
      projectedAt: "2026-06-01T10:00:00.000Z",
    });
    expect(pool.sql.join("\n")).toContain("read_model.visibility_status = 'public'");
    expect(pool.sql.join("\n")).toContain("offer.offer_status = 'verified'");
    expect(pool.sql.join("\n")).toContain('offer.id::text AS "offerId"');
    expect(pool.sql.join("\n")).toContain("marketplace.offer_compensation_options");
    expect(
      pool.sql
        .join("\n")
        .match(/LEFT JOIN hotel_catalog\.property_public_profile_read_model property_profile/g),
    ).toHaveLength(2);
    expect(pool.sql.join("\n")).toContain(
      "COALESCE(property_profile.display_name, read_model.display_name, property.display_name)",
    );
    expect(pool.sql.join("\n")).toContain(
      "COALESCE(property_profile.canonical_slug, read_model.canonical_slug, property.public_id)",
    );
    expect(pool.sql.join("\n")).toContain(
      "COALESCE(property_profile.location, '{}'::jsonb) AS \"hotelLocation\"",
    );
    expect(pool.sql.join("\n")).not.toContain("read_model.location");
    expect(pool.sql.join("\n")).toContain("platformMediaObjectId");
    expect(pool.sql.join("\n")).toContain(
      "COALESCE(media.cover_image_url, read_model.image_urls[1])",
    );
    expect(pool.sql.join("\n")).toContain(
      "COALESCE(media.image_urls, read_model.image_urls, '{}')",
    );
    expect(pool.sql.join("\n")).not.toMatch(/\bauth\b|users/i);
  });

  it("maps only canonical public locality fields", () => {
    expect(
      toMarketplaceLocation({
        rawMarketplaceLocation: "Private Strasse 1, Innsbruck",
        displayText: "Private Strasse 1, Innsbruck",
        display: "Private Strasse 1, Innsbruck",
        country: "Austria",
      }),
    ).toEqual({ displayText: "" });
    expect(
      toMarketplaceLocation({ city: "Innsbruck", region: "Tyrol", countryCode: "AT" }),
    ).toEqual({
      displayText: "Innsbruck, Tyrol, AT",
      city: "Innsbruck",
      region: "Tyrol",
      countryCode: "AT",
    });
  });

  it("maps active creator rows with source IDs, platforms, and rounded ratings", async () => {
    const pool = createFakePool([
      [
        {
          creatorId: LEGACY_CREATOR_ID_A,
          displayName: "Anna Alps",
          locationText: "Vienna, Austria",
          shortDescription: "Alpine travel storytelling.",
          portfolioUrl: "https://annaalps.example.com",
          profilePictureUrl: "https://cdn.example.com/anna.jpg",
          creatorType: "migration",
          platforms: [
            {
              platformId: "platform-1",
              platform: "instagram",
              handle: "@annaalps",
              profileUrl: "https://instagram.com/annaalps",
              followerCount: 12000,
              engagementRate: "4.20",
              audienceCountries: [{ country: "AT", percentage: 45 }],
              audienceAgeGroups: [{ ageRange: "25-34", percentage: 40 }],
              audienceGenderSplit: { male: 30, female: 70 },
            },
            {
              platformId: "platform-2",
              platform: "tiktok",
              handle: "@unsafe-http",
              profileUrl: "http://tiktok.com/unsafe-http",
            },
            {
              platformId: "platform-3",
              platform: "youtube",
              handle: "@unsafe-relative",
              profileUrl: "/unsafe-relative",
            },
            {
              platformId: "platform-4",
              platform: "facebook",
              handle: "@unsafe-script",
              profileUrl: "javascript:alert(1)",
            },
          ],
          averageRating: "4.33",
          totalReviews: "3",
          createdAt: "2026-04-15T09:00:00.000Z",
        },
      ],
      [{ total: "1" }],
    ]);
    const repository = createPgMarketplaceDiscoveryReadRepository({
      connectionString: "postgresql://marketplace-db",
      pool,
    });

    const result = await repository.listPublicCreators({ limit: 100, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      creatorId: LEGACY_CREATOR_ID_A,
      displayName: "Anna Alps",
      creatorType: "other",
      averageRating: 4.33,
      totalReviews: 3,
      platforms: [
        {
          platformId: "platform-1",
          platform: "instagram",
          handle: "@annaalps",
          profileUrl: "https://instagram.com/annaalps",
          followerCount: 12000,
          engagementRate: 4.2,
        },
        { platformId: "platform-2", profileUrl: null },
        { platformId: "platform-3", profileUrl: null },
        { platformId: "platform-4", profileUrl: null },
      ],
    });
    const sql = pool.sql.join("\n");
    expect(sql).not.toContain("creator.profile_complete");
    expect(sql).toContain("marketplace.creator_profile_is_complete");
    expect(sql).toContain("TRUE");
    expect(sql).not.toMatch(/\$[13]::boolean/);
    expect(sql).toContain("creator.profile_status = 'active'");
    expect(sql).toContain('creator.source_creator_id AS "creatorId"');
    expect(sql).toContain("'profileUrl', platform.profile_url");
    expect(sql).toContain("creator.source_creator_id IS NOT NULL");
    expect(sql).not.toContain("COALESCE(creator.source_creator_id");
    expect(sql).not.toMatch(/\bauth\b|users/i);
  });

  it("does not discover a creator without the mandatory profile photo", async () => {
    const sql: string[] = [];
    const pool: MarketplaceDiscoveryReadPool = {
      async query(text) {
        sql.push(text);
        const rows = text.trim().startsWith("SELECT COUNT(*)::text AS total")
          ? [{ total: "0" }]
          : [];
        return { rows: rows as never[] };
      },
      async end() {},
    };
    const repository = createPgMarketplaceDiscoveryReadRepository({
      connectionString: "postgresql://marketplace-db",
      pool,
    });

    const result = await repository.listPublicCreators({ limit: 100, offset: 0 });

    expect(result).toEqual({ items: [], total: 0 });
    expect(sql.join("\n")).not.toContain("creator.profile_complete");
    expect(sql.join("\n")).toContain("marketplace.creator_profile_is_complete");
    expect(sql.join("\n")).toContain("TRUE");
  });
});

it("preserves the catalog timezone through public offer serialization", () => {
  const hotelLocation = toMarketplaceLocation({ city: "Vienna", timezone: "Europe/Vienna" });
  expect(hotelLocation.timezone).toBe("Europe/Vienna");
  const serialized = serializeMarketplaceOffer({
    hotelLocation,
    hotelImageUrls: [],
    deliverables: [],
    compensationOptions: [],
  } as unknown as MarketplaceOfferReadModel);
  expect(serialized.hotelLocation.timezone).toBe("Europe/Vienna");
});
