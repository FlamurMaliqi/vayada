import { describe, expect, it, vi } from "vitest";

import { createFacebookCreatorPlatformAdapter } from "./facebook.js";
import {
  CreatorPlatformRequestError,
  CreatorPlatformResponseError,
  fetchOptionalJson,
  normalizeMetaApiVersion,
} from "./http.js";
import { createInstagramCreatorPlatformAdapter } from "./instagram.js";
import { createTikTokCreatorPlatformAdapter } from "./tiktok.js";
import type { CreatorPlatformImportWindow } from "./types.js";
import { createYouTubeCreatorPlatformAdapter } from "./youtube.js";

const now = () => new Date("2026-07-19T12:00:00.000Z");
const window: CreatorPlatformImportWindow = {
  startDate: "2026-06-19",
  endDate: "2026-07-19",
};

type FetchFixture = {
  name: string;
  match: (url: URL, init: RequestInit | undefined) => boolean;
  json?: unknown;
  status?: number;
};

type FetchCall = {
  url: URL;
  init: RequestInit | undefined;
};

function fixtureFetch(fixtures: FetchFixture[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
  remaining: FetchFixture[];
} {
  const remaining = [...fixtures];
  const calls: FetchCall[] = [];
  const mock = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);
      calls.push({ url, init });
      const index = remaining.findIndex((fixture) => fixture.match(url, init));
      if (index < 0) throw new Error(`No fixture for ${init?.method ?? "GET"} ${url}`);
      const fixture = remaining.splice(index, 1)[0];
      if (!fixture) throw new Error("Matched fixture disappeared");
      const status = fixture.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(fixture.json ?? {}), {
        status,
        headers: status === 204 ? undefined : { "Content-Type": "application/json" },
      });
    },
  );
  return { fetch: mock as unknown as typeof fetch, calls, remaining };
}

function formValue(init: RequestInit | undefined, key: string): string | null {
  const body = init?.body;
  if (body instanceof URLSearchParams || body instanceof FormData)
    return body.get(key) as string | null;
  return null;
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("Authorization");
}

describe("creator platform authorization URLs", () => {
  it("uses each provider's official OAuth endpoint and requested read scopes", () => {
    const instagram = createInstagramCreatorPlatformAdapter({
      clientId: "instagram-client",
      clientSecret: "instagram-secret",
      apiVersion: "25.0",
    });
    const facebook = createFacebookCreatorPlatformAdapter({
      clientId: "facebook-client",
      clientSecret: "facebook-secret",
      apiVersion: "V25.0",
    });
    const tiktok = createTikTokCreatorPlatformAdapter({
      clientKey: "tiktok-client",
      clientSecret: "tiktok-secret",
    });
    const youtube = createYouTubeCreatorPlatformAdapter({
      clientId: "youtube-client",
      clientSecret: "youtube-secret",
    });

    const instagramUrl = new URL(
      instagram.buildAuthorizationUrl("state", "https://api.example.test/instagram/callback"),
    );
    expect(instagramUrl.origin + instagramUrl.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(instagramUrl.searchParams.get("scope")?.split(",")).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);

    const facebookUrl = new URL(
      facebook.buildAuthorizationUrl("state", "https://api.example.test/facebook/callback"),
    );
    expect(facebookUrl.origin + facebookUrl.pathname).toBe(
      "https://www.facebook.com/v25.0/dialog/oauth",
    );
    expect(facebookUrl.searchParams.get("scope")?.split(",")).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
    ]);

    const tiktokUrl = new URL(
      tiktok.buildAuthorizationUrl("state", "https://api.example.test/tiktok/callback"),
    );
    expect(tiktokUrl.origin + tiktokUrl.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(tiktokUrl.searchParams.get("scope")?.split(",")).toEqual([
      "user.info.basic",
      "user.info.profile",
      "user.info.stats",
      "video.list",
    ]);

    const youtubeUrl = new URL(
      youtube.buildAuthorizationUrl("state", "https://api.example.test/youtube/callback"),
    );
    expect(youtubeUrl.origin + youtubeUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(youtubeUrl.searchParams.get("scope")?.split(" ")).toEqual([
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ]);
    expect(youtubeUrl.searchParams.get("access_type")).toBe("offline");

    for (const url of [instagramUrl, facebookUrl, tiktokUrl, youtubeUrl]) {
      expect(url.searchParams.get("state")).toBe("state");
      expect(url.toString()).not.toContain("secret");
    }
  });

  it("normalizes and validates Meta Graph API versions", () => {
    expect(normalizeMetaApiVersion()).toBe("v25.0");
    expect(normalizeMetaApiVersion("25.0")).toBe("v25.0");
    expect(normalizeMetaApiVersion("V25.0")).toBe("v25.0");
    expect(() => normalizeMetaApiVersion("latest")).toThrow("Invalid Meta Graph API version");
  });
});

