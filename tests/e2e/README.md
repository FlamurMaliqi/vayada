# Playwright E2E Pilot

This directory contains the Vayada Playwright pilot from VAY-545. It is a focused browser-smoke layer, not a replacement for build, lint, typecheck, or backend pytest.

## Commands

Run from the repo root:

```bash
npm run e2e                       # all specs
npm run e2e:landing
npm run e2e:booking-web
npm run e2e:booking-public-canary
npm run e2e:affiliate-dashboard
npm run e2e:booking-admin
npm run e2e:marketplace-web
npm run e2e:pms-web
npm run e2e:vayada-admin
npm run e2e:next-stack-smoke
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

## Deployed Next-stack Smoke

`npm run e2e:next-stack-smoke` is the production-safe browser and API smoke for
the deployed TypeScript stack. It creates unique synthetic WorkOS identities,
completes fresh hotel and creator onboarding, verifies Marketplace-to-PMS and
Marketplace-to-Booking-Admin handoffs, publishes a direct-booking property, and
exercises both instant and request acceptance with a pay-at-property quote.

The command is guarded: it accepts only the fixed `next-*.vayada.com` origins
and requires `NEXT_STACK_SMOKE_ENV=next`. The deployed next API shares the live
WorkOS tenant, so live-key use additionally requires
`NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS=1`; the manual workflow uses the exact
deployed key from its protected `next-smoke` environment secret. The smoke never
configures card, wallet, Stripe, or Xendit checkout. Run it through the manual
`Next-stack onboarding and checkout smoke` workflow, whose `next-smoke` GitHub
environment isolates the password and email-domain settings, or locally with
the same variables:

```bash
E2E_NEXT_STACK_SMOKE=1 \
NEXT_STACK_SMOKE_ENV=next \
NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS=1 \
NEXT_STACK_SMOKE_EMAIL_DOMAIN=smoke.example.test \
NEXT_STACK_SMOKE_PASSWORD='<staging-password>' \
WORKOS_API_KEY='<key used by deployed next-api>' \
npm run e2e:next-stack-smoke
```

The `next-smoke` environment accepts reviewed `main` runs only, releases its secrets only after
FlamurMaliqi approves the deployment, and does not let administrators bypass that approval. Each run
creates a temporary Platform Admin for the production lifecycle command. Cleanup restores inventory
and disables public offers, reauthenticates the temporary admin to retire the synthetic property,
then deletes its membership and user. If retirement fails, cleanup reports `recovery_run_id`,
`recovery_property_id`, and a signed `recovery_receipt` while still deleting the temporary admin.
Supply all three values to a later protected workflow run; the receipt binds recovery to that exact
synthetic property. Recovery creates a fresh temporary admin, retires the property, and deletes the
recovery admin. It reuses the signed run identity, so rerunning the same recovery also cleans up an
admin left by an interrupted recovery.

Cleanup runs even after a failed assertion. It cancels or withdraws every
synthetic booking, changes the synthetic property to the non-checkout `other`
payment method and waits until public quotes disappear, then deletes the
WorkOS staging organizations and users. Target database rows and product audit
events are deliberately retained for traceability, but the property is left
unbookable and inventory is restored. A cleanup failure fails the workflow.

Real card payments are intentionally outside this command. Stripe coverage must
use a separate test-mode-only environment and test payment methods; do not add a
live Stripe key or card-capable payment method to this workflow.

The next-stack Playwright project disables traces, automatic screenshots, and
video because its browser and API flows handle live smoke credentials. Secret
form values use a non-value-bearing Playwright step, and the workflow inspects
the completed HTML report and test-results payload for the configured smoke
password and WorkOS key before allowing upload. Non-secret step names, errors,
and explicit acceptance screenshots remain available. Evidence is retained for
7 days.

Retention changes only affect new artifacts. Existing
`next-stack-smoke-evidence` artifacts created before VAY-1302 are not rewritten;
delete them from the repository's Actions artifacts page or with the GitHub
Actions Artifacts API. Rotate `NEXT_STACK_SMOKE_PASSWORD` after removing those
artifacts, and rotate the WorkOS key too if inspection ever finds it in retained
evidence.

## Deployed Booking Public Canary

`npm run e2e:booking-public-canary` is the unmocked public Booking verification.
It checks public host resolution, the public-bookability profile, and the
rendered tenant page, plus the deployed build SHA when one is supplied. The
`Next Booking public canary` workflow runs every 15 minutes and on manual
dispatch. The platform deployment workflow performs the build-specific
post-deploy check after ECS finishes its cutover; the scheduled workflow
deliberately does not trigger from the earlier image publish step. Repository
variables supply `NEXT_BOOKING_CANARY_URL` and
`NEXT_BOOKING_CANARY_NAME`; the URL must identify a dedicated published tenant
on `*.next-booking.vayada.com`. They are non-secret so scheduled checks can run
without an environment approval gate.

Run it locally against the same canary with:

```bash
E2E_BOOKING_PUBLIC_CANARY=1 \
BOOKING_PUBLIC_CANARY_URL=https://<slug>.next-booking.vayada.com \
BOOKING_PUBLIC_CANARY_NAME='<expected hotel name>' \
npm run e2e:booking-public-canary
```

Server mode starts only the Next.js frontends on ports 3000-3006. It does not
start `apps/api` on 8003 or the legacy FastAPI APIs on 8000-8002. Current smokes
either mock backend calls or assert local AuthKit redirects; for real backend
flows, start `npm run dev:workos-local` first and leave `E2E_START_SERVERS`
unset.

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

The smoke tests for `affiliate-dashboard`, `booking-admin`, `pms-web`, and
`vayada-admin` navigate to `/login` and verify the custom password login shell
renders without errors. Marketplace smoke covers its custom auth routes
separately.

Focused next signup coverage is tagged `@signup`. It verifies PMS, Booking
Admin, and Marketplace creator/hotel `/signup` entrypoints render custom signup
forms instead of redirecting to hosted AuthKit. Vayada Admin keeps public
registration closed and its smoke asserts `/register` redirects back to login
instead of creating a platform-admin self-service signup.

```bash
npm run e2e -- \
  --project=marketplace-web-chromium \
  --project=pms-web-chromium \
  --project=booking-admin-chromium \
  --grep '@signup'
