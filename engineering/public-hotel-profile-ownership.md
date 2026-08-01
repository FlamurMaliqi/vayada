# Public Hotel Profile and Location Ownership

_VAY-658 decision record. Builds on VAY-604, VAY-612, VAY-642,
VAY-655, and the target schema ownership map._

## Purpose

This document defines the canonical owner for public hotel identity, profile,
location, locale, currency, timezone, media, amenities, and public policy fields.
It exists so GEO, booking pages, marketplace pages, public AI/bookability APIs,
and Channex-facing PMS sync do not each invent their own hotel profile truth.

This is a contract document. It does not migrate production data or implement
new API routes.

## Decision

Canonical public hotel identity and location belong to the
**Hotel/property catalog** (`domain-hotels`).

The PMS is a producer of operational and setup facts, and Vayada PMS is one PMS
implementation among several. PMS and Channex data may seed or update catalog
fields through explicit mappings, but PMS and Channex-shaped payloads are not
the public profile contract.

Distribution (`domain-distribution`) consumes the hotel catalog read model plus
Booking, PMS, Finance, and booking-web inputs to create public bookability
profiles, structured data, public AI endpoints, and partner/tool feeds. It must
not expose product-native database fields or provider-shaped payloads.

## Canonical Field Table

| Field(s)                                                                           | Owner                        | Producer of record / migration input                                                                     | Visibility                                                            | Validation and fallback                                                                                               | Notes / follow-ups                                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `propertyId`                                                                       | Hotel/property catalog       | New canonical ID generated from linked Booking/PMS/Marketplace resources                                 | Public-safe opaque ID                                                 | Required; stable; never reuse after merge/split                                                                       | `property_source_links` maps legacy IDs privately.                                                                  |
| Booking hotel ID, PMS hotel ID, marketplace hotel profile/listing IDs              | Hotel/property catalog       | Legacy `booking_hotels`, PMS `hotels`, marketplace `hotel_profiles`/`hotel_listings`                     | Private/internal by default                                           | Required for migration and reconciliation; exposed only as opaque external references where a contract says so        | Do not let public APIs expose raw legacy table names.                                                               |
| Public display name                                                                | Hotel/property catalog       | Booking hotel name, PMS hotel/property name, marketplace hotel profile/listing name                      | Public-safe                                                           | Required before public profile is considered complete; trim and preserve brand casing                                 | Conflict resolution prefers verified owner/admin catalog value, then Booking, then PMS, then Marketplace.           |
| Legal entity name                                                                  | Finance                      | Payment provider/account setup, billing profile, owner-entered legal fields                              | Private or conditional public                                         | Optional; expose only when explicitly intended for legal imprint/terms                                                | Not a search/GEO display name; catalog may link to the public legal/imprint projection but does not own it.         |
| Property type, category, star rating                                               | Hotel/property catalog       | Owner setup, marketplace profile, PMS property details where present                                     | Public-safe when verified                                             | Optional; normalize to controlled values; omit unknowns                                                               | Ratings need a trustworthy source before public exposure.                                                           |
| Canonical slug and slug history                                                    | Hotel/property catalog       | Booking slug, marketplace listing slug, PMS identity, rename history                                     | Public-safe canonical slug; old slugs redirect                        | Required for Vayada-hosted public pages; slug history preserves redirects                                             | VAY-663 owns canonical URL/custom-domain behavior.                                                                  |
| Verified custom domain                                                             | Platform/domain verification | Booking custom-domain setup and verification status                                                      | Public-safe only when verified                                        | Use only verified domains as canonical; unverified domains stay internal/setup state                                  | Catalog links the verified domain to the property; public bookability exposes `customDomainUrl` only when verified. |
| Canonical URL                                                                      | Distribution                 | Catalog slug/domain, verified custom-domain state, booking-web route rules, VAY-663 policy               | Public-safe                                                           | Required for public bookability; fallback to Vayada-hosted URL when no verified custom domain                         | Computed field; do not persist as a second source of identity truth.                                                |
| Booking base URL                                                                   | Distribution                 | Catalog slug/domain, verified custom-domain state, booking-web route rules                               | Public-safe                                                           | Required for public bookability; must share host policy with canonical URL                                            | Used by public profile, quote deep links, structured data, and sitemap generation.                                  |
| Default locale                                                                     | Hotel/property catalog       | Owner setup, Booking translations, marketplace copy, product default                                     | Public-safe                                                           | Required; default to `en` only when no explicit owner locale exists                                                   | Hreflang must not list locales without real pages/content.                                                          |
| Supported locales                                                                  | Hotel/property catalog       | Existing translations and public page availability                                                       | Public-safe                                                           | Include only locales with renderable content or defined fallback behavior                                             | Distribution consumes this list and may return `locale_not_supported` for unsupported public API requests.          |
| Default pricing currency                                                           | PMS operations               | PMS property pricing settings; Booking/Finance currency fields are migration inputs only                 | Public-safe                                                           | Required for quotes; ISO-4217 uppercase; no silent fallback for quote totals                                          | Booking and Finance consume the PMS projection; neither owns a steady-state currency write.                         |
| Supported currencies                                                               | Finance                      | Payment capability, exchange-rate support, booking quote capability                                      | Public-safe                                                           | Optional list; unsupported public quote currency fails with `currency_not_supported`                                  | Distribution consumes this list; do not expose provider/private payment account details.                            |
| Timezone                                                                           | Hotel/property catalog       | PMS hotel timezone, Booking hotel timezone, owner setup                                                  | Public-safe                                                           | Required IANA timezone for quotes, same-day cutoff, analytics buckets; do not silently default to UTC for bookability | If unknown, profile may render but quote returns unavailable/stale reason until fixed.                              |
| Country                                                                            | Hotel/property catalog       | PMS country, Booking location/contact, Marketplace free-form location                                    | Public-safe                                                           | Normalize to ISO-3166 alpha-2 for machine contracts; human display may localize                                       | Required for structured address when public profile is complete.                                                    |
| Region/state/province                                                              | Hotel/property catalog       | PMS address fields, Booking contact/location, Marketplace free-form location                             | Public-safe                                                           | Optional; normalize only when source confidence is high                                                               | Preserve ambiguous source text as a migration note, not canonical region.                                           |
| City/locality                                                                      | Hotel/property catalog       | PMS city, Booking location/contact, Marketplace free-form location                                       | Public-safe                                                           | Required for complete public location; normalize display casing                                                       | Marketplace location strings can seed this only with high confidence.                                               |
| Street address, postal code                                                        | Hotel/property catalog       | PMS address, Booking contact address, owner setup                                                        | Public-safe when owner marks public                                   | Optional for public profile; required for full `PostalAddress` JSON-LD if exposed                                     | Some properties may hide exact street address before booking; support field-level public flag.                      |
| Latitude and longitude                                                             | Hotel/property catalog       | PMS latitude/longitude, Booking map fields, geocoding from verified address                              | Public-safe when owner marks public                                   | Both required to emit `GeoCoordinates`; valid ranges only; omit if incomplete                                         | Do not infer from free-form Marketplace text without confirmation.                                                  |
| Map display config                                                                 | Hotel/property catalog       | Owner setup, Booking map fields                                                                          | Public-safe when enabled                                              | Optional; controls exact pin vs approximate area                                                                      | Distinct from canonical lat/long storage.                                                                           |
| Short summary                                                                      | Hotel/property catalog       | Canonical short description; legacy long description is migration fallback only                          | Public-safe                                                           | Required for onboarding publication; locale-aware; no private operations notes                                        | Marketplace-specific listing pitch remains a Marketplace-owned overlay.                                             |
| Public hero image, gallery images, logo                                            | Hotel/property catalog       | Booking branding/images, marketplace images, PMS property/room media                                     | Public-safe when approved                                             | URLs must be stable and crawlable; include alt text where available; preserve source attribution/rights               | Room-specific media belongs to PMS room/rate facts until projected publicly.                                        |
| Property-level amenities/benefits                                                  | Hotel/property catalog       | Booking benefits, PMS hotel benefits, marketplace amenities/profile fields                               | Public-safe                                                           | Normalize to controlled keys plus display labels; custom labels allowed with review                                   | Room-specific amenities remain PMS-owned and feed room offer snapshots.                                             |
| Accessibility facts                                                                | Hotel/property catalog       | Owner setup, PMS/Marketplace fields where present                                                        | Public-safe when verified                                             | Optional; do not infer from generic amenities                                                                         | Important for search/AI comparison but must be accurate.                                                            |
| Public phone, email, WhatsApp, website, socials                                    | Hotel/property catalog       | Booking contact fields, PMS hotel contact, marketplace profile contact data                              | Public-safe only with field-level public flag                         | Optional; validate formats; private owner/admin contact stays private                                                 | Public support contacts may differ from operational or billing contacts.                                            |
| Check-in/check-out times                                                           | Booking/checkout             | Booking public profile, PMS setup, owner policy settings                                                 | Public-safe                                                           | Required for complete bookability; HH:mm local time; interpreted in hotel timezone                                    | Catalog may show the projected public summary; Booking owns the policy semantics.                                   |
| Cancellation summary and terms URL                                                 | Booking/checkout             | Booking policy config, PMS cancellation policy during migration                                          | Public-safe summary only                                              | Required for public quote; full legal text URL when available                                                         | PMS may store legacy policy data but target ownership is Booking.                                                   |
| Deposit and public payment policy summary                                          | Finance                      | Finance payment capabilities, booking checkout requirements, PMS payment settings during migration       | Public-safe summary only                                              | Required for public quote when payment is needed; no private payment provider details                                 | Distribution projects this into public bookability responses.                                                       |
| Instant-book and request-to-book capability flags                                  | Booking/checkout             | Booking settings, product entitlement, payment readiness                                                 | Public-safe                                                           | Required for public bookability; false or unavailable reason when incomplete                                          | Not hotel catalog facts; they describe public booking capability.                                                   |
| Promo/referral capability flags                                                    | Booking/checkout             | Booking promo/referral settings and public attribution rules                                             | Public-safe                                                           | Optional; false when not supported; do not expose private promo rule internals                                        | Public quote may accept promo/referral inputs only through Booking-owned rules.                                     |
| Booking deep-link capability flag                                                  | Distribution                 | Booking-web route support, VAY-663 URL policy, checkout context capability                               | Public-safe                                                           | Required before public quote can return checkout/search deep links                                                    | Distribution owns whether the public contract can round-trip into booking-web.                                      |
| Online payment, pay-at-property, bank transfer, PayPal/card capability             | Finance                      | Payment settings and provider capability                                                                 | Public-safe capability only                                           | Optional per method; do not expose processor account IDs, payout state, bank details, or private risk settings        | Booking and Distribution consume this; public quote should return `payment_disabled` when needed.                   |
| Profile completeness                                                               | Hotel/property catalog       | Catalog validation over identity, location, media, amenities, contact, locale, and public profile fields | Public-safe status/reason codes                                       | Required for public AI profile; reason codes must be stable and non-sensitive                                         | Distribution consumes the catalog status, not raw validation internals.                                             |
| Domain verified status                                                             | Platform/domain verification | Custom-domain verification checks                                                                        | Public-safe status/reason codes                                       | Required before a custom domain may become canonical                                                                  | Distribution consumes this for canonical URL policy.                                                                |
| Bookability status                                                                 | Distribution                 | Catalog profile status, Booking policy/capability, PMS availability readiness, Finance payment readiness | Public-safe status/reason codes                                       | Required for public AI profile; reason codes must be stable and non-sensitive                                         | VAY-665 builds the projection/read model.                                                                           |
| Channex property ID, room/rate/channel mappings, sync status, credentials, markups | PMS operations               | PMS Channex integration state                                                                            | Internal/private except coarse setup health when explicitly projected | Never part of canonical public profile; Distribution consumes normalized public fields only                           | Channex-shaped payloads must stay behind PMS/channel adapters.                                                      |

