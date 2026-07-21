# C1 staging rehearsal evidence tooling

_Originally created for VAY-793 dashboard/check tooling and replay fixtures.
VAY-794 rehearsal evidence is appended below as each staging gate is executed._

## Dashboard/check command

VAY-794 used a disposable rehearsal-specific target database for these checks:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

The command returns one JSON report with these checks:

| Check id                          | Evidence covered                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `provider_receipt_counts`         | `external_webhook_events` receipt counts by provider, event type, delivery status, and domain. |
| `provider_dedupe_hits`            | Idempotency keys seen more than once by provider and operation scope.                          |
| `job_lag_by_provider_domain`      | Pending/running target job lag by provider and domain.                                         |
| `job_failures_by_provider_domain` | Failed, timed-out, canceled, and dead-lettered job/attempt counts by provider and domain.      |
| `dead_letters_by_provider_domain` | Dead-letter counts by provider, domain, source kind, recovery status, and reason.              |
| `legacy_scheduler_frozen_state`   | Latest audit proof for every legacy PMS scheduler row in the C1 freeze matrix.                 |

The scheduler check expects one `platform.product_audit_events` row per legacy
scheduler job. The target table requires the audit key, product/action,
occurred time, tenant scope, actor type, target resource, payload JSON, retention,
and privacy fields. Use this frozen-scheduler evidence template after operators
confirm each legacy scheduler is frozen, disabled, or blocked for the rehearsal:

```sql
\set rehearsal_id 'c1-staging-rehearsal-YYYYMMDD'
\set correlation_id 'c1-staging-rehearsal-YYYYMMDD'

WITH required_jobs(job_id, owner) AS (
  VALUES
    ('expire_pending_bookings', 'PMS operator'),
    ('cancel_stale_unpaid_bookings', 'PMS operator'),
    ('cleanup_expired_drafts', 'PMS operator'),
    ('process_property_payouts', 'Finance operator'),
    ('process_affiliate_payouts', 'Finance operator'),
    ('poll_xendit_processing_payouts', 'Finance operator'),
    ('poll_channex_bookings', 'PMS operator'),
    ('full_channex_ari_sync', 'PMS operator'),
    ('advance_calendar_auto_open_windows', 'PMS operator')
)
INSERT INTO platform.product_audit_events (
  audit_key,
  product,
  action,
  action_version,
  occurred_at,
  tenant_scope,
  actor_type,
  target_resource_product,
  target_resource_type,
  target_resource_id,
  correlation_id,
  causation_id,
  redacted_payload,
  private_payload,
  audit_metadata,
  retention_class,
  privacy_scope,
  ai_visible
)
SELECT
  format('c1:%s:legacy-scheduler:%s:freeze-checked', :'rehearsal_id', job_id),
  'platform',
  'legacy.scheduler.freeze.checked',
  1,
  now(),
  'platform',
  'system',
  'platform',
  'legacy_scheduler_job',
  job_id,
  :'correlation_id',
  :'rehearsal_id',
  jsonb_build_object(
    'job_id', job_id,
    'expected_state', 'frozen',
    'actual_state', :'actual_state'
  ),
  '{}'::jsonb,
  jsonb_build_object(
    'job_id', job_id,
    'expected_state', 'frozen',
    'actual_state', :'actual_state',
    'owner', owner,
    'rehearsal_id', :'rehearsal_id',
    'evidence_source', 'operator-confirmed-freeze'
  ),
  'standard',
  'internal',
  FALSE
FROM required_jobs
ON CONFLICT (product, audit_key) DO NOTHING;
```

Set `actual_state` to `frozen`, `disabled`, or `blocked`; those values pass.
Missing rows or any other state are reported in the summary.

## Replay fixtures

Fixtures live in
[`engineering/fixtures/c1-staging-rehearsal-replay`](fixtures/c1-staging-rehearsal-replay)
and include:

- Channex message and booking revision samples.
- Stripe `payment_intent.succeeded` and Connect `account.updated` samples.
- Xendit invoice paid and payout succeeded samples.

List fixtures:

```bash
node scripts/c1-rehearsal-replay-fixtures.mjs --list
```

Dry-run a provider:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=https://api.staging.example.test \
  node scripts/c1-rehearsal-replay-fixtures.mjs --provider stripe --twice
```

`--send` is guarded so synthetic fixtures cannot be posted to arbitrary hosts.
Dry runs do not need host approval. Real sends are allowed only for local hosts
by default (`localhost`, `*.localhost`, `127.0.0.1`, `::1`). Remote staging
sends must set `C1_REHEARSAL_ALLOW_SEND_TO_HOST=<host>` to allow one exact host
for the run.

Use `--twice` during rehearsal to prove duplicate provider delivery creates one
receipt, one normalized domain event, and no duplicate jobs. The script prints
the expected receipt, domain-event, and job keys for each fixture so the dashboard
report can be compared with the replay output.

## VAY-794 local execution record

Recorded on 2026-06-14 from branch
`flamurmaliqi2811/vay-794-execute-c1-staging-rehearsal-and-record-gono-go-evidence`.
This is local tooling evidence only; it does not replace the staging provider
dashboard exports, operator freeze approvals, live replay output, rollback proof,
or go/no-go sign-off required by VAY-794.

### Commands run

Fixture inventory:

```bash
node scripts/c1-rehearsal-replay-fixtures.mjs --list
```

Result: passed. The command listed six synthetic replay fixtures:

| Fixture                           | Provider  | Event type                 |
| --------------------------------- | --------- | -------------------------- |
| `channex-message-created`         | `channex` | `message`                  |
| `channex-booking-revision`        | `channex` | `booking`                  |
| `stripe-payment-intent-succeeded` | `stripe`  | `payment_intent.succeeded` |
| `stripe-connect-account-updated`  | `stripe`  | `account.updated`          |
| `xendit-invoice-paid`             | `xendit`  | `invoice.paid`             |
| `xendit-payout-succeeded`         | `xendit`  | `payout.succeeded`         |

Duplicate dry-run replay:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=http://localhost:8000 \
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice
```

Result: passed. The command printed two dry-run POST attempts per fixture and
redacted provider auth headers. Expected idempotency evidence emitted by the
script:

| Fixture                           | Expected receipt key                                                     | Expected domain event keys                                                                 | Expected job keys                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channex-message-created`         | `webhook:channex:message:prop_c1_rehearsal:msg_c1_rehearsal_001`         | `channex.message.ingest:prop_c1_rehearsal:thread_c1_rehearsal_001:msg_c1_rehearsal_001:v1` | `channex.ingest-message:channel_message:msg_c1_rehearsal_001:message-created:v1`                                                                                                                                |
| `channex-booking-revision`        | `webhook:channex:booking:prop_c1_rehearsal:chan_book_c1_rehearsal_001:7` | `channex.booking.ingest:prop_c1_rehearsal:chan_book_c1_rehearsal_001:7:v1`                 | `channex.ingest-booking:channel_booking:chan_book_c1_rehearsal_001:revision-7:v1`                                                                                                                               |
| `stripe-payment-intent-succeeded` | `webhook:stripe:evt_c1_rehearsal_pi_succeeded_001`                       | `payment.captured:stripe:pi_c1_rehearsal_001:24100:v1`                                     | `payment.reconcile-status:payment:pi_c1_rehearsal_001:stripe-event-evt_c1_rehearsal_pi_succeeded_001:v1`; `booking.finalize-instant:booking:book_c1_rehearsal_001:stripe-payment-intent-pi_c1_rehearsal_001:v1` |
| `stripe-connect-account-updated`  | `webhook:stripe:evt_c1_rehearsal_account_updated_001`                    | `finance.provider-account.updated:stripe:acct_c1_rehearsal_001:true:v1`                    | `finance.reconcile-provider-account:provider_account:acct_c1_rehearsal_001:stripe-event-evt_c1_rehearsal_account_updated_001:v1`                                                                                |
| `xendit-invoice-paid`             | `webhook:xendit:invoice:inv_c1_rehearsal_001:PAID`                       | `payment.captured:xendit:inv_c1_rehearsal_001:24100:v1`                                    | `payment.reconcile-status:payment:inv_c1_rehearsal_001:xendit-status-PAID:v1`; `booking.finalize-instant:booking:book_c1_rehearsal_002:xendit-invoice-inv_c1_rehearsal_001:v1`                                  |
| `xendit-payout-succeeded`         | `webhook:xendit:payout:payout_c1_rehearsal_001:SUCCEEDED`                | `payout.status:xendit:payout_c1_rehearsal_001:SUCCEEDED:v1`                                | `finance.reconcile-payout:payout:payout_c1_rehearsal_001:xendit-status-SUCCEEDED:v1`                                                                                                                            |

C1 evidence unit coverage:

```bash
npm --workspace @vayada/backend-migration run test -- c1RehearsalEvidence
```

Result: passed. Vitest reported 1 file passed, 4 tests passed.

Backend migration typecheck:

```bash
npm --workspace @vayada/backend-migration run typecheck
```

Result: passed.

Parity harness unit coverage:

```bash
npm --workspace @vayada/backend-migration run test -- parity registry platformJobsEventsAudit
```

Result: passed. Vitest reported 5 files passed, 9 tests passed, 6 skipped.

### Staging runtime attempt on 2026-06-14

After the platform secret-ownership work, the target database URL was loaded
from AWS Secrets Manager without printing the value and the staging
dashboard/check command was attempted:

```bash
TARGET_DATABASE_URL="$(aws secretsmanager get-secret-value \
  --region eu-west-1 \
  --secret-id vayada/database-url \
  --query SecretString \
  --output text)" \
npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: failed before producing a report. The command reached the database
connection step but timed out connecting to the target database host on port
5432 from the local operator environment.

Additional runtime checks:

- The deployed `vayada-backend-service` task definition exposes
  `DATABASE_URL`, `JWT_SECRET_KEY`, auth, SMTP, CORS, and AWS runtime secrets,
  but does not expose `STRIPE_WEBHOOK_SECRET`, `XENDIT_WEBHOOK_SECRET`, or
  `CHANNEX_WEBHOOK_SECRET`.
- The deployed `vayada-pms-backend-service` task definition exposes
  `STRIPE_WEBHOOK_SECRET` and `CHANNEX_API_KEY`, but no
  `XENDIT_WEBHOOK_SECRET` or `CHANNEX_WEBHOOK_SECRET`.
- AWS SSM Parameter Store currently has no parameters under `/vayada/staging/`
  in `eu-west-1`.
- GitHub Actions now has workflow wiring for the staging rehearsal Terraform
  variables, but the repository secret-name listing does not show the
  corresponding staging values yet.

No live `--send --twice` provider replay was executed because the target runtime
does not currently have matching provider webhook secrets and the rehearsal SSM
parameters have not been created with real values.

### Target staging database setup on 2026-06-15

A separate logical target database was created on the existing AWS RDS instance
for C1 rehearsal isolation:

- database: `vayada_target_staging`;
- user: `vayada_target_staging_user`;
- master connection stored in AWS Secrets Manager as `vayada/rds-master-url`;
- target connection stored in AWS Secrets Manager as
  `vayada/target-staging-database-url`;
- `vayada-platform` GitHub Actions secret
  `TF_VAR_STAGING_TARGET_DATABASE_URL` set to the target connection string.

The local operator IP was temporarily allowed to reach the RDS security group on
port 5432 for setup and validation, then the temporary ingress rule was revoked.

Target migrations were applied with the staging environment ledger:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:migrate -- --env staging
```

Result: passed. Migrations `0001` through `0017` were applied. The target
database now contains these target schemas:

```text
booking, distribution, finance, hotel_catalog, identity, intelligence,
marketplace, platform, pms
```

The C1 rehearsal dashboard command was then run against the migrated target
database:

```bash
TARGET_DATABASE_URL=<target-staging-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: passed and produced a baseline report. Since no provider replay or
scheduler freeze evidence has been recorded into the new target database yet,
the report showed:

