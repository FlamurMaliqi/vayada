import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_DESIGN_COVER_FALLBACK_PATH,
  BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
} from "./bookingDesignSnapshot.js";
import {
  BOOKING_DESIGN_PROVIDER_FAILURE_CODES,
  BOOKING_DESIGN_READINESS_BLOCKER_CODES,
  createBookingDesignReadinessProvider,
  parseBookingDesignReadinessResult,
} from "./bookingDesignReadiness.js";

const organizationId = "abcdef10-0000-4000-8000-000000000001";
const propertyId = "abcdef00-0000-4000-8000-000000000002";
const mediaObjectId = "abcdef20-0000-4000-8000-000000000003";
const scope = { organizationId, propertyId };
const source = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "hotel_catalog" as const,
  entityType,
  entityId,
  revision,
});
const design = () => ({
  contractVersion: "booking-design.v1" as const,
  propertyId,
  revision: 4,
  choices: { primaryColor: "#0077B6" as const, fontPairing: "modern-minimalist" as const },
  createdAt: "2026-08-03T12:00:00.000Z",
});
const profile = () => ({
  outcome: "evidence" as const,
  evidencePort: "profile" as const,
  ...scope,
  source: source("property_profile", propertyId, "profile:7"),
  profile: {
    contractVersion: "hotel-catalog-step1.v1" as const,
    profileRevision: 7,
    displayName: "Hotel Alpenrose",
    contentLocale: "en" as const,
    shortDescription:
      "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
  },
});
const assignment = (cover: null | { mediaObjectId: string; altText: string | null } = null) => ({
  outcome: "evidence" as const,
  evidencePort: "cover_assignment" as const,
  ...scope,
  source: source("property_media_assignment", propertyId, "assignment:9"),
  cover,
});
const media = () => ({
  outcome: "evidence" as const,
  evidencePort: "safe_media" as const,
  ...scope,
  source: source("property_safe_media", mediaObjectId, "media:11"),
  media: {
    mediaObjectId,
    ownerOrganizationId: organizationId,
    propertyId,
    purpose: "property.hero_image" as const,
    publicVariants: [
      { variantName: "thumbnail" as const, publicUrl: "https://cdn.vayada.test/thumb.webp" },
      { variantName: "original_safe" as const, publicUrl: "https://cdn.vayada.test/cover.webp" },
    ],
  },
});

function provider(overrides: Record<string, unknown> = {}) {
  const safeMedia = vi.fn().mockResolvedValue(media());
  const result = createBookingDesignReadinessProvider({
    design: { getCurrentDesign: vi.fn().mockResolvedValue(design()) },
    profile: {
      bookingDesignCatalogEvidencePort: "profile",
      getBookingDesignProfileEvidence: vi.fn().mockResolvedValue(profile()),
    },
    coverAssignment: {
      bookingDesignCatalogEvidencePort: "cover_assignment",
      getBookingDesignCoverAssignmentEvidence: vi.fn().mockResolvedValue(assignment()),
    },
    safeMedia: {
      bookingDesignCatalogEvidencePort: "safe_media",
      getBookingDesignSafeMediaEvidence: safeMedia,
    },
    ...overrides,
  });
  return { result, safeMedia };
}

