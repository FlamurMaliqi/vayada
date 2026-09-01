# Marketplace creator platform connections

This contract defines V1 automatic creator-account connections for Instagram,
Facebook Pages, TikTok, and YouTube. It extends the creator profile contract in
[`marketplace-creator-self-service-contract.md`](marketplace-creator-self-service-contract.md)
without replacing manual platform entry.

The frontend presents one connection experience. The backend keeps a separate
adapter for each provider-facing platform and normalizes the data before it is
written to Marketplace tables.

## Scope

V1 supports:

| Platform  | Credential provider | Eligible account                         | Import intent                                                                          |
| --------- | ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Instagram | Meta                | Professional Creator or Business account | Followers, reach, interactions, content count, and available demographics              |
| Facebook  | Meta                | Facebook Page                            | Followers, unique media reach, interactions, content count, and available country data |
| TikTok    | TikTok              | Authorized profile                       | Followers, recent-video views, likes, comments, shares, and content count              |
| YouTube   | Google              | Authorized channel                       | Subscribers, views, likes, comments, shares, content count, and available demographics |

The provider identifiers stored in authorization and connection rows are
`meta`, `tiktok`, and `google`. The platform remains one of `instagram`,
`facebook`, `tiktok`, or `youtube`, so Instagram and Facebook callbacks cannot
be confused even though both use Meta credentials.

TikTok does not provide the detailed countries, age groups, or gender split
needed by this profile. Those fields remain manually editable. The same manual
fallback applies when any other provider omits a metric because of permissions,
privacy thresholds, or insufficient data.

Facebook's current Page Insights API exposes country data through
`page_follows_country`, but its former Page age/gender metric has been
[retired without a replacement](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics).
Facebook age and gender therefore remain manually editable in V1.

X, LinkedIn, Lemon8, blogs, and other networks remain manual platform entries.
They do not receive a provider authorization or connection row in V1.

## Authorization and ownership

All creator connection routes use the same selected creator-workspace resource
policy as creator profile self-service:

- the actor, selected organization, and membership are active;
- the selected organization is a `creator_workspace`;
- the membership has `marketplace.profile.manage`;
- an active `creator_profile` owner resource link resolves the concrete
  `creator_profile_id`;
- every read and write includes both that profile ID and organization ID.

The actor starting the flow is persisted as `actor_user_id`. A callback may
only consume the one-time authorization created for that actor's resolved
profile and organization. Provider account IDs never authorize access by
themselves.

Creators may connect more than one account on the same platform. Each selected
account has its own `creator_platforms` row and connection row. The same
external account cannot be claimed by two Vayada creator profiles for the same
platform. Authorization can target an existing owned manual row, upgrading it
instead of creating a duplicate. The provider owns the handle and profile URL
while connected; any unavailable statistics keep their manual values.

## Common flow

1. The creator chooses a platform.
2. Vayada creates a short-lived authorization and returns the provider URL.
3. The provider authenticates the creator and asks for the required scopes.
4. The callback validates and atomically consumes the hashed state.
5. Vayada exchanges the code and stages the grant in the credential vault under
   a fresh, per-account reference with a durable cleanup intent.
6. If the grant exposes multiple eligible accounts, Vayada returns a safe
   account list and waits for the creator's selection.
7. Vayada imports the selected account, calculates engagement, saves a dated
   snapshot, and projects imported fields onto `creator_platforms`.
8. Later syncs claim a generation lease, refresh into another fresh credential
   reference, atomically swap it with the imported snapshot, and retire the old
   reference through the cleanup path.

The callback-to-web redirect query is deliberately small:

```text
connection=success|select|error
platform=instagram|facebook|tiktok|youtube
authorization_id=<uuid>  # select only
connection_id=<uuid>     # success only
error_code=<stable_code> # error only
```

No access token, authorization code, provider payload, or account data belongs
in the redirect URL.

## Storage model

Migration
[`0035_marketplace_creator_platform_connections.sql`](../packages/backend-migration/migrations/0035_marketplace_creator_platform_connections.sql)
adds four tenant-scoped tables.

### `creator_platform_authorizations`

A short-lived OAuth attempt contains the profile, organization, actor,
platform/provider pair, an optional owned manual-row target, a digest of
one-time state, safe account-selection candidates, granted scope names, expiry,
consumption time, and a stable error code. Callback completion rechecks that the
initiating actor still has the active membership, permission, and creator owner
link that authorized the flow.

