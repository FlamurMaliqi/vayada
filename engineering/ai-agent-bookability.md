# AI-agent hotel bookability

_VAY-604 recommendation. Public schema, search, and agent-tool documentation
checked on 2026-06-03._

## Recommendation

Make Vayada hotels bookable by AI agents in three layers:

1. **AI-readable direct-booking pages**: canonical public hotel URLs with
   complete, crawlable hotel content, stable booking deep links, sitemap/robots
   hygiene, and Schema.org JSON-LD for the hotel, rooms, offers, policies,
   location, images, amenities, and ratings where available.
2. **Agent-readable bookability API**: a public, read-only contract that returns
   hotel profile, room, rate, availability, payment, policy, and deep-link data
   in one stable schema. External agents should not have to stitch together
   Vayada's internal booking-api and PMS API shapes.
3. **Agent/tool integrations**: after the read-only API exists, expose the same
   contract through MCP/tool surfaces and partner feeds. Booking creation should
   start as quote/preview plus redirect to Vayada checkout; full tool-based
   booking should wait for explicit guest confirmation, payment/fraud controls,
   idempotency, and audit.

This does not guarantee that an AI assistant will recommend a Vayada hotel.
Vayada can, however, make hotels more likely to be understood, compared, cited,
and booked by giving agents fresh, complete, machine-readable direct-booking
data with clear policies and a reliable booking path.

The practical product distinction is:

- **Without a quote API**: an AI assistant can discover a Vayada hotel from the
  web, summarize why it may fit the request, and link to the hotel page. The
  guest still has to click through, enter dates, check rooms, compare prices,
  and complete the booking manually.
- **With a quote API and checkout deep links**: an AI assistant can discover the
  hotel, verify live availability/price/policy for the requested dates and
  guests, then route the guest into a Vayada checkout URL with the same dates,
  guests, room/rate, currency, promo, and referral context already filled in.

In other words, structured pages help Vayada win recommendations. Quote APIs and
deep links help Vayada turn those recommendations into direct booking traffic.
MCP/tool integrations should reuse the same quote and deep-link contract rather
than become the first place that bookability exists.

## Current Vayada surface

Useful public pieces already exist:

- `apps/booking-api/app/routers/hotels.py` exposes public hotel profile,
  add-ons, payment settings, promo validation, exchange rates, and custom-domain
  resolution under `/api/hotels/{slug}`.
- `apps/pms-api/app/routers/rooms.py` exposes public room and unavailable-date
  reads under `/api/hotels/{slug}/rooms` and
  `/api/hotels/{slug}/unavailable-dates`.
- `apps/pms-api/app/routers/bookings.py` exposes public booking creation,
  payment authorization confirmation, status lookup, cancellation previews, and
  change-request flows under `/api/hotels/{slug}/bookings`.
- Booking-web already has public hotel, rooms, add-ons, book, payment, and
  booking-status pages under `apps/booking-web/app/[locale]/`.

The gaps for AI-agent bookability are:

- No obvious Schema.org JSON-LD or hotel-specific structured markup exists in
  booking-web, landing, marketplace-web, booking-api, or PMS API.
- Hotel identity/profile data, availability/rates, policies, payment settings,
  and booking creation are split across services and response shapes.
- Existing public endpoints are optimized for the Vayada frontend, not for
  external machine clients that need contract stability, freshness metadata,
  explicit policy semantics, and quote reproducibility.
- Public pages do not expose a single canonical machine-readable answer to
  "Can this hotel be booked for these guests and dates, at what total price, and
  with what policy?"
- There is no MCP/tool interface, partner feed, or external-agent terms/rate
  limiting posture yet.

## Data agents need

### Hotel identity and trust

- Stable hotel ID, slug, canonical URL, custom-domain URL, supported locales,
  default language, currency, supported currencies, and timezone.
- Name, legal/brand identity where available, short and long descriptions,
  category/type, star rating, images, logo, address, country, city/region,
  latitude/longitude, phone/email/WhatsApp, and social links.
- Amenities, accessibility fields when available, points of interest, map
  configuration, hotel policies, check-in/check-out times, and whether instant
  booking is enabled.
- Verification/completeness state: whether required fields are present, whether
  images/policies/location are complete, and when the data was last updated.
- Reviews/ratings once Vayada has a trustworthy source and permission to expose
  them.

### Room, rate, and availability

- Room type ID, name, description, images, occupancy limits, bed/bathroom
  fields, amenities/filters, map/location fields where relevant, and active
  selling status.
