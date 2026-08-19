# Booking Web Public API Routing

_VAY-655 contract record. Builds on `engineering/booking-pms-coupling-audit.md`,
`engineering/booking-pms-domain-boundaries.md`,
`engineering/public-bookability-contract.md`, and
`engineering/pms-reservation-integration-contract.md`._

## Purpose

Booking Web currently renders one guest-facing flow while calling both Booking
API and PMS API public routes. That makes Vayada PMS look like the Booking Web
backend for room search, payment settings, direct booking lifecycle, guest
lookup, cancellation, change requests, and affiliate clicks.

This document defines the target public API split for Booking Web. It is a
contract/design slice only: it does not refactor the current Next.js runtime,
remove existing FastAPI routes, or cut traffic over before compatibility
adapters and parity checks exist.

## Decision

Booking Web must call Booking-owned and Distribution-owned public contracts.
Vayada PMS may produce inventory, room/rate, and operational reservation facts
through adapters or read models, but Booking Web must not call PMS public routes
directly in the TypeScript target path.
Where a target route triggers Marketplace, Finance, PMS, or Jobs/events/audit
work, the public HTTP boundary still stays behind the Booking/Distribution
route family and delegates to the owning domain behind that boundary.

Target call shape:

```text
Booking Web
  -> Booking/checkout public API for checkout, guest booking lifecycle, status,
     lookup, cancellation, and change requests
  -> Distribution/bookability public API for hotel page projection, room offers,
     unavailable dates, quote/deep links, host resolution, canonical URLs, and
     public attribution context
  -> Booking/Distribution public attribution endpoint that delegates affiliate
     click processing to Marketplace attribution plus Jobs/events/audit

Distribution/read models
  <- Hotel catalog public profile facts
  <- Booking checkout policy, promo/referral, add-on, and booking settings
  <- PMS operations inventory and public-safe room/rate snapshots
  <- Finance public payment capabilities
```

Forbidden target call shape:

```text
Booking Web
  -> PMS public routes for rooms, unavailable dates, payment settings,
     bookings, booking status, lookup, cancellation, change requests, or
     affiliate clicks
```

## Current Surface Inventory

