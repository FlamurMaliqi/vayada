# WorkOS rollout configuration

_VAY-735 decision record. Builds on VAY-600 WorkOS identity architecture,
VAY-602 TypeScript backend structure, VAY-603 implementation roadmap, VAY-605
backend database restructure, and VAY-608 RequestContext contract._

## Decision summary

Vayada will use WorkOS AuthKit as the login and browser session authority for
migrated staff and business-user surfaces. New TypeScript backend routes should
verify WorkOS access tokens directly at the API boundary, resolve them into
Vayada internal identity and authorization state, and pass a typed
`RequestContext` into product code.

Do not introduce a long-lived Vayada edge session as a second session authority.
Any Vayada-issued credential during rollout is a short-lived compatibility
credential for legacy FastAPI surfaces only.

The first migration surface is `vayada-admin`. It has the smallest tenant-shape
ambiguity, requires the strongest MFA posture, and can move from
`users.is_superadmin` compatibility toward platform organization membership
before hotel/creator/affiliate surfaces depend on organization and resource
selection.

## Token and session strategy

### WorkOS tokens on TypeScript API requests

New `apps/api` authenticated routes should require a WorkOS-authenticated
browser session and verify WorkOS access tokens on every API request.

Accepted request shape:

- Browser login and refresh are handled by AuthKit/session routes.
- API calls carry the current WorkOS access token through the approved
  first-party mechanism for that frontend surface.
- `packages/backend-auth` verifies issuer, audience, signature, expiry,
  selected organization claims when present, and required session metadata.
- Authorization code maps `sub` to `external_identities.provider_user_id`,
  maps `org_id` to `organizations.workos_org_id`, and then resolves the
  internal `RequestContext`.

The TypeScript backend must not treat a WorkOS token as sufficient
authorization. A valid WorkOS session only proves provider authentication and
selected WorkOS organization membership. Vayada still gates access through
internal user status, selected internal organization, active membership,
product permissions, resource links, entitlements, and resource state.

### No durable Vayada edge session

Do not exchange WorkOS sessions for a durable Vayada edge session that becomes
the normal credential for TypeScript routes. That would create two session
authorities, duplicate refresh/logout semantics, and make WorkOS session
revocation harder to reason about.

A short-lived signed compatibility credential is allowed only when a migrated
frontend must call an unmigrated FastAPI surface before that surface can verify
WorkOS tokens. It must:

- be minted only after a valid WorkOS session is resolved to an internal user;
- expire quickly, with a target maximum TTL of 15 minutes;
- identify the internal user and selected compatibility product context;
- avoid storing broad product authorization decisions in the token;
- be rejected for new TypeScript product authorization;
- be auditable and removable per surface during cutover.

### Browser cookie approach

AuthKit callback, refresh, and logout routes in `apps/api` own the browser
session bridge for Vayada frontends. Migrated frontend code should fetch a
short-lived WorkOS access token from the first-party `apps/api` session route,
keep that access token in memory only, and send it to protected `apps/api`
product routes as `Authorization: Bearer <workos-access-token>`.

Protected TypeScript product routes should accept WorkOS access tokens only
from the `Authorization` header. They should not read access tokens from browser
cookies. This matches the current `packages/backend-auth` verifier boundary and
keeps product route CSRF behavior tied to bearer-token presentation instead of
ambient cookies.

Frontend code must not store WorkOS refresh tokens, WorkOS access tokens, or
durable application credentials in `localStorage` or session storage.

Cookie requirements:

- use secure, `HttpOnly`, first-party cookies for AuthKit session state and any
  short-lived compatibility credential;
- use `SameSite=Lax` by default for same-site frontend/API subdomains, and move
  to `SameSite=None; Secure` only if a deployed cross-site topology requires it;
- scope cookies to the narrowest practical domain for the active environment;
- rotate the cookie/session secret through the environment's secret store;
- clear WorkOS/AuthKit session cookies and Vayada compatibility cookies on
  logout;
