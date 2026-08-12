import { describe, expect, it } from "vitest";

import { isPmsSetupExitPath, pmsSetupExitPath, pmsSetupExitPropertyId } from "./setupExit";

describe("PMS setup exit routing", () => {
  it("lands a selected property on the dashboard", () => {
    expect(pmsSetupExitPath(" property-1 ")).toBe(
      "/dashboard?setup=incomplete&propertyId=property-1",
    );
  });

  it("lands setup without a property on the property picker", () => {
    expect(pmsSetupExitPath(null)).toBe("/choose-property?setup=incomplete");
  });

  it("recognizes only intentional PMS setup-exit destinations", () => {
    expect(isPmsSetupExitPath("/dashboard?setup=incomplete&propertyId=property-1")).toBe(true);
    expect(isPmsSetupExitPath("https://pms.vayada.com/choose-property?setup=incomplete")).toBe(
      true,
    );
    expect(isPmsSetupExitPath("/dashboard?setup=incomplete")).toBe(false);
    expect(isPmsSetupExitPath("/dashboard")).toBe(false);
    expect(isPmsSetupExitPath("/settings?setup=incomplete")).toBe(false);
    expect(
      isPmsSetupExitPath(
        "https://attacker.example/dashboard?setup=incomplete&propertyId=property-1",
      ),
    ).toBe(false);
  });

  it("reads the selected property only from a dashboard setup exit", () => {
    expect(pmsSetupExitPropertyId("/dashboard?setup=incomplete&propertyId=%20property-1%20")).toBe(
      "property-1",
    );
    expect(pmsSetupExitPropertyId("/dashboard?propertyId=property-1")).toBeNull();
    expect(
      pmsSetupExitPropertyId("/choose-property?setup=incomplete&propertyId=property-1"),
    ).toBeNull();
    expect(
      pmsSetupExitPropertyId(
        "https://attacker.example/dashboard?setup=incomplete&propertyId=property-1",
      ),
    ).toBeNull();
  });
});
