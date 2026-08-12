# WorkOS browser session transport

_VAY-1194 decision record. WorkOS documentation checked on 2026-08-07._

## Decision

Serve browser-facing `/auth/*` routes through each authenticated frontend's own
origin. Each Next.js application acts as a narrow auth gateway to `apps/api`;
it does not become an authentication authority.

```text
browser
  -> https://<frontend-origin>/auth/*
  -> frontend server auth gateway
  -> apps/api /auth/*
  -> WorkOS AuthKit
```

WorkOS remains the authority for authentication and provider sessions.
`apps/api` remains the only Vayada service that calls WorkOS management APIs,
seals or refreshes WorkOS sessions, validates product intent, resolves internal
identity, and applies CSRF checks. The frontend gateway only transports the
request and a deliberately small response-header set.

This is an application-local gateway/BFF boundary, not a general reverse proxy:

- browser auth clients always use the relative `/auth/*` path;
- ordinary `/api/*`, media, legacy, and target-domain clients keep their current
  backend origins;
- `NEXT_PUBLIC_AUTH_API_URL` must not be repointed to a frontend origin because
  existing non-auth clients also use it;
- no WorkOS API key, refresh token, sealed session value, or internal proxy
  header is exposed to browser JavaScript.

## Why

The current local browser path sends auth requests from frontend hosts such as
`marketplace.localhost` to `api.localhost`. When the browser does not accept or
send that cross-site cookie, password signup reaches onboarding without the
matching CSRF cookie (`csrf_rejected`), and the Google callback cannot restore
the sealed session (`missing_session`).

The first-party route makes the cookie owner and the page owner the same host.
It also matches the shape recommended by WorkOS's Next.js integration: the app
owns its callback/session route, cookies are host-only by default,
`SameSite=Lax` is the default, and `SameSite=None` is reserved for architectures
that genuinely require cross-origin cookies.

## Frontend gateway contract

Each authenticated frontend implements one Node-runtime catch-all route for
`/auth/*`. A route handler is preferred over a blind rewrite because the
gateway must construct trusted forwarding metadata and control which response
headers reach the browser.

### Configuration

Every frontend service receives server-only configuration:

| Setting                        | Contract                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_GATEWAY_UPSTREAM_ORIGIN` | Absolute `apps/api` origin. No credentials, query, fragment, or user-controlled value. Prefer private service DNS in deployed environments and `http://127.0.0.1:8003` locally. |
| `AUTH_PUBLIC_ORIGIN`           | Exact external origin for this frontend, including a non-default review port. It is the only accepted browser origin for unsafe auth requests.                                  |

The browser base is the literal relative path `/auth`; it is not a public
origin environment variable. Unit tests may inject a fetch implementation, but
production browser code must not construct auth URLs from
`NEXT_PUBLIC_AUTH_API_URL`.

`apps/api` receives an explicit surface-to-origin map rather than deriving a
callback origin from arbitrary forwarded headers:

| Surface               | Origin setting                    |
| --------------------- | --------------------------------- |
| `platform-admin`      | `AUTH_PLATFORM_ADMIN_ORIGIN`      |
| `marketplace-web`     | `AUTH_MARKETPLACE_WEB_ORIGIN`     |
| `booking-admin`       | `AUTH_BOOKING_ADMIN_ORIGIN`       |
| `pms-web`             | `AUTH_PMS_WEB_ORIGIN`             |
| `affiliate-dashboard` | `AUTH_AFFILIATE_DASHBOARD_ORIGIN` |

`AUTH_FIRST_PARTY_SURFACES` is a comma-separated rollout list. A surface in
that list uses the first-party callback and cookie policy. A surface outside it
uses the exact API origin in `AUTH_COMPATIBILITY_CALLBACK_ORIGIN` and may retain
the temporary cross-origin cookie policy until its own ticket is deployed. The
backend never derives either callback from forwarded headers. Remove both
compatibility settings after all surfaces pass VAY-1203.

