# Identity user-lifecycle commands

_VAY-656 contract record. Builds on VAY-600 WorkOS identity architecture,
VAY-608 RequestContext, VAY-609 target schema ownership, and the VAY-642
Booking/PMS coupling audit._

## Purpose

Product domains must not create, update, delete, suspend, or recover users by
writing `identity.users` or legacy Auth DB tables directly. Those writes are
identity-owned lifecycle commands. Product domains may request a lifecycle
change, but the identity/auth boundary owns the mutation, provider
reconciliation, organization membership changes, resource links, permission
grants, idempotency, and audit.

The TypeScript contract lives in `packages/backend-auth/src/lifecycle.ts` until
a dedicated `domain-identity` package exists. Product-facing TypeScript code
should depend on the command bus contract, not on raw Auth DB tables.

## Command Surface

| Command type                       | Identity-owned write intent                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `identity.user.create`             | Create an internal user, optional WorkOS mapping, initial organization, membership, permission intent, and resource links.     |
| `identity.user.profile.update`     | Update identity-owned profile cache fields such as display name. Product profile fields stay product-owned.                    |
| `identity.user.email.update`       | Change the local identity email cache and coordinate provider email verification/reconciliation.                               |
| `identity.user.status.update`      | Move the internal user between target statuses such as `pending`, `active`, `suspended`, and `deleted`.                        |
| `identity.user.suspend`            | Suspend a user and, when requested, suspend memberships/resource links so RequestContext resolution denies product access.     |
| `identity.user.delete`             | Soft-delete or privacy-erase identity state while preserving required audit and provider reconciliation records.               |
| `identity.access.grant`            | Grant or upsert an existing user's organization membership, resource links, and role permission grants.                        |
| `identity.access.revoke`           | Revoke or suspend an existing user's organization membership, resource links, and role permission grants.                      |
| `identity.resource_links.grant`    | Add exact resource links to an existing active organization without changing organization, membership, or permission state.    |
| `identity.recovery.flow.create`    | Start recovery, password reset, email verification, or email change through identity/provider flows, not product token tables. |
| `identity.invite.staff.create`     | Record one hotel staff invitation intent with an assigned property scope and validated permission overrides.                   |
| `identity.invite.affiliate.create` | Invite or link an affiliate user through an affiliate-partner organization, membership, resource link, and permission grants.  |
| `identity.invite.customer.create`  | Invite a customer account without granting hotel ownership or staff membership. Guest booking data remains booking-owned.      |

Each accepted command emits an identity lifecycle event with the original
`commandId`, `idempotencyKey`, actor, reason, request/correlation metadata,
affected identity resources, and an event-specific payload. Product domains
react to events or command results; they do not patch identity rows themselves
or query identity tables to infer what changed.

## Audit And Idempotency

Every command must include:

- `commandId`: unique command identity for logs and event correlation.
- `idempotencyKey`: stable key from the product action, such as
  `affiliate:<affiliateId>:approved` or `booking-register:<email>`.
- `audit.actor`: user, system, or migration actor that requested the change.
- `audit.source`: route/source family (`web`, `admin`, `api`, `agent`, or
  `migration`).
- `audit.requestId` and optional `audit.correlationId`.
- `audit.reason`: human-readable business reason suitable for audit review.
- `audit.requestedAt`: timestamp from the command boundary.

Identity command handlers must treat the tuple
`(commandType, idempotencyKey)` as replay-safe. A retry can return
`idempotent_replay`, but it must not create duplicate users, memberships,
resource links, reset flows, or provider invites.

Staff invitation audit actor fields come from trusted `RequestContext`, never
the request body. Before idempotency lookup or persistence, handlers require an
active actor user and active hotel-group organization, require the actor and
command organization IDs to match, then resolve that user's active membership
for the organization and require `identity.staff.manage`. They also verify that
every canonical property is actively linked to that organization. The resolved
membership identifies the inviter; callers do not supply a membership ID.
Handlers persist one pending intent per organization/email before calling
WorkOS. The command never accepts owner roles, `all` property scope, provider
IDs, provider URLs, or caller-selected expiry.

Recovery commands must name the recovery target at the contract boundary.
Password reset, account recovery, and email verification require either an
internal `userId` or an email address. Email change requires the current
internal `userId` and the requested `newEmail`.

## Ownership Mapping

| Current product write                                                                                           | Target replacement                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking registration inserts `auth-db.users` with `type = 'hotel'`, password hash, consent, and pending status. | `identity.user.create` creates a pending internal user, hotel-group organization, hotel-owner membership, and booking link.                                                            |
| Booking password reset and password change writes `password_reset_tokens` and `users.password_hash`.            | `identity.recovery.flow.create` delegates recovery/reset to identity/WorkOS and records reconciliation/audit events.                                                                   |
| Booking email change updates `users.email` after product token verification.                                    | `identity.user.email.update` coordinates provider verification and updates the identity email cache.                                                                                   |
| Marketplace registration/admin create inserts `auth-db.users` with creator, hotel, or admin type.               | `identity.user.create` plus organization/membership/resource links; user type becomes a migration input, not authorization.                                                            |
| Marketplace admin update mutates name, email, status, email verification, avatar, and `is_superadmin`.          | Profile/email/status commands plus `identity.access.grant` or `identity.access.revoke` for platform organization membership and permission grants. Avatar stays product/profile-owned. |
| Marketplace admin delete removes `auth-db.users` and product profiles in one product route.                     | `identity.user.delete` handles identity deletion; product domains handle their own profile/resource cleanup from events.                                                               |
| PMS affiliate approval inserts Auth users and `password_reset_tokens`, then links `affiliates.user_id`.         | `identity.invite.affiliate.create` creates or links an affiliate user, affiliate-partner membership, and affiliate resource.                                                           |
| Future customer account invitations from booking flows.                                                         | `identity.invite.customer.create`; no hotel ownership, staff membership, or resource-link grant is implied.                                                                            |

## Resource Ownership Rules

Identity lifecycle commands are the only target path that may create or update
identity ownership primitives:

- `organizations` for platform, hotel group, creator workspace, or affiliate
  partner tenants.
- `organization_memberships` for user-to-organization access.
- `role_permission_grants` or membership permission intent for product
  permissions such as `booking.settings.manage` or `affiliate.payout.manage`.
- `organization_resource_links` for booking hotels, PMS hotels, marketplace
  hotel profiles/offers, creator profiles, affiliates, and payout accounts.
  Revoking a resource link must include the relationship so identity can
  distinguish, for example, `owner`, `operator`, and `billing_account` links to
  the same resource.

Product-created child resources use `identity.resource_links.grant`. The
broader `identity.access.grant` is reserved for flows that intentionally create
or reconcile organization membership and permissions.

Product tables may still keep legacy `user_id` columns as migration inputs or
compatibility fields until cutover, but target TypeScript routes and domain
services must authorize through RequestContext, membership permissions, and
resource links.

## Out Of Scope

This contract does not refactor the current Python auth repositories, change
WorkOS provider configuration, or migrate old password/TOTP/email-token tables.
Those legacy writes remain current-system behavior until their migration slices
land.
