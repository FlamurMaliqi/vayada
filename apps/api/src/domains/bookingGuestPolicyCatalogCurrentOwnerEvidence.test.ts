import type { BookingGuestPolicyPmsCurrentOwnerEvidencePort } from "@vayada/domain-booking";
import type {
  HotelCatalogLocationCurrentOwnerEvidencePort,
  HotelCatalogPolicyCurrentOwnerEvidencePort,
} from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import { createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter } from "./bookingGuestPolicyCatalogCurrentOwnerEvidence.js";
import { createBookingGuestPolicyCurrentOwnerEvidenceAdapter } from "./bookingGuestPolicyCurrentOwnerEvidence.js";

const organizationId = "b1000000-0000-4000-8000-000000000002";
const propertyId = "b1000000-0000-4000-8000-000000000003";
const scope = { organizationId, propertyId };

describe("Booking guest-policy Catalog current-owner evidence adapter", () => {
  it("maps exact canonical location and policy revisions without synthesizing them", async () => {
    const location = locationPort(availableLocation(3));
    const policy = policyPort(availablePolicy(7));
    const adapter = createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
      location,
      policy,
    });

    await expect(adapter.getCurrentGuestPolicyBaseRevisions(scope)).resolves.toEqual({
      outcome: "available",
      evidence: {
        ...scope,
        revisions: {
          "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r3`,
          "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r7`,
        },
      },
    });
    expect(location.getCurrentLocationOwnerEvidence).toHaveBeenCalledWith(scope);
    expect(policy.getCurrentPolicyOwnerEvidence).toHaveBeenCalledWith(scope);
  });

  it("supplies the two canonical Catalog keys to the six-owner Booking aggregate", async () => {
    const catalog = createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
      location: locationPort(availableLocation(3)),
      policy: policyPort(availablePolicy(7)),
    });
    const aggregate = createBookingGuestPolicyCurrentOwnerEvidenceAdapter({
      booking: {
        async getCurrentGuestPolicy() {
          return null;
        },
      },
      pms: availablePmsPort(),
      catalog,
    });

    await expect(aggregate.getCurrentGuestPolicyOwnerEvidence(scope)).resolves.toEqual({
      outcome: "available",
      ...scope,
      currentBaseRevisions: {
        "booking.guest_experience": "guest-policy:absent",
        "pms.pricing_settings": "pricing-settings:2",
        "pms.rate_plans": "rate-plans:4",
        "pms.room_types": "room-types:6",
        "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r3`,
        "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r7`,
      },
    });
  });

  it("fails closed before calling owners for a malformed Booking scope", async () => {
    const location = locationPort(availableLocation(3));
    const policy = policyPort(availablePolicy(7));
    const adapter = createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
      location,
      policy,
    });

    await expect(
      adapter.getCurrentGuestPolicyBaseRevisions({ ...scope, propertyId: "wrong" }),
    ).resolves.toEqual({ outcome: "malformed" });
    expect(location.getCurrentLocationOwnerEvidence).not.toHaveBeenCalled();
    expect(policy.getCurrentPolicyOwnerEvidence).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed outranks missing",
      location: { outcome: "missing", reason: "owner_state" },
      policy: { outcome: "available", evidence: { ...availablePolicy(7).evidence, extra: true } },
      expected: { outcome: "malformed" },
    },
    {
      name: "system unavailability outranks provider unavailability",
      location: { outcome: "unavailable", errorSource: "provider" },
      policy: "throw",
      expected: { outcome: "unavailable", errorSource: "system" },
    },
    {
      name: "provider unavailability outranks missing",
      location: { outcome: "missing", reason: "property_scope" },
      policy: { outcome: "unavailable", errorSource: "provider" },
      expected: { outcome: "unavailable", errorSource: "provider" },
    },
    {
      name: "a missing owner remains missing",
      location: { outcome: "missing", reason: "owner_state" },
      policy: availablePolicy(7),
      expected: { outcome: "missing" },
    },
  ])("uses deterministic fail-closed precedence: $name", async ({ location, policy, expected }) => {
    const adapter = createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
      location: locationPort(location as never),
      policy: policyPort(
        policy === "throw"
          ? () => {
              throw new Error("Catalog timed out");
            }
          : (policy as never),
      ),
    });

    await expect(adapter.getCurrentGuestPolicyBaseRevisions(scope)).resolves.toEqual(expected);
  });

  it("strictly rejects cross-scope and non-canonical owner evidence", async () => {
    const adapter = createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
      location: locationPort({
        outcome: "available",
        evidence: {
          ...availableLocation(3).evidence,
          propertyId: "b1000000-0000-4000-8000-000000000009",
        },
      }),
      policy: policyPort({
        outcome: "available",
        evidence: {
          ...availablePolicy(7).evidence,
          baseRevision: `hotel_catalog.policy:${propertyId}:r6`,
        },
      }),
    });

    await expect(adapter.getCurrentGuestPolicyBaseRevisions(scope)).resolves.toEqual({
      outcome: "malformed",
    });
  });
});

function availableLocation(revision: number) {
  const sourceIdentity = `hotel_catalog.location:${propertyId}` as const;
  return {
    outcome: "available" as const,
    evidence: {
      ...scope,
      ownerKey: "hotel_catalog.location" as const,
      sourceIdentity,
      revision,
      baseRevision: `${sourceIdentity}:r${revision}` as const,
    },
  };
}

function availablePolicy(revision: number) {
  const sourceIdentity = `hotel_catalog.policy:${propertyId}` as const;
  return {
    outcome: "available" as const,
    evidence: {
      ...scope,
      ownerKey: "hotel_catalog.policy" as const,
      sourceIdentity,
      revision,
      baseRevision: `${sourceIdentity}:r${revision}` as const,
    },
  };
}

function availablePmsPort(): BookingGuestPolicyPmsCurrentOwnerEvidencePort {
  return {
    bookingGuestPolicyCurrentOwnerEvidencePort: "pms",
    async getCurrentGuestPolicyBaseRevisions() {
      return {
        outcome: "available",
        evidence: {
          ...scope,
          revisions: {
            "pms.pricing_settings": "pricing-settings:2",
            "pms.rate_plans": "rate-plans:4",
            "pms.room_types": "room-types:6",
          },
        },
      };
    },
  };
}

function locationPort(
  result:
    | Awaited<
        ReturnType<HotelCatalogLocationCurrentOwnerEvidencePort["getCurrentLocationOwnerEvidence"]>
      >
    | Promise<never>,
): HotelCatalogLocationCurrentOwnerEvidencePort {
  return {
    ownerKey: "hotel_catalog.location",
    getCurrentLocationOwnerEvidence: vi.fn(async () => result),
  };
}

function policyPort(
  result:
    | Awaited<
        ReturnType<HotelCatalogPolicyCurrentOwnerEvidencePort["getCurrentPolicyOwnerEvidence"]>
      >
    | (() => never),
): HotelCatalogPolicyCurrentOwnerEvidencePort {
  return {
    ownerKey: "hotel_catalog.policy",
    getCurrentPolicyOwnerEvidence: vi.fn(
      typeof result === "function" ? result : async () => result,
    ),
  };
}
