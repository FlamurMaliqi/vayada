# WorkOS identity architecture

_VAY-600 decision record. WorkOS documentation checked on 2026-06-03._

## Recommendation

Adopt WorkOS AuthKit as Vayada's source of truth for authentication and
provider-managed identity state. Keep Vayada as the source of truth for internal
application identity, product authorization, resource ownership, billing
entitlements, and product audit trails.

In practice:

- WorkOS answers: who authenticated, which session is active, which WorkOS
  organization membership was selected, whether MFA/SSO/directory lifecycle
  requirements were satisfied, and which coarse organization role claims belong
  in the session.
- Vayada answers: which internal user exists, which internal organization owns
  which hotel/property/creator/affiliate resource, which product permissions
  that membership grants, what the user can do to a specific resource, and which
  product/billing state is active.

Do not replace Vayada internal IDs with WorkOS IDs in product tables. Preserve
`users.id` as the internal principal and add explicit WorkOS mapping columns or
tables around it.

## WorkOS-owned surface

WorkOS should own these provider-managed concerns:

- User identities: WorkOS user ID, verified email, profile basics, linked
  authentication methods, and provider profile metadata.
- Sessions: WorkOS access/refresh tokens, session ID, token refresh, logout, and
  organization switching. WorkOS access tokens use `sub` as the WorkOS user ID
  and can include selected `org_id`, role, and permissions claims when an
  organization is selected.
- Authentication methods and provider-side flows: password auth, passwordless
  or magic auth if enabled, social login if enabled, enterprise SSO, account
  recovery, email verification, and passkeys where configured. Vayada may own
  the browser UI for these flows, but WorkOS remains the provider authority.
- MFA policy and enrollment: especially mandatory MFA for Vayada staff and hotel
  owner/admin roles.
- Organizations: WorkOS organization ID, domains, SSO connection, directory
  sync connection, organization-level auth policies, and invite acceptance.
- Organization memberships: membership status (`pending`, `active`,
  `inactive`), WorkOS membership ID, and coarse role slug(s) used for session
  claims. WorkOS supports one user belonging to multiple organizations.
- Invitations and directory lifecycle: provider invitation flow, JIT
  provisioning where enabled, SCIM/directory provisioning and deprovisioning,
  and group-to-role assignment for enterprise customers.
- Auth events and provider audit logs: login/logout/MFA/SSO/session and
  directory/authentication events. Vayada should ingest selected events for
  reconciliation, not duplicate provider audit mechanics.

## Vayada-owned surface

Vayada should own these application concerns:

- Internal users: stable `auth-db.users.id`, product-visible name/email cache,
  status needed for product moderation/suspension, consent fields, and legacy
  compatibility during migration.
- Internal organizations: Vayada tenant/business containers such as platform,
  hotel group, creator workspace, and affiliate partner.
- Resource links: mappings from an internal organization to marketplace hotel
  profiles/offers, booking hotels, PMS hotels/properties, creator profiles,
  affiliate records, payouts, and future product resources.
- Product roles and permissions: fine-grained permissions like
  `pms.booking.update`, `booking.settings.manage`,
  `marketplace.collaboration.review`, `affiliate.payout.manage`, and
  `platform.user.suspend`.
- Authorization decisions: endpoint and repository checks that combine
  authenticated user, selected organization, active membership, product
  permission, resource link, billing entitlement, and resource state.
- Billing and entitlements: product subscription, enabled modules, plan limits,
  feature gates, payment status, and add-on access.
- Product audit events: application actions after login, including actor,
  selected organization, target resource, before/after data, source IP/user
  agent where relevant, and correlation to WorkOS auth events when available.
- Guest booking identity: guest checkout remains booking/customer data, not a
  WorkOS user or organization membership, until a guest account product is
  explicitly scoped.

Product domains request user lifecycle changes through the identity-owned
command surface in
[`identity-user-lifecycle-commands.md`](identity-user-lifecycle-commands.md).
They must not write `users`, provider identity mappings, organization
memberships, resource links, permission grants, or retired reset/recovery token
tables directly in the TypeScript target path.

