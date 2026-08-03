import { describe, expect, expectTypeOf, it } from "vitest";

import type { ResolvedPublicHotelMedia } from "@vayada/domain-hotels";

import {
  BOOKING_DESIGN_COVER_FALLBACK_PATH,
  BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
  parseBookingDesignCatalogCoverAssignmentEvidenceResult,
  parseBookingDesignCatalogProfileEvidenceResult,
  parseBookingDesignCatalogSafeMediaEvidenceResult,
  type BookingDesignCatalogCoverAssignmentEvidence,
  type BookingDesignCatalogCoverAssignmentEvidencePort,
  type BookingDesignCatalogEvidenceFailure,
  type BookingDesignCatalogProfileEvidence,
  type BookingDesignCatalogProfileEvidencePort,
  type BookingDesignCatalogSafeMediaEvidence,
  type BookingDesignCatalogSafeMediaEvidencePort,
} from "./bookingDesignSnapshot.js";

const organizationId = "abcdef10-0000-4000-8000-000000000001";
const propertyId = "abcdef00-0000-4000-8000-000000000002";
const mediaObjectId = "abcdef20-0000-4000-8000-000000000003";
const scope = { organizationId, propertyId };
const source = (entityType: string, entityId: string, revision: string) => ({
  ownerDomain: "hotel_catalog",
  entityType,
  entityId,
  revision,
});
const profileEvidence = () => ({
  outcome: "evidence",
  evidencePort: "profile",
  organizationId,
  propertyId,
  source: source("property_profile", propertyId, "profile:7"),
  profile: {
    contractVersion: "hotel-catalog-step1.v1",
    profileRevision: 7,
    displayName: "Hotel Alpenrose",
    contentLocale: "en",
    shortDescription:
      "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
  },
});
const coverEvidence = (cover: null | { mediaObjectId: string; altText: string | null } = null) => ({
  outcome: "evidence",
  evidencePort: "cover_assignment",
  organizationId,
  propertyId,
  source: source("property_media_assignment", propertyId, "assignment:9"),
  cover,
});
const mediaEvidence = () => ({
  outcome: "evidence",
  evidencePort: "safe_media",
  organizationId,
  propertyId,
  source: source("property_safe_media", mediaObjectId, "media:11"),
  media: {
    mediaObjectId,
    ownerOrganizationId: organizationId,
    propertyId,
    purpose: "property.hero_image",
    publicVariants: [
      { variantName: "original_safe", publicUrl: "https://cdn.vayada.test/cover.webp" },
    ],
  },
});
describe("Booking design renderer evidence contract", () => {
  it("locks the renderer version and exact public no-cover fallback", () => {
    expect(BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION).toBe("booking-design-renderer.v1");
    expect(BOOKING_DESIGN_COVER_FALLBACK_PATH).toBe("/vayada-logo.png");
  });

  it("keeps explicit no-cover distinct from missing owner evidence", () => {
    expectTypeOf<BookingDesignCatalogCoverAssignmentEvidence["cover"]>().toEqualTypeOf<Readonly<{
      mediaObjectId: string;
      altText: string | null;
    }> | null>();
    expectTypeOf<
      BookingDesignCatalogEvidenceFailure<"cover_assignment">["outcome"]
    >().toEqualTypeOf<"missing" | "stale" | "unavailable">();
  });

  it("prevents structurally identical Catalog ports from being interchanged", () => {
    expectTypeOf<
      BookingDesignCatalogProfileEvidencePort["bookingDesignCatalogEvidencePort"]
    >().toEqualTypeOf<"profile">();
    expectTypeOf<
      BookingDesignCatalogCoverAssignmentEvidencePort["bookingDesignCatalogEvidencePort"]
    >().toEqualTypeOf<"cover_assignment">();
    expectTypeOf<
      BookingDesignCatalogSafeMediaEvidencePort["bookingDesignCatalogEvidencePort"]
    >().toEqualTypeOf<"safe_media">();
    expectTypeOf<BookingDesignCatalogProfileEvidence["profile"]>().toMatchTypeOf<
      Readonly<{
        contractVersion: "hotel-catalog-step1.v1";
        profileRevision: number;
        displayName: string;
        contentLocale: string;
        shortDescription: string;
      }>
    >();
    expectTypeOf<
      BookingDesignCatalogSafeMediaEvidence["media"]
    >().toEqualTypeOf<ResolvedPublicHotelMedia>();
    type SafeMediaRequest = Parameters<
      BookingDesignCatalogSafeMediaEvidencePort["getBookingDesignSafeMediaEvidence"]
    >[0];
    if (false) {
      const request = {} as SafeMediaRequest;
      // @ts-expect-error Safe-media evidence scope is immutable.
      request.mediaObjectId = "changed";
    }
  });

  it("snapshots current profile and explicit no-cover evidence with exact revisions", () => {
    const profile = parseBookingDesignCatalogProfileEvidenceResult(profileEvidence(), {
      organizationId: organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
    });
    const noCover = parseBookingDesignCatalogCoverAssignmentEvidenceResult(coverEvidence(), scope);
    const missing = parseBookingDesignCatalogCoverAssignmentEvidenceResult(
      { outcome: "missing", evidencePort: "cover_assignment", code: "assignment_missing" },
      scope,
    );
    expect(profile).toMatchObject({
      outcome: "evidence",
      organizationId,
      propertyId,
      source: { entityType: "property_profile", revision: "profile:7" },
    });
    expect(noCover).toMatchObject({
      outcome: "evidence",
      source: { entityType: "property_media_assignment", revision: "assignment:9" },
      cover: null,
    });
    expect(missing).toEqual({
      outcome: "missing",
      evidencePort: "cover_assignment",
      code: "assignment_missing",
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile?.outcome === "evidence" ? profile.profile : null)).toBe(true);
  });

  it("accepts only exact port failures and fails closed on malformed owner evidence", () => {
    for (const failure of [
      { outcome: "missing", evidencePort: "profile", code: "profile_missing" },
      { outcome: "stale", evidencePort: "profile", code: "profile_stale" },
      {
        outcome: "unavailable",
        evidencePort: "profile",
        code: "profile_unavailable",
        errorSource: "provider",
      },
    ]) {
      expect(parseBookingDesignCatalogProfileEvidenceResult(failure, scope)).toEqual(failure);
    }
    const profile = profileEvidence();
    for (const malformed of [
      { ...profile, propertyId: mediaObjectId },
      { ...profile, source: { ...profile.source, revision: "profile:8" } },
      { ...profile, profile: { ...profile.profile, shortDescription: "too short" } },
      {
        ...profile,
        profile: { ...profile.profile, shortDescription: ` ${profile.profile.shortDescription} ` },
      },
      { ...profile, ignored: true },
      Object.assign(Object.create({}), profile),
      { outcome: "missing", evidencePort: "cover_assignment", code: "profile_missing" },
      { outcome: "unavailable", evidencePort: "profile", code: "bad", errorSource: "network" },
    ]) {
      expect(parseBookingDesignCatalogProfileEvidenceResult(malformed, scope)).toBeNull();
    }
    const accessor = profileEvidence();
    Object.defineProperty(accessor, "profile", { enumerable: true, get: () => profile.profile });
    expect(parseBookingDesignCatalogProfileEvidenceResult(accessor, scope)).toBeNull();
  });

  it("normalizes assigned-cover identity and rejects malformed assignments", () => {
    const cover = parseBookingDesignCatalogCoverAssignmentEvidenceResult(
      coverEvidence({ mediaObjectId: mediaObjectId.toUpperCase(), altText: "Hotel at sunrise" }),
      scope,
    );
    expect(cover).toMatchObject({ outcome: "evidence", cover: { mediaObjectId } });
    for (const malformed of [
      coverEvidence({ mediaObjectId: "invalid", altText: null }),
      coverEvidence({ mediaObjectId, altText: "x".repeat(501) }),
      { ...coverEvidence(), propertyId: mediaObjectId },
      { ...coverEvidence(), source: source("wrong_type", propertyId, "assignment:9") },
    ]) {
      expect(parseBookingDesignCatalogCoverAssignmentEvidenceResult(malformed, scope)).toBeNull();
    }
  });

  it("snapshots only scoped, public, renderer-safe assigned media", () => {
    const media = parseBookingDesignCatalogSafeMediaEvidenceResult(mediaEvidence(), {
      ...scope,
      mediaObjectId: mediaObjectId.toUpperCase(),
    });
    expect(media).toMatchObject({
      outcome: "evidence",
      source: { entityId: mediaObjectId, revision: "media:11" },
      media: { mediaObjectId, ownerOrganizationId: organizationId, propertyId },
    });
    expect(Object.isFrozen(media?.outcome === "evidence" ? media.media : null)).toBe(true);
    expect(Object.isFrozen(media?.outcome === "evidence" ? media.media.publicVariants : null)).toBe(
      true,
    );
    expect(
      parseBookingDesignCatalogSafeMediaEvidenceResult(
        { outcome: "stale", evidencePort: "safe_media", code: "media_stale" },
        { ...scope, mediaObjectId },
      ),
    ).toEqual({ outcome: "stale", evidencePort: "safe_media", code: "media_stale" });
  });

  it("rejects malformed, cross-scope, non-public, and raw safe-media evidence", () => {
    const valid = mediaEvidence();
    for (const malformed of [
      { ...valid, organizationId: mediaObjectId },
      { ...valid, source: { ...valid.source, entityId: propertyId } },
      { ...valid, media: { ...valid.media, purpose: "pms.room_type.media" } },
      { ...valid, media: { ...valid.media, publicVariants: [] } },
      {
        ...valid,
        media: {
          ...valid.media,
          publicVariants: [
            { variantName: "original_safe", publicUrl: "http://cdn.vayada.test/cover.webp" },
          ],
        },
      },
      { ...valid, media: { ...valid.media, rawUrl: "https://private.test/raw" } },
    ]) {
      expect(
        parseBookingDesignCatalogSafeMediaEvidenceResult(malformed, { ...scope, mediaObjectId }),
      ).toBeNull();
    }
    const accessor = mediaEvidence();
    Object.defineProperty(accessor.media.publicVariants, "0", {
      enumerable: true,
      get: () => {
        throw new Error("must not read accessors");
      },
    });
    expect(
      parseBookingDesignCatalogSafeMediaEvidenceResult(accessor, { ...scope, mediaObjectId }),
    ).toBeNull();
    const poisoned = mediaEvidence();
    Object.setPrototypeOf(
      poisoned.media.publicVariants,
      Object.create(Array.prototype, {
        map: {
          get: () => {
            throw new Error("must not use inherited array methods");
          },
        },
      }),
    );
    expect(
      parseBookingDesignCatalogSafeMediaEvidenceResult(poisoned, { ...scope, mediaObjectId }),
    ).toBeNull();
  });
});
