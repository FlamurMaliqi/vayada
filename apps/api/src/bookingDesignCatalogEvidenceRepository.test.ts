import { createBookingDesignReadinessProvider } from "@vayada/domain-booking";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import { createPgBookingDesignCatalogEvidenceRepository } from "./domains/bookingDesignCatalogEvidenceRepository.js";

const organizationId = "323e4567-e89b-42d3-a456-426614174000";
const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const mediaObjectId = "523e4567-e89b-42d3-a456-426614174000";

function harness(
  options: {
    missingProfile?: boolean;
    mediaReady?: boolean;
    coverCount?: number;
    coverPublicApproved?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string, _parameters?: readonly unknown[]) => {
    if (sql.includes('AS "displayName"')) {
      return {
        rows: options.missingProfile
          ? []
          : [
              {
                displayName: "Hotel Alpenrose",
                contentLocale: "en",
                profileRevision: "7",
                shortDescription:
                  "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
              },
            ],
        rowCount: options.missingProfile ? 0 : 1,
      };
    }
    return {
      rows: [
        {
          profileRevision: "7",
          coverCount: String(options.coverCount ?? 1),
          mediaObjectId,
          altText: "Hotel at sunrise",
          sourceSystem: "platform",
          publicApproved: options.coverPublicApproved ?? true,
        },
      ],
      rowCount: 1,
    };
  });
  const mediaResolver = createHotelMediaResolutionPort({
    async loadPublicMedia() {
      if (options.mediaReady === false) {
        return { ok: false, error: { code: "media_not_ready", mediaObjectIds: [mediaObjectId] } };
      }
      return {
        ok: true,
        resolvedTarget: { kind: "property", propertyId } as const,
        media: [
          {
            mediaObjectId,
            ownerOrganizationId: organizationId,
            propertyId,
            purpose: "property.hero_image" as const,
            publicVariants: [
              {
                variantName: "original_safe" as const,
                publicUrl: "https://cdn.vayada.test/cover.webp",
              },
            ],
          },
        ],
      };
    },
  });
  const repository = createPgBookingDesignCatalogEvidenceRepository({
    connectionString: "postgresql://test",
    mediaResolver,
    pool: { query: query as never, end: vi.fn() },
  });
  const readiness = createBookingDesignReadinessProvider({
    design: {
      async getCurrentDesign() {
        return {
          contractVersion: "booking-design.v1",
          propertyId,
          revision: 3,
          choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
          createdAt: "2026-08-04T12:00:00.000Z",
        };
      },
    },
    profile: repository.profile,
    coverAssignment: repository.coverAssignment,
    safeMedia: repository.safeMedia,
  });
  return { query, repository, readiness };
}

describe("Booking design Catalog evidence repository", () => {
  it("builds the renderer snapshot only from scoped profile, assignment, and safe media", async () => {
    const { query, readiness } = harness();
    const result = await readiness.getBookingDesignReadiness({ organizationId, propertyId });
    expect(result).toMatchObject({
      outcome: "ready",
      snapshot: {
        profile: { displayName: "Hotel Alpenrose", contentLocale: "en" },
        cover: { kind: "safe_media", mediaObjectId, altText: "Hotel at sunrise" },
      },
    });
    if (result.outcome !== "ready") throw new Error("Expected ready result");
    expect(result.snapshot.sourceBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "property_profile", revision: "profile:7" }),
        expect.objectContaining({
          entityType: "property_media_assignment",
          revision: "profile:7",
        }),
        expect.objectContaining({
          entityType: "property_safe_media",
          entityId: mediaObjectId,
          revision: expect.stringMatching(/^media:[0-9a-f]{64}$/),
        }),
      ]),
    );
    expect(query).toHaveBeenCalledTimes(2);
    for (const [, parameters] of query.mock.calls) {
      expect(parameters).toEqual([organizationId, propertyId]);
    }
  });

  it("maps absent profile and unresolved assigned media to typed blockers", async () => {
    await expect(
      harness({ missingProfile: true }).readiness.getBookingDesignReadiness({
        organizationId,
        propertyId,
      }),
    ).resolves.toMatchObject({
      outcome: "blocked",
      blocker: { code: "booking_design_profile_missing", evidencePort: "profile" },
    });
    await expect(
      harness({ mediaReady: false }).readiness.getBookingDesignReadiness({
        organizationId,
        propertyId,
      }),
    ).resolves.toMatchObject({
      outcome: "blocked",
      blocker: { code: "booking_design_safe_media_stale", evidencePort: "safe_media" },
    });
  });

  it("fails closed when the Catalog cover assignment is ambiguous or not public-safe", async () => {
    for (const options of [{ coverCount: 2 }, { coverCount: 1, coverPublicApproved: false }]) {
      await expect(
        harness(options).readiness.getBookingDesignReadiness({ organizationId, propertyId }),
      ).resolves.toMatchObject({
        outcome: "blocked",
        blocker: {
          code: "booking_design_cover_assignment_stale",
          evidencePort: "cover_assignment",
        },
      });
    }
  });
});
