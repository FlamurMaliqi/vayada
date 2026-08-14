# Target TypeScript backend structure

_VAY-602 decision record. Inputs: VAY-600 WorkOS identity architecture,
VAY-601 Ask Intelligence architecture, and VAY-604 AI-agent bookability
recommendation. Updated after VAY-605 selected a planned big-bang database
rewrite._

> **Retirement update:** VAY-601 is a historical input only. Migration `0090`
> removes the retired Ask Intelligence schema. Any future hotel employee agent
> starts with the VAY-1091 design spike and must define a new runtime and
> storage model.

## Recommendation

Move Vayada toward a **TypeScript modular backend**, not a direct port of the
current FastAPI files and not a premature microservice split.

The target should be one cohesive backend codebase with explicit domain modules,
shared infrastructure packages, product API adapters, and compatibility facades
for old frontend/public routes during migration.

The code migration can still be incremental, but the database rewrite should be
planned as a coordinated target-schema cutover per VAY-605. Python services
should keep serving production traffic against the current databases until the
target schema, legacy-to-target migration pipeline, application cutover branch,
staging rehearsals, validation gates, and rollback window are ready.

The backend structure should be organized around these principles:

- WorkOS owns provider authentication and provider organization membership
  state; Vayada owns internal users, organizations, resource links,
  permissions, product authorization, billing entitlements, and product audit.
- Every authenticated request resolves a typed `RequestContext` before domain
  code runs: user, selected organization, memberships, permissions, linked
  product resources, locale, currency, and request/audit metadata.
- Product domains expose typed application services. Routers/controllers should
  translate HTTP to domain calls, not contain business rules, SQL, emails,
  third-party side effects, and response shaping in one file.
- Cross-domain access happens through typed domain interfaces or read models,
  not by one product directly opening another product's database pool.
- The TypeScript backend should be built against the target domain model and
  target schema contracts, with compatibility adapters for old HTTP/frontend
  shapes. It should not encode current product database boundaries as
  permanent architecture.
- Background work uses explicit job/event infrastructure with idempotency,
  retries, failure visibility, and audit links. Avoid untracked
  `asyncio.create_task`-style side effects.
- Public AI bookability is a distribution domain. A future hotel employee agent
  is deferred to VAY-1091 and is not a current backend domain.
- Preserve existing public URLs and frontend contracts through compatibility
  adapters until the frontend has moved to the new contracts.
- Preserve the Booking Engine / PMS split defined in
  `engineering/booking-pms-domain-boundaries.md`: Booking Engine owns
  guest-facing checkout and direct-booking contracts; PMS owns operational
  inventory, reservations, room assignment, and channel connectivity. Vayada PMS
  is one PMS implementation, not the Booking Engine backend.

## Current backend pain points

The existing FastAPI backend is functional but its structure makes the WorkOS
and AI decisions harder to implement safely:

- Auth and authorization are duplicated across `marketplace-api`,
  `booking-api`, and `pms-api`. Each service validates shared JWTs and checks
  `users.type` / `is_superadmin` in slightly different ways.
- Multi-hotel selection relies on `X-Hotel-Id` headers, context variables, and
  fallback-to-first-hotel behavior. This is a compatibility mechanism, not a
  durable organization/resource authorization model.
- Product services directly open other product databases. Examples include PMS
  reading booking-engine hotel identity/payment data, booking-api reading PMS
  billing data, and marketplace-api reading PMS affiliate data.
- Database ownership is currently split by historical product app rather than
  by the target domains needed for WorkOS, bookability, finance, jobs, and
  audit. VAY-605 therefore makes database restructure a coordinated
  cutover program, not an endpoint-by-endpoint table patch.
- Large routers and services mix responsibilities. Current examples include
  `apps/pms-api/app/services/booking_service.py`,
  `apps/pms-api/app/routers/admin_bookings.py`,
  `apps/marketplace-api/app/routers/collaborations.py`, and
  `apps/marketplace-api/app/routers/hotels.py`.
