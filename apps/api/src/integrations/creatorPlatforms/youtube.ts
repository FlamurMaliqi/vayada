import {
  array,
  assertAccountProvider,
  assertImportWindow,
  assertProvider,
  available,
  expiresAt,
  fetchJson,
  fetchOptionalJson,
  fetchOk,
  identifier,
  normalizeGenderBucket,
  number,
  optionalNumber,
  optionalString,
  record,
  scopes,
  string,
  type CreatorPlatformOptionalResponse,
  unavailable,
  withAbortSignal,
} from "./http.js";
import type {
  CreatorPlatformAdapter,
  CreatorPlatformAdapterRuntime,
  CreatorPlatformImport,
  CreatorPlatformMetric,
  YouTubeCreatorPlatformGrant,
} from "./types.js";

const provider = "youtube" as const;
const permissions = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export type YouTubeCreatorPlatformAdapterConfig = CreatorPlatformAdapterRuntime & {
  clientId: string;
  clientSecret: string;
};

export function createYouTubeCreatorPlatformAdapter(
  config: YouTubeCreatorPlatformAdapterConfig,
): CreatorPlatformAdapter {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());

  return {
    provider,

    buildAuthorizationUrl(state, redirectUri) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", permissions.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });
      const token = record(
        provider,
        await fetchJson(provider, fetcher, "https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      return googleGrant(token, now);
    },

    async listAccounts(grant, signal) {
      assertProvider(grant, provider);
      const url = new URL("https://www.googleapis.com/youtube/v3/channels");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("mine", "true");
      url.searchParams.set("maxResults", "50");
      const root = record(
        provider,
        await fetchJson(provider, fetcher, url, withAbortSignal(bearer(grant), signal)),
      );
      const accounts = array(provider, root.items, "invalid channels data").map((itemValue) => {
        const item = record(provider, itemValue, "invalid channel");
        const snippet = record(provider, item.snippet, "channel missing snippet");
        const providerAccountId = identifier(provider, item.id, "channel missing id");
        const customUrl = optionalString(snippet.customUrl);
        return {
          provider,
          providerAccountId,
          displayName: string(provider, snippet.title, "channel missing title"),
          username: customUrl,
          profileUrl: customUrl
            ? `https://www.youtube.com/${customUrl}`
            : `https://www.youtube.com/channel/${providerAccountId}`,
          avatarUrl: channelAvatar(snippet.thumbnails),
          accountType: "channel" as const,
        };
      });
      return { accounts, grant };
    },

    async refreshGrant(grant, signal) {
      assertProvider(grant, provider);
      if (!grant.refreshToken) throw new Error("YouTube refresh token is missing");
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
      });
      const token = record(
        provider,
        await fetchJson(
          provider,
          fetcher,
          "https://oauth2.googleapis.com/token",
          withAbortSignal(
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body,
            },
            signal,
          ),
        ),
      );
      return googleGrant(token, now, grant);
    },

    async importAccount(account, grant, window, signal) {
      assertProvider(grant, provider);
      assertAccountProvider(provider, account.provider);
      assertImportWindow(window);
      const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
      channelUrl.searchParams.set("part", "statistics,contentDetails");
      channelUrl.searchParams.set("id", account.providerAccountId);
      const channelPayload = await fetchJson(
        provider,
        fetcher,
        channelUrl,
        withAbortSignal(bearer(grant), signal),
      );
      const channelRoot = record(provider, channelPayload);
      const channel = record(
        provider,
        array(provider, channelRoot.items, "invalid channel data")[0],
        "channel not returned",
      );
      const statistics = record(provider, channel.statistics, "channel missing statistics");
      const contentDetails = record(
        provider,
        channel.contentDetails,
        "channel missing contentDetails",
      );
      const relatedPlaylists = record(
        provider,
        contentDetails.relatedPlaylists,
        "channel missing relatedPlaylists",
      );
      const uploadsPlaylistId = string(
        provider,
        relatedPlaylists.uploads,
        "channel missing uploads playlist",
      );
      const [contentCount, activityResponse, countriesResponse, agesResponse, gendersResponse] =
        await Promise.all([
          countUploads(fetcher, grant, uploadsPlaylistId, window, signal),
          optionalAnalytics(
            fetcher,
            grant,
            account.providerAccountId,
            window,
            {
              metrics: "views,likes,comments,shares",
            },
            signal,
          ),
          optionalAnalytics(
            fetcher,
            grant,
            account.providerAccountId,
            window,
            {
              dimensions: "country",
              metrics: "views",
            },
            signal,
          ),
          optionalAnalytics(
            fetcher,
            grant,
            account.providerAccountId,
            window,
            {
              dimensions: "ageGroup",
              metrics: "viewerPercentage",
            },
            signal,
          ),
          optionalAnalytics(
            fetcher,
            grant,
            account.providerAccountId,
            window,
            {
              dimensions: "gender",
              metrics: "viewerPercentage",
            },
            signal,
          ),
        ]);
      const activity = activityResponse.ok ? analyticsRows(activityResponse.value)[0] : undefined;

      return {
        provider,
        providerAccountId: account.providerAccountId,
        importedAt: now().toISOString(),
        window,
        followers: subscriberMetric(statistics),
        contentCount: available(contentCount),
        likes: activityResponse.ok
          ? activityMetric(activity, "likes")
          : unavailable(activityResponse.unavailableReason),
        comments: activityResponse.ok
          ? activityMetric(activity, "comments")
          : unavailable(activityResponse.unavailableReason),
        shares: activityResponse.ok
          ? activityMetric(activity, "shares")
          : unavailable(activityResponse.unavailableReason),
        reach: unavailable("not_supported"),
        views: activityResponse.ok
          ? activityMetric(activity, "views")
          : unavailable(activityResponse.unavailableReason),
        demographics: {
          countries: percentageByViews(countriesResponse),
          ageGroups: percentageRows(agesResponse, "ageGroup"),
          genders: percentageRows(gendersResponse, "gender"),
        },
      } satisfies CreatorPlatformImport;
    },

    async revoke(grant) {
      assertProvider(grant, provider);
      const body = new URLSearchParams({ token: grant.refreshToken ?? grant.accessToken });
      await fetchOk(provider, fetcher, "https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    },
  };
}

