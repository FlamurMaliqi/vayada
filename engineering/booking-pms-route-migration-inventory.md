# Booking/PMS route migration inventory

_VAY-762 decision record. Complements
`apps-api-legacy-runtime-dependency-audit.md` from VAY-760,
`marketplace-route-migration-inventory.md`, `booking-pms-coupling-audit.md`,
and `pms-reservation-integration-contract.md`._

## Purpose

Inventory the remaining legacy `booking-api` and `pms-api` route surfaces,
identify consumers, mark existing `apps/api` coverage, and define the
contract-first vertical order needed to call the TypeScript backend rewrite
complete.

Current code scan:

- `apps/booking-api`: 58 decorated routes, including 3 app-level infra routes.
- `apps/pms-api`: 157 decorated routes, including 1 app-level health route.

The ticket text references 56 booking routes; this document uses the current
repository state so newer helpers such as promo/internal helpers and app-level
health are not silently dropped.

Consumer abbreviations:

- BA = `apps/booking-admin`
- BW = `apps/booking-web`
- PMS = `apps/pms-web`
- AD = `apps/affiliate-dashboard`
- VA = `apps/vayada-admin`
- API = `apps/api`
- EXT = external/webhook/provider surface

## Reconciliation with apps/api

Already implemented in `apps/api`; remaining source-specific compatibility
behavior is called out per route:

| TypeScript surface                                                                    | Legacy surface covered                                                             | Status                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/PUT /api/booking/hotels/:hotelId/settings/addons`                                | Booking admin add-on settings.                                                     | Migrated route shape always reads and writes the target Booking settings projection.                                                          |
| `GET/PUT /api/booking/hotels/:hotelId/settings/guest-form`                            | Booking/PMS guest-form settings.                                                   | Migrated route shape always reads and writes the target projection; the retired PMS Python client is not called.                              |
| `GET/PUT /api/booking/hotels/:hotelId/settings/benefits`                              | Booking/PMS benefits.                                                              | Migrated route shape always reads and writes the target Booking settings projection.                                                          |
| `GET/PUT /api/booking/hotels/:hotelId/settings/localization`                          | Booking localization/currency settings.                                            | Migrated route shape always reads and writes the target Booking settings projection.                                                          |
| `GET/PUT /api/booking/hotels/:hotelId/settings/room-filters`                          | Booking design/room-filter settings.                                               | Migrated route shape always reads and writes the target Booking settings projection.                                                          |
| `GET /api/booking/hotels/:hotelId/reservations`                                       | Booking-admin reservation list backed by target Booking/PMS/Finance projections.   | Migrated route and target read model; no legacy PMS database connection.                                                                      |
| `GET /api/ai/hotels/:slug` and `/api/booking-web/hotels/:slug`                        | Public hotel profile.                                                              | Migrated response contract always uses the target profile or active immutable publication through `TARGET_DATABASE_URL`.                      |
| `GET /api/ai/hotels/:slug/quote` and `/api/booking-web/hotels/:slug/offers`           | Public room/rate quote.                                                            | Target mode reads the target projection; compatibility mode returns an unavailable quote without calling a legacy service.                    |
| `GET /api/booking-web/hotels/:slug/calendar`                                          | Public unavailable dates.                                                          | Target mode reads the target projection; compatibility mode returns an unavailable calendar projection without calling a legacy service.      |
| `GET /api/booking-web/hosts/:host`                                                    | Booking host/custom-domain resolution.                                             | Contract uses the selected target profile repository for known subdomains and verified custom domains; the legacy domain selector is removed. |
| Booking Web checkout, guest command, promo, affiliate routes under `/api/booking-web` | PMS public checkout routes, Booking promo validation, PMS affiliate public routes. | Target adapters own migrated behavior; compatibility mode returns explicit unavailable responses without a legacy Python client.              |
| `POST /api/booking-web/events` and `/hotels/:slug/attribution/clicks`                 | Booking public telemetry and affiliate click tracking.                             | Target event sink writes platform events/audit rows; legacy telemetry forwarding to `BOOKING_PUBLIC_API_URL /api/events` is retired.          |

## booking-api route inventory

### Infrastructure

| Routes                                   | Consumers   | Disposition                                                      |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `GET /`, `GET /health`, `GET /health/db` | local/infra | Replace with `apps/api` health/readiness. Not product verticals. |

### Auth and account lifecycle

| Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Consumers                                                                      | Disposition                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/totp/verify`, `POST /auth/totp/setup`, `POST /auth/totp/confirm`, `POST /auth/totp/recovery-codes/regenerate`, `GET /auth/totp/recovery-codes/count`, `GET /auth/totp/status`, `GET /auth/login-history`, `POST /auth/logout`, `POST /auth/validate-token`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/change-password`, `POST /auth/change-email`, `POST /auth/verify-email-change` | BA, PMS, AD, VA; some marketplace legacy clients still use the same auth shape | **WorkOS/identity track.** Do not port as Booking verticals. Keep only temporary compatibility until each frontend uses AuthKit and identity lifecycle commands. |

### Booking admin property, setup, domain, and design

| Routes                                                                                                                                                                    | Consumers                      | apps/api status                                                                                    | Disposition                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/hotels`, `GET /admin/me`                                                                                                                                      | BA, VA                         | Not migrated                                                                                       | WorkOS identity plus hotel/resource selection. Replace with organization resource links and selected-property context.                                                                                          |
| `GET /admin/settings/setup-status`                                                                                                                                        | BA, PMS setup links            | Not migrated                                                                                       | Port as hotel-catalog/booking setup read model after canonical property setup facts exist.                                                                                                                      |
| `GET /admin/settings/property`, `POST /admin/hotels`, `PATCH /admin/settings/property`, `GET /admin/hotels/{hotel_id}/deletion-impact`, `DELETE /admin/hotels/{hotel_id}` | BA, PMS, VA                    | Partially covered by public profile/settings but admin property CRUD is not migrated               | Hotel catalog owns canonical property identity; Booking owns booking capabilities; Finance owns billing/payment flags. Split into contract-first setup/profile commands rather than porting this row wholesale. |
| `POST /admin/settings/custom-domain`, `DELETE /admin/settings/custom-domain`, `GET /admin/settings/custom-domain/status`                                                  | BA, PMS custom-domain settings | Host read partially covered; admin writes not migrated                                             | Port to target property/domain verification. Coordinate cutover with Booking Web host-resolution because custom-domain traffic breaks if verification state is not migrated.                                    |
| `GET /admin/settings/design`, `PATCH /admin/settings/design`, `POST /admin/upload/images`                                                                                 | BA, PMS, VA design studio      | Design settings migrated to target-backed `/api/booking/.../settings/design`; upload proxy retired | Booking Admin uses the typed settings route and platform media sessions. Audit any remaining external consumers before retiring the old Python routes.                                                          |