## Mapping model

### Users

Keep `users.id` as the stable internal principal ID.

Recommended schema shape:

- `users.id`: Vayada UUID, unchanged.
- `users.email`, `users.name`, optional contact `phone`, profile-picture media
  reference, `users.status`, and consent fields: retained as Vayada's local
  cache and product state. Hotel and organization contact details remain on
  their own resources rather than being copied onto the user.
- `external_identities.provider`: `workos`.
- `external_identities.user_id`: FK to `users.id`.
- `external_identities.provider_user_id`: WorkOS `user_*` ID.
- `external_identities.provider_email`: email observed from WorkOS.
- `external_identities.provider_email_verified`: provider email verification
  state.
- `external_identities.last_login_at`, `raw_profile`, timestamps.

Required integrity:

- `external_identities.user_id` is `NOT NULL` and references `users.id`.
- `(external_identities.provider, external_identities.provider_user_id)` is
  unique where `provider_user_id` is present.
- `(external_identities.provider, external_identities.provider_email)` can be a
  partial unique bootstrap constraint only where the provider/email pair is
  known to be canonical for account creation. Do not use provider email
  uniqueness as the long-term authorization key.

Set WorkOS user `external_id` to `users.id` whenever Vayada creates or
backfills the WorkOS user. If a user arrives through SSO/JIT before a Vayada user
exists, create the Vayada user during callback, then update the WorkOS user
`external_id` to the new `users.id`. WorkOS external IDs are unique in the
environment and fit Vayada UUIDs.

Email is only a bootstrap and recovery signal. It must not be the authorization
key because enterprise SSO, email changes, duplicate historical records, and
account recovery can all change or reassert email ownership.

### Organizations

Create an internal `organizations` table and map it one-to-one to WorkOS
organizations when that organization needs authenticated members.

Recommended schema shape:

- `organizations.id`: Vayada UUID.
- `organizations.kind`: `platform`, `hotel_group`, `creator_workspace`,
  `affiliate_partner`.
- `organizations.name`, optional `website_url`, `slug`, `status`, timestamps.
- `organizations.workos_org_id`: WorkOS `org_*` ID, nullable during backfill.
- `organizations.workos_external_id`: normally the same value as
  `organizations.id`.

Required integrity:

- `organizations.workos_org_id` is unique where present. During migration it can
  stay nullable for organizations not yet backfilled, but once a tenant is
  WorkOS-managed it must be populated before accepting WorkOS sessions for that
  tenant.
- `organizations.workos_external_id` is unique where present and should match the
  internal organization UUID used as WorkOS `external_id`.

Set WorkOS organization `external_id` to `organizations.id`. Store the WorkOS
organization ID locally for fast session validation and webhook reconciliation.

Default organization mapping:

- `platform`: one Vayada staff organization.
- `hotel_group`: one hotel business account that can own one or many product
  hotel/property records.
- `creator_workspace`: one creator business or solo creator workspace.
- `affiliate_partner`: one affiliate account, agency, or partner workspace.

The default for hotels should be hotel group, not individual property. Product
resources can still model individual properties through resource links.

### Memberships

Create an internal `organization_memberships` table and map each active business
membership to a WorkOS organization membership.

Recommended schema shape:

- `organization_memberships.id`: Vayada UUID.
- `organization_memberships.organization_id`: FK to `organizations.id`.
- `organization_memberships.user_id`: FK to `users.id`.
- `organization_memberships.status`: `pending`, `active`, `inactive`,
  `suspended`.
- `organization_memberships.role_key`: Vayada's primary product role.
- `organization_memberships.permission_overrides`: optional JSON for temporary
  exceptions, if needed.
- `organization_memberships.workos_membership_id`: WorkOS `om_*` ID.
- `organization_memberships.workos_role_slugs`: coarse mirrored role slugs from
  WorkOS.
- invite/source/audit timestamps.

Required integrity:

- `organization_memberships.organization_id` is `NOT NULL` and references
  `organizations.id`.
