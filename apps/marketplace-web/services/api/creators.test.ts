import { afterEach, describe, expect, it, vi } from "vitest";

import type { Creator } from "@/lib/types";
import {
  clearAuthData,
  setAuthKitSession,
  setLegacyCompatibilityToken,
} from "@/services/auth/sessionStore";
import { creatorService } from "./creators";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => body,
  } as Response;
}

const targetProfile = {
  creatorProfileId: "creator_profile_local",
  displayName: "Lina Creator",
  creatorType: "travel",
  locationText: "Berlin",
  shortDescription: "Travel creator",
  portfolioUrl: null,
  phone: null,
  profilePictureUrl: null,
  profileComplete: true,
  profileStatus: "pending",
  platforms: [
    {
      platformId: "platform_instagram",
      platform: "instagram",
      handle: "lina",
      profileUrl: null,
      followerCount: 1200,
      engagementRate: 4.2,
      audienceCountries: [],
      audienceAgeGroups: [],
      audienceGenderSplit: null,
    },
  ],
  audienceSize: 1200,
  rating: { averageRating: 0, totalReviews: 0 },
  createdAt: "2026-07-05T10:00:00.000Z",
  updatedAt: "2026-07-05T10:00:00.000Z",
};

describe("creator target self-service client", () => {
  afterEach(() => {
    clearAuthData();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the AuthKit token, not the legacy compatibility token, for target status reads", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer workos-access-token",
      );
      return jsonResponse({
        profileComplete: false,
        missingFields: ["displayName"],
        missingPlatforms: true,
        completionSteps: ["add_display_name", "add_platform"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await creatorService.getProfileStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/api/marketplace/creators/me/profile-status",
      expect.any(Object),
    );
    expect(status).toEqual({
      profile_complete: false,
      missing_fields: ["displayName"],
      missing_platforms: true,
      completion_steps: ["add_display_name", "add_platform"],
    });
  });

  it("refreshes the AuthKit session from cookies before target status reads after reload", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
        return jsonResponse({
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          organizationKind: "creator_workspace",
          user: { id: "user_creator", email: "creator@example.com", status: "active" },
        });
      }
      if (href === "https://api.localhost/api/marketplace/creators/me/profile-status") {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer workos-access-token",
        );
        return jsonResponse({
          profileComplete: false,
          missingFields: [],
          missingPlatforms: true,
          completionSteps: ["add_platform"],
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await creatorService.getProfileStatus();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      profile_complete: false,
      missing_platforms: true,
    });
  });

  it("maps the legacy creator form payload to the target update contract", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    let body: unknown;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(targetProfile);
    });
    vi.stubGlobal("fetch", fetchMock);

    const profile = await creatorService.updateMyProfile({
      name: "Lina Creator",
      location: "Berlin",
      creatorType: "Travel",
      shortDescription: "Travel creator",
      platforms: [
        {
          name: "Instagram",
          handle: "lina",
          followers: 1200,
          engagementRate: 4.2,
        },
      ],
    } as Partial<Creator>);

    expect(body).toMatchObject({
      displayName: "Lina Creator",
      locationText: "Berlin",
      creatorType: "travel",
      shortDescription: "Travel creator",
      platforms: [
        {
          platform: "instagram",
          handle: "lina",
          followerCount: 1200,
          engagementRate: 4.2,
        },
      ],
    });
    expect(profile).toMatchObject({
      id: "creator_profile_local",
      name: "Lina Creator",
      creatorType: "Travel",
      audienceSize: 1200,
    });
  });

  it("preserves the other creator type in target reads and writes", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    let body: unknown;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ ...targetProfile, creatorType: "other" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const profile = await creatorService.updateMyProfile({
      creatorType: "Other",
    } as Partial<Creator>);

    expect(body).toMatchObject({ creatorType: "other" });
    expect(profile.creatorType).toBe("Other");
  });
});