### Booking admin settings and commercial controls

| Routes                                                                                                                                                                       | Consumers                   | apps/api status                                                         | Disposition                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /admin/addons`, `POST /admin/addons`, `PATCH /admin/addons/{addon_id}`, `DELETE /admin/addons/{addon_id}`, `GET /admin/settings/addons`, `PATCH /admin/settings/addons` | BA, VA, BW checkout         | Settings and add-on catalog CRUD migrated to target-backed typed routes | Keep Booking Admin on the target clients; audit external consumers before retiring the old Python routes.  |
| `GET /admin/benefits`, `PUT /admin/benefits`                                                                                                                                 | BA, PMS                     | Migrated to target-backed `/api/booking/.../settings/benefits`          | Keep Booking Admin on the target client; audit external consumers before retiring the old Python routes.   |
| `GET /admin/promo-codes`, `POST /admin/promo-codes`, `PATCH /admin/promo-codes/{promo_id}`, `DELETE /admin/promo-codes/{promo_id}`                                           | BA, VA, BW promo validation | Admin CRUD migrated to target-backed typed routes                       | Public promo validation is owned by the Booking Web checkout command surface, not this admin route family. |

### Booking analytics and events

| Routes                                                                                                                                                                                  | Consumers                  | apps/api status                                       | Disposition                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/dashboard/stats`, `GET /admin/dashboard/bookings-by-source`, `GET /admin/dashboard/conversion-funnel`, `GET /admin/dashboard/sparklines`, `GET /admin/dashboard/page-views` | BA                         | Not migrated                                          | Booking metrics/read-model vertical. Existing audit VAY-651 direction: Booking metrics read port, PMS operational reservation read port, no PMS DB access from Booking. |
| `POST /api/events`                                                                                                                                                                      | BW legacy public telemetry | TypeScript Booking Web intake no longer forwards here | Legacy route remains booking-api-owned until dashboard/read-model migration removes the old consumer surface.                                                           |

