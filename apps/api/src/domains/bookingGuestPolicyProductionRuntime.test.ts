import { createBookingPricingSourceFingerprint } from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import {
  choices,
  now,
  organizationId,
  pricingEvidence,
  propertyId,
} from "../bookingGuestPolicyTestFixtures.js";
import type { BookingGuestPolicyCatalogProfileEvidencePool } from "./bookingGuestPolicyCatalogProfileEvidence.js";
import type { BookingGuestPolicyRepository } from "./bookingGuestPolicyRepository.js";
import { createBookingGuestPolicyProductionApplication } from "./bookingGuestPolicyProductionRuntime.js";

describe("Booking guest-policy production application", () => {
  it("composes the repository and exact owner evidence ports", async () => {
    const evidence = pricingEvidence();
    const getCurrentGuestPolicy = vi.fn(async () => null);
    const ownerCalls = {
      rooms: vi.fn(async () => evidence.roomPublication),
      pricing: vi.fn(async () => evidence.pricing),
      recurring: vi.fn(async () => evidence.recurringPricing),
      confirmation: vi.fn(async () => ({
        outcome: "available" as const,
        evidence: {
          organizationId,
          propertyId,
          pricingSourceFingerprint: createBookingPricingSourceFingerprint(
            { organizationId, propertyId },
            evidence,
          ),
          confirmationRevision: 6,
          confirmedAt: now,
        },
      })),
    };
    const application = createBookingGuestPolicyProductionApplication({
      repository: { getCurrentGuestPolicy } as unknown as BookingGuestPolicyRepository,
      catalogPool: {
        async query() {
          return {
            rows: [{ propertyId, profileRevision: 8, timeZone: "Europe/Berlin" }],
            rowCount: 1,
          };
        },
      } as unknown as BookingGuestPolicyCatalogProfileEvidencePool,
      ownerEvidence: {
        rooms: { getRoomPublicationSnapshot: ownerCalls.rooms },
        pricing: { getPricingSourceSnapshot: ownerCalls.pricing },
        recurringPricing: { getRecurringPricingBookingEvidence: ownerCalls.recurring },
        mandatoryChargeConfirmation: {
          bookingPricingConfirmationEvidencePort: "pms_mandatory_charges",
          getMandatoryChargeConfirmation: ownerCalls.confirmation,
        },
      },
      currentOwnerEvidence: {
        async getCurrentGuestPolicyOwnerEvidence() {
          throw new Error("not used by setup or preview");
        },
      },
    });

    await expect(application.getGuestPolicySetup({ organizationId, propertyId })).resolves.toEqual(
      expect.objectContaining({ propertyId, current: null, draft: expect.any(Object) }),
    );
    await expect(
      application.previewGuestPolicy({ organizationId, propertyId, choices }),
    ).resolves.toEqual(expect.objectContaining({ outcome: "ready" }));
    expect(getCurrentGuestPolicy).toHaveBeenCalledWith({ organizationId, propertyId });
    expect(Object.values(ownerCalls).map((call) => call.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });
});