- empty rows for provider receipts, dedupe hits, job lag, job failures, and
  dead letters;
- `missingProviders`: `channex`, `stripe`, `xendit`;
- all nine legacy scheduler jobs present in
  `missingFrozenSchedulerJobs`.

Remaining VAY-794 evidence still required from staging:

- provider endpoint exports for Channex and Stripe;
- target dashboard/check report after freeze evidence and replay receipts exist;
- operator-approved scheduler freeze rows for the nine legacy PMS scheduler jobs;
- live or controlled staging replay using `--send --twice` with provider secrets;
- rollback proof for at least one provider;
- go/no-go decision with named owners.

### AWS secret discovery

Recorded on 2026-06-14 after refreshing AWS access. Secret values were not
printed or committed.

Discovery scope:

- AWS Secrets Manager and SSM Parameter Store names across the configured
  deployment account and common regions.
- Active and recent ECS task definitions for application-level environment and
  secret references.
- GitHub repository, environment, and organization secret-name listings for the
  app and platform repositories.
- App Runner runtime environment and secret names.
- The platform Terraform source and environment documentation.
- Local dotenv files, limited to variable-name matching.

High-level finding: the current deployed runtime exposes the application-level
values needed for the existing Stripe webhook and Channex API integration, but
no managed staging/rehearsal runtime path was found for `TARGET_DATABASE_URL`,
`XENDIT_WEBHOOK_SECRET`, or `CHANNEX_WEBHOOK_SECRET`. The platform Terraform
source also does not define the missing C1 rehearsal variables or a staging
secret namespace.

Direct read-only connection attempts to candidate database URLs timed out from
the local machine, and ECS Exec is disabled on the running Fargate tasks, so the
C1 dashboard command could not be run inside the VPC from this environment.

### Managed staging secrets and controlled replay on 2026-06-15

The platform repository now manages the C1 staging rehearsal SSM parameters.
Secret values were loaded from AWS SSM/GitHub Actions without printing them.

Terraform apply:

```text
https://github.com/vayada-marketplace/vayada-platform/actions/runs/27571357112
```

Result: passed. AWS SSM Parameter Store now contains these managed SecureString
parameters in `eu-west-1`:

```text
/vayada/staging/channex-webhook-secret
/vayada/staging/stripe-webhook-secret
/vayada/staging/target-database-url
/vayada/staging/xendit-webhook-secret
```

The target RDS endpoint is private and does not accept local operator TCP
traffic, so the dashboard command was run as an ECS one-off task inside the VPC.
The first ECS dashboard task used log stream
`/ecs/vayada-c1-rehearsal-checks:ecs/checks/f787bcfed7794855843dedd9ba0cb655`.

```bash
TARGET_DATABASE_URL=<ssm:/vayada/staging/target-database-url> \
  npm --workspace @vayada/backend-migration run target:c1-rehearsal:checks -- \
  --lookback-minutes 1440 \
  --pretty
```

Result: passed. Baseline report generated at
`2026-06-15T19:52:58.974Z`:

- no provider receipt rows yet;
- no provider dedupe-hit rows yet;
- `missingProviders`: `channex`, `stripe`, and `xendit`;
- all nine legacy scheduler freeze rows were missing.

A temporary target `apps/api` runtime was then run as an ECS one-off task in
`observe_only` mode for all three providers. The runtime received only these
runtime values from SSM:

```text
TARGET_DATABASE_URL
STRIPE_WEBHOOK_SECRET
XENDIT_WEBHOOK_SECRET
CHANNEX_WEBHOOK_SECRET
```

The replay was executed from the operator machine against that temporary target
runtime:

```bash
C1_REHEARSAL_WEBHOOK_BASE_URL=http://<temporary-ecs-public-ip>:8003 \
C1_REHEARSAL_ALLOW_SEND_TO_HOST=<temporary-ecs-public-ip> \
STRIPE_WEBHOOK_SECRET=<ssm:/vayada/staging/stripe-webhook-secret> \
XENDIT_WEBHOOK_SECRET=<ssm:/vayada/staging/xendit-webhook-secret> \
CHANNEX_WEBHOOK_SECRET=<ssm:/vayada/staging/channex-webhook-secret> \
  node scripts/c1-rehearsal-replay-fixtures.mjs --all --twice --send
```