### Public Booking API

| Routes                                                                                                                                                                                                                                         | Consumers                                                  | apps/api status                                                                                                          | Disposition                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/hotels/{slug}`, `GET /api/hotels/{slug}/addons`, `GET /api/hotels/{slug}/payment-settings`, `GET /api/hotels/{slug}/validate-promo`, `POST /api/hotels/{slug}/increment-promo`, `GET /api/exchange-rates`, `GET /api/resolve-domain` | BW, API compatibility adapters, PMS public booking service | Profile/host/promo pieces partially covered; add-ons, payment settings, exchange rates, promo increment not target-owned | Split across public profile, booking/checkout, finance, and platform/domain verification. `increment-promo` is server-to-server and must become an idempotent booking outcome side effect, not a public helper. |

## pms-api route inventory

### Infrastructure

| Routes        | Consumers   | Disposition                                                     |
| ------------- | ----------- | --------------------------------------------------------------- |
| `GET /health` | local/infra | Replace with `apps/api` health/readiness. Not product vertical. |

### Public bookability and direct booking

| Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Consumers                       | apps/api status                                                                                                                     | Disposition                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/hotels/{slug}/rooms`, `GET /api/hotels/{slug}/unavailable-dates`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | BW, API quote/calendar adapters | Proxied by `apps/api` quote/offers/calendar                                                                                         | Distribution/bookability read vertical. Replace with target offer/calendar read models; Channex/availability freshness is cutover-window sensitive.                                                                              |
| `POST /api/hotels/{slug}/bookings`, `POST /api/hotels/{slug}/bookings/{handle}/confirm-authorization`, `POST /api/hotels/{slug}/bookings/{booking_id}/withdraw`, `POST /api/hotels/{slug}/bookings/{booking_id}/cancel-preview`, `POST /api/hotels/{slug}/bookings/{booking_id}/cancel`, `POST /api/hotels/{slug}/bookings/lookup`, `GET /api/hotels/{slug}/bookings/status`, `POST /api/hotels/{slug}/bookings/{booking_id}/change-request/preview`, `POST /api/hotels/{slug}/bookings/{booking_id}/change-request`, `GET /api/hotels/{slug}/bookings/{booking_id}/change-request`, `GET /api/hotels/{slug}/payment-settings` | BW, API checkout adapter        | Compatibility adapter exists; write commands proxy only when explicitly enabled                                                     | Booking/checkout vertical plus PMS reservation handoff. This is staging-rehearsal gating because guest bookings, cancellation, change requests, and payment state cannot depend on the legacy PMS public API at cutover.         |
| `GET /api/hotels/{slug}/affiliates/check-email`, `POST /api/hotels/{slug}/affiliates`, `POST /api/hotels/{slug}/affiliates/{referral_code}/click`, `POST /api/hotels/{slug}/affiliates/{affiliate_id}/stripe/connect`, `GET /api/hotels/{slug}/affiliates/{affiliate_id}/stripe/onboarding-link`                                                                                                                                                                                                                                                                                                                               | BW, API affiliate adapter       | `check-email`, `register`, and connect are proxied; click is replaced by API event sink; onboarding-link not exposed by API adapter | Marketplace/affiliate plus finance target ownership behind `AFFILIATE_PUBLIC_SOURCE=target`. Booking Web remains a compatibility facade while `ReferModal` is live; retire only after that public UI/product surface is removed. |

#### VAY-768 affiliate route ownership decision

Booking Web should not own affiliate application, referral identity, or payout
provider onboarding. The public Booking Web affiliate endpoints remain only as a
temporary compatibility facade for the existing `ReferModal` guest/creator
registration flow; they must be backed by marketplace/affiliate and finance
target services before `PMS_PUBLIC_API_URL` is removed.

Accepted ownership:

- Marketplace/affiliate owns public email availability checks, affiliate
  application/registration state, referral codes, referral links, and approval
  lifecycle.
- Finance owns affiliate payout account/provider setup, including Stripe
  Connect account creation and onboarding-link issuance.
- Booking Web owns only the public UI entry point and request/response
  compatibility shape under `/api/booking-web/hotels/:slug/affiliates...`.
