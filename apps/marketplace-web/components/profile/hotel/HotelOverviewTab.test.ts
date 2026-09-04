import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HotelOverviewTab } from "./HotelOverviewTab";

const profile = {
  id: "property-one",
  name: "Hotel Alpenrose",
  location: "Munich, Germany",
  localityPublic: true,
  status: "verified" as const,
  website: "https://alpenrose.example",
  about: "A creator-friendly hotel in central Munich.",
  email: "reception@alpenrose.example",
  phone: "+49 89 123456",
  listings: [],
};

const editFormData = {
  name: profile.name,
  picture: "",
  location: profile.location,
  localityPublic: profile.localityPublic,
  website: profile.website,
  about: profile.about,
};

describe("HotelOverviewTab locality controls", () => {
  it("lets an editing hotel revoke Marketplace locality consent", () => {
    const html = renderToStaticMarkup(
      createElement(HotelOverviewTab, {
        isEditing: true,
        editFormData,
        phone: profile.phone,
        onEditFormChange: vi.fn(),
        onPhoneChange: vi.fn(),
      }),
    );

    expect(html).toContain("Show city and country on public vayada surfaces");
    expect(html).toContain("hides your locality across vayada’s public surfaces");
    expect(html).toContain("makes your Marketplace offer private");
    expect(html).toContain("street address and coordinates stay private");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).not.toMatch(/type="checkbox"[^>]* disabled=""/);
  });

  it("shows consent read-only outside edit mode", () => {
    const html = renderToStaticMarkup(
      createElement(HotelOverviewTab, {
        isEditing: false,
        editFormData,
        phone: profile.phone,
        onEditFormChange: vi.fn(),
        onPhoneChange: vi.fn(),
      }),
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });
});