describe("Instagram creator platform adapter", () => {
  it("exchanges, lists a safe account, refreshes, and imports a 30-day snapshot", async () => {
    const fixtures = fixtureFetch([
      {
        name: "short token",
        match: (url, init) =>
          url.hostname === "api.instagram.com" &&
          url.pathname === "/oauth/access_token" &&
          init?.method === "POST",
        json: {
          access_token: "instagram-short-token",
          user_id: "ig-1",
          permissions: "instagram_business_basic,instagram_business_manage_insights",
        },
      },
      {
        name: "long token",
        match: (url) =>
          url.hostname === "graph.instagram.com" &&
          url.pathname === "/access_token" &&
          url.searchParams.get("grant_type") === "ig_exchange_token",
        json: { access_token: "instagram-long-token", expires_in: 5_184_000 },
      },
      {
        name: "account",
        match: (url, init) =>
          url.pathname === "/v25.0/me" &&
          authorizationHeader(init) === "Bearer instagram-long-token",
        json: {
          id: "app-scoped-1",
          user_id: "ig-1",
          username: "travel_creator",
          name: "Travel Creator",
          account_type: "CREATOR",
          profile_picture_url: "https://images.example.test/ig.jpg",
        },
      },
      {
        name: "followers",
        match: (url) => url.pathname === "/v25.0/ig-1" && url.searchParams.has("fields"),
        json: { followers_count: 250 },
      },
      {
        name: "media",
        match: (url) => url.pathname === "/v25.0/ig-1/media",
        json: {
          data: [
            { id: "media-1", timestamp: "2026-07-10T12:00:00+0000" },
            { id: "media-2", timestamp: "2026-06-20T12:00:00+0000" },
          ],
        },
      },
      {
        name: "activity",
        match: (url) =>
          url.pathname === "/v25.0/ig-1/insights" &&
          url.searchParams.get("metric")?.startsWith("likes,") === true,
        json: {
          data: [
            { name: "likes", total_value: { value: 100 } },
            { name: "comments", total_value: { value: 20 } },
            { name: "shares", total_value: { value: 10 } },
            { name: "reach", total_value: { value: 1_200 } },
            { name: "views", total_value: { value: 2_500 } },
          ],
        },
      },
      demographicErrorFixture("country", 400, {
        error: { reason: "privacy_threshold" },
      }),
      demographicErrorFixture("age", 403),
      demographicFixture("gender", [
        ["F", 25],
        ["female", 25],
        ["M", 20],
        ["male", 20],
        ["U", 5],
        ["unknown", 5],
      ]),
      {
        name: "refresh",
        match: (url) => url.pathname === "/refresh_access_token",
        json: { access_token: "instagram-refreshed-token", expires_in: 5_184_000 },
      },
    ]);
    const adapter = createInstagramCreatorPlatformAdapter({
      clientId: "instagram-client",
      clientSecret: "instagram-secret",
      apiVersion: "25.0",
      fetch: fixtures.fetch,
      now,
    });

    const grant = await adapter.exchangeCode("code", "https://api.example.test/callback");
    const listed = await adapter.listAccounts(grant);
    expect(listed.accounts).toEqual([
      {
        provider: "instagram",
        providerAccountId: "ig-1",
        displayName: "Travel Creator",
        username: "travel_creator",
        profileUrl: "https://www.instagram.com/travel_creator/",
        avatarUrl: "https://images.example.test/ig.jpg",
        accountType: "professional",
      },
    ]);
    expect(JSON.stringify(listed.accounts)).not.toContain("token");

    const imported = await adapter.importAccount(listed.accounts[0]!, listed.grant, window);
    expect(imported).toMatchObject({
      provider: "instagram",
      providerAccountId: "ig-1",
      importedAt: "2026-07-19T12:00:00.000Z",
      window,
      followers: { value: 250 },
      contentCount: { value: 2 },
      likes: { value: 100 },
      comments: { value: 20 },
      shares: { value: 10 },
      reach: { value: 1_200 },
      views: { value: 2_500 },
      demographics: {
        countries: { value: null, unavailableReason: "privacy_threshold" },
        ageGroups: { value: null, unavailableReason: "missing_permission" },
        genders: { value: { female: 50, male: 40, other: 10 } },
      },
    });
    const boundedInstagramCalls = fixtures.calls.filter(
      ({ url }) =>
        url.pathname === "/v25.0/ig-1/media" ||
        (url.pathname === "/v25.0/ig-1/insights" &&
          url.searchParams.get("metric")?.startsWith("likes,") === true),
    );
    expect(boundedInstagramCalls).toHaveLength(2);
    for (const { url } of boundedInstagramCalls) {
      expect(url.searchParams.get("since")).toBe(
        String(Date.parse("2026-06-19T00:00:00Z") / 1_000),
      );
      expect(url.searchParams.get("until")).toBe(
        String(Math.floor((Date.parse("2026-07-19T00:00:00Z") - 1) / 1_000)),
      );
    }
    await expect(adapter.refreshGrant?.(listed.grant)).resolves.toMatchObject({
      provider: "instagram",
      accessToken: "instagram-refreshed-token",
    });
    expect(fixtures.remaining).toEqual([]);
  });
});