- Affiliate click attribution remains outside this proxy path and continues to
  use the target event sink.

Consequences:

- Do not retire the public registration route while Booking Web still renders
  the referral modal. Route retirement is only acceptable if product removes
  that public affiliate registration surface and the modal/links are updated in
  the same slice.
- The follow-up implementation should introduce
  `AFFILIATE_PUBLIC_SOURCE=target` backed by `TARGET_DATABASE_URL` and target
  domain services. It must mount `check-email`, `register`, and Stripe Connect
  link creation without any PMS HTTP proxy or PMS table writes.
- Contract tests should prove the public routes work with
  `PMS_PUBLIC_API_URL` unset and preserve the current browser-facing response
  shape that Booking Web consumes: `check-email` returns `exists`, registration
  accepts the current `ReferModal` payload (`fullName`, `email`,
  `socialMedia`, `userType`, `paymentMethod`, PayPal fields, and bank fields)
  and returns stable affiliate `id` plus `referralCode`, and Stripe Connect
  link creation returns the exact `onboardingUrl` field.
- Public registration should create a marketplace/affiliate application or
  affiliate resource and emit/audit the event needed by affiliate admin and the
  affiliate dashboard vertical. Stripe Connect should be delegated to finance
  and linked back to the affiliate resource by stable target identifiers.
- Affiliate provisioning must be retry-safe. The
  `marketplace.affiliate.provision:collaboration:<id>:v1` command/event is
  idempotent: if the affiliate/application already exists, the target handler is
  a no-op for side effects and returns the existing affiliate. Public
  registration retries for the same collaboration/application must always return
  the same affiliate `id` and `referralCode` instead of allocating a duplicate
  identity.
- `POST /api/hotels/{slug}/affiliates/{affiliate_id}/stripe/connect` must be
  idempotent by explicit idempotency key or by stable dedupe on `affiliate_id`.
  Repeated requests must not create duplicate Stripe accounts. The public
  response should return the latest valid `onboardingUrl` for the same
  `stripe_connect_account_id`; if the previous onboarding link has expired,
  finance may mint a replacement link for the same account, not a new account.
- Stripe Connect compensation must cover the partial-failure window where the
  provider account is created but the target `stripe_connect_account_id` write
  fails. Finance owns a reconciliation job/audit path that either reattaches the
  provider account to the affiliate record by provider metadata/idempotency key
  or marks the orphaned Stripe account for cleanup before another account can be
  created for the same affiliate.
- Contract tests for the follow-up implementation must simulate registration
  retries, Stripe Connect retries, and Stripe provider-success/DB-write-failure
  recovery. They should assert stable affiliate `id`/`referralCode`,
  deterministic onboarding URL/account behavior, no duplicate provider accounts,
  and successful reconciliation of the partial failure.

### PMS admin property and setup

| Routes                                                                                                                                                                                                                                                                                                                                             | Consumers                                             | apps/api status                                                                              | Disposition                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/register-hotel`, `GET /admin/hotel`, `PATCH /admin/hotel`, `GET /admin/hotel/deletion-impact`, `DELETE /admin/hotel`, `GET /admin/setup-status`, `GET /admin/benefits`, `PUT /admin/benefits`, `GET /admin/guest-form-settings`, `PATCH /admin/guest-form-settings`, `GET /admin/calendar-settings`, `PATCH /admin/calendar-settings` | PMS, BA setup handoff, historical API guest-form sync | Benefits and guest-form settings are target-backed; PMS property/setup/calendar are separate | Hotel catalog owns property identity, Booking owns guest-facing settings, and PMS owns operational calendar settings. No apps/api guest-form sync remains. |

### PMS operations: inventory, rooms, room types, calendar, blocks

| Routes                                                                                                                                                                                                                                                                                  | Consumers                                          | apps/api status                             | Disposition                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/rooms`, `POST /admin/rooms`, `PATCH /admin/rooms/reorder`, `PATCH /admin/rooms/{room_id}`, `DELETE /admin/rooms/{room_id}`, `GET /admin/calendar`                                                                                                                           | PMS, BA room selector                              | Calendar/offers only proxied on public side | PMS operations vertical. Reads before writes; external availability/ARI side effects must move to jobs/events.                                                |
| `GET /admin/room-types`, `POST /admin/room-types`, `GET /admin/room-types/{room_type_id}`, `GET /admin/room-types/{room_type_id}/resolved-rate`, `PATCH /admin/room-types/{room_type_id}`, `POST /admin/room-types/{room_type_id}/duplicate`, `DELETE /admin/room-types/{room_type_id}` | PMS, BA room selector, BW public offers indirectly | Public offers proxied through PMS rooms     | PMS operations plus finance/distribution rate projection. `resolved-rate` must be contract-owned because quote/checkout depend on the same pricing semantics. |
| `POST /admin/room-blocks`, `PATCH /admin/room-blocks/{block_id}`, `DELETE /admin/room-blocks/{block_id}`                                                                                                                                                                                | PMS calendar                                       | Not migrated                                | PMS operations vertical with Channex ARI jobs. Cutover-window sensitive because inventory blocks can affect public bookability immediately.                   |
| `GET /admin/module-activations`, `PATCH /admin/module-activations/{module_id}`                                                                                                                                                                                                          | PMS                                                | Not migrated                                | Platform entitlement/module configuration. Merge with entitlement and setup-read surfaces rather than PMS-only flags.                                         |