Result: passed. All six fixture sends returned HTTP 200. First delivery returned
`observed`; duplicate delivery returned `duplicate_observed`:

| Fixture                           | Provider  | First attempt | Duplicate attempt    |
| --------------------------------- | --------- | ------------- | -------------------- |
| `channex-message-created`         | `channex` | `observed`    | `duplicate_observed` |
| `channex-booking-revision`        | `channex` | `observed`    | `duplicate_observed` |
| `stripe-payment-intent-succeeded` | `stripe`  | `observed`    | `duplicate_observed` |
| `stripe-connect-account-updated`  | `stripe`  | `observed`    | `duplicate_observed` |
| `xendit-invoice-paid`             | `xendit`  | `observed`    | `duplicate_observed` |
| `xendit-payout-succeeded`         | `xendit`  | `observed`    | `duplicate_observed` |

The post-replay ECS dashboard task used log stream
`/ecs/vayada-c1-rehearsal-checks:ecs/checks/0aacca9cbadd42bfa89aa181ca214efd`.

Result: passed. Report generated at `2026-06-15T19:58:24.873Z`:

- `providersCovered`: `channex`, `stripe`, `xendit`;
- `missingProviders`: none;
- provider receipt counts: one observed receipt for each fixture event type;
- provider dedupe hits:
  - Channex: two idempotency keys, two dedupe hits;
  - Stripe: two idempotency keys, two dedupe hits;
  - Xendit: two idempotency keys, two dedupe hits;
- job lag, job failure, and dead-letter rows were empty;
- all nine legacy scheduler freeze rows were still missing.

Temporary infrastructure cleanup:

- the temporary target API ECS task was stopped after replay;
- the temporary replay security group allowing operator access to port 8003 was
  deleted;
- temporary ECS task definitions were deregistered;
- the temporary ECR repository used for the rehearsal image was deleted;
- CloudWatch log groups were retained for evidence.

VAY-794 go/no-go status after the 2026-06-15 replay: **no-go / incomplete**.
The managed secret path, target DB access path, controlled provider replay, and
duplicate receipt dedupe evidence existed. The rehearsal still could not pass
until the remaining cutover-plan gates were completed:

- export and attach provider dashboard configuration for Channex and Stripe;
- record operator-approved freeze evidence rows for all nine legacy PMS
  scheduler jobs;
- exercise rollback for at least one provider path;
- rerun the dashboard after freeze rows exist;
- record named owner sign-off for go/no-go.

### Provider exports and live freeze check on 2026-06-15

Provider configuration was exported through managed provider/runtime access
without printing secrets. Redacted artifacts are committed under
`engineering/evidence/vay-794/`:

```text
channex-webhook-export-2026-06-15.json
abort-before-switch-decision-2026-06-16.json
frozen-pms-one-off-task-attempts-2026-06-15.json
pms-runtime-health-2026-06-15.json
scheduler-freeze-audit-insert-2026-06-16.json
staging-pms-runtime-health-2026-06-16.json
stripe-webhook-export-2026-06-15.json
target-dashboard-after-freeze-2026-06-16.json
xendit-webhook-export-2026-06-15.json
```

The staging provider secret sources, replay results, and go/no-go constraints
are recorded in the evidence below. The retired target staging lane and its
replay secrets were removed under VAY-868 after the rehearsal was accepted.

Stripe export:

- source: Stripe API `GET /v1/webhook_endpoints?limit=100`;
- result: one enabled live endpoint;
- endpoint id: `we_1TEEq8HtaQeEOmq28UeQ3Y7f`;
- endpoint URL: `https://pms-api.vayada.com/webhooks/stripe`;
- enabled events:
  - `payment_intent.amount_capturable_updated`;
  - `payment_intent.succeeded`;
  - `payment_intent.canceled`;
  - `payment_intent.payment_failed`;
  - `account.updated`;
