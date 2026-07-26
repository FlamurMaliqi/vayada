# Adaptive Hotel Onboarding and Setup Tracks

_VAY-965 decision record. This document defines the next onboarding contract
above the existing shared hotel setup status V1 API. It does not change the
Booking/PMS domain split or the V1 wire contract._

## Decision

Hotel owners choose outcomes, not Vayada's internal product boundaries.

Vayada exposes two onboarding tracks:

| Setup track           | Owner-facing outcome                        | Internal products      |
| --------------------- | ------------------------------------------- | ---------------------- |
| `hotel_operations`    | Manage the hotel and accept direct bookings | PMS and Booking Engine |
| `creator_marketplace` | Promote the hotel through travel creators   | Creator Marketplace    |

An owner may select either track or both. Onboarding must never offer Booking
Engine without PMS. Selecting `hotel_operations` provisions PMS and Booking as
one atomic commercial bundle.

This bundle is an onboarding and provisioning rule, not a domain merger:

- Booking owns guest-facing direct booking, quote, checkout, and booking policy.
- PMS owns room/rate inventory, operational reservations, room assignment, and
  channel connectivity.
- Finance owns payment capability and provider onboarding.
- Distribution owns public bookability and publication readiness.
- Marketplace owns creator-facing profile overlays and collaboration offers.
- Hotel Catalog owns canonical property identity and public-profile facts.

The shared setup orchestrator sequences domain-owned readiness facts. It does
not calculate new product readiness by reading another domain's raw tables.
Unlike V1, V2 keeps organization track intent, effective entitlement,
per-property progress, and requested product entry as separate concepts.

## Scope Model

- Track intent applies to the selected `hotel_group` and every property in it.
  The UI states that impact; only `hotel_catalog.products.manage` may change it.
- `identity.product_entitlements` is the RequestContext read model for effective
  access and suspension. Finance owns upstream billing entitlement decisions.
  Access cannot reveal intent because suspension, aliases, billing provenance,
  and historical partial combinations change what is currently effective.
- Readiness belongs to one canonical property. Every actionable plan and task
  carries an authorized `propertyId`; multi-property groups require an explicit,
  directly linked selection. Portfolio summaries are never writable plans.
- `entryDecision` determines whether a requested product may open;
  `setupPlan.recommendedTaskId` only guides onboarding.

A product-entry guard must never redirect an active user into an unrelated
recommended task. Operators may read plans but not change account-wide tracks.
Removing a provisioned track is a separate, confirmed, audited service-management
flow; omission from an onboarding request never removes access.

## Persisted Track Intent

Add one organization-scoped aggregate, conceptually:

```ts
type OrganizationSetupTrackIntent = {
  organizationId: string;
  selectedTracks: Array<"hotel_operations" | "creator_marketplace">;
  policyVersion: number;
  revision: number;
  confirmationState: "confirmed" | "inferred";
  createdAt: string;
  updatedAt: string;
};
```

The next available migration adds the Hotel Catalog table, one row per
`hotel_group`. It rejects other organization kinds and permits only either
single track or both tracks in canonical order. Absence is the only unconfigured
state and has effective revision `0`; an owner-created or inferred row starts at
`1`, and every confirmation or additive change increments it once.

| Current intent       | Requested intent | Setup-command result                        |
| -------------------- | ---------------- | ------------------------------------------- |
| None                 | Either or both   | Create confirmed intent                     |
| Inferred             | Same or superset | Confirm, preflight additions, increment     |
| One confirmed track  | Both             | Add the other track                         |
| Confirmed            | Same set         | No-op; replay current result                |
| Any selected track   | A smaller set    | `track_removal_requires_service_management` |
| Legacy compatibility | Explicit set     | Preflight, show component impact, confirm   |

The public command requires:

- authenticated owner-level `hotel_catalog.products.manage`;
- an `expectedRevision` compare-and-set guard;
- a caller-stable command/idempotency key;
- an allowed transition under the current track policy version;
- one append-only `platform.product_audit_events` record containing actor,
  previous selection, requested selection, result, and correlation identifiers.

Migration writes use actor type `migration` and the same validation/audit path.
Actor and source history live in the append-only audit, not duplicate row fields.