| Booking Web service                   | Current route owner | Current route                                                         | Target owner                            | Target route family                                                                            |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Host/custom-domain slug resolution    | Booking API         | `GET /api/resolve-domain?domain={host}`                               | Hotel catalog plus Distribution         | `GET /api/booking-web/hosts/{host}`                                                            |
| Canonical URL redirect policy         | Booking API         | `GET /api/hotels/{slug}` plus Booking Web URL policy                  | Distribution/bookability                | Included in host and hotel page projections                                                    |
| `hotelService.getHotel`               | Booking API         | `GET /api/hotels/{slug}`                                              | Distribution/bookability                | `GET /api/booking-web/hotels/{slug}`                                                           |
| `hotelService.getRooms`               | PMS API             | `GET /api/hotels/{slug}/rooms`                                        | Distribution/bookability                | `GET /api/booking-web/hotels/{slug}/offers`                                                    |
| `hotelService.getUnavailableDates`    | PMS API             | `GET /api/hotels/{slug}/unavailable-dates`                            | Distribution/bookability                | `GET /api/booking-web/hotels/{slug}/calendar`                                                  |
| `hotelService.getAddons`              | Booking API         | `GET /api/hotels/{slug}/addons`                                       | Booking/checkout                        | Included in checkout config or add-on subresource                                              |
| `hotelService.validatePromoCode`      | Booking API         | `GET /api/hotels/{slug}/validate-promo`                               | Booking/checkout                        | `POST /api/booking-web/hotels/{slug}/promo/validate`                                           |
| `bookingService.getPaymentSettings`   | PMS API             | `GET /api/hotels/{slug}/payment-settings`                             | Finance via Booking/checkout            | `GET /api/booking-web/hotels/{slug}/checkout-config`                                           |
| `bookingService.quote`                | PMS API             | `POST /api/hotels/{slug}/bookings/quote`                              | Booking/checkout plus Distribution      | `POST /api/booking-web/hotels/{slug}/bookings/quote`                                           |
| `bookingService.create`               | PMS API             | `POST /api/hotels/{slug}/bookings`                                    | Booking/checkout                        | `POST /api/booking-web/hotels/{slug}/bookings`                                                 |
| `bookingService.confirmAuthorization` | PMS API             | `POST /api/hotels/{slug}/bookings/{handle}/confirm-authorization`     | Booking/checkout plus Finance           | `POST /api/booking-web/hotels/{slug}/bookings/{handle}/confirm-authorization`                  |
| Manual-payment instructions           | PMS API             | Pre-checkout `payment-settings` bank details and create response data | Finance via Booking/checkout            | Create response or `GET /api/booking-web/hotels/{slug}/bookings/{handle}/payment-instructions` |
| `bookingService.getStatus`            | PMS API             | `GET /api/hotels/{slug}/bookings/status`                              | Booking/checkout                        | `GET /api/booking-web/hotels/{slug}/bookings/status`                                           |
| `bookingService.lookup`               | PMS API             | `POST /api/hotels/{slug}/bookings/lookup`                             | Booking/checkout                        | `POST /api/booking-web/hotels/{slug}/bookings/lookup`                                          |
| `bookingService.withdraw`             | PMS API             | `POST /api/hotels/{slug}/bookings/{bookingId}/withdraw`               | Booking/checkout                        | `POST /api/booking-web/hotels/{slug}/bookings/{bookingId}/withdraw`                            |
| `bookingService.cancelPreview`        | PMS API             | `POST /api/hotels/{slug}/bookings/{bookingId}/cancel-preview`         | Booking/checkout plus Finance           | `POST /api/booking-web/hotels/{slug}/bookings/{bookingId}/cancel-preview`                      |
| `bookingService.cancel`               | PMS API             | `POST /api/hotels/{slug}/bookings/{bookingId}/cancel`                 | Booking/checkout plus Finance/PMS sink  | `POST /api/booking-web/hotels/{slug}/bookings/{bookingId}/cancel`                              |
| `bookingService.previewChangeRequest` | PMS API             | `POST /api/hotels/{slug}/bookings/{bookingId}/change-request/preview` | Booking/checkout plus Distribution      | `POST /api/booking-web/hotels/{slug}/bookings/{bookingId}/change-request/preview`              |
| `bookingService.submitChangeRequest`  | PMS API             | `POST /api/hotels/{slug}/bookings/{bookingId}/change-request`         | Booking/checkout plus PMS sink          | `POST /api/booking-web/hotels/{slug}/bookings/{bookingId}/change-request`                      |
| `bookingService.getChangeRequest`     | PMS API             | `GET /api/hotels/{slug}/bookings/{bookingId}/change-request`          | Booking/checkout                        | `GET /api/booking-web/hotels/{slug}/bookings/{bookingId}/change-request`                       |
| `hotelService.recordAffiliateClick`   | PMS API             | `POST /api/hotels/{slug}/affiliates/{referralCode}/click`             | Marketplace plus Jobs/events/audit      | `POST /api/booking-web/hotels/{slug}/attribution/clicks`                                       |
| `trackEvent`                          | Booking API         | `POST /api/events`                                                    | Jobs/events/audit via Booking telemetry | `POST /api/booking-web/events`; no legacy Booking forwarding                                   |

The target route family is intentionally Booking Web specific. Public AI and
partner bookability routes may stay under `/api/ai/...`; Booking Web should not
depend on agent-facing response shapes when it needs checkout-specific fields,
guest lifecycle actions, or localized page bootstrap data.

## Contract Ownership

### Hotel and Profile Facts

Target owner: Distribution/bookability public page projection.

Producer owners:

- Hotel/property catalog owns public identity, location, timezone, locale,
  media, amenities, public contacts, and profile completeness.
- Booking/checkout owns check-in/check-out policy, cancellation summary, terms
  URL, instant-book/request-to-book capability, promo capability, referral
  capability, and add-on availability.
- Finance owns public payment capability summaries and default/supported
  currencies.

Booking Web consumes one public page projection keyed by slug and locale. The
projection must not expose PMS table names, Channex IDs, private payment
provider fields, admin notes, or guest PII.

