import { describe, expect, expectTypeOf, it } from "vitest";

import type { ResolvedPublicHotelMedia } from "@vayada/domain-hotels";

import {
  BOOKING_DESIGN_COVER_FALLBACK_PATH,
  BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
  type BookingDesignCatalogCoverAssignmentEvidence,
  type BookingDesignCatalogCoverAssignmentEvidencePort,
  type BookingDesignCatalogEvidenceFailure,
  type BookingDesignCatalogProfileEvidence,
  type BookingDesignCatalogProfileEvidencePort,
  type BookingDesignCatalogSafeMediaEvidence,
  type BookingDesignCatalogSafeMediaEvidencePort,
} from "./bookingDesignSnapshot.js";

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
});