Idempotency is scoped by operation and organization. The first request reserves
the key with a hash of the canonical payload. A matching completed retry returns
the original status and body without changing revision or duplicating the
outcome audit. A matching in-progress retry returns `409 command_in_progress`;
a matching failed request replays its stored failure, and an expired key returns
`409 idempotency_key_expired` so the caller must refetch and use a new key.
Reusing a live key with another fingerprint returns
`409 idempotency_key_conflict`, leaves the original result intact, and records a
separate rejected-attempt audit. The outcome audit key derives from the reserved
idempotency row; rejected attempts use their own correlation ID. A stale CAS
returns the current revision and selection, commits no intent or grants, and
records the rejected attempt.

## Legacy Classification

Backfill never mutates entitlements. It evaluates explicit intent first, then
Finance billing provenance, then effective canonical/alias component state:

| Evidence                                                   | Intent / compatibility result               |
| ---------------------------------------------------------- | ------------------------------------------- |
| Existing V2 row                                            | Preserve it; recompute component state      |
| Effective active Booking + PMS source `shared_hotel_setup` | Infer `hotel_operations`, revision `1`      |
| Effective active Marketplace source `shared_hotel_setup`   | Infer `creator_marketplace`, revision `1`   |
| Exactly one Operations component selected/active           | No Operations intent; `legacy_partial`      |
| Active legacy access without setup-selection provenance    | No inferred intent; `legacy_access`         |
| Finance-managed or mixed provenance                        | No inferred intent; `externally_managed`    |
| Suspended component without an explicit V2 row             | No inferred intent; `blocked` compatibility |
| Expired or not-yet-effective setup-sourced row             | No inferred current intent                  |
| No access or evidence                                      | No row; effective revision `0`              |

The two tracks classify independently and compose. Compatibility is a derived
projection—`none`, `legacy_partial`, `legacy_access`, `externally_managed`, or
`blocked`—not owner intent. The classifier joins Finance billing records because
Identity entitlement metadata alone cannot establish billing provenance.
Ambiguous states require owner confirmation and never grant a missing product.

## Atomic Hotel Operations Provisioning

Hotel Catalog owns the bundle application command. Both the V2 track route and
any eventual V1 compatibility policy call it so older callers cannot bypass the
invariant.

For `hotel_operations`, the service:

1. resolves the authenticated hotel-group organization;
2. reserves idempotency and compare-and-sets track intent;
3. asks Finance to lock/read normalized provenance and suspension state;
4. asks Booking and PMS domain commands to approve onboarding activation;
5. asks Identity to apply both setup-sourced projections and existing-property
   links, or neither;
6. records selected intent even when the result is blocked;
7. records the audit result and completes idempotency.

One checked-out PostgreSQL client passes through domain-owned command
repositories, so all effects commit together without cross-domain raw SQL in the
orchestrator. Finance is read-only; no commit may expose only one Operations
component.

A blocked selection may preserve owner intent without granting the unblocked
half of Hotel Operations. Suspended and billing-managed entitlements are never
reactivated or expired by onboarding.

`creator_marketplace` uses the same command, provenance, link, and audit path for
its single Marketplace component.

Property creation always makes the Catalog link. It makes both Operations links
atomically only when Booking and PMS are effectively provisioned; blocked intent
makes neither. Entitlement or Finance changes run the same idempotent all-or-none
reconciler after unblock. Suspended links are preserved and effective
entitlements continue to gate entry.

## Adaptive Field Requirements

Outcome selection happens before detailed property setup. The first step
collects only account identity needed to authenticate and authorize the user.
The chosen tracks then generate the property form.

### Minimum shared property identity

All tracks require:

- hotel display name;
- property type;
- structured address, country, city, postal code, and editable IANA timezone;
- hotel/reception email and phone, optional website, and explicit contact roles;
- field-level address and contact visibility;
- a canonical property link inside the selected hotel group.

These are creation requirements for new properties. Existing properties keep
their data and access; missing facts become setup tasks and block only a surface
whose owning-domain policy requires them.

### Hotel Operations

Hotel Operations additionally requires:

- room types, physical rooms, and rate plans;
- operational setup facts owned by PMS;
- guest-facing booking profile, policies, payment capability, and publication
  readiness owned by their respective domains.

### Creator Marketplace

Creator Marketplace additionally requires:

- public hotel description and approved media;
- optional public website and explicitly public contact channels;
- creator-facing pitch;
- collaboration deliverables, compensation, and creator requirements;
- Marketplace review/publication state.

Shared public-profile fields are collected once through Hotel Catalog and reused
by Booking and Marketplace projections. Product-owned overlays remain separate.

