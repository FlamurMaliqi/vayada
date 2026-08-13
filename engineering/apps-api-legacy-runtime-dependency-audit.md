# apps/api legacy runtime dependency audit

_VAY-760 decision record. Complements the route-surface inventory in
`booking-pms-route-migration-inventory.md` and the marketplace route order in
`marketplace-route-migration-inventory.md`._

## Decision

`apps/api` must reach the staging rehearsal with no runtime dependency on
legacy product databases or legacy Python APIs. Until then, the current
compatibility wiring remains acceptable only as a dark migration bridge:
contracts can be implemented behind the same HTTP shape, but activation waits
for the one-time legacy-to-target migration and cutover window.

`AUTH_LEGACY_MARKETPLACE_JWT_SECRET` is intentionally excluded from this audit.
Marketplace Web no longer requests a compatibility token; the remaining secret
supports Platform Admin's legacy handoff, whose retirement is owned by the
WorkOS/custom auth cutover. All other legacy product DB connection strings and
legacy product API URLs in `apps/api/src/config.ts` are in scope.
`BOOKING_HOST_BASE` and `MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS` are support
configuration for generated URLs/CORS and are not legacy runtime dependencies;
they can remain after the legacy DB/API removals if the target routes still
need those deployment-specific values.

## Runtime dependency inventory

