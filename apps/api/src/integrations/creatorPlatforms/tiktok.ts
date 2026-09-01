import {
  array,
  assertAccountProvider,
  assertImportWindow,
  assertProvider,
  available,
  expiresAt,
  fetchJson,
  fetchOk,
  number,
  optionalString,
  record,
  scopes,
  string,
  unavailable,
  withAbortSignal,
} from "./http.js";
import type {
  CreatorPlatformAdapter,
  CreatorPlatformAdapterRuntime,
  CreatorPlatformImport,
  TikTokCreatorPlatformGrant,
} from "./types.js";

const provider = "tiktok" as const;
const permissions = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"];

export type TikTokCreatorPlatformAdapterConfig = CreatorPlatformAdapterRuntime & {
  clientKey: string;
  clientSecret: string;
};

export function createTikTokCreatorPlatformAdapter(
  config: TikTokCreatorPlatformAdapterConfig,
): CreatorPlatformAdapter {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());

  return {
    provider,

    buildAuthorizationUrl(state, redirectUri) {
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.searchParams.set("client_key", config.clientKey);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", permissions.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
      return tokenGrant(
        record(
          provider,
          await fetchJson(provider, fetcher, "https://open.tiktokapis.com/v2/oauth/token/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          }),
        ),
        now,
      );
    },

    async listAccounts(grant, signal) {
      assertProvider(grant, provider);
      const user = await getUser(
        fetcher,
        grant,
        ["open_id", "display_name", "username", "profile_deep_link", "avatar_url"],
        signal,
      );
      const openId = string(provider, user.open_id, "missing open_id");
      const username = optionalString(user.username);
      return {
        accounts: [
          {
            provider,
            providerAccountId: openId,
            displayName: optionalString(user.display_name) ?? username ?? openId,
            username,
            profileUrl: optionalString(user.profile_deep_link),
            avatarUrl: optionalString(user.avatar_url),
            accountType: "profile",
          },
        ],
        grant: { ...grant, openId },
      };
    },

    async refreshGrant(grant, signal) {
      assertProvider(grant, provider);
      const body = new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
      });
      return tokenGrant(
        record(
          provider,
          await fetchJson(
            provider,
            fetcher,
            "https://open.tiktokapis.com/v2/oauth/token/",
            withAbortSignal(
              {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
              },
              signal,
            ),
          ),
        ),
        now,
      );
    },

    async importAccount(account, grant, window, signal) {
      assertProvider(grant, provider);
      assertAccountProvider(provider, account.provider);
      assertImportWindow(window);
      if (account.providerAccountId !== grant.openId) {
        throw new Error("TikTok account does not belong to the grant");
      }
      const [user, videos] = await Promise.all([
        getUser(
          fetcher,
          grant,
          ["open_id", "follower_count", "likes_count", "video_count"],
          signal,
        ),
        listVideos(fetcher, grant, window, signal),
      ]);
      const totals = videos.reduce<{
        likes: number;
        comments: number;
        shares: number;
        views: number;
      }>(
        (result, video) => ({
          likes: result.likes + number(provider, video.like_count, "video missing like_count"),
          comments:
            result.comments + number(provider, video.comment_count, "video missing comment_count"),
          shares: result.shares + number(provider, video.share_count, "video missing share_count"),
          views: result.views + number(provider, video.view_count, "video missing view_count"),
        }),
        { likes: 0, comments: 0, shares: 0, views: 0 },
      );

      return {
        provider,
        providerAccountId: account.providerAccountId,
        importedAt: now().toISOString(),
        window,
        followers: available(number(provider, user.follower_count, "missing follower_count")),
        contentCount: available(videos.length),
        likes: available(totals.likes),
        comments: available(totals.comments),
        shares: available(totals.shares),
        reach: unavailable("not_supported"),
        views: available(totals.views),
        demographics: {
          countries: unavailable("not_supported"),
          ageGroups: unavailable("not_supported"),
          genders: unavailable("not_supported"),
        },
        providerMetrics: {
          totalLikes: number(provider, user.likes_count, "missing likes_count"),
          totalVideoCount: number(provider, user.video_count, "missing video_count"),
        },
      } satisfies CreatorPlatformImport;
    },

    async revoke(grant) {
      assertProvider(grant, provider);
      const body = new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        token: grant.accessToken,
      });
      await fetchOk(provider, fetcher, "https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    },
  };
}

function tokenGrant(payload: Record<string, unknown>, now: () => Date): TikTokCreatorPlatformGrant {
  const token = payload.data ? record(provider, payload.data, "invalid token data") : payload;
  return {
    provider,
    accessToken: string(provider, token.access_token, "missing access_token"),
    expiresAt: expiresAt(now, number(provider, token.expires_in, "missing expires_in")),
    scopes: scopes(token.scope),
    openId: string(provider, token.open_id, "missing open_id"),
    refreshToken: string(provider, token.refresh_token, "missing refresh_token"),
    refreshExpiresAt: expiresAt(
      now,
      number(provider, token.refresh_expires_in, "missing refresh_expires_in"),
    ),
  };
}

async function getUser(
  fetcher: typeof fetch,
  grant: TikTokCreatorPlatformGrant,
  fields: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL("https://open.tiktokapis.com/v2/user/info/");
  url.searchParams.set("fields", fields.join(","));
  const root = record(
    provider,
    await fetchJson(
      provider,
      fetcher,
      url,
      withAbortSignal({ headers: { Authorization: `Bearer ${grant.accessToken}` } }, signal),
    ),
  );
  return record(provider, record(provider, root.data, "missing user data").user, "missing user");
}

async function listVideos(
  fetcher: typeof fetch,
  grant: TikTokCreatorPlatformGrant,
  window: { startDate: string; endDate: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const start = Date.parse(`${window.startDate}T00:00:00Z`) / 1_000;
  const end = Date.parse(`${window.endDate}T00:00:00Z`) / 1_000;
  const videos: Record<string, unknown>[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://open.tiktokapis.com/v2/video/list/");
    url.searchParams.set(
      "fields",
      "id,create_time,like_count,comment_count,share_count,view_count",
    );
    const body = JSON.stringify({ max_count: 20, ...(cursor === undefined ? {} : { cursor }) });
    const root = record(
      provider,
      await fetchJson(
        provider,
        fetcher,
        url,
        withAbortSignal(
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${grant.accessToken}`,
              "Content-Type": "application/json",
            },
            body,
          },
          signal,
        ),
      ),
    );
    const data = record(provider, root.data, "missing videos data");
    const pageVideos = array(provider, data.videos, "invalid videos data").map((value) =>
      record(provider, value, "invalid video"),
    );
    for (const video of pageVideos) {
      const createdAt = number(provider, video.create_time, "video missing create_time");
      if (createdAt >= start && createdAt < end) videos.push(video);
    }
    if (typeof data.has_more !== "boolean") {
      throw new Error("tiktok videos response is missing has_more");
    }
    const oldestTime = pageVideos.reduce<number | undefined>((oldest, video) => {
      const createdAt = number(provider, video.create_time, "video missing create_time");
      return oldest === undefined ? createdAt : Math.min(oldest, createdAt);
    }, undefined);
    if (!data.has_more || (oldestTime !== undefined && oldestTime < start)) return videos;
    cursor = number(provider, data.cursor, "missing video cursor");
  }
  throw new Error("tiktok video pagination exceeded 100 pages");
}