- protect AuthKit callback, refresh, logout, and compatibility-token routes with
  state parameters, origin checks, and CSRF controls appropriate for the selected
  cookie mode.

The refresh token stays server-managed behind `apps/api`. Implementation
tickets must document the exact session endpoint shape, cookie names, and cookie
domain attributes they introduce. Any future move to a backend-for-frontend
proxy model or access-token cookie would be a new decision because it changes
CSRF, CORS, logout, and token-exposure assumptions.

## Organization selection

WorkOS owns provider organization selection in the login/session flow. Vayada
owns the internal interpretation of that selection.

For the first `vayada-admin` surface, the selected organization must be the
single Vayada `platform` organization. Platform access requires:

- WorkOS authenticated user;
- selected WorkOS organization mapped to the internal `platform` organization;
- active internal membership;
- required platform permission;
- MFA satisfied for platform roles.

For later hotel, creator, and affiliate surfaces, the frontend should select an
organization through the WorkOS/AuthKit session flow and select a product
resource explicitly when more than one linked resource exists. TypeScript domain
code should receive only resolved internal organization and resource context,
not raw `X-Hotel-Id`, `users.type`, `is_superadmin`, or direct product
`user_id` ownership claims.

If a user belongs to multiple WorkOS organizations, the session must carry the
selected organization. The backend should reject ambiguous authenticated
requests that require organization context but lack a selected organization.

## Permissions model

Use normalized internal permission grants from day one for target
authorization, with a seeded role-to-permission mapping used to initialize and
maintain grants.

Rationale:

- VAY-608 requires route-policy denial cases for missing permission,
  entitlement, and linked resource. Normalized grants make those cases explicit
  and testable.
- WorkOS role slugs remain coarse session roles. They are not the product
  permission authority.
- `users.is_superadmin` and `users.type` remain transition inputs only.

Implementation tickets may start with a small seed set for platform roles and
defer admin UI for editing fine-grained permissions, but the stored
authorization model should still be normalized.

## MFA and authentication methods

MFA policy:

- Require MFA for Vayada platform staff roles from the first `vayada-admin`
  cutover.
- Require MFA for hotel owner/admin roles before booking/PMS hotel admin
  surfaces are cut over.
- Allow creator and affiliate MFA to be policy-configurable at launch, with the
  option to require it for payout, billing, and sensitive account changes.
- Treat enterprise SSO or directory-enforced MFA as satisfying the policy only
  when WorkOS session metadata indicates the requirement was met.

Allowed authentication methods:

- Use WorkOS AuthKit APIs behind Vayada-owned auth UI for migrated users.
  Hosted AuthKit UI is not the target for self-service email/password login or
  signup.
- Enable email/password only through WorkOS, not Vayada local password
  verification, for migrated users.
- Allow SSO connections for enterprise hotel groups and platform staff as they
  are configured.
- Allow passkeys or passwordless methods only after they are explicitly enabled
  in the WorkOS environment and covered by the same MFA/session assurance checks.

Retired for migrated users:

- local bcrypt password verification;
- Vayada-owned password reset tokens;
- local email verification tokens for account identity;
- local TOTP secrets and recovery codes.

## Webhook and directory reconciliation

Ingest WorkOS events for reconciliation and audit correlation, not as direct
product authorization decisions.

Initial webhook events to ingest:

- user created, updated, deleted, and email/profile changes;
- session authentication events needed for audit correlation;
- organization created, updated, and deleted;
- organization membership created, updated, activated, deactivated, and deleted;
- invitation accepted or revoked where available;
- MFA enrollment or factor changes where available;
- SSO connection and directory lifecycle changes when those features are
  enabled;
- Directory Sync user/group membership changes for enterprise customers.

Reconciliation rule:

- WorkOS active user and membership state is necessary but not sufficient for
  access.