### PMS admin bookings and operational reservations

| Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Consumers                                              | apps/api status                                                         | Disposition                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/bookings`, `GET /admin/bookings`, `GET /admin/bookings/{booking_id}`, `PATCH /admin/bookings/{booking_id}`, `GET /admin/bookings/addons/available`, `GET /admin/bookings/{booking_id}/addons`, `PATCH /admin/bookings/{booking_id}/status`, `POST /admin/bookings/{booking_id}/check-in`, `POST /admin/bookings/{booking_id}/mark-paid`, `POST /admin/bookings/{booking_id}/arrival-charge`, `PATCH /admin/bookings/{booking_id}/assign-room`, `PATCH /admin/bookings/{booking_id}/move-room`, `PATCH /admin/bookings/{booking_id}/unassign-room`, `PATCH /admin/bookings/{booking_id}/swap-room`, `POST /admin/bookings/{booking_id}/accept`, `POST /admin/bookings/{booking_id}/reject`, `GET /admin/bookings/{booking_id}/change-request`, `POST /admin/bookings/{booking_id}/change-request/approve`, `POST /admin/bookings/{booking_id}/change-request/decline`, `GET /admin/bookings/{booking_id}/notes`, `POST /admin/bookings/{booking_id}/notes`, `DELETE /admin/bookings/{booking_id}/notes/{note_id}`, `GET /admin/bookings/{booking_id}/additional-guests`, `POST /admin/bookings/{booking_id}/additional-guests`, `PATCH /admin/bookings/{booking_id}/additional-guests/{guest_id}`, `DELETE /admin/bookings/{booking_id}/additional-guests/{guest_id}`, `POST /admin/bookings/{booking_id}/cancel`, `POST /admin/bookings/{booking_id}/no-show`, `GET /admin/payouts` | PMS, BA reservation read via API, VA super-admin views | Reservation list migrated as read-only compatibility; rest not migrated | Split Booking guest lifecycle from PMS operational reservation state. PMS operations owns assignment/check-in/out/notes/operational status; Booking owns guest-visible accept/reject/cancel/change outcomes; finance owns payouts/charges. This is staging-rehearsal gating. |
| `GET /admin/check-in-checklist`, `PUT /admin/check-in-checklist`, `GET /admin/check-out-inspection`, `PUT /admin/check-out-inspection`, `GET /admin/bookings/{booking_id}/checkout-charges`, `POST /admin/bookings/{booking_id}/checkout-charges`, `POST /admin/bookings/{booking_id}/checkout-charges/{charge_id}/paid`, `POST /admin/bookings/{booking_id}/checkout-charges/{charge_id}/waive`, `GET /admin/bookings/{booking_id}/checkout-record`, `POST /admin/bookings/{booking_id}/check-out`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PMS                                                    | Not migrated                                                            | PMS operations plus finance charge records. Keep operational checklist/inspection PMS-owned; payment/charge effects need audit and idempotency.                                                                                                                              |

### Finance, payments, payouts, and affiliates

| Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Consumers                          | apps/api status                                     | Disposition                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/payment-settings`, `PATCH /admin/payment-settings`, `PATCH /admin/cancellation-policy`, `POST /admin/stripe/connect-account`, `GET /admin/stripe/connect-onboarding-link`, `POST /admin/xendit/validate-bank-account`, `POST /admin/xendit/reconcile-payouts`                                                                                                                                                                                           | PMS, BW public checkout indirectly | Public payment-settings proxied; admin not migrated | Finance vertical. Payment provider onboarding, payout account validation, cancellation policy, and reconciliation move to finance commands/jobs.                    |
| `GET /admin/financials/summary`, `GET /admin/financials/invoices`, `GET /admin/financials/invoices/export.csv`, `GET /admin/financials/invoices/{booking_id}`, `POST /admin/financials/invoices/{booking_id}/payments`, `GET /admin/financials/payments`                                                                                                                                                                                                            | PMS                                | Not migrated                                        | Finance read/write vertical. CSV export can be a read-model/export job after invoice/payment contracts land.                                                        |
| `GET /admin/affiliates/default-commission`, `PATCH /admin/affiliates/default-commission`, `GET /admin/affiliates`, `GET /admin/affiliates/{affiliate_id}`, `PATCH /admin/affiliates/{affiliate_id}/status`, `PATCH /admin/affiliates/{affiliate_id}/commission`, `POST /admin/affiliates/{affiliate_id}/stripe/connect-account`, `GET /admin/affiliates/{affiliate_id}/stripe/connect-onboarding-link`, `POST /admin/affiliates/{affiliate_id}/xendit/bank-details` | PMS                                | Public affiliate pieces proxied; admin not migrated | Marketplace/affiliate plus finance vertical. Commission defaults and payout accounts are finance-owned; affiliate application state is marketplace/affiliate-owned. |