Host and custom-domain resolution are part of the same profile split. Booking
Web may derive well-known Vayada subdomain slugs locally, but custom-domain
lookup and canonical redirect policy must come from Hotel catalog and
Distribution projections rather than the legacy Booking API domain resolver.

### Rooms, Offers, Quotes, and Unavailable Dates

Target owner: Distribution/bookability.

Distribution owns the public-safe offer and calendar projection. PMS operations
produces inventory, room/rate, stay restriction, stop-sell, and room block
snapshots into Distribution; Booking contributes policy/add-on/promo context;
Finance contributes payment capability. Booking Web reads Distribution output
only.

Unavailable-date responses must be public-safe calendar summaries, not a raw PMS
inventory API. They may include date-level sold-out state, min/max stay by
arrival, same-day cutoff closure, and coarse unavailable reason codes.

### Payment Settings and Checkout Config

Target owner: Finance via Booking/checkout.

Booking Web needs checkout-safe payment configuration, not provider-private
payment settings. The public checkout config may include enabled payment methods,
deposit requirement summary, bank-transfer availability, PayPal availability,
guest form flags, terms text/URL, cancellation summary, same-day cutoff, and
payment-disabled reason codes.

It must not include payout settings, Stripe/Xendit account IDs, provider
onboarding state, bank details unless they are intentionally needed after a
manual-payment booking exists, or private risk/finance metadata.

Manual-payment instructions are Finance-owned public checkout outputs. Booking
Web should receive them only after a guest has selected a manual method and a
Booking-owned checkout/booking exists, either embedded in the Booking create
response or through a booking-scoped payment-instructions route. This preserves
bank-transfer and PayPal guest UX without exposing payout or provider settings
as pre-checkout public configuration.

### Booking Create, Confirm, Status, Lookup, Cancel, and Change

Target owner: Booking/checkout.

Booking owns guest booking identity, quote/session consumption, idempotency,
guest-visible status, lookup, cancellation preview, cancellation request, change
request preview, and change request submission. Finance owns payment
authorization/capture/refund decisions. PMS operations receives confirmed or
accepted changes only through the PMS reservation sink contract in
`engineering/pms-reservation-integration-contract.md`.

Booking Web must treat `guestBookingId` and booking reference as Booking
identities. Any PMS reservation reference returned to Booking must stay opaque
and must not be required by the frontend for guest actions.

### Affiliate Click Tracking and Public Events

Target owner: Marketplace plus Jobs/events/audit.

Marketplace owns collaboration and affiliate attribution rules. Jobs/events/audit
owns durable event intake, retries, abuse/rate-limit signals, and audit
visibility. Finance consumes attribution outcomes for commission rules when a
booking converts.

Booking Web should submit click/session data to a Booking/Distribution public
route family endpoint owned by Marketplace attribution plus Jobs/events/audit.
Distribution may provide read-only public attribution context on page and quote
responses, but it does not own the click write. The intake endpoint may emit
marketplace attribution events and telemetry jobs, but Booking Web must not
write PMS affiliate click rows or know which PMS adapter will eventually receive
commission context.

Dashboard source after VAY-769: Booking Web page/funnel telemetry is target-only
when `BOOKING_WEB_EVENT_SINK=target` and `AUTH_DATABASE_URL`/WorkOS auth config
are present. Dashboard readers should query `platform.domain_events` for
`booking_web.*` distribution events and join the matching
`platform.product_audit_events` rows when audit/correlation context is needed.
The TypeScript intake no longer best-effort forwards telemetry to legacy Booking
`/api/events`. Telemetry event keys use a client `eventId`/`idempotencyKey` when
provided and otherwise the API request id; they must not dedupe all repeated
events in a browser session.

## Transitional Compatibility

The existing PMS public endpoints are production compatibility surfaces and must
stay available until Booking Web has target API parity:

- `GET /api/hotels/{slug}/rooms`
- `GET /api/hotels/{slug}/unavailable-dates`
- `GET /api/hotels/{slug}/payment-settings`
- `POST /api/hotels/{slug}/bookings`
- `POST /api/hotels/{slug}/bookings/{handle}/confirm-authorization`
- `POST /api/hotels/{slug}/bookings/{bookingId}/withdraw`
- `POST /api/hotels/{slug}/bookings/{bookingId}/cancel-preview`
- `POST /api/hotels/{slug}/bookings/{bookingId}/cancel`
- `GET /api/hotels/{slug}/bookings/status`
- `POST /api/hotels/{slug}/bookings/lookup`
- `POST /api/hotels/{slug}/bookings/{bookingId}/change-request/preview`
- `POST /api/hotels/{slug}/bookings/{bookingId}/change-request`
- `GET /api/hotels/{slug}/bookings/{bookingId}/change-request`
- `POST /api/hotels/{slug}/affiliates/{referralCode}/click`

Compatibility rules:

1. Existing FastAPI PMS routes may continue serving the current Next.js runtime
   until a focused cutover PR switches Booking Web to Booking/distribution
   endpoints.
2. New TypeScript target planning must not add new Booking Web direct PMS
   calls. Temporary PMS reads for rooms, unavailable dates, payment-readiness
   inputs, and operational lookup inputs are allowed only inside server-side
   compatibility adapters that emit Booking, Distribution, Finance,
   Marketplace, or Jobs/events/audit contracts.
3. Compatibility adapters may preserve current frontend response field names
   while the frontend is migrated, but the owning contract must name the target
   domain owner and data-source owner separately.
4. Booking lifecycle writes use the target Booking command adapter and PMS
   reservation handoff, with Booking-owned idempotency, guest-visible status
   mapping, audit visibility, and parity tests. The frontend calls
   Booking/checkout, not PMS.
5. Manual-payment instructions must be covered by parity before the public
   payment-settings route is retired.
6. `NEXT_PUBLIC_PMS_URL` in Booking Web is legacy configuration. Target Booking
   Web should need only the public Booking/distribution API origin.
7. TypeScript quote and offer reads use the target Distribution projections.
   `PMS_PUBLIC_API_URL` is rejected as stale Python integration configuration
   and is not a target Booking Web dependency.
8. Target Booking lifecycle routes preserve current guest-visible behavior
   for card soft holds, manual payments, request-to-book states, cancellation
   previews, and change request previews until parity fixtures cover the target
   routes.

## Recorded Migration Sequence

The migration followed this order. Steps 1–5 are complete; step 6 remains for
the separately tracked affiliate compatibility surface:

1. Added Booking Web public route adapters in the TypeScript API with no direct
   frontend changes. The active adapters are target-backed; stale Python API
   URL configuration is rejected.
2. Added parity tests for current hotel page bootstrap, rooms/offers,
   host/custom-domain resolution, canonical redirects, unavailable dates,
   payment config, manual-payment instructions, booking
   create/confirm/status/lookup, cancel, change request, and affiliate click
   behavior.
3. Switched `apps/booking-web/services/api` from `pms` to the
   Booking/distribution API for page, offer, and calendar reads. The remaining
   affiliate facade is tracked separately.
4. Moved booking create/confirm/status/lookup/cancel/change calls behind
   Booking/checkout route adapters and wired PMS handoff through the PMS
   reservation sink.
5. Replaced affiliate click writes with marketplace attribution events and
   durable telemetry/audit intake.
6. Remove `NEXT_PUBLIC_PMS_URL` from Booking Web and retire the remaining PMS
   public compatibility routes after production parity and smoke coverage are
   accepted.

## Acceptance for Future PRs

Future implementation PRs that touch Booking Web public API calls should answer:

- Does Booking Web call Booking or Distribution, rather than PMS?
- Is each producer fact mapped to its target owner before reaching the
  frontend?
- Are PMS reservation references opaque and absent from frontend business logic?
- Are payment settings public checkout capabilities rather than provider or
  payout settings?
- Are affiliate clicks represented as marketplace attribution events with
  durable audit/telemetry, rather than PMS table writes?
- Are custom-domain resolution and canonical URL policy served by catalog and
  Distribution projections instead of legacy Booking API profile routes?
- Are manual-payment instructions returned from a booking-scoped Finance output
  instead of pre-checkout provider settings?
- Is any temporary PMS compatibility route documented with a removal dependency
  and covered by parity tests?