## Catalog Public Profile Read Model

`property_public_profile_read_model.v1` is a Catalog-owned projection with this
JSON shape:

```ts
type PropertyPublicProfileReadModelV1 = {
  propertyId: string;
  propertyType:
    | "hotel"
    | "resort"
    | "hostel"
    | "apartment"
    | "aparthotel"
    | "guesthouse"
    | "bed_and_breakfast"
    | "villa"
    | "vacation_rental"
    | "motel"
    | "other"
    | null;
  locale: string;
  shortSummary: string | null;
  location: {
    countryCode: string | null;
    city: string | null;
    timezone: string | null;
    postalCode: string | null;
    streetAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    mapDisplayMode: "hidden" | "approximate" | "exact";
  };
  contacts: Array<{
    channelType: "email" | "phone" | "website" | "whatsapp" | "instagram" | "facebook" | "x";
    value: string;
    purpose: "general" | "operations" | "guest" | "creator";
  }>;
  media: Array<{
    mediaObjectId: string;
    mediaType: "hero_image" | "gallery_image" | "logo";
    url: string;
    altText: string | null;
    sortOrder: number;
  }>;
};
```

The projector reads `propertyType`, the public-safe location fields, and only
contact channels whose Catalog metadata explicitly marks them public. Unknown
property types and timezones project as `null`; a missing timezone blocks
date-sensitive quotes but does not block profile rendering. City and country
are null unless `localityPublic` is true; street/postal data stays null until a
separate public-address decision exists; coordinates are included only when
`geoPublic` and the map-display policy allow them. It reads locale and media
from the canonical Catalog profile/assignments, but includes a media item only
when Catalog has approved it, its canonical URL is stable, and its usage rights
are currently valid. It maps the single summary as
`shortSummary = shortDescription ?? longDescription` during migration; after
backfill, `longDescription` is not a second public source.