function demographicFixture(
  breakdown: "country" | "age" | "gender",
  values: Array<[string, number]>,
): FetchFixture {
  return {
    name: `Instagram ${breakdown}`,
    match: (url) =>
      url.pathname === "/v25.0/ig-1/insights" && url.searchParams.get("breakdown") === breakdown,
    json: {
      data: [
        {
          name: "follower_demographics",
          total_value: {
            breakdowns: [
              {
                dimension_keys: ["timeframe", breakdown],
                results: values.map(([value, count]) => ({
                  dimension_values: ["THIS_MONTH", value],
                  value: count,
                })),
              },
            ],
          },
        },
      ],
    },
  };
}

function demographicErrorFixture(
  breakdown: "country" | "age" | "gender",
  status: number,
  json?: unknown,
): FetchFixture {
  return {
    name: `Instagram ${breakdown} error`,
    match: (url) =>
      url.pathname === "/v25.0/ig-1/insights" && url.searchParams.get("breakdown") === breakdown,
    status,
    json,
  };
}

describe("Facebook creator platform adapter", () => {
  it("imports eligible Pages, post activity, daily unique media views, and country data", async () => {
    const fixtures = fixtureFetch([
      {
        name: "short token",
        match: (url) =>
          url.pathname === "/v25.0/oauth/access_token" && !url.searchParams.has("grant_type"),
        json: { access_token: "facebook-short-token" },
      },
      {
        name: "long token",
        match: (url) =>
          url.pathname === "/v25.0/oauth/access_token" &&
          url.searchParams.get("grant_type") === "fb_exchange_token",
        json: { access_token: "facebook-long-token", expires_in: 5_184_000 },
      },
      {
        name: "Facebook grant subject",
        match: (url, init) =>
          url.pathname === "/v25.0/me" &&
          url.searchParams.get("fields") === "id" &&
          authorizationHeader(init) === "Bearer facebook-long-token",
        json: { id: "facebook-user-1" },
      },
      {
        name: "Page list first page",
        match: (url, init) =>
          url.pathname === "/v25.0/me/accounts" &&
          !url.searchParams.has("after") &&
          authorizationHeader(init) === "Bearer facebook-long-token",
        json: {
          data: [
            {
              id: "page-without-insights",
              name: "No insights task",
              access_token: "unused-page-token",
              tasks: ["CREATE_CONTENT"],
            },
          ],
          paging: {
            next: "https://evil.invalid/must-not-be-followed?access_token=facebook-long-token",
            cursors: { after: "page-cursor" },
          },
        },
      },
      {
        name: "Page list second page",
        match: (url) =>
          url.pathname === "/v25.0/me/accounts" && url.searchParams.get("after") === "page-cursor",
        json: {
          data: [
            {
              id: "page-1",
              name: "Creator Page",
              access_token: "facebook-page-token",
              tasks: ["ANALYZE", "CREATE_CONTENT"],
              link: "https://www.facebook.com/creator-page",
              picture: { data: { url: "https://images.example.test/page.jpg" } },
            },
          ],
        },
      },
      {
        name: "Page followers",
        match: (url, init) =>
          url.pathname === "/v25.0/page-1" &&
          authorizationHeader(init) === "Bearer facebook-page-token",
        json: { followers_count: 250 },
      },
      {
        name: "Page daily unique media views",
        match: (url) =>
          url.pathname === "/v25.0/page-1/insights" &&
          url.searchParams.get("metric") === "page_total_media_view_unique",
        json: {
          data: [
            {
              name: "page_total_media_view_unique",
              values: [{ value: 100 }, { value: 120 }],
            },
          ],
        },
      },
      {
        name: "Page demographics",
        match: (url) =>
          url.pathname === "/v25.0/page-1/insights" &&
          url.searchParams.get("metric") === "page_follows_country",
        json: {
          data: [
            {
              name: "page_follows_country",
              values: [{ value: { DE: 60, US: 40 } }],
            },
          ],
        },
      },
      {
        name: "posts first page",
        match: (url) =>
          url.pathname === "/v25.0/page-1/published_posts" && !url.searchParams.has("after"),
        json: {
          data: [
            {
              id: "post-1",
              created_time: "2026-07-10T12:00:00+0000",
              likes: { summary: { total_count: 8 } },
              comments: { summary: { total_count: 3 } },
              shares: { count: 2 },
            },
          ],
          paging: {
            next: "https://graph.facebook.com/v25.0/page-1/published_posts?after=post-cursor",
            cursors: { after: "post-cursor" },
          },
        },
      },
      {
        name: "posts second page",
        match: (url) =>
          url.pathname === "/v25.0/page-1/published_posts" &&
          url.searchParams.get("after") === "post-cursor",
        json: {
          data: [
            {
              id: "post-2",
              created_time: "2026-06-20T12:00:00+0000",
              likes: { summary: { total_count: 5 } },
              comments: { summary: { total_count: 1 } },
            },
          ],
        },
      },
      {
        name: "revoke",
        match: (url, init) =>
          url.pathname === "/v25.0/me/permissions" &&
          init?.method === "DELETE" &&
          authorizationHeader(init) === "Bearer facebook-long-token",
        json: { success: true },
      },
    ]);
    const adapter = createFacebookCreatorPlatformAdapter({
      clientId: "facebook-client",
      clientSecret: "facebook-secret",
      apiVersion: "v25.0",
      fetch: fixtures.fetch,
      now,
    });

    const grant = await adapter.exchangeCode("code", "https://api.example.test/callback");
    const listed = await adapter.listAccounts(grant);
    expect(listed.accounts).toEqual([
      {
        provider: "facebook",
        providerAccountId: "page-1",
        displayName: "Creator Page",
        profileUrl: "https://www.facebook.com/creator-page",
        avatarUrl: "https://images.example.test/page.jpg",
        accountType: "page",
      },
    ]);
    expect(JSON.stringify(listed.accounts)).not.toContain("facebook-page-token");
    expect(listed.grant).toMatchObject({
      subjectId: "facebook-user-1",
      pageAccessTokens: { "page-1": "facebook-page-token" },
    });
    if (listed.grant.provider !== "facebook") throw new Error("Expected Facebook grant");
    const selectedGrant = adapter.grantForAccount!(listed.accounts[0]!, {
      ...listed.grant,
      pageAccessTokens: {
        ...listed.grant.pageAccessTokens,
        "page-2": "must-be-discarded",
      },
    });
    expect(selectedGrant).toMatchObject({
      pageAccessTokens: { "page-1": "facebook-page-token" },
    });
    expect(JSON.stringify(selectedGrant)).not.toContain("must-be-discarded");

    const imported = await adapter.importAccount(listed.accounts[0]!, selectedGrant, window);
    expect(imported).toMatchObject({
      followers: { value: 250 },
      contentCount: { value: 2 },
      likes: { value: 13 },
      comments: { value: 4 },
      shares: { value: 2 },
      reach: { value: null, unavailableReason: "not_supported" },
      views: { value: null, unavailableReason: "not_supported" },
      providerMetrics: { dailyUniqueMediaViewsSum: 220 },
      demographics: {
        countries: { value: { DE: 60, US: 40 } },
        ageGroups: { value: null, unavailableReason: "not_supported" },
        genders: { value: null, unavailableReason: "not_supported" },
      },
    });
    await expect(adapter.revoke?.(listed.grant)).resolves.toBeUndefined();
    expect(fixtures.calls.some(({ url }) => url.hostname === "evil.invalid")).toBe(false);
    expect(fixtures.remaining).toEqual([]);
  });
});

