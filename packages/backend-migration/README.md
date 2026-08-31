# Backend Migration

`@vayada/backend-migration` owns target-schema migrations, local fixture
rebuilds, source-to-target transforms, and parity checks for the TypeScript
backend rewrite.

Deployed `next-api` images run `target:migrate:dist` before starting the HTTP
server. The image embeds its application commit as `APPLICATION_RELEASE`, and
the CLI stores that value in `platform.schema_migrations.git_sha`. See
[`engineering/target-database-deployment-migrations.md`](../../engineering/target-database-deployment-migrations.md)
for normal deployment, verification, and failure recovery.

## Target Manual-Booking Readiness

Run the read-only VAY-1259 gate with a reviewed rehearsal manifest:

```bash
TARGET_DATABASE_URL=<staging target database> \
  npm --workspace @vayada/backend-migration run target:manual-booking:readiness -- \
  --evidence-manifest <manifest.json> --reviewed-sha256 <approved digest> --pretty
```

It reconciles bookings, stays/nights, add-ons, Finance, attribution, causal and
privacy evidence. The fixture matrix covers every payment method in paid/unpaid
states, every add-on model, rates, Email, heterogeneous dates, cancellation, no-show, refund,
stay correction, and price correction. The manifest records the
source snapshot, successful restore rehearsal, cutover review, exact property
cohort, booking IDs and expected target facts. The local bytes must
match the separately supplied reviewed SHA-256, and the CLI runs in a read-only
transaction. Any blocker exits non-zero.

## Full-Fixture Smoke

Use the full-fixture smoke command after updating `main` and before marking
post-merge migration fixture coverage as accepted:

```bash
TARGET_DATABASE_URL=<local scratch target database> \
  npm --workspace @vayada/backend-migration run target:fixtures:smoke -- \
  --confirm-database <scratch database name>
```

The command runs every fixture case registered in `src/cases/registry.ts`. For
each case it drops and recreates the target schemas, applies all reviewed target
migrations, loads that fixture, runs its transform when one is registered, and
then runs parity checks against `expected-target.json`.

Destructive rebuild commands require `--confirm-database` and verify that exact
name against PostgreSQL `current_database()` before dropping any schema.

`target:fixtures:smoke` intentionally does not accept `--fixtures`; it is the
full accepted fixture matrix. Use `target:rebuild` and `target:parity` directly
when you need to debug a single fixture case.

The unit tests compare fixture manifests, registry entries, and the smoke case
list. Adding a fixture manifest without registering it, or changing the smoke
path so it omits a registered case, fails `npm test`.

## Immutable Source Extraction

VAY-1351 stages the four reviewed legacy snapshots without giving normal
application code source-database access. The reviewed manifest contains each
snapshot identifier, database name, and VAY-1350 schema fingerprint; connection
URLs stay in environment variables and never appear in the report.

```bash
npm --workspace @vayada/backend-migration run target:source:extract -- \
  --manifest <reviewed-manifest.json> \
  --source-schema-revision 2d7fe21080646cb1931aac4054a5648bac9b8227 \
  --auth-snapshot-arn <arn> \
  --booking-snapshot-arn <arn> \
  --marketplace-snapshot-arn <arn> \
  --pms-snapshot-arn <arn> \
  --dry-run
```

Remove `--dry-run` only in isolated local, staging, or pre-production targets
after applying migration `0120`. Supply `TARGET_DATABASE_URL` plus
`AUTH_SOURCE_DATABASE_URL`, `BOOKING_SOURCE_DATABASE_URL`,
`MARKETPLACE_SOURCE_DATABASE_URL`, and `PMS_SOURCE_DATABASE_URL`. Source roles
must have direct `SELECT` grants, no role memberships, no write privileges, and
no access to non-system `SECURITY DEFINER` routines. A mutable source tag additionally requires a
reviewed `cutoverFreezeProofSha256` in the manifest and the matching
`--cutover-freeze-proof-sha256` argument.

