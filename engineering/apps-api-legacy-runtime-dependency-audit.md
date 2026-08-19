# apps/api legacy data-source adapter audit

_Updated 2026-08-19 after removing the final legacy product database configuration._

## Scope

This audit covers `apps/api` runtime composition, source selectors, and code
that opens a legacy product database or calls a legacy product service. It does
not classify compatibility HTTP response shapes, migrated legacy fields inside
the target schema, or auth token handoffs as legacy data-source adapters.

The production next runtime is `API_RUNTIME=next`. Its startup guard requires
target sources and rejects legacy product runtime dependencies before server
composition.

## Result

- Reservation list reads now always use
  `createTargetBookingReservationsReadRepository` with `TARGET_DATABASE_URL`.
  The old PMS query, its source selector, its separate database URL, runtime
  wiring, and tests are removed.
- `BOOKING_DATABASE_URL` is removed from `ApiConfig`. Public profiles, Booking
  settings, and reservation reads all use `TARGET_DATABASE_URL`.
- Public profiles always use `TARGET_DATABASE_URL`, and Booking Web host
  resolution always delegates to that selected target profile repository.
- `apps/api` has no live legacy Python API client. The old Booking/PMS service
  URL names are rejected during configuration loading in every runtime.
- `API_RUNTIME=next` always resolves Booking Web hosts through the selected
  target profile repository and requires target public bookability, Finance,
  PMS operations, and checkout sources. Booking settings and reservation reads
  no longer have source selectors.

## Runtime inventory

| Configuration key                                                                           | Code entry point                                                                                                                                                                                | Old database/service used                                                               | Route or user flow                                                                                                                       | Current next-runtime behavior                                                                                                                                                                                 | Safe to remove?                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed: `BOOKING_RESERVATIONS_READ_DATABASE_URL` plus `BOOKING_RESERVATIONS_SOURCE=legacy` | Removed `createCompatibilityPmsBookingReservationsReadRepository` in `src/routes/bookingReservations.ts`; `src/server.ts` now directly composes `createTargetBookingReservationsReadRepository` | Legacy `pms-api` database tables `bookings`, `room_types`, `rooms`, and `booking_rooms` | Booking Admin `GET /api/booking/hotels/:hotelId/reservations`, including status/search pagination and assigned-room projection           | Always reads Booking, PMS operations, and Finance projections through `TARGET_DATABASE_URL`; route contract and authorization policy are unchanged. Target dashboard metrics remain gated to the next runtime | **Removed in this change.** The next runtime already required the target source.                                                                            |
| Removed: `PUBLIC_HOTEL_PROFILE_SOURCE=legacy` and its `BOOKING_DATABASE_URL` reader         | `createPublicRuntimeRepositories` now selects only `createTargetPublicHotelProfileRepository` or `createActiveBookingPublicationProfileRepository`                                              | None; both implementations use `TARGET_DATABASE_URL`                                    | Public AI hotel profile and Booking Web hotel profile                                                                                    | Always target-backed; `PUBLIC_HOTEL_PROFILE_SOURCE` accepts only `target` or `active_publication`.                                                                                                            | **Removed.** `createPgPublicHotelProfileRepository`, its `booking_hotels` queries, and the obsolete database URL are deleted.                               |
| Removed: legacy Booking settings adapter, source selector, and `BOOKING_DATABASE_URL`       | `src/server.ts` directly composes `createPgTargetBookingSettingsRepository` in `src/routes/bookingSettings.ts`                                                                                  | None                                                                                    | Booking Admin property, add-on, guest-form, benefits, localization, room-filter, design, and last-minute settings GET/PUT flows          | Always reads and writes `booking.booking_settings`; route contracts and authorization policies are unchanged.                                                                                                 | **Removed.** No legacy Booking product database configuration remains in `apps/api`.                                                                        |
| `PUBLIC_BOOKABILITY_SOURCE=legacy`                                                          | `createPublicRuntimeRepositories` selects `createCompatibilityPublicHotelQuoteRepository` in `src/routes/aiHotelQuotes.ts`                                                                      | None; it derives an unavailable quote from the selected target profile repository       | Public AI quote and Booking Web offers; the legacy mode does not mount a calendar repository                                             | Unreachable: next requires `PUBLIC_BOOKABILITY_SOURCE=target`                                                                                                                                                 | **Yes**, as a small follow-up that removes the legacy source value and unavailable-quote compatibility branch.                                              |
| Removed: `BOOKING_DOMAIN_RESOLUTION_SOURCE=legacy`                                          | `findProfileForHost` in `src/routes/bookingWebPublic.ts` directly uses the selected profile repository                                                                                          | None                                                                                    | Booking Web `GET /api/booking-web/hosts/:host`                                                                                           | Known booking hosts resolve by slug; other hosts resolve through `findProfileByCustomDomain` on the target profile repository.                                                                                | **Removed with the profile cleanup.** The duplicate legacy/target branches had the same repository behavior.                                                |
| `BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy`                                              | `src/server.ts` leaves `bookingWebCheckoutAdapter` undefined, so `registerBookingWebPublicRoutes` installs `createUnavailableBookingWebCheckoutAdapter`                                         | None; there is no remaining legacy proxy or HTTP client                                 | Booking Web checkout, booking lookup/status, cancellation/change, payment instructions, and promo routes return the unavailable contract | Unreachable: next requires `BOOKING_CHECKOUT_COMMAND_SOURCE=target`                                                                                                                                           | **Yes after confirming legacy-runtime disabled behavior is not needed**, but it is a separate public write-surface cleanup, not a database-adapter removal. |

