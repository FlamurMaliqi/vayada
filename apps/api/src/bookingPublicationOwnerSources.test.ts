import {
  createBookingDesignReadinessProvider,
  createBookingPricingSourceFingerprint,
} from "@vayada/domain-booking";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import {
  now,
  organizationId,
  pricingEvidence,
  propertyId,
  revisionFixture,
} from "./bookingGuestPolicyTestFixtures.js";
import { createBookingBookingPublicationSource } from "./domains/bookingBookingPublicationSource.js";
import { createHotelCatalogBookingPublicationSource } from "./domains/hotelCatalogBookingPublicationSource.js";
import { createPmsBookingPublicationSource } from "./domains/pmsBookingPublicationSource.js";

const mediaObjectId = "a0000000-0000-4000-8000-000000000001";
const roomTypeId = "30000000-0000-4000-8000-000000000003";
const scope = { organizationId, propertyId };
const hash = `sha256:${"a".repeat(64)}` as const;

describe("production Booking publication owner sources", () => {
  it("builds a Catalog snapshot from private canonical rows and exact safe media", async () => {
    const row = {
      propertyId,
      displayName: "Hotel Alpenrose",
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      profileStatus: "complete",
      profileRevision: 8,
      sourceUpdatedAt: now,
      timezone: "Europe/Berlin",
      countryCode: "DE",
      region: "Bavaria",
      city: "Alpenstadt",
      latitude: "47.10",
      longitude: "11.20",
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "approximate",
      summary: "An alpine retreat.",
      canonicalSlug: "hotel-alpenrose",
      verifiedHostname: null,
      amenities: ["wifi"],
      contacts: [{ type: "email", value: "hello@alpenrose.test" }],
      media: [{ mediaObjectId, mediaType: "hero_image", altText: "Hotel", sortOrder: 0 }],
    };
    const pool = { query: vi.fn(async () => ({ rows: [row] })) };
    const source = createHotelCatalogBookingPublicationSource({
      connectionString: "postgres://unused",
      pool: pool as any,
      mediaResolver: createHotelMediaResolutionPort({
        async loadPublicMedia() {
          return {
            ok: true as const,
            resolvedTarget: { kind: "property" as const, propertyId },
            media: [
              {
                mediaObjectId,
                ownerOrganizationId: organizationId,
                propertyId,
                purpose: "property.hero_image" as const,
                publicVariants: [
                  {
                    variantName: "original_safe" as const,
                    publicUrl: "https://cdn.test/hotel.webp",
                  },
                ],
              },
            ],
          };
        },
      }),
    });
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected Catalog evidence");
    expect(evidence.entities[0]?.blockers).toEqual([]);
    expect(evidence.sources.map(({ entityType }) => entityType)).toContain("property_safe_media");

    const request = manifestRequest(evidence.sources);
    await expect(source.getSnapshot(request)).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        slug: "hotel-alpenrose",
        images: [{ url: "https://cdn.test/hotel.webp", alt: "Hotel" }],
      },
    });
    await expect(
      source.getSnapshot({
        ...request,
        sourceManifest: {
          ...request.sourceManifest,
          sources: request.sourceManifest.sources.map((item, index) =>
            index ? item : { ...item, revision: "wrong" },
          ),
        },
      }),
    ).resolves.toEqual({ outcome: "unavailable", owner: "hotel_catalog" });
  });

  it("projects Booking design, guest policy, and settings through Booking-owned ports", async () => {
    const design = designReadiness();
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            acceptanceMode: "instant",
            defaultLanguage: "en",
            supportedLanguages: ["en", "de"],
            heroSubtext: "Book direct.",
            hasActivePromos: true,
            updatedAt: now,
          },
        ],
      })),
    };
    const source = createBookingBookingPublicationSource({
      connectionString: "postgres://unused",
      pool: pool as any,
      design,
      guestPolicy: {
        async getCurrentGuestPolicy() {
          return revisionFixture();
        },
      },
    });
    const designResult = await design.getBookingDesignReadiness(scope);
    if (designResult.outcome !== "ready") throw new Error(JSON.stringify(designResult));
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected Booking evidence");
    expect(evidence.entities).toHaveLength(2);
    expect(evidence.entities.flatMap(({ blockers }) => blockers)).toEqual([]);

    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        branding: { heroImage: "https://cdn.test/cover.webp", heroSubtext: "Book direct." },
        capabilities: { instantBook: true, promoCodes: true },
        supportedQuoteParameters: { childrenSupported: true, adultAgeThreshold: 18 },
      },
    });
  });

  it("projects exact PMS room, rate, and 366-day calendar evidence", async () => {
    const pricing = pricingEvidence();
    const roomPublication = structuredClone(pricing.roomPublication) as any;
    roomPublication.rooms[0].facts.beds = [{ type: "king", quantity: 1 }];
    roomPublication.rooms[0].media = [
      {
        mediaObjectId,
        altText: "Suite",
        sortOrder: 0,
        publicVariants: [
          { variantName: "original_safe", publicUrl: "https://cdn.test/suite.webp" },
        ],
      },
    ];
    const fingerprint = createBookingPricingSourceFingerprint(scope, {
      ...pricing,
      roomPublication,
    });
    let calendarStatus: "current" | "stale" = "current";
    const source = createPmsBookingPublicationSource({
      rooms: {
        async getRoomPublicationSnapshot() {
          return roomPublication;
        },
      },
      pricing: {
        async getPricingSourceSnapshot() {
          return pricing.pricing;
        },
      },
      recurringPricing: {
        async getRecurringPricingBookingEvidence() {
          return pricing.recurringPricing;
        },
      },
      operatingCalendar: {
        async getCurrentOperatingCalendarConfiguration() {
          return {
            sourceStatus: calendarStatus,
            sourceConflicts: [],
            configuration: {
              propertyId,
              source: pmsSource("pms_operating_calendar.v1", propertyId, "calendar:3"),
              sourceInputs: {
                propertyTimeZone: "Europe/Berlin",
                propertyProfile: catalogSource("property_profile", propertyId, "profile:8"),
              },
              updatedAt: now,
            },
          } as any;
        },
        async getOperatingCalendarConfigurationBySource() {
          return null;
        },
      },
      inventory: {
        async getInventoryLaunchReadiness({ requiredCoverage }) {
          return {
            ready: true,
            blockers: [],
            requiredCoverage,
            snapshot: {
              configuration: {
                source: pmsSource("pms_operating_calendar.v1", propertyId, "calendar:3"),
              },
              coverage: {
                ...requiredCoverage,
                coverageFrom: requiredCoverage.from,
                coverageThrough: requiredCoverage.through,
                expectedDayCount: 366,
                materializedDayCount: 366,
                gaps: [],
                roomTypeIds: [roomTypeId],
              },
            },
          } as any;
        },
      },
      mandatoryChargeConfirmation: {
        bookingPricingConfirmationEvidencePort: "pms_mandatory_charges",
        async getMandatoryChargeConfirmation() {
          return {
            outcome: "available",
            evidence: {
              organizationId,
              propertyId,
              pricingSourceFingerprint: fingerprint,
              confirmationRevision: 6,
              confirmedAt: now,
            },
          };
        },
      },
      now: () => new Date(now),
    });
    const evidence = await source.getBookingLaunchEvidence(scope);
    if (evidence.outcome !== "evidence") throw new Error("Expected PMS evidence");
    expect(evidence.entities.flatMap(({ blockers }) => blockers)).toEqual([]);
    await expect(source.getSnapshot(manifestRequest(evidence.sources))).resolves.toMatchObject({
      outcome: "snapshot",
      content: {
        availabilityReady: true,
        rooms: [{ images: [{ url: "https://cdn.test/suite.webp", alt: "Suite" }] }],
        calendar: { expectedDayCount: 366, materializedDayCount: 366, gapCount: 0 },
      },
    });
    calendarStatus = "stale";
    const staleEvidence = await source.getBookingLaunchEvidence(scope);
    expect(staleEvidence).toMatchObject({
      outcome: "evidence",
      entities: expect.arrayContaining([
        expect.objectContaining({
          groupId: "booking.calendar",
          blockers: [expect.objectContaining({ code: "operating_calendar_source_stale" })],
        }),
      ]),
    });
  });
});