### Channex, messaging, uploads, imports, and webhooks

| Routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consumers              | apps/api status | Disposition                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/channex/enable`, `POST /admin/channex/disable`, `GET /admin/channex/status`, `POST /admin/channex/provision`, `GET /admin/channex/room-type-mappings`, `GET /admin/channex/rate-plan-mappings`, `POST /admin/channex/sync-ari`, `POST /admin/channex/sync-bookings`, `GET /admin/channex/channels`, `GET /admin/channex/markups`, `PUT /admin/channex/markups`, `POST /admin/channex/iframe-url`, `POST /admin/channex/messaging/backfill`, `POST /admin/channex/messaging/install`, `GET /admin/channex/webhook-events/summary`, `POST /admin/channex/webhook/setup` | PMS, EXT Channex setup | Not migrated    | PMS channel-connectivity vertical with durable jobs/events. Cutover-window sensitive: webhook endpoint, ARI sync, and mappings must move together or be frozen.           |
| `GET /admin/messaging/threads`, `GET /admin/messaging/threads/{thread_id}`, `POST /admin/messaging/threads/{thread_id}/messages`, `POST /admin/messaging/threads/{thread_id}/attachments`, `POST /admin/messaging/threads/{thread_id}/read`, `POST /admin/messaging/threads/{thread_id}/close`, `POST /admin/messaging/threads/{thread_id}/no-reply-needed`, `GET /admin/messaging/unread-count`                                                                                                                                                                                   | PMS                    | Not migrated    | PMS/Channex messaging vertical. Attachments share platform media ownership.                                                                                               |
| `POST /upload/images`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PMS, VA upload helpers | Retired         | Generic PMS image uploads are retired. PMS Web uses platform media upload sessions for room media; PMS listing import routes are retired with the listing import feature. |
| `POST /webhooks/stripe`, `POST /webhooks/xendit`, `POST /webhooks/channex`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | EXT providers          | Not migrated    | External webhook intake. Must be cut over in a provider-aware window with idempotency, replay, and rollback handling.                                                     |

### Non-route external runtime surfaces

`pms-api` also starts `app.services.scheduler.setup_scheduler()` on boot. These
jobs are not decorated routes, but they mutate the same provider and booking
state that route cutover depends on:

| Scheduler job                        | Current effect                                                   | Cutover disposition                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `expire_pending_bookings`            | Expires pending bookings when the host response deadline passes. | Booking/checkout target job with idempotent booking outcome events; legacy job must be disabled during the write freeze. |
| `cancel_stale_unpaid_bookings`       | Cancels stale unpaid bookings.                                   | Booking/checkout target job; must share cancellation idempotency with guest/admin cancel commands.                       |
| `cleanup_expired_drafts`             | Deletes expired booking drafts.                                  | Booking/checkout target cleanup job; safe only after target owns draft state.                                            |
| `process_property_payouts`           | Dispatches Stripe/Xendit hotel payouts.                          | Finance target job; disable legacy before target payout dispatcher starts to avoid duplicate provider transfers.         |
| `process_affiliate_payouts`          | Dispatches affiliate payouts and notifications monthly.          | Finance/affiliate target job; cut over with affiliate payout ledger and notification audit.                              |
| `poll_xendit_processing_payouts`     | Polls provider payout state and marks success/failure.           | Finance target reconciliation job with provider idempotency/replay handling.                                             |
| `poll_channex_bookings`              | Polls Channex booking feed and ingests OTA reservations.         | PMS channel-connectivity target job or provider freeze; cannot run in both legacy and target during cutover.             |
| `full_channex_ari_sync`              | Pushes full ARI state to Channex.                                | PMS channel-connectivity target job; legacy scheduler must be stopped before target ARI push begins.                     |
| `advance_calendar_auto_open_windows` | Opens rolling inventory/calendar windows.                        | PMS operations target job; coordinate with room-block/calendar migration and public bookability freshness.               |

The Channex/webhook follow-up must include scheduler disable/freeze controls,
job ownership, idempotency keys, replay policy, and rollback behavior. A route
PR that moves Channex or payout/provider endpoints without these scheduler
controls is not enough for staging rehearsal.

### Affiliate dashboard and platform/super-admin

| Routes                                                                                                                                                                                                                                                                                                    | Consumers | apps/api status                                                   | Disposition                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /affiliate/me`, `GET /affiliate/properties`, `GET /affiliate/dashboard`, `GET /affiliate/earnings`, `GET /affiliate/activity`, `GET /affiliate/payouts`, `GET /affiliate/payout-settings`, `PATCH /affiliate/payout-settings`, `PATCH /affiliate/me`, `POST /affiliate/xendit/validate-bank-account` | AD        | Auth still uses booking-api; PMS affiliate dashboard not migrated | Marketplace/affiliate plus finance vertical after WorkOS surface cutover. This cannot stay in PMS long term because affiliate identity, earnings, and payout settings are not PMS operations. |
| `GET /super-admin/bookings`, `GET /super-admin/affiliate-payouts`, `GET /super-admin/affiliate-payouts/{affiliate_id}`, `POST /super-admin/affiliate-payouts/{affiliate_id}/mark-paid`, `GET /platform-admin/growth`, `PATCH /platform-admin/properties/{property_id}/status`                             | VA        | Not migrated                                                      | Platform admin/finance/read-model vertical. Requires platform organization authorization and target admin read models.                                                                        |