Before opening the read-only extractor connections, attest each restored source
with database-level settings applied by its administrator. The extractor reads
the settings from `pg_db_role_setting`, so session parameters cannot impersonate
another snapshot:

```sql
ALTER DATABASE <source_database>
  SET vayada.source_snapshot_identifier TO '<reviewed-snapshot-identifier>';
-- Required when the manifest carries a cutover freeze proof:
ALTER DATABASE <source_database>
  SET vayada.cutover_freeze_proof_sha256 TO '<reviewed-sha256>';
```

## Production Identity Migration

VAY-1352 consumes one completed, immutable VAY-1351 extraction run. It maps
legacy users and current consent, ownership, entitlement, and login-audit data
into the target identity model. Password hashes, reset/email tokens, TOTP
secrets/recovery codes, and login-rate-limit rows are reported by count and are
never copied. Existing WorkOS links are validated and preserved; this command
does not call WorkOS or create provider credentials.

Run and review a dry run first. It executes the complete read and reconciliation
inside a repeatable-read transaction, then always rolls back:

```bash
TARGET_DATABASE_URL=<target database> npm run target:identity:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

The report must have no blockers. Review its checksum, counts,
`preservedNewerUsers`, WorkOS identity count, and retired-auth counts against the
approved extraction evidence. Newer target state is preserved; equal-time
disagreement and ambiguous ownership block the apply.

After the reviewed backup, write freeze/queue, dry-run report, and go/no-go
approval, apply that exact run ID with confirmation bound to it:

```bash
TARGET_DATABASE_URL=<target database> npm run target:identity:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-identity:vay1351-<same 24 lowercase hex characters>
```

Apply locks every reconciled target table and fails within five seconds if live
writes prevent the lock. Keep the external write freeze active through commit.

Rerun dry-run and apply with the same run ID and confirm the checksum and counts
are unchanged. Apply is transactional and idempotent; append-only conflicts or
post-write mismatch roll back. Keep the legacy systems available through the
approved rollback window. Identity success alone does not authorize shutdown:
the remaining domain migrations, full VAY-1359 parity, VAY-1360 cutover checks,
and VAY-1363 retirement evidence must also pass.

## Production Hotel Catalog Migration

VAY-1354 consumes the Booking hotel, Booking hotel-translation, PMS hotel, and
Marketplace hotel-profile tables from the same completed, immutable VAY-1351
run. Do not use an older snapshot as a substitute for a fresh extraction and
reviewed freeze proof.

Run this exact dry-run command first:

```bash
TARGET_DATABASE_URL=<target database> npm run target:catalog:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

The dry run always rolls back. The report must have no blockers. Review its
checksum, counts, write count, and every `preservedTarget` row. Newer target
rows and target-owned location or policy revisions are preserved; equal-time,
ownership, canonical-slug, verified-domain, unresolved-media, and malformed
source conflicts block apply. The migration never deletes target-only rows.

After the reviewed backup, source write freeze/queue, dry-run report, and
go/no-go approval, apply that exact run ID:

```bash
TARGET_DATABASE_URL=<target database> npm run target:catalog:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-catalog:vay1351-<same 24 lowercase hex characters>
```

Apply locks the catalog and Platform Media tables, rechecks target freshness,
writes in one repeatable-read transaction, verifies the stored plan, and then
rebuilds the scoped public projection. Migrated contacts and amenities remain
private until explicitly approved in the target. Public media comes only from
an active, approved Platform Media `original_safe` variant; raw legacy URLs and
free-form Marketplace locations are not projected.

Rerun the dry run with the same run ID and confirm the checksum and counts are
unchanged. Keep the legacy systems available throughout the rollback window.
Catalog success does not authorize shutdown: VAY-1355 through VAY-1358,
VAY-1359 full parity, and all remaining cutover and retirement gates must pass.

## Production Booking Migration

