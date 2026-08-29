# Migration and parity harness design

_VAY-610 contract record. Builds on VAY-605, VAY-607, and the target ownership
map in `engineering/target-schema-ownership-map.md`._

## Purpose

The target database rewrite is a rehearsed source-to-target rebuild, not an
in-place production migration. This document defines the harness that later
implementation tickets should build for local fixtures, staging rehearsals,
target SQL migration application, and go/no-go parity checks.

This is a design contract only. It does not implement the runner, write target
DDL, or run a staging rehearsal.

## Non-Negotiables

- Current auth, marketplace, booking, and PMS databases remain source of truth
  until the reviewed cutover window.
- Target schema migrations are reviewed SQL files applied by an explicit
  command. Production target schema migration must not run as an `apps/api`
  container startup side effect.
- The harness validates the VAY-609 ownership map. It must fail when source data
  cannot be mapped to a single authoritative target owner.
- Legacy authorization fields such as `users.type`, `users.is_superadmin`, and
  product `user_id` owner columns are transform inputs only. They are not target
  authorization primitives.
- Reports must be deterministic enough to compare between local fixture runs,
  staging rehearsals, and final cutover dry runs.

## Package and Command Model

Implementation should live in `packages/backend-migration` so it is shared by
local development, staging rehearsal jobs, and final cutover commands.

Recommended structure:

```text
packages/backend-migration
  migrations/
    0001_identity.sql
    0002_catalog.sql
    ...
  fixtures/
    cases/
      representative-hotel/
        manifest.json
        auth.sql
        marketplace.sql
        booking.sql
        pms.sql
        expected-target.json
  src/
    runner.ts
    rebuild.ts
    extract.ts
    transform.ts
    parity.ts
    report.ts
```

Root npm scripts should delegate to package commands:

| Command                                                                                        | Purpose                                                                                                                         | Environment                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `npm run target:migrate -- --env local`                                                        | Apply pending reviewed SQL migrations to an existing local target database.                                                     | Local                                 |
| `npm run target:rebuild -- --fixtures representative-hotel --confirm-database <database-name>` | Drop/recreate the explicitly confirmed local target schema, apply all migrations, load fixture source records, transform, test. | Local                                 |
| `npm run target:parity -- --fixtures representative-hotel --report json`                       | Run parity checks against the local target schema without rebuilding it.                                                        | Local                                 |
| `npm run target:rehearse:staging -- --snapshot <snapshot-id>`                                  | Rebuild a staging target schema from production-like source snapshots and emit a go/no-go report.                               | Staging only                          |
| `npm run target:migration-status -- --env staging`                                             | Print applied SQL migrations, checksums, and latest rehearsal status.                                                           | Local against staging or staging      |
| `npm run target:cutover:dry-run -- --snapshot <snapshot-id>`                                   | Run the production command sequence against an isolated target namespace without switching traffic.                             | Staging/pre-production rehearsal      |
| `npm run target:cutover -- --snapshot <snapshot-id> --approved-run <id>`                       | Final explicit cutover command after backups, write freeze/queue, and human approval.                                           | Production operation, never app start |

Required connection variables:

```text
TARGET_DATABASE_URL
AUTH_SOURCE_DATABASE_URL
MARKETPLACE_SOURCE_DATABASE_URL
BOOKING_SOURCE_DATABASE_URL
PMS_SOURCE_DATABASE_URL
```

Staging and production commands should require explicit `--snapshot` or
`--source-tag` input. They should refuse to run against mutable source databases
unless the cutover runbook has already placed writes into the required frozen or
queued state.

## SQL Migration Runner

The target schema source of truth is reviewed SQL under
`packages/backend-migration/migrations`.

The runner should:

- acquire a Postgres advisory lock before applying migrations;
- run each SQL file in a transaction unless the migration declares otherwise;
- calculate and store a checksum for the exact file contents;
- reject edited migrations whose checksum differs from a previously applied
  version;
- record the Git SHA, environment, runner version, operator, duration, and
  status;
- stop on the first failed migration and preserve the failed ledger row.

Migration ledger table:

| Column             | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `version`          | Ordered migration number, e.g. `0001`.                |
| `name`             | Human-readable migration name from the filename.      |
| `checksum_sha256`  | Hash of the reviewed SQL file.                        |
| `applied_at`       | Timestamp when the migration finished.                |
| `applied_by`       | Local user, CI actor, or production operator.         |
| `environment`      | `local`, `staging`, `preprod`, or `production`.       |
| `git_sha`          | Repository revision used for the run.                 |
| `runner_version`   | Backend migration package version or package Git SHA. |
| `duration_ms`      | Runtime for the migration file.                       |
| `status`           | `applied`, `failed`, or `rolled_forward`.             |
| `failure_reason`   | Error summary when status is `failed`.                |
| `statement_count`  | Optional count of executed SQL statements.            |
| `requires_rebuild` | Marks migrations that are local/staging rebuild-only. |