The existing validated `PublicPropertyProfileResponse` remains a compatibility
contract until a versioned parser/client cutover lands. Its accepted nested keys
remain exactly `locale`, `shortDescription`, `longDescription`, and `media`;
adapters must not add `propertyType`, `location`, `contacts`, or `shortSummary`
to that payload. Instead, the new read-model endpoint uses its own validator,
and compatibility adapters combine the canonical `PropertyProfileResponse`
with `PublicPropertyProfileResponse` and apply the mapping above. After every
consumer moves to `property_public_profile_read_model.v1`, the compatibility
response can be retired explicitly.

## Source Mapping Rules

| Current source                                  | What it may feed                                                                                                                                          | What it must not become                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Booking `booking_hotels` and translations       | Public display name, slug history, custom domain, descriptions, currency migration input, booking policy/config, benefits, public contact, locale content | Permanent owner of all hotel identity; raw public API schema                                                                              |
| PMS `hotels`                                    | Timezone, address, country, city, latitude/longitude, PMS setup facts, Channex-required setup input                                                       | Public profile owner; Booking Engine backend; public Channex-shaped contract                                                              |
| PMS room/rate tables                            | Room offer snapshots, public quote availability/rate inputs, room-specific amenities/media                                                                | Hotel-level identity/profile owner; raw public table exposure                                                                             |
| Marketplace `hotel_profiles` / `hotel_listings` | Marketplace-specific listing overlays plus seed data for profile copy, images, and free-form location                                                     | Canonical structured address without confidence/owner confirmation                                                                        |
| Finance/payment settings                        | Supported payment currencies and public payment capability summaries; legacy default currency is migration-only input                                     | A steady-state default-pricing-currency write; public exposure of provider account IDs, payout state, bank details, or private risk state |
| Channex integration data                        | PMS/channel setup health, provider mappings behind PMS adapters                                                                                           | Canonical public hotel profile, Booking dependency, public AI/profile payload shape                                                       |

