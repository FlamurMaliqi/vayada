# MarketplaceCreatorSelfService contract

This contract is marketplace vertical **V3 (creator profile self-service)** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md),
following the contract standard in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md).
It covers the authenticated creator workspace profile reads and profile update
surface:

- `GET /api/marketplace/creators/me/profile-status`
- `GET /api/marketplace/creators/me`
- `PUT /api/marketplace/creators/me`

The backing target tables are `marketplace.creator_profiles`,
`marketplace.creator_platforms`, and `marketplace.creator_matching_preferences`.
The selected creator workspace and ownership
link are resolved through `identity.organizations`,
`identity.organization_memberships`, and `identity.organization_resource_links`
per [`workos-identity-architecture.md`](workos-identity-architecture.md). The
legacy routes are `/creators/me/profile-status`, `GET /creators/me`, and
`PUT /creators/me` in `apps/marketplace-api/app/routers/creators.py`.

Out of scope: collaboration reads/writes, creator public discovery browsing,
profile image upload/storage, platform media ownership, legacy marketplace
`/auth/*`, admin user management, hotel V2 surfaces, and V6 notifications or
invite-code surfaces.

## Migration Slices

Reads land before writes:

1. Document this contract and fixtures.
2. Implement dark TypeScript read routes for profile status and profile details.
3. Add the marketplace-web typed read client and cut over the profile bootstrap
   read path.
4. Implement the dark write route.
5. Add the marketplace-web typed write client and cut over save behavior.

Python remains the production source of truth for non-migrated surfaces until
the matching route, client, and smoke coverage are accepted.

## Endpoints

| Field                  | Profile status                                            | Profile read                                      | Profile write                                             |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| Method                 | `GET`                                                     | `GET`                                             | `PUT`                                                     |
| Path                   | `/api/marketplace/creators/me/profile-status`             | `/api/marketplace/creators/me`                    | `/api/marketplace/creators/me`                            |
| Route adapter          | `registerMarketplaceCreatorSelfServiceRoutes`             | `registerMarketplaceCreatorSelfServiceRoutes`     | `registerMarketplaceCreatorSelfServiceRoutes`             |
| Frontend client target | `getCreatorProfileStatus() -> CreatorProfileStatusResult` | `getMyCreatorProfile() -> CreatorProfileDocument` | `updateMyCreatorProfile(input) -> CreatorProfileDocument` |

## Authorization

All three routes are protected. The route boundary must use
`enforceRoutePolicy`; direct `requireAuthContext` is not enough for this
surface. Because these are `/me` routes, the adapter resolves the selected
creator workspace's active marketplace `creator_profile` resource link. A
workspace that does not have a profile yet uses the existing identity lifecycle
command to create and link exactly one profile. The adapter then calls
`enforceRoutePolicy` with that concrete `resourceId`; it must not invent a policy
check that omits the resource id.

Required context:

- `actor.status = "active"`.
- `selectedOrganization.kind = "creator_workspace"`.
- selected organization status and membership status are active.
- membership has `marketplace.profile.manage`.
- selected organization has exactly one active resource link selected for this
  route:
  `product = "marketplace"`, `resource_type = "creator_profile"`,
  `resource_id = creator_profiles.id`, `relationship = "owner"`.
- the linked `creator_profiles.organization_id` matches the selected
  organization.

If no creator-profile link exists, successful lifecycle provisioning continues
through the same resource-specific policy check. Provisioning failure or an
inactive link is denied. More than one active creator-profile link is a
conflict. If the active link points at a target profile row that no longer
exists, the route returns `404 creator_profile_not_found`.

`creator_profiles.owner_user_id` is a migration compatibility field only. It
must not authorize access and must not be returned by this contract. The old
`users.type = "creator"` check is replaced by the selected
`creator_workspace` organization and permission/resource-link policy.

## Request

### Profile Status Read

```ts
type CreatorProfileStatusRequest = {
  params: Record<string, never>;
  query: Record<string, never>;
};
```

### Profile Read