- `organization_memberships.user_id` is `NOT NULL` and references `users.id`.
- `organization_memberships.workos_membership_id` is unique where present.
- The internal membership identity is unique on `(organization_id, user_id)` so
  webhook retries, backfills, and manual fixes resolve to one Vayada membership.

WorkOS membership status gates whether the user can present that organization in
an authenticated session. Vayada membership status and permissions gate what the
user can do inside Vayada after the session is accepted.

Use WorkOS roles as coarse session roles only. Mirror enough to support session
claims and enterprise group assignment, but keep authoritative product
permissions in Vayada. Suggested WorkOS role slugs are broad:

- `platform_admin`
- `hotel_owner`
- `hotel_admin`
- `hotel_member`
- `creator_owner`
- `creator_member`
- `affiliate_owner`
- `affiliate_member`

Vayada can map those to finer product roles such as `pms_manager`,
`front_desk`, `booking_manager`, `finance`, `content_review`, or
`affiliate_payout_manager`.

### Resource links

Add `organization_resource_links` as the bridge from organizations to product
resources.

Recommended schema shape:

- `organization_id`: FK to `organizations.id`.
- `product`: `marketplace`, `booking`, `pms`, `platform`.
- `resource_type`: `hotel_profile`, `marketplace_offer`, `booking_hotel`,
  `pms_hotel`, `creator_profile`, `affiliate`, `payout_account`.
- `resource_id`: UUID or product-native ID.
- `relationship`: `owner`, `operator`, `promotes`, `billing_account`.
- unique key on `(organization_id, product, resource_type, resource_id,
relationship)`.

New authorization should resolve:

1. WorkOS access token and session.
2. WorkOS `sub` -> `external_identities` -> `users.id`.
3. WorkOS `org_id` -> `organizations.workos_org_id`.
4. Active Vayada membership for `(user_id, organization_id)`.
5. Required product permission on that membership.
6. Link from selected organization to target resource.
7. Product-specific resource state and billing entitlement.

## Product implications

### Vayada admin

Replace `users.is_superadmin` as the sole platform gate with membership in the
`platform` organization. Keep `is_superadmin` as a transition compatibility flag
until platform endpoints use membership/permission checks. Require WorkOS MFA
for platform roles.

### Booking and PMS hotel admin

Stop assuming one `users.id` owns the hotel forever. A hotel organization can
have multiple members and can own multiple booking/PMS resources. The active
hotel context should come from selected organization plus selected linked hotel
resource, not just `X-Hotel-Id` checked against `booking_hotels.user_id` or
`pms.hotels.user_id`.

During migration, keep `X-Hotel-Id` and direct `user_id` checks as compatibility
fallbacks while adding membership/resource-link checks.

### Marketplace hotel and creator flows

Move registration from "create local user with password, then create profile" to
"authenticate with WorkOS, then create or select internal organization and
product profile." Existing `creators.user_id` and `hotel_profiles.user_id`
remain owner compatibility fields until resource links are in place.

Creator workspaces can start as solo organizations but should use the same
membership model so agencies or assistants can be added later without another
identity rewrite.

### Custom AuthKit UI contract

Next-generation signup, login, password reset, and email verification surfaces
use Vayada-owned UI backed by WorkOS AuthKit APIs. WorkOS remains the source of
truth for users, passwords, sessions, email verification, password reset,
MFA/SSO policy, and provider identity state. Vayada owns the product-specific
entrypoints, copy, layout, and setup routing.

The browser must not call WorkOS management APIs directly or receive WorkOS API
keys/client secrets. `apps/api` owns WorkOS API calls, validates product intent,
maps WorkOS auth states into Vayada auth states, sets the sealed AuthKit session
cookie, and returns the same first-party session response shape used by
migrated frontends.

Browser auth traffic reaches `apps/api` through each frontend's application-local
`/auth/*` gateway. Host-only cookie ownership, callbacks, proxy headers,
cross-app handoff, logout, staged activation, and rollback are defined in
[`workos-browser-session-transport.md`](workos-browser-session-transport.md).

