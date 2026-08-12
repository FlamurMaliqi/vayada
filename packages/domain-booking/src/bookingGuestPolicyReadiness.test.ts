import { describe, expect, it } from "vitest";

import {
  evaluateBookingGuestPolicyReadiness,
  parseBookingGuestPolicyReadiness,
} from "./bookingGuestPolicyReadiness.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "20000000-0000-4000-8000-000000000002";

describe("Booking guest-policy readiness", () => {
  it("reports an explicit first-visit absence while retaining all live owner revisions", () => {
    const result = evaluateBookingGuestPolicyReadiness({
      organizationId,
      propertyId,
      current: null,
      composition: null,
      currentOwnerEvidence: availableEvidence(),
    });

    expect(result).toEqual({
      contractVersion: "booking-guest-policy-readiness.v1",
      organizationId,
      propertyId,
      status: "blocked",
      guestPolicySourceRevision: "guest-policy:absent",
      sourceFingerprint: null,
      currentBaseRevisions: availableEvidence().currentBaseRevisions,
      blockers: [{ code: "guest_policy_not_configured", kind: "user_fixable" }],
    });
    expect(parseBookingGuestPolicyReadiness(result)).toEqual(result);
    expect(Object.isFrozen(result.currentBaseRevisions)).toBe(true);
  });

  it("fails closed on scope escapes and malformed owner evidence", () => {
    const result = evaluateBookingGuestPolicyReadiness({
      organizationId,
      propertyId,
      current: null,
      composition: null,
      currentOwnerEvidence: {
        ...availableEvidence(),
        propertyId: "30000000-0000-4000-8000-000000000003",
      },
    });
    expect(result.currentBaseRevisions).toBeNull();
    expect(result.blockers).toContainEqual({
      code: "current_owner_evidence_malformed",
      kind: "provider_failure",
    });
    expect(
      parseBookingGuestPolicyReadiness({
        ...result,
        currentBaseRevisions: availableEvidence().currentBaseRevisions,
        guestPolicySourceRevision: "guest-policy:1",
      }),
    ).toBeNull();
  });

  it("rejects readiness that claims ready without exact current revisions", () => {
    expect(
      parseBookingGuestPolicyReadiness({
        contractVersion: "booking-guest-policy-readiness.v1",
        organizationId,
        propertyId,
        status: "ready",
        guestPolicySourceRevision: "guest-policy:1",
        sourceFingerprint: `sha256:${"0".repeat(64)}`,
        currentBaseRevisions: null,
        blockers: [],
      }),
    ).toBeNull();
  });
});

function availableEvidence() {
  return {
    outcome: "available" as const,
    organizationId,
    propertyId,
    currentBaseRevisions: {
      "booking.guest_experience": "guest-policy:absent" as const,
      "pms.pricing_settings": "pms.pricing_settings:2",
      "pms.rate_plans": "pms.rate_plans:3",
      "pms.room_types": "pms.room_types:4",
      "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r5`,
      "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r6`,
    },
  };
}