VAY-1355 consumes Booking settings, add-ons, funnel events and promo tables plus
PMS bookings, drafts, additional guests, change requests, and promo usage from
the same completed immutable VAY-1351 run. Apply VAY-1354 first so every legacy
Booking/PMS hotel ID resolves through an active canonical Catalog source link.

Run the exact production dry run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:booking:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

The command runs in a repeatable-read transaction and always rolls back. Review
the checksum, source/planned/write counts, preserved newer target rows, preserved
target deletions, and every blocker. A previous provenance link with no target
row is treated as an intentional target-side deletion and is never recreated
from a later legacy snapshot.

Apply is blocked by ambiguous property ownership, orphaned relationships,
unknown lifecycle/payment states, equal-time conflicts, pending promo
reconciliation, unresolved legacy add-on media, and sensitive additional-guest
fields that lack an approved encrypted target contract. Raw legacy media URLs
are never copied. Funnel event PII is private and its audit projection is
redacted with `ai_visible = false`.

After backup, source write freeze/queue, a blocker-free reviewed dry run, and
human go/no-go approval, apply the exact reviewed run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:booking:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-booking:vay1351-<same 24 lowercase hex characters>
```

Apply locks the Booking, audit, and provenance tables, writes in dependency
order, and rereads the target before committing. Unmaterialized drafts remain
quote/checkout history; materialized drafts link through the normal guest
booking path. Private guest input never enters the direct-booking summary read
model. Checkout guest input receives the immutable draft expiry date as its PII
retention deadline. Rerun the dry run with the same ID after apply and require unchanged
checksums/counts. Booking success still does not authorize legacy shutdown:
VAY-1356 through VAY-1363 and the rollback window remain mandatory gates.

## Production PMS Migration

VAY-1356 consumes PMS rooms and rate configuration, exact 366-day inventory,
operational assignments and blocks, guest operations, messages, Channex
mappings, and historical receipts from the same immutable VAY-1351 run. Apply
VAY-1354 and VAY-1355 first so every hotel and booking has canonical target
ownership. Platform Media references must already pass VAY-1055.

Run the exact production dry run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:pms:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

The dry run always rolls back. Review the checksum, per-property source/target
counts, 366-day inventory totals, preserved newer target rows, preserved target
deletions, and every blocker. Equal-time conflicts, orphaned bookings, missing
media, duplicate provider IDs, and unsupported legacy state block apply. Raw
webhook rows are inert receipts: successful legacy processing becomes
`observed`, never a replayable provider job.

After backup, source write freeze/queue, a blocker-free reviewed dry run, and
human go/no-go approval, apply the exact reviewed run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:pms:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-pms:vay1351-<same 24 lowercase hex characters>
```

Apply locks every PMS target table, writes in dependency order inside one
repeatable-read transaction, verifies exact write/provenance counts, and rereads
the target before commit. Rerun the same dry run and require unchanged parity.
PMS success does not authorize legacy shutdown: VAY-1357 through VAY-1363,
the rollback window, and the final human cutover approval remain mandatory.

## Production Marketplace Migration

VAY-1357 consumes creators, offers, collaborations, deliverables, chat, trips,
notifications, invites, and newsletter preferences from the immutable VAY-1351
run. It resolves ownership only through the accepted Identity and Hotel Catalog
links. Every legacy Marketplace image must already resolve to an active VAY-1055
Platform Media object; unresolved or ambiguous media blocks the run.
Legacy offer settings are reported as deterministic, presentation-only hotel
preference drafts. They never write canonical preferences because legacy offers
cannot prove the required content-type answer.

Run the exact production dry run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:marketplace:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

The dry run always rolls back. Review every blocker, source/target table count,
property-scoped count, preserved newer target row, preserved target deletion,
ownership link, and rewritten media reference.

