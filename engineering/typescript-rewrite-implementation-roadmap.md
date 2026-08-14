# TypeScript rewrite implementation roadmap

_VAY-603 roadmap index. Inputs: VAY-600 WorkOS identity architecture, VAY-601
Ask Intelligence architecture, VAY-602 target TypeScript backend structure,
VAY-604 AI-agent bookability, and VAY-605 backend database restructure._

> **Retirement update:** VAY-601 and its Ask Intelligence contracts are
> historical inputs only. Migration `0090` removes that schema. Any future
> hotel employee agent starts with the VAY-1091 design spike and must not reuse
> the retired implementation or storage model.

## Purpose

This roadmap explains how Vayada should start the TypeScript backend rewrite
without turning it into one broad implementation epic.

It is intentionally an index, not the full implementation plan. Detailed
contracts, DDL, migration scripts, runtime choices, rollout runbooks, and
product route implementations belong in follow-up tickets and stacked PRs.

## Operating model

- Architecture and contracts come before implementation.
- Prefer stacked PRs with one review question each. Around 400 changed
  non-generated lines is a useful reviewability target, not a hard rule.
- Python FastAPI services remain production source-of-truth until the reviewed
  cutover window.
- New TypeScript code targets the agreed domain model and target-schema
  contracts, not the current product database split.
- The TypeScript target runtime must not depend on legacy product databases or
  Python APIs. Legacy Auth, Marketplace, Booking, and PMS database access is
  allowed only in migration, backfill, parity, rehearsal, and rollback tooling.
- Compatibility means preserving externally required contracts at the HTTP or
  frontend boundary, not wrapping legacy runtime tables or Python services from
  TypeScript domain code.
- WorkOS authentication, Vayada authorization, and public AI bookability are
  separate concerns. A future hotel employee agent is deferred to VAY-1091.

## Phase order

### 0. Guardrails

Goal: make the rewrite process reviewable before implementation starts.

Output:

- shared rewrite workflow skill for agents
- AGENTS.md pointer to stacked PR and architecture-first rules
- PR review expectation for small, single-purpose slices

### 1. Open decision closure

Goal: make the core technology choices explicit.

Decisions to resolve:

- HTTP runtime/framework for `apps/api`
- TypeScript DB query and migration tooling
- target database topology: one physical DB with schemas, or multiple physical
  DBs cut over together
- durable job/event mechanism for ECS and local dev
- WorkOS rollout sequence: same cutover or short-lived legacy session bridge
- future hotel employee agent boundary is deferred to VAY-1091
- public bookability API terms, rate limits, and cache policy

### 2. Core contracts

Goal: define the contracts that product work must use.

Contract slices:

- `RequestContext`: provider identity, internal user, selected organization,
  membership, permissions, linked resources, entitlements, locale, currency,
  and audit metadata
- target schema ownership map for identity, hotel catalog, booking, PMS,
  marketplace, finance, distribution/bookability, jobs, and audit:
  `engineering/target-schema-ownership-map.md`
- migration and parity harness design for target rebuilds, source-to-target
  checks, mismatch reports, and explicit SQL migration application:
  `engineering/migration-parity-harness.md`
- public bookability profile and quote contract:
  `engineering/public-bookability-contract.md`
- no current agent contract; VAY-1091 owns any future hotel employee agent
- jobs/events idempotency, retry, failure visibility, and audit contract

### 3. TypeScript platform scaffold

Goal: create the smallest useful TypeScript backend surface.

Output:

- `apps/api` with health and readiness routes
- route-group structure for marketplace, booking, PMS, platform, and AI
- shared packages for config, HTTP, DB, testing, auth, authorization, audit,
  events, and observability as needed
- build, typecheck, lint, and one HTTP test
- local portless wiring

No product behavior should be ported in this phase.

### 4. Target schema and migration harness

Goal: make target-schema work testable before production data moves.

Output:

- target schema DDL entry points
- local fixture loader
- source-to-target migration inputs and mapping tests for representative
  records; these are the only approved place for TypeScript tooling to read
  legacy product databases before cutover
- row count, uniqueness, checksum, ownership parity, and public/private exposure
  checks where practical
- mismatch reports that are actionable in staging rehearsals

Current status:

- Booking/checkout DDL is merged in VAY-671 through
  `packages/backend-migration/migrations/0005_booking_checkout.sql`.
- Booking source-to-target transforms and parity fixtures remain open; the
  merged DDL only establishes the target tables and migration-runner checks.
- PMS operations is the next open domain DDL slice before finance,
  marketplace, distribution/bookability, and jobs/events/audit.

### 5. Domain implementation slices

Goal: implement one domain capability at a time behind contracts.

Recommended first domains:

- identity and authorization resource resolution
- public bookability profile
- quote contract parity
- one jobs/events side-effect path
- target-backed compatibility routes for externally required frontend/public
  HTTP shapes

Each slice should include contract tests or parity fixtures before product route
coverage expands.

### 6. Staging rehearsals

Goal: prove the target schema, migration pipeline, compatibility routes, and
validation gates work together before production.

Output:

- rebuild target schema from production-like snapshots in staging
- run migration and parity harness
- run API and browser smoke tests against the TypeScript backend using
  target-schema data, with no runtime calls to legacy product databases or
  Python APIs
- document go/no-go gates and owner assignments
- record rollback decision points

### 7. Production cutover

Goal: switch traffic only after rehearsals pass.

Output:

- reviewed maintenance window or write-freeze/queue plan
- backup snapshots and legacy DB retention plan
- final migration command sequence
- validation gate checklist
- deploy order for TypeScript backend, frontend config, and target-backed
  compatibility routes where old response shapes must be preserved
- rollback instructions while the rollback window is open
- post-cutover monitoring and cleanup tickets

## Dependency order

| Before                             | After                                |
| ---------------------------------- | ------------------------------------ |
| Runtime and DB tooling decision    | `apps/api` scaffold                  |
| RequestContext contract            | authenticated product routes         |
| Target schema ownership map        | DDL and migration scripts            |
| Bookability profile/quote contract | public AI bookability implementation |
| Jobs/events contract               | side-effect migration                |
| Migration/parity harness           | staging rehearsal                    |
| Staging rehearsal pass             | production cutover                   |

## First follow-up tickets

These should be created as separate Linear tickets with concrete acceptance
criteria:

1. **Choose TypeScript backend runtime and DB tooling**
   - Decide framework, query tool, migration tool, and test harness.
   - Validation: decision record with tradeoffs and scaffold implications.

2. **Define RequestContext contract**
   - Model actor, organization, memberships, permissions, linked resources,
     entitlements, locale, currency, and audit metadata.
   - Validation: allowed/denied fixture cases for hotel, creator, affiliate,
     and platform scopes.

3. **Define target schema ownership map**
   - Convert the VAY-605 domain ownership plan into table-level ownership and
     source mapping.
   - Validation: every current migration history is represented or explicitly
     deferred.
   - Output: `engineering/target-schema-ownership-map.md`.

4. **Design migration/parity harness**
   - Specify local/staging commands, fixture shape, count checks, mismatch
     reports, and go/no-go failures.
   - Validation: harness design explains how ambiguous ownership and public PII
     leaks fail.
   - Output: `engineering/migration-parity-harness.md`.

5. **Scaffold `apps/api`**
   - Add health/readiness, route groups, minimal shared packages, build,
     typecheck, one HTTP test, and portless wiring.
   - Validation: local build/typecheck/test passes; no product route behavior.

6. **Define public bookability profile and quote contract**
   - Specify public-safe hotel profile, quote request/response, freshness,
     unavailable reasons, and booking deep-link context.
   - Validation: fixtures for bookable, sold out, payment disabled, min/max
     stay, same-day cutoff, promo/referral, and stale data cases.
   - Output: `engineering/public-bookability-contract.md` and
     `engineering/fixtures/public-bookability/cases.json`.

7. **Design the future hotel employee agent in VAY-1091**
   - Start from current hotel employee workflows and authorization needs.
   - Do not reuse the retired Ask Intelligence runtime, contracts, fixtures, or
     schema.
   - Output: a reviewed design spike before any implementation ticket.

8. **Define jobs/events contract**
   - Specify idempotency keys, retry behavior, failure visibility, dead-letter
     handling, audit correlation, and sync/async route boundaries.
   - Validation: fixtures cover side-effect enqueue, duplicate idempotency, and
     dead-letter behavior.
   - Output: `engineering/jobs-events-contract.md` and
     `engineering/fixtures/jobs-events/cases.json`.

9. **Write cutover and rollback runbook**
   - Define coexistence, staging rehearsal gates, maintenance window,
     deployment order, rollback window, and post-cutover monitoring.
   - Validation: tabletop review with explicit go/no-go gates.

## References

- `engineering/workos-identity-architecture.md`
- `engineering/ask-intelligence-architecture.md` (historical, retired)
- `engineering/ai-agent-bookability.md`
- `engineering/typescript-backend-structure.md`
- `engineering/backend-database-restructure.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/migration-parity-harness.md`
- `engineering/public-bookability-contract.md`
- `engineering/ask-intelligence-evidence-contract.md` (historical, retired)
- `engineering/jobs-events-contract.md`
- `.agents/skills/typescript-rewrite-workflow/SKILL.md`