describe("TikTok creator platform adapter", () => {
  it("imports current stats and recent video activity while marking demographics unsupported", async () => {
    const recent = Date.parse("2026-07-18T12:00:00Z") / 1_000;
    const inWindow = Date.parse("2026-06-20T12:00:00Z") / 1_000;
    const beforeWindow = Date.parse("2026-06-18T12:00:00Z") / 1_000;
    const fixtures = fixtureFetch([
      {
        name: "token",
        match: (url, init) =>
          url.pathname === "/v2/oauth/token/" &&
          formValue(init, "grant_type") === "authorization_code",
        json: {
          access_token: "tiktok-access-token",
          expires_in: 86_400,
          open_id: "tiktok-user-1",
          refresh_token: "tiktok-refresh-token",
          refresh_expires_in: 31_536_000,
          scope: "user.info.basic,user.info.profile,user.info.stats,video.list",
        },
      },
      {
        name: "profile",
        match: (url) =>
          url.pathname === "/v2/user/info/" &&
          url.searchParams.get("fields")?.includes("display_name") === true,
        json: {
          data: {
            user: {
              open_id: "tiktok-user-1",
              display_name: "TikTok Creator",
              username: "tiktok_creator",
              profile_deep_link: "https://www.tiktok.com/@tiktok_creator",
              avatar_url: "https://images.example.test/tiktok.jpg",
            },
          },
        },
      },
      {
        name: "stats",
        match: (url) =>
          url.pathname === "/v2/user/info/" &&
          url.searchParams.get("fields") === "open_id,follower_count,likes_count,video_count",
        json: {
          data: {
            user: {
              open_id: "tiktok-user-1",
              follower_count: 900,
              likes_count: 12_345,
              video_count: 42,
            },
          },
        },
      },
      {
        name: "videos first page",
        match: (url, init) =>
          url.pathname === "/v2/video/list/" && JSON.parse(String(init?.body)).cursor === undefined,
        json: {
          data: {
            videos: [
              {
                id: "video-1",
                create_time: recent,
                like_count: 100,
                comment_count: 20,
                share_count: 10,
                view_count: 2_000,
              },
              {
                id: "video-2",
                create_time: inWindow,
                like_count: 50,
                comment_count: 5,
                share_count: 2,
                view_count: 800,
              },
            ],
            has_more: true,
            cursor: 10,
          },
        },
      },
      {
        name: "videos second page",
        match: (url, init) =>
          url.pathname === "/v2/video/list/" && JSON.parse(String(init?.body)).cursor === 10,
        json: {
          data: {
            videos: [
              {
                id: "video-old",
                create_time: beforeWindow,
                like_count: 999,
                comment_count: 999,
                share_count: 999,
                view_count: 999,
              },
            ],
            has_more: true,
            cursor: 20,
          },
        },
      },
      {
        name: "refresh",
        match: (url, init) =>
          url.pathname === "/v2/oauth/token/" && formValue(init, "grant_type") === "refresh_token",
        json: {
          access_token: "tiktok-refreshed-access-token",
          expires_in: 86_400,
          open_id: "tiktok-user-1",
          refresh_token: "tiktok-rotated-refresh-token",
          refresh_expires_in: 31_536_000,
          scope: "user.info.basic,user.info.profile,user.info.stats,video.list",
        },
      },
      {
        name: "revoke",
        match: (url, init) =>
          url.pathname === "/v2/oauth/revoke/" &&
          init?.method === "POST" &&
          formValue(init, "token") === "tiktok-access-token",
        json: {},
      },
    ]);
    const adapter = createTikTokCreatorPlatformAdapter({
      clientKey: "tiktok-client",
      clientSecret: "tiktok-secret",
      fetch: fixtures.fetch,
      now,
    });

    const grant = await adapter.exchangeCode("code", "https://api.example.test/callback");
    const listed = await adapter.listAccounts(grant);
    expect(listed.accounts[0]).toMatchObject({
      provider: "tiktok",
      providerAccountId: "tiktok-user-1",
      displayName: "TikTok Creator",
      username: "tiktok_creator",
      accountType: "profile",
    });
    expect(JSON.stringify(listed.accounts)).not.toContain("tiktok-access-token");

    const imported = await adapter.importAccount(listed.accounts[0]!, listed.grant, window);
    expect(imported).toMatchObject({
      followers: { value: 900 },
      contentCount: { value: 2 },
      likes: { value: 150 },
      comments: { value: 25 },
      shares: { value: 12 },
      reach: { value: null, unavailableReason: "not_supported" },
      views: { value: 2_800 },
      demographics: {
        countries: { value: null, unavailableReason: "not_supported" },
        ageGroups: { value: null, unavailableReason: "not_supported" },
        genders: { value: null, unavailableReason: "not_supported" },
      },
      providerMetrics: { totalLikes: 12_345, totalVideoCount: 42 },
    });
    await expect(adapter.refreshGrant?.(listed.grant)).resolves.toMatchObject({
      accessToken: "tiktok-refreshed-access-token",
      refreshToken: "tiktok-rotated-refresh-token",
    });
    await expect(adapter.revoke?.(listed.grant)).resolves.toBeUndefined();
    expect(fixtures.remaining).toEqual([]);
  });
});