Authorization status is exactly:

- `authorizing`
- `processing`
- `pending_account_selection`
- `active`
- `failed`
- `expired`

Provider grants are never stored in this table. `credential_ref` is an opaque
credential-vault reference. Callback exchange and account selection take a
short processing lease; abandoned work becomes eligible for cleanup only after
that lease expires.

### `creator_platform_connections`

A connection binds one authorization and one `creator_platforms` row to the
provider's external account ID. It records safe capabilities, the fields most
recently imported, fields unavailable during that import, credential expiry
metadata, and sync timestamps.

Connection status is exactly:

- `active`
- `reconnect_required`
- `revoked`
- `sync_failed`

A non-revoked connection requires a nonblank credential reference. Each sync
uses a short generation lease so two workers cannot publish different metrics
or credentials for the same connection. The authorization row keeps the opaque
reference until vault deletion succeeds, so cleanup remains retryable across
provider or vault outages.

The safe connection response exposes:

```ts
type CreatorPlatformConnectionSummary = {
  connectionId: string;
  platformId: string;
  platform: "instagram" | "facebook" | "tiktok" | "youtube";
  provider: "meta" | "tiktok" | "google";
  externalAccountId: string;
  status: "active" | "reconnect_required" | "revoked" | "sync_failed";
  capabilities: CreatorPlatformImportField[];
  importedFields: CreatorPlatformImportField[];
  unavailableFields: Array<{
    field: CreatorPlatformImportField;
    reason: CreatorPlatformUnavailableReason;
  }>;
  lastSyncAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
};
```

Credential references, token expiry timestamps, authorization IDs, provider
grants, and provider response bodies are private and never returned.

### `creator_platform_metric_snapshots`

Each successful import appends a normalized, dated snapshot. It retains
followers, content count, likes, comments, shares, reach, views, engagement
rate, and available demographics. Reach and views remain useful historical
evidence even though the current public creator profile does not expose both.

`window_start` is inclusive and `window_end` is exclusive. V1 writes 30-day
snapshots; the schema also permits a future 90-day window. Every snapshot stores
the formula version that produced its engagement rate.

### `creator_platform_credential_cleanup_jobs`

Failed, expired, replaced, disconnected, and deleted-profile grants are removed
by an idempotent cleanup loop. A cleanup intent is written before every new
vault grant; the same database transaction that activates the grant must consume
that unclaimed intent. This prevents both an orphaned secret after a crash and a
late activation after cleanup has started.

Live authorization rows act as the retry ledger. The cleanup table preserves
only an opaque vault reference when its authorization row is deleted with a
profile. Workers claim jobs with an expiring lease, delete from the vault, and
only then remove the job. A crash or failed deletion therefore remains
retryable. No cleanup job contains a grant or provider payload.

## Normalized field vocabulary

Capabilities and imported field lists only use:

```text
followerCount
reach
views
contentItemCount
likes
comments
shares
engagementRate
audienceCountries
audienceAgeGroups
audienceGenderSplit
```

An unavailable field uses one of these stable reasons:

```text
unsupported
privacy_threshold
permission_missing
insufficient_data
account_type_ineligible
provider_omitted
```

Provider-specific errors are mapped to this vocabulary at the adapter boundary.
Raw provider reason strings do not enter the public contract.

## Engagement formula

V1 uses a consistent 30-day, per-content engagement rate:

```text
((likes + comments + shares) / contentItemCount / followerCount) * 100
```

The formula version is `creator-platform-engagement.v1`; results are rounded to
four decimal places. Zero interactions are valid and produce `0`. The result is
`null` when follower count, content count, likes, comments, or shares is absent,
non-finite, negative, or when either denominator is zero. A missing component
must not be silently treated as zero.

The formula and requested interval are consistent; provider reporting semantics
are not identical. Facebook and TikTok expose current counters for content
published in the interval, while Instagram and YouTube can report interactions
recorded during the interval. Snapshots retain the requested window, normalized
components, formula version, and safe provider-specific metrics. Vayada treats
the result as a normalized collaboration signal, not a cross-platform audited
measurement.

## Manual fallback and projection