Recommended table name: `platform.schema_migrations`, unless the topology
decision splits platform ledger state into another schema.

## Fixture Shape

Fixtures should represent source rows, expected target ownership, and parity
expectations in one case directory. Each case should be small enough to inspect
in review but rich enough to prove cross-domain transforms.

`manifest.json` shape:

```json
{
  "caseId": "representative-hotel",
  "description": "One hotel with booking profile, PMS inventory, payments, creator listing, and WorkOS-linked owner.",
  "sourceDatabases": ["auth", "marketplace", "booking", "pms"],
  "expectedOwners": {
    "identity.users": 1,
    "catalog.properties": 1,
    "booking.guest_bookings": 2,
    "pms.room_types": 2,
    "finance.payments": 2,
    "distribution.public_hotel_bookability_profiles": 1
  },
  "expectedFailures": [],
  "publicExposureAllowlist": [
    "distribution.public_hotel_bookability_profiles",
    "distribution.public_room_offer_snapshots",
    "distribution.public_quote_read_models"
  ]
}
```

Minimum fixture cases:

| Case                              | Source areas                    | Purpose                                                                                                               |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `identity-organization-links`     | Auth, booking, PMS, marketplace | Maps users, organizations, memberships, resource links, and entitlements.                                             |
| `hotel-catalog-merge`             | Booking, PMS, marketplace       | Creates one canonical property from product-specific hotel/profile rows.                                              |
| `direct-booking-lifecycle`        | Booking, PMS                    | Migrates guest booking lifecycle, guests, add-ons, public status events.                                              |
| `pms-operations-and-channel-sync` | PMS                             | Covers rooms, rate rules, inventory, room blocks, Channex mappings.                                                   |
| `marketplace-collaboration`       | Marketplace, PMS where needed   | Covers creators, listings, collaborations, deliverables, affiliate links.                                             |
| `finance-reconciliation`          | Booking, PMS, marketplace       | Reconciles payment settings, payments, payouts, commissions, entitlements.                                            |
| `public-bookability`              | Booking, PMS, catalog           | Proves public-safe profile, room offer, quote, and deep-link read models.                                             |
| `jobs-events-audit`               | Auth, booking, PMS, marketplace | Proves event, job, webhook, idempotency, and audit transforms.                                                        |
| `retired-or-deferred-sources`     | Auth, booking, PMS, marketplace | Confirms retired local auth, Lodgify, Beds24, and dropped tables are retained only as allowed audit/source snapshots. |

## Source-To-Target Coverage

The harness must cover every current database area from VAY-609 or explicitly
defer it with rationale in the report.

| Source area                       | Required checks                                                                                                      | Deferral posture                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `auth-db/migrations`              | User count, stable internal IDs, external identity uniqueness, membership/resource-link parity, privacy rows.        | Retired password/TOTP/email-token tables can be snapshot-only.    |
| `apps/marketplace-api/migrations` | Creator/listing/collaboration/chat/trip counts, status distributions, listing owner links, notification disposition. | Removed local auth tables are historical only.                    |
| `apps/booking-api/migrations`     | Hotel profile/config counts, slug uniqueness, add-on/promo mapping, commission history, platform/billing fields.     | Dropped Lodgify state is audit-only unless a dependency is found. |
| `apps/pms-api/migrations`         | Hotel/room/rate/inventory/booking/payment/payout/channel/message/note/setup counts and ownership links.              | Dropped Beds24 and old messaging tables are audit-only.           |

## Parity Checks

Core checks:

- source and target row counts by owner domain and table group;
- uniqueness for internal IDs, external provider IDs, slugs, resource links,
  booking references, payment provider IDs, channel mappings, and WorkOS IDs;
- checksums where rows have stable ordered projections;
- status distribution parity for bookings, collaborations, payouts, payments,
  platform status, channel sync, jobs, and audit events;
- ownership parity from source `user_id`-style fields into organizations,
  memberships, entitlements, and resource links;
- financial totals for payments, payouts, commissions, deposits, and balances;
- public/private exposure checks for distribution and AI-readable read models;
- tenant-scope checks for finance visibility;
- idempotency checks proving a local/staging rebuild can be rerun from the same
  source snapshot with the same target output.

Checksum projections should exclude volatile columns such as `updated_at`,
runner timestamps, generated target IDs when source IDs are not preserved, and
provider webhook receipt metadata that is intentionally normalized.

## Failures Versus Warnings

