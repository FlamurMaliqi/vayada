import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PropertySection } from "@/components/settings/PropertySection";

import { canSavePmsPropertyDetails, pmsPropertyDetailsSaveError } from "./propertyDetails";

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.save": "Save",
        "common.saving": "Saving…",
        "settings.retry": "Retry",
      })[key] ?? key,
  }),
}));

describe("PMS canonical property details state", () => {
  it("blocks blank canonical fields after the profile request fails", () => {
    const failed = { loadStatus: "error" as const, timezone: "", country: "" };

    expect(canSavePmsPropertyDetails(failed)).toBe(false);
    expect(pmsPropertyDetailsSaveError(failed)).toBe("profile_not_ready");
  });

  it("requires valid canonical fields even after the profile loads", () => {
    expect(canSavePmsPropertyDetails({ loadStatus: "ready", timezone: "", country: "AT" })).toBe(
      false,
    );
    expect(
      canSavePmsPropertyDetails({
        loadStatus: "ready",
        timezone: "Europe/Vienna",
        country: "A",
      }),
    ).toBe(false);
    expect(
      canSavePmsPropertyDetails({
        loadStatus: "ready",
        timezone: "Europe/Vienna",
        country: "AT",
      }),
    ).toBe(true);
  });

  it("renders failed profile fields and Save disabled with a retry action", () => {
    const markup = renderToStaticMarkup(
      createElement(PropertySection, {
        timezone: "",
        setTimezone: vi.fn(),
        country: "",
        setCountry: vi.fn(),
        saving: false,
        loadStatus: "error",
        loadError: "We couldn’t load the canonical property profile.",
        onRetry: vi.fn(),
        onSave: vi.fn(),
      }),
    );

    expect(markup).toContain("We couldn’t load the canonical property profile.");
    expect(markup).toContain("Retry");
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(/<input[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });
});
