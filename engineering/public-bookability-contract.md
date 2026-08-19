# Public bookability contract

_VAY-612 contract record. Builds on VAY-604 AI-agent bookability, VAY-605
database restructure, VAY-609 target schema ownership, and VAY-610 migration
parity harness._

## Purpose

Public bookability is the stable external distribution contract for agents,
partner consumers, search systems, and future MCP/tools. It is not a wrapper
around today's split booking/PMS endpoints. Any future hotel employee agent is
separately designed through VAY-1091.

The first implementation should answer two public questions:

1. What public-safe facts and capabilities describe this hotel?
2. Given dates, guests, currency, locale, promo, and referral context, can the
   guest start a direct booking checkout and with which public offer?

This document defines the contract only. It does not implement public API
routes, external agent clients, booking creation, or live booking/PMS behavior
changes.

## Boundary

Owner: `domain-distribution`.

Producer inputs:

- hotel/property catalog public profile read model;
- booking public profile, policy, add-on, promo, and checkout context;
- PMS public room/rate/availability/payment readiness snapshots;
- finance-owned public payment capabilities, not payout or provider-private
  details;
- booking-web canonical URL and deep-link rules.

Field-level ownership for hotel identity, location, media, amenities, public
contacts, locale, currency, timezone, and public policy projection is defined
in [`public-hotel-profile-ownership.md`](public-hotel-profile-ownership.md).
Distribution consumes those normalized catalog/profile fields; it does not
publish PMS, Marketplace, Booking, Finance, or Channex-shaped payloads directly.

Consumers:

- Vayada public pages and structured data;
- public AI/agent bookability API;
- future MCP/tools and partner feeds;
- migration/parity fixtures for quote and exposure checks.

Non-consumers:

- any future authenticated hotel employee agent. VAY-1091 must define its
  private evidence and `RequestContext` boundaries separately.

## Versioning

Every response must include:

| Field              | Meaning                                                   |
| ------------------ | --------------------------------------------------------- |
| `contractVersion`  | Contract version, starting at `public-bookability.v1`.    |
| `generatedAt`      | ISO timestamp when this response was assembled.           |
| `freshness`        | Source freshness and stale/unavailable states.            |
| `publicVisibility` | Explicit reminder that this response is public-safe only. |
| `dataSources`      | Logical source owners, not legacy database/table names.   |

Breaking changes require a new contract version. Additive fields are allowed
when they are public-safe and documented here before route implementation.

## Public Profile Endpoint

Recommended route:

```text
GET /api/ai/hotels/{slug}
```

Implementation owner: TypeScript `apps/api` route backed by a
`domain-distribution` public profile read model. The route must not assemble
Booking, PMS, Marketplace, Finance, or Channex-shaped payloads directly. Legacy
product systems may feed the read model through compatibility adapters during
the rewrite, but the HTTP response is the distribution projection.
`apps/api` now always serves this contract from `TARGET_DATABASE_URL`, using
either the target public profile projection or the active immutable Booking
publication. The legacy `booking_hotels` database reader and profile source
were retired after the next deployment lane made them unreachable.

Intended consumers:

- AI agents and search/partner crawlers that need a stable public hotel profile;
- Vayada public pages and structured data generators that need the same
  canonical URL/profile answer;
- future MCP/tools and partner feeds.

Response posture:

- public, read-only; unauthenticated only when the API starts without auth
  config. If `AUTH_DATABASE_URL`, `WORKOS_JWKS_URL`, `WORKOS_ISSUER`, and
  `WORKOS_AUDIENCE` are configured, `apps/api` registers the backend auth plugin
  and this endpoint follows the authenticated API posture;
- `Cache-Control: public, max-age=60, stale-while-revalidate=300`;
- `X-Vayada-RateLimit-Policy: public-ai-profile-read`;
- no guest PII, payout/provider details, Channex mappings, housekeeping,
  maintenance, or admin-only fields.

Response shape:

```json
{
  "contractVersion": "public-bookability.v1",
  "generatedAt": "2026-06-04T09:00:00Z",
  "publicVisibility": "public_safe",
  "hotel": {
    "propertyId": "prop_alpenrose",
    "slug": "hotel-alpenrose",
    "name": "Hotel Alpenrose",
    "canonicalUrl": "https://hotel-alpenrose.booking.localhost/en",
    "bookingBaseUrl": "https://hotel-alpenrose.booking.localhost",
    "customDomainUrl": null,
    "timezone": "Europe/Vienna",
    "defaultLocale": "en",
    "supportedLocales": ["en", "de"],
    "defaultCurrency": "EUR",
    "supportedCurrencies": ["EUR", "USD"],
    "location": {
      "country": "AT",
      "city": "Innsbruck",
      "region": "Tyrol",
      "latitude": 47.2692,
      "longitude": 11.4041
    },
    "summary": "Independent alpine hotel near the old town.",
    "images": [
      {
        "url": "https://cdn.vayada.example/hotels/alpenrose/front.jpg",
        "alt": "Hotel Alpenrose exterior"
      }
    ],
    "amenities": ["wifi", "breakfast", "parking"],
    "policies": {
      "checkInFrom": "15:00",
      "checkOutUntil": "11:00",
      "cancellationSummary": "Free cancellation until 7 days before arrival.",
      "termsUrl": "https://hotel-alpenrose.booking.localhost/en/terms"
    },
    "capabilities": {
      "instantBook": true,
      "onlinePayment": true,
      "payAtProperty": true,
      "promoCodes": true,
      "referralCodes": true,
      "bookingDeepLinks": true
    },
    "supportedQuoteParameters": {
      "minRooms": 1,
      "maxRooms": 5,
      "minAdults": 1,
      "maxAdults": 8,
      "childrenSupported": true,
      "adultAgeThreshold": 18,
      "supportedCurrencies": ["EUR", "USD"],
      "supportedLocales": ["en", "de"]
    }
  },
  "freshness": {
    "status": "fresh",
    "generatedAt": "2026-06-04T09:00:00Z",
    "sources": [
      {
        "owner": "hotel_catalog",
        "lastUpdatedAt": "2026-06-04T08:45:00Z",
        "status": "fresh"
      },
      {
        "owner": "distribution",
        "lastUpdatedAt": "2026-06-04T08:55:00Z",
        "status": "fresh"
      }
    ]
  },
  "dataSources": ["hotel_catalog", "booking", "pms", "finance", "distribution"]
}
```

## Quote Endpoint

Recommended route:

```text
GET /api/ai/hotels/{slug}/quote?check_in&check_out&adults&children&rooms&currency&locale&promo_code&referral_code
```

Implementation owner: TypeScript `apps/api` route backed by a
`domain-distribution` public quote projection. Phase 1 is read-only quote plus
canonical checkout deep link only. It does not create reservations, hold
inventory, authorize payment, or let an external agent complete a booking.

`apps/api` composes `createTargetPublicHotelQuoteRepository`, which reads the
canonical Distribution quote projection through `TARGET_DATABASE_URL`. It
validates public request shape, hotel quote limits, locale/currency support,
and same-property-day requests using the hotel timezone. Missing or failed
target projection reads return contract-valid unavailable reasons without
exposing Booking, PMS, Finance, Channex, promo, or provider internals.

`PMS_PUBLIC_API_URL` is a rejected stale Python integration variable, not a
quote input or target Booking Web dependency. VAY-655 defines the Booking Web
public API split:
Booking Web should call Booking/checkout and Distribution/bookability contracts,
while any PMS route access remains hidden behind temporary adapters and is
removed after canonical offer and quote read models exist.

Response posture:

- public, unauthenticated, read-only;
- `Cache-Control: public, max-age=15, stale-while-revalidate=60`;
- `X-Vayada-RateLimit-Policy: public-ai-quote-read`;
- `X-Robots-Tag: noindex`;
- bounded request parameters for dates, rooms, guests, locale, currency, promo,
  and referral codes to limit price enumeration and abuse;
- no private promo-only discounts, payout/provider details, payment processor
  account data, Channex mappings, housekeeping, maintenance, admin-only fields,
  or guest PII.