After backup, source write freeze/queue, a blocker-free reviewed dry run, and
human go/no-go approval, apply the exact reviewed run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:marketplace:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-marketplace:vay1351-<same 24 lowercase hex characters>
```

Apply is transactional and verifies the target before commit. Marketplace
success does not authorize legacy shutdown: Finance, VAY-1359 through VAY-1363,
the rollback window, and the final human cutover approval remain mandatory.

## Production Finance Migration

VAY-1358 consumes the exact Booking and PMS Finance rows from the immutable
VAY-1351 extraction. It resolves property, organization, affiliate, and booking
ownership only through accepted earlier migration links. Monetary parity uses
exact decimal arithmetic. The migration never invokes a payment provider and
never turns configuration flags into online-card execution evidence.

Run the exact production dry run:

```bash
TARGET_DATABASE_URL=<target database> npm run target:finance:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --dry-run
```

Any ambiguous owner, duplicate provider identity, invalid amount, newer target
economic fact, unattributed webhook, checkout row lacking encrypted folio
recipient evidence, or payout destination lacking an approved secrets-store
reference is a hard blocker. Resolve every blocker and rerun the same immutable
source run. The legacy extraction has no standalone expense rows and does not
contain the encrypted recipient revisions, invoice identity, or immutable
affiliate-payout command evidence required by the target. The migration never
fabricates those records: affected checkout and completed affiliate-payout rows
remain explicit blockers until reviewed canonical evidence is supplied. Legacy
fixed-plan Stripe subscriptions also remain suspended and block migration until
a reviewed provider cutover rebinds them to the target canonical tiered price
and target property/organization metadata. After
backup, source write freeze/queue, a reviewed blocker-free dry
run, and explicit human go/no-go approval, apply with the run-bound guard:

```bash
TARGET_DATABASE_URL=<target database> npm run target:finance:migrate -- \
  --source-run-id vay1351-<24 lowercase hex characters> --apply \
  --confirm production-finance:vay1351-<same 24 lowercase hex characters>
```

Apply is transactional, locks Finance and its prerequisites, verifies exact
write and provenance counts, then rereads the target before commit. Finance
success does not authorize legacy shutdown: VAY-1359 through VAY-1363, the
rollback window, and final human approval remain mandatory.

## Production Full Parity and Go/No-Go

VAY-1359 aggregates the rollback-only Identity, Hotel Catalog, Booking, PMS,
Marketplace, and Finance dry runs for one immutable extraction. It also verifies
the four source tags against their extraction ledger, source schema fingerprints
and checksums, target migration checksums, target provenance, forbidden PII, and
raw legacy media references. It never repairs data or applies a domain migration.

Run it only with the exact immutable tags recorded for the extraction:

```bash
TARGET_DATABASE_URL=<target database> \
APPLICATION_RELEASE=<deployed exact 40-character Git SHA> \
npm run target:parity -- \
  --source-run-id vay1351-<24 lowercase hex characters> \
  --source-env <local|staging|preprod> \
  --env <staging|preprod|production> \
  --auth-source-tag <exact immutable auth snapshot identifier> \
  --booking-source-tag <exact immutable booking snapshot identifier> \
  --marketplace-source-tag <exact immutable Marketplace snapshot identifier> \
  --pms-source-tag <exact immutable PMS snapshot identifier> \
  --application-release <same deployed exact 40-character Git SHA> \
  --operator <cutover operator> \
  --report json
