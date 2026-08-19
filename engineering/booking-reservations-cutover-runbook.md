# Booking reservations cutover runbook

Operational runbook for exposing the booking-admin **reservations** surface,
the first frontend/backend vertical migrated to the TypeScript backend
(`apps/api`). It complements
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md)
and the [`BookingReservationList`](booking-reservation-list-contract.md)
contract.

This surface is migrated per
[`frontend-backend-contract-migration.md` § Cutover Model](frontend-backend-contract-migration.md):
cut over one surface at a time while Python keeps serving everything else.

## What ships behind the flag

| Piece              | Location                                                       |
| ------------------ | -------------------------------------------------------------- |
| Screen             | `apps/booking-admin/app/(app)/reservations/page.tsx` (VAY-704) |
| Typed client       | `apps/booking-admin/services/api/bookingReservationsClient.ts` |
| Sidebar nav link   | `apps/booking-admin/components/layout/Sidebar.tsx`             |
| TypeScript route   | `apps/api/src/routes/bookingReservations.ts` (VAY-702/705)     |
| Runtime read model | `createTargetBookingReservationsReadRepository`                |

## Feature flag

| Field   | Value                                                     |
| ------- | --------------------------------------------------------- |
| Name    | `NEXT_PUBLIC_BOOKING_RESERVATIONS_ENABLED`                |
| Read at | booking-admin **build time** (`NEXT_PUBLIC_*` is inlined) |
| Default | unset / `false` — sidebar link hidden                     |

`NEXT_PUBLIC_*` values are inlined when booking-admin is built, so toggling the
flag requires a rebuild/redeploy of booking-admin, not just an env change on a
running container.

The flag is a **manual build-time toggle that is not coupled to runtime
reachability** — nothing in the code checks that the TypeScript route is actually
serving the contract before showing the link. "Enable only when reachable" is an
operator rule enforced by the checklist below, not an automatic invariant. If the
flag is enabled before the route is reachable, the link appears and the screen
renders the typed client's error states.

## Route mapping

The screen's typed client calls, relative to `NEXT_PUBLIC_API_URL`:

```
GET {NEXT_PUBLIC_API_URL}/api/booking/hotels/:hotelId/reservations
```

For the migrated behavior, `NEXT_PUBLIC_API_URL` (booking-admin) **must** resolve
that path to the TypeScript backend (`apps/api`). The API always composes the
target reservation read model from `TARGET_DATABASE_URL`.

## Enable conditions (all must hold)

Only set `NEXT_PUBLIC_BOOKING_RESERVATIONS_ENABLED=true` in an environment where:

1. `apps/api` is deployed and reachable.
2. `apps/api` has its required `TARGET_DATABASE_URL`, so
   `/api/booking/hotels/:hotelId/reservations` returns the target-backed contract.
3. booking-admin's `NEXT_PUBLIC_API_URL` routes that path to `apps/api`.

If the flag is enabled while any condition is false, the sidebar link appears but
the screen surfaces the typed client error states (401/403 or
`read_model_unavailable`) instead of a reservation list.

## Verification

- Backend route contract + denial matrix: `cd apps/api && npm test`.
- Frontend build/lint/typecheck: `cd apps/booking-admin && npm run build && npm run lint && npm run typecheck`.
- Browser smoke: `tests/e2e/booking-admin/reservations.spec.ts` drives the
  reservations screen and asserts it issues a `GET` to the **real contract
  pathname** `/api/booking/hotels/:hotelId/reservations` (the configured route,
  not a fabricated mock endpoint) and renders the product list shape. The
  backend _response_ is fulfilled with a fixture so the test is hermetic — it
  proves the screen targets the contract route, not that a live `apps/api`
  answers. End-to-end verification against a running `apps/api` + read model is a
  separate manual/integration step.

  The authenticated `(app)` shell only hydrates in a production build, so the
  spec is gated behind `E2E_BOOKING_ADMIN_PROD`; the default dev e2e run
  (`E2E_START_SERVERS=1 npm run e2e:booking-admin`) skips it. **This smoke is
  therefore manual-only today — it is not yet in an automated CI gate** (CI runs
  booking-admin via `next dev`, which does not hydrate the shell here; a
  follow-up should run booking-admin e2e against a production build). Run it
  locally against a production booking-admin server:

  ```bash
  cd apps/booking-admin && npm run build && PORT=3013 npx next start -p 3013 &
  E2E_BOOKING_ADMIN_PROD=1 E2E_BOOKING_ADMIN_BASE_URL=http://127.0.0.1:3013 \
    npm run e2e:booking-admin
  ```

## Rollback

Reservations is additive and read-only; rollback is low-risk and does not touch
Python booking surfaces.

1. **Fastest** — set `NEXT_PUBLIC_BOOKING_RESERVATIONS_ENABLED=false` (or unset)
   and rebuild/redeploy booking-admin. The sidebar link disappears; the
   `/reservations` route remains built but is unlinked.
2. **Route mapping** — if a router/edge config was changed to send the contract
   path to `apps/api`, revert that mapping so the path is no longer routed to the
   TypeScript backend.
3. **Backend** — leaving `apps/api` deployed is safe; the route is read-only and
   has no side effects. No data migration to unwind.

Python remains the source of truth for all non-migrated booking surfaces
throughout, so disabling the flag fully restores the pre-cutover booking-admin.
