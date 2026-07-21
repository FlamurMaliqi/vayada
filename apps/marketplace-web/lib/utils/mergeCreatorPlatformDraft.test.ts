import { describe, expect, it } from "vitest";

import type { CreatorPlatformConnection, PlatformFormData } from "@/lib/types";

import { mergeCreatorPlatformDraft } from "./mergeCreatorPlatformDraft";

describe("mergeCreatorPlatformDraft", () => {
  it("refreshes only fields owned by the matching connection", () => {
    const draft = platform({
      id: "instagram-1",
      handle: "@draft",
      followers: 100,
      engagement_rate: 1,
      top_countries: [{ country: "France", percentage: 60 }],
      top_age_groups: [{ ageRange: "25-34", percentage: 70 }],
      gender_split: { male: 30, female: 70 },
    });
    const hydrated = platform({
      id: "instagram-1",
      handle: "@provider",
      profile_url: "https://instagram.com/provider",
      followers: 250,
      engagement_rate: 4.5,
      top_countries: [{ country: "Germany", percentage: 80 }],
      top_age_groups: [{ ageRange: "18-24", percentage: 90 }],
      gender_split: { male: 45, female: 55 },
    });

    expect(
      mergeCreatorPlatformDraft(
        [draft],
        [hydrated],
        [connection({ importedFields: ["followerCount", "engagementRate"] })],
      ),
    ).toEqual([
      {
        ...draft,
        name: hydrated.name,
        handle: hydrated.handle,
        profile_url: hydrated.profile_url,
        followers: hydrated.followers,
        engagement_rate: hydrated.engagement_rate,
      },
    ]);
  });

  it("applies empty imported values instead of resurrecting stale draft data", () => {
    const draft = platform({
      id: "instagram-1",
      top_countries: [{ country: "France", percentage: 60 }],
    });
    const hydrated = platform({ id: "instagram-1", top_countries: [] });

    expect(
      mergeCreatorPlatformDraft(
        [draft],
        [hydrated],
        [connection({ importedFields: ["audienceCountries"] })],
      )[0].top_countries,
    ).toEqual([]);
  });

  it("preserves unrelated manual rows and appends newly connected accounts", () => {
    const manualDraft = platform({ id: "manual-1", handle: "@unsaved", followers: 321 });
    const staleManual = platform({ id: "manual-1", handle: "@saved", followers: 123 });
    const connected = platform({ id: "youtube-1", name: "YouTube", handle: "@new" });

    expect(
      mergeCreatorPlatformDraft(
        [manualDraft],
        [staleManual, connected],
        [connection({ platformId: "youtube-1", platform: "youtube" })],
      ),
    ).toEqual([manualDraft, connected]);
  });
});

function platform(overrides: Partial<PlatformFormData> = {}): PlatformFormData {
  return {
    id: "instagram-1",
    name: "Instagram",
    handle: "@creator",
    profile_url: "https://instagram.com/creator",
    followers: 100,
    engagement_rate: 2,
    top_countries: [],
    top_age_groups: [],
    gender_split: { male: 50, female: 50 },
    ...overrides,
  };
}

function connection(overrides: Partial<CreatorPlatformConnection> = {}): CreatorPlatformConnection {
  return {
    connectionId: "connection-1",
    platformId: "instagram-1",
    platform: "instagram",
    provider: "meta",
    externalAccountId: "external-1",
    status: "active",
    lastSyncAttemptAt: null,
    lastSuccessfulSyncAt: null,
    lastErrorCode: null,
    capabilities: [],
    importedFields: [],
    unavailableFields: [],
    ...overrides,
  };
}
