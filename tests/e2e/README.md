# Playwright E2E Pilot

This directory contains the Vayada Playwright pilot from VAY-545. It is a focused browser-smoke layer, not a replacement for build, lint, typecheck, or backend pytest.

## Commands

Run from the repo root:

```bash
npm run e2e                       # all specs
npm run e2e:landing
npm run e2e:booking-web
npm run e2e:affiliate-dashboard
npm run e2e:booking-admin
npm run e2e:marketplace-web
npm run e2e:pms-web
npm run e2e:vayada-admin
npm run e2e:headed
npm run e2e:ui
npm run e2e:report
```

By default local tests expect the apps to already be running through portless:

- `https://landing.localhost`
- `https://hotel-alpenrose.booking.localhost`
- `https://affiliate.localhost`
- `https://admin.booking.localhost`
- `https://marketplace.localhost`
- `https://pms.localhost`
- `https://admin.localhost`

To have Playwright start plain-port Next.js dev servers for all apps:

```bash
E2E_START_SERVERS=1 npm run e2e
```

Plain-port server mode uses:

- `http://127.0.0.1:3006` for landing
- `http://hotel-alpenrose.booking.localhost:3002` for booking-web
- `http://127.0.0.1:3005` for affiliate-dashboard
- `http://127.0.0.1:3003` for booking-admin
- `http://127.0.0.1:3000` for marketplace-web
- `http://127.0.0.1:3004` for pms-web
- `http://127.0.0.1:3001` for vayada-admin

Override URLs when needed:

```bash
E2E_LANDING_BASE_URL=http://localhost:3006 npm run e2e:landing
E2E_BOOKING_BASE_URL=http://hotel-alpenrose.localhost:3002 npm run e2e:booking-web
E2E_AFFILIATE_BASE_URL=http://localhost:3005 npm run e2e:affiliate-dashboard
E2E_BOOKING_ADMIN_BASE_URL=http://localhost:3003 npm run e2e:booking-admin
E2E_MARKETPLACE_BASE_URL=http://localhost:3000 npm run e2e:marketplace-web
E2E_PMS_BASE_URL=http://localhost:3004 npm run e2e:pms-web
E2E_VAYADA_ADMIN_BASE_URL=http://localhost:3001 npm run e2e:vayada-admin
```

## Booking Tenant Smoke

The booking-web pilot verifies tenant host routing with the seeded `hotel-alpenrose` slug. It mocks the browser-side hotel, room, add-on, and tracking API calls so the smoke test can prove the storefront shell and host-derived slug without requiring a full local database bootstrap.

When testing against a real seeded backend instead of the mocked smoke, start portless wildcard mode first:

```bash
portless proxy stop
portless proxy start --wildcard
cd apps/booking-web && portless
```

Then visit `https://hotel-alpenrose.booking.localhost`.

## GEO Validation

The `booking-web/geo-validation.spec.ts` suite validates the GEO (Generative Engine Optimization) contract introduced in VAY-664. It asserts:

- Public hotel pages emit parseable, required-field-complete JSON-LD (`Hotel` and `HotelRoom` nodes).
- HotelRoom JSON-LD nodes never include `offers` (pricing is served by the quote API).
- Private booking pages (`/book`, `/payment`, `/booking/*`, `/my-booking`) are excluded from search-engine indexing.
- The public sitemap does not include any private booking paths.
- The public AI profile/quote contract fixtures cover all required VAY-664 case IDs.

All network calls are mocked via `mockBookingApis`. No seeded backend is required for this suite.

## Auth App Smokes

The smoke tests for `affiliate-dashboard` and `vayada-admin` navigate to `/login` and verify the login shell renders without errors. AuthKit-backed product pages (`booking-admin`, `marketplace-web`, and `pms-web`) immediately redirect to hosted auth, so their smoke asserts the local redirect target and surface.

Focused next signup/register coverage is tagged `@signup`. It verifies PMS,
Booking Admin, and Marketplace creator/hotel entrypoints redirect to hosted
AuthKit signup with the expected surface and intent instead of rendering legacy
password signup. Vayada Admin keeps public registration closed and its smoke
asserts `/register` redirects back to login instead of creating a platform-admin
self-service signup.

```bash
npm run e2e -- \
  --project=marketplace-web-chromium \
  --project=pms-web-chromium \
  --project=booking-admin-chromium \
  --grep '@signup'
```

Use `E2E_START_SERVERS=1` with the same command when portless apps are not
already running.

The next-api hosted signup contract is covered by the focused AuthKit route
test. It verifies explicit surface/intent validation, signed callback state, and
that the public signup GET does not create a WorkOS organization before AuthKit
returns a user:

```bash
npm --workspace vayada-api run test -- src/authSession.test.ts
```

## Shared Hotel Setup Smoke

The focused first-run setup smoke lives in `tests/e2e/pms-web/setup.spec.ts`.
It enters through PMS at `/setup?entryProduct=pms&returnTo=/dashboard`, mocks an
empty shared hotel setup status, creates the first property under the resolved
hotel-group organization, and verifies the flow reaches product selection with
PMS preselected.

Run just that coverage from the repo root:

```bash
npm run e2e:pms-web -- tests/e2e/pms-web/setup.spec.ts
```

Use `E2E_START_SERVERS=1` with the same command when portless apps are not
already running.

## No Legacy Call Guard

Migrated next-stack specs can opt into `watchNoLegacyCalls(page, testInfo, surface)`
from `tests/e2e/support/noLegacyCalls.ts`. Each surface has a data-driven
banlist for legacy route shapes, hostnames, or headers. The guard records
browser requests and fails with the exact offending method and URL.

Currently covered surface:

- `booking-admin-benefits-settings` bans legacy production API hosts and
  `/admin/benefits`, plus `X-Hotel-Id` routing scope.

The booking-admin migrated surface specs require a production build:

```bash
cd apps/booking-admin && npm run build && PORT=3013 npx next start -p 3013 &
E2E_BOOKING_ADMIN_PROD=1 E2E_BOOKING_ADMIN_BASE_URL=http://127.0.0.1:3013 \
  npm run e2e:booking-admin -- tests/e2e/booking-admin/benefits.spec.ts
```

## Debugging

CI uploads `playwright-report/` and `test-results/` on every pilot run. Open the report locally with:

```bash
npm run e2e:report
```

Traces are retained on failure locally and on first retry in CI.

## Agent Guidance

Agents should report the exact browser flow they exercised. Starting a dev server alone is not browser validation.

Playwright Test is for committed regression coverage. For quick exploratory checks, prefer the Playwright CLI or Codex in-app browser. Reserve Playwright MCP for cases requiring deeper browser control, persistent state, or accessibility snapshots.