| Finding type                                                                                                               | Severity | Result                                              |
| -------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------- |
| Ambiguous ownership for a migrated user, organization, property, booking, creator, affiliate, payment, or channel mapping. | Fail     | Stop run and require transform or source cleanup.   |
| Any critical source row missing from a non-deferred target owner group.                                                    | Fail     | Block rehearsal/cutover.                            |
| Target uniqueness violation or duplicate external provider ID.                                                             | Fail     | Block rehearsal/cutover.                            |
| Public read model exposes guest PII, private owner settings, payout data, internal notes, or unpublished inventory.        | Fail     | Block rehearsal/cutover.                            |
| Finance total mismatch outside configured zero/rounding tolerance.                                                         | Fail     | Block rehearsal/cutover.                            |
| Booking status distribution mismatch for active/future bookings.                                                           | Fail     | Block rehearsal/cutover.                            |
| WorkOS/internal identity link cannot be resolved for active users.                                                         | Fail     | Block rehearsal/cutover.                            |
| SQL migration checksum differs from the applied ledger.                                                                    | Fail     | Refuse migration application.                       |
| Missing optional profile/media/amenity fields with no product-critical behavior.                                           | Warn     | Include owner and source row IDs in report.         |
| Retired source rows present only in allowed audit/snapshot disposition.                                                    | Warn     | Confirm retention owner and do not block.           |
| Checksum unavailable because the source table has unstable projection.                                                     | Warn     | Require count and domain-specific parity instead.   |
| Non-critical historical status distribution mismatch on canceled/archived records.                                         | Warn     | Requires explicit owner sign-off before cutover.    |
| Rows skipped due to documented source corruption or deleted external dependency.                                           | Warn     | Requires linked cleanup issue or accepted deferral. |

Staging and production dry-run commands should exit non-zero on any `Fail`.
Warnings exit zero only when they are below the configured warning budget and
each warning has an owner.

## Mismatch Report Format

Every harness run should write a machine-readable JSON report and a concise
Markdown summary.

JSON top-level shape:

```json
{
  "runId": "2026-06-04T08-30-00Z-representative-hotel",
  "environment": "local",
  "gitSha": "abc123",
  "sourceSnapshot": "fixture:representative-hotel",
  "targetSchema": "vayada_target",
  "startedAt": "2026-06-04T08:30:00Z",
  "finishedAt": "2026-06-04T08:31:12Z",
  "status": "failed",
  "summary": {
    "failures": 1,
    "warnings": 2,
    "checkedSourceAreas": ["auth", "marketplace", "booking", "pms"]
  },
  "mismatches": [
    {
      "severity": "fail",
      "code": "PUBLIC_PII_EXPOSURE",
      "owner": "Distribution/bookability",
      "sourceArea": "pms",
      "sourceTable": "bookings",
      "sourcePrimaryKey": "booking_123",
      "targetObject": "distribution.public_quote_read_models",
      "message": "Guest email appeared in public quote read model.",
      "expected": "field omitted",
      "actual": "field present",
      "suggestedAction": "Remove guest_email from public projection and add fixture coverage."
    }
  ]
}
```

Markdown summary should include:

- command and environment;
- source snapshot ID;
- target schema/namespace;
- applied migration versions and checksums;
- pass/fail counts by source area and target owner;
- top failures with source IDs and target objects;
- warning budget status;
- explicit go/no-go result.

## Staging Rehearsal Gates

A staging rehearsal passes only when:

- target schema rebuild starts from a clean namespace;
- all reviewed SQL migrations apply with matching checksums;
- all four source areas are loaded from the declared snapshot;
- all failure-severity parity checks pass;
- warning count is within the configured budget and each warning has an owner;
- the report includes applied migration ledger output;
- application smoke tests that depend on the target schema are run separately
  and linked from the rehearsal record.

The rehearsal should produce an immutable run artifact under a predictable path,
for example:

```text
artifacts/migration-parity/<run-id>/
  report.json
  summary.md
  schema-migrations.json
  source-counts.json
  target-counts.json
```

## Production Cutover Constraint

Production target migration is a reviewed operation with backups, a declared
source snapshot, a write freeze or write queue, and a go/no-go owner. It is not
part of the `apps/api` boot path and must not be hidden in ECS container
startup.

`apps/api` readiness can check that the expected target migration version is
present before serving traffic. It must not apply missing production target
migrations itself.

## Implementation Ticket Readiness

The implementation ticket can start when:

- target DDL entry point path is chosen;
- first fixture case is selected;
- `packages/backend-migration` scaffold exists or is in the same narrow PR;
- local Postgres target database naming is agreed;
- staging snapshot source and access pattern are defined;
- each fail/warn code has an owner and test fixture.