describe("YouTube creator platform adapter", () => {
  it("imports channel activity and privacy-thresholded analytics with the inclusive API end date", async () => {
    const fixtures = fixtureFetch([
      {
        name: "token",
        match: (url, init) =>
          url.pathname === "/token" && formValue(init, "grant_type") === "authorization_code",
        json: {
          access_token: "youtube-access-token",
          expires_in: 3_600,
          refresh_token: "youtube-refresh-token",
          scope:
            "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
        },
      },
      {
        name: "channels",
        match: (url) =>
          url.pathname === "/youtube/v3/channels" && url.searchParams.get("part") === "snippet",
        json: {
          items: [
            {
              id: "youtube-channel-1",
              snippet: {
                title: "YouTube Creator",
                customUrl: "@youtube_creator",
                thumbnails: { high: { url: "https://images.example.test/youtube.jpg" } },
              },
            },
          ],
        },
      },
      {
        name: "statistics",
        match: (url) =>
          url.pathname === "/youtube/v3/channels" &&
          url.searchParams.get("part") === "statistics,contentDetails",
        json: {
          items: [
            {
              id: "youtube-channel-1",
              statistics: { subscriberCount: "1500", hiddenSubscriberCount: false },
              contentDetails: { relatedPlaylists: { uploads: "youtube-uploads-1" } },
            },
          ],
        },
      },
      {
        name: "uploads",
        match: (url) =>
          url.pathname === "/youtube/v3/playlistItems" &&
          url.searchParams.get("playlistId") === "youtube-uploads-1",
        json: {
          items: [
            {
              contentDetails: {
                videoId: "video-1",
                videoPublishedAt: "2026-07-15T12:00:00Z",
              },
            },
            {
              contentDetails: {
                videoId: "video-2",
                videoPublishedAt: "2026-07-01T12:00:00Z",
              },
            },
            {
              contentDetails: {
                videoId: "video-3",
                videoPublishedAt: "2026-06-20T12:00:00Z",
              },
            },
          ],
        },
      },
      youtubeAnalyticsFixture(undefined, {
        columnHeaders: ["views", "likes", "comments", "shares"],
        rows: [[10_000, 500, 60, 20]],
      }),
      youtubeAnalyticsFixture("country", {
        columnHeaders: ["country", "views"],
        rows: [
          ["DE", 6_000],
          ["US", 4_000],
        ],
      }),
      youtubeAnalyticsFixture("ageGroup", {
        columnHeaders: ["ageGroup", "viewerPercentage"],
        rows: [
          ["age13-17", 5],
          ["age18-24", 30],
          ["age25-34", 50],
          ["age55-64", 10],
          ["age65-", 5],
        ],
      }),
      youtubeAnalyticsFixture("gender", {
        columnHeaders: ["gender", "viewerPercentage"],
        rows: [
          ["female", 45],
          ["male", 40],
          ["user_specified", 10],
          ["unknown", 5],
        ],
      }),
      {
        name: "refresh",
        match: (url, init) =>
          url.pathname === "/token" && formValue(init, "grant_type") === "refresh_token",
        json: { access_token: "youtube-refreshed-token", expires_in: 3_600 },
      },
      {
        name: "revoke",
        match: (url, init) =>
          url.pathname === "/revoke" && formValue(init, "token") === "youtube-refresh-token",
        json: {},
      },
    ]);
    const adapter = createYouTubeCreatorPlatformAdapter({
      clientId: "youtube-client",
      clientSecret: "youtube-secret",
      fetch: fixtures.fetch,
      now,
    });

    const grant = await adapter.exchangeCode("code", "https://api.example.test/callback");
    const listed = await adapter.listAccounts(grant);
    expect(listed.accounts[0]).toEqual({
      provider: "youtube",
      providerAccountId: "youtube-channel-1",
      displayName: "YouTube Creator",
      username: "@youtube_creator",
      profileUrl: "https://www.youtube.com/@youtube_creator",
      avatarUrl: "https://images.example.test/youtube.jpg",
      accountType: "channel",
    });
    expect(JSON.stringify(listed.accounts)).not.toContain("youtube-access-token");

    const imported = await adapter.importAccount(listed.accounts[0]!, listed.grant, window);
    expect(imported).toMatchObject({
      followers: { value: 1_500 },
      contentCount: { value: 3 },
      likes: { value: 500 },
      comments: { value: 60 },
      shares: { value: 20 },
      reach: { value: null, unavailableReason: "not_supported" },
      views: { value: 10_000 },
      demographics: {
        countries: { value: { DE: 60, US: 40 } },
        ageGroups: {
          value: { "13-17": 5, "18-24": 30, "25-34": 50, "55+": 15 },
        },
        genders: { value: { female: 45, male: 40, other: 15 } },
      },
    });
    await expect(adapter.refreshGrant?.(listed.grant)).resolves.toMatchObject({
      accessToken: "youtube-refreshed-token",
      refreshToken: "youtube-refresh-token",
    });
    await expect(adapter.revoke?.(listed.grant)).resolves.toBeUndefined();
    const analyticsCalls = fixtures.calls.filter(
      ({ url }) => url.hostname === "youtubeanalytics.googleapis.com",
    );
    expect(analyticsCalls).toHaveLength(4);
    expect(
      analyticsCalls.every(({ url }) => url.searchParams.get("endDate") === "2026-07-18"),
    ).toBe(true);
    expect(fixtures.remaining).toEqual([]);
  });
});

