import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdaptiveSetupStepRenderContext } from "./AdaptiveHotelSetupController";

const calls = vi.hoisted(() => ({
  presentation: vi.fn(),
  marketplace: vi.fn(),
  booking: vi.fn(),
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

import { AdaptiveSetupStepFormDispatcher } from "./AdaptiveSetupStepFormDispatcher";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("AdaptiveSetupStepFormDispatcher", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["present_hotel", "presentation"],
    ["marketplace_preferences", "marketplace"],
    ["booking_design", "booking"],
  ] as const)("dispatches %s with the stable shared component contract", async (stepId, target) => {
    let renderer: ReactTestRenderer | undefined;
    const registerBeforeLeave = vi.fn(() => vi.fn());
    const props = { ...context(stepId), propertyId, registerBeforeLeave };
    await act(async () => {
      renderer = create(createElement(AdaptiveSetupStepFormDispatcher, props));
    });

    expect(calls[target]).toHaveBeenCalledWith(expect.objectContaining(props));
    expect(calls.presentation).toHaveBeenCalledTimes(target === "presentation" ? 1 : 0);
    expect(calls.marketplace).toHaveBeenCalledTimes(target === "marketplace" ? 1 : 0);
    expect(calls.booking).toHaveBeenCalledTimes(target === "booking" ? 1 : 0);
    renderer?.unmount();
  });

  it("returns null for room and future step-owned dispatchers", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(AdaptiveSetupStepFormDispatcher, {
          ...context("pricing"),
          propertyId,
          registerBeforeLeave: vi.fn(() => vi.fn()),
        }),
      );
    });
    expect(renderer?.toJSON()).toBeNull();
    expect(calls.presentation).not.toHaveBeenCalled();
    expect(calls.marketplace).not.toHaveBeenCalled();
    expect(calls.booking).not.toHaveBeenCalled();
    renderer?.unmount();
  });
});

function context(
  stepId: "present_hotel" | "marketplace_preferences" | "booking_design" | "pricing",
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
    progress: { complete: 0, total: 4 },
    steps: ["present_hotel", "marketplace_preferences", "booking_design", "pricing"].map(
      (stepId, index) => ({
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
                : "pricing:0",
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
                : {
                    "pms.pricing_settings": "pricing-settings:1",
                    "pms.rate_plans": "rate-plans:1",
                    "pms.rate_rules": "rate-rules:1",
                  },
        draft: null,
        blockers: [],
      }),
    ),
  };
}