describe("Booking design renderer readiness", () => {
  it("strictly parses ready, blocked, and provider-failure wire results", async () => {
    const ready = await provider().result.getBookingDesignReadiness(scope);
    expect(parseBookingDesignReadinessResult(ready, scope)).toEqual(ready);
    expect(
      parseBookingDesignReadinessResult(
        {
          outcome: "blocked",
          ...scope,
          blocker: { code: "booking_design_missing", evidencePort: "design" },
        },
        scope,
      ),
    ).toEqual({
      outcome: "blocked",
      ...scope,
      blocker: { code: "booking_design_missing", evidencePort: "design" },
    });
    expect(
      parseBookingDesignReadinessResult(
        {
          outcome: "provider_failure",
          ...scope,
          error: {
            code: "booking_design_profile_unavailable",
            evidencePort: "profile",
            errorSource: "system",
          },
        },
        scope,
      ),
    ).toMatchObject({ outcome: "provider_failure" });
    expect(
      parseBookingDesignReadinessResult(
        ready.outcome === "ready" ? { ...ready, extra: true } : ready,
        scope,
      ),
    ).toBeNull();
    expect(
      parseBookingDesignReadinessResult(ready, { ...scope, propertyId: mediaObjectId }),
    ).toBeNull();
  });

  it("creates a complete frozen default-cover snapshot without calling safe media", async () => {
    const { result, safeMedia } = provider();
    const readiness = await result.getBookingDesignReadiness({
      organizationId: organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
    });
    expect(readiness).toMatchObject({
      outcome: "ready",
      organizationId,
      propertyId,
      designSource: {
        ownerDomain: "booking",
        entityType: "design_revision",
        entityId: propertyId,
        revision: "design:4",
      },
      snapshot: {
        contractVersion: BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
        appearance: {
          primaryColor: "#0077B6",
          fontPairing: "modern-minimalist",
          button: { foregroundColor: "#FFFFFF" },
        },
        cover: { kind: "fallback", path: BOOKING_DESIGN_COVER_FALLBACK_PATH },
      },
    });
    expect(safeMedia).not.toHaveBeenCalled();
    if (readiness.outcome !== "ready") throw new Error("Expected ready design");
    expect(readiness.snapshot.sourceBindings).toEqual([
      readiness.designSource,
      assignment().source,
      profile().source,
    ]);
    expect(Object.isFrozen(readiness.snapshot)).toBe(true);
    expect(Object.isFrozen(readiness.snapshot.sourceBindings)).toBe(true);
    expect(readiness.snapshot.profile).toEqual({
      displayName: "Hotel Alpenrose",
      contentLocale: "en",
      shortDescription:
        "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
    });
  });

  it("binds exact assigned safe media and canonicalizes renderer ordering", async () => {
    const cover = assignment({ mediaObjectId, altText: "Hotel at sunrise" });
    const { result, safeMedia } = provider({
      coverAssignment: {
        bookingDesignCatalogEvidencePort: "cover_assignment",
        getBookingDesignCoverAssignmentEvidence: vi.fn().mockResolvedValue(cover),
      },
    });
    const readiness = await result.getBookingDesignReadiness(scope);
    expect(safeMedia).toHaveBeenCalledWith({ ...scope, mediaObjectId });
    expect(readiness).toMatchObject({
      outcome: "ready",
      snapshot: {
        cover: {
          kind: "safe_media",
          mediaObjectId,
          altText: "Hotel at sunrise",
          publicVariants: [{ variantName: "original_safe" }, { variantName: "thumbnail" }],
        },
      },
    });
    if (readiness.outcome !== "ready") throw new Error("Expected ready design");
    expect(readiness.snapshot.sourceBindings.map(({ revision }) => revision)).toEqual([
      "design:4",
      "assignment:9",
      "profile:7",
      "media:11",
    ]);
  });

  it("maps missing and stale owner facts to exact blockers without a snapshot", async () => {
    expect(BOOKING_DESIGN_READINESS_BLOCKER_CODES).toEqual([
      "booking_design_missing",
      "booking_design_profile_missing",
      "booking_design_profile_stale",
      "booking_design_cover_assignment_missing",
      "booking_design_cover_assignment_stale",
      "booking_design_safe_media_missing",
      "booking_design_safe_media_stale",
    ]);
    await expect(
      provider({
        design: { getCurrentDesign: vi.fn().mockResolvedValue(null) },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toEqual({
      outcome: "blocked",
      ...scope,
      blocker: { code: "booking_design_missing", evidencePort: "design" },
    });
    const cases = [
      ["profile", "missing", "booking_design_profile_missing"],
      ["profile", "stale", "booking_design_profile_stale"],
      ["cover_assignment", "missing", "booking_design_cover_assignment_missing"],
      ["cover_assignment", "stale", "booking_design_cover_assignment_stale"],
      ["safe_media", "missing", "booking_design_safe_media_missing"],
      ["safe_media", "stale", "booking_design_safe_media_stale"],
    ] as const;
    for (const [port, outcome, code] of cases) {
      const failure = { outcome, evidencePort: port, code: "owner_code" };
      const overrides =
        port === "profile"
          ? {
              profile: {
                bookingDesignCatalogEvidencePort: "profile",
                getBookingDesignProfileEvidence: vi.fn().mockResolvedValue(failure),
              },
            }
          : port === "cover_assignment"
            ? {
                coverAssignment: {
                  bookingDesignCatalogEvidencePort: "cover_assignment",
                  getBookingDesignCoverAssignmentEvidence: vi.fn().mockResolvedValue(failure),
                },
              }
            : {
                coverAssignment: {
                  bookingDesignCatalogEvidencePort: "cover_assignment",
                  getBookingDesignCoverAssignmentEvidence: vi
                    .fn()
                    .mockResolvedValue(assignment({ mediaObjectId, altText: null })),
                },
                safeMedia: {
                  bookingDesignCatalogEvidencePort: "safe_media",
                  getBookingDesignSafeMediaEvidence: vi.fn().mockResolvedValue(failure),
                },
              };
      await expect(provider(overrides).result.getBookingDesignReadiness(scope)).resolves.toEqual({
        outcome: "blocked",
        ...scope,
        blocker: { code, evidencePort: port },
      });
    }
  });

  it("keeps malformed, unavailable, and thrown dependencies as provider failures", async () => {
    expect(BOOKING_DESIGN_PROVIDER_FAILURE_CODES).toEqual([
      "booking_design_request_invalid",
      "booking_design_revision_invalid",
      "booking_design_revision_unavailable",
      "booking_design_profile_invalid",
      "booking_design_profile_unavailable",
      "booking_design_cover_assignment_invalid",
      "booking_design_cover_assignment_unavailable",
      "booking_design_safe_media_invalid",
      "booking_design_safe_media_unavailable",
    ]);
    await expect(
      provider({
        profile: {
          bookingDesignCatalogEvidencePort: "profile",
          getBookingDesignProfileEvidence: vi.fn().mockResolvedValue({ ...profile(), extra: true }),
        },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toEqual({
      outcome: "provider_failure",
      ...scope,
      error: {
        code: "booking_design_profile_invalid",
        evidencePort: "profile",
        errorSource: "provider",
      },
    });
    await expect(
      provider({
        coverAssignment: {
          bookingDesignCatalogEvidencePort: "cover_assignment",
          getBookingDesignCoverAssignmentEvidence: vi.fn().mockResolvedValue({
            outcome: "unavailable",
            evidencePort: "cover_assignment",
            code: "owner_unavailable",
            errorSource: "provider",
          }),
        },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toMatchObject({
      outcome: "provider_failure",
      error: { code: "booking_design_cover_assignment_unavailable", errorSource: "provider" },
    });
    await expect(
      provider({
        design: { getCurrentDesign: vi.fn().mockRejectedValue(new Error("secret")) },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toMatchObject({
      outcome: "provider_failure",
      error: { code: "booking_design_revision_unavailable", errorSource: "system" },
    });

    const hostileEvidence = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("secret from owner parser");
        },
      },
    );
    await expect(
      provider({
        profile: {
          bookingDesignCatalogEvidencePort: "profile",
          getBookingDesignProfileEvidence: vi.fn().mockResolvedValue(hostileEvidence),
        },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toEqual({
      outcome: "provider_failure",
      ...scope,
      error: {
        code: "booking_design_profile_invalid",
        evidencePort: "profile",
        errorSource: "provider",
      },
    });
  });

  it("fails closed on invalid or cross-scoped values", async () => {
    await expect(
      provider().result.getBookingDesignReadiness({ ...scope, propertyId: "invalid" }),
    ).resolves.toMatchObject({
      outcome: "provider_failure",
      propertyId: "",
      error: { code: "booking_design_request_invalid" },
    });
    await expect(
      provider({
        design: {
          getCurrentDesign: vi.fn().mockResolvedValue({ ...design(), propertyId: mediaObjectId }),
        },
      }).result.getBookingDesignReadiness(scope),
    ).resolves.toMatchObject({
      outcome: "provider_failure",
      error: { code: "booking_design_revision_invalid" },
    });
  });
});
