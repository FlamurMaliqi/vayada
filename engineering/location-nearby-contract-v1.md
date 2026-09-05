# Location and nearby places — v1 contract

Decision draft for [VAY-1475](https://linear.app/vayadacom/issue/VAY-1475).
Product scope accepted in VAY-1472; provider activation remains unverified.
Updated 2026-09-05. This document introduces no runtime behavior or migration.

## Product behavior

Confirm the property address and pin, then automatically suggest nearby places.
Hotel staff may hide a suggestion, add a missing place, or mark a favorite.
None of these actions is required to finish property setup.

Guests see a real map and categorized list. Automatic results are labeled
“Nearby”; favorites are labeled “Recommended by us”. Adding a place does not
automatically endorse it. V1 does not include travel times, routing calculations,
price-pin room browsing, indoor maps, or editing room-location overrides.

## Provider proposal and verified setup

Use the existing Google Maps JavaScript loader for the map. Use Places API
(New) for bounded discovery, retaining place IDs separately from hotel choices.
Render Google descriptions through Places UI Kit compact detail elements;
keep our hide/favorite/note controls outside the Google element. This is one
proposed rendering path for all accounts, avoiding a second EEA-specific UI.

The repository has a GitHub secret named `GOOGLE_MAPS_BROWSER_API_KEY`, wired
into next Marketplace, Booking Admin and PMS deploy workflows. Secret presence
does not prove enabled APIs, billing, restrictions, quota, or working access.
The checked local app env files provided no configured Maps/Places credentials.
No server Places key or usable billing-account metadata was verified.

Before approving the provider decision, verify billing country, enabled Maps
JavaScript/Places/UI Kit APIs, a separate restricted server credential, browser
referrer restrictions including Booking Web domains, configured quotas, and one
real search plus compact-card render. Do not publish with placeholder keys.
No cloud settings or billing changes are made by this decision draft.

EEA terms prohibit using Places API content with any map except latitude,
longitude and place ID; Places UI Kit has an explicit exception. Consequently,
server Places responses must not supply names/addresses to our map/list UI.
The UI Kit must obtain and render its own content. Non-EEA terms also constrain
map choice and storage. See [EEA service terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
and [non-EEA service terms](https://cloud.google.com/maps-platform/terms/maps-service-terms).

## Storage and refresh

| Data | Owner and retention |
| --- | --- |
| Canonical property address, pin, visibility | Existing hotel catalog contract; preserve existing data and provenance. This decision does not retroactively license provider-derived property coordinates. |
| Google place ID | Provider reference; may persist. Never use it as a property authorization key. |
| Google destination coordinates | Expiring lookup cache, maximum 24 hours from retrieval; delete expired values. No indefinite backup/publication snapshot copies. |
| Google name, address, photo, rating, hours, URLs, types | No durable storage or shared response cache. UI Kit renders its own display content; discovery classification is request-local. No response-body logs. |
| Discovery metadata | Property ID, source revision, policy version, category bucket, place IDs, timestamps and status; no copied provider description or exact private origin. |
| Hotel favorite/hidden/add choice and note | Hotel-owned structured data, independent of provider lookup lifetime. |
| Custom place name, address, coordinates, category | Independently supplied hotel content; never prefill by copying Google details into a custom record. |

These are conservative implementation limits, not a claim that all provider
content can be cached for 24 hours. Google's [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)
exempt IDs from storage restrictions; coordinate exceptions are in the service
terms. Keep UI Kit attribution intact and separate hotel notes from Google data.
Do not scrape Google elements or hide required attribution with CSS.

Discover during the address-confirmation/editor interaction and when a guest
opens surroundings with an expired discovery snapshot. Do not prefetch on a
timer or search on every page render. Reuse only IDs and permitted unexpired
coordinates; UI Kit display requests still occur when cards mount.
One successful discovery per property/source revision/policy version per 24h
is enough. A lookup failure never erases hotel choices or blocks their save.
Expired provider coordinates are not a fallback; omit those markers until
refreshed. A previously saved place ID may still be resolved by UI Kit.

## Discovery policy `nearby-v1`

Initial limits are product choices to validate in staging, not provider defaults.

| Category key / label | Included types | Radius |
| --- | --- | --- |
| `nature` / Beaches & nature | beach, park, national_park, hiking_area | 5 km |
| `food` / Food & drink | restaurant, cafe, bar, bakery | 2 km |
| `activities` / Things to do | tourist_attraction, museum, art_gallery | 5 km |
| `transport` / Transport | airport, train_station, bus_station, ferry_terminal | 20 km |

One [Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search)
per category, `rankPreference=DISTANCE`, `maxResultCount=10`; no radius expansion
or pagination. Request only `places.id,places.location,places.types` for
transient validation and classification. Use supported [place types](https://developers.google.com/maps/documentation/places/web-service/place-types).
Exclude lodging types in the request and reject any returned lodging result;
do not offer competing hotels even when they also match an attraction type.
Deduplicate IDs across categories in table order. Keep provider order within
each bucket; pin favorites first only at presentation time, with stable ID ties.
Never persist provider ranking scores. Host hiding may reduce the list to zero;
do not fill it by removing their exclusions.

Allow at most 40 automatic candidates plus 20 explicitly added places per
property. Limit each category to five initially mounted guest cards; expand on
request. Transport destinations do not change the default neighborhood viewport.
No distance labels in v1: no straight-line distance disguised as a walk time.

Four searches per refresh at the current first paid Nearby Search Pro tier
cost about $0.128 before free caps, tax, discounts and other SKUs. UI Kit Query
is listed at $1 per 1,000 after its free cap; maps load separately. These are
scenario inputs, not an account quote. [Google pricing](https://developers.google.com/maps/billing-and-pricing/pricing).
Record refresh counts and failures without provider response bodies. Use the
existing durable job/lease mechanism for deduplication, not a new queue package.
Bound provider calls to 5s each, no automatic request retry; after failures use
a 15-minute retry cooldown. An explicit host refresh is limited to once per
hour per property. Enforce project quotas and request rate limits before launch;
a billing budget notification alone is not a spending cap.

## Ownership, authorization and revisions

`hotel_catalog` owns nearby choices and discovery references. Shared DTOs belong
in `packages/domain-hotels`; provider adapters and persistence live in
`apps/api`. Booking reads a typed public projection, never raw catalog tables.
Use existing property-profile location writes; do not introduce a second address
or visibility writer. Preserve all legacy location/POI data for VAY-1480 review.

Protected routes call `enforceRoutePolicy`, then verify the active hotel-group
organization and active owner/operator property link, following shared setup.
Reads require `hotel_catalog.setup.read`; writes/refresh require
`hotel_catalog.setup.manage`. Public curation changes must additionally reuse
the shared profile's hotel-owner publication authorization guard.
No product subscription is added to shared catalog setup. Booking publication
requires the existing active Booking entitlement and published property gate.
Test entitlement denial at that gate; do not invent a paid nearby add-on.

Keep an independent `curationRevision` (nonnegative integer, starting at 0).
Every write includes both `expectedCurationRevision` and `expectedProfileRevision`.
Check both against current rows inside one transaction; mismatch returns 409
without partial writes. A successful atomic replacement increments curation
revision once, audits actor/property/change IDs, and returns the saved state.

Discovery captures profile revision and policy version. On completion, compare
with the current profile revision before committing; discard old results on
mismatch. Apply latest curation at read time, never the choices captured by a
job. Any profile revision change conservatively invalidates discovery. Preserve
choices but pause publishing additions/favorites tied to the old revision until
the host saves them against the new location. Hidden IDs remain suppressed.

## Privacy and public projection

| Existing visibility | Discovery origin and guest output |
| --- | --- |
| `hidden`, `geoPublic=false`, or no valid coordinate pair | No public map or nearby IDs/custom places. Existing permitted locality text only. Protected editor can show its own suggestions. |
| `approximate` with `geoPublic=true` | Search only around the same server-rounded public center used by bookability (2 decimals), including host preview. Show an area indicator, never the exact property pin/address. |
| `exact` with `geoPublic=true` | Search around confirmed canonical coordinates. Publish only the existing permitted address fields and exact pin. |

For approximate properties, ranking, selection, radius and any browser requests
must depend only on that public center. Do not discover from the private exact
pin and then merely round the marker. Never identify the property by its own
Google place ID in a guest request when location is private or approximate.
Custom destinations are explicitly published by the host; preview must explain
that their coordinates/address and notes are public.

Public GET resolves slug through the existing public property gate and checks
current visibility/profile revision before returning any snapshot. No caller-
supplied search origin, radius, provider URL or tenant ID is accepted. Return
`Cache-Control: no-store` initially so a previous exact payload cannot survive
a visibility change in our CDN. SSR, JSON, structured data, room details and
browser requests use the same projection. Never expose raw PMS room override
coordinates as a shortcut for this feature; VAY-1480 must audit those existing
public payloads before enabling the rebuild. Provider credentials stay server-side.
Directions links may target a displayed public destination without a prefilled
private hotel origin. Hidden mode has no directions action.

## Versioned HTTP/data boundary

Proposed routes under `/api/shared/properties/:propertyId/nearby`:

- `GET`: authenticated editor state; no arbitrary property fallback.
- `PUT`: atomic replacement of hotel-owned curation only.
- `POST /refresh`: `{ expectedProfileRevision }`; returns 202 or 429 cooldown.
- `POST /search`: authenticated Add search with `{ expectedProfileRevision,
  query, category }`. Require setup-manage and publication permission; trim
  query to 3..120 characters, reject unknown categories. Use one [Text Search
  (New)](https://developers.google.com/maps/documentation/places/web-service/text-search),
  `pageSize=10`, no pagination, `locationBias.circle` using the selected
  category's public-safe origin/radius, and only ID/location/types fields.
  Since bias is not a restriction, discard out-of-radius and nonmatching-category
  results using transient coordinates/types. Apply the lodging exclusion; render
  returned IDs through UI Kit. Limit to ten searches/minute/property, no retries,
  and 5s timeout. This is a paid Text Search Pro request, separate from refresh.

Search stores at most 100 returned ID references per property/profile revision
in a bounded selection registry, with coordinates subject to the same 24h
expiry. PUT accepts every newly introduced Google choice ID, regardless of
flags, only from this registry or current discovery; only previously validated
saved references are grandfathered. Test attempts to save a fabricated hidden ID
and then toggle it to added/favorite. This prevents fabricated place references
without provider calls during save. Search rejection/expiry asks the host to
search again. Keep explicit additions when automatic discovery no longer finds
them; resolve their coordinates on demand with Place Details (ID/location only)
when expired, bounded to the 20-addition limit and the same cooldown/timeout.

Public route: `GET /api/booking/public/hotels/:slug/nearby`.
Use existing API envelopes; each success contains `schemaVersion: 1`.
Exact route mounting must be checked against existing adapters before coding.

```typescript
type Category = "nature" | "food" | "activities" | "transport";
type Choice = {
  placeId: string; // Google identity only; validate bounded opaque string
  hidden: boolean;
  favorite: boolean;
  added: boolean;
  category: Category; // hotel choice, not copied provider types
  note: string | null; // independently written, max 500 characters
};
type CustomPlace = {
  id: string; // UUID, stable across retries
  category: Category;
  name: string; // trimmed, 1..120 characters
  address: string | null; // max 300 characters
  latitude: number;
  longitude: number;
  favorite: boolean;
  hidden: boolean;
  note: string | null;
};
type CurationWrite = {
  schemaVersion: 1;
  expectedProfileRevision: number;
  expectedCurationRevision: number;
  choices: Choice[];
  customPlaces: CustomPlace[];
};
```

Reject duplicate IDs, non-finite/out-of-range coordinates, unknown categories,
HTML content, oversized payloads, and `hidden && favorite` (the UI clears a
favorite on hide). Coordinates must occur as a pair, latitude -90..90 and
longitude -180..180; 0 is valid. Limit request body to 64 KiB and 100 stored
Google choices including hidden references; at most 20 combined explicit Google
and custom additions. Omitted choices in PUT mean reset to automatic behavior;
omitted custom IDs mean delete. Preserve drafts on conflict and never silently
retry them over someone else's edit.

Read state includes profile/curation revisions, `status` (`ready`, `empty`,
`refreshing`, `unavailable`, `location_required`, `hidden`), `retryAfter`, and
categories. Google rows contain only ID, permitted unexpired destination
coordinates, category and hotel-owned annotations. Custom rows contain hotel
content. Public responses exclude hidden choices, drafts, internal IDs, audit,
provider failures and raw private location. Details render using the
[UI Kit place-ID request](https://developers.google.com/maps/documentation/javascript/places-ui-kit/place-details).
An unavailable card is omitted publicly; editor shows a removable unresolved
reference. Never substitute stale stored Google names.

```typescript
type PublicPlace =
  | { source: "google"; placeId: string; category: Category;
      coordinates: { latitude: number; longitude: number } | null;
      favorite: boolean; note: string | null }
  | ({ source: "custom" } & Omit<CustomPlace, "hidden">);
type PublicNearby = {
  schemaVersion: 1;
  status: "ready" | "empty" | "refreshing" | "unavailable"
    | "location_required" | "hidden";
  location: { mode: "exact" | "approximate";
    latitude: number; longitude: number } | null;
  places: PublicPlace[];
};
type EditorNearby = {
  schemaVersion: 1;
  profileRevision: number;
  curationRevision: number;
  choices: Choice[];
  customPlaces: CustomPlace[];
  candidates: PublicPlace[]; // includes hidden candidates for editing
  status: PublicNearby["status"];
  retryAfter: string | null; // ISO timestamp, authenticated only
  preview: PublicNearby;
};
```

GET editor and successful PUT return `EditorNearby`. Search returns
`{ schemaVersion: 1, profileRevision, candidates: PublicPlace[] }`, Google-only
with favorite false and note null. Refresh 202 returns
`{ schemaVersion: 1, status: "refreshing" }`; 429 includes Retry-After seconds.
`PublicNearby.location=null` for hidden/missing/unauthorized geo; its places are
empty in those modes. Public custom IDs are opaque destination UUIDs, never
property/organization IDs. Dates and internal revisions remain editor-only.

Representative public states (all include `schemaVersion: 1`):

- Hidden: `{ status: "hidden", location: null, places: [] }`.
- Approximate: `{ status: "ready", location: { mode: "approximate",
  latitude: -8.65, longitude: 115.14 }, places: [...] }`; all candidate discovery
  uses that same public center, regardless of private coordinate precision.
- Provider failure for an exact property: `{ status: "unavailable",
  location: { mode: "exact", latitude: -8.65, longitude: 115.14 },
  places: [/* permitted current custom places only */] }`. A UI Kit failure is
  client-local and removes that Google card without changing saved curation.

Errors: 400 invalid request; 401 missing/invalid auth; 403 permission/link denial;
404 unpublished/unknown public property; 409 revision conflict; 429 throttled;
503 provider unavailable. Curation PUT never calls Google. Public provider
failure returns a usable 200 state with existing permitted hotel content.

## Desktop and mobile flows

Host: Property settings → Location → shared address search/manual entry →
correct pin → Save location. Show “Location saved” before nearby loading, so a
failed search cannot look like a failed address save. Category tabs and rows
show favorite/hide controls; Add offers Google search or independent manual
entry. Desktop preview sits beside controls; mobile preview opens a full-width
panel with an explicit Back action. The preview uses unsaved curation but the
same server-authorized public location projection.

Save nearby changes / Discard apply only to the nearby draft. Dirty navigation,
browser back and tab close use the existing unsaved-change protection. Conflict
offers reload saved state while keeping a copy of the draft for manual recovery.
Provider failure leaves manual additions and saves usable. Address-only setup
has no required POI step. Empty categories say no places were found, not an error.

Guest: Location section shows allowed locality text, a lazy map, category tabs,
and readable cards. Desktop map/list are adjacent; mobile map precedes list.
Selecting a card highlights its marker, with keyboard equivalents and visible
focus. Selecting a marker focuses its card without hijacking page scroll.
Favorites appear once in “Recommended by us”; other results remain “Nearby”.
Map failure keeps permitted text/custom places. Google card failure is shown
as unavailable without blocking room selection or booking. No map library loads
for hidden locations. Current category persists while expanding cards.

## Delivery and acceptance

Architecture references: [backend structure](typescript-backend-structure.md),
[database ownership](backend-database-restructure.md), [identity](workos-identity-architecture.md).
The retired Ask Intelligence runtime is unrelated and must not be recreated.

VAY-1473 removes the old frontend graph (PR #1565, CI green, still draft).
VAY-1474 owns the overall UX plan; VAY-1475 is its contract subtask, not a second
completed predecessor. VAY-1476 builds discovery; VAY-1477 builds curation;
VAY-1478/1479 consume both; VAY-1480 reconciles existing data and verifies release.
Keep each implementation PR focused and below the repository review budget.

Required fixtures: provider failure/quota/timeout/empty/duplicates/lodging;
concurrent refresh and profile change; curation conflict/no partial writes;
tenant link/permission denial; all visibility modes and immediate revocation;
expired coordinates; no private origin in SSR/JSON/network; save/discard/reload;
mobile/keyboard; attribution and UI Kit failure; booking unaffected.

This draft is not provider activation approval or a claim that VAY-1475 is done.
Billing country/account access, credential/API verification and real UI Kit
validation remain open. No provider-dependent runtime should be enabled before
these checks resolve. Existing data reconciliation requires coordination with
VAY-1287 and the active legacy migration work before any backfill.