## Migration vertical order

1. **Completed B1: Booking settings target repository**
   The add-on, guest-form, benefits, localization, and room-filter routes now
   always use the target settings read/write model. The source selector and
   runtime branch are retired. The legacy repository is now unreachable and
   remains only for the next deletion slice; `BOOKING_DATABASE_URL` is accepted
   but inert until the following configuration cleanup.

2. **Completed B2: Public profile and host resolution**
   Public profile and host-resolution reads use target hotel catalog/domain
   models. Custom-domain admin writes also use the target domain-verification
   route family.

3. **B3: Public bookability quote/calendar reads**
   Replace PMS rooms and unavailable-date proxying with target distribution
   read models. This is read-only but cutover-window sensitive because
   availability freshness and Channex mapping state affect guest search.

4. **B4: Booking checkout and guest lifecycle**
   Port create/confirm/status/lookup/cancel/withdraw/change-request/promo flows
   to Booking-owned target commands plus PMS reservation handoff. This gates
   staging rehearsal because guest booking writes cannot depend on legacy PMS.

5. **P1: PMS operations inventory and reservation reads**
   Port rooms, room types, calendar, room blocks, reservation list/detail, and
   assignments. Reads first, then writes that affect inventory/ARI. Contract
   artifact:
   [`PMS operations route contracts`](pms-operations-route-contracts.md).

6. **P2: PMS operational reservation commands**
   Port check-in/out, operational status, notes, additional guests, no-show,
   checklists, inspections, and checkout charges behind PMS-owned contracts.
   Contract artifact:
   [`PMS operations route contracts`](pms-operations-route-contracts.md).