```

The report contains hashes rather than raw snapshot identifiers and has a
deterministic checksum that excludes run timestamps. `GO` requires zero hard
failures and zero warnings. A warning within an explicitly configured
`--warning-budget` returns `REVIEW`, never automatic approval. Exit code `2`
means `NO-GO`; exit code `3` means human review is still required. Missing
domain results, schema drift, tag mismatch, stale provenance, active booking or
366-day inventory variance, financial variance, PII exposure, and raw legacy
media references are hard failures.

`--source-env` names the environment recorded by the immutable extraction;
`--env` names the target database. They are deliberately separate because a
production target must consume a reviewed `preprod` extraction, while the
extraction ledger only permits `local`, `staging`, or `preprod`. Local, staging,
and pre-production targets require extraction evidence from their matching
environment; a local fixture extraction can never authorize production.

Outside local development, the requested application release must match trusted
`APPLICATION_RELEASE` or `GIT_SHA` deployment metadata. Target schema identity
is independently bound to the migration files in that release through the exact
version set and checksums; it is not incorrectly tied to whichever older release
first applied the latest unchanged migration. Operator identity and all
domain-level IDs, provider references, and blocker evidence are emitted only as
hashes.

The command always discovers migrations from the directory bundled with the
running application. Production parity does not accept a migration-directory
override, so an operator cannot replace the trusted checksum manifest.

The command acquires PostgreSQL `SHARE` locks across target and staged-source
tables for the complete report so its seven readers cannot observe mixed target
states. Run it only inside the approved cutover write-freeze window. It aborts
rather than waiting indefinitely when those locks cannot be acquired within five
seconds.

## Guarded Rehearsal and Cutover Orchestration

VAY-1360 composes the reviewed schema, immutable extraction, six domain apply,
full-parity, and smoke-evidence gates in this fixed order:

```text
schema_migrations -> source_extraction -> identity -> catalog -> booking ->
pms -> marketplace -> finance -> parity -> smoke_evidence
```

The command stores each attempt and evidence checksum in
`platform.production_cutover_runs` and `platform.production_cutover_steps`.
Every completed step is an explicit safe checkpoint because the underlying
schema, extraction, and domain commands are transactional and idempotent. A
failed or interrupted run requires `--resume`; completed steps are not executed
again. The run ID and all guard inputs are immutable, and a PostgreSQL advisory
lock excludes concurrent orchestration.

All run modes require these inputs in addition to the four source database URLs
and `TARGET_DATABASE_URL`:

```text
--run-id vay1360-<24 lowercase hex characters>
--source-run-id vay1351-<24 lowercase hex characters>
--source-env <staging|preprod>
--env <staging|preprod|production>
--manifest <reviewed VAY-1351 manifest.json>
--source-schema-revision <reviewed full Git SHA>
--application-release <deployed full Git SHA>
--operator <operator identity>
--target-clean-proof-sha256 <reviewed clean-target evidence SHA-256>
--freeze-proof-sha256 <reviewed source freeze evidence SHA-256>
--auth-source-tag <exact immutable tag>
--booking-source-tag <exact immutable tag>
--marketplace-source-tag <exact immutable tag>
--pms-source-tag <exact immutable tag>
--confirmation <mode-bound value>
```

The trusted runtime `APPLICATION_RELEASE` or `GIT_SHA` must exactly equal
`--application-release`. Environment pairs are fixed: staging rehearsal uses
staging/staging, dry-run uses preprod/preprod, and production uses
production/preprod.

Before a run, a database administrator must bind the target itself with
database-level settings. The command reads these only from
`pg_catalog.pg_db_role_setting` for the current database and role `0`; session
options cannot spoof them:

```sql
ALTER DATABASE <target_database> SET vayada.target_environment TO '<environment>';
ALTER DATABASE <target_database> SET vayada.target_identity_sha256 TO '<stable target SHA-256>';
ALTER DATABASE <target_database> SET vayada.target_clean_run_id TO '<vay1360 run ID>';
ALTER DATABASE <target_database> SET vayada.target_clean_proof_sha256 TO '<clean-target evidence SHA-256>';
ALTER DATABASE <target_database> SET vayada.target_application_release TO '<deployed full Git SHA>';
```

Production additionally requires
`vayada.target_backup_proof_sha256` to equal the reviewed
`--backup-proof-sha256`. A wrong database, environment, run, release, clean
proof, or production backup proof fails before the advisory lock or any
migration service runs.

Run staging and the isolated pre-production dry-run with confirmations bound to
the exact orchestration and source run IDs:

```bash
npm run target:rehearse:staging -- <common arguments> \
  --confirmation STAGING_REHEARSAL:<vay1360-run-id>:<vay1351-source-run-id>

