import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_SETUP_STEP_COPY,
  ADAPTIVE_SETUP_STEP_IDS,
  resolveAdaptiveSetupActiveStep,
  resolveNextAdaptiveSetupStep,
  resolvePreviousAdaptiveSetupStep,
  resolveSupportedInterfaceLocale,
  type AdaptiveSetupNavigationStep,
} from "./adaptiveSetupNavigation";

const combinedSteps: AdaptiveSetupNavigationStep[] = [
  { stepId: "present_hotel", state: "complete" },
  { stepId: "marketplace_preferences", state: "draft" },
  { stepId: "booking_design", state: "not_started" },
  { stepId: "rooms", state: "not_started" },
  { stepId: "pricing", state: "not_started" },
  { stepId: "calendar", state: "not_started" },
  { stepId: "guest_experience", state: "not_started" },
  { stepId: "payments", state: "not_started" },
  { stepId: "review", state: "not_started" },
];

describe("resolveAdaptiveSetupActiveStep", () => {
  it("honors a requested active step before resume state", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: combinedSteps,
        requestedStepId: "pricing",
        resumeStepId: "marketplace_preferences",
      })?.stepId,
    ).toBe("pricing");
  });

  it("ignores requested steps that are not in the server route", () => {
    const marketplaceSteps = [combinedSteps[0]!, combinedSteps[1]!, combinedSteps[8]!];

    expect(
      resolveAdaptiveSetupActiveStep({
        steps: marketplaceSteps,
        requestedStepId: "pricing",
        resumeStepId: "marketplace_preferences",
      })?.stepId,
    ).toBe("marketplace_preferences");
  });

  it("uses the server resume step before scanning completion", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: combinedSteps,
        requestedStepId: "not-a-step",
        resumeStepId: "calendar",
      })?.stepId,
    ).toBe("calendar");
  });

  it("selects the first non-complete step in server order", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: combinedSteps,
        resumeStepId: "inactive-step",
      })?.stepId,
    ).toBe("marketplace_preferences");
  });

  it("selects review when every step is complete", () => {
    const completeSteps = combinedSteps.map((step) => ({ ...step, state: "complete" as const }));

    expect(resolveAdaptiveSetupActiveStep({ steps: completeSteps })?.stepId).toBe("review");
  });

  it("falls back to the final server step when a route has no review step", () => {
    const completeSteps = combinedSteps
      .slice(0, 2)
      .map((step) => ({ ...step, state: "complete" as const }));

    expect(resolveAdaptiveSetupActiveStep({ steps: completeSteps })?.stepId).toBe(
      "marketplace_preferences",
    );
  });

  it("returns null for an empty route", () => {
    expect(resolveAdaptiveSetupActiveStep({ steps: [] })).toBeNull();
  });
});

describe("adaptive route-order navigation", () => {
  it("uses the preceding and following positions from the server response", () => {
    expect(resolvePreviousAdaptiveSetupStep(combinedSteps, "rooms")?.stepId).toBe("booking_design");
    expect(resolveNextAdaptiveSetupStep(combinedSteps, "booking_design")?.stepId).toBe("rooms");
  });

  it("returns null at route boundaries or for inactive steps", () => {
    expect(resolvePreviousAdaptiveSetupStep(combinedSteps, "present_hotel")).toBeNull();
    expect(resolvePreviousAdaptiveSetupStep(combinedSteps, "not-a-step")).toBeNull();
    expect(resolveNextAdaptiveSetupStep(combinedSteps, "review")).toBeNull();
    expect(resolveNextAdaptiveSetupStep(combinedSteps, "not-a-step")).toBeNull();
  });
});

describe("adaptive setup copy", () => {
  it("has stable English copy for every supported step", () => {
    expect(Object.keys(ADAPTIVE_SETUP_STEP_COPY)).toEqual([...ADAPTIVE_SETUP_STEP_IDS]);
    for (const stepId of ADAPTIVE_SETUP_STEP_IDS) {
      expect(ADAPTIVE_SETUP_STEP_COPY[stepId].title.length).toBeGreaterThan(0);
      expect(ADAPTIVE_SETUP_STEP_COPY[stepId].subtitle.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSupportedInterfaceLocale", () => {
  it("derives a supported interface locale from the browser and falls back safely", () => {
    expect(resolveSupportedInterfaceLocale("en-US")).toBe("en");
    expect(resolveSupportedInterfaceLocale("de-DE")).toBe("en");
    expect(resolveSupportedInterfaceLocale(null)).toBe("en");
  });
});