`AUTH_ALLOWED_ORIGINS` remains the backend CSRF/CORS allowlist and must contain
the configured surface origins. Active first-party cookies never include an
`AUTH_COOKIE_DOMAIN`. During migration, retain the previous value only long
enough for the backend to expire legacy Domain-scoped cookies alongside the new
host-only cookies, then unset it after the cleanup window.

### Request rules

The gateway:

1. accepts only the `/auth/*` namespace and the methods implemented by
   `apps/api`;
2. builds the upstream URL from `AUTH_GATEWAY_UPSTREAM_ORIGIN` plus the
   normalized path and query, never from a request-supplied upstream;
3. forwards the request method, query, body, `Cookie`, `Origin`,
   `x-vayada-csrf`, content negotiation, and request-correlation metadata;
4. removes hop-by-hop headers, incoming `Host`, incoming `x-forwarded-*`, and
   any client-supplied internal/WorkOS headers;
5. sets forwarded protocol and host from `AUTH_PUBLIC_ORIGIN`, not from the
   incoming forwarded-header chain;
6. rejects unsafe-method requests whose `Origin` does not exactly equal
   `AUTH_PUBLIC_ORIGIN`;
7. does not follow upstream redirects server-side.

`apps/api` treats the forwarded host/protocol as consistency evidence only.
The signed OAuth state and the configured surface-origin map remain the
authority for the callback and post-auth destination.

### Response rules

The gateway preserves the upstream status and body. It forwards only response
headers required by the auth contract:

- every `Set-Cookie` value, appended separately;
- `Content-Type`;
- `Location` for backend-generated WorkOS or validated app redirects;
- `Cache-Control`, forced to at least `private, no-store`;
- merged `Vary` values, including `Cookie` when a session affects the result;
- `WWW-Authenticate`, `Retry-After`, and the public request/correlation ID when
  present.

It strips hop-by-hop headers, CORS headers that are unnecessary on the
same-origin browser hop, server/framework disclosure headers, and all
unrecognized `x-workos-*` or internal headers. Auth responses are never stored
by the Next.js data cache, a CDN, or a shared proxy.

Redirects keep the upstream status. POST/PUT flows that deliberately convert to
GET use `303`; OAuth navigation GETs may use `302`, `303`, or `307` according to
the backend contract. User-controlled redirect values are never passed through
without the backend's surface-specific origin and safe-path validation.

## Cookie and CSRF contract

First-party surfaces use host-only cookies:

| Cookie                 | Attributes                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| WorkOS sealed session  | `HttpOnly; Secure; SameSite=Lax; Path=/auth`; no `Domain`                 |
| OAuth state / verifier | `HttpOnly; Secure; SameSite=Lax; Path=/auth`; short lifetime; no `Domain` |
| Vayada CSRF cookie     | `HttpOnly; Secure; SameSite=Lax; Path=/auth`; no `Domain`                 |

First-party cookies use a distinct `vayada_fp_*` name family. Compatibility
surfaces retain the existing names, so a later compatibility login cannot win
through ambiguous browser cookie ordering. First-party responses also expire
the legacy host-only and configured Domain-scoped names during migration.

Plain HTTP localhost fallback omits `Secure`; portless and every deployed
environment use HTTPS and require it. `SameSite=None` is not used by a
first-party surface. Any future embedded or cross-site flow that requires it
needs a separate security decision and must retain `Secure`.

`SameSite=Lax` is defense in depth, not a replacement for the existing CSRF
contract. Unsafe auth requests still require:

- an exact allowed `Origin`;
- a matching `x-vayada-csrf` header and CSRF cookie;
- a surface allowed to perform the requested operation.

Browser clients obtain the CSRF header value from the authenticated JSON
response and keep it in memory; they do not read the cookie. VAY-1196 must make
every session-establishing or session-refreshing response return that value
before changing the current non-`HttpOnly` compatibility cookie.