npm run target:cutover:dry-run -- <common arguments> \
  --confirmation CUTOVER_DRY_RUN:<vay1360-run-id>:<vay1351-source-run-id>
```

Each initial command stops after the `GO` parity checkpoint with status
`AWAITING_SMOKE` and exit code `4`. This is an incomplete, safe state: legacy
remains authoritative and the command has not claimed success. Run the deployed
target API/browser smoke job, save its structured
`production-cutover-smoke.v1` artifact, then resume the same immutable run:

```bash
npm run <same orchestration command> -- <same arguments> \
  --resume \
  --smoke-report <reviewed smoke-report.json>
```

The smoke artifact must bind the run ID, target identity, environment, release,
source run and hashed tags, parity checksum, passed checks, and its recomputed
evidence checksum. Only that second phase can complete `smoke_evidence` and the
orchestration record.

Production additionally requires a reviewed backup, an approved earlier run,
the checksum and explicit `go` decision of that run's parity report, and a
separate approval record:

```bash
npm run target:cutover -- <common arguments> \
  --backup-proof-sha256 <sha256> \
  --approved-run-id <different vay1360 run ID> \
  --approved-run-report <completed preprod dry-run report.json> \
  --approved-report-checksum-sha256 <sha256> \
  --approved-decision go \
  --approval-proof-sha256 <sha256> \
  --approval-report <reviewed approval-report.json> \
  --confirmation PRODUCTION_CUTOVER:<vay1360-run-id>:<vay1351-source-run-id>
```

Before opening a production database connection, the command recomputes the
approved dry-run artifact's evidence checksum and requires its exact run ID,
completed status, `GO` parity decision/checksum, immutable source run/tags,
preprod environment, application release, freeze proof, and completed safe-step
sequence to match the production request. Supplying `--approved-decision go`
without that matching artifact cannot pass the gate.

The separate `production-cutover-approval.v1` artifact binds the approved run
artifact checksum, parity checksum, `GO` decision, the exact production run and
target identity, backup proof, release, source run/tags, freeze proof, hashed
approver identity, and canonical approval time. Its checksum is recomputed and
must equal `--approval-proof-sha256`; a database uniqueness constraint permits
that approval artifact to authorize only one production run. The production
backup proof is independently bound to the target database setting, so neither
approval nor backup can be supplied as an unverified arbitrary hash.

The orchestration deliberately does not drop target schemas. This is the
reviewed safety deviation from the harness's example rebuild command: an
operator must provide the checksum of separately reviewed evidence that the
isolated target was freshly rebuilt and is clean. This avoids putting a broad,
destructive schema-drop operation inside the production-capable command. The
immutable source tags, freshness-preserving domain reconciliation, and final
zero-warning VAY-1359 parity gate prevent an old legacy state from silently
overwriting newer target state.

Application smoke remains a separate target-dependent job, as required by the
migration harness contract. The structured `--smoke-report` links its immutable
result to the exact paused orchestration; this command does not substitute the
destructive local fixture smoke for deployed application smoke.

Inspect SQL checksums and the latest rehearsal without changing data:

```bash
npm run target:migration-status -- --env staging --report json
```

Abort a failed or interrupted run with an exact guard:

```bash
npm run target:cutover:abort -- \
  --run-id <vay1360-run-id> \
  --operator <operator identity> \
  --confirmation ABORT_CUTOVER:<vay1360-run-id>