| Form section                           | Marketplace | Operations | Both |
| -------------------------------------- | ----------- | ---------- | ---- |
| Identity, location, contact visibility | Required    | Required   | Once |
| Creator pitch, offer, media, terms     | Required    | Hidden     | Yes  |
| Inventory, rooms, rates, coverage      | Hidden      | Required   | Yes  |
| Guest settings, localization, policies | Hidden      | Required   | Yes  |
| Payment capability and publication     | Hidden      | Required   | Yes  |
| Add-ons, benefits, promotions          | Hidden      | Optional   | Yes  |
| Channel connectivity                   | Hidden      | Optional   | Yes  |

Account email/phone, private operational contact, public guest contact, public
creator contact, and billing contact are distinct concepts. Account contact
values may be offered as editable suggestions but must never become public
without an explicit field-level visibility choice. Exact address and coordinates
default to private. Readiness exposes only public-safe reason codes, never bank,
provider, payout, or risk values.

Before adaptive form writes ship, Hotel Catalog adds a versioned profile command
and extends `property_contact_channels` with a required purpose:
`general`, `operations`, `guest`, or `creator`. Its uniqueness includes purpose,
so one value may be intentionally reused with different visibility. Existing
rows backfill to `general` and preserve their current `is_public` value; all new
contacts default private. Account values remain unsaved suggestions until
confirmed. Account contacts stay in Identity and billing contacts stay in
Finance. The migration also adds `profile_revision` to
`hotel_catalog.properties` as `NOT NULL DEFAULT 1`, backfilling every existing
property to revision `1`; the command compare-and-sets and increments it once.
Only explicitly public values project to Booking, Marketplace, or Distribution.
The command also writes existing `address_public`, `geo_public`, and
`map_display_mode` controls with private/hidden defaults. V2 never calls the V1
flat-contact writer.

## Domain-Owned Readiness Contributions

V2 does not promote free-form `missingSteps`. Domains publish versioned dynamic
facts; the orchestrator adds caller capability and returns:

```ts
type SetupTask = {
  contractVersion: string;
  organizationId: string;
  propertyId: string;
  taskId: string;
  callerCapability: "allowed" | "ask_owner" | "forbidden" | "waiting";
  ownerProgress: "not_started" | "in_progress" | "owner_complete";
  readiness: "actionable" | "blocked" | "pending_sync" | "pending_review" | "rejected" | "complete";
  actionableBy: "owner" | "operator" | "support" | "system" | null;
  reasonCodes: string[];
  sourceRevision: string;
  freshness: "fresh" | "not_fresh";
  evaluatedAt: string;
};
```

Static title, owner, route, permission, requirement, blockers, and dependencies
come from the versioned registry, never from domain payloads. Its initial tasks:

| Task ID                               | Included for        | Owner        | Route key                         | Required permission          |
| ------------------------------------- | ------------------- | ------------ | --------------------------------- | ---------------------------- |
| `catalog.property_identity`           | All                 | Catalog      | `setup.property_identity`         | `hotel_catalog.setup.manage` |
| `catalog.public_profile`              | Marketplace         | Catalog      | `setup.public_profile`            | `hotel_catalog.setup.manage` |
| `marketplace.creator_pitch`           | Marketplace         | Marketplace  | `marketplace.creator_pitch`       | `marketplace.profile.manage` |
| `marketplace.collaboration_offer`     | Marketplace         | Marketplace  | `marketplace.collaboration_offer` | `marketplace.profile.manage` |
| `marketplace.verification`            | Marketplace         | Marketplace  | None                              | None                         |
| `pms.inventory_structure`             | Operations          | PMS          | `pms.inventory_structure`         | `pms.operations.manage`      |
| `pms.rates_and_coverage`              | Operations          | PMS          | `pms.rates_and_coverage`          | `pms.operations.manage`      |
| `pms.channel_connectivity`            | Operations optional | PMS          | `pms.channel_connectivity`        | `pms.operations.manage`      |
| `booking.guest_experience`            | Operations          | Booking      | `booking.guest_experience`        | `booking.settings.manage`    |
| `booking.policies`                    | Operations          | Booking      | `booking.policies`                | `booking.settings.manage`    |
| `finance.payment_capability`          | Operations          | Finance      | `booking.payment_capability`      | `booking.settings.manage`    |
| `distribution.direct_booking_publish` | Operations          | Distribution | None                              | None                         |
| `booking.growth`                      | Operations optional | Booking      | `booking.growth`                  | `booking.settings.manage`    |