The OAuth state/verifier cookie must be written on the same frontend origin
that receives `/auth/oauth/google/callback`. The callback fails closed if the
cookie is missing or does not match the signed URL state; there is no
URL-state-only fallback.

## OAuth callback and return URLs

For a surface with configured origin `<origin>`, the only Google callback is:

```text
<origin>/auth/oauth/google/callback
```

`apps/api` selects `<origin>` from the validated surface at OAuth start, embeds
the surface and nonce in signed state, and uses the same callback URI during
code exchange. On callback it verifies that the gateway public origin matches
the signed surface's configured origin.

`return_to` and `error_return_to` must use the same configured surface origin.
Their paths must pass the existing safe-return validation. Cross-app navigation
does not use OAuth return URLs; it uses the handoff contract below.

Every callback URI passed to WorkOS must match an allowed redirect URI in the
WorkOS application. Prefer exact registrations. The local launcher registers
the exact origins resolved for the current checkout, including review ports and
worktree-qualified hosts; it must not assume that the API-host callback covers
frontend callbacks.

### Surface matrix

| Surface               | Canonical local origin            | Next-stack origin                       | Callback path                 |
| --------------------- | --------------------------------- | --------------------------------------- | ----------------------------- |
| `platform-admin`      | `https://admin.localhost`         | Resolve from platform configuration     | `/auth/oauth/google/callback` |
| `marketplace-web`     | `https://marketplace.localhost`   | `https://next-marketplace.vayada.com`   | `/auth/oauth/google/callback` |
| `booking-admin`       | `https://admin.booking.localhost` | `https://next-booking-admin.vayada.com` | `/auth/oauth/google/callback` |
| `pms-web`             | `https://pms.localhost`           | `https://next-pms.vayada.com`           | `/auth/oauth/google/callback` |
| `affiliate-dashboard` | `https://affiliate.localhost`     | Resolve from platform configuration     | `/auth/oauth/google/callback` |

The table records repo-confirmed app origins and flags the two origins owned by
the separate platform configuration. VAY-1200 and VAY-1201 must resolve those
exact values before implementation. Each production service must set its exact
canonical `AUTH_PUBLIC_ORIGIN` and matching `apps/api` surface-origin setting.
There is no production fallback to an API origin, request host, or
`*.vayada.com` cookie domain.

| Environment                 | Registration and configuration rule                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical local portless    | Register all five exact local callback URIs; use `127.0.0.1:8003` as the server-only upstream.                                                                                              |
| Isolated review port        | Preserve the port in `AUTH_PUBLIC_ORIGIN` and register each exact callback URI for that port.                                                                                               |
| Worktree-qualified portless | Resolve and register the exact generated frontend host; do not drop the worktree prefix.                                                                                                    |
| Plain-port fallback         | Use each frontend's `http://localhost:<port>` origin, omit cookie `Secure`, and register the exact staging redirect URI.                                                                    |
| Next stack                  | Set the five explicit next-stack origins and register their exact HTTPS callbacks before enabling a surface.                                                                                |
| Production                  | Platform configuration supplies the canonical public origin per surface. Activation is blocked until the exact HTTPS callbacks and sign-out URIs are registered and VAY-1202/VAY-1203 pass. |

## Cross-app session handoff

Host-only cookies deliberately do not follow a user to another Vayada app. Do
not solve that by broadening the cookie domain or placing access tokens, refresh
tokens, sealed sessions, or user JSON in a URL or local storage.

Use an opaque, one-time, audience-bound handoff:

1. The source app posts to `/auth/handoff/create` with CSRF protection, the
   target surface, selected organization/resource hints, and a safe relative
   target path.
2. `apps/api` verifies the source session and authorization, then stores a
   short-lived handoff record containing the already sealed session state and
   returns a random opaque code. Store only a hash of the code; keep sealed
   session material encrypted; default lifetime is 60 seconds.