- Requested dates, nights, guest counts, room count, available inventory,
  minimum/maximum stay, same-day booking cutoff, operating periods, blackout or
  unavailable dates, room blocks, and source freshness.
- Rate options with explicit semantics: flexible/non-refundable, meal plan,
  deposit requirements, cancellation terms, payment methods allowed per rate,
  nightly prices, total price, taxes/fees/add-ons, promo effects, currency, and
  whether the quote can still change.
- A stable quote ID or deterministic quote hash for the preview phase so the
  guest can verify the final checkout matches what the agent showed.

### Policy and payment

- Free cancellation window, cancellation text, terms text, deposit schedule,
  refundability, pay-at-property methods, online card eligibility, bank transfer
  or PayPal eligibility, payment window, host response deadline for request
  flows, and instant-book behavior.
- Required guest fields and supported checkout capabilities: special requests,
  arrival time, guest count, country/phone, add-ons, promo codes, and referral
  codes.
- Bookability status and failure reasons, for example `bookable`,
  `sold_out`, `min_stay_not_met`, `same_day_cutoff_passed`,
  `payment_disabled`, `unpublished`, or `policy_missing`.

## Integration surfaces

### 1. Structured web pages

Add JSON-LD to public booking pages using Schema.org's lodging model:

- `Hotel` or a more specific `LodgingBusiness` subtype for the property.
- `HotelRoom` plus `Product` for room types where offers are attached.
- `Offer` for bookable room/rate combinations, with `offeredBy`, `itemOffered`,
  price, currency, availability, URL, and eligible occupancy/date constraints
  where feasible.
- `PostalAddress`, `GeoCoordinates`, `Rating`, `LocationFeatureSpecification`,
  `openingHours`/check-in/check-out equivalents where appropriate, and stable
  image URLs.

Keep markup honest. If live rates or availability cannot be guaranteed from a
static page response, include profile and room facts in JSON-LD and link to the
quote endpoint or booking deep link for live availability. Do not mark
unavailable rooms as bookable offers.

Booking-web should also add canonical links, localized alternates, hotel
sitemap entries, and robots rules that allow indexing of public hotel/room pages
while keeping checkout/status/guest-specific pages out of crawlable surfaces.

### 2. Public bookability API

Create a new external contract rather than documenting existing internal
frontend endpoints as the agent API. Suggested shape:

```text
GET /api/ai/hotels/{slug}
  -> hotel identity, canonical URLs, completeness, policy summary,
     supported quote parameters, capabilities, freshness

GET /api/ai/hotels/{slug}/quote?check_in&check_out&adults&children&rooms&currency&locale
  -> normalized offers, totals, availability, policies, payment capabilities,
     quote ID/hash, booking URL, freshness, unavailable reasons
```

Rules for this API:

- Public read-only, no guest PII, no tenant-private operational fields, and no
  unpublished room/rate data.
- Strong response versioning, typed error codes, `generatedAt`,
  source-specific `freshness`, cache headers, and rate limiting.
- Only expose offers that can be booked or clearly explain why no offer is
  bookable.
- Use canonical URLs and deep links that can round-trip the same dates, guests,
  room/rate choice, promo/referral code, locale, and currency into booking-web.
- Prefer one server-side aggregator over asking clients to call booking-api for
  profile/policies and PMS API for rooms/availability.
- Treat this as the same backend contract future MCP tools and partner feeds
  will call.

### 3. MCP/tools and partner feeds

After the read-only API is stable, expose an MCP server or tool surface with a
small set of deterministic tools:

- `search_vayada_hotels`
- `get_hotel_bookability_profile`
- `get_hotel_quote`
- `create_booking_preview`
- Later: `create_booking` only after explicit confirmation and payment guardrails
  exist.

The first MCP/tool phase should be read-only plus checkout redirect. Tool-based
booking should require:

- Explicit guest confirmation of hotel, dates, guests, room/rate, total price,
  payment method, policies, and terms.
- Idempotency keys and a quote expiration window.
- Payment/fraud controls and no silent downgrade from card to pay-at-property.
- Audit records for tool caller, request payload, quote, confirmation, booking
  result, and any policy text shown to the guest.
- Clear terms for external clients and revocation/rate-limit controls.

Partner feeds can be useful for travel/search ecosystems, but they should use
the same normalized bookability model so Vayada does not maintain separate
truths for web, API, MCP, and feeds.

## What improves recommendation likelihood