- Side effects such as email sending, Channex ARI pushes, notifications, and
  cancellation handling are often launched inline or fire-and-forget. Failures
  are hard to observe, retry, or link to the originating action.
- The public booking surface is split between booking-api, PMS public room
  endpoints, and PMS booking endpoints. This works for Vayada frontends but is
  not a stable external bookability contract for AI agents or partners.
- Analytics and setup-completeness signals still need clear domain-owned read
  models.

## Target shape

### Deployable apps

Start with one TypeScript backend app and keep deployment boundaries simple:

```text
apps/api
  src/http
  src/domains
  src/jobs
  src/integrations
  src/platform
```

This app can expose route groups for existing products:

```text
/api/marketplace/*
/api/booking/*
/api/pms/*
/api/platform/*
/api/ai/*
```

Product subdomains such as `api.marketplace.localhost`,
`api.booking.localhost`, and `api.pms.localhost` can route to the same backend
app during or after migration. The API boundary should be logical first. Split
into separate deployable services only when there is operational pressure such
as scaling, ownership, compliance, or release isolation.

This app should be able to run against target-schema fixtures and staging target
databases before production cutover. Legacy Python APIs may continue serving
production until the cutover, but new TypeScript domain code should express the
target model rather than mirror the old database layout.

If the team later wants separate deployables, keep them thin:

```text
apps/marketplace-api-ts
apps/booking-api-ts
apps/pms-api-ts
apps/platform-api-ts
```

Those apps should import the same domain packages rather than copying
authorization, database, jobs, or integration code.

### Shared packages

Recommended shared packages:

```text
packages/backend-config
packages/backend-db
packages/backend-http
packages/backend-auth
packages/backend-authorization
packages/backend-audit
packages/backend-events
packages/backend-observability
packages/backend-test
packages/backend-migration
packages/domain-identity
packages/domain-hotels
packages/domain-booking
packages/domain-pms
packages/domain-marketplace
packages/domain-finance
packages/domain-distribution
```

Package responsibilities:

- `backend-config`: environment parsing, secret references, product URLs, and
  runtime feature flags.
- `backend-db`: typed DB clients, transaction helpers, migrations interface,
  advisory locks, read/write connection roles, and test fixtures.
- `backend-http`: request parsing, response envelopes, errors, pagination,
  idempotency, cache headers, CORS, and route registration helpers.
- `backend-auth`: WorkOS session verification, provider identity mapping, and
  webhook ingestion.
- `backend-authorization`: internal organization membership, product
  permissions, resource links, selected organization/resource resolution, and
  policy checks.
- `backend-audit`: product audit events with actor, organization, resource,
  action, before/after, correlation ID, and source.
- `backend-events`: durable domain events/jobs with retries, idempotency keys,
  dead-letter visibility, and typed handlers.
- `backend-observability`: logs, traces, metrics, health/readiness, and
  correlation IDs.
- `backend-test`: builders, fake WorkOS/session contexts, test DB utilities,
  contract fixtures, and HTTP test helpers.
- `backend-migration`: target-schema DDL entry points, legacy-to-target
  migration helpers, parity checks, fixture loaders, and cutover validation
  harnesses.

Domain packages should own business language and application services. They
should not import HTTP routers. HTTP adapters import domains, never the reverse.

### Request context

Every authenticated route should receive a resolved context:

```text
RequestContext
  requestId
  actor
    internalUserId
    workosUserId
    email
    status
  selectedOrganization
    organizationId
    workosOrgId
    kind
    membershipId
    roleKey
    permissions
  resources
    hotelGroupIds
    bookingHotelIds
    pmsHotelIds
    marketplaceHotelProfileIds
    creatorProfileIds
    affiliateIds
  locale
  currency
  source
```

The context replaces these old patterns:

- direct `users.type` checks in routers
- `is_superadmin` as the main platform authorization gate
- `X-Hotel-Id` as an authorization primitive
- "first hotel for this user" fallback behavior
- duplicate JWT parsing per product app