```

Use `E2E_START_SERVERS=1` with the same command when portless apps are not
already running.

The next-api auth route test asserts the old hosted AuthKit GET routes remain
unexposed and covers the custom password login/signup/session contracts:

```bash
npm --workspace vayada-api run test -- src/authSession.test.ts
```

## First-Party Auth Regressions

`tests/e2e/first-party-auth` is the focused regression suite for the five
migrated browser surfaces. It covers password login, signup and recovery where
available, session refresh, CSRF, logout, app-local Google callback state,
Marketplace signup-to-onboarding, cross-app handoff, stale-cookie cleanup, and
production routing guards. Chromium runs with third-party-cookie phaseout
enabled, and the browser flows assert that auth requests and cookies stay on
the current frontend origin.

Run against the full portless stack:

```bash
npm run dev:workos-local
npm run e2e:first-party-auth
```

Run with isolated plain-port frontend servers and mocked auth responses:

```bash
E2E_FIRST_PARTY_AUTH_ONLY=1 E2E_START_SERVERS=1 npm run e2e:first-party-auth
```

The PR workflow runs the isolated browser suite plus every frontend gateway
unit test. Those unit tests lock down multiple `Set-Cookie` values,
`Cache-Control: private, no-store`, `Vary: Cookie`, redirect status and
`Location`, and the request/response header allowlists. Real WorkOS and Google
credentials are never stored in the repository or Playwright artifacts.

The deterministic Google cases simulate the external redirect while exercising
the real frontend login/signup code and exact app-local callback shape. For a
live WorkOS sandbox check, first start `npm run dev:workos-local` with staging
WorkOS credentials in `apps/api/.env`. In a second terminal, resolve the same
worktree-qualified Marketplace origin and pass it to Playwright:

```bash
E2E_MARKETPLACE_BASE_URL="$(portless get marketplace)" \
  E2E_WORKOS_SANDBOX_GOOGLE=1 npm run e2e:first-party-auth:live -- --headed
```

Complete Google sign-in in the headed browser with a sandbox-only account. The
test waits for the callback and verifies `/auth/session` returns 200 instead of
`missing_session`. The dedicated live project disables traces, screenshots, and
video so provider credentials and session material are not retained in test
artifacts.

WorkOS must register `<origin returned by portless get>/auth/oauth/google/callback`
for the active worktree. For a canonical root checkout, the five exact callback
URIs are:

```text
https://marketplace.localhost/auth/oauth/google/callback
https://admin.booking.localhost/auth/oauth/google/callback
https://pms.localhost/auth/oauth/google/callback
https://affiliate.localhost/auth/oauth/google/callback
https://admin.localhost/auth/oauth/google/callback
```

Google account interaction remains intentionally manual because provider login
challenges are not stable or appropriate for unattended CI. The callback,
cookie, state, session, and `missing_session` regression assertions remain
automated.

## Shared Hotel Setup Smoke

The focused first-run setup smoke lives in `tests/e2e/pms-web/setup.spec.ts`.
It enters through PMS at `/setup?entryProduct=pms&returnTo=/dashboard`, mocks an
empty shared hotel setup status, creates the first property under the resolved
hotel-group organization, and verifies the flow selects a setup track before
creating the property. The Hotel Operations track enables PMS and Booking
Engine together; after track selection, the smoke verifies the adaptive,
property-scoped setup plan only shows tasks for the selected track.

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

Open the HTML report after a local run with:

```bash
npm run e2e:report
```

Traces are retained on failure.

## Agent Guidance

Agents should report the exact browser flow they exercised. Starting a dev server alone is not browser validation.

Playwright Test is for committed regression coverage. For quick exploratory checks, prefer the Playwright CLI or Codex in-app browser. Reserve Playwright MCP for cases requiring deeper browser control, persistent state, or accessibility snapshots.