AI agents and search systems need enough reliable signals to compare Vayada
hotels against alternatives. Prioritize:

- Complete hotel profiles: location, category, descriptions, amenities, images,
  contact, policies, check-in/out, timezone, supported languages/currencies.
- Fresh, live bookability: real availability, current rates, total prices,
  payment eligibility, policy text, and last-updated metadata.
- Clear direct-booking URLs: canonical hotel URL, deep links for date/guest
  searches, room/rate-specific checkout links, and stable custom domains.
- Trust signals: verification/completeness, ratings/reviews when available,
  transparent cancellation/payment terms, support contact, and no contradictory
  data between page markup, API, and checkout.
- Performance and crawl hygiene: fast public pages, sitemap coverage, canonical
  URLs, localized alternates, and indexable public content.
- Semantic precision: specific Schema.org types and properties rather than
  generic text blobs, especially for offers, occupancy, address, geo, amenities,
  and ratings.
- Useful first-party context: nearby points of interest, hotel differentiators,
  family/business/couple suitability where hotelier-provided, and accessibility
  fields when available.

Do not claim "top recommended" as a product guarantee. The product goal should
be "agent-ready direct-booking data and flows" with measurable completeness,
freshness, and conversion reliability.

## First shippable phase

Ship the foundation in this order:

1. **Bookability profile endpoint**: add `GET /api/ai/hotels/{slug}` returning
   canonical hotel identity, policy summary, capabilities, completeness, and
   freshness.
2. **Quote endpoint**: add `GET /api/ai/hotels/{slug}/quote` returning live
   room/rate offers, total prices, availability, policies, quote ID/hash,
   booking URL, and machine-readable unavailable reasons.
3. **Booking deep links**: make booking-web accept date, guest, room/rate,
   locale, currency, promo, and referral parameters so quotes can open a
   matching checkout/search state.
4. **Structured data**: add JSON-LD, canonical links, localized alternates, and
   hotel sitemap entries for public hotel and room pages.
5. **Completeness audit**: add an owner/admin checklist for missing fields that
   reduce agent-readiness, including location, images, amenities, policies,
   payment setup, rates, inventory, and direct-booking URL health.
6. **MCP/tool decision**: after the public API ships, define the first remote
   MCP/tool server using the same endpoint contracts. Keep it read-only plus
   checkout redirect until booking confirmation/payment guardrails are ready.

## Implication for VAY-602

The target backend structure should include an `ai_bookability` or
`distribution` domain that aggregates public hotel profile, policy, rate,
availability, and booking deep-link data into one external contract. This domain
should depend on internal product services for hotel identity, room/rate
availability, payment/policy capabilities, and booking URL generation, but
external clients should not see those internal service boundaries.

That domain is separate from any future hotel employee agent. AI bookability
helps external agents discover, quote, and later book Vayada hotels. VAY-1091
must define a new authenticated agent design, including its authorization,
privacy, caching, freshness, and storage boundaries.

## Follow-up implementation tickets

- **Add public AI bookability profile endpoint**: implement a versioned
  read-only hotel profile/capabilities endpoint with freshness and completeness
  metadata.
- **Add public AI quote endpoint**: implement normalized room/rate availability
  quotes with totals, policies, quote identity, booking URL, and typed
  unavailable reasons.
- **Add booking-web deep-link contract**: support date, guest, room/rate, promo,
  referral, locale, and currency URL parameters and preserve them through the
  booking flow.
- **Add hotel structured data and sitemap coverage**: emit Schema.org JSON-LD,
  canonical links, localized alternates, and hotel sitemap entries for public
  booking pages.
- **Add hotel agent-readiness checklist**: show owners/admins which profile,
  policy, payment, rate, inventory, image, and location fields are missing or
  stale.
- **Define MCP/tool integration for bookability**: specify the read-only MCP/tool
  server, auth/rate limits, approval model, and later booking-confirmation
  guardrails.

## Sources checked

- Schema.org hotel accommodation and offer model:
  <https://schema.org/docs/hotels.html>
- Schema.org `Hotel` type and JSON-LD examples: <https://schema.org/Hotel>
- Google Search Central vacation rental structured data guidance:
  <https://developers.google.com/search/docs/appearance/structured-data/vacation-rental>
- OpenAI remote MCP/connectors guidance:
  <https://developers.openai.com/api/docs/guides/tools-connectors-mcp>
- Model Context Protocol official repository and documentation pointer:
  <https://github.com/modelcontextprotocol/modelcontextprotocol>