7. **F1: Finance/payment/payout surfaces**
   Port payment settings, cancellation policy, invoices, payments, payouts,
   Stripe/Xendit onboarding, and reconciliation jobs. This includes stopping
   legacy scheduled payout dispatch and Xendit polling before target jobs are
   enabled.

8. **C1: Channex and webhook intake**
   Port Channex admin routes, provider webhooks, ARI sync, booking sync,
   webhook summaries, and messaging setup. This needs a coordinated cutover
   window because external providers retry and can replay events. It also owns
   legacy scheduler shutdown for Channex polling, full ARI sync, and rolling
   calendar auto-open. Cutover sequencing, replay/idempotency rules, rollback,
   and scheduler freeze ownership are defined in
   [`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md).

9. **A1: Affiliate dashboard and affiliate administration**
   Move public affiliate registration, affiliate dashboard, affiliate admin,
   commission, earnings, and payout settings to marketplace/affiliate and
   finance ownership.

10. **PL1: Platform admin, imports, media, and analytics**
    Replace platform/super-admin routes, import workflows, media upload routes,
    Booking dashboards, and telemetry with target read models, platform media,
    and jobs/events intake. Non-media platform admin, dashboard, import, and
    contact-intake scope is pinned in
    [`Platform admin, dashboard, and intake contract`](platform-admin-dashboard-intake-contract.md);
    platform media remains in the platform media track.

Auth routes (`/auth/*`) cut over on the WorkOS track and can run in parallel,
but no product vertical is considered rehearsal-ready until its frontend uses
the target AuthKit/RequestContext path or a documented compatibility bridge.

## Staging rehearsal gates

The staging rehearsal milestone is gated by these verticals:

- B1 through B4: Booking Web and Booking Admin must run without legacy Booking
  DB/PMS public API calls for settings, profile, quote, calendar, and guest
  lifecycle.
- P1 through P2: PMS Web must cover inventory, operational reservations,
  room assignment, check-in/out, notes, and guest operations from target data.
- F1: payment settings, invoices, payouts, and provider webhooks must be
  target-owned or explicitly frozen during rehearsal.
- C1 webhook/Channex intake: any external event source kept live during
  rehearsal must point at target idempotent intake; otherwise the rehearsal
  needs a documented provider freeze. Legacy scheduler jobs that touch Channex,
  payouts, booking expiry/cancellation, or calendar auto-open must be disabled
  or explicitly owned by the target runtime during the rehearsal.

## Immediate follow-up slices

1. **VAY follow-up: Delete the unreachable Booking settings legacy repository**
   - Scope: remove `createPgBookingSettingsReadRepository`, its
     `booking_hotels` SQL and legacy-only tests. Keep the inert
     `BOOKING_DATABASE_URL` setting for the immediately following configuration
     cleanup.

2. **VAY follow-up: Remove the inert Booking database configuration**
   - Scope: remove `BOOKING_DATABASE_URL` from config, tests, local scripts, and
     environment documentation after the dormant settings adapter is gone.

3. **VAY follow-up: Remove the public-bookability compatibility selector**
   - Scope: keep the existing target quote/calendar repositories and remove
     `PUBLIC_BOOKABILITY_SOURCE=legacy` plus its unavailable-quote branch.

4. **VAY follow-up: Remove the checkout-command compatibility selector**
   - Scope: keep the existing target Booking command adapter and remove
     `BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy` plus its unavailable branch.

5. **VAY follow-up: Define PMS operations route contracts for rooms, room
   types, calendar, and operational reservations**
   - Scope: contract docs and fixtures before implementation tickets. Accepted
     as [`PMS operations route contracts`](pms-operations-route-contracts.md).

6. **VAY follow-up: Define Channex/webhook cutover plan**
   - Scope: provider endpoint switch, idempotency keys, replay handling,
     rollback, scheduler disable/freeze controls, and freeze requirements.
   - Plan: [`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md).

## References

- `apps/booking-api/app/main.py` and `apps/booking-api/app/routers/**`.
- `apps/pms-api/app/main.py` and `apps/pms-api/app/routers/**`.
- `engineering/apps-api-legacy-runtime-dependency-audit.md`.
- `engineering/booking-pms-coupling-audit.md`.
- `engineering/booking-web-public-api-routing.md`.
- `engineering/pms-reservation-integration-contract.md`.
- `engineering/target-schema-ownership-map.md`.
