import { describe, expect, it } from "vitest";

import {
  buildSettingsSectionUrl,
  readSettingsSection,
  SETTINGS_SECTIONS,
} from "./settingsSectionUrl";

describe("settings section URLs", () => {
  it.each(SETTINGS_SECTIONS)("opens the %s section directly", (section) => {
    expect(readSettingsSection(`?section=${section}`)).toBe(section);
  });

  it("falls back to property for a missing or invalid section", () => {
    expect(readSettingsSection("")).toBe("property");
    expect(readSettingsSection("?section=unknown")).toBe("property");
    expect(readSettingsSection("?section=account")).toBe("property");
  });

  it("keeps legacy billing return URLs opening billing", () => {
    expect(readSettingsSection("?billing=success")).toBe("billing");
    expect(readSettingsSection("?billing=canceled")).toBe("billing");
  });

  it("prefers an explicit section over a billing return parameter", () => {
    expect(readSettingsSection("?billing=success&section=payments")).toBe("payments");
  });

  it("changes only the section query parameter", () => {
    expect(
      buildSettingsSectionUrl(
        "https://admin.booking.example/settings?billing=success&source=email#details",
        "payments",
      ),
    ).toBe("/settings?billing=success&source=email&section=payments#details");
  });
});