- If Vayada internal user status, membership status, billing entitlement,
  compliance state, or product resource state says access is blocked, access
  remains blocked even when WorkOS reports an active session or membership.
- Webhook handlers should upsert provider mappings and membership mirrors
  idempotently, then emit identity lifecycle or audit records for product
  domains to consume.
- Webhook retries must not create duplicate internal users, organizations,
  memberships, or resource links.

## First migration surface

Cut over `vayada-admin` first.

Required shape for the first surface:

- one internal `platform` organization mapped to one WorkOS organization;
- platform staff users backfilled or linked to WorkOS users;
- platform memberships and normalized platform permissions seeded;
- `is_superadmin` retained only as a compatibility input during backfill and
  rollback;
- WorkOS MFA required for platform roles;
- AuthKit login, callback, session refresh, and logout routes implemented in
  `apps/api` before frontend cutover;
- no booking/PMS/marketplace/affiliate frontend behavior changed by the first
  surface.

Recommended later sequence:

1. Booking/PMS hotel admin surfaces, once `hotel_group` organizations and
   resource links are backfilled.
2. Marketplace creator and hotel surfaces, once creator workspace and hotel
   profile/listing links are backfilled.
3. Affiliate dashboard, once affiliate partner organizations and payout-sensitive
   MFA rules are in place.

## FastAPI compatibility bridge

Use the short-lived legacy session bridge only for migrated frontends that still
need to call unmigrated FastAPI endpoints.

Compatibility bridge behavior:

- AuthKit login completes through `apps/api`.
- The TypeScript auth boundary resolves WorkOS identity to an internal user and
  selected organization.
- When a legacy FastAPI call is unavoidable, `apps/api` may mint a short-lived
  compatibility credential scoped to the legacy surface.
- FastAPI surfaces keep their current authorization until migrated, but should
  accept the compatibility credential only for the specific surface and context
  documented by the implementation ticket.
- New TypeScript product routes must use WorkOS-backed `RequestContext`, not
  the compatibility credential.
- Next-stack browser deployments keep compatibility-token minting disabled by
  default with `NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=false`; VAY-860
  owns retiring the remaining fallback bridge after WorkOS links are complete.

The alternative request-scoped principal handoff is preferred for server-to-server
internal calls, but not for browser-to-FastAPI traffic because the current
frontends already expect cookie/token-based browser calls and the first cutover
must preserve unmigrated route behavior.

## Local password credential cutover

For a user on a migrated surface, disable local password login after all of
these are true:

- the internal user is linked to a verified WorkOS user;
- the required WorkOS organization membership for that surface is active;
- the surface's frontend uses AuthKit login and session refresh in production;
- rollback has either expired or the rollback plan can re-enable local
  credentials intentionally;
- support/admin recovery procedures for WorkOS account issues are documented.

Disabling means local password verification no longer issues a new application
session for that migrated surface. Keep legacy password hashes, reset tokens,
and local TOTP data only for rollback, audit, or not-yet-linked users until a
separate retirement ticket deletes or archives them.

VAY-751 retirement state:

- `vayada-admin` uses AuthKit login by default. The visible legacy password
  fallback is now opt-in via `NEXT_PUBLIC_AUTHKIT_LEGACY_FALLBACK_ENABLED=true`
  and should only be enabled for rollback or an explicitly identified unlinked
  admin cohort.
- The server-side retirement gate defaults on via
  `LOCAL_AUTH_RETIREMENT_ENABLED=true`. Set it to `false` only during an
  intentional rollback window when linked admins must temporarily use the local
  credential path again.
- WorkOS-linked platform users (`users.type = 'admin'` or
  `users.is_superadmin = true` with an `identity.external_identities.provider =
'workos'` row) cannot mint new local password sessions, complete legacy
  password reset, consume legacy email verification tokens, or complete local
  TOTP challenge/setup flows.
- Unlinked users remain on the legacy credential path while the rollback window
  and backfill cohort remain open. Local password, reset, email verification,
  rate-limit, and TOTP tables are retained for those users and for rollback;
  this ticket does not drop or archive credential material.