Initial email/password entrypoints:

```text
POST /auth/password/login
POST /auth/password/signup
```

Custom signup must keep product intent explicit. The public frontend entrypoints
are product-specific, for example:

```text
/signup?type=creator
/signup?type=hotel
```

Missing or unsupported product intent must be rejected before creating a WorkOS
user or Vayada organization.

Surface contract:

| Surface           | Signup intent       | Post-signup destination owner                       |
| ----------------- | ------------------- | --------------------------------------------------- |
| `booking-admin`   | `hotel`             | Booking Admin setup/dashboard guard                 |
| `pms-web`         | `hotel`             | PMS setup/dashboard guard                           |
| `marketplace-web` | `creator` / `hotel` | Marketplace creator completion or hotel setup guard |

`platform-admin` is intentionally absent from public self-service signup.
Platform administrators must be provisioned by an invitation or administrative
flow, not a public register page.

The custom signup endpoint derives the organization kind and owner role from the
validated surface and signup intent, creates the WorkOS user and organization,
creates or finds the WorkOS organization membership, then authenticates or
refreshes the sealed session with the selected `organization_id` before
continuing. It creates or links the internal user through `identity.user.create`
when needed, and the identity lifecycle command creates the internal
organization and owner membership from the signup context. Existing WorkOS users
who enter a valid signup flow receive the same organization access through
`identity.access.grant`.

Custom auth endpoints should expose a stable Vayada auth-state contract instead
of leaking WorkOS SDK errors into frontend pages. Required states include
invalid credentials, email verification required, organization selection
required, MFA required, SSO required, and generic auth failure. MFA and SSO are
not part of the first custom UI rollout; until they are scoped, those states
should produce explicit unsupported responses instead of redirecting to hosted
AuthKit UI.

When Google code exchange returns `organization_selection_required`, the API may
complete the pending WorkOS authentication automatically only when exactly one
provider-offered organization maps to an active Vayada organization of the
surface's required kind. PMS/Booking Admin therefore select hotel groups, while
Platform Admin selects the platform organization. Zero or multiple matching
organizations must not be guessed. Keep the pending token server-side, verify
the returned session organization, then apply the existing user, membership,
role, and property-access checks. This does not add a multi-workspace picker.

Product-specific profile setup still belongs to the destination app's setup
guard. Custom auth endpoints must not recreate legacy password registration
behavior or store/verify Vayada-owned password hashes.

### Affiliates

Affiliate dashboard login should use WorkOS and an `affiliate_partner`
organization. Public referral links, click attribution, and unauthenticated
booking attribution remain public product flows. Payout settings and affiliate
admin actions require membership checks.

### Guests

Do not add booking guests to WorkOS by default. Guest identity belongs to booking
records and payment/customer records. A future guest portal should be scoped as a
separate account model.

## Migration implications

### Current local auth to retire

These should be retired for migrated users after WorkOS is authoritative:

- Local password hash creation and bcrypt verification in
  `apps/marketplace-api/app/routers/auth.py` and
  `apps/booking-api/app/routers/auth.py`.
- Local password reset tables and flows (`password_reset_tokens`).
- Local email verification code/token flows for account identity.
- Local TOTP secrets, recovery codes, and TOTP login challenge flows.
- Local login rate limiting that protects only Vayada password endpoints.
- Internal JWT issuance where `sub = users.id` is treated as the primary web
  session forever.

### Current app state to keep

These should remain in Vayada:

- `users.id`, consent history, GDPR request linkage, local product status, and
  product-facing display cache.
- Product resource ownership state, migrated from direct `user_id` ownership to
  organization resource links.
- Product audit events and domain-specific history such as booking events,
  commission audit, payout actions, notes, and admin actions.
- Compatibility columns like `users.type`, `users.is_superadmin`, and product
  `user_id` owner fields until their endpoint surfaces are migrated.

### Transition session strategy

Use a staged transition:

