# Adaptive Hotel Onboarding

_VAY-965 decision record._

## Decision

Hotel owners choose outcomes, not Vayada's internal product boundaries.

| Setup track           | Owner-facing outcome                        | Internal products      |
| --------------------- | ------------------------------------------- | ---------------------- |
| `hotel_operations`    | Manage the hotel and accept direct bookings | PMS and Booking Engine |
| `creator_marketplace` | Promote the hotel through travel creators   | Creator Marketplace    |

An owner may select either track or both. Booking Engine is never selectable
without PMS. Selecting Hotel Operations provisions PMS and Booking Engine as one
atomic bundle, but the domains remain separate:

- PMS owns inventory, operational reservations, room assignment, and channel
  connectivity.
- Booking owns the guest-facing booking profile, policies, quote, and checkout.
- Marketplace owns collaboration offers and the review state for hotel profiles
  shown to creators.
- Hotel Catalog owns canonical property identity and shared public-profile facts.
- Finance owns billing and payment capability.
- Distribution owns public bookability.

## Clean Cutover Boundary

This is a direct replacement, not a compatibility program:

- the API, shared package, all app consumers, mocks, and tests move together,
  and the old contract artifacts are deleted;
- there are no V1/V2 cohorts, compatibility states, legacy classifiers, or
  fallback reads;
- no old setup selections are backfilled or inferred;
- development and seed accounts may be reset or explicitly reseeded;

The apps deploy independently, so the cutover uses a coordinated maintenance
deployment pinned to one commit.

## Scope Model

- Track selection applies to the authenticated `hotel_group` organization.
  Owner-facing copy states that it applies to every property in that group.
- Adding a property creates a Hotel Catalog property inside the selected group.
  It never creates an organization, billing boundary, user boundary, or data
  boundary.
- Setup progress is property-scoped. Every actionable task carries an authorized
  `propertyId`; multi-property groups require explicit property selection.
- Product entry and setup recommendation are separate decisions. An active,
  authorized product opens even when another setup task is recommended.
- Removing a provisioned track is service management, not onboarding. Omitting a
  track from a setup request never cancels access.

## Track Intent and Provisioning

Hotel Catalog owns one organization-scoped setup intent:

```ts
type SetupTrack = "hotel_operations" | "creator_marketplace";

type OrganizationSetupTrackIntent = {
  organizationId: string;
  selectedTracks: SetupTrack[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

No row means no selection and effective revision `0`. The first confirmed
selection creates revision `1`. `selectedTracks` is non-empty, unique, and
stored in `SetupTrack` order.

| Current selection | Requested selection | Result                                                  |
| ----------------- | ------------------- | ------------------------------------------------------- |
| None              | Either or both      | Create selection and provision                          |
| One track         | Both                | Add and provision the missing track                     |
| Same set          | Same set            | Keep revision; a new key may retry missing provisioning |
| Any selection     | Smaller set         | Require service-management confirmation                 |

Track writes require:

- `hotel_catalog.products.manage`;
- an authenticated selected organization of kind `hotel_group`;
- `expectedRevision` compare-and-set;
- a caller-stable `Idempotency-Key`;
- one append-only audit event with actor, before/after selection, result, and
  correlation identifiers.

Matching idempotent retries return the stored result. A reused key with another
payload and a stale revision both return `409` without changing intent or
entitlements.

### Atomic Hotel Operations

The track command preflights both Operations components, then:

1. records the selected intent;
2. grants both PMS and Booking setup-managed entitlements, or grants neither;
3. creates both product resource links for already linked Catalog properties, or
   creates neither;
4. records audit and idempotency results in the same transaction.

A suspended or billing-managed component is never overwritten by onboarding.
When either component cannot be provisioned, the response reports the track as
blocked and creates no new half-bundle. A later authorized retry runs the same
all-or-none command.

Marketplace uses the same command path for its single entitlement and resource
link.

Property creation always creates the Catalog link. For selected Marketplace
intent, it also creates the Marketplace link when entitlement provisioning is
active. For selected Operations intent, it creates PMS and Booking links
together or neither. A later retry reconciles missing links under the same
all-or-none rule.

## Adaptive Property Setup

The flow asks the outcome question before detailed property fields:

1. authenticate and resolve the hotel-group organization;
2. choose Creator Marketplace, Hotel Operations, or both;
3. select an existing property or add one;
4. collect shared property identity once;
5. show only tasks required by the selected tracks;
6. continue through one property setup wizard, reloading authoritative status
   after each task.

The wizard renders one active task at a time with a compact ordered step list.
It does not render one card per task. When both tracks are selected, the order
is:

1. shared hotel basics;
2. one hotel description and public profile for guests and creators;
3. collaboration offer;
4. rooms, rates, and availability;
5. guest settings and policies;
6. payment;
7. direct-booking publication;
8. review and next steps.

Marketplace steps appear before Operations steps, but this is presentation
order rather than a cross-track dependency. A Marketplace review, sync, or
permission constraint does not prevent the wizard from recommending an
independent Operations task.

The Marketplace-only public-profile step is hidden for Operations-only hotels.
Their final direct-booking publication step still collects the minimum canonical
public facts needed for a guest-facing booking page: a description, approved
hero media, and explicit city/country visibility. When both tracks are selected,
the earlier public-profile work is reused rather than collected twice. A
successful projection command is not treated as completion unless Distribution
reports the booking profile as publicly ready and fresh.

The final review reports Creator Marketplace publication, PMS operations use,
and direct-booking publication separately. Owner-complete work may still be
under review or pending launch, so the UI never collapses these states into one
"launch everything" action.

### New Property Minimum

Every newly created property requires:

- hotel display name and property type;
- street and house number, postal code, city, country, and editable IANA
  timezone;
- hotel/reception email and phone;
- optional website;
- explicit contact purpose and visibility.

Account email and phone may be offered as editable suggestions. They are not
saved as property contacts until confirmed and never become public implicitly.
Address, coordinates, and all new contacts default private.

Descriptions and media are later profile tasks, not blockers for creating the
property.

| Form/task group                  | Marketplace | Operations | Both |
| -------------------------------- | ----------- | ---------- | ---- |
| Shared identity and contacts     | Required    | Required   | Once |
| Public description and media     | Required    | Required   | Once |
| Collaboration offer              | Required    | Hidden     | Yes  |
| Rooms, rates, and availability   | Hidden      | Required   | Yes  |
| Guest settings and policies      | Hidden      | Required   | Yes  |
| Payment and direct publication   | Hidden      | Required   | Yes  |
| Growth features and connectivity | Hidden      | Optional   | Yes  |

Hotel Catalog stores contact purpose as `general`, `operations`, `guest`, or
`creator`. Only explicitly public values project to public Booking, Marketplace,
or Distribution views.

## Domain-Owned Readiness

Domains return typed readiness facts; the setup wizard sequences them without
reimplementing their completion rules:

```ts
type SetupTask = {
  taskId: string;
  propertyId: string;
  callerCapability: "allowed" | "ask_owner" | "forbidden" | "waiting";
  ownerProgress: "not_started" | "in_progress" | "owner_complete";
  readiness: "actionable" | "blocked" | "pending_sync" | "pending_review" | "rejected" | "complete";
  actionableBy: "owner" | "operator" | "support" | "system" | null;
  reasonCodes: string[];
  sourceRevision: string;
  freshness: "fresh" | "stale";
  evaluatedAt: string;
};
```

The shared task registry owns stable labels, owner domains, route keys,
permissions, and dependencies. Initial task groups are:

| Task group                    | Track       | Owner                       |
| ----------------------------- | ----------- | --------------------------- |
| Shared property identity      | All         | Hotel Catalog               |
| Hotel description and profile | Marketplace | Hotel Catalog + Marketplace |
| Collaboration offer           | Marketplace | Marketplace                 |
| Inventory, rooms, rates       | Operations  | PMS                         |
| Guest settings and policies   | Operations  | Booking                     |
| Payment capability            | Operations  | Finance                     |
| Direct-booking publication    | Operations  | Distribution                |

The wizard recommends only a launchable task the current caller may perform.
That includes actionable work and rejected Marketplace work that an owner must
correct. Pending review, pending sync, suspended work, and owner-only work for an
operator are never recommended. An incomplete direct-booking projection remains
actionable after its dependencies are complete so the owner can fix and retry
publication. Returning from another app reloads authoritative readiness; it does
not mark the task complete.

Stale required facts are not complete and never permit Booking or Marketplace
publication. The wizard may preserve displayed owner progress while it refreshes
the owning domain.

## Replacement API

The existing setup routes change directly to the replacement contract:

```http
GET  /api/hotel-setup/status?propertyId=<uuid>&entryProduct=<product>
GET  /api/hotel-setup/property-types
PUT  /api/hotel-setup/tracks
POST /api/hotel-setup/properties
GET  /api/hotel-setup/properties/:propertyId/profile
PUT  /api/hotel-setup/properties/:propertyId/profile
GET  /api/hotel-setup/properties/:propertyId/public-profile
PUT  /api/hotel-setup/properties/:propertyId/public-profile
```

`GET /status` uses the membership-scoped, non-editable property-manifest
baseline defined by [`staff-access-authorization-contract.md`](staff-access-authorization-contract.md);
it does not authorize sibling profile, catalog, or setup commands.

`@vayada/domain-hotels` is the single wire authority. The API and all three apps
import its types and runtime parsers.

```ts
type TrackStatus = {
  track: SetupTrack;
  provisioning: "not_selected" | "active" | "blocked";
  components: Array<{
    product: "booking" | "pms" | "marketplace";
    access: "absent" | "active" | "suspended" | "unavailable";
  }>;
  allowedActions: Array<"add" | "manage_service">;
};