Do not delete local credential material at the same time as first WorkOS login
linking. Deletion belongs to a later cleanup after the cutover surface has been
stable and rollback no longer depends on local credentials.

## High-risk legacy ownership checks

Migrate these before or with the corresponding frontend cutover, not as a
global precondition for the first `vayada-admin` cutover:

- `users.is_superadmin` platform admin checks: replace with platform
  organization membership and platform permissions for `vayada-admin`.
- `X-Hotel-Id` and direct hotel `user_id` checks: migrate before booking/PMS
  hotel admin WorkOS cutover.
- creator and marketplace hotel `user_id` ownership checks: migrate before
  marketplace frontend cutover.
- affiliate `user_id` and payout access checks: migrate before affiliate
  dashboard cutover.

No old ownership check should be imported into the TypeScript `RequestContext`
contract as durable authorization state.

## Environment and dashboard checklist

Configure separate WorkOS environments or applications for local development,
staging, and production. Values below are configuration requirements, not
committed secrets. Production secrets are owned outside this repo, currently by
the platform/deployment environment.

### `apps/api` environment variables

| Variable                | Local development                                                                                                       | Staging                                                                                                    | Production                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AUTH_DATABASE_URL`     | `postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db` or the local Docker auth DB URL      | staging target/auth DB secret                                                                              | production target/auth DB secret                                                           |
| `WORKOS_CLIENT_ID`      | local WorkOS application client ID                                                                                      | staging WorkOS application client ID                                                                       | production WorkOS application client ID                                                    |
| `WORKOS_API_KEY`        | local WorkOS API key, used only by AuthKit route/backfill/webhook code that calls WorkOS APIs                           | staging WorkOS API key secret                                                                              | production WorkOS API key secret                                                           |
| `WORKOS_JWKS_URL`       | `https://api.workos.com/sso/jwks/<local-WORKOS_CLIENT_ID>` unless the WorkOS environment documents a different JWKS URL | staging WorkOS JWKS URL for the staging app                                                                | production WorkOS JWKS URL for prod app                                                    |
| `WORKOS_ISSUER`         | issuer expected in local WorkOS access tokens                                                                           | issuer expected in staging WorkOS tokens                                                                   | issuer expected in production tokens                                                       |
| `WORKOS_AUDIENCE`       | local WorkOS application client ID                                                                                      | staging WorkOS application client ID                                                                       | production WorkOS application client ID                                                    |
| `AUTH_COOKIE_SECRET`    | local random secret for AuthKit session/compatibility cookies                                                           | staging secret store                                                                                       | production secret store                                                                    |
| `WORKOS_WEBHOOK_SECRET` | local tunnel webhook signing secret when testing webhooks                                                               | staging webhook signing secret                                                                             | production webhook signing secret                                                          |
| `AUTH_BASE_URL`         | `https://api.localhost` for the `apps/api` portless app                                                                 | `https://api-staging.vayada.com`                                                                           | `https://api.vayada.com`                                                                   |
| `AUTH_ALLOWED_ORIGINS`  | `https://admin.localhost`                                                                                               | `https://admin-staging.vayada.com`                                                                         | `https://admin.vayada.com`                                                                 |
| `AUTH_CALLBACK_URLS`    | `https://api.localhost/auth/workos/callback` and `https://admin.localhost/auth/callback`                                | `https://api-staging.vayada.com/auth/workos/callback` and `https://admin-staging.vayada.com/auth/callback` | `https://api.vayada.com/auth/workos/callback` and `https://admin.vayada.com/auth/callback` |
| `AUTH_LOGOUT_URLS`      | `https://admin.localhost/login`                                                                                         | `https://admin-staging.vayada.com/login`                                                                   | `https://admin.vayada.com/login`                                                           |

