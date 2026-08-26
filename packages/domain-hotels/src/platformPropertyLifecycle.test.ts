import { describe, expect, it } from "vitest";

import {
  PLATFORM_PROPERTY_LIFECYCLE_STATUSES,
  canTransitionPlatformProperty,
  isPlatformPropertyLifecycleStatus,
} from "./platformPropertyLifecycle.js";

describe("platform property lifecycle", () => {
  it("exposes the explicit Catalog-owned states", () => {
    expect(PLATFORM_PROPERTY_LIFECYCLE_STATUSES).toEqual([
      "provisioning",
      "active",
      "suspended",
      "retired",
    ]);
    expect(isPlatformPropertyLifecycleStatus("active")).toBe(true);
    expect(isPlatformPropertyLifecycleStatus("deleted")).toBe(false);
  });

  it.each([
    ["provisioning", "active"],
    ["provisioning", "suspended"],
    ["provisioning", "retired"],
    ["active", "suspended"],
    ["active", "retired"],
    ["suspended", "active"],
    ["suspended", "retired"],
    ["retired", "suspended"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionPlatformProperty(from, to)).toBe(true);
  });

  it.each([
    ["active", "active"],
    ["active", "provisioning"],
    ["suspended", "provisioning"],
    ["retired", "active"],
    ["retired", "provisioning"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransitionPlatformProperty(from, to)).toBe(false);
  });
});