- API version: `2026-02-25.clover`;
- signing secret: present in AWS SSM at
  `/vayada/prod/stripe-webhook-secret` and copied to
  `/vayada/staging/stripe-webhook-secret` for replay; value not printed or
  committed.

Channex export:

- source: Channex API `GET /api/v1/webhooks`;
- result: no webhooks currently returned for the configured production Channex
  API key;
- no global `event_mask="message"` webhook is currently active through the
  exported Channex account configuration;
- rehearsal Channex token is managed at
  `/vayada/staging/channex-webhook-secret`; value not printed or committed.

Xendit export:

- result: blocked by missing real API/runtime configuration;
- no `XENDIT_SECRET_KEY` or production `XENDIT_WEBHOOK_SECRET` exists in the
  discovered AWS SSM/Secrets Manager runtime namespace;
- only `/vayada/staging/xendit-webhook-secret` exists, and it is a generated C1
  replay placeholder;
- platform ECS Terraform does not inject Xendit secrets into the deployed
  production services.

Xendit VAY-794 disposition recorded on 2026-06-16:

- Xendit is removed from the active VAY-794 go/no-go provider scope because no
  real production or staging Xendit webhook/API runtime configuration has been
  found;
- the existing Xendit replay rows remain useful synthetic coverage of the target
  intake/idempotency path, but they are not required for VAY-794 sign-off;
- future Xendit cutover work should use VAY-840 or a successor issue once real
  Xendit usage and provider credentials are confirmed.

Live PMS runtime freeze check:

```bash
curl https://pms-api.vayada.com/health
```

Result: passed as an HTTP call but failed the rehearsal freeze gate. The
deployed production PMS runtime reported:

- scheduler enabled: `true`;
- scheduler running: `true`;
- active legacy scheduler jobs: `9`;
- frozen legacy scheduler jobs: `0`;
- legacy provider webhook modes:
  - Stripe: `mutating`;
  - Xendit: `mutating`;
  - Channex: `mutating`.

This means the scheduler-freeze and legacy-webhook-drain phases have **not**
been executed in a valid staging/production-like runtime. No
`platform.product_audit_events` scheduler-freeze rows were inserted, because the
observed runtime state does not support marking the nine legacy scheduler jobs
as frozen, disabled, or blocked.

Temporary frozen PMS one-off task attempts:

- source artifact:
  `engineering/evidence/vay-794/frozen-pms-one-off-task-attempts-2026-06-15.json`;
- goal: run the current production PMS backend image as an ECS one-off task with
  scheduler disabled and all legacy provider webhook modes set to
  `ack_only_with_receipt`;
- requested freeze overrides:
  - `PMS_SCHEDULER_ENABLED=false`;
  - `PMS_LEGACY_STRIPE_WEBHOOK_MODE=ack_only_with_receipt`;
  - `PMS_LEGACY_XENDIT_WEBHOOK_MODE=ack_only_with_receipt`;
  - `PMS_LEGACY_CHANNEX_WEBHOOK_MODE=ack_only_with_receipt`;
  - `CHANNEX_ADMIN_DEFAULT_MODE=disabled`;
  - `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE=disabled`;
- deployed service observation: the service is healthy, but ECS is running task
  definition `vayada-pms-backend:176`; task definition `178` is primary with
  zero running tasks;
- non-SSL one-off attempts using the production PMS database URL failed before
  `/health` because RDS rejected the new task private IP with
  `no pg_hba.conf entry ... no encryption`;
- SSL one-off attempts using both `/vayada/prod/db-pms-url-ssl` and a temporary
  SecureString derived from `/vayada/prod/db-pms-url` plus `sslmode=require`
  failed before `/health` with `Invalid database password`;
- the final live-image SSL attempt used image
  `269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-pms-backend:301ad02b4fa760fd7ea676db7475847db9f3f82d`
  and task definition `vayada-vay-794-frozen-pms:3`, but exited before serving
  health.

Temporary resource cleanup after the attempts:

- temporary ECS task definitions `vayada-vay-794-frozen-pms:1`, `:2`, and `:3`
  were deregistered;
