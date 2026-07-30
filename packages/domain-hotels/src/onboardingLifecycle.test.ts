import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MARKETPLACE_ACTIVATION_STATUSES,
  MARKETPLACE_MODERATION_STATUSES,
  type BookingActiveContentPointer,
  type BookingContentRevisionId,
  type MarketplaceSubmissionLifecyclePort,
  type MarketplaceSubmissionActivation,
  type MarketplaceSubmissionRevisionId,
  type OnboardingLifecycleJsonValue,
  type ReadyProductReadinessEvidence,
} from "./onboardingLifecycle.js";

type MarketplaceAppendInput = Parameters<
  MarketplaceSubmissionLifecyclePort["appendRevision"]
>[0];

function assertCompileTimeLifecycleBoundaries(
  bookingEvidence: ReadyProductReadinessEvidence<"booking">,
  marketplaceInput: MarketplaceAppendInput,
): void {
  // @ts-expect-error Booking readiness cannot seed a Marketplace revision.
  const marketplaceEvidence: MarketplaceAppendInput["readiness"] = bookingEvidence;
  // @ts-expect-error Hashed manifest sources are deeply immutable.
  marketplaceInput.readiness.sourceManifest.sources[0]!.revision = "mutated";
  void marketplaceEvidence;
}

void assertCompileTimeLifecycleBoundaries;

describe("onboarding publication lifecycle contracts", () => {
  it("keeps Marketplace moderation explicit", () => {
    expect(MARKETPLACE_MODERATION_STATUSES).toEqual([
      "pending",
      "changes_requested",
      "approved",
      "rejected",
      "withdrawn",
    ]);
    expect(MARKETPLACE_ACTIVATION_STATUSES).toEqual(["active", "suspended", "deactivated"]);
  });

  it("does not allow Marketplace and Booking revision identities to mix", () => {
    expectTypeOf<MarketplaceSubmissionRevisionId>().not.toEqualTypeOf<BookingContentRevisionId>();
    expectTypeOf<MarketplaceSubmissionActivation["revisionId"]>().not.toEqualTypeOf<
      BookingActiveContentPointer["revisionId"]
    >();
    expectTypeOf<MarketplaceAppendInput["readiness"]["product"]>().toEqualTypeOf<"marketplace">();
    expectTypeOf<MarketplaceAppendInput["readiness"]["status"]>().toEqualTypeOf<"ready">();
    expectTypeOf<Date>().not.toMatchTypeOf<OnboardingLifecycleJsonValue>();
  });
});
