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

## What is deployed

| Piece              | Location                                                       |
| ------------------ | -------------------------------------------------------------- |
| Screen             | `apps/booking-admin/app/(app)/reservations/page.tsx` (VAY-704) |
| Typed client       | `apps/booking-admin/services/api/bookingReservationsClient.ts` |
| TypeScript route   | `apps/api/src/routes/bookingReservations.ts` (VAY-702/705)     |
| Runtime read model | `createTargetBookingReservationsReadRepository`                |

The reservations screen remains available at `/reservations` for contract
verification, but it is intentionally unlinked from Booking Admin navigation.
Hosts manage reservations in PMS.

## Route mapping

The screen's typed client calls, relative to `NEXT_PUBLIC_API_URL`:

```
GET {NEXT_PUBLIC_API_URL}/api/booking/hotels/:hotelId/reservations
```

For the migrated behavior, `NEXT_PUBLIC_API_URL` (booking-admin) **must** resolve
that path to the TypeScript backend (`apps/api`). The API always composes the
target reservation read model from `TARGET_DATABASE_URL`.

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

1. **Route mapping** — if a router/edge config was changed to send the contract
   path to `apps/api`, revert that mapping so the path is no longer routed to the
   TypeScript backend.
2. **Backend** — leaving `apps/api` deployed is safe; the route is read-only and
   has no side effects. No data migration to unwind.

Python remains the source of truth for all non-migrated booking surfaces
throughout.