`X-Hotel-Id` can remain as a compatibility input during migration, but it must
resolve into a selected organization/resource through
`backend-authorization`. Domain code should not read the header directly.

## Domain modules

### Identity and authorization

Owns:

- internal users
- external identities
- internal organizations
- organization memberships
- organization resource links
- product permissions
- product entitlements
- WorkOS webhook reconciliation
- selected organization/resource resolution

In the target schema, `users.type`, `is_superadmin`, and product `user_id`
ownership columns are migration inputs only. They should not survive as
authorization primitives in TypeScript domain services.

Retire:

- product-specific auth dependency copies
- long-term authorization by email, `users.type`, or `is_superadmin`
- direct user-to-hotel ownership checks scattered through routers

Preserve:

- stable internal user IDs
- existing product resource IDs
- compatibility for current JWT/cookie sessions until the WorkOS/session cutover
  is ready

### Hotels and property content

Owns shared hotel/property facts used by marketplace, booking, PMS, and AI:

- hotel identity, slug, canonical names, previous slug history
- address, geo, timezone, country, descriptions, amenities, images
- branding, supported languages/currencies, social/contact data
- setup completeness and freshness signals
- resource links from hotel groups to product-specific hotel records

This domain should provide canonical read models rather than letting PMS,
booking-api, and marketplace-api keep duplicating hotel identity reads.

VAY-605 should define whether this is one physical target database with schemas
per domain or multiple physical databases cut over together. Either way,
TypeScript should model canonical property identity explicitly instead of
choosing one current product table as permanent source of truth.

### Booking and direct checkout

Owns guest-facing direct-booking behavior:

- public hotel booking profile
- room/rate quote and checkout deep-link generation
- booking request/create flow
- payment authorization/capture coordination
- guest booking lookup/status/cancellation/change requests
- promo/referral/add-on application
- booking idempotency and quote expiration

Preserve:

- existing guest booking status semantics
- current public booking URLs during migration
- Stripe/Xendit/manual payment behavior behind compatibility adapters

Redesign:

- extract quote calculation into a deterministic application service
- separate payment orchestration from booking persistence
- publish booking events for email, Channex, metrics, and affiliate handling

Boundaries:

- do not read or write PMS operational tables directly;
- do not import Channex integration code;
- interact with PMS through the reservation sink and operational read contracts
  in `engineering/pms-reservation-integration-contract.md`, or through a typed
  domain event;
- treat Vayada PMS and external PMS systems as interchangeable implementations
  behind the PMS boundary.

### PMS operations

Owns hotel operations:

- rooms and room types
- rates, seasons, min/max stay, occupancy rates, and availability
- room assignment and room blocks
- admin-created bookings
- check-in/check-out flows
- messaging, notes, financial views, payouts
- Channex ARI and inbound channel-manager sync

Retire:

- one huge `booking_service` as the center of all booking, email, payment,
  Channex, and policy logic
- untracked fire-and-forget side effects

Preserve:

- existing PMS data semantics through the target migration, not the current PMS
  table layout as permanent architecture
- Channex integration behavior and channel mapping semantics
- existing admin route compatibility while frontends migrate

Boundaries:

- do not own public checkout conversion or quote/session contracts;
- do not make direct-booking payment, promo, or guest-facing status rules
  operational PMS state unless consumed through Booking/Finance read models or
  events;
- keep Channex code behind PMS connectivity contracts so Booking Engine does
  not couple to a specific channel manager.
- expose PMS reservation sink and operational reservation read ports that Vayada
  PMS, external PMS adapters, and test fakes can all implement.

### Marketplace and collaborations

Owns:

- creators and creator profiles
- marketplace hotel profiles/listings
- collaboration offerings, deliverables, lifecycle, ratings, notifications
- trips and public marketplace browsing
- marketplace admin moderation flows

Redesign:

- move long router logic into application services
- treat PMS/booking facts as read models or domain interfaces rather than
  direct cross-database queries

### Finance, billing, and payouts

Owns:

- product subscription and module entitlements
- platform fees, affiliate commissions, property payouts
- payment provider configuration and account readiness
- payout settings and payout runs

This domain must expose stricter permissions than operational booking summaries.
Any future hotel employee agent designed through VAY-1091 must use those same
explicit finance permissions.

### Distribution and AI bookability

Owns public machine-readable bookability:

- `GET /api/ai/hotels/{slug}` bookability profile
- `GET /api/ai/hotels/{slug}/quote` live quote endpoint
- structured response schema for external agents, partner feeds, and future MCP
- freshness, cache, rate-limit, and typed unavailable reasons
- canonical booking/deep-link URLs

This domain is public read-only and must not expose guest PII, tenant-private
operational data, unpublished rates, internal commissions, or owner-only setup
details.

Without this domain, AI assistants can only discover and link to Vayada hotel
pages. With this domain and checkout deep links, assistants can verify live
availability, price, and policy before sending the guest into a Vayada checkout
flow.

### Retired Intelligence domain

The VAY-601 Ask Intelligence domain is retired and migration `0090` removes its
schema and stored data. Do not recreate its API, runtime, tools, traces, or
audit model in this backend structure. VAY-1091 owns any future hotel employee
agent design.

## Data access and cutover model

Keep database ownership explicit while preparing the big-bang cutover:

- A domain owns writes to its authoritative tables.
- Other domains consume either typed application services, read models, or
  events.
- Legacy cross-database reads are treated as source extraction or temporary
  compatibility only, not as the target integration pattern.
- New TypeScript code should target the VAY-605 schema contracts and should not
  introduce raw cross-product DB pools as normal domain integration.

Recommended cutover bridge:

```text
Python FastAPI services
  -> existing DBs and routes until cutover

TypeScript backend
  -> target domain services
  -> target-schema fixtures/staging DB before production
  -> compatibility HTTP routes for existing frontend/public contracts

Migration pipeline
  -> extract from auth/marketplace/booking/PMS
  -> transform into target schema
  -> validate parity before production cutover
```

The goal is not to port each FastAPI table access pattern into TypeScript. The
goal is to design the target domain model and target database contracts, build
the migration pipeline, rehearse the cutover, then switch application traffic in
one coordinated release.

## Old shapes to retire, preserve, redesign

Retire:

- duplicated JWT/TOTP/password logic in product APIs after WorkOS migration
- direct product authorization with `users.type` and `is_superadmin`
- `X-Hotel-Id` as hidden global state in domain logic
- product services opening each other's database pools as normal behavior
- large routers that contain business rules and SQL
- fire-and-forget side effects without job identity, retry, or audit
- frontend-only public booking contracts as the external AI/partner contract

Preserve:

- internal Vayada user IDs and product resource IDs
- current guest checkout and booking lifecycle semantics
- existing public booking URLs through redirects or compatibility adapters
- existing production databases as source of truth until the VAY-605 cutover
  window
- Channex, Stripe, Xendit, email, affiliate, and marketplace integration
  behavior while moving orchestration behind typed services
- local portless hostnames and app paths during migration

Redesign:

- authentication/session handling around WorkOS plus internal identity mappings
- organization/resource authorization around explicit memberships and links
- booking quote/creation/payment as separate services with idempotency
- PMS side effects as domain events/jobs
- hotel setup completeness as a shared read model
- analytics/metrics as domain-owned read models
- public AI bookability as a first-class distribution API

## First implementation tickets

These are the smallest useful follow-ups after this decision:

1. **Scaffold TypeScript backend app and shared backend packages**
   - Create `apps/api` with health/readiness routes and route-group structure.
   - Add `packages/backend-config`, `backend-http`, `backend-db`, and
     `backend-test`.
   - Validation: build, typecheck, one HTTP test, and local portless route.