Request shape:

| Field           | Required | Notes                                                        |
| --------------- | -------- | ------------------------------------------------------------ |
| `check_in`      | Yes      | ISO date.                                                    |
| `check_out`     | Yes      | ISO date after `check_in`.                                   |
| `adults`        | Yes      | Positive integer.                                            |
| `children`      | No       | Defaults to `0`.                                             |
| `rooms`         | No       | Defaults to `1`.                                             |
| `currency`      | No       | Defaults to hotel currency. Unsupported values fail clearly. |
| `locale`        | No       | Defaults to hotel default locale.                            |
| `promo_code`    | No       | Public promo input. Never exposes private promo internals.   |
| `referral_code` | No       | Public referral/affiliate attribution input.                 |

Response shape:

```json
{
  "contractVersion": "public-bookability.v1",
  "generatedAt": "2026-06-04T09:01:00Z",
  "publicVisibility": "public_safe",
  "request": {
    "hotelSlug": "hotel-alpenrose",
    "checkIn": "2026-09-12",
    "checkOut": "2026-09-15",
    "nights": 3,
    "adults": 2,
    "children": 0,
    "rooms": 1,
    "currency": "EUR",
    "locale": "en",
    "promoCode": null,
    "referralCode": "creator-anna"
  },
  "status": "bookable",
  "unavailableReasons": [],
  "quote": {
    "quoteId": "quote_01JZALPENROSE",
    "quoteHash": "sha256:public-demo",
    "expiresAt": "2026-06-04T09:16:00Z",
    "priceGuarantee": "expires_at",
    "offers": [
      {
        "offerId": "offer_deluxe_flexible",
        "roomTypeId": "room_deluxe",
        "ratePlanId": "rate_flexible_breakfast",
        "name": "Deluxe Double Room",
        "occupancy": {
          "maxAdults": 2,
          "maxChildren": 1
        },
        "availableRooms": 3,
        "refundable": true,
        "mealPlan": "breakfast",
        "paymentOptions": ["card", "pay_at_property"],
        "totals": {
          "currency": "EUR",
          "roomTotal": 540,
          "taxesAndFees": 54,
          "discounts": 0,
          "grandTotal": 594
        },
        "policies": {
          "cancellation": "Free cancellation until 7 days before arrival.",
          "deposit": "No deposit required."
        },
        "bookingUrl": "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&room_type=room_deluxe&rate_plan=rate_flexible_breakfast&referral_code=creator-anna&quote_id=quote_01JZALPENROSE"
      }
    ]
  },
  "deepLink": {
    "url": "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&referral_code=creator-anna&quote_id=quote_01JZALPENROSE",
    "expiresAt": "2026-06-04T09:16:00Z",
    "preserves": [
      "dates",
      "guests",
      "rooms",
      "currency",
      "locale",
      "promo_code",
      "referral_code",
      "quote_id"
    ]
  },
  "freshness": {
    "status": "fresh",
    "generatedAt": "2026-06-04T09:01:00Z",
    "sources": [
      {
        "owner": "pms",
        "lastUpdatedAt": "2026-06-04T09:00:20Z",
        "status": "fresh"
      },
      {
        "owner": "booking",
        "lastUpdatedAt": "2026-06-04T08:58:00Z",
        "status": "fresh"
      },
      {
        "owner": "finance",
        "lastUpdatedAt": "2026-06-04T08:50:00Z",
        "status": "fresh"
      }
    ]
  },
  "dataSources": ["booking", "pms", "finance", "distribution"]
}
```

## Status and Unavailable Reasons

`status` values:

| Status        | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| `bookable`    | At least one public-safe offer can start checkout.           |
| `unavailable` | No offer can be booked for the request.                      |
| `stale`       | Data is too old to produce a reliable public quote.          |
| `error`       | The request cannot be answered safely; retry may be allowed. |

Unavailable reason codes:

| Code                     | Meaning                                                       | Public-safe detail allowed |
| ------------------------ | ------------------------------------------------------------- | -------------------------- |
| `sold_out`               | No inventory remains for requested stay.                      | Date range and room count. |
| `payment_disabled`       | Hotel cannot accept a supported public checkout method.       | Supported method summary.  |
| `min_stay_not_met`       | Requested nights are below public rate restriction.           | Required minimum nights.   |
| `max_stay_exceeded`      | Requested nights exceed public rate restriction.              | Maximum nights.            |
| `same_day_cutoff_passed` | Same-day booking cutoff has passed in hotel timezone.         | Cutoff time and timezone.  |
| `unsupported_occupancy`  | Guest or room counts exceed public quote limits.              | Supported counts.          |
| `unpublished`            | Hotel or all relevant rooms/rates are not publicly sellable.  | Generic statement only.    |
| `policy_missing`         | Required public policy text is missing.                       | Missing public policy key. |
| `stale_data`             | Source freshness is outside allowed quote window.             | Source owner and age.      |
| `unavailable_data`       | Required source is unavailable or cannot be safely projected. | Source owner only.         |
| `invalid_request`        | Request parameters are unsupported or invalid.                | Invalid public field name. |
| `currency_not_supported` | Requested currency is not supported for public quote.         | Supported currencies.      |
| `locale_not_supported`   | Requested locale is not supported for public response.        | Supported locales.         |
| `promo_not_applicable`   | Promo code cannot apply to this quote.                        | Promo code status summary. |

When status is not `bookable`, the response must still include
`contractVersion`, `generatedAt`, `request`, `status`, `unavailableReasons`,
`freshness`, `publicVisibility`, `dataSources`, and `deepLink` when a safe hotel
search link can be produced.

## Public-Safe Field Rules

Allowed:

- hotel public identity, location, images, amenities, policies, public contact
  channels, canonical URLs, supported locale/currency, public setup
  completeness, and public payment capabilities;
- room/rate facts that are currently sellable or safely explain why they are
  unavailable;
- public price totals, taxes/fees, discounts, cancellation/deposit summaries,
  quote identity, expiry, and booking deep links;
- promo/referral effect summaries that do not expose private rule internals.

Forbidden:

- guest PII, booking guest names, emails, phone numbers, arrival messages, and
  special requests;
- payout data, bank details, processor account IDs, private finance metadata,
  and internal commission rules;
- owner/admin notes, PMS private notes, housekeeping/check-in/out records,
  room assignment details, maintenance blockers with private notes, and channel
  manager credentials;
- unpublished room/rate inventory, internal overbooking buffers, private setup
  diagnostics, and tenant-only internal evidence;
- raw source table names, legacy IDs that are not public resource IDs, SQL
  snippets, and internal error traces.

## Fixture Coverage

Representative fixtures live in:

```text
engineering/fixtures/public-bookability/cases.json
```

The fixture file covers:

- bookable quote;
- sold out;
- payment disabled;
- min stay not met;
- max stay exceeded;
- same-day cutoff passed;
- promo/referral applied;
- stale data;
- unavailable source data.

Fixture assertions should be reusable by later implementation tests:

- no fixture response may contain forbidden public fields;
- each non-bookable response must include at least one typed
  `unavailableReasons` item;
- each bookable response must include quote identity, expiry, totals, and a
  deep link that preserves request context;
- stale/unavailable data cases must state the unavailable source owner without
  leaking private source details.

## Implementation Handoff

Follow-up implementation tickets can build without reading current FastAPI
internals by using these artifacts:

- profile route shape: `GET /api/ai/hotels/{slug}`;
- quote route shape:
  `GET /api/ai/hotels/{slug}/quote?check_in&check_out&adults&children&rooms&currency&locale&promo_code&referral_code`;
- Booking Web target route split:
  `engineering/booking-web-public-api-routing.md`;
- fixture cases in `engineering/fixtures/public-bookability/cases.json`;
- target owners from `engineering/target-schema-ownership-map.md`;
- freshness and parity expectations from
  `engineering/migration-parity-harness.md`.

The first route implementation should remain read-only. Tool-based booking
creation must wait for explicit guest confirmation, payment/fraud controls,
idempotency, and audit.