- temporary SSM parameter
  `/vayada/staging/vay-794-temp-pms-db-url-ssl` was deleted;
- temporary inline IAM policy
  `ecsTaskExecutionRole/vay-794-temp-pms-db-url-ssl-read` was deleted;
- temporary security group `sg-077bd9c81444a9d75` was deleted;
- CloudWatch log streams under `/ecs/vayada-pms-backend` were retained for
  audit evidence.

Conclusion: this path did not produce valid frozen scheduler evidence. The next
valid unblock is a dedicated staging legacy PMS runtime, or a managed production
freeze window, with database connectivity configured so the PMS app can boot
with scheduler and webhook freeze flags before `/health` evidence is captured.

Abort-before-switch rollback evidence:

- the temporary target `apps/api` runtime used for replay stayed in
  `observe_only` mode;
- provider dashboards were not switched to the temporary target endpoint;
- controlled replay completed against target, then the temporary target API task
  was stopped and its temporary inbound security group was deleted;
- Stripe provider export after the replay still shows the live Stripe endpoint
  pointing at the legacy PMS URL, so the abort-before-switch path returned the
  environment to legacy-only provider delivery.

VAY-794 status after the 2026-06-15 one-off task attempts: **no-go /
incomplete**. Provider export evidence and an abort-before-switch rollback proof
existed, but the remaining hard blockers were:

- no frozen staging legacy scheduler runtime exists yet;
- no operator-approved freeze rows exist for the nine legacy PMS scheduler jobs;
- Xendit still lacked real production/staging API secrets, so only synthetic
  replay evidence existed; this was later removed from the active VAY-794
  go/no-go provider scope;
- final dashboard cannot pass until freeze rows exist;
- named owner sign-off is still missing.

### Managed staging PMS freeze proof on 2026-06-16

The dedicated frozen staging PMS runtime was provisioned through
`vayada-platform` and verified after the earlier one-off ECS path failed.

Platform changes:

- PR: `https://github.com/vayada-marketplace/vayada-platform/pull/6`;
- follow-up permission fix:
  `https://github.com/vayada-marketplace/vayada-platform/pull/7`;
- successful Terraform apply:
  `https://github.com/vayada-marketplace/vayada-platform/actions/runs/27578245703`;
- staging service: `vayada-staging-pms-backend-service`;
- task definition:
  `arn:aws:ecs:eu-west-1:269416271598:task-definition/vayada-staging-pms-backend:1`;
- service state after apply: desired `1`, running `1`, pending `0`;
- target group state: healthy.

The staging runtime uses a separate logical PMS database,
`vayada_pms_staging`, with the connection stored in
`/vayada/staging/pms-database-url`. The runtime starts with:

- `PMS_SCHEDULER_ENABLED=false`;
- `PMS_LEGACY_WEBHOOK_MODE=ack_only_with_receipt`;
- `PMS_LEGACY_STRIPE_WEBHOOK_MODE=ack_only_with_receipt`;
- `PMS_LEGACY_XENDIT_WEBHOOK_MODE=ack_only_with_receipt`;
- `PMS_LEGACY_CHANNEX_WEBHOOK_MODE=ack_only_with_receipt`;
- `CHANNEX_ADMIN_DEFAULT_MODE=disabled`;
- `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE=disabled`.

Health proof:

```bash
curl --connect-to staging-pms-api.vayada.com:443:vayada-backend-alb-709536928.eu-west-1.elb.amazonaws.com:443 \
  https://staging-pms-api.vayada.com/health
```

Result: passed. The health payload is committed as
`engineering/evidence/vay-794/staging-pms-runtime-health-2026-06-16.json` and
reported:

- scheduler enabled: `false`;
- scheduler running: `false`;
- scheduler configuration valid: `true`;
- active legacy scheduler jobs: `0`;
- frozen legacy scheduler jobs: `9`;
- unknown scheduler jobs: `0`;
- legacy provider webhook modes:
  - Stripe: `ack_only_with_receipt`;
  - Xendit: `ack_only_with_receipt`;
  - Channex: `ack_only_with_receipt`.

