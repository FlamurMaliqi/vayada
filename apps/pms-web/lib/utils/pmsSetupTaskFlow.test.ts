import { describe, expect, it } from "vitest";

import { SELECTED_SHARED_PROPERTY_ID_KEY } from "./pmsPropertySelectionKeys";
import { hasPmsSetupTaskContext, parsePmsSetupTaskHandoff } from "./pmsSetupTaskFlow";

const propertyId = "f6853000-0000-4000-8000-000000000001";
const marketplaceOrigin = "https://marketplace.localhost";
const returnUrl = `${marketplaceOrigin}/setup?propertyId=${propertyId}`;

describe("parsePmsSetupTaskHandoff", () => {
  it("accepts only the canonical PMS task context for the selected shared property", () => {
    expect(
      parsePmsSetupTaskHandoff(
        taskParams(),
        storageWithSelectedProperty(propertyId),
        marketplaceOrigin,
      ),
    ).toEqual({ returnUrl });
  });

  it.each([
    ["an external return URL", { returnUrl: "https://attacker.example/setup" }],
    [
      "a return URL for a different property",
      { returnUrl: `${marketplaceOrigin}/setup?propertyId=other-property` },
    ],
    ["a different task", { taskId: "guest_settings_policies" }],
    ["a different destination", { destinationRouteKey: "pms.workspace" }],
    ["a blank plan revision", { planRevision: " " }],
    ["an unsupported onboarding mode", { onboarding: "unsupported" }],
  ])("rejects %s", (_, overrides) => {
    expect(
      parsePmsSetupTaskHandoff(
        taskParams(overrides),
        storageWithSelectedProperty(propertyId),
        marketplaceOrigin,
      ),
    ).toBeNull();
  });

  it("rejects missing, duplicate, or client-added context", () => {
    const missing = taskParams();
    missing.delete("planRevision");
    expect(
      parsePmsSetupTaskHandoff(missing, storageWithSelectedProperty(propertyId), marketplaceOrigin),
    ).toBeNull();

    const duplicate = taskParams();
    duplicate.append("returnUrl", returnUrl);
    expect(
      parsePmsSetupTaskHandoff(
        duplicate,
        storageWithSelectedProperty(propertyId),
        marketplaceOrigin,
      ),
    ).toBeNull();

    const extra = taskParams();
    extra.set("propertyId", propertyId);
    expect(
      parsePmsSetupTaskHandoff(extra, storageWithSelectedProperty(propertyId), marketplaceOrigin),
    ).toBeNull();
  });

  it("requires the property established by the exchanged handoff", () => {
    expect(
      parsePmsSetupTaskHandoff(taskParams(), storageWithSelectedProperty(null), marketplaceOrigin),
    ).toBeNull();
  });

  it("detects complete or partial task context", () => {
    expect(hasPmsSetupTaskContext(new URLSearchParams({ returnUrl }))).toBe(true);
    expect(hasPmsSetupTaskContext(new URLSearchParams({ onboarding: "pms-activation" }))).toBe(
      true,
    );
    expect(hasPmsSetupTaskContext(new URLSearchParams({ onboarding: "unsupported" }))).toBe(true);
    expect(hasPmsSetupTaskContext(new URLSearchParams())).toBe(false);
  });
});

function taskParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    onboarding: "pms-activation",
    taskId: "rooms_rates_availability",
    destinationRouteKey: "pms.rooms_rates_availability",
    planRevision: "plan-1",
    returnUrl,
    ...overrides,
  });
}

function storageWithSelectedProperty(selectedPropertyId: string | null): Pick<Storage, "getItem"> {
  return {
    getItem(key) {
      return key === SELECTED_SHARED_PROPERTY_ID_KEY ? selectedPropertyId : null;
    },
  };
}