The orchestrator validates and orders contributions. It may compute aggregate
counts and select a recommended task, but it must not duplicate the underlying
completion predicate.

Recommendation rules:

- recommend only a task the current caller can perform;
- never recommend `pending_sync`, `pending_review`, or suspended work;
- respect required task dependencies;
- offer the domain correction action for rejected work;
- allow the owner to open another independent actionable task;
- keep owner completion separate from launch/live state.

Returning from a task never marks it complete by itself. The hub reloads
authoritative readiness and can temporarily show `pending_sync`. During
migration, V1 `missingSteps` may be derived from V2 contributions, never the
other way around.

Non-fresh blockers neither count as ready nor drive recommendations; detail stays
in `reasonCodes`. Optional non-fresh facts retain owner progress, while public
publication fails closed.

## V2 API

V1 remains unchanged during rollout. V2 uses additive routes:

```http
GET /api/hotel-setup/v2/status?propertyId=<uuid>&entryProduct=<product>
PUT /api/hotel-setup/v2/tracks
POST /api/hotel-setup/v2/properties
GET /api/hotel-setup/v2/properties/:propertyId/profile
PUT /api/hotel-setup/v2/properties/:propertyId/profile
GET /api/hotel-setup/v2/properties/:propertyId/public-profile
PUT /api/hotel-setup/v2/properties/:propertyId/public-profile
POST /api/hotel-setup/v2/handoffs
POST /api/hotel-setup/v2/handoffs/exchange
```

`@vayada/domain-hotels` is the single authority for V2 wire constants, TypeScript
types, and runtime parsers. API and all three apps import it; they do not copy
unions or infer states from prose.

```ts
type PropertyContactInput = {
  channelType: "phone" | "email" | "website" | "whatsapp" | "instagram" | "facebook" | "x";
  value: string;
  purpose: "general" | "operations" | "guest" | "creator";
  isPublic: boolean;
};
type CreatePropertyProfileInput = {
  displayName: string;
  propertyType: string;
  location: {
    countryCode: string;
    region?: string | null;
    city: string;
    streetAddress: string;
    postalCode: string;
    timezone: string;
    latitude?: number | null;
    longitude?: number | null;
    addressPublic: boolean;
    geoPublic: boolean;
    mapDisplayMode: "hidden" | "approximate" | "exact";
  };
  contacts: PropertyContactInput[];
};
type PropertyProfileSnapshot = {
  displayName: string;
  propertyType: string | null;
  location: {
    countryCode: string | null;
    region: string | null;
    city: string | null;
    streetAddress: string | null;
    postalCode: string | null;
    rawMarketplaceLocation: string | null;
    timezone: string | null;
    latitude: number | null;
    longitude: number | null;
    addressPublic: boolean;
    geoPublic: boolean;
    mapDisplayMode: "hidden" | "approximate" | "exact";
  };
  contacts: PropertyContactInput[];
};
type PropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  profile: PropertyProfileSnapshot;
};
type CreatePropertyRequest = { profile: CreatePropertyProfileInput };
type UpdatePropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: {
    displayName?: string;
    propertyType?: string | null;
    location?: Partial<PropertyProfileSnapshot["location"]>;
    replaceContacts?: PropertyContactInput[];
  };
};
type PublicPropertyProfileSnapshot = {
  defaultLocale: string;
  supportedLocales: string[];
  descriptions: Array<{
    locale: string;
    shortDescription: string | null;
    longDescription: string | null;
    publicNotes: string | null;
  }>;
  media: Array<{
    propertyMediaId: string;
    mediaType: "hero_image" | "gallery_image" | "logo";
    url: string;
    altText: string | null;
    sortOrder: number;
  }>;
};
type PublicPropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  profile: PublicPropertyProfileSnapshot;
};
type UpdatePublicPropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: Partial<{
    defaultLocale: string;
    supportedLocales: string[];
    descriptions: PublicPropertyProfileSnapshot["descriptions"];
    media: Array<{
      propertyMediaId?: string;
      mediaObjectId?: string;
      mediaType: "hero_image" | "gallery_image" | "logo";
      altText: string | null;
      sortOrder: number;
    }>;
  }>;
};
type PropertyProfileError = {
  code:
    | "invalid_profile"
    | "profile_revision_conflict"
    | "missing_property_resource_link"
    | "setup_profile_v2_required";
  currentProfileRevision?: number;
};

type SetupTrack = "hotel_operations" | "creator_marketplace";
type ComponentAccess = {
  product: "booking" | "pms" | "marketplace";
  access: "absent" | "future" | "active" | "suspended" | "expired" | "unavailable";
  provenance: "onboarding" | "billing" | "legacy" | "mixed";
};
type SetupTrackStatus = {
  track: SetupTrack;
  intent: "none" | "inferred" | "confirmed";
  provisioning: "not_provisioned" | "setup_required" | "pending" | "active" | "blocked";
  compatibility: "none" | "legacy_partial" | "legacy_access" | "externally_managed" | "blocked";
  components: ComponentAccess[];
  allowedActions: Array<"select" | "confirm" | "add" | "manage_service">;
};
type ProductEntryDecision = {
  requestedProduct: ComponentAccess["product"];
  propertyId: string | null;
  decision: "enter" | "setup_required" | "unavailable";
  destinationRouteKey: string | null;
  reasonCode: string | null;
};
type PropertySetupPlan = {
  propertyId: string;
  planRevision: string;
  tasks: SetupTask[];
  recommendedTaskId: string | null;
  ownerProgress: { complete: number; total: number };
  launchReadiness: Record<
    "operations_use" | "direct_booking_publish" | "marketplace_publish",
    "not_applicable" | "blocked" | "pending" | "ready"
  >;
};
```

