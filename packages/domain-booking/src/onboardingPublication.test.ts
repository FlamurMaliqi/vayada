import type { ProductReadinessResult } from "@vayada/domain-hotels";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BOOKING_PUBLICATION_FAILURE_CODES,
  BOOKING_PUBLICATION_OPERATION_STATUSES,
  type BookingPublicationOperation,
  type ReadyBookingPublicationEvidence,
} from "./onboardingPublication.js";

function assertBookingEvidenceBoundary(readiness: ProductReadinessResult): void {
  // @ts-expect-error Non-narrowed readiness cannot request Booking publication.
  const evidence: ReadyBookingPublicationEvidence = readiness;
  void evidence;
}

void assertBookingEvidenceBoundary;

describe("Booking onboarding publication contract", () => {
  it("keeps externally uncertain operation states explicit", () => {
    expect(BOOKING_PUBLICATION_OPERATION_STATUSES).toEqual([
      "pending",
      "succeeded",
      "failed",
      "unknown",
    ]);
    expect(BOOKING_PUBLICATION_FAILURE_CODES).toEqual([
      "external_result_unconfirmed",
      "projection_failed",
      "source_content_changed",
    ]);
  });

  it("keeps recovery reads free of readiness and unpublished content", () => {
    expectTypeOf<BookingPublicationOperation>().not.toHaveProperty("readiness");
    expectTypeOf<BookingPublicationOperation>().not.toHaveProperty("sourceManifest");
    expectTypeOf<BookingPublicationOperation>().not.toHaveProperty("publicContent");
  });
});