`WORKOS_CLIENT_ID` is listed even though the current verifier uses
`WORKOS_AUDIENCE`, because AuthKit routes, backfill, and dashboard setup need
the client ID explicitly. `WORKOS_AUDIENCE` should equal the WorkOS client ID
unless WorkOS changes the access-token audience contract for the application.

The staging hostnames above are the selected rollout pattern. If the platform
repo uses different staging DNS, update this decision record before configuring
the WorkOS staging dashboard; do not leave AuthKit implementation tickets to
choose new callback/logout origins silently.

### WorkOS dashboard settings

| Setting               | Local development                                                                      | Staging                                                                                                 | Production                                                                              |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Application           | dedicated local/dev AuthKit application                                                | dedicated staging AuthKit application                                                                   | dedicated production AuthKit application                                                |
| API base URL          | `https://api.localhost`                                                                | `https://api-staging.vayada.com`                                                                        | `https://api.vayada.com`                                                                |
| First frontend origin | `https://admin.localhost`                                                              | `https://admin-staging.vayada.com`                                                                      | `https://admin.vayada.com`                                                              |
| Callback URLs         | `https://api.localhost/auth/workos/callback`, `https://admin.localhost/auth/callback`  | `https://api-staging.vayada.com/auth/workos/callback`, `https://admin-staging.vayada.com/auth/callback` | `https://api.vayada.com/auth/workos/callback`, `https://admin.vayada.com/auth/callback` |
| Logout return URLs    | `https://admin.localhost/login`                                                        | `https://admin-staging.vayada.com/login`                                                                | `https://admin.vayada.com/login`                                                        |
| Allowed origins       | `https://admin.localhost`, `https://api.localhost`                                     | `https://admin-staging.vayada.com`, `https://api-staging.vayada.com`                                    | `https://admin.vayada.com`, `https://api.vayada.com`                                    |
| Webhook endpoint      | local tunnel to `https://api.localhost/auth/workos/webhook` only when testing webhooks | `https://api-staging.vayada.com/auth/workos/webhook`                                                    | `https://api.vayada.com/auth/workos/webhook`                                            |
| Custom auth domain    | optional for local                                                                     | configure before external staging QA if available                                                       | required before broad customer rollout                                                  |
| MFA policy            | required for platform roles                                                            | required for platform roles; rehearse hotel admin policy                                                | required for platform and hotel owner/admin roles                                       |
| SSO/directory         | optional test connections                                                              | staging enterprise test connections                                                                     | production customer/staff connections                                                   |

Dashboard checklist per environment:

- create or confirm the WorkOS application used by Vayada AuthKit;
- register callback URLs for the first `vayada-admin` surface;
- register logout return URLs;
- configure allowed origins for the relevant frontend and API domains;
- decide and configure the custom auth domain before production customer
  rollout;
- enable required MFA policy for platform roles;
- enable only approved authentication methods for the environment;
- create the platform WorkOS organization and set its external ID to the
  internal `platform` organization ID;
- configure role slugs for platform roles and future hotel/creator/affiliate
  roles;
- configure webhook endpoint and signing secret;
- enable only the webhook event families listed in this document for the first
  implementation pass;
- document SSO and Directory Sync connections separately when a customer or
  staff group is onboarded.

## Implementation gates

Before VAY-739, VAY-742, VAY-745, or VAY-748 changes production auth behavior,
the implementation ticket must link this decision record and state which part
of the rollout it implements.

Minimum gates:

- AuthKit routes verify WorkOS sessions and resolve internal `RequestContext`.
- Backfill creates or links WorkOS users, the platform organization, platform
  memberships, external IDs, and local provider mappings idempotently.
- Webhook reconciliation is idempotent and never overrides Vayada-side blocks.
- The first frontend cutover is limited to `vayada-admin`.
- Rollback can restore local login for the cutover surface until the agreed
  rollback window closes.
- Local password credential deletion is deferred to legacy-auth retirement
  after the cutover rules are satisfied.