function youtubeAnalyticsFixture(
  dimension: string | undefined,
  data: { columnHeaders: string[]; rows: Array<Array<string | number>> },
): FetchFixture {
  return {
    name: `YouTube analytics ${dimension ?? "activity"}`,
    match: (url) =>
      url.hostname === "youtubeanalytics.googleapis.com" &&
      url.pathname === "/v2/reports" &&
      url.searchParams.get("dimensions") === (dimension ?? null),
    json: {
      columnHeaders: data.columnHeaders.map((name) => ({ name })),
      rows: data.rows,
    },
  };
}

describe("provider response safety", () => {
  it("bounds provider requests and preserves caller cancellation", async () => {
    const controller = new AbortController();
    const fixtures = fixtureFetch([
      {
        name: "bounded request",
        match: (url) => url.pathname === "/bounded",
      },
    ]);

    await fetchOptionalJson("instagram", fixtures.fetch, "https://example.test/bounded", {
      signal: controller.signal,
    });
    const requestSignal = fixtures.calls[0]?.init?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal).not.toBe(controller.signal);

    controller.abort();

    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([400, 401, 429, 500])("does not suppress optional request status %i", async (status) => {
    const fixtures = fixtureFetch([
      {
        name: "optional request failure",
        match: (url) => url.pathname === "/optional",
        status,
      },
    ]);
    await expect(
      fetchOptionalJson("instagram", fixtures.fetch, "https://example.test/optional"),
    ).rejects.toMatchObject({
      status,
      ...(status === 400 ? { category: "request" } : {}),
    });
  });

  it("suppresses an explicitly categorized privacy threshold", async () => {
    const fixtures = fixtureFetch([
      {
        name: "privacy threshold",
        match: (url) => url.pathname === "/optional",
        status: 400,
        json: { error: { reason: "privacy_threshold" } },
      },
    ]);

    await expect(
      fetchOptionalJson("instagram", fixtures.fetch, "https://example.test/optional"),
    ).resolves.toEqual({ ok: false, unavailableReason: "privacy_threshold" });
  });

  it("keeps YouTube quota failures retryable instead of treating them as missing permission", async () => {
    const fixtures = fixtureFetch([
      {
        name: "YouTube quota failure",
        match: (url) => url.pathname === "/optional",
        status: 403,
        json: { error: { errors: [{ reason: "quotaExceeded" }] } },
      },
    ]);

    await expect(
      fetchOptionalJson("youtube", fixtures.fetch, "https://example.test/optional"),
    ).rejects.toMatchObject({ status: 403, category: "quota", reason: "quotaExceeded" });
  });

  it("does not suppress optional request network failures", async () => {
    const networkFailure = vi.fn(async () => {
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch;
    await expect(
      fetchOptionalJson("youtube", networkFailure, "https://example.test/optional"),
    ).rejects.toThrow("network unavailable");
  });

  it("preserves HTTP status without exposing provider response bodies", async () => {
    const fixtures = fixtureFetch([
      {
        name: "unauthorized",
        match: (url) => url.pathname === "/token",
        status: 401,
        json: { error: "invalid_grant", access_token: "must-never-appear" },
      },
    ]);
    const adapter = createYouTubeCreatorPlatformAdapter({
      clientId: "youtube-client",
      clientSecret: "youtube-secret",
      fetch: fixtures.fetch,
      now,
    });

    const error = await adapter
      .exchangeCode("code", "https://api.example.test/callback")
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CreatorPlatformRequestError);
    expect(error).toMatchObject({ status: 401, category: "authorization" });
    expect(String(error)).not.toContain("must-never-appear");
  });

  it("rejects malformed successful responses and non-30-day imports", async () => {
    const fixtures = fixtureFetch([
      {
        name: "malformed token",
        match: (url) => url.pathname === "/token",
        json: { access_token: "must-never-appear" },
      },
    ]);
    const adapter = createYouTubeCreatorPlatformAdapter({
      clientId: "youtube-client",
      clientSecret: "youtube-secret",
      fetch: fixtures.fetch,
      now,
    });
    const error = await adapter
      .exchangeCode("code", "https://api.example.test/callback")
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CreatorPlatformResponseError);
    expect(String(error)).not.toContain("must-never-appear");

    await expect(
      adapter.importAccount(
        {
          provider: "youtube",
          providerAccountId: "channel",
          displayName: "Channel",
          accountType: "channel",
        },
        {
          provider: "youtube",
          accessToken: "token",
          scopes: [],
        },
        { startDate: "2026-06-18", endDate: "2026-07-19" },
      ),
    ).rejects.toThrow("exact 30-day UTC date window");
  });
});
