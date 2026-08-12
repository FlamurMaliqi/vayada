import {
  BOOKING_DESIGN_CONTRACT_VERSION,
  BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
} from "@vayada/domain-booking";
import { HOTEL_CATALOG_STEP1_CONTRACT_VERSION } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import type { HotelCatalogStep1State } from "./domains/hotelCatalogStep1Repository.js";
import { createPropertySetupBookingStateProvider } from "./platform/propertySetupBookingState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup Booking owner state", () => {
  it("returns the stable exact design and Catalog manifest", async () => {
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(provider.getOwnerState(request(["booking_design"]))).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          state: "complete",
          sourceRevision: "design:2",
          currentBaseRevisions: {
            "booking.design": "design:2",
            "hotel_catalog.profile": "profile:5",
            "hotel_catalog.media": "profile:5",
          },
        },
      ],
    });
  });

  it("consumes the exact six-key guest manifest without partial Booking state", async () => {
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestPolicy: { getCurrentGuestPolicyOwnerEvidence: vi.fn(async () => guestEvidence()) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "booking_design", sourceRevision: "design:2" },
        {
          stepId: "guest_experience",
          state: "complete",
          sourceRevision: "guest-policy:3",
          currentBaseRevisions: guestEvidence().currentBaseRevisions,
        },
      ],
    });
  });

  it("maps only the typed first-visit absence source to not started", async () => {
    const absent = guestEvidence("guest-policy:absent");
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestPolicy: { getCurrentGuestPolicyOwnerEvidence: vi.fn(async () => absent) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "booking_design", state: "complete" },
        {
          stepId: "guest_experience",
          state: "not_started",
          sourceRevision: "guest-policy:absent",
          currentBaseRevisions: absent.currentBaseRevisions,
        },
      ],
    });
  });

  it("fails closed on a Booking design revision race", async () => {
    const getCurrentDesign = vi
      .fn()
      .mockResolvedValueOnce(design(2))
      .mockResolvedValueOnce(design(3));
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(provider.getOwnerState(request(["booking_design"]))).resolves.toEqual({
      outcome: "provider_failure",
    });
    expect(getCurrentDesign).toHaveBeenCalledTimes(2);
  });

  it("fails before owner reads when required guest evidence is absent", async () => {
    const getCurrentDesign = vi.fn(async () => design(2));
    const provider = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign },
      catalog: { getState: vi.fn(async () => catalog()) },
    });

    await expect(
      provider.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toEqual({ outcome: "provider_failure" });
    expect(getCurrentDesign).not.toHaveBeenCalled();
  });

  it("fails closed on a guest-policy evidence race", async () => {
    const getCurrentGuestPolicyOwnerEvidence = vi
      .fn()
      .mockResolvedValueOnce(guestEvidence())
      .mockResolvedValueOnce({
        ...guestEvidence(),
        currentBaseRevisions: {
          ...guestEvidence().currentBaseRevisions,
          "hotel_catalog.policy": "policy:8",
        },
      });
    const guestRace = createPropertySetupBookingStateProvider({
      design: { getCurrentDesign: vi.fn(async () => design(2)) },
      catalog: { getState: vi.fn(async () => catalog()) },
      guestPolicy: { getCurrentGuestPolicyOwnerEvidence },
    });
    await expect(
      guestRace.getOwnerState(request(["booking_design", "guest_experience"])),
    ).resolves.toEqual({ outcome: "provider_failure" });
    expect(getCurrentGuestPolicyOwnerEvidence).toHaveBeenCalledTimes(2);
  });
});

function request(stepIds: ("booking_design" | "guest_experience")[]) {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["hotel_operations"] as const,
    expectedTrackRevision: 3,
    stepIds,
  };
}

function guestEvidence(
  revision: "guest-policy:absent" | `guest-policy:${number}` = "guest-policy:3",
) {
  return {
    outcome: "available" as const,
    organizationId,
    propertyId,
    currentBaseRevisions: {
      "booking.guest_experience": revision,
      "pms.pricing_settings": "pricing:4",
      "pms.rate_plans": "rate-plans:5",
      "pms.room_types": "room-types:6",
      "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r7`,
      "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r7`,
    },
  };
}

function design(revision: number) {
  return {
    contractVersion: BOOKING_DESIGN_CONTRACT_VERSION,
    propertyId,
    revision,
    choices: {
      primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
      fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
    },
    createdAt: "2026-08-04T12:00:00.000Z",
  };
}

function catalog(): HotelCatalogStep1State {
  return {
    readModel: {
      contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
      propertyId,
      displayName: "Hotel Example",
      profileRevision: 5,
      supportedLocales: ["en"],
      profile: {
        locale: "en",
        shortDescription: "A".repeat(50),
        publicSlug: "hotel-example",
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      },
      baseRevisions: {
        "hotel_catalog.profile": "profile:5",
        "hotel_catalog.media": "profile:5",
        "hotel_catalog.amenities": "profile:5",
      },
    },
    presentationAssignments: [],
  };
}