Only a field named in `importedFields` and carrying a non-null normalized value
may overwrite the current `creator_platforms` value. While connected, the
self-service API rejects direct edits to those provider-owned fields; the UI
also renders them read-only. An omitted or unavailable field preserves the
creator's manual value and remains editable. This is especially important for
TikTok demographics and for YouTube or Meta privacy-threshold results.

An imported zero is a real value and must be projected. Manual edits remain
available for every missing field after a connection is active.

Country codes are normalized to display names, ordered by audience share, and
limited to the top three. Provider age buckets are combined into the profile's
adult buckets (`18-24`, `25-34`, `35-44`, `45-54`, `55+`), ordered by share,
and limited to the top three. Provider errors are classified as authorization,
permission/privacy, rate-limit, quota, transient, or request failures so a
quota outage never incorrectly marks a creator as needing to reconnect.

## Credential and payload safety

- Store grants in the credential vault; SQL stores opaque references only.
- If provider or vault configuration is unavailable, credential cleanup fails
  closed and retains its durable retry record; it never treats an empty local
  vault as proof that a production secret was deleted.
- Persist only a digest of OAuth state and consume it once before its expiry.
- Never write access tokens, refresh tokens, client secrets, authorization
  codes, raw provider responses, or credential-shaped JSON to Marketplace
  tables, jobs, audit metadata, logs, or URLs.
- Account-selection candidates contain only the external account ID, display
  name, handle, profile URL, avatar URL, and account type.
- Background jobs carry connection IDs, not credentials. Workers resolve the
  vault reference after rechecking connection ownership and status.
- Treat an invalid or revoked grant as `reconnect_required`. Retry transient
  rate limits and provider 5xx failures without replacing a last successful
  snapshot.
- V1 disconnect is deliberately local-only: it marks the connection `revoked`
  and removes Vayada's per-account vault secret through the retryable cleanup
  path. It does not revoke the provider-level consent grant, because Meta and
  Google grants may be shared by another connected account or a concurrent
  reconnect. Creators can revoke Vayada itself from the provider's account
  settings. Snapshot retention follows the creator privacy and account-deletion
  policy.

The migration applies recursive JSON guards to candidates, unavailable-field
metadata, demographics, and provider-specific normalized metrics so a token or
raw response cannot be accidentally persisted there.

## Production readiness

The in-repository runtime is implemented. It schedules each active connection
after its last successful snapshot becomes due, persists an ID-only job in
`platform.jobs`, reacquires current workspace ownership and connection status,
and only then reads the credential vault. Provider work is serialized and
spaced independently for Meta, TikTok, and Google. Rate limits, quota failures,
network failures, vault-read failures, and provider 5xx responses receive
bounded exponential retries. Failed attempts never replace the last successful
snapshot. Invalid or revoked grants move the connection to
`reconnect_required`; exhausted non-authorization failures move it to
`sync_failed` and leave dead-letter evidence.

The runtime starts automatically when at least one complete provider config is
present and only enqueues connections for configured credential providers. It
cancels in-flight provider and credential-vault calls during graceful shutdown.
`CREATOR_PLATFORM_SYNC_ENABLED=false` disables it. Poll cadence, recurring
interval, batch size, maximum attempts, and each provider's minimum job-start
spacing are configurable through the `CREATOR_PLATFORM_SYNC_*`,
`CREATOR_PLATFORM_META_*`, `CREATOR_PLATFORM_TIKTOK_*`, and
`CREATOR_PLATFORM_GOOGLE_*` variables documented in `apps/api/.env.example`.

External production enablement is still blocked until a human completes all of
the following outside this repository:

1. Register the Meta, TikTok, and Google applications and configure the exact
   deployed callback URLs.
2. Obtain provider review/approval for the production scopes used by Instagram
   professional insights, Facebook Page insights, TikTok profile/video data,
   and YouTube Data/Analytics.
3. Add provider credentials to the production deployment secret store and give
   the API task role access to the configured Secrets Manager prefix. Never put
   those values in source control, Linear, pull requests, or chat.
4. Complete the provider-specific retention/compliance review.
5. Run live OAuth, account-selection, initial-import, scheduled-refresh,
   revoked-grant, and reconnect evidence for all four platforms in the deployed
   environment.

Until a provider's complete configuration and external approval are available,
the API reports a stable not-configured error instead of starting an
authorization that cannot complete. Local adapter and worker tests are not
evidence of provider approval or live OAuth verification.