### Marketplace Free-Form Location Deprecation

Marketplace `location` strings are migration evidence and marketplace display
overlays, not the canonical structured location after catalog rollout.

Deprecation lifecycle:

1. Preserve the raw free-form value on marketplace-owned records for audit,
   existing UI compatibility, and manual reconciliation.
2. Parse into catalog `country`, `region`, `city`, address, or geo fields only
   when confidence is high or an owner/admin confirms the mapped value.
3. When parsing is ambiguous, leave canonical structured fields null and expose
   a profile-completeness reason instead of publishing guessed structured
   location.
4. After catalog-backed consumers are live, marketplace search/display should
   read catalog structured location plus marketplace overlay text instead of
   treating `location` as canonical.

## Locale, Currency, and Timezone Rules

- **Timezone**: catalog-owned, IANA-only, required for quote semantics. Unknown
  timezone blocks public quote responses that depend on dates, same-day cutoff,
  or freshness windows. Do not default to UTC for public bookability.
- **Locale**: catalog owns default/supported content locales; Distribution may
  serve fallback text but must report the locale actually used. Hreflang should
  include only public pages that exist.
- **Currency**: PMS owns one property pricing currency and projects it to
  Booking and Finance. Finance owns method/currency capability, not the property
  pricing-currency write. The former `UpdatePropertyCurrencyCommand` and
  `finance.currency.update` contracts have been removed; new setup/runtime
  callers use the target `pms.setPropertyPricingCurrency` contract. Public quote
  requests with unsupported currency fail clearly instead of silently
  converting through an unapproved path.