```ts
type CreatorProfileReadRequest = {
  params: Record<string, never>;
  query: Record<string, never>;
};
```

### Profile Write

`PUT /api/marketplace/creators/me` accepts a partial profile patch. Omitted
fields are unchanged. If `platforms` is omitted, existing platform rows are
unchanged. If `platforms` is present, the full platform set for the profile is
replaced inside the same transaction as the profile update.

```ts
type UpdateCreatorProfileRequest = {
  displayName?: string;
  creatorType?: "lifestyle" | "travel" | "other";
  locationText?: string | null;
  shortDescription?: string | null;
  portfolioUrl?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  platforms?: CreatorProfilePlatformInput[];
  matchingPreferences?: MarketplaceCreatorMatchingPreferencesWrite | null;
};

type CreatorProfilePlatformInput = {
  platform: "instagram" | "tiktok" | "youtube" | "facebook" | "blog" | "x" | "other";
  handle: string;
  profileUrl?: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries?: { country: string; percentage: number }[];
  audienceAgeGroups?: { ageRange: string; percentage: number }[];
  audienceGenderSplit?: { male: number; female: number; other?: number } | null;
};

type MarketplaceCreatorMatchingPreferencesWrite = {
  contentCategories: CodePreference | null;
  deliverableTypes: CodePreference | null;
  compensationTypes: CodePreference<"free_stay" | "paid" | "discount" | "affiliate"> | null;
  collaborationGoals: CodePreference<
    "audience_distribution" | "ugc_creation" | "affiliate_work" | "other"
  > | null;
  travel:
    | { mode: "no_preference" }
    | {
        mode: "planned_trips";
        flexibilityDaysBefore: number;
        flexibilityDaysAfter: number;
      }
    | null;
};

type CodePreference<T extends string = string> =
  | { mode: "no_preference" }
  | { mode: "selected"; values: T[] };
```

Validation:

- `displayName`, when present, must contain non-whitespace text.
- `shortDescription`, when present, is clamped by product validation to
  500 characters.
- `portfolioUrl`, `profilePictureUrl`, and platform `profileUrl`, when present,
  must be absolute `https://` URLs.
- `followerCount >= 0`.
- `engagementRate >= 0`.
- audience percentages must be finite numbers between 0 and 100.
- platform `handle` must contain non-whitespace text.
- platform names use the lowercase target enum; legacy capitalized names are
  client compatibility only and are not accepted by this contract.
- selected matching codes are unique lowercase `snake_case`, with 1–20 values;
- travel flexibility is an integer from 0–365 days on each side;
- unknown matching fields, unsupported compensation/goals, and extra fields
  such as provider metrics are rejected.

Matching state has three distinct meanings:

- absent `matchingPreferences` on an existing profile response is `null` and
  means unknown/not collected;
- a saved field with value `null` means the creator intentionally left that
  dimension unset;
- `{ mode: "no_preference" }` explicitly accepts any value in that dimension.

Omitting `matchingPreferences` from a write leaves it unchanged. Sending the
top-level field as `null` deletes the saved document and returns it to unknown.
`travel.mode = "planned_trips"` evaluates locations and dates from the existing
`marketplace.trips` records, expanding each date range by the declared
flexibility. It does not copy travel locations or dates into preferences. No
usable trip means travel evidence is unknown.

## Response

### Profile Status

```ts
type CreatorProfileStatusResult = {
  creatorProfileId: string;
  organizationId: string;
  profileComplete: boolean;
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  missingFields: CreatorProfileMissingField[];
  missingPlatforms: boolean;
  completionSteps: CreatorProfileCompletionStep[];
  canPublishToDiscovery: boolean;
  updatedAt: string;
};

type CreatorProfileMissingField = "displayName" | "locationText" | "shortDescription" | "platforms";

type CreatorProfileCompletionStep =
  | "add_display_name"
  | "set_location"
  | "add_short_description"
  | "add_platform";
```

Completion rules preserve the legacy product behavior but use target fields:

- `display_name` must be non-empty.
- `location_text` must be non-empty.
- `short_description` must be non-empty.
- at least one `creator_platforms` row must have a non-empty `handle` and
  `follower_count > 0`.

`canPublishToDiscovery` is true only when `profileComplete = true` and
`profileStatus = "active"`.

### Profile Document

```ts
type CreatorProfileDocument = {
  creatorProfileId: string;
  organizationId: string;
  sourceCreatorId: string | null;
  displayName: string | null;
  creatorType: "lifestyle" | "travel" | "other";
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  phone: string | null;
  profilePictureUrl: string | null;
  profileComplete: boolean;
  profileCompletedAt: string | null;
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  platforms: CreatorProfilePlatform[];
  audienceSize: number;
  rating: CreatorProfileRatingSummary;
  matchingPreferences: MarketplaceCreatorMatchingPreferences | null;
  createdAt: string;
  updatedAt: string;
};

type CreatorProfilePlatform = {
  platformId: string;
  platform: "instagram" | "tiktok" | "youtube" | "facebook" | "blog" | "x" | "other";
  handle: string;
  profileUrl: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries: { country: string; percentage: number }[];
  audienceAgeGroups: { ageRange: string; percentage: number }[];
  audienceGenderSplit: { male: number; female: number; other?: number } | null;
  verificationStatus: "unverified" | "verified" | "rejected" | "stale";
};

type CreatorProfileRatingSummary = {
  averageRating: number;
  totalReviews: number;
};

type MarketplaceCreatorMatchingPreferences = MarketplaceCreatorMatchingPreferencesWrite & {
  contractVersion: "marketplace-creator-matching-preferences.v1";
  evidenceSource: "creator_declared";
  revision: number;
  updatedAt: string;
};
```

`creatorType = "migration"` in storage maps to `"other"` in the response.
`audienceSize` is derived from `platforms[].followerCount`; it is not accepted
as a write input. Ratings are read-only aggregates over `creator_ratings`.

The response intentionally does not include `ownerUserId`, raw WorkOS IDs,
membership IDs, email, or profile metadata. `phone` is included because this is
the authenticated self-service edit surface; public discovery responses must
continue to exclude it.

### Matching preference visibility and provider evidence

All raw creator matching preferences are private to the authenticated creator
and internal matching services. Hotels and public discovery APIs must not
receive them. A later matching response may expose only approved user-safe
reason codes such as `destination_match`, `deliverable_match`, or
`compensation_match`; it must not expose private values or minimums.

`updated_by_user_id` is internal audit metadata and is not returned. The API
marks the saved document `evidenceSource: "creator_declared"` and accepts no
provider-derived metrics, audience data, handles, or verification claims in the
preference object. Provider evidence remains usable only through the separate
connection/import contract with active consent, an imported field, and a
successful snapshot no older than 30 days. Compensation minimums are not in v1
because VAY-1407 did not approve an exact minimum-value contract.

## Discovery Coherence

The public `GET /api/marketplace/creators` discovery route is assembled from
`creator_profiles`, `creator_platforms`, and `creator_ratings`. A successful
profile write must keep that read model coherent:

- Profile and platform changes are committed atomically.
- `profile_complete` and `profile_completed_at` are recalculated before the
  response is returned.
- A creator becomes eligible for public discovery only when
  `profile_complete = true`, `profile_status = "active"`, and
  `display_name IS NOT NULL`.
- If the write makes the profile incomplete or non-active, the creator is absent
  from public discovery.
- If a later implementation introduces a denormalized creator discovery read
  model, the write route must update it transactionally or enqueue a durable
  projection job with freshness surfaced in route tests. A fire-and-forget
  projection is not acceptable.

## Errors

Error responses use the established backend-http error envelope:

```ts
type MarketplaceCreatorSelfServiceError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  code:
    | "invalid_body"
    | "unauthorized"
    | "forbidden"
    | "creator_profile_not_found"
    | "missing_resource_access"
    | "profile_conflict"
    | "internal_error";
  category: "validation" | "auth" | "not_found" | "conflict" | "internal";
  message: string;
};
```