```

Abort preserves the step evidence and leaves `legacyAuthority` as `legacy`.
None of these commands switches traffic, changes provider dashboards, deletes
source data, or shuts down legacy services. Those actions remain separate
VAY-1361 through VAY-1363 cutover gates.

## Platform Media Parity

`platform-media` is a target-only fixture that pins the registry contract before
source-backed media transforms are implemented. Media migration parity must
track:

- source URL inventory count;
- copied Vayada-managed object count;
- external-reference object count;
- unresolved external URL count;
- public/private object classification count;
- required public image variants: `original_safe`, `large`, `thumbnail`, and
  `blur_preview`;
- forbidden private values in public media objects, variant CDN URLs, or future
  public read models.

Product fixtures that later migrate Booking, Marketplace, or PMS media URLs
should reuse `platformMediaChecks` instead of creating ad hoc media assertions.

## WorkOS Backfill

Bootstrap platform admins from the legacy auth DB before running the WorkOS
backfill. The command imports only legacy `is_superadmin` / `type = 'admin'`
users into the fixed platform organization and leaves hotel/creator/affiliate
resource ETL to the product-specific migration pipeline.

```bash
TARGET_DATABASE_URL=<target database url> \
  LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
    --dry-run
```

Apply mode requires the printed guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
    --apply \
    --confirm platform-identity-bootstrap:v1
```

`--admin-email` grants an already-linked active target user canonical platform
access without opening the legacy auth DB. Deleted same-email users are ignored,
multiple active matches fail closed, and apply confirmation is bound to the
normalized email. Follow `engineering/next-admin-platform-access-repair.md` for
the guarded target/WorkOS repair, deployment, verification, and rollback steps.

Audit the migrated target identity/resource links before a backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:workos:audit
```

The audit exits non-zero when target identity tables are missing or when active
users, organizations, memberships, or required owner resource links are not
ready for AuthKit.

Production API images prune dev dependencies, so one-off ECS tasks should use
the compiled commands:

```bash
npm --workspace @vayada/backend-migration run target:migrate:dist -- --env production
npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- --dry-run
npm --workspace @vayada/backend-migration run target:workos:audit:dist
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- --organization-kind platform --dry-run
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- --email user@example.com --dry-run
```

Use `--email` for one-user migration smoke tests:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_SOURCE_RUN_ID=<completed VAY-1351 run id> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --dry-run
```

Apply mode requires the printed cohort key as a confirmation guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_SOURCE_RUN_ID=<completed VAY-1351 run id> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --apply \
    --confirm email:user@example.com
```

Use `--cohort-manifest <path>` for reviewed batch cohorts. The immutable source
run supplies only the legacy bcrypt hash and verified-email flag needed for the
one-time WorkOS handoff; reset, verification, rate-limit, and MFA state is never
loaded into live target tables. Omit both source options to migrate identities
without importing legacy bcrypt password hashes. The direct legacy auth
connection remains available for pre-VAY-1351 recovery only and cannot be
combined with `--source-run-id`.

## Next Stack Smoke Backfill

VAY-874 and VAY-877 use one targeted command for the production next-route smoke
data. It is intentionally narrow:

- activates the Booking Engine entitlement for smoke booking hotel
  `43303cea-963c-445a-9522-a05145fe0918`;
- adds the marketplace hotel profile owner link and scoped entitlement for the
  selected hotel-group org;
- creates or updates an affiliate-partner org, membership, affiliate resource
  link, and `affiliate-payouts` entitlement for the smoke affiliate user;
- optionally activates Booking Admin Feature Hub module rows in the PMS DB when
  `PMS_DATABASE_URL` is supplied.

Run all reviewed target migrations first so the current role grants and schema
state are present:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:migrate:dist -- --env production
```

Dry-run the smoke backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:next-smoke:backfill:dist -- \
    --dry-run
```

If the command cannot infer the marketplace profile, pass the Vayada resource ID
explicitly:

```bash
--marketplace-hotel-profile-resource-id <marketplace hotel profile resource id>
```

Apply mode requires the printed guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  PMS_DATABASE_URL=<pms database url> \
  npm --workspace @vayada/backend-migration run target:next-smoke:backfill:dist -- \
    --apply \
    --affiliate-organization-id <verified affiliate organization id> \
    --confirm next-smoke-backfill:vay-874-vay-877
```

