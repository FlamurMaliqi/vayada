import { describe, expect, it } from "vitest";

import { isPmsPropertyReady, type PmsPropertySummary } from "./pmsPropertyClient";

describe("isPmsPropertyReady", () => {
  it.each([
    ["active", true],
    ["selected_incomplete", false],
    ["not_selected", false],
    ["suspended", false],
    ["unavailable", false],
  ] as const)("treats %s PMS access as ready: %s", (pmsStatus, expected) => {
    const property = { pmsStatus } as PmsPropertySummary;

    expect(isPmsPropertyReady(property)).toBe(expected);
  });
});
