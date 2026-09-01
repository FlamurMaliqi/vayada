import {
  array,
  assertAccountProvider,
  assertImportWindow,
  assertProvider,
  available,
  expiresAt,
  fetchJson,
  fetchOptionalJson,
  identifier,
  normalizeGenderBucket,
  number,
  normalizeMetaApiVersion,
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
  CreatorPlatformUnavailableReason,
  InstagramCreatorPlatformGrant,
} from "./types.js";

const provider = "instagram" as const;
const permissions = ["instagram_business_basic", "instagram_business_manage_insights"];

export type InstagramCreatorPlatformAdapterConfig = CreatorPlatformAdapterRuntime & {
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
};

export function createInstagramCreatorPlatformAdapter(
  config: InstagramCreatorPlatformAdapterConfig,
): CreatorPlatformAdapter {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const graphVersion = normalizeMetaApiVersion(config.apiVersion);

  return {
    provider,

    buildAuthorizationUrl(state, redirectUri) {
      const url = new URL("https://www.instagram.com/oauth/authorize");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", permissions.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const body = new FormData();
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
      body.set("grant_type", "authorization_code");
      body.set("redirect_uri", redirectUri);
      body.set("code", code);
      const shortPayload = await fetchJson(
        provider,
        fetcher,
        "https://api.instagram.com/oauth/access_token",
        { method: "POST", body },
      );
      const short = instagramTokenRecord(shortPayload);
      const shortToken = string(provider, short.access_token, "missing access_token");

      const url = new URL("https://graph.instagram.com/access_token");
      url.searchParams.set("grant_type", "ig_exchange_token");
      url.searchParams.set("client_secret", config.clientSecret);
      url.searchParams.set("access_token", shortToken);
      const long = record(provider, await fetchJson(provider, fetcher, url));
      const expiresIn = number(provider, long.expires_in, "missing expires_in");
      return {
        provider,
        accessToken: string(provider, long.access_token, "missing access_token"),
        expiresAt: expiresAt(now, expiresIn),
        scopes: scopes(short.permissions, permissions),
      } satisfies InstagramCreatorPlatformGrant;
    },

    async listAccounts(grant, signal) {
      assertProvider(grant, provider);
      const url = new URL(`https://graph.instagram.com/${graphVersion}/me`);
      url.searchParams.set("fields", "id,user_id,username,name,account_type,profile_picture_url");
      const user = instagramUserRecord(
        await fetchJson(provider, fetcher, url, withAbortSignal(bearer(grant), signal)),
      );
      const providerAccountId = identifier(provider, user.user_id ?? user.id, "missing user id");
      const username = optionalString(user.username);
      return {
        accounts: [
          {
            provider,
            providerAccountId,
            displayName: optionalString(user.name) ?? username ?? providerAccountId,
            username,
            profileUrl: username ? `https://www.instagram.com/${username}/` : undefined,
            avatarUrl: optionalString(user.profile_picture_url),
            accountType: "professional",
          },
        ],
        grant,
      };
    },

    async refreshGrant(grant, signal) {
      assertProvider(grant, provider);
      const url = new URL("https://graph.instagram.com/refresh_access_token");
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", grant.accessToken);
      const payload = record(
        provider,
        await fetchJson(provider, fetcher, url, withAbortSignal(undefined, signal)),
      );
      const expiresIn = number(provider, payload.expires_in, "missing expires_in");
      return {
        ...grant,
        accessToken: string(provider, payload.access_token, "missing access_token"),
        expiresAt: expiresAt(now, expiresIn),
      };
    },

    async importAccount(account, grant, window, signal) {
      assertProvider(grant, provider);
      assertAccountProvider(provider, account.provider);
      assertImportWindow(window);

      const userUrl = new URL(
        `https://graph.instagram.com/${graphVersion}/${encodeURIComponent(account.providerAccountId)}`,
      );
      userUrl.searchParams.set("fields", "followers_count");
      const user = record(
        provider,
        await fetchJson(provider, fetcher, userUrl, withAbortSignal(bearer(grant), signal)),
      );
      const followers = number(provider, user.followers_count, "missing followers_count");
      const activityUrl = insightsUrl(graphVersion, account.providerAccountId, window);
      const [mediaCount, activityResponse, countriesResponse, agesResponse, gendersResponse] =
        await Promise.all([
          countMedia(fetcher, grant, graphVersion, account.providerAccountId, window, signal),
          fetchOptionalJson(provider, fetcher, activityUrl, withAbortSignal(bearer(grant), signal)),
          fetchOptionalJson(
            provider,
            fetcher,
            demographicsUrl(graphVersion, account.providerAccountId, "country"),
            withAbortSignal(bearer(grant), signal),
          ),
          fetchOptionalJson(
            provider,
            fetcher,
            demographicsUrl(graphVersion, account.providerAccountId, "age"),
            withAbortSignal(bearer(grant), signal),
          ),
          fetchOptionalJson(
            provider,
            fetcher,
            demographicsUrl(graphVersion, account.providerAccountId, "gender"),
            withAbortSignal(bearer(grant), signal),
          ),
        ]);
      const activity = activityResponse.ok
        ? insightValues(activityResponse.value)
        : new Map<string, number>();
      const activityUnavailableReason = activityResponse.ok
        ? "not_returned"
        : activityResponse.unavailableReason;
      const demographicUnavailable = followers < 100 ? "privacy_threshold" : "not_returned";

      return {
        provider,
        providerAccountId: account.providerAccountId,
        importedAt: now().toISOString(),
        window,
        followers: available(followers),
        contentCount: available(mediaCount),
        likes: metric(activity.get("likes"), activityUnavailableReason),
        comments: metric(activity.get("comments"), activityUnavailableReason),
        shares: metric(activity.get("shares"), activityUnavailableReason),
        reach: metric(activity.get("reach"), activityUnavailableReason),
        views: metric(activity.get("views"), activityUnavailableReason),
        demographics: {
          countries: demographicMetric(countriesResponse, "country", demographicUnavailable),
          ageGroups: demographicMetric(agesResponse, "age", demographicUnavailable),
          genders: demographicMetric(gendersResponse, "gender", demographicUnavailable),
        },
      } satisfies CreatorPlatformImport;
    },
  };
}

