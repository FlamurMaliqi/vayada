import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdaptiveSetupStepRenderContext } from "./AdaptiveHotelSetupController";

const calls = vi.hoisted(() => ({
  presentation: vi.fn(),
  marketplace: vi.fn(),
  booking: vi.fn(),
  pricing: vi.fn(),
  calendar: vi.fn(),
}));

vi.mock("./presentation/PresentHotelStep", () => ({
  PresentHotelStep: (props: unknown) => {
    calls.presentation(props);
    return null;
  },
}));
vi.mock("./marketplace/MarketplacePreferencesStep", () => ({
  MarketplacePreferencesStep: (props: unknown) => {
    calls.marketplace(props);
    return null;
  },
}));
vi.mock("./booking/BookingDesignStep", () => ({
  BookingDesignStep: (props: unknown) => {
    calls.booking(props);
    return null;
  },
}));
vi.mock("./pricing/PricingStep", () => ({
  PricingStep: (props: unknown) => {
    calls.pricing(props);
    return null;
  },
}));
vi.mock("./calendar/CalendarStep", () => ({
  CalendarStep: (props: unknown) => {
    calls.calendar(props);
    return null;
  },
}));

import { AdaptiveSetupStepFormDispatcher } from "./AdaptiveSetupStepFormDispatcher";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("AdaptiveSetupStepFormDispatcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["present_hotel", "presentation"],
    ["marketplace_preferences", "marketplace"],
    ["booking_design", "booking"],
    ["pricing", "pricing"],
    ["calendar", "calendar"],
  ] as const)("dispatches %s with the stable shared component contract", async (stepId, target) => {
    let renderer: ReactTestRenderer | undefined;
    const registerBeforeLeave = vi.fn(() => vi.fn());
    const props = { ...context(stepId), propertyId, registerBeforeLeave };
    await act(async () => {
      renderer = create(createElement(AdaptiveSetupStepFormDispatcher, props));
    });

    expect(calls[target]).toHaveBeenCalledWith(expect.objectContaining(props));
    Object.entries(calls).forEach(([name, call]) => {
      expect(call).toHaveBeenCalledTimes(name === target ? 1 : 0);
    });
    renderer?.unmount();
  });

  it("returns null for the separately composed room step", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(AdaptiveSetupStepFormDispatcher, {
          ...context("rooms"),
          propertyId,
          registerBeforeLeave: vi.fn(() => vi.fn()),
        }),
      );
    });
    expect(renderer?.toJSON()).toBeNull();
    Object.values(calls).forEach((call) => expect(call).not.toHaveBeenCalled());
    renderer?.unmount();
  });
});

function context(
  stepId:
    | "present_hotel"
    | "marketplace_preferences"
    | "booking_design"
    | "rooms"
    | "pricing"
    | "calendar",
): AdaptiveSetupStepRenderContext {
  const route = setupRoute();
  return {
    route,
    step: route.steps.find((step) => step.stepId === stepId)!,
    interfaceLocale: "en",
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    reportRevisionConflict: vi.fn(),
  };
}

function setupRoute(): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v2",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    trackRevision: 2,
    sessionId: null,
    sessionRevision: null,
    resumeStepId: null,
    progress: { complete: 0, total: 6 },
    steps: [
      "present_hotel",
      "marketplace_preferences",
      "booking_design",
      "rooms",
      "pricing",
      "calendar",
    ].map((stepId, index) => ({
      stepId: stepId as PropertySetupRouteReadModel["steps"][number]["stepId"],
      position: index + 1,
      state: "not_started",
      sourceRevision:
        stepId === "present_hotel"
          ? "profile:7"
          : stepId === "marketplace_preferences"
            ? "preferences:0"
            : stepId === "booking_design"
              ? "design:0"
              : stepId === "rooms"
                ? "rooms:0"
                : stepId === "pricing"
                  ? "pricing:0"
                  : "calendar:0",
      currentBaseRevisions:
        stepId === "present_hotel"
          ? {
              "hotel_catalog.profile": "profile:7",
              "hotel_catalog.media": "profile:7",
              "hotel_catalog.amenities": "profile:7",
            }
          : stepId === "marketplace_preferences"
            ? { "marketplace.collaboration_preferences": "preferences:0" }
            : stepId === "booking_design"
              ? {
                  "booking.design": "design:0",
                  "hotel_catalog.profile": "profile:7",
                  "hotel_catalog.media": "profile:7",
                }
              : stepId === "rooms"
                ? {
                    "pms.room_types": "room-types:1",
                    "pms.room_units": "room-units:1",
                    "pms.room_media": "room-media:1",
                  }
                : stepId === "pricing"
                  ? {
                      "pms.pricing_settings": "pricing-settings:1",
                      "pms.rate_plans": "rate-plans:1",
                      "pms.rate_rules": "rate-rules:1",
                    }
                  : {
                      "pms.operating_calendar": "calendar:1",
                      "pms.inventory": "inventory:1",
                      "pms.room_types": "room-types:1",
                      "hotel_catalog.location": "location:1",
                    },
      draft: null,
      blockers: [],
    })),
  };
}
