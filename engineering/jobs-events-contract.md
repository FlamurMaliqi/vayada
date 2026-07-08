# Jobs and events contract

_VAY-614 contract record. Builds on VAY-602 TypeScript backend structure,
VAY-603 implementation roadmap, VAY-605 database restructure, and VAY-607
runtime/database tooling decision._

## Purpose

The TypeScript backend should treat side effects as durable jobs/events, not as
inline work hidden inside route handlers or untracked fire-and-forget tasks.

This contract defines the target jobs/events shape for idempotency, retries,
failure visibility, dead-letter handling, audit correlation, local development,
and tests. It does not choose the final production queue provider or change
current Python production behavior before cutover.

## Boundary

Owner packages:

- `backend-events`: event emission, outbox, job scheduling, retries, handlers.
- `backend-audit`: product audit events and correlation metadata.
- domain packages: own domain decisions and handler business logic.

Target storage from `engineering/target-schema-ownership-map.md`:

- `domain_events`;
- `outbox_events`;
- `jobs`;
- `job_attempts`;
- `dead_letter_events`;
- `idempotency_keys`;
- `product_audit_events`;
- `external_webhook_events`.

## Synchronous vs Asynchronous Work

Routes stay synchronous for work required to make the request truthful:

- authenticate and resolve `RequestContext`;
- authorize the requested action;
- validate input and resource state;
- persist the domain state change in the owning domain transaction;
- create the domain event/outbox row in the same transaction;
- return a response that reflects only committed state.

Routes must not synchronously depend on these side effects unless the user-facing
operation cannot be true without them:

- sending emails or notifications;
- Channex/OTA availability pushes;
- webhook fan-out;
- reconciliation jobs;
- image imports and external downloads;
- delayed cancellation/change side effects;
- payout reconciliation or provider polling.

Legacy Python `asyncio.create_task` and FastAPI `BackgroundTasks` behavior is
compatibility-only. New TypeScript product code should enqueue durable work.

## Event And Job Shape

```text
DomainEvent
  eventId
  eventType
  version
  occurredAt
  producer
  aggregate
  organizationId
  resourceScope
  payload
  requestId
  correlationId
  causationId
```

```text
Job
  jobId
  jobType
  version
  status
  idempotencyKey
  eventId
  aggregate
  organizationId
  resourceScope
  payload
  runAfter
  attempts
  maxAttempts
  backoffPolicy
  lastError
  auditCorrelationId
```

Statuses:

- event: `recorded`, `published`, `publish_failed`;
- job: `queued`, `running`, `succeeded`, `retry_scheduled`, `failed`,
  `dead_lettered`, `cancelled`, `superseded`.

## Idempotency

Every externally visible or customer-facing job needs an idempotency key.

Key format:

```text
<jobType>:<aggregateType>:<aggregateId>:<semanticAction>:<versionOrWindow>
```

Examples:

- `email.booking-confirmed:booking:book_123:guest-confirmation:v1`
- `channex.push-availability:room_type:rt_123:2026-09-12_2026-09-15:v1`
- `notification.affiliate-application:affiliate:aff_123:hotel-owner:v1`

Rules:

- Enqueueing the same key twice returns the existing active/succeeded job.
- A succeeded key prevents duplicate customer-facing work.
- Retrying a failed attempt reuses the same key and appends `job_attempts`.
- Intentional repeats must change the semantic action or version/window.
- Provider request IDs should be stored on attempts when available.

## Retry And Dead Letter

Default retry policy:

- max attempts: `5`;
- backoff: exponential with jitter;
- retryable failures: network timeout, provider `429`, provider `5xx`, transient
  database/lock errors;
- non-retryable failures: authorization denial, invalid payload, missing
  required provider configuration, resource deleted/suspended.

After max attempts or a non-retryable failure, the job is visible in
`dead_letter_events` with:

- job ID and idempotency key;
- final error category and sanitized message;
- affected organization/resource;
- last attempt timestamp;
- replay eligibility;
- owner package;
- linked product audit event.

Dead-letter replay must be explicit and audited. Replays keep the original
causation chain and create a new attempt or replacement job according to the
handler contract.

## Audit Correlation

Every event/job created from an authenticated action carries:

- `requestId` from `RequestContext.audit`;
- actor internal user ID;
- selected organization ID;
- target resource IDs;
- source route or system actor;
- correlation and causation IDs.

`product_audit_events` records both the synchronous domain change and the
asynchronous side-effect outcome. Provider logs are not the product audit trail.

## Local Development And Tests

Before the production queue provider is selected, local/test infrastructure must
support:

- in-memory or database-backed queue adapter with the same enqueue/claim/ack
  interface;
- deterministic `runDueJobs()` test helper;
- fake clock for `runAfter` and retry backoff;
- idempotency-key assertions;
- attempt history assertions;
- dead-letter fixture assertions;
- handler tests without real SMTP, Channex, payment, or notification providers.

Local dev can run jobs inline only through an explicit adapter mode. Inline mode
must still write event, job, attempt, idempotency, and audit records.

## First Side-Effect Candidates

Candidate priority for implementation tickets:

| Candidate                              | Current legacy shape                                                     | First target job(s)                                                          | Why first                                   |
| -------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------- |
| Booking status change side effects     | `asyncio.create_task` in `apps/pms-api/app/routers/admin_bookings.py`    | `email.booking-status-changed`, `channex.push-availability`                  | High customer impact and duplicate-risk.    |
| Room block availability sync           | `asyncio.create_task` in `apps/pms-api/app/routers/admin_room_blocks.py` | `channex.push-ari`                                                           | Clear idempotency window by room/date.      |
| Affiliate registration notifications   | `asyncio.create_task` in `apps/pms-api/app/routers/affiliates.py`        | `email.affiliate-application-received`, `notification.affiliate-application` | Email fan-out currently has no retry/audit. |
| Listing image import                   | Retired with PMS listing import                                          | None                                                                         | Route and background work no longer exist.  |
| Payout/payment reconciliation          | Synchronous/manual provider polling routes                               | `finance.reconcile-payout`, `payment.reconcile-status`                       | Needs strict audit and idempotency.         |
| Cancellation/change request follow-ups | Mixed inline updates and background notifications                        | `booking.cancellation-follow-up`, `booking.change-request-follow-up`         | Multi-step side effects need visibility.    |

Recommended first implementation ticket:

> Move booking status change side effects behind the TypeScript jobs/events
> abstraction for target-schema fixtures: emit one booking status event, enqueue
> guest email and Channex availability jobs with idempotency keys, and assert
> retry/dead-letter behavior with fake providers.

This can be implemented against target fixtures without changing current Python
production behavior.

## Fixtures

Representative fixtures live in:

```text
engineering/fixtures/jobs-events/cases.json
```

They cover:

- booking confirmation enqueues email and Channex jobs with audit correlation;
- duplicate event enqueue reuses idempotency keys;
- retry exhaustion creates a dead-letter record.

## Implementation Handoff

Follow-up implementation tickets should use:

- TypeScript backend structure:
  `engineering/typescript-backend-structure.md`;
- database restructure plan:
  `engineering/backend-database-restructure.md`;
- target ownership map:
  `engineering/target-schema-ownership-map.md`;
- roadmap:
  `engineering/typescript-rewrite-implementation-roadmap.md`;
- fixtures:
  `engineering/fixtures/jobs-events/cases.json`.
