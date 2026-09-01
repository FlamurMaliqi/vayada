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
  number,
  normalizeMetaApiVersion,
  optionalNumber,
  optionalString,
  record,
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
  FacebookCreatorPlatformGrant,
} from "./types.js";

const provider = "facebook" as const;
const permissions = ["pages_show_list", "pages_read_engagement", "read_insights"];

export type FacebookCreatorPlatformAdapterConfig = CreatorPlatformAdapterRuntime & {
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
};

export function createFacebookCreatorPlatformAdapter(
  config: FacebookCreatorPlatformAdapterConfig,
): CreatorPlatformAdapter {
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const graphVersion = normalizeMetaApiVersion(config.apiVersion);

  return {
    provider,

    buildAuthorizationUrl(state, redirectUri) {
      const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", permissions.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const shortUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
      shortUrl.searchParams.set("client_id", config.clientId);
      shortUrl.searchParams.set("client_secret", config.clientSecret);
      shortUrl.searchParams.set("redirect_uri", redirectUri);
      shortUrl.searchParams.set("code", code);
      const short = record(provider, await fetchJson(provider, fetcher, shortUrl));

      const longUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
      longUrl.searchParams.set("grant_type", "fb_exchange_token");
      longUrl.searchParams.set("client_id", config.clientId);
      longUrl.searchParams.set("client_secret", config.clientSecret);
      longUrl.searchParams.set(
        "fb_exchange_token",
        string(provider, short.access_token, "missing access_token"),
      );
      const long = record(provider, await fetchJson(provider, fetcher, longUrl));
      const expiresIn = number(provider, long.expires_in, "missing expires_in");
      return {
        provider,
        accessToken: string(provider, long.access_token, "missing access_token"),
        expiresAt: expiresAt(now, expiresIn),
        scopes: permissions,
        pageAccessTokens: {},
      } satisfies FacebookCreatorPlatformGrant;
    },

    async listAccounts(grant, signal) {
      assertProvider(grant, provider);
      const accounts = [];
      const pageAccessTokens = { ...grant.pageAccessTokens };
      const subjectUrl = new URL(`https://graph.facebook.com/${graphVersion}/me`);
      subjectUrl.searchParams.set("fields", "id");
      const [managedPages, subjectPayload] = await Promise.all([
        listManagedPages(fetcher, grant, graphVersion, signal),
        fetchJson(
          provider,
          fetcher,
          subjectUrl,
          withAbortSignal(bearer(grant.accessToken), signal),
        ),
      ]);
      const subjectId = identifier(
        provider,
        record(provider, subjectPayload).id,
        "Facebook user missing id",
      );

      for (const pageValue of managedPages) {
        const page = record(provider, pageValue, "invalid Page");
        const tasks = array(provider, page.tasks, "Page missing tasks");
        if (!tasks.some((task) => task === "ANALYZE")) continue;
        const providerAccountId = identifier(provider, page.id, "Page missing id");
        pageAccessTokens[providerAccountId] = string(
          provider,
          page.access_token,
          "Page missing access_token",
        );
        accounts.push({
          provider,
          providerAccountId,
          displayName: string(provider, page.name, "Page missing name"),
          profileUrl: optionalString(page.link),
          avatarUrl: pictureUrl(page.picture),
          accountType: "page" as const,
        });
      }

      return { accounts, grant: { ...grant, subjectId, pageAccessTokens } };
    },

    grantForAccount(account, grant) {
      assertProvider(grant, provider);
      assertAccountProvider(provider, account.provider);
      const pageAccessToken = grant.pageAccessTokens[account.providerAccountId];
      if (!pageAccessToken) {
        throw new Error("Facebook Page access token is missing from the grant");
      }
      return {
        ...grant,
        pageAccessTokens: { [account.providerAccountId]: pageAccessToken },
      };
    },

    async importAccount(account, grant, window, signal) {
      assertProvider(grant, provider);
      assertAccountProvider(provider, account.provider);
      assertImportWindow(window);
      const pageToken = grant.pageAccessTokens[account.providerAccountId];
      if (!pageToken) throw new Error("Facebook Page access token is missing from the grant");

      const pageUrl = new URL(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(account.providerAccountId)}`,
      );
      pageUrl.searchParams.set("fields", "followers_count");
      const insightsUrl = new URL(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(account.providerAccountId)}/insights`,
      );
      insightsUrl.searchParams.set("metric", "page_total_media_view_unique");
      insightsUrl.searchParams.set("period", "day");
      insightsUrl.searchParams.set("since", window.startDate);
      insightsUrl.searchParams.set("until", window.endDate);
      const demographicsUrl = new URL(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(account.providerAccountId)}/insights`,
      );
      demographicsUrl.searchParams.set("metric", "page_follows_country");
      demographicsUrl.searchParams.set("period", "lifetime");

      const pageAuthorization = bearer(pageToken);
      const [pagePayload, insightsResponse, demographicsResponse, posts] = await Promise.all([
        fetchJson(provider, fetcher, pageUrl, withAbortSignal(pageAuthorization, signal)),
        fetchOptionalJson(
          provider,
          fetcher,
          insightsUrl,
          withAbortSignal(pageAuthorization, signal),
        ),
        fetchOptionalJson(
          provider,
          fetcher,
          demographicsUrl,
          withAbortSignal(pageAuthorization, signal),
        ),
        listPosts(fetcher, graphVersion, account.providerAccountId, pageToken, window, signal),
      ]);
      const page = record(provider, pagePayload);
      const followers = optionalNumber(page.followers_count);
      const dailyUniqueMediaViewsSum = insightsResponse.ok
        ? pageInsightTotal(insightsResponse.value, "page_total_media_view_unique")
        : undefined;
      const postTotals = posts.reduce<{ likes: number; comments: number; shares: number }>(
        (totals, post) => ({
          likes: totals.likes + summaryCount(post.likes),
          comments: totals.comments + summaryCount(post.comments),
          shares:
            totals.shares +
            (post.shares
              ? number(provider, record(provider, post.shares).count, "invalid share count")
              : 0),
        }),
        { likes: 0, comments: 0, shares: 0 },
      );

      return {
        provider,
        providerAccountId: account.providerAccountId,
        importedAt: now().toISOString(),
        window,
        followers: metric(followers),
        contentCount: available(posts.length),
        likes: available(postTotals.likes),
        comments: available(postTotals.comments),
        shares: available(postTotals.shares),
        reach: unavailable("not_supported"),
        views: unavailable("not_supported"),
        demographics: pageDemographics(demographicsResponse, followers),
        providerMetrics:
          dailyUniqueMediaViewsSum === undefined ? undefined : { dailyUniqueMediaViewsSum },
      } satisfies CreatorPlatformImport;
    },

    async revoke(grant) {
      assertProvider(grant, provider);
      const url = new URL(`https://graph.facebook.com/${graphVersion}/me/permissions`);
      await fetchOk(provider, fetcher, url, { ...bearer(grant.accessToken), method: "DELETE" });
    },
  };
}

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}` } };
}

async function listManagedPages(
  fetcher: typeof fetch,
  grant: FacebookCreatorPlatformGrant,
  graphVersion: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  let after: string | undefined;
  const pages: Record<string, unknown>[] = [];

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const url = new URL(`https://graph.facebook.com/${graphVersion}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,tasks,link,picture{url}");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const root = record(
      provider,
      await fetchJson(provider, fetcher, url, withAbortSignal(bearer(grant.accessToken), signal)),
    );
    pages.push(
      ...array(provider, root.data, "invalid pages data").map((value) =>
        record(provider, value, "invalid Page"),
      ),
    );
    const next = metaNextCursor(root);
    if (!next) return pages;
    after = next;
  }
  throw new Error("facebook Page pagination exceeded 100 pages");
}

function pictureUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return optionalString((data as Record<string, unknown>).url);
}

async function listPosts(
  fetcher: typeof fetch,
  graphVersion: string,
  pageId: string,
  accessToken: string,
  window: { startDate: string; endDate: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  const posts: Record<string, unknown>[] = [];
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/published_posts`,
    );
    url.searchParams.set(
      "fields",
      "id,created_time,likes.limit(0).summary(true),comments.limit(0).summary(true),shares",
    );
    url.searchParams.set("since", window.startDate);
    url.searchParams.set("until", window.endDate);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const root = record(
      provider,
      await fetchJson(provider, fetcher, url, withAbortSignal(bearer(accessToken), signal)),
    );
    for (const postValue of array(provider, root.data, "invalid posts data")) {
      const post = record(provider, postValue, "invalid post");
      identifier(provider, post.id, "post missing id");
      const createdAt = Date.parse(
        string(provider, post.created_time, "post missing created_time"),
      );
      if (!Number.isFinite(createdAt)) throw new Error("facebook post has an invalid created_time");
      if (createdAt >= start && createdAt < end) posts.push(post);
    }
    const next = metaNextCursor(root);
    if (!next) return posts;
    after = next;
  }
  throw new Error("facebook post pagination exceeded 100 pages");
}

function metaNextCursor(root: Record<string, unknown>): string | undefined {
  if (root.paging === undefined) return undefined;
  const paging = record(provider, root.paging, "invalid paging");
  if (paging.next === undefined) return undefined;
  string(provider, paging.next, "invalid paging next URL");
  const cursors = record(provider, paging.cursors, "missing paging cursors");
  return string(provider, cursors.after, "missing paging cursor");
}

function summaryCount(value: unknown): number {
  if (!value) return 0;
  const summary = record(provider, record(provider, value).summary, "invalid summary");
  return number(provider, summary.total_count, "invalid total_count");
}

function pageInsightTotal(payload: unknown, name: string): number | undefined {
  const root = record(provider, payload);
  const entryValue = array(provider, root.data, "invalid Page insights").find(
    (value) => record(provider, value).name === name,
  );
  if (!entryValue) return undefined;
  const entry = record(provider, entryValue);
  return array(provider, entry.values, "invalid Page insight values").reduce<number>(
    (total, value) =>
      total + number(provider, record(provider, value).value, "invalid Page insight value"),
    0,
  );
}

function pageDemographics(
  response: CreatorPlatformOptionalResponse,
  followers: number | undefined,
): CreatorPlatformImport["demographics"] {
  if (!response.ok) {
    return {
      countries: unavailable(response.unavailableReason),
      ageGroups: unavailable("not_supported"),
      genders: unavailable("not_supported"),
    };
  }
  const root = record(provider, response.value);
  const entries = array(provider, root.data, "invalid Page demographic insights").map((value) =>
    record(provider, value, "invalid Page demographic insight"),
  );
  const unavailableReason =
    followers !== undefined && followers < 100 ? "privacy_threshold" : "not_returned";
  const countries = pageInsightMap(entries, "page_follows_country");

  return {
    countries: percentageMetric(countries, unavailableReason),
    ageGroups: unavailable("not_supported"),
    genders: unavailable("not_supported"),
  };
}

function pageInsightMap(
  entries: Record<string, unknown>[],
  name: string,
): Record<string, number> | undefined {
  const entry = entries.find((value) => value.name === name);
  if (!entry) return undefined;
  const values = array(provider, entry.values, `${name} has invalid values`);
  if (values.length === 0) return undefined;
  const latest = record(provider, values.at(-1), `${name} has an invalid value`);
  const raw = record(provider, latest.value, `${name} has invalid demographic data`);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      number(provider, value, `${name} has an invalid demographic count`),
    ]),
  );
}

function percentageMetric(
  counts: Record<string, number> | undefined,
  missingReason: "privacy_threshold" | "not_returned",
): CreatorPlatformMetric<Record<string, number>> {
  if (!counts) return unavailable(missingReason);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return unavailable("no_data");
  return {
    value: Object.fromEntries(
      Object.entries(counts).map(([key, count]) => [
        key,
        Number(((count / total) * 100).toFixed(2)),
      ]),
    ),
  };
}

function metric(
  value: number | undefined,
  unavailableReason: CreatorPlatformUnavailableReason = "not_returned",
): CreatorPlatformMetric<number> {
  return value === undefined ? unavailable(unavailableReason) : available(value);
}