type ProductEntryDecision = {
  requestedProduct: "booking" | "pms" | "marketplace";
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
  launchReadiness: {
    operationsUse: "not_applicable" | "blocked" | "pending" | "ready";
    directBookingPublish: "not_applicable" | "blocked" | "pending" | "ready";
    marketplacePublish: "not_applicable" | "blocked" | "pending" | "ready";
  };
};

type AdaptiveHotelSetupStatus = {
  contractVersion: "adaptive-hotel-setup.v1";
  organization: {
    organizationId: string;
    selectedTracks: SetupTrack[];
    trackRevision: number;
    canManageTracks: boolean;
    tracks: TrackStatus[];
  };
  propertySelection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
    availableProperties: Array<{ propertyId: string; displayName: string }>;
  };
  entryDecision: ProductEntryDecision | null;
  setupPlan: PropertySetupPlan | null;
  updatedAt: string;
};
```

`setupPlan` is null until a directly linked property is selected. Active access
plus an authorized product resource link and any read-level page permission for
the requested product returns `enter`; unfinished payment, publication, or
optional work may affect launch readiness but does not block an otherwise
authorized configuration workspace. Direct product routes continue to require
their exact page permission.

The track request is:

```ts
type UpdateTracksRequest = {
  selectedTracks: SetupTrack[];
  expectedRevision: number;
};

type UpdateTracksResponse = {
  trackRevision: number;
  selectedTracks: SetupTrack[];
  tracks: TrackStatus[];
};

type SetupCommandError = {
  code:
    | "invalid_setup_request"
    | "track_revision_conflict"
    | "profile_revision_conflict"
    | "idempotency_key_conflict"
    | "command_in_progress"
    | "track_removal_requires_service_management"
    | "missing_property_resource_link";
  currentRevision?: number;
};
```

### Property Contracts

`GET /property-types` returns the server-owned
`adaptive-hotel-property-types.v1` catalog. Clients never keep a fallback list.

`POST /properties` accepts the required new-property fields defined above,
requires `hotel_catalog.setup.manage` and `Idempotency-Key`, derives the
organization from authentication, and returns:

```ts
type PropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  profile: {
    displayName: string;
    propertyType: string;
    location: {
      streetAddress: string;
      postalCode: string;
      city: string;
      countryCode: string;
      timezone: string;
      latitude: number | null;
      longitude: number | null;
      localityPublic: boolean;
      geoPublic: boolean;
      mapDisplayMode: "hidden" | "approximate" | "exact";
    };
    contacts: Array<{
      channelType: "email" | "phone" | "website" | "whatsapp" | "instagram" | "facebook" | "x";
      value: string;
      purpose: "general" | "operations" | "guest" | "creator";
      isPublic: boolean;
    }>;
  };
};
```

Shared and public-profile updates require `hotel_catalog.setup.manage`, a direct
Catalog property link, and `{ expectedProfileRevision, patch }`. Property-type
and profile reads require `hotel_catalog.setup.read`; profile reads also require
the same link. Patches preserve omitted values;
validation returns `422` with `{ code: "invalid_setup_request", fields }`, and a
stale revision returns the current revision with `409 profile_revision_conflict`.
Public-profile patches own localized descriptions and ordered, approved media:

```ts
type PublicPropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  publicProfile: {
    locale: string;
    shortDescription: string | null;
    longDescription: string | null;
    media: Array<{
      mediaObjectId: string;
      mediaType: "hero_image" | "gallery_image" | "logo";
      url: string;
      altText: string | null;
      sortOrder: number;
    }>;
  };
};

type UpdatePublicPropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: {
    shortDescription?: string | null;
    longDescription?: string | null;
    media?: Array<{
      mediaObjectId: string;
      altText: string | null;
      sortOrder: number;
    }>;
  };
};
```

The endpoint edits the property's default locale. Media commands may reference
only active, approved Platform Media objects linked to that property. Omitting
`media` preserves the current ordering; supplying it replaces the approved
public list. Upload approval and public-profile writes both advance the same
`profileRevision`, so a stale description or media edit cannot overwrite newer
public content. For Marketplace hotels, the shared profile task remains
actionable until the normalized Catalog description and Marketplace host
summary match, so a failed second write cannot advance the wizard with divergent
copy.

## Canonical Wizard

`marketplace-web /setup` is the canonical wizard. Canonical setup links keep the requested
`entryProduct` separate from the
allowlisted `returnProduct`. The latter identifies the app that sent the owner
into setup; `returnTo` remains a validated relative path. Booking, PMS, and
Marketplace set their own return product rather than trusting query input, and
the canonical wizard resolves that pair against the configured product origin.
This preserves exact product-local return paths without accepting an arbitrary
redirect origin.

Before launching a task, Marketplace stores the already validated entry and
return context in tab-scoped session storage for that property. The server-issued
task return remains the minimal canonical property URL; on the same-tab return,
Marketplace restores the validated context before rendering the wizard. The
context is cleared when the owner exits setup or enters a product, so completing
one task does not silently change the original return app.

Every actionable task renders through a tested inline adapter in the canonical
wizard. Each save independently rechecks the current session, organization
membership, entitlement, permission, property resource link, and current plan
revision. The legacy product authentication handoff remains separate and never
acts as setup-task authority. "Save and exit" leaves the wizard without
implicitly submitting incomplete data.

## Implementation and Cutover

Implementation remains reviewable as stacked PRs, but the stack deploys as one
clean release:

1. target schema plus shared runtime types/parsers;
2. atomic track/profile/readiness API;
3. shared adaptive wizard and all three app consumers;
4. inline task adapters, old-contract deletion, and end-to-end validation.

No stack slice introduces a long-lived compatibility layer. Until the complete
stack is ready, the current environment may continue using the current code.
Cutover replaces it at once. The coordinated release is smoke tested before
opening onboarding traffic. The prior pinned release may be restored only before
the first replacement-contract write; afterward rollback is a forward fix so
new intent/profile writes are never interpreted by old code.

## Required Validation

Coverage must include:

- Marketplace, Operations, and both track selections;
- rejection of empty, Booking-only, PMS-only, stale-revision, and conflicting
  idempotency requests;
- all-or-none PMS and Booking entitlement/resource-link creation;
- owner versus operator permissions and direct property-link authorization;
- single-property, multi-property, and add-property behavior;
- private contact defaults and explicit public projections;
- track-specific field visibility and draft resume;
- product entry remaining separate from setup recommendation;
- pending review/sync, rejected work, and launch-readiness behavior;
- cross-app launch, session recovery, return, reload, and browser Back;
- all API, package, app, mock, and test references to the old contract removed;
- root build/typecheck plus focused API and Playwright coverage for Marketplace,
  Booking Admin, and PMS.