3. The browser navigates to the target `/handoff` page with the opaque code in
   the URL fragment so it is not sent in the initial request or referrer.
4. The target page posts the code to its same-origin
   `/auth/handoff/redeem`. `apps/api` atomically marks it used, validates the
   target surface and public origin, refreshes or re-seals the WorkOS session,
   and writes the target host's session and CSRF cookies.
5. Organization/property hints are revalidated after redemption; they are
   routing inputs, never authorization evidence.

The handoff store must work across `apps/api` instances and must not be an
in-memory map. Replay, wrong audience, expired code, revoked WorkOS session, or
invalid organization produces a terminal auth response, clears target-host
cookies, and sends the user through normal login with a safe relative return
path. Transient WorkOS refresh failures preserve the still-valid sealed session
and return a retryable response instead of logging the user out.

Legacy handoff fragments containing `token`, `expires_at`, or serialized user
data are transition compatibility only. New first-party surfaces must neither
create nor require them.

## Logout and stale sessions

`POST /auth/logout` is global provider-session logout:

1. validate CSRF and the surface;
2. clear the current frontend host's session, CSRF, and OAuth-state cookies;
3. end/revoke the WorkOS session identified by the access token `sid` and use a
   registered surface-specific sign-out return URI;
4. clear the current app's in-memory access token and auth hints immediately.

Cookies on other frontend hosts cannot be deleted by the current host. They
become stale because they refer to the same ended WorkOS session. On the next
session load or refresh, a terminal WorkOS result clears that host's cookies and
client auth state. A transient timeout, `429`, or `5xx` must not clear a
still-valid session; retry according to WorkOS session-resilience guidance.

An already issued JWT can remain valid until its `exp`. Keep WorkOS access-token
duration short so cross-tab logout and membership changes converge quickly;
the exact duration remains an environment security setting. Immediate
revocation checks on every product API request would require a separate
server-side revocation design and are not introduced by this transport change.

## Rollout and rollback

Roll out one reviewable surface at a time:

1. **VAY-1195 and VAY-1196:** add local callback/config wiring and harden
   callback/cookie behavior behind `AUTH_FIRST_PARTY_SURFACES`.
2. **VAY-1197:** enable Marketplace locally and in the next stack; verify the
   exact `csrf_rejected` and `missing_session` reproductions.
3. **VAY-1198 through VAY-1201:** migrate Booking Admin, PMS, Affiliate, and
   Vayada Admin independently.
4. **VAY-1202:** replace shared-cookie handoff assumptions and verify global
   logout/stale-cookie behavior.
5. **VAY-1203:** run the full browser regression gate with third-party cookies
   unavailable before production activation.

The dependency-ordered implementation checklist is:

| Ticket   | Prerequisite              | Deliverable and validation gate                                                                                        | Ticket-level rollback                                              |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| VAY-1195 | VAY-1194                  | Configure local/review frontend origins and exact WorkOS callbacks; validate canonical, port, and worktree variants.   | Restore the API-host callback and prior launcher values.           |
| VAY-1196 | VAY-1194                  | Add trusted surface origins, signed-state callback binding, host-only cookies, and gateway header tests in `apps/api`. | Disable all first-party surfaces and retain direct compatibility.  |
| VAY-1197 | VAY-1195 and VAY-1196     | Migrate Marketplace `/auth/*`; reproduce password signup and Google signup without the two reported errors.            | Disable `marketplace-web` and deploy its prior frontend image.     |
| VAY-1198 | VAY-1195 and VAY-1196     | Migrate Booking Admin; validate session refresh, compatibility-token calls, organization selection, and logout.        | Disable `booking-admin` and deploy its prior frontend image.       |
| VAY-1199 | VAY-1195 and VAY-1196     | Migrate PMS; validate session refresh, organization/property selection, handoff arrival, and logout.                   | Disable `pms-web` and deploy its prior frontend image.             |
| VAY-1200 | VAY-1195 and VAY-1196     | Resolve the platform-owned origin, migrate Affiliate, and validate affiliate-scoped session and logout flows.          | Disable `affiliate-dashboard` and deploy its prior frontend image. |
| VAY-1201 | VAY-1195 and VAY-1196     | Resolve the platform-owned origin, migrate Vayada Admin, and validate platform-org session and logout flows.           | Disable `platform-admin` and deploy its prior frontend image.      |
| VAY-1202 | VAY-1197 through VAY-1201 | Implement one-time handoff and global logout semantics; validate replay, audience, expiry, and stale-cookie cases.     | Disable handoff and require reauthentication between applications. |
| VAY-1203 | VAY-1195 through VAY-1202 | Run the full multi-environment, third-party-cookie-blocked browser matrix and record production activation evidence.   | Block production activation; no transport change is rolled out.    |