function googleGrant(
  token: Record<string, unknown>,
  now: () => Date,
  previous?: YouTubeCreatorPlatformGrant,
): YouTubeCreatorPlatformGrant {
  return {
    provider,
    accessToken: string(provider, token.access_token, "missing access_token"),
    expiresAt: expiresAt(now, number(provider, token.expires_in, "missing expires_in")),
    scopes: scopes(token.scope, previous?.scopes ?? permissions),
    refreshToken: optionalString(token.refresh_token) ?? previous?.refreshToken,
  };
}

function bearer(grant: YouTubeCreatorPlatformGrant): RequestInit {
  return { headers: { Authorization: `Bearer ${grant.accessToken}` } };
}

function channelAvatar(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const thumbnails = value as Record<string, unknown>;
  for (const size of ["high", "medium", "default"]) {
    const candidate = thumbnails[size];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const url = optionalString((candidate as Record<string, unknown>).url);
      if (url) return url;
    }
  }
  return undefined;
}

async function countUploads(
  fetcher: typeof fetch,
  grant: YouTubeCreatorPlatformGrant,
  uploadsPlaylistId: string,
  window: { startDate: string; endDate: string },
  signal?: AbortSignal,
): Promise<number> {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  let pageToken: string | undefined;
  let count = 0;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const root = record(
      provider,
      await fetchJson(provider, fetcher, url, withAbortSignal(bearer(grant), signal)),
    );
    let reachedBeforeWindow = false;
    for (const itemValue of array(provider, root.items, "invalid upload data")) {
      const item = record(provider, itemValue, "invalid upload");
      const contentDetails = record(provider, item.contentDetails, "upload missing contentDetails");
      identifier(provider, contentDetails.videoId, "upload missing videoId");
      const publishedAt = Date.parse(
        string(provider, contentDetails.videoPublishedAt, "upload missing videoPublishedAt"),
      );
      if (!Number.isFinite(publishedAt)) throw new Error("youtube upload has an invalid date");
      if (publishedAt >= start && publishedAt < end) count += 1;
      if (publishedAt < start) reachedBeforeWindow = true;
    }
    if (reachedBeforeWindow) return count;
    pageToken = optionalString(root.nextPageToken);
    if (!pageToken) return count;
  }
  throw new Error("youtube upload pagination exceeded 100 pages");
}