function bearer(grant: InstagramCreatorPlatformGrant): RequestInit {
  return { headers: { Authorization: `Bearer ${grant.accessToken}` } };
}

function instagramTokenRecord(payload: unknown): Record<string, unknown> {
  const root = record(provider, payload);
  if (!Array.isArray(root.data)) return root;
  return record(provider, array(provider, root.data, "invalid token data")[0]);
}

function instagramUserRecord(payload: unknown): Record<string, unknown> {
  const root = record(provider, payload);
  if (!Array.isArray(root.data)) return root;
  return record(provider, array(provider, root.data, "invalid user data")[0]);
}

function insightsUrl(
  graphVersion: string,
  accountId: string,
  window: { startDate: string; endDate: string },
): URL {
  const url = new URL(
    `https://graph.instagram.com/${graphVersion}/${encodeURIComponent(accountId)}/insights`,
  );
  url.searchParams.set("metric", "likes,comments,shares,reach,views");
  url.searchParams.set("period", "day");
  url.searchParams.set("metric_type", "total_value");
  const providerWindow = inclusiveProviderWindow(window);
  url.searchParams.set("since", providerWindow.since);
  url.searchParams.set("until", providerWindow.until);
  return url;
}

function demographicsUrl(
  graphVersion: string,
  accountId: string,
  breakdown: "country" | "age" | "gender",
): URL {
  const url = new URL(
    `https://graph.instagram.com/${graphVersion}/${encodeURIComponent(accountId)}/insights`,
  );
  url.searchParams.set("metric", "follower_demographics");
  url.searchParams.set("period", "lifetime");
  url.searchParams.set("timeframe", "this_month");
  url.searchParams.set("metric_type", "total_value");
  url.searchParams.set("breakdown", breakdown);
  return url;
}