2. **Define target-schema boundaries and migration harness**
   - Convert the VAY-605 ownership map into target-schema contracts for
     identity, hotel catalog, booking, PMS, marketplace, finance,
     distribution, and jobs/audit.
   - Add migration/parity harness interfaces to `backend-migration`.
   - Validation: target-schema contract fixtures and source-to-target mapping
     tests for representative records.

3. **Define RequestContext and authorization contract**
   - Add TypeScript types and tests for actor, organization, membership,
     permissions, and linked resources.
   - Include compatibility inputs for current JWT/cookie and `X-Hotel-Id`, but
     resolve them into the target organization/resource model.
   - Validation: unit tests for allowed/denied hotel resource resolution.

4. **Implement public AI bookability profile contract**
   - Add a read-only profile endpoint or contract test using target bookability
     fixtures.
   - Return hotel identity, canonical URLs, capabilities, completeness, and
     freshness.
   - Validation: contract tests and no guest/private fields.

5. **Implement quote service contract**
   - Extract a deterministic quote shape for dates, guests, room count, rates,
     policies, payment capabilities, and booking URL.
   - Validate parity with existing PMS/booking behavior through migration
     fixtures and staging rehearsals.
   - Validation: tests for sold out, min/max stay, same-day cutoff, and payment
     not configured.

6. **Design the future hotel employee agent in VAY-1091**
   - Start from current hotel employee workflows and authorization needs.
   - Do not reuse the retired Ask runtime, contracts, fixtures, or schema.
   - Validation: reviewed design before any implementation ticket.

7. **Move one side-effect path to jobs/events**
   - Pick a narrow booking side effect, such as email after booking status
     change or Channex ARI push after room block.
   - Add idempotency, retry, dead-letter visibility, and audit correlation.
   - Validation: unit test retry/idempotency behavior and one integration test.

8. **Write application cutover runbook for the TS backend**
   - Define which Python routes remain until cutover, which TypeScript routes
     replace them, deploy order, config flags, target DB readiness checks, and
     rollback behavior.
   - Validation: tabletop runbook review and staging smoke against target schema.

## Open decisions before implementation planning

VAY-603 should resolve these before committing to a full roadmap:

- TypeScript runtime/framework: choose the HTTP framework and whether the first
  deployable is `apps/api` or product-specific TS API apps.
- Database tooling: pick migration and query tooling for TypeScript
  (`node-postgres` plus typed query generation, Prisma, Drizzle, Kysely, or
  another option).
- Big-bang database topology: decide whether the target is one physical database
  with schemas per domain or multiple physical databases cut over together.
- Job/event infrastructure: choose the first durable job mechanism compatible
  with ECS/local dev.
- WorkOS rollout sequencing: decide whether WorkOS is part of the same cutover
  or whether the TS app supports a short-lived legacy session compatibility
  layer against the target identity model.
- Source of truth for hotel identity: decide the target shared hotel/property
  model and source-to-target transforms from current booking/PMS/marketplace
  tables.
- AI provider/runtime: choose the agent runtime and storage shape after the
  evidence tools are defined.
- Public AI terms/rate limits: define external client limits, cache policy, and
  acceptable use for bookability APIs.

## What this enables

This target structure gives VAY-603 a concrete implementation-planning base:

- WorkOS can be introduced through one identity/authorization layer rather than
  three duplicated FastAPI dependency stacks.
- Any future hotel employee agent can start from a reviewed VAY-1091 design
  instead of inheriting the retired Ask implementation.
- AI-agent bookability can expose one public quote/bookability contract instead
  of leaking internal booking-api/PMS boundaries.
- Python and TypeScript services can coexist behind compatibility routes while
  the target schema, ETL pipeline, and cutover branch are prepared.
- Backend implementation tickets can be small, testable, and reversible instead
  of one broad "rewrite the backend" epic, while production migration still
  happens as a coordinated VAY-605 cutover.