`PMS_DATABASE_URL` is required in apply mode because the VAY-874 smoke criteria
include the Feature Hub module activation. The command activates the
`affiliates` module for the smoke PMS hotel ID, defaulting to the same UUID as
the booking hotel. Use `--pms-hotel-id <uuid>` if the PMS hotel ID differs, and
repeat `--module-id <id>` to activate a different reviewed module set. Dry runs
may omit `PMS_DATABASE_URL`; apply will fail before committing target identity
changes if PMS or WorkOS readiness blockers remain.

Apply mode does not accept `--affiliate-workos-org-id` or
`--affiliate-workos-membership-id`; those flags are dry-run/audit aids only. The
affiliate org and smoke-user membership must already exist locally and have
verified WorkOS IDs before the smoke backfill applies resource links and
entitlements. If the affiliate org does not exist yet, create the local
affiliate org/membership in a separate reviewed prepare step, complete provider
state with the existing WorkOS command, then rerun the smoke backfill dry-run and
apply with the verified `--affiliate-organization-id`:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email flamur.maliqi2811@gmail.com \
    --apply \
    --confirm email:flamur.maliqi2811@gmail.com
```

The smoke command output documents:

- hotel-group WorkOS org ID;
- booking hotel entitlement status;
- marketplace hotel profile resource ID;
- affiliate-partner WorkOS org ID and WorkOS membership ID;
- affiliate Vayada resource ID and entitlement status.

Validate the emitted IDs with:

```sql
SELECT organization.id::text AS organization_id,
       organization.workos_org_id,
       booking_entitlement.status AS booking_engine_status,
       marketplace_link.resource_id AS marketplace_hotel_profile_resource_id,
       marketplace_entitlement.status AS marketplace_hotel_profile_status
FROM identity.organizations organization
LEFT JOIN identity.product_entitlements booking_entitlement
  ON booking_entitlement.organization_id = organization.id
 AND booking_entitlement.product = 'booking'
 AND booking_entitlement.entitlement_key = 'booking-engine'
 AND booking_entitlement.resource_id = '<booking hotel id>'
LEFT JOIN identity.organization_resource_links marketplace_link
  ON marketplace_link.organization_id = organization.id
 AND marketplace_link.product = 'marketplace'
 AND marketplace_link.resource_type = 'hotel_profile'
 AND marketplace_link.resource_id = '<marketplace hotel profile resource id>'
 AND marketplace_link.status = 'active'
LEFT JOIN identity.product_entitlements marketplace_entitlement
  ON marketplace_entitlement.organization_id = organization.id
 AND marketplace_entitlement.product = 'marketplace'
 AND marketplace_entitlement.entitlement_key = 'marketplace-hotel-profile'
 AND marketplace_entitlement.resource_id = '<marketplace hotel profile resource id>'
WHERE organization.id = '<hotel organization id>'::uuid;

SELECT affiliate_org.id::text AS affiliate_organization_id,
       affiliate_org.workos_org_id,
       membership.workos_membership_id,
       affiliate_link.resource_id AS affiliate_resource_id,
       affiliate_entitlement.status AS affiliate_payouts_status
FROM identity.organizations affiliate_org
JOIN identity.organization_memberships membership
  ON membership.organization_id = affiliate_org.id
 AND membership.user_id = '<affiliate user id>'::uuid
LEFT JOIN identity.organization_resource_links affiliate_link
  ON affiliate_link.organization_id = affiliate_org.id
 AND affiliate_link.product = 'affiliate'
 AND affiliate_link.resource_type = 'affiliate'
 AND affiliate_link.resource_id = '<affiliate resource id>'
 AND affiliate_link.status = 'active'
LEFT JOIN identity.product_entitlements affiliate_entitlement
  ON affiliate_entitlement.organization_id = affiliate_org.id
 AND affiliate_entitlement.product = 'affiliate'
 AND affiliate_entitlement.entitlement_key = 'affiliate-payouts'
 AND affiliate_entitlement.resource_id = '<affiliate resource id>'
WHERE affiliate_org.id = '<affiliate organization id>'::uuid;
```

Run the global audit after the targeted backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:workos:audit:dist
```
