import { describe, expect, it, vi } from "vitest";

const createMarketplaceCollaborationMock = vi.hoisted(() => vi.fn());

vi.mock("@vayada/marketplace-shared/api/collaborations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vayada/marketplace-shared/api/collaborations")>();
  return { ...actual, createMarketplaceCollaboration: createMarketplaceCollaborationMock };
});

import type { CollaborationOffering } from "@/lib/types";
import { toLegacyCollaborationType } from "@vayada/marketplace-shared/api/collaborations";
import { collaborationService, toCreatorCompensationTerms } from "./collaborations";

describe("toLegacyCollaborationType", () => {
  it("preserves primary compensation when affiliate terms are additive", () => {
    expect(toLegacyCollaborationType("free_stay", true, "12.5")).toBe("Free Stay");
  });

  it("uses Affiliate only for complete affiliate-only terms", () => {
    expect(toLegacyCollaborationType(null, true, "12.5")).toBe("Affiliate");
    expect(toLegacyCollaborationType("free_stay", true, null)).toBe("Free Stay");
    expect(toLegacyCollaborationType(null, true, null)).toBeNull();
  });
});

describe("creator collaboration applications", () => {
  it("sends the selected compensation terms without a client-provided creator ID", async () => {
    const paidOption: CollaborationOffering = {
      id: "paid-option",
      listing_id: "offer-one",
      collaboration_type: "Paid",
      availability_months: ["September"],
      platforms: ["Instagram"],
      paid_max_amount: 350,
      currency: "EUR",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    createMarketplaceCollaborationMock.mockRejectedValueOnce(new Error("stop after request"));

    await expect(
      collaborationService.create({
        initiator_type: "creator",
        listing_id: "offer-one",
        why_great_fit: "A strong match for my audience.",
        consent: true,
        ...toCreatorCompensationTerms(paidOption),
        platform_deliverables: [
          { platform: "Instagram", deliverables: [{ type: "Reel", quantity: 1 }] },
        ],
      }),
    ).rejects.toThrow("stop after request");

    expect(createMarketplaceCollaborationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId: "offer-one",
        creatorId: undefined,
        initiatorSide: "creator",
        terms: expect.objectContaining({
          compensationType: "paid",
          paidAmount: "350",
          currency: "EUR",
        }),
      }),
    );
  });
});