Scheduler-freeze audit rows were then inserted into the target database from an
ECS one-off task inside the VPC. Artifact:
`engineering/evidence/vay-794/scheduler-freeze-audit-insert-2026-06-16.json`.

Result:

- rehearsal id: `c1-staging-rehearsal-20260616`;
- freeze rows inserted or already present: `9`;
- freeze rows present for rehearsal: `9`;
- evidence source: `staging-pms-api-health`;
- all rows use `actual_state=frozen`.

The final C1 dashboard check was rerun from ECS task
`arn:aws:ecs:eu-west-1:269416271598:task/vayada-backend-cluster/abf0fcb9cad9490cbcd5179d25156350`
with log stream
`/ecs/vayada-c1-rehearsal-checks:ecs/checks/abf0fcb9cad9490cbcd5179d25156350`.
Artifact:
`engineering/evidence/vay-794/target-dashboard-after-freeze-2026-06-16.json`.

Result: passed. Report generated at `2026-06-16T16:29:24.543Z`:

- `providersCovered`: `channex`, `stripe`, `xendit`;
- `missingProviders`: none;
- provider receipt counts: one observed receipt for each of the six replay
  fixture event types;
- provider dedupe hits:
  - Channex: two idempotency keys, two dedupe hits;
  - Stripe: two idempotency keys, two dedupe hits;
  - Xendit: two idempotency keys, two dedupe hits;
- job lag rows: none;
- job failure rows: none;
- dead-letter rows: none;
- all nine legacy scheduler rows reported `evidence_status=passed`;
- `missingFrozenSchedulerJobs`: none;
- `unfrozenSchedulerJobs`: none;
- `missingMetrics`: none.

Temporary runner cleanup after the final dashboard pass:

- temporary task definition `vayada-c1-rehearsal-checks:2` was deregistered;
- temporary ECR repository `vayada-c1-rehearsal-checks` was deleted;
- CloudWatch log group `/ecs/vayada-c1-rehearsal-checks` was retained for
  evidence.

### C1 rehearsal go/no-go decision on 2026-06-16

The cutover commander accepted the abort-before-switch path as sufficient
rollback proof for VAY-794 rehearsal closure. Evidence artifact:
`engineering/evidence/vay-794/abort-before-switch-decision-2026-06-16.json`.

Decision scope:

- VAY-794 C1 staging rehearsal evidence: **go / accepted**;
- production provider cutover: **not authorized by this rehearsal decision**;
- production cutover still requires a controlled provider switch window with the
  same owner coverage and rollback access described in
  `engineering/channex-webhook-cutover-plan.md`.

Owner assignments and sign-off:

The final VAY-794 rehearsal call is signed by the cutover commander. Domain rows
below record assigned owner roles for evidence accountability and production
cutover follow-through.

| Gate                                      | Owner                       | Decision                                                                                                                      |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cutover command / final C1 rehearsal call | Flamur Maliqi               | Accept abort-before-switch rollback proof for VAY-794 rehearsal closure.                                                      |
| Platform/runtime evidence                 | Platform/runtime owner      | Staging target runtime, staging PMS freeze runtime, SSM secret path, ECS runner cleanup, and dashboard report are recorded.   |
| PMS scheduler freeze                      | PMS operations owner        | Dedicated staging PMS runtime reports scheduler disabled, zero active jobs, nine frozen jobs, and freeze audit rows inserted. |
| Provider gate                             | Finance/PMS provider owners | Channex and Stripe provider exports plus controlled replay evidence are recorded; Xendit is deferred/non-blocking.            |

Final VAY-794 rehearsal status: **go / accepted for C1 rehearsal evidence**.
The residual production-cutover caveat is:

- provider dashboards were not switched to the temporary target endpoint during
  this rehearsal. That is accepted for VAY-794 because rollback proof used the
  abort-before-switch path, but it does not prove the future production endpoint
  switch itself.

Xendit is no longer a VAY-794 blocker. It remains represented by synthetic replay
evidence only and is deferred to VAY-840 or a successor issue if real Xendit
runtime usage is confirmed.
