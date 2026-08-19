# apps/api legacy data-source adapter audit

_Updated 2026-08-19 after retiring the reservation legacy-database adapter._

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
- The only accepted legacy product database URL left in `ApiConfig` is
  `BOOKING_DATABASE_URL`. It feeds two distinct Booking DB readers described
  below.
- `apps/api` has no live legacy Python API client. The old Booking/PMS service
  URL names are rejected during configuration loading in every runtime.
- `API_RUNTIME=next` forbids `BOOKING_DATABASE_URL` and requires target profile,
  domain resolution, public bookability, Booking settings, Finance, and
  checkout sources. The target reservation route has no remaining source
  selector.

## Runtime inventory

| Configuration key                                                                           | Code entry point                                                                                                                                                                                                                                  | Old database/service used                                                                                                                                    | Route or user flow                                                                                                                       | Current next-runtime behavior                                                                                                                      | Safe to remove?                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed: `BOOKING_RESERVATIONS_READ_DATABASE_URL` plus `BOOKING_RESERVATIONS_SOURCE=legacy` | Removed `createCompatibilityPmsBookingReservationsReadRepository` in `src/routes/bookingReservations.ts`; `src/server.ts` now directly composes `createTargetBookingReservationsReadRepository` and `createTargetBookingDashboardMetricsReadPort` | Legacy `pms-api` database tables `bookings`, `room_types`, `rooms`, and `booking_rooms`                                                                      | Booking Admin `GET /api/booking/hotels/:hotelId/reservations`, including status/search pagination and assigned-room projection           | Always reads Booking, PMS operations, and Finance projections through `TARGET_DATABASE_URL`; route contract and authorization policy are unchanged | **Removed in this change.** The next runtime already required the target source.                                                                                                                                                 |
| `BOOKING_DATABASE_URL` with `PUBLIC_HOTEL_PROFILE_SOURCE=legacy`                            | `createPublicRuntimeRepositories` in `src/publicRuntime.ts` selects `createPgPublicHotelProfileRepository` in `src/routes/aiHotels.ts`                                                                                                            | Legacy `booking-api` database table `booking_hotels`                                                                                                         | Public AI hotel profile, Booking Web hotel profile, and Booking Web host/custom-domain resolution                                        | Unreachable: next forbids `BOOKING_DATABASE_URL` and requires `PUBLIC_HOTEL_PROFILE_SOURCE=target` or `active_publication`                         | **Yes for the next runtime**, but remove it in a separate profile cleanup. Keep the shared URL until the settings adapter below is also removed, and confirm no `API_RUNTIME=legacy` deployment is an intentional rollback path. |
| `BOOKING_DATABASE_URL` with `BOOKING_SETTINGS_SOURCE=legacy`                                | `src/server.ts` selects `createPgBookingSettingsReadRepository` in `src/routes/bookingSettings.ts`                                                                                                                                                | Legacy `booking-api` database table `booking_hotels`                                                                                                         | Booking Admin property, add-on, guest-form, benefits, localization, room-filter, design, and last-minute settings GET/PUT flows          | Unreachable: next forbids `BOOKING_DATABASE_URL` and requires `BOOKING_SETTINGS_SOURCE=target`                                                     | **Yes for the next runtime**, but use a separate settings cleanup because this adapter writes as well as reads and shares the URL with public profiles. Confirm no legacy runtime rollback remains before deleting it.           |
| `PUBLIC_BOOKABILITY_SOURCE=legacy`                                                          | `createPublicRuntimeRepositories` selects `createCompatibilityPublicHotelQuoteRepository` in `src/routes/aiHotelQuotes.ts`                                                                                                                        | No legacy service directly; it derives an unavailable quote from the selected profile repository, which can indirectly be the legacy Booking DB reader above | Public AI quote and Booking Web offers; the legacy mode does not mount a calendar repository                                             | Unreachable: next requires `PUBLIC_BOOKABILITY_SOURCE=target`                                                                                      | **Yes**, as a small follow-up that removes the legacy source value and unavailable-quote compatibility branch. It is left here because it is not required for reservation build coherence.                                       |
| `BOOKING_DOMAIN_RESOLUTION_SOURCE=legacy`                                                   | `findProfileForHost` in `src/routes/bookingWebPublic.ts`                                                                                                                                                                                          | No service directly; it delegates to the selected profile repository and can therefore indirectly use `BOOKING_DATABASE_URL`                                 | Booking Web `GET /api/booking-web/hosts/:host`                                                                                           | Unreachable: next requires `BOOKING_DOMAIN_RESOLUTION_SOURCE=target`                                                                               | **Yes**, preferably with the public-profile cleanup. The legacy and target branches both use `findProfileByCustomDomain`; removing the selector should be a narrow change.                                                       |
| `BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy`                                              | `src/server.ts` leaves `bookingWebCheckoutAdapter` undefined, so `registerBookingWebPublicRoutes` installs `createUnavailableBookingWebCheckoutAdapter`                                                                                           | None; there is no remaining legacy proxy or HTTP client                                                                                                      | Booking Web checkout, booking lookup/status, cancellation/change, payment instructions, and promo routes return the unavailable contract | Unreachable: next requires `BOOKING_CHECKOUT_COMMAND_SOURCE=target`                                                                                | **Yes after confirming legacy-runtime disabled behavior is not needed**, but it is a separate public write-surface cleanup, not a database-adapter removal.                                                                      |

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

## Smallest follow-up scope

Remove the remaining legacy Booking DB support in two ordered changes:

1. Remove `createPgPublicHotelProfileRepository` and the
   `PUBLIC_HOTEL_PROFILE_SOURCE=legacy` branch while retaining
   `BOOKING_DATABASE_URL` for settings.
2. Remove `createPgBookingSettingsReadRepository`,
   `BOOKING_SETTINGS_SOURCE=legacy`, and finally `BOOKING_DATABASE_URL`.

Then remove the no-service compatibility selectors
`PUBLIC_BOOKABILITY_SOURCE=legacy`, `BOOKING_DOMAIN_RESOLUTION_SOURCE=legacy`,
and `BOOKING_CHECKOUT_COMMAND_SOURCE=legacy_proxy` in separate, route-focused
changes. No additional adapter needs removal to keep this reservation cleanup
coherent.
