import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OtaCommissionSettingsSection } from "@/components/settings/OtaCommissionSettingsSection";
import {
  canonicalEffectiveFrom,
  displayPercentage,
  otaCommissionFormErrors,
} from "./otaCommissions";
describe("PMS OTA commission settings", () => {
  it("accepts precise percentages and valid effective timestamps", () => {
    expect(otaCommissionFormErrors("12.3456", "2026-09-01T12:30")).toEqual({
      percentageRate: "",
      effectiveFrom: "",
    });
    expect(canonicalEffectiveFrom("2026-01-01T00:00")).toBe(new Date(2026, 0).toISOString());
    expect(canonicalEffectiveFrom("2026-02-30T12:30")).toBeNull();
    expect(canonicalEffectiveFrom("2026-09-01")).toBeNull();
    expect(displayPercentage("12.3400")).toBe("12.34");
  });
  it("rejects out-of-range, over-precise, and invalid values", () => {
    expect(otaCommissionFormErrors("101", "not-a-date")).toEqual({
      percentageRate: "Enter a percentage from 0 to 100 with up to four decimal places.",
      effectiveFrom: "Choose a valid effective date and time.",
    });
    expect(otaCommissionFormErrors("10.12345", "2026-09-01T12:30").percentageRate).not.toBe("");
  });
  it("renders an accessible persisted-settings loading state", () => {
    const markup = renderToStaticMarkup(createElement(OtaCommissionSettingsSection));
    expect(markup).toContain("OTA commissions");
    expect(markup).toContain("future booking economics only");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading persisted OTA commission settings");
  });
});