| Config                                   | Current wiring                                                                                                                                                                                                                                                                                                 | Legacy owner                 | What breaks if legacy is off today                                                                                                                                                                                                                                                                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOKING_DATABASE_URL`                   | `createPgPublicHotelProfileRepository` reads `booking_hotels` for `/api/ai/hotels/:slug` and `/api/booking-web/hotels/:slug`; `findProfileByCustomDomain` is also used by host resolution.                                                                                                                     | `booking-api` DB             | Public AI profile routes and Booking Web hotel/profile routes stop mounting. Known booking subdomain host resolution can no longer find a profile; custom-domain fallback loses the only local lookup when `BOOKING_PUBLIC_API_URL` is absent.                                                             | Replace with target-schema public profile read repository fed by hotel catalog, booking, finance, and distribution projections.                                                                                                                                                                                                                                                                 |
| `BOOKING_DATABASE_URL`                   | `createPgBookingSettingsReadRepository` reads and writes `booking_hotels` columns for booking add-ons, guest-form, benefits, localization, and room-filter settings.                                                                                                                                           | `booking-api` DB             | Authenticated Booking settings GET/PUT routes fail or are not registered. Until cutover, legacy Booking/PMS UIs and guest flows can also miss settings because the TypeScript route writes only the legacy table.                                                                                          | Keep writes on legacy until the cutover write-freeze. Implement target settings read/write repository dark, then flip writes during cutover after migrated snapshot validation.                                                                                                                                                                                                                 |
| `BOOKING_RESERVATIONS_READ_DATABASE_URL` | `createCompatibilityPmsBookingReservationsReadRepository` reads PMS `bookings`, `room_types`, `rooms`, and `booking_rooms` for `/api/booking/hotels/:hotelId/reservations`.                                                                                                                                    | `pms-api` DB                 | Booking admin reservation list has no read model; status/search pagination and assigned-room projection disappear.                                                                                                                                                                                         | Replace with target booking reservation read model backed by booking/checkout and PMS operations schemas. Activate after reservation migration parity passes.                                                                                                                                                                                                                                   |
| `BOOKING_PUBLIC_API_URL`                 | Booking Web host resolution calls `/api/resolve-domain`; promo validation proxies `/api/hotels/:slug/validate-promo`. Booking Web telemetry no longer forwards to legacy `/api/events`; it uses the target event sink when `BOOKING_WEB_EVENT_SINK=target`.                                                    | `booking-api` Python service | Verified custom domains can no longer be resolved through legacy verification, and promo validation returns adapter failure. Booking Web dashboards must read target platform events for telemetry.                                                                                                        | Split by purpose: custom-domain resolution moves to target property/domain verification; promo validation moves to booking/checkout target rules. Telemetry forwarding is retired; keep `BOOKING_PUBLIC_API_URL` until B2/B4 remove the remaining domain and promo uses.                                                                                                                        |
| `PMS_PUBLIC_API_URL`                     | Public AI quote fetches `/api/hotels/:slug/rooms`; Booking Web calendar fetches `/api/hotels/:slug/unavailable-dates`; checkout adapter proxies payment settings, booking creation, booking lookup/status, guest cancel/withdraw/change-request flows, and affiliate public registration/check/connect routes. | `pms-api` public surface     | Public quote data becomes `unavailable_data`; Booking Web calendar returns empty unavailable dates; checkout config/status/lookup/affiliate routes fail; booking creation and guest command routes remain unavailable unless the explicit legacy command proxy flag is enabled and the legacy API is live. | Replace reads with target distribution/bookability projections. Replace checkout commands with booking/checkout command handlers plus PMS reservation handoff. Move affiliate registration/checks to marketplace/affiliate target ownership and Stripe Connect/onboarding to finance ownership; keep Booking Web only as the public compatibility facade while its referral modal remains live. |
| `PMS_API_URL`                            | `createHttpPmsGuestFormSettingsSync` PATCHes `/admin/guest-form-settings` after Booking guest-form settings writes.                                                                                                                                                                                            | `pms-api` admin surface      | Guest-form settings writes still update the legacy Booking DB, but PMS guest verification/check-in behavior can drift because the PMS copy is not synced.                                                                                                                                                  | Remove cross-service sync by making guest-form settings target-owned and consumed from the target read model by PMS/check-in flows after cutover. No runtime admin API call remains.                                                                                                                                                                                                            |

## Replacement order

1. **Public profile and Booking Web host read path** (`BOOKING_DATABASE_URL`).
   Replace `createPgPublicHotelProfileRepository` with a target public profile
   repository. This unblocks AI profile, Booking Web profile, and host
   resolution from the same canonical projection.

2. **Public quote, offers, and calendar reads** (`PMS_PUBLIC_API_URL` read
   calls).
   Replace PMS room/unavailable-date HTTP calls with target distribution and
   bookability read models. This must follow the public profile work because
   quote and calendar responses depend on canonical hotel slug, currency,
   locale, booking URL, and policy data.

3. **Booking settings target repository** (`BOOKING_DATABASE_URL` reads and
   writes).
   Implement target read/write ownership behind the existing contracts, but keep
   writes pointed at legacy until the cutover window because legacy services
   still read `booking_hotels`.

4. **Guest-form settings PMS sync removal** (`PMS_API_URL`).
   After target settings are the shared source, PMS guest-form/check-in flows
   must consume the target read model. The PATCH sync is then removed rather
   than redirected.

5. **Booking reservations read model** (`BOOKING_RESERVATIONS_READ_DATABASE_URL`).
   Replace the compatibility PMS query with a target reservation read repository.
   This depends on booking/checkout and PMS operations migration parity because
   the current projection joins booking, room type, room assignment, payment,
   add-on, and change/guest status fields.

6. **Booking Web checkout and guest commands** (`PMS_PUBLIC_API_URL` command
   calls).
   Move booking create, authorization confirmation, lookup/status, guest
   cancel/withdraw/change-request, and payment-instruction behavior into target
   booking/checkout handlers with PMS reservation handoff and audit/idempotency.
   This is the highest-risk write surface and should be activated only during
   the rehearsal-backed cutover sequence.

7. **Affiliate public Booking Web proxies** (`PMS_PUBLIC_API_URL` affiliate
   calls).
   VAY-768 decides ownership: marketplace/affiliate target services own public
   registration, email checks, referral identity, and lifecycle state; finance
   owns Stripe Connect/onboarding. Booking Web keeps only the public
   compatibility facade while its referral modal remains live.

8. **Booking public API leftovers** (`BOOKING_PUBLIC_API_URL` promo,
   custom-domain, telemetry).
   Replace promo/custom-domain behavior in the target services and retire the
   telemetry forwarder once platform event intake is the only dashboard source.
   VAY-769 retires only the telemetry bridge: Booking Web public telemetry and
   attribution clicks use `BOOKING_WEB_EVENT_SINK=target` with the auth DB event
   store configured, which persists dashboard events to `platform.domain_events` with matching
   `platform.product_audit_events`; `BOOKING_PUBLIC_API_URL` remains for
   custom-domain resolution and promo validation until the B2/B4 cutovers land.

## Cutover-day activation

Follow-up implementations must introduce or confirm these activation contracts
before legacy env vars are removed. Names below are proposed contract names;
implementation tickets can rename them, but each surface needs an explicit
target dependency or source switch plus a startup assertion.

Marketplace discovery is already active against `TARGET_DATABASE_URL`; the
former `MARKETPLACE_DATABASE_URL` dependency and source switch have been
removed.

| Surface                                         | Legacy config removed                                                       | Required target activation knob                                                                                                                                                                    | Startup assertion before cutover                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public hotel profile / Booking Web host profile | `BOOKING_DATABASE_URL` for profile reads                                    | `TARGET_DATABASE_URL` plus `PUBLIC_HOTEL_PROFILE_SOURCE=active_publication`; `target` remains the mutable compatibility source                                                                     | Every intended property has a valid active immutable Booking revision; `/api/ai/hotels/:slug`, `/api/booking-web/hotels/:slug`, and known-host resolution pass with `BOOKING_DATABASE_URL` unset.                                                                                                                                                                                         |
| Booking Web custom-domain resolution            | `BOOKING_PUBLIC_API_URL` for `/api/resolve-domain`                          | `TARGET_DATABASE_URL` plus `BOOKING_DOMAIN_RESOLUTION_SOURCE=target`                                                                                                                               | `/api/booking-web/hosts/:host` resolves verified custom domains without calling legacy Booking.                                                                                                                                                                                                                                                                                           |
| Public quote/offers/calendar reads              | `PMS_PUBLIC_API_URL` read calls                                             | `TARGET_DATABASE_URL` plus `PUBLIC_BOOKABILITY_SOURCE=target`                                                                                                                                      | `/api/ai/hotels/:slug/quote`, `/api/booking-web/hotels/:slug/offers`, and `/api/booking-web/hotels/:slug/calendar` return target freshness states with `PMS_PUBLIC_API_URL` unset.                                                                                                                                                                                                        |
| Booking settings                                | `BOOKING_DATABASE_URL` for settings reads/writes                            | `TARGET_DATABASE_URL` plus `BOOKING_SETTINGS_SOURCE=target`                                                                                                                                        | All `/api/booking/hotels/:hotelId/settings/*` GET/PUT routes mount and pass contract tests with `BOOKING_DATABASE_URL` unset.                                                                                                                                                                                                                                                             |
| Guest-form settings sync                        | `PMS_API_URL`                                                               | no replacement HTTP URL; PMS/check-in reads target settings through `TARGET_DATABASE_URL`                                                                                                          | Guest-form settings PUT succeeds and PMS guest-form behavior passes parity with `PMS_API_URL` unset.                                                                                                                                                                                                                                                                                      |
| Reservation list reads                          | `BOOKING_RESERVATIONS_READ_DATABASE_URL`                                    | `TARGET_DATABASE_URL` plus `BOOKING_RESERVATIONS_SOURCE=target`                                                                                                                                    | `/api/booking/hotels/:hotelId/reservations` mounts and passes migrated-snapshot parity with the PMS legacy DB URL unset.                                                                                                                                                                                                                                                                  |
| Booking Web checkout commands                   | `PMS_PUBLIC_API_URL`, `BOOKING_PUBLIC_API_URL`                              | `TARGET_DATABASE_URL` plus `BOOKING_CHECKOUT_COMMAND_SOURCE=target`                                                                                                                                | Booking create/confirm/status/lookup/cancel/withdraw/change-request/promo/payment-instruction routes pass parity with all legacy public API URLs unset.                                                                                                                                                                                                                                   |
| Booking Web affiliate routes                    | `PMS_PUBLIC_API_URL` affiliate calls and any legacy affiliate click handler | `TARGET_DATABASE_URL` plus `AFFILIATE_PUBLIC_SOURCE=target`, including `/api/booking-web/hotels/:slug/attribution/clicks`; route retirement flag only if the Booking Web referral modal is removed | Public affiliate routes mount against marketplace/affiliate plus finance target ownership, and `/api/booking-web/hotels/:slug/attribution/clicks` persists click-attribution events to the target event store with the legacy forwarding/handler disabled; or the routes return the accepted retired-contract response only after the public UI is removed, with no PMS proxy either way. |
| Booking telemetry forwarding                    | `BOOKING_PUBLIC_API_URL` for `/api/events`                                  | `AUTH_DATABASE_URL`/target event store plus explicit `BOOKING_WEB_EVENT_SINK=target`                                                                                                               | `/api/booking-web/events` and attribution click routes persist target events and make no legacy forwarding attempt.                                                                                                                                                                                                                                                                       |

The staging rehearsal should prove the same steps against a migrated snapshot
before production:

1. Deploy target-backed repositories and adapters dark with legacy env vars
   still configured.
2. Run the final legacy-to-target migration and parity checks.
3. Freeze or queue legacy writes for the cutover window.
4. Confirm the reviewed property cohort has valid active immutable Booking
   revisions, then set `PUBLIC_HOTEL_PROFILE_SOURCE=active_publication`; remove
   the public-profile use of `BOOKING_DATABASE_URL`.
5. Flip quote, offer, and calendar reads to target read models; remove read use
   of `PMS_PUBLIC_API_URL`.
6. Flip Booking settings writes to target after the final settings snapshot is
   migrated. Remove settings use of `BOOKING_DATABASE_URL`.
7. Point PMS/check-in consumers at target guest-form settings. Remove
   `PMS_API_URL` from `apps/api`.
8. Flip reservation list reads to the target repository. Remove
   `BOOKING_RESERVATIONS_READ_DATABASE_URL`.
9. Enable target checkout/guest command handlers. Remove remaining
   command-path use of `PMS_PUBLIC_API_URL`.
10. Flip or retire affiliate public routes and the remaining
    `BOOKING_PUBLIC_API_URL` promo/domain paths.
11. Start `apps/api` with no legacy product DB URLs and no legacy product API
    URLs configured. The app must still mount all accepted replacement
    contracts needed for frontend and public traffic.

### Immutable public profile flip notes

`PUBLIC_HOTEL_PROFILE_SOURCE=active_publication` is the immutable revision
activation switch. `target` intentionally retains the pre-existing mutable
`distribution.public_hotel_bookability_profiles` compatibility reader.

Before activation, verify every property in the rollout cohort has an active
pointer to a valid `booking-public-content.v1` revision and smoke canonical
slug, redirect slug, and verified custom-domain reads. A missing, malformed,
stale, non-bookable, revoked-domain, or unpointed revision fails closed.

For rollback, set `PUBLIC_HOTEL_PROFILE_SOURCE=target`; do not mutate or delete
the immutable revisions or active pointers. Reconcile the failing cohort, build
and activate corrected revisions, repeat the smoke checks, then re-enable
`active_publication`.

### Checkout command flip notes

`BOOKING_CHECKOUT_COMMAND_SOURCE=target` is a cutover-window switch, not a
normal canary. Turn it on only after the final booking/finance/PMS target
snapshot has passed parity and the legacy write-freeze is active for guest
booking creation, guest lifecycle changes, promo application changes, payment
state writes, and PMS reservation handoff writes.

Forward cutover:

1. Confirm `TARGET_DATABASE_URL` points at the migrated target database and
   `PMS_PUBLIC_API_URL` and `BOOKING_PUBLIC_API_URL` are absent from the
   rehearsal environment.
2. Set `BOOKING_CHECKOUT_COMMAND_SOURCE=target`.
3. Smoke the Booking Web public checkout command matrix: config, create,
   confirm authorization, status, lookup, withdraw, cancel preview, cancel,
   change preview, change submit/get, payment instructions, and promo validate.
4. Verify `platform.idempotency_keys`, `platform.product_audit_events`, and
   `platform.jobs` contain property-scoped rows for the exercised command
   paths. Create/cancel/change commands must enqueue PMS reservation handoff
   work rather than calling legacy PMS public routes.

Rollback:

1. Stop new guest checkout writes briefly or keep the write-freeze active while
   switching the source.
2. Set `BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy` and restore
   `PMS_PUBLIC_API_URL` and `BOOKING_PUBLIC_API_URL`.
3. Replay only target commands whose idempotency/audit rows show no completed
   PMS handoff job. Never replay a command that has a completed target
   idempotency row and a completed PMS handoff job without a manual duplicate
   booking review.
4. Leave target audit/idempotency rows intact for reconciliation; do not delete
   them during rollback.

## Follow-up implementation tickets

These scopes are ready to create once this decision record is accepted:

1. **Add target public hotel profile repository**
   - Replace `createPgPublicHotelProfileRepository` behind AI profile and
     Booking Web host/profile routes.
   - Validation: profile and host-resolution parity fixtures pass for known
     subdomain and custom-domain hotels.

2. **Add target public quote and calendar read repositories**
   - Replace PMS public rooms and unavailable-date calls with distribution
     read models.
   - Validation: public bookability fixtures cover available, sold-out,
     invalid request, stale data, and unavailable data cases.

3. **Add target Booking settings read/write repository**
   - Implement add-on, guest-form, benefits, localization, and room-filter
     settings against target schema behind the existing route contracts.
   - Validation: existing settings contract tests pass against target fixtures;
     cutover notes state when writes flip.

4. **Remove PMS guest-form settings sync**
   - Make PMS/check-in settings consumers read the target settings projection
     and delete `createHttpPmsGuestFormSettingsSync`.
   - Validation: guest-form settings write no longer depends on `PMS_API_URL`;
     PMS guest-form behavior has parity coverage.

5. **Add target Booking reservations read repository**
   - Replace the compatibility PMS SQL query with a target read model preserving
     current list filters and response fields.
   - Validation: reservation list contract tests pass against migrated snapshot
     fixtures, including room assignments and payment/add-on fields.

6. **Move Booking Web checkout commands to target handlers**
   - Implement checkout config, create, confirm authorization, status, lookup,
     withdraw, cancel, change-request, payment-instructions, and promo flows
     without `PMS_PUBLIC_API_URL` / `BOOKING_PUBLIC_API_URL`.
   - Validation: Booking Web public parity tests pass with the legacy command
     proxy disabled and no legacy public API URLs.

7. **Implement Booking Web affiliate route ownership**
   - Port check-email/register to target marketplace/affiliate ownership and
     Stripe Connect link creation to finance ownership behind
     `AFFILIATE_PUBLIC_SOURCE=target`; keep `/api/booking-web/hotels/:slug/attribution/clicks`
     on the target event sink in the same gate, and keep route retirement only
     for a later product decision that removes the Booking Web referral modal.
   - Validation: accepted owner has route contract tests, click attribution
     persists to the target event store with legacy forwarding disabled, and no
     PMS proxy remains.

8. **Retire remaining legacy Booking public domain bridge**
   - Replace `/api/resolve-domain` compatibility with target domain
     verification. VAY-769 already removed best-effort `/api/events`
     forwarding from Booking Web telemetry intake.
   - Validation: custom-domain host resolution and dashboard telemetry use
     target services only.