| Case                                             | Status | Code                        |
| ------------------------------------------------ | ------ | --------------------------- |
| Missing/invalid auth                             | `401`  | `unauthorized`              |
| Wrong organization kind                          | `403`  | `forbidden`                 |
| Inactive org, membership, or resource link       | `403`  | `forbidden`                 |
| Missing permission                               | `403`  | `forbidden`                 |
| No linked creator profile and provisioning fails | `403`  | `missing_resource_access`   |
| Multiple active creator profile links            | `409`  | `creator_profile_conflict`  |
| Linked target profile row missing                | `404`  | `creator_profile_not_found` |
| Invalid request body                             | `400`  | `invalid_body`              |
| Concurrent update/version conflict               | `409`  | `profile_conflict`          |
| Unexpected failure                               | `500`  | `internal_error`            |

Empty platform collections are successful reads: `platforms: []`,
`audienceSize: 0`, and `missingPlatforms: true`.

## Intentional Differences From Legacy

| Legacy behavior                                                          | Contract behavior                                                            | Why                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Auth checks `users.type = "creator"` and `creators.user_id`.             | Auth checks creator workspace membership, permission, and resource link.     | WorkOS organization/resource-link model replaces direct ownership.   |
| `name` and `email` are loaded from `users` at route runtime.             | `displayName` is stored on `creator_profiles`; email is not returned.        | Product profile reads must not cross-read identity tables.           |
| Platform enum accepts capitalized names.                                 | Lowercase target enums only.                                                 | Matches target DDL and V1 discovery contracts.                       |
| `audience_size` can be sent by the client.                               | `audienceSize` is derived from platform follower counts.                     | Avoids inconsistent stored aggregates.                               |
| Profile writes may update auth user name as a side effect.               | Writes update marketplace profile tables only.                               | Identity writes belong to identity-owned lifecycle/profile surfaces. |
| Email verification and profile-completion email side effects run inline. | Side effects are out of this contract; future notifications use jobs/events. | Keeps this slice contract-first and avoids hidden side effects.      |

## Fixtures

`engineering/fixtures/marketplace-creator-self-service/cases.json`
(`contractVersion: "marketplace-creator-self-service.v1"`) defines the cases
for follow-up route and client tickets:

| Case                                | Asserts                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `profile-status-complete`           | Complete active creator returns no missing fields and can publish.                                |
| `profile-status-incomplete`         | Missing profile fields and platform requirements are reported.                                    |
| `profile-read-populated`            | Full self-service profile shape, private auth fields excluded.                                    |
| `profile-read-empty-platforms`      | Empty platform list is valid with `audienceSize: 0`.                                              |
| `authz-allowed-owner-link`          | Creator workspace owner with permission and active resource link passes.                          |
| `authz-denial-matrix`               | Missing/invalid auth, wrong org kind, inactive membership, missing permission, inactive link.     |
| `authz-bootstrap-missing-link`      | Authorized creator workspace without a profile gets one lifecycle-managed profile and owner link. |
| `profile-write-profile-fields`      | Partial patch updates only profile fields and recalculates completion.                            |
| `profile-write-replaces-platforms`  | Present `platforms` replaces the full platform set atomically.                                    |
| `profile-write-invalid-body`        | Invalid enum, URL, handle, follower, and percentage inputs are rejected.                          |
| `profile-write-discovery-coherence` | Write results match public discovery inclusion/exclusion rules.                                   |

## References

- VAY-797: this contract.
- VAY-737 / `marketplace-route-migration-inventory.md`: V3 scope.
- VAY-803: later AuthKit cutover for marketplace creator/hotel surfaces.
- `workos-identity-architecture.md`: creator workspace organization linkage.
- `request-context-contract.md`: protected route authorization shape.
- `target-schema-ownership-map.md`: marketplace table ownership.
- `packages/backend-migration/migrations/0008_marketplace.sql`: backing DDL.
- `marketplace-discovery-contract.md`: public creator discovery contract.