Profile reads require `hotel_catalog.setup.read` plus a direct property link;
updates require `hotel_catalog.setup.manage` and CAS. Creation requires
`hotel_catalog.setup.manage` and `Idempotency-Key`, derives the active hotel
group from authentication, and creates the Catalog property, profile revision
`1`, location, contacts, and direct Catalog link together. It never creates an
organization, billing, user, or data boundary. Legacy reads preserve missing
fields as explicit nulls; they never fabricate creation-required values.

Shared-profile and public-profile updates are patches: omitted scalar fields and
collections are preserved, while a supplied collection intentionally replaces
that collection. Both compare-and-set the same profile revision and increment
it once. The public-profile command is the only write path for canonical
localized descriptions, locale settings, and ordered media used by
`catalog.public_profile`. Media entries reference either an ID returned by the
read or an owned, approved platform media object. Product-link materialization
follows the all-or-none track rule.

```ts
type PutTracksRequest = {
  selectedTracks: SetupTrack[];
  expectedRevision: number;
  policyVersion: number;
};
type PutTracksResponse = {
  trackRevision: number;
  selectedTracks: SetupTrack[];
  tracks: SetupTrackStatus[];
};
type SetupCommandError = {
  code:
    | "setup_track_revision_conflict"
    | "track_removal_requires_service_management"
    | "unsupported_track_policy_version"
    | "setup_tracks_v2_required"
    | "command_in_progress"
    | "idempotency_key_conflict"
    | "idempotency_key_expired";
  currentRevision?: number;
  currentTracks?: SetupTrack[];
};
```

The V2 status response contains:

```ts
type SharedHotelSetupStatusV2 = {
  contractVersion: "shared-hotel-setup-status.v2";
  hotelGroup: {
    organizationId: string;
    selectedTracks: SetupTrack[];
    trackRevision: number;
    writeContract: "v1" | "v2";
    canManageTracks: boolean;
    tracks: SetupTrackStatus[];
  };
  propertySelection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
    availableProperties: Array<{ propertyId: string; displayName: string | null }>;
  };
  entryDecision: ProductEntryDecision | null;
  setupPlan: PropertySetupPlan | null;
  updatedAt: string;
};
```

`setupPlan` is null until a requested property passes the canonical direct-link
authorization check. It always repeats its `propertyId` and plan revision.
Every track status separates selected intent, provisioning state, and component
entitlement states. `availableProperties` contains only active, direct-linked
Catalog properties and is the sole property-picker source.

| Requested-product state                               | `entryDecision`                          |
| ----------------------------------------------------- | ---------------------------------------- |
| Active access, including legacy, with authorized link | `enter`                                  |
| Active access but missing/stale property link         | `unavailable: missing_resource_link`     |
| Selected, allowed, but not yet provisioned            | `setup_required: provisioning_required`  |
| Suspended, expired, blocked, or unavailable           | `unavailable` with stable reason         |
| No selected property in a multi-property group        | `setup_required: select_property`        |
| No intent or access                                   | `setup_required: select_track`           |
| Payment, publication, or optional setup incomplete    | Still `enter` when access/link are valid |