async function countMedia(
  fetcher: typeof fetch,
  grant: InstagramCreatorPlatformGrant,
  graphVersion: string,
  accountId: string,
  window: { startDate: string; endDate: string },
  signal?: AbortSignal,
): Promise<number> {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  const providerWindow = inclusiveProviderWindow(window);
  let after: string | undefined;
  let count = 0;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      `https://graph.instagram.com/${graphVersion}/${encodeURIComponent(accountId)}/media`,
    );
    url.searchParams.set("fields", "id,timestamp");
    url.searchParams.set("since", providerWindow.since);
    url.searchParams.set("until", providerWindow.until);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const root = record(
      provider,
      await fetchJson(provider, fetcher, url, withAbortSignal(bearer(grant), signal)),
    );
    for (const mediaValue of array(provider, root.data, "invalid media data")) {
      const media = record(provider, mediaValue, "invalid media");
      identifier(provider, media.id, "media missing id");
      const timestamp = Date.parse(string(provider, media.timestamp, "media missing timestamp"));
      if (!Number.isFinite(timestamp)) {
        throw new Error("instagram media has an invalid timestamp");
      }
      if (timestamp >= start && timestamp < end) count += 1;
    }
    const next = metaNextCursor(root);
    if (!next) return count;
    after = next;
  }
  throw new Error("instagram media pagination exceeded 100 pages");
}

function inclusiveProviderWindow(window: { startDate: string; endDate: string }): {
  since: string;
  until: string;
} {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const endExclusive = Date.parse(`${window.endDate}T00:00:00Z`);
  return {
    since: String(Math.floor(start / 1_000)),
    until: String(Math.floor((endExclusive - 1) / 1_000)),
  };
}

function metaNextCursor(root: Record<string, unknown>): string | undefined {
  if (root.paging === undefined) return undefined;
  const paging = record(provider, root.paging, "invalid paging");
  if (paging.next === undefined) return undefined;
  string(provider, paging.next, "invalid paging next URL");
  const cursors = record(provider, paging.cursors, "missing paging cursors");
  return string(provider, cursors.after, "missing paging cursor");
}

function insightValues(payload: unknown): Map<string, number> {
  const root = record(provider, payload);
  const result = new Map<string, number>();
  for (const entryValue of array(provider, root.data, "invalid insights data")) {
    const entry = record(provider, entryValue, "invalid insight");
    const name = string(provider, entry.name, "insight missing name");
    if (entry.total_value !== undefined) {
      const total = record(provider, entry.total_value, `${name} has invalid total_value`);
      result.set(name, number(provider, total.value, `${name} missing value`));
      continue;
    }
    const values = array(provider, entry.values, `${name} missing values`);
    result.set(
      name,
      values.reduce<number>(
        (sum, value) =>
          sum + number(provider, record(provider, value).value, `${name} has invalid value`),
        0,
      ),
    );
  }
  return result;
}

function metric(
  value: number | undefined,
  unavailableReason: CreatorPlatformUnavailableReason,
): CreatorPlatformMetric<number> {
  return value === undefined ? unavailable(unavailableReason) : available(value);
}

function demographicMetric(
  response: CreatorPlatformOptionalResponse,
  breakdown: string,
  reason: "privacy_threshold" | "not_returned",
): CreatorPlatformMetric<Record<string, number>> {
  if (!response.ok) return unavailable(response.unavailableReason);
  const root = record(provider, response.value);
  const entries = array(provider, root.data, "invalid demographic data");
  if (entries.length === 0) return unavailable(reason);
  const entry = record(provider, entries[0], "invalid demographic insight");
  const total = record(provider, entry.total_value, "missing demographic total_value");
  const breakdowns = array(provider, total.breakdowns, "missing demographic breakdowns");
  const output: Record<string, number> = {};
  for (const groupValue of breakdowns) {
    const group = record(provider, groupValue);
    const keys = array(provider, group.dimension_keys).map((key) => String(key));
    const index = keys.indexOf(breakdown);
    if (index < 0) continue;
    for (const resultValue of array(provider, group.results)) {
      const result = record(provider, resultValue);
      const dimensions = array(provider, result.dimension_values).map((value) => String(value));
      const rawKey = dimensions[index];
      if (rawKey) {
        const key = breakdown === "gender" ? normalizeGenderBucket(rawKey) : rawKey;
        output[key] =
          (output[key] ?? 0) + number(provider, result.value, "invalid demographic value");
      }
    }
  }
  const sum = Object.values(output).reduce((totalValue, value) => totalValue + value, 0);
  if (sum === 0) return unavailable("no_data");
  return {
    value: Object.fromEntries(
      Object.entries(output).map(([key, value]) => [key, Number(((value / sum) * 100).toFixed(2))]),
    ),
  };
}