## Channex Boundary

Channex is PMS/channel connectivity. It requires property, room, rate, address,
currency, timezone, and mapping data, but those requirements do not make Channex
the owner of public hotel profile facts.

### Channex Adapter Input Map

| Channex-facing input                                      | Canonical owner        | Mapping rule                                                                                                                    |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Property title/name                                       | Hotel/property catalog | Map from public display name; PMS adapter may transform to provider limits.                                                     |
| Property type/category                                    | Hotel/property catalog | Map normalized catalog category where available; omit or use adapter default only when Channex requires it.                     |
| Country, region, city, postal code, street address        | Hotel/property catalog | Use structured catalog location fields; do not parse marketplace free-form location inside the Channex adapter.                 |
| Latitude/longitude                                        | Hotel/property catalog | Use verified catalog geo fields only; omit if incomplete or not public/approved for provider use.                               |
| Timezone                                                  | Hotel/property catalog | Use catalog IANA timezone; block provider setup if missing.                                                                     |
| Currency                                                  | PMS operations         | Use the PMS-owned property pricing currency; Finance capability and Booking quote projections consume it read-only.             |
| Public contact                                            | Hotel/property catalog | Public contact comes from catalog field-level public contact.                                                                   |
| Channel operations contact                                | PMS operations         | Operational channel contact remains PMS-private.                                                                                |
| Room type identity, occupancy, room-level amenities/media | PMS operations         | PMS owns operational room/rate product; only public-safe room facts may feed Distribution snapshots.                            |
| Rate plan identity, restrictions, ARI values              | PMS operations         | PMS owns rate plans, rate rules, inventory, restrictions, and ARI sync.                                                         |
| Channex property/room/rate/channel mapping IDs            | PMS operations         | Private provider mapping state; never part of public profile or public bookability schema.                                      |
| Credentials, webhook payloads, sync errors, retries       | PMS operations         | Private operational state; jobs/events/audit may store receipts and attempts; Distribution may consume normalized reason codes. |

Allowed flow:

```text
Hotel/property catalog public facts
  -> PMS/channel adapter maps required setup fields
  -> Channex property/room/rate/channel payloads
```

Forbidden flow:

```text
Channex payload or PMS channel mapping
  -> public hotel profile / structured data / AI bookability schema
```

Distribution may expose public-safe readiness like `channel_setup_incomplete`
only when it is expressed as a normalized reason code. It must not expose
Channex credentials, channel IDs, mapping IDs, raw webhook payloads, or sync
error traces.

## Consumer Contract

- **Booking-web public pages** consume `property_public_profile_read_model` and
  Distribution URL/bookability outputs. They should not call PMS or Marketplace
  profile tables directly for public identity. VAY-655 defines the target
  Booking Web route split in `engineering/booking-web-public-api-routing.md`.
- **Marketplace and landing** consume catalog public profile facts and add their
  own marketplace/listing overlays where needed.
- **Public AI/bookability APIs** consume Distribution projections from VAY-665,
  not Booking/PMS/Marketplace response shapes.
- **PMS admin and channel sync** consume catalog identity/location facts for
  setup, but PMS remains owner only for operational inventory, room/rate,
  reservation, and channel connectivity state.

## Follow-Up Implementation Dependencies

- VAY-665 must build the Distribution public bookability projection from this
  catalog ownership contract.
- VAY-661 and VAY-662 must expose public AI profile/quote data from the
  Distribution projection, not raw producer shapes.
- VAY-663 must own canonical URL/custom-domain policy using catalog slug/domain
  facts.
- VAY-666 tracks target catalog DDL and legacy Booking/PMS/Marketplace
  profile/location backfill.