async function optionalAnalytics(
  fetcher: typeof fetch,
  grant: YouTubeCreatorPlatformGrant,
  channelId: string,
  window: { startDate: string; endDate: string },
  query: { metrics: string; dimensions?: string },
  signal?: AbortSignal,
): Promise<CreatorPlatformOptionalResponse> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", `channel==${channelId}`);
  url.searchParams.set("startDate", window.startDate);
  url.searchParams.set("endDate", previousDate(window.endDate));
  url.searchParams.set("metrics", query.metrics);
  if (query.dimensions) url.searchParams.set("dimensions", query.dimensions);
  return fetchOptionalJson(provider, fetcher, url, withAbortSignal(bearer(grant), signal));
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function analyticsRows(payload: unknown): Array<Record<string, string | number>> {
  const root = record(provider, payload);
  const headers = array(provider, root.columnHeaders, "missing analytics headers").map((value) =>
    string(provider, record(provider, value).name, "analytics header missing name"),
  );
  if (root.rows === undefined) return [];
  return array(provider, root.rows, "invalid analytics rows").map((rowValue) => {
    const values = array(provider, rowValue, "invalid analytics row");
    if (values.length !== headers.length) throw new Error("youtube analytics row width mismatch");
    return Object.fromEntries(
      headers.map((header, index) => {
        const value = values[index];
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error("youtube analytics returned an invalid cell");
        }
        return [header, value];
      }),
    );
  });
}

function activityMetric(
  row: Record<string, string | number> | undefined,
  name: string,
): CreatorPlatformMetric<number> {
  return row ? metric(optionalNumber(row[name])) : unavailable("no_data");
}

function subscriberMetric(statistics: Record<string, unknown>): CreatorPlatformMetric<number> {
  const count = optionalNumber(statistics.subscriberCount);
  if (count !== undefined) return available(count);
  return unavailable(
    statistics.hiddenSubscriberCount === true ? "privacy_threshold" : "not_returned",
  );
}

function metric(value: number | undefined): CreatorPlatformMetric<number> {
  return value === undefined ? unavailable("not_returned") : available(value);
}

function percentageByViews(
  response: CreatorPlatformOptionalResponse,
): CreatorPlatformMetric<Record<string, number>> {
  if (!response.ok) return unavailable(response.unavailableReason);
  const rows = analyticsRows(response.value);
  const total = rows.reduce((sum, row) => sum + (optionalNumber(row.views) ?? 0), 0);
  if (total === 0) return unavailable("privacy_threshold");
  return {
    value: Object.fromEntries(
      rows.map((row) => [
        String(row.country),
        Number((((optionalNumber(row.views) ?? 0) / total) * 100).toFixed(2)),
      ]),
    ),
  };
}

function percentageRows(
  response: CreatorPlatformOptionalResponse,
  dimension: string,
): CreatorPlatformMetric<Record<string, number>> {
  if (!response.ok) return unavailable(response.unavailableReason);
  const rows = analyticsRows(response.value);
  if (rows.length === 0) return unavailable("privacy_threshold");
  const output: Record<string, number> = {};
  for (const row of rows) {
    const rawKey = string(provider, row[dimension], `invalid ${dimension}`);
    const key =
      dimension === "ageGroup" ? normalizeAgeGroup(rawKey) : normalizeGenderBucket(rawKey);
    output[key] =
      (output[key] ?? 0) + number(provider, row.viewerPercentage, "invalid viewerPercentage");
  }
  return {
    value: output,
  };
}

function normalizeAgeGroup(value: string): string {
  const ageGroup = value.replace(/^age/, "");
  return ageGroup === "55-64" || ageGroup === "65-" ? "55+" : ageGroup;
}
