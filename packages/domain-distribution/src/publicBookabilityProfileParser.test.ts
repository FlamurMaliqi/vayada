import { describe, expect, it } from "vitest";

import { PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";
import { parsePublicBookabilityProfileProjection } from "./publicBookabilityProfileParser.js";

const storedProfile = () =>
  JSON.parse(JSON.stringify(PUBLIC_BOOKABILITY_FIXTURES[0]!.profile)) as Record<string, unknown>;

describe("parsePublicBookabilityProfileProjection", () => {
  it("reconstructs and freezes every canonical fixture after JSON storage", () => {
    for (const fixture of PUBLIC_BOOKABILITY_FIXTURES) {
      const stored = JSON.parse(JSON.stringify(fixture.profile));
      const parsed = parsePublicBookabilityProfileProjection(stored);

      expect(parsed).toEqual(stored);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed?.hotel.capabilities)).toBe(true);
    }
  });

  it.each([
    ["unknown root field", (profile: any) => (profile.privateValue = "secret")],
    ["wrong source", (profile: any) => (profile.dataSources[0] = "private")],
    ["object locale", (profile: any) => (profile.hotel.supportedLocales[0] = { value: "en" })],
    ["unsafe URL", (profile: any) => (profile.hotel.canonicalUrl = "https://token@evil.test")],
    [
      "unsafe public contact",
      (profile: any) => {
        profile.hotel.publicContacts = [{ type: "website", value: "javascript:alert(1)" }];
      },
    ],
    ["nested policy", (profile: any) => (profile.hotel.policies.checkInFrom = { value: "15:00" })],
    ["string capability", (profile: any) => (profile.hotel.capabilities.instantBook = "true")],
    ["unknown trust status", (profile: any) => (profile.hotel.trust.bookabilityStatus = "ready")],
    [
      "duplicate source owner",
      (profile: any) => (profile.freshness.sources[1].owner = "hotel_catalog"),
    ],
    [
      "future source",
      (profile: any) => (profile.freshness.sources[0].lastUpdatedAt = "2027-01-01T00:00:00.000Z"),
    ],
    [
      "impossible calendar instant",
      (profile: any) => {
        profile.generatedAt = profile.freshness.generatedAt = "2026-02-30T00:00:00.000Z";
      },
    ],
    [
      "normalized 24-hour instant",
      (profile: any) => {
        profile.generatedAt = profile.freshness.generatedAt = "2026-01-01T24:00:00.000Z";
      },
    ],
    [
      "wrong source reason",
      (profile: any) => (profile.freshness.sources[0].reasonCode = "source_stale"),
    ],
    [
      "missing fresh timestamp",
      (profile: any) => delete profile.freshness.sources[0].lastUpdatedAt,
    ],
    [
      "bookable without payment",
      (profile: any) => {
        profile.hotel.capabilities.onlinePayment = false;
        profile.hotel.capabilities.payAtProperty = false;
      },
    ],
    [
      "incomplete bookable profile",
      (profile: any) => (profile.hotel.trust.profileComplete = false),
    ],
    [
      "mismatched custom origin",
      (profile: any) => {
        profile.hotel.customDomainUrl = "https://other.example";
        profile.hotel.trust.domainVerified = true;
      },
    ],
    ["unknown nested field", (profile: any) => (profile.hotel.location.internalId = "location-1")],
  ])("fails closed for %s", (_name, poison) => {
    const profile = storedProfile();
    poison(profile);

    expect(parsePublicBookabilityProfileProjection(profile)).toBeNull();
  });
});