During the staged rollout, `apps/api` may support both transports by surface;
one surface must not mix direct API-host auth and frontend-host auth in the same
session. Production behavior is unchanged until that surface's frontend image,
origin mapping, WorkOS callbacks, and first-party flag are deployed together.

Rollback disables the surface in `AUTH_FIRST_PARTY_SURFACES` and deploys the
previous frontend image. Reauthentication is acceptable because host-only
frontend cookies cannot and must not be copied to the API host. Keep the direct
compatibility route only through the rollout window, monitor its use, and
remove it after all surfaces pass the final gate.

## Validation gate

A surface is ready only when all applicable checks pass:

- password login and signup establish a host-local sealed session;
- Marketplace signup can submit onboarding without `csrf_rejected`;
- Google login/signup starts and returns on the same app origin without
  `missing_session` or OAuth state mismatch;
- verification, reset, organization switch, CSRF writes, compatibility-token
  calls, profile updates, and logout use relative `/auth/*`;
- multiple `Set-Cookie` headers, redirects, `Cache-Control: no-store`, and
  merged `Vary` survive the gateway;
- hostile `Origin`, forwarded host/protocol, return URL, and callback surface
  inputs are rejected;
- ordinary product API requests retain their configured API origins;
- cross-app handoff rejects replay, expiry, and wrong audience;
- global logout prevents a stale cookie on another app from restoring the
  ended provider session;
- canonical local, review-port, worktree, plain-port, next-stack, and production
  configuration validation is documented or automated;
- production does not contain `127.0.0.1` upstreams or an unregistered callback.

## Rejected alternatives

- **Continue direct browser calls to `api.*`:** retains the cross-site cookie
  dependency that caused the failures.
- **Set `SameSite=None` or a broad `Domain`:** increases CSRF exposure and does
  not reliably solve third-party-cookie blocking; WorkOS documents both as
  exceptional rather than the default.
- **Repoint `NEXT_PUBLIC_AUTH_API_URL`:** breaks non-auth product clients that
  currently share that variable.
- **Blindly proxy all backend traffic:** expands the frontend trust boundary and
  makes cache/header mistakes harder to contain.
- **Derive callback origin from forwarded headers:** permits host-header
  influence over OAuth redirect URIs.
- **Put sessions or access tokens in cross-app URLs:** leaks credentials through
  browser history, extensions, screenshots, logs, and downstream code.
- **Use a stateless handoff token without replay state:** cannot enforce
  one-time redemption.

## References

- [WorkOS AuthKit Next.js SDK](https://workos.com/docs/sdks/authkit-nextjs)
- [WorkOS AuthKit sessions](https://workos.com/docs/authkit/sessions)
- [WorkOS session resilience](https://workos.com/docs/authkit/session-resilience)
- [WorkOS authorization URL and redirect URI](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)
- [WorkOS session API](https://workos.com/docs/reference/authkit/session)
- `engineering/workos-identity-architecture.md`
- VAY-600, VAY-735, VAY-739, VAY-1000, VAY-1002, VAY-1003