function designReadiness() {
  const source = catalogSource;
  return createBookingDesignReadinessProvider({
    design: {
      async getCurrentDesign() {
        return {
          contractVersion: "booking-design.v1",
          propertyId,
          revision: 4,
          choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
          createdAt: now,
        } as any;
      },
    },
    profile: {
      bookingDesignCatalogEvidencePort: "profile",
      async getBookingDesignProfileEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "profile",
          ...scope,
          source: source("property_profile", propertyId, "profile:8"),
          profile: {
            contractVersion: "hotel-catalog-step1.v1",
            profileRevision: 8,
            displayName: "Hotel Alpenrose",
            contentLocale: "en",
            shortDescription:
              "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
          },
        } as any;
      },
    },
    coverAssignment: {
      bookingDesignCatalogEvidencePort: "cover_assignment",
      async getBookingDesignCoverAssignmentEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "cover_assignment",
          ...scope,
          source: source("property_media_assignment", propertyId, "profile:8"),
          cover: { mediaObjectId, altText: "Hotel" },
        } as any;
      },
    },
    safeMedia: {
      bookingDesignCatalogEvidencePort: "safe_media",
      async getBookingDesignSafeMediaEvidence() {
        return {
          outcome: "evidence",
          evidencePort: "safe_media",
          ...scope,
          source: source("property_safe_media", mediaObjectId, `media:${"b".repeat(64)}`),
          media: {
            mediaObjectId,
            ownerOrganizationId: organizationId,
            propertyId,
            purpose: "property.hero_image",
            publicVariants: [
              { variantName: "original_safe", publicUrl: "https://cdn.test/cover.webp" },
            ],
          },
        } as any;
      },
    },
  });
}

const catalogSource = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "hotel_catalog" as const,
  entityType,
  entityId,
  revision,
});
const pmsSource = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "pms" as const,
  entityType,
  entityId,
  revision,
});
const manifestRequest = (sources: readonly any[]) => ({
  ...scope,
  sourceManifestHash: hash,
  sourceManifest: {
    contractVersion: "onboarding-source-manifest.v1" as const,
    propertyId,
    sources,
  },
});