## Rejected legacy service configuration

These names do not select adapters. `assertRemovedLegacyPythonIntegrationEnv`
rejects them before runtime composition, including outside the next runtime.
Keeping the guard is useful because it detects stale deployment configuration.

| Configuration key        | Guard entry point                                            | Old service                                 | Route/user flow today          | Next-runtime behavior                         | Safe to remove?                                                         |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `BOOKING_PUBLIC_API_URL` | `assertRemovedLegacyPythonIntegrationEnv` in `src/config.ts` | Legacy `booking-api` HTTP service           | None; no client is constructed | Boot fails with the removed-integration error | **Do not remove the guard yet**; remove the stale deployment env first. |
| `PMS_API_URL`            | Same guard                                                   | Legacy authenticated `pms-api` HTTP service | None; no client is constructed | Boot fails with the removed-integration error | **Do not remove the guard yet**; remove the stale deployment env first. |
| `PMS_PUBLIC_API_URL`     | Same guard                                                   | Legacy public `pms-api` HTTP service        | None; no client is constructed | Boot fails with the removed-integration error | **Do not remove the guard yet**; remove the stale deployment env first. |

## Deliberate exclusions

- `AUTH_LEGACY_*_JWT_SECRET` values mint compatibility tokens for old
  frontends; they do not read a legacy product database or call a product
  service.
- `registerPmsFinanceCompatibilityRoutes`, legacy-shaped Booking settings
  payloads, and other compatibility route contracts use target repositories or
  preserve HTTP shapes. They are not legacy data-source adapters.
- Target-schema code that reads migrated fields labelled `legacy`, source-link
  rows for old product IDs, or immutable/mutable target projections remains
  target runtime code.
- `FINANCE_SOURCE=legacy`, `PMS_OPERATIONS_SOURCE=disabled`, and
  `API_RUNTIME=legacy` can disable target surfaces, but do not by themselves
  construct a legacy database or service client.

## Deployment and rollback evidence

- `.github/workflows/deploy-next-api.yml` is the only workflow that builds and
  publishes `apps/api`; it passes `API_RUNTIME=next` as a Docker build argument
  and dispatches the image to the `next-target-backend` service.
- `apps/api/Dockerfile` bakes that argument into the runtime image. No repository
  workflow publishes an `apps/api` image with `API_RUNTIME=legacy`.
- Canonical rollback remains the separately deployed Python APIs documented in
  `engineering/monorepo-deploy-workflows.md`; `apps/api` legacy mode is not an
  intentional deployment rollback lane.

## Smallest follow-up scope

Remove the remaining no-service compatibility selectors
`PUBLIC_BOOKABILITY_SOURCE=legacy` and
`BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy` in separate, route-focused
changes. The domain-resolution selector was removed with the profile reader.