Thus legacy data remains enterable. Launch readiness may block public
publication, never an otherwise authorized configuration workspace.

The track command takes its stable command ID from `Idempotency-Key`; the
organization comes only from authenticated context. Omitting a provisioned track
does not remove it and returns the service-management error.

V1 reads and writes stay unchanged while `writeContract` is `v1`. The
organization-scoped, server-owned rollout cohort—not row presence or inferred
intent—changes it to `v2`. Thereafter stale V1 track writes fail closed with
`409 setup_tracks_v2_required`; V1 property create/update, flat-contact, and
public-profile writes fail with `409 setup_profile_v2_required`. Both request a
client refresh. V1 reads remain available during migration.

V2 clients feature-detect and fall back to V1 until migration is complete.

## Canonical Hub and Cross-App Handoff

`HOTEL_SETUP_BASE_URL` points to the canonical `marketplace-web /setup` hub.

The existing fragment-based handoff remains a V1 compatibility path. V2 task
launch creates a short-lived, single-use context holding organization, property,
task, plan revision, destination app/route key, hub return, and expiry.

```ts
type CreateHandoffRequest = {
  propertyId: string;
  taskId: string;
  planRevision: string;
};
type CreateHandoffResponse = {
  launchUrl: string;
  expiresAt: string;
};
type ExchangeHandoffRequest = { code: string };
type ExchangeHandoffResponse = {
  propertyId: string;
  taskId: string;
  issuedPlanRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
  planChanged: boolean;
};
type HandoffError = {
  code: "refresh_plan" | "invalid_handoff";
};
```

The launch URL carries only an opaque code: never a bearer token, serialized
user, arbitrary return URL, or raw context fields. The server binds the code to
the initiating user, organization, destination audience, and expiry, and maps a
route key to an allowlisted destination. Organization-selection and AuthKit
recovery preserve only that code. The receiving app exchanges it once, then
independently checks the current session, organization membership, entitlement,
permission, and property resource link. A handoff is routing context, never
authorization.

The task registry determines the destination; destination and return URLs are
server-owned mappings. Detailed expiry, reuse, audience, authorization, and
route failures are logged internally under the public error category.

Every supported destination provides:

- a task-specific route adapter;
- a consistent onboarding header;
- `Back to setup plan`;
- completion or cancellation return to the canonical hub.

No task becomes actionable in the hub until its destination adapter and return
path have a passing contract test. Every target command reauthorizes; operators
see a read-only plan and “Ask an owner” for account-level actions.

## Rollout and Compatibility

Deployment order is:

1. add revisioned persistence, legacy classification, and their database tests
   without changing entitlements;
2. ship additive V2 reads/profile/track commands with atomicity, authorization,
   idempotency, and compatibility integration tests;
3. ship the handoff protocol and each destination adapter with contract and real
   cross-origin recovery tests;
4. add rollout telemetry;
5. expose the unified hub in read-only/internal mode;
6. enable V2 track writes for a small feature-flagged cohort;
7. expand only when success and rollback thresholds pass;
8. retire V1 after every deployed consumer has migrated and V1 traffic is zero.

Rollout telemetry covers:

- track selection attempts, conflicts, blocks, and outcomes;
- task impression, launch, destination arrival, return, and redirect loops;
- permission failures and handoff recovery failures;
- pending-sync and pending-review duration;
- task completion, go-live readiness, abandonment, and support intervention.

Rollback stops new cohort enrollment and new track changes, but enrollment is
sticky. Enrolled organizations retain V2 status/read-only setup and completion
of already reserved commands; their V1 writer remains closed. Rollback never
reverses entitlement mutations or strands existing product entry.

## Required Validation

Contract and integration coverage must include:

- all three valid track combinations;
- Booking-only and PMS-only legacy states;
- canonical and alias entitlements with active, expired, future, bounded, and
  unbounded suspension windows;
- onboarding-managed, billing-managed, and mixed-provenance entitlements;
- atomic bundle success, blocked result, stale revision, replay, conflict, expiry;
- owner versus operator permissions and direct property-link authorization;
- single/multi/future properties and link reconciliation after unblock;
- private contact defaults, purpose migration, and explicit public projections;
- stale V1 track/profile writers failing closed for V2-cohort organizations;
- browser back/reload, draft resume, expired AuthKit session, organization
  selection, task return, stale projection, pending review, and rejection;
- one real three-origin AuthKit browser flow without mocking the setup API.
