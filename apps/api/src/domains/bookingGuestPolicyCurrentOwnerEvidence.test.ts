import type {
  BookingGuestPolicyCatalogCurrentOwnerEvidencePort,
  BookingGuestPolicyPmsCurrentOwnerEvidencePort,
  BookingGuestPolicyReadPort,
  BookingGuestPolicyRevision,
} from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import { createBookingGuestPolicyCurrentOwnerEvidenceAdapter } from "./bookingGuestPolicyCurrentOwnerEvidence.js";

const organizationId = "b1000000-0000-4000-8000-000000000002";
const propertyId = "b1000000-0000-4000-8000-000000000003";

describe("Booking guest-policy current owner evidence adapter", () => {
  it("fails closed with deterministic owner failures", async () => {
    const booking = vi
      .fn<BookingGuestPolicyReadPort["getCurrentGuestPolicy"]>()
      .mockResolvedValue(null);
    const pms = pmsPort({ outcome: "missing" });
    const catalog = catalogPort({ outcome: "unavailable", errorSource: "provider" });
    const adapter = createBookingGuestPolicyCurrentOwnerEvidenceAdapter({
      booking: { getCurrentGuestPolicy: booking },
      pms,
      catalog,
    });

    await expect(
      adapter.getCurrentGuestPolicyOwnerEvidence({ organizationId, propertyId }),
    ).resolves.toEqual({
      outcome: "unavailable",
      organizationId,
      propertyId,
      failures: [
        { owner: "booking", outcome: "missing" },
        { owner: "pms", outcome: "missing" },
        { owner: "hotel_catalog", outcome: "unavailable", errorSource: "provider" },
      ],
    });
    expect(booking).toHaveBeenCalledWith({ organizationId, propertyId });
  });

  it("rejects scope escapes, extra revision groups, and malformed Booking revisions", async () => {
    const booking: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy"> = {
      async getCurrentGuestPolicy() {
        return {} as BookingGuestPolicyRevision;
      },
    };
    const pms = pmsPort({
      outcome: "available",
      evidence: {
        organizationId,
        propertyId,
        revisions: {
          "pms.pricing_settings": "pricing-settings:2",
          "pms.rate_plans": "rate-plans:4",
          "pms.room_types": "room-types:6",
          extra: "forbidden:1",
        },
      },
    } as never);
    const catalog = catalogPort({
      outcome: "available",
      evidence: {
        organizationId,
        propertyId: "b1000000-0000-4000-8000-000000000009",
        revisions: {
          "hotel_catalog.location": "location:3",
          "hotel_catalog.policy": "policy:7",
        },
      },
    });

    await expect(
      createBookingGuestPolicyCurrentOwnerEvidenceAdapter({
        booking,
        pms,
        catalog,
      }).getCurrentGuestPolicyOwnerEvidence({ organizationId, propertyId }),
    ).resolves.toEqual({
      outcome: "unavailable",
      organizationId,
      propertyId,
      failures: [
        { owner: "booking", outcome: "malformed" },
        { owner: "pms", outcome: "malformed" },
        { owner: "hotel_catalog", outcome: "malformed" },
      ],
    });
  });
});

function pmsPort(
  result: Awaited<
    ReturnType<BookingGuestPolicyPmsCurrentOwnerEvidencePort["getCurrentGuestPolicyBaseRevisions"]>
  >,
): BookingGuestPolicyPmsCurrentOwnerEvidencePort {
  return {
    bookingGuestPolicyCurrentOwnerEvidencePort: "pms",
    async getCurrentGuestPolicyBaseRevisions() {
      return result;
    },
  };
}

function catalogPort(
  result: Awaited<
    ReturnType<
      BookingGuestPolicyCatalogCurrentOwnerEvidencePort["getCurrentGuestPolicyBaseRevisions"]
    >
  >,
): BookingGuestPolicyCatalogCurrentOwnerEvidencePort {
  return {
    bookingGuestPolicyCurrentOwnerEvidencePort: "hotel_catalog",
    async getCurrentGuestPolicyBaseRevisions() {
      return result;
    },
  };
}
