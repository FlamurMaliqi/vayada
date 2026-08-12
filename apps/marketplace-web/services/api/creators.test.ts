import { afterEach, describe, expect, it, vi } from "vitest";

import type { Creator } from "@/lib/types";
import { clearAuthData, setAuthKitSession } from "@/services/auth/sessionStore";
import { creatorService, isAbsoluteHttpsUrl } from "./creators";

const uploadPlatformMediaMock = vi.hoisted(() => vi.fn());

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({
  uploadPlatformMedia: uploadPlatformMediaMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" },
  });
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
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
      profileUrl: "https://instagram.com/lina",
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
  it("accepts only absolute HTTPS URLs", () => {
    expect(isAbsoluteHttpsUrl("https://instagram.com/lina")).toBe(true);
    expect(isAbsoluteHttpsUrl("http://instagram.com/lina")).toBe(false);
    expect(isAbsoluteHttpsUrl("/lina")).toBe(false);
    expect(isAbsoluteHttpsUrl("javascript:alert(1)")).toBe(false);
  });

  afterEach(() => {
    clearAuthData();
    uploadPlatformMediaMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects a profile image until a public CDN URL exists", async () => {
    uploadPlatformMediaMock.mockResolvedValue([
      {
        mediaId: "media-id",
        url: "staging/creator-profile/media-id/original.jpg",
        storageKey: "staging/creator-profile/media-id/original.jpg",
      },
    ]);

    await expect(
      creatorService.uploadProfilePicture(
        new File(["image"], "profile.jpg", { type: "image/jpeg" }),
        "creator-profile-id",
      ),
    ).rejects.toThrow("The profile image is still processing. Please try again later.");
  });

  it("returns a public HTTPS profile-picture URL", async () => {
    uploadPlatformMediaMock.mockResolvedValue([
      {
        mediaId: "media-id",
        url: "https://cdn.example.com/creator-profile/media-id.jpg",
        storageKey: "staging/creator-profile/media-id/original.jpg",
      },
    ]);

    const result = await creatorService.uploadProfilePicture(
      new File(["image"], "profile.jpg", { type: "image/jpeg" }),
      "creator-profile-id",
    );

    expect(result).toEqual({
      mediaObjectId: "media-id",
      url: "https://cdn.example.com/creator-profile/media-id.jpg",
    });
  });

  it("sends only the issued media ID when linking a creator profile picture", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          ...targetProfile,
          profilePictureMediaObjectId: "media-id",
        });
      }),
    );

    const profile = await creatorService.updateMyProfile({
      profilePicture: "staging/creator-profile/media-id/original.jpg",
      profilePictureMediaObjectId: "media-id",
    });

    expect(body).toEqual({ profilePictureMediaObjectId: "media-id" });
    expect(profile.profilePictureMediaObjectId).toBe("media-id");
  });

  it("uses the AuthKit token for target status reads", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(requestHeader(init, "Authorization")).toBe("Bearer workos-access-token");
      return jsonResponse({
        profilePhotoRequired: true,
        profileComplete: false,
        missingFields: ["displayName"],
        missingPlatforms: true,
        completionSteps: ["add_display_name", "add_platform"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const status = await creatorService.getProfileStatus({ signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/api/marketplace/creators/me/profile-status",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(status).toEqual({
      profile_photo_required: true,
      profile_complete: false,
      missing_fields: ["displayName"],
      missing_platforms: true,
      completion_steps: ["add_display_name", "add_platform"],
    });
  });

  it("refreshes the AuthKit session from cookies before target status reads after reload", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/auth/session?surface=marketplace-web") {
        expect(init?.signal).toBe(controller.signal);
        return jsonResponse({
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          organizationKind: "creator_workspace",
          user: { id: "user_creator", email: "creator@example.com", status: "active" },
        });
      }
      if (href === "https://api.localhost/api/marketplace/creators/me/profile-status") {
        expect(requestHeader(init, "Authorization")).toBe("Bearer workos-access-token");
        return jsonResponse({
          profilePhotoRequired: true,
          profileComplete: false,
          missingFields: [],
          missingPlatforms: true,
          completionSteps: ["add_platform"],
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await creatorService.getProfileStatus({ signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      profile_photo_required: true,
      profile_complete: false,
      missing_platforms: true,
    });
  });

  it("does not turn an aborted cold session refresh into an authentication failure", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(String(url)).toBe("/auth/session?surface=marketplace-web");
        expect(init?.signal).toBe(controller.signal);
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = creatorService.getProfileStatus({ signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps the creator profile form payload to the target update contract", async () => {
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
      portfolioLink: "https://example.com/lina",
      phone: "+4915123456789",
      platforms: [
        {
          id: "platform_instagram",
          name: "Instagram",
          handle: "lina",
          profileUrl: "https://instagram.com/lina",
          followers: 1200,
          engagementRate: 4.2,
        },
        {
          id: "platform_blog",
          name: "Blog",
          handle: "lina.example.com",
          profileUrl: "https://lina.example.com",
          followers: 800,
          engagementRate: 2.1,
        },
        {
          id: "platform_x",
          name: "X",
          handle: "lina",
          profileUrl: "https://x.com/lina",
          followers: 600,
          engagementRate: 1.8,
        },
      ],
    } as Partial<Creator>);

    expect(body).toMatchObject({
      displayName: "Lina Creator",
      locationText: "Berlin",
      creatorType: "travel",
      shortDescription: "Travel creator",
      portfolioUrl: "https://example.com/lina",
      phone: "+4915123456789",
      platforms: [
        {
          platformId: "platform_instagram",
          platform: "instagram",
          handle: "lina",
          profileUrl: "https://instagram.com/lina",
          followerCount: 1200,
          engagementRate: 4.2,
        },
        expect.objectContaining({
          platformId: "platform_blog",
          platform: "blog",
        }),
        expect.objectContaining({
          platformId: "platform_x",
          platform: "x",
        }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/api/marketplace/creators/me",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(requestHeader(fetchMock.mock.calls[0]?.[1], "Authorization")).toBe(
      "Bearer workos-access-token",
    );
    expect(profile).toMatchObject({
      id: "creator_profile_local",
      name: "Lina Creator",
      creatorType: "Travel",
      audienceSize: 1200,
      platforms: [expect.objectContaining({ profileUrl: "https://instagram.com/lina" })],
    });
  });

  it("starts platform authorization and reads connection availability", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(requestHeader(init, "Authorization")).toBe("Bearer workos-access-token");
      const href = String(url);
      if (href.endsWith("/platform-connections")) {
        return jsonResponse({
          connections: [
            {
              connectionId: "connection-instagram",
              platformId: "platform-instagram",
              platform: "instagram",
              provider: "meta",
              externalAccountId: "instagram-account-1",
              status: "active",
              lastSyncAttemptAt: "2026-07-19T12:00:00.000Z",
              lastSuccessfulSyncAt: "2026-07-19T12:00:00.000Z",
              lastErrorCode: null,
              capabilities: ["followerCount", "audienceCountries"],
              importedFields: ["followerCount"],
              unavailableFields: [{ field: "audienceCountries", reason: "privacy_threshold" }],
            },
          ],
        });
      }
      if (href.endsWith("/platform-connections/instagram/authorize")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ platformId: "platform-instagram" });
        return jsonResponse({ authorizationUrl: "https://instagram.com/oauth/authorize" });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(creatorService.getPlatformConnections()).resolves.toEqual([
      expect.objectContaining({
        connectionId: "connection-instagram",
        status: "active",
        unavailableFields: [{ field: "audienceCountries", reason: "privacy_threshold" }],
      }),
    ]);
    await expect(
      creatorService.startPlatformAuthorization("instagram", "platform-instagram"),
    ).resolves.toEqual({ authorizationUrl: "https://instagram.com/oauth/authorize" });
  });

  it("starts a new platform authorization without sending an empty JSON body", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        expect(requestHeader(init, "Content-Type")).toBeNull();
        return jsonResponse({ authorizationUrl: "https://instagram.com/oauth/authorize" });
      }),
    );

    await expect(creatorService.startPlatformAuthorization("instagram")).resolves.toEqual({
      authorizationUrl: "https://instagram.com/oauth/authorize",
    });
  });

  it("selects, syncs, and disconnects a connected platform account", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        requests.push({
          url: href,
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (href.endsWith("/platform-authorizations/pending")) {
          return jsonResponse({
            authorizationId: "authorization-1",
            platform: "facebook",
            accounts: [
              {
                externalAccountId: "page-1",
                displayName: "Vayada Travel",
                handle: "vayada.travel",
                profileUrl: "https://facebook.com/vayada.travel",
              },
            ],
          });
        }
        return jsonResponse(null, init?.method === "DELETE" ? 204 : 200);
      }),
    );

    await expect(creatorService.getPendingPlatformAuthorization()).resolves.toMatchObject({
      authorizationId: "authorization-1",
      platform: "facebook",
    });
    await creatorService.selectPlatformAuthorizationAccount("authorization-1", "page-1");
    await creatorService.syncPlatformConnection("connection-1");
    await creatorService.disconnectPlatformConnection("connection-1");

    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://api.localhost/api/marketplace/creators/me/platform-authorizations/pending",
        method: "GET",
      }),
      {
        url: "https://api.localhost/api/marketplace/creators/me/platform-authorizations/authorization-1/accounts",
        method: "POST",
        body: { externalAccountId: "page-1" },
      },
      {
        url: "https://api.localhost/api/marketplace/creators/me/platform-connections/connection-1/sync",
        method: "POST",
      },
      {
        url: "https://api.localhost/api/marketplace/creators/me/platform-connections/connection-1",
        method: "DELETE",
      },
    ]);
  });

  it("maps a custom platform to other while preserving its name and profile link", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    let body: { platforms?: unknown[] } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as { platforms?: unknown[] };
        return jsonResponse(targetProfile);
      }),
    );

    await creatorService.updateMyProfile({
      platforms: [
        {
          name: "Other",
          handle: "LinkedIn",
          profileUrl: "https://www.linkedin.com/in/lina",
          followers: 900,
          engagementRate: 2.8,
        },
      ],
    });

    expect(body.platforms).toEqual([
      expect.objectContaining({
        platform: "other",
        handle: "LinkedIn",
        profileUrl: "https://www.linkedin.com/in/lina",
        followerCount: 900,
        engagementRate: 2.8,
      }),
    ]);
  });

  it("preserves stable IDs and demographics for a multi-platform edit", async () => {
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    let body: { platforms?: unknown[] } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as { platforms?: unknown[] };
        return jsonResponse(targetProfile);
      }),
    );

    await creatorService.updateMyProfile({
      platforms: [
        {
          id: "platform_instagram",
          name: "Instagram",
          handle: "lina",
          followers: 1500,
          engagementRate: 4.5,
          topCountries: [{ country: "Germany", percentage: 70 }],
          topAgeGroups: [{ ageRange: "25-34", percentage: 60 }],
          genderSplit: { male: 30, female: 60, other: 10 },
        },
        {
          id: null,
          name: "YouTube",
          handle: "lina-travels",
          followers: 800,
          engagementRate: 3.2,
          topCountries: [],
          topAgeGroups: [],
          genderSplit: { male: 0, female: 0 },
        },
      ],
    });

    expect(body.platforms).toEqual([
      {
        platformId: "platform_instagram",
        platform: "instagram",
        handle: "lina",
        followerCount: 1500,
        engagementRate: 4.5,
        audienceCountries: [{ country: "Germany", percentage: 70 }],
        audienceAgeGroups: [{ ageRange: "25-34", percentage: 60 }],
        audienceGenderSplit: { male: 30, female: 60, other: 10 },
      },
      {
        platformId: null,
        platform: "youtube",
        handle: "lina-travels",
        followerCount: 800,
        engagementRate: 3.2,
        audienceCountries: [],
        audienceAgeGroups: [],
        audienceGenderSplit: { male: 0, female: 0 },
      },
    ]);
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