1. Verify WorkOS access tokens at the backend boundary.
2. Resolve WorkOS IDs to internal IDs and selected organization.
3. Either issue a short-lived internal compatibility session for old FastAPI
   surfaces or pass a request-scoped internal principal into the new TypeScript
   backend.
4. Stop minting new local password sessions once all migrated frontends use
   WorkOS-backed custom auth and session refresh.

The new TypeScript backend should not carry forward the assumption that the JWT
subject is always `users.id`. It should model an authenticated principal as both
provider identity and resolved internal identity:

```text
provider_user_id -> internal_user_id -> active_organization_id -> permissions -> resource links
```

## Old assumptions to retire

- One user has exactly one durable product `type`.
- `users.type = hotel` means the user can administer every hotel row tied to
  that user.
- `users.is_superadmin` is the whole platform authorization model.
- The authenticated user directly owns all product resources through `user_id`.
- A hotel admin account is the same concept as a hotel/property/business.
- Local password login is the primary session authority.
- Local TOTP is the long-term MFA authority.
- Email address is a stable authorization identifier.
- Guest booking identity should share the same account model as staff, hotels,
  creators, and affiliates.

## Assumptions to keep only as transition compatibility

- `users.type` for routing old profile/onboarding flows.
- `users.is_superadmin` for old admin dependencies.
- Existing `user_id` columns on `creators`, `hotel_profiles`, `booking_hotels`,
  `pms.hotels`, affiliate records, notes, and audit rows.
- `access_token` cookie shape for FastAPI surfaces that have not moved to
  WorkOS-aware verification.
- Local password/reset/TOTP tables for rollback and not-yet-linked users.

## Prerequisites before implementation tickets

Do not create endpoint-by-endpoint WorkOS implementation tickets until these are
true:

- WorkOS is confirmed as the provider of record for Vayada account login.
- The first migration surface is selected. The original broad identity rollout
  recommendation was Vayada Admin, Booking/PMS, Marketplace, then Affiliate.
  For the narrower first-party browser transport, VAY-1194 supersedes that
  order: validate the reported failure on Marketplace first, then migrate each
  remaining surface behind its independent rollout flag.
- The internal organization kinds and default hotel mapping are accepted. The
  recommended hotel mapping is one `hotel_group` organization owning one or many
  linked product hotel/property resources.
- The provider-neutral auth DB migration is designed and reviewed before any
  frontend login replacement starts.
- A rollback/compatibility strategy exists for users not yet linked to WorkOS.
- Required WorkOS environment settings are known: app URLs, callback/logout
  URLs, custom auth domain decision, cookie/session approach, MFA policy,
  allowed authentication methods, SSO/directory rollout policy, and webhook
  events to ingest.
- The backend rewrite plan has an explicit principal contract so new TypeScript
  code receives both provider and internal identity context.

## Backend restructure questions

- Should the TypeScript backend use WorkOS access tokens directly on every API
  request, or should it exchange them for a Vayada internal session at the edge?
- Which service owns organization selection when a user belongs to multiple
  hotel groups or product workspaces?
- Should permissions be stored as normalized tables from day one, or should
  role-to-permission JSON be used until the first multi-member hotel customer
  requires admin UI?
- How should WorkOS webhooks and Directory Sync events be reconciled when Vayada
  product billing or compliance state says access should stay blocked?
- What is the cutover rule for deleting or disabling local password credentials
  after WorkOS linking?
- Which old `user_id` ownership checks are high-risk enough to migrate before
  the TypeScript rewrite, if any?

## References

- VAY-582: Evaluate authentication platform and identity model.
- VAY-600: Define WorkOS identity architecture.
- VAY-735: Decide WorkOS rollout configuration and first login surface.
- WorkOS AuthKit sessions:
  https://workos.com/docs/authkit/sessions
- WorkOS users and organizations:
  https://workos.com/docs/authkit/users-organizations
- WorkOS organization memberships API:
  https://workos.com/docs/reference/authkit/organization-membership
- WorkOS metadata and external IDs:
  https://workos.com/docs/user-management/metadata
- WorkOS Directory Sync:
  https://workos.com/docs/directory-sync/index
