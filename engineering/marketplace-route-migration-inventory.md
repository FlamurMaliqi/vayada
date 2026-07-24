# Marketplace Route Migration Inventory

_VAY-737 decision record. Inputs: `engineering/typescript-backend-structure.md`,
`engineering/target-schema-ownership-map.md`,
`engineering/frontend-backend-contract-migration.md`,
`engineering/workos-identity-architecture.md`,
`engineering/identity-user-lifecycle-commands.md`._

## Purpose

Inventory the historical `apps/marketplace-api` route surface (92 router routes
across 17 routers, plus 3 app-level root/health routes that are infra and out of
scope), assign each route family a disposition and owning track, and define the
contract-first vertical order for migrating marketplace product behavior to the
TypeScript backend. After the newsletter retirement, the active Python runtime
contains 90 router routes across 16 routers.

The rewrite is explicitly not 1:1: several route families are owned by other
tracks (WorkOS identity, identity/privacy, platform media) and must not be
ported as marketplace verticals.

## Decision

Migrate marketplace in contract-first verticals following the read-before-write
pattern from `engineering/frontend-backend-contract-migration.md`. The first
vertical is **public marketplace discovery** (`/marketplace/listings`,
`/marketplace/creators`): read-only, already modeled as
`marketplace_listing_read_model` in the target schema ownership map, and
consumed by three frontends (`marketplace-web`, `vayada-admin`'s marketplace
dashboard, and `landing`'s hotel-creator-network page), which makes it the
cheapest end-to-end proof of the marketplace contract → route → client →
cutover chain.

Auth, consent/GDPR, uploads, and admin user management are explicitly **not**
marketplace verticals. They are deferred to their owning tracks below.

## Route inventory and dispositions

Frontend consumers: MW = `apps/marketplace-web`, VA = `apps/vayada-admin`,
LA = `apps/landing`, BA = `apps/booking-admin`. `affiliate-dashboard` does not
consume marketplace-api (its auth calls go to booking-api).

### Owned by other tracks (not marketplace verticals)

| Router                                                                                                                                 | Routes                  | Consumers                                               | Disposition                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.py` (15: register, login, TOTP setup/verify/confirm/recovery, password reset, email verification, validate-token, login-history) | `/auth/*`               | VA                                                      | **WorkOS track.** Marketplace Web has cut over to next-api AuthKit and no longer consumes legacy login or `validate-token`. The remaining legacy Vayada Admin consumer stays on its existing route until that surface cuts over. Do not port.                   |
| `consent.py` (5), `gdpr.py` (6)                                                                                                        | `/consent/*`, `/gdpr/*` | MW, LA (cookie banner uses `GET/POST /consent/cookies`) | **Identity/privacy domain.** The coverage matrix places `cookie_consent`, `consent_history`, and `gdpr_requests` under identity ownership. Migrate behind identity-owned routes after the WorkOS lifecycle command surface is live; not a marketplace vertical. |
| `admin/users.py` (8: user CRUD, profile writes, superadmin toggle)                                                                     | `/admin/users*`         | VA                                                      | **Identity user-lifecycle commands.** Product admin user writes must go through the command surface in `identity-user-lifecycle-commands.md`, not direct `users` writes. Ticketed under the identity/WorkOS track when that surface lands.                      |
| `upload.py` (7: image/listing/profile/chat uploads)                                                                                    | `/upload/*`             | MW                                                      | **Platform media decision needed.** Cross-cutting object-storage concern shared with booking/PMS media. Defer behind a platform media/storage decision ticket; do not port per-product upload routes 1:1.                                                       |
| `contact.py` (1)                                                                                                                       | `/contact`              | LA                                                      | **Platform intake.** Public contact form is an email side effect; belongs in jobs/events intake (same family as booking-web telemetry in `booking-web-public-api-routing.md`). Merge there, not a marketplace vertical.                                         |

### Marketplace verticals (migration order)

| #   | Vertical                                                  | Routes                                                                                                         | Consumers  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **Public discovery reads**                                | `GET /marketplace/listings`, `GET /marketplace/creators` (2)                                                   | MW, VA, LA | First vertical. Read-only, public-safe, backed by `marketplace_listing_read_model` + `creator_profiles`/`creator_platforms`. Cross-origin consumer (landing HCN) makes the contract worth pinning first.                                                                                                                                                                                                                                                                                                                                                                                        |
| V2  | **Hotel profile and listings self-service**               | `/hotels/me/profile-status`, `GET/PUT /hotels/me`, `POST/PUT/DELETE /hotels/me/listings*` (6)                  | MW         | Reads first, then writes. Canonical property facts come from hotel catalog; marketplace keeps `marketplace_hotel_profiles`/`marketplace_hotel_listings` state. Resource scoping moves from `hotel_profiles.user_id` to organization resource links with `user_id` as compatibility fallback.                                                                                                                                                                                                                                                                                                    |
| V3  | **Creator profile self-service**                          | `/creators/me/profile-status`, `GET/PUT /creators/me` (3)                                                      | MW         | Same shape as V2 with `creator_profiles`/`creator_platforms`. Creator-workspace organization linkage per WorkOS architecture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| V4  | **Collaboration lifecycle and chat**                      | `/collaborations*` (7), chat (4), `/creators/me/collaborations*` (2), `/hotels/me/collaborations*` (2) (15)    | MW         | Largest vertical: create/respond/terms/approve/cancel/deliverable-toggle/rate plus conversations. Both-side authorization (creator and hotel orgs). Reads (`me/collaborations`, conversations, messages) before lifecycle writes. Rating writes touch `creator_ratings`.                                                                                                                                                                                                                                                                                                                        |
| V5  | **Trips and external collaborations**                     | `/trips*` (9)                                                                                                  | MW         | Creator-facing CRUD, self-contained tables (`trips`, `external_collaborations`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| V6  | **Notifications and newsletter retirement; invite codes** | `/notifications*` (2 retired), `/newsletter/*` (2 retired), `/admin/invite-codes*` + `/api/invite-codes/*` (5) | MW, VA, BA | VAY-800 and [`marketplace-v6-notifications-newsletter-invite-contract.md`](marketplace-v6-notifications-newsletter-invite-contract.md) record the disposition. Notification HTTP routes remain retired while notification history migrates. The newsletter UI, routes, scheduler, and sender were retired on 2026-07-24; historical preferences remain migration data and VAY-1029 tracks a future engagement redesign. Invite-code admin CRUD (VA) plus public lookup/redeem consumed by booking-admin's setup flow (`apps/booking-admin/app/setup/page.tsx`) remain the active cutover scope. |
| V7  | **Marketplace admin**                                     | `/admin/collaborations*` (3), `/admin/users/{id}/listings*` (3)                                                | VA         | Admin actions on marketplace-owned resources, after the self-service verticals stabilize the contracts they reuse. Admin authorization moves to platform-organization membership checks per WorkOS architecture (superadmin flag as transition fallback).                                                                                                                                                                                                                                                                                                                                       |

### Routes to retire or merge instead of port

- `/auth/*` password, TOTP, reset, and verification flows — retired by WorkOS
  (see above), not rewritten in TypeScript.
- `POST /contact` — merged into platform intake.
- `/upload/*` — replaced by the platform media decision, not ported per
  product.
- `GET /notifications` and `POST /notifications/{id}/read` — not ported in V6
  because no frontend consumer exists. Notification data still migrates to
  marketplace-owned `marketplace_notifications`; add a new route contract only
  when a notification-center consumer is scoped.
- Any V1 response fields that exist only because the legacy endpoint serialized
  ORM rows directly: the V1 contract defines the public-safe shape from the
  read model, and undocumented fields are dropped there rather than carried
  forward.

## Vertical order rationale

1. Read paths before writes, per the contract-migration standard already proven
   on booking settings.
2. V1 has no authenticated context, so it does not depend on the WorkOS track
   and exercises the marketplace route group, contract docs, parity fixtures,
   and two frontend clients with minimal risk.
3. V2/V3 establish the organization/resource-link authorization shape for
   marketplace before V4 needs it on both sides of a collaboration.
4. V4 is the product core and the riskiest surface; it goes after the
   profile verticals prove scoping, and its reads land before lifecycle writes.
5. V5/V6 are low-coupling cleanups that can interleave with other tracks.
6. V7 waits for the contracts it administers.

## First-vertical follow-up tickets

Per the planning-first rule, only V1 tickets are created with this audit:

1. Define marketplace discovery read contracts (listings + creators).
2. Implement marketplace discovery routes in `apps/api`.
3. Add discovery clients and cut over marketplace-web, vayada-admin, and
   landing.

V2+ tickets are created when their predecessor vertical is accepted.

## References

- VAY-737: this audit.
- VAY-674: marketplace target schema DDL.
- VAY-693: marketplace transform slice.
- `engineering/frontend-backend-contract-migration.md` — vertical pattern.
- `engineering/target-schema-ownership-map.md` — marketplace table ownership.
- `engineering/workos-identity-architecture.md` — auth retirement and
  organization resource links.
- `engineering/identity-user-lifecycle-commands.md` — admin user write surface.
