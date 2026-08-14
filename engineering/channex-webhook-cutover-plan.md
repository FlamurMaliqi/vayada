# Channex and webhook cutover plan

_VAY-772 cutover record. Builds on
[`booking-pms-route-migration-inventory.md`](booking-pms-route-migration-inventory.md),
[`jobs-events-contract.md`](jobs-events-contract.md), and
[`target-schema-ownership-map.md`](target-schema-ownership-map.md). Channex event
selection is recorded in
[`channex-webhook-event-strategy.md`](channex-webhook-event-strategy.md)._

## Purpose

This plan defines how the C1 Channex/webhook vertical cuts over from legacy
`apps/pms-api` to the TypeScript backend without duplicate provider effects,
lost external events, or competing schedulers.

The C1 surface includes:

- Channex admin routes, setup, mappings, markups, ARI sync, booking sync,
  messaging setup, and webhook summaries.
- External provider webhooks:
  `POST /webhooks/stripe`, `POST /webhooks/xendit`, and
  `POST /webhooks/channex`.
- Legacy scheduler jobs that mutate booking, payout, Channex, or inventory
  state from `apps/pms-api/app/services/scheduler.py`.

VAY-794 scope decision recorded on 2026-06-16: the active C1 staging rehearsal
provider gate is Channex plus Stripe. Xendit remains described in this broader
cutover plan for future finance/payment usage, but it is not a VAY-794 blocker
until real Xendit production or staging webhook/API runtime configuration is
confirmed.

VAY-794 rollback decision recorded on 2026-06-16: the C1 staging rehearsal may
pass with abort-before-switch rollback evidence if target intake, replay,
dedupe, freeze, dashboard, provider export, cleanup, and owner sign-off evidence
are recorded. This decision does not authorize production provider endpoint
switching; production cutover still requires the Phase 3 switch window and
rollback coverage below.

This plan does not implement target webhook intake, Channex route ports,
scheduler controls, or provider configuration changes.

## Cutover rule

Exactly one runtime may be the mutating owner for a provider event, scheduler
job, or Channex side effect at any point in the cutover.

The overlap window is for observation, replay, and old-URL draining. It is not a
period where legacy and target both mutate state for the same external event.
Because current legacy webhook handlers and schedulers do not all share durable
idempotency records, the target runtime must support shadow/observe-only intake
before the switch and legacy must support ack-only or proxy-to-target behavior
after the switch.

## Ownership

| Surface                                                             | Target owner                                                                | Jobs/events owner                                                            | Cutover owner                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| Channex connection, mappings, markups, booking feed, ARI, messaging | PMS operations (`domain-pms`, `domain-pms-channex`)                         | `backend-events` for receipts, jobs, attempts, dead letters, and idempotency | PMS channel-connectivity engineer |
| Stripe payment and Connect account webhooks                         | Finance (`domain-finance`) plus Booking for guest booking lifecycle effects | `backend-events` and `backend-audit`                                         | Finance engineer                  |
| Xendit invoice and payout webhooks                                  | Finance plus Booking for guest invoice lifecycle effects                    | `backend-events` and `backend-audit`                                         | Finance engineer                  |
| Booking expiry, stale unpaid cancellation, draft cleanup            | Booking/checkout (`domain-booking`)                                         | `backend-events` and `backend-audit`                                         | Booking engineer                  |
| Payout dispatch and payout polling                                  | Finance and affiliate/marketplace where applicable                          | `backend-events` and `backend-audit`                                         | Finance engineer                  |
| Rolling calendar auto-open                                          | PMS operations and distribution read models                                 | `backend-events` and `backend-audit`                                         | PMS operations engineer           |
| Environment-level switch/freeze decision                            | Platform/runtime                                                            | Platform observability and deploy tooling                                    | Cutover commander                 |

The cutover commander owns the timeline and go/no-go calls. Domain owners own
event correctness, replay decisions, and rollback validation for their rows in
the matrices below.

## Prerequisites

Before staging rehearsal:

1. Target webhook intake exists for Stripe, Xendit, and Channex and writes raw
   receipts to `external_webhook_events` before any domain mutation.
2. Target intake can run in `observe_only`, `mutating`, `ack_only_with_receipt`,
   and proxy modes per provider.
3. Target intake records `idempotency_keys` for raw provider receipts,
   normalized domain events, and emitted jobs.
4. Target jobs/events tables include `jobs`, `job_attempts`,
   `dead_letter_events`, `domain_events`, `outbox_events`, and
   `product_audit_events` as described in
   [`jobs-events-contract.md`](jobs-events-contract.md).
5. Legacy `pms-api` has an environment-level scheduler control that can disable
   the whole scheduler and a per-job allowlist/blocklist for rehearsal.
6. Legacy webhook routes can be put in one of these modes per provider:
   `mutating`, `ack_only_with_receipt`, or `proxy_to_target`.
7. Provider dashboard access and rollback credentials are confirmed for
   Channex, Stripe, and Xendit.
8. Dashboards exist for receipt count, dedupe hit count, job failures,
   dead-letter count, and lag by provider.

Mode semantics:

- `observe_only` verifies provider authentication, writes or finds a durable raw
  receipt, computes normalized previews, and does not mutate domain state or
  enqueue jobs.
- `mutating` writes or finds the raw receipt, promotes an observed receipt to
  one normalized domain event when needed, and enqueues jobs idempotently.
- `ack_only_with_receipt` returns 2xx only after the route writes or finds a
  durable receipt and records that the event needs replay, proxying, or manual
  disposition. Receipt-less ack is not allowed for provider callbacks.
- `proxy_to_target` and `proxy_to_legacy` forward the provider request without
  mutating locally. The proxying runtime still writes a receipt/audit row that
  links to the forwarded request outcome.

Before production cutover:

1. Staging rehearsal has passed every requirement in
   [Staging rehearsal requirements](#staging-rehearsal-requirements).
2. A provider replay sample has been executed against target intake for each
   provider without duplicate domain events or jobs.
3. Legacy and target job owners have signed off on the scheduler matrix.
4. A rollback window is scheduled with the same people and provider dashboard
   access as the forward cutover.
5. The Stripe endpoint is configured for events on connected accounts and has
   `charge.updated` enabled. Replay evidence must include the connected account
   id and an available balance transaction so exact processing fees reconcile.

## Endpoint switch sequence

### Phase 0 - Inventory and freeze notice

1. Export current provider endpoint configuration:
   - Stripe webhook endpoint URL, enabled events, signing secret, and endpoint
     id.
   - Xendit callback URLs/tokens for invoices and payouts.
   - Channex global webhook id, callback URL, event mask, active flag, and
     headers. Legacy setup currently uses `event_mask="message"`,
     `is_global=true`, and `X-Vayada-Webhook-Token`.
2. Record current legacy scheduler job list and next run times from
   `pms-api`.
3. Announce the freeze window to support and operations:
   - no manual Channex re-provisioning unless the cutover commander approves;
   - no manual full ARI sync unless PMS channel-connectivity owner approves;
   - no manual payout dispatch or reconciliation outside the finance owner;
   - no manual provider webhook dashboard edits outside the cutover commander.

### Phase 1 - Shadow target intake

1. Deploy target webhook routes in `observe_only` mode.
2. Register target as a secondary endpoint where the provider supports multiple
   endpoints. If a provider only supports one live endpoint, mirror legacy
   receipts to target from the edge or keep the provider frozen for rehearsal.
3. Keep legacy as the only mutating owner.
4. Target must verify signatures/tokens, persist raw receipts, compute
   idempotency keys, and stop before domain mutation or job enqueue.
5. Compare legacy mutations with target normalized-event previews for a full
   provider retry horizon, at minimum:
   - Stripe payment intents and Connect account updates;
   - Xendit invoices and payout callbacks;
   - Channex message events and any enabled booking/ARI event type.

### Phase 2 - Freeze legacy schedulers

1. Put legacy `pms-api` scheduler into the rehearsal/cutover mode required by
   the scheduler matrix.
2. Confirm disabled jobs do not fire for two expected intervals or one expected
   cron slot, whichever is shorter.
3. Run target jobs in `observe_only` or dry-run mode where available and compare
   selected job candidates with legacy source rows.
4. Block manual admin actions that enqueue the frozen side effects unless the
   target path owns them. In particular, `POST /admin/channex/sync-ari` and
   `POST /admin/channex/sync-bookings` must not invoke legacy mutating behavior
   after their scheduler equivalent is frozen.

### Phase 3 - Provider endpoint switch

1. Set target intake to `mutating` for one provider group at a time:
   - Channex first for message/booking intake and ARI job ownership;
   - Xendit invoice and payout callbacks;
   - Stripe payment and Connect callbacks.
2. Put the matching legacy route into `ack_only_with_receipt` or
   `proxy_to_target` mode before the provider URL is changed.
3. Change the provider dashboard endpoint to the target URL. For Channex, update
   the existing global webhook if possible instead of creating a second active
   global webhook with the same event mask.
4. Trigger or replay one known event and verify:
   - exactly one `external_webhook_events` receipt;
   - one normalized domain event;
   - expected jobs with stable idempotency keys;
   - no legacy mutation after the switch timestamp;
   - provider dashboard shows successful delivery.
5. Keep old legacy URLs reachable in `ack_only_with_receipt` or
   `proxy_to_target` mode for the provider retry horizon:
   - Stripe: keep for 72 hours unless the provider dashboard proves no retries
     remain.
   - Xendit: keep for 72 hours unless callback retry state is empty.
   - Channex: keep for 48 hours and confirm webhook summary/receipt counts stay
     healthy.

### Phase 4 - Target scheduler enablement

1. Enable target scheduler jobs only after the matching legacy job is disabled
   and the owner in the scheduler matrix approves.
2. Enable jobs in this order:
   - booking cleanup/expiry jobs after Booking owns guest lifecycle writes;
   - finance reconciliation jobs before finance payout dispatch jobs;
   - Channex booking intake before full ARI push;
   - rolling calendar auto-open after PMS inventory writes and distribution
     snapshots are target-owned.
3. Run one manual target job claim per class with a narrow resource scope before
   enabling recurring cadence.
4. Confirm idempotency-key reuse for duplicate enqueue attempts.

### Phase 5 - Drain and close legacy

1. Keep legacy webhook routes reachable in durable non-mutating mode until the
   retry horizon ends.
2. Confirm no legacy scheduler job has executed after its freeze timestamp.
3. Archive exported provider configuration, cutover timestamps, and replay
   evidence in the release notes or Linear decision record.
4. Remove old provider endpoints only after rollback no longer depends on them.

## Endpoint matrix

| Provider route                                                     | Current mutating behavior                                                                                                             | Target mode before switch                                                                          | Target mutating owner after switch                                                                            | Legacy mode after switch                                  | Rollback                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /webhooks/channex`                                           | Verifies `X-Vayada-Webhook-Token`, stores `channex_webhook_events`, processes `message`, returns 200 even when processing fails       | `observe_only`; persist receipt and normalized preview only                                        | PMS channel-connectivity                                                                                      | `ack_only_with_receipt` or `proxy_to_target` for 48 hours | Repoint Channex global webhook to legacy URL, set legacy `mutating`, set target `observe_only`, replay target receipts not seen by legacy                   |
| `POST /webhooks/xendit` invoice callbacks                          | Marks payments/bookings from invoice status and may enqueue guest/host emails via background tasks                                    | `observe_only`; verify token, dedupe by callback id/external id                                    | Finance for payment state, Booking for booking lifecycle effects                                              | `ack_only_with_receipt` or `proxy_to_target` for 72 hours | Repoint Xendit callbacks to legacy, set legacy `mutating`, set target `observe_only`, replay unprocessed target receipts through legacy-safe reconciliation |
| `POST /webhooks/xendit` payout callbacks                           | Marks payouts complete/failed and may notify affiliates                                                                               | `observe_only`; verify token, dedupe by payout id and status                                       | Finance                                                                                                       | `ack_only_with_receipt` or `proxy_to_target` for 72 hours | Repoint Xendit callbacks to legacy, resume `poll_xendit_processing_payouts` only after target reconciliation is stopped                                     |
| `POST /webhooks/stripe` payment intent and `charge.updated` events | Updates payment/booking state, materializes drafts, may finalize instant-book bookings, may enqueue emails with `asyncio.create_task` | `observe_only`; verify signature, dedupe by Stripe `event.id` and payment intent or fee transition | Finance for payment state and exact connected-account fee reconciliation, Booking for guest lifecycle effects | `ack_only_with_receipt` or `proxy_to_target` for 72 hours | Repoint Stripe endpoint to legacy, set legacy `mutating`, target `observe_only`, replay failed target events only after idempotency audit                   |
| `POST /webhooks/stripe` Connect `account.updated`                  | Marks hotel or affiliate onboarding state                                                                                             | `observe_only`; verify signature and preview target finance/account update                         | Finance/identity entitlement read model                                                                       | `ack_only_with_receipt` or `proxy_to_target` for 72 hours | Repoint Stripe endpoint to legacy and reconcile account state from Stripe dashboard                                                                         |

## Channex admin route freeze matrix

All Channex admin routes stay legacy-owned before C1 implementation, but the
cutover window must prevent legacy manual mutation after the target owns the
same provider state.

| Legacy route group                                                                                                                                                                                                      | Current behavior                                                                        | Rehearsal/cutover mode                                                                                                                                             | Target owner                                   | Cutover owner                     | Rollback                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/channex/enable`, `POST /admin/channex/disable`, `POST /admin/channex/provision`                                                                                                                            | Creates/disables Channex connection state and provider property/mapping setup           | Disabled unless target owns Channex connection commands; no legacy provisioning while target ARI/booking intake is mutating                                        | PMS channel-connectivity                       | PMS channel-connectivity engineer | Re-enable legacy only after target connection commands are paused and provider property/mapping state is reconciled |
| `GET /admin/channex/status`, `GET /admin/channex/room-type-mappings`, `GET /admin/channex/rate-plan-mappings`, `GET /admin/channex/channels`, `GET /admin/channex/markups`, `GET /admin/channex/webhook-events/summary` | Reads local/provider Channex state and webhook summaries                                | Read-only allowed from the current source of truth; once target owns the read model, legacy reads should proxy or be disabled to avoid stale operational decisions | PMS channel-connectivity                       | PMS channel-connectivity engineer | Route reads back to legacy only after target read model is marked non-authoritative                                 |
| `POST /admin/channex/sync-ari`                                                                                                                                                                                          | Manually pushes full ARI to Channex                                                     | Disabled before target ARI jobs enable; no dual ARI push                                                                                                           | PMS channel-connectivity                       | PMS channel-connectivity engineer | Stop target ARI jobs, reconcile inventory versions, then re-enable legacy manual sync                               |
| `POST /admin/channex/sync-bookings`                                                                                                                                                                                     | Manually polls Channex booking feed and imports revisions                               | Disabled before target Channex booking intake enables; no dual feed ingestion                                                                                      | PMS channel-connectivity                       | PMS channel-connectivity engineer | Stop target booking intake, set legacy mutating, replay only receipts/revisions not already mapped                  |
| `PUT /admin/channex/markups`                                                                                                                                                                                            | Writes channel markups and triggers per-channel provisioning/ARI resync                 | Disabled unless target owns markup command and ARI side effects; legacy cannot change markups during target ARI ownership                                          | PMS channel-connectivity                       | PMS channel-connectivity engineer | Pause target markup/ARI jobs, reconcile provider rate-plan state, then re-enable legacy                             |
| `POST /admin/channex/iframe-url`                                                                                                                                                                                        | Creates a Channex iframe token for channel management                                   | Disabled during cutover freeze unless the PMS owner approves a read-only/channel-management exception                                                              | PMS channel-connectivity                       | PMS channel-connectivity engineer | Re-enable after provider webhook and mapping ownership is back on legacy                                            |
| `POST /admin/channex/messaging/backfill`, `POST /admin/channex/messaging/install`                                                                                                                                       | Installs Channex Messaging & Reviews app and marks local install state                  | Disabled unless target owns messaging install command; no legacy app install during webhook URL switch                                                             | PMS channel-connectivity                       | PMS channel-connectivity engineer | Pause target messaging jobs, reconcile installed app state, then re-enable legacy                                   |
| `POST /admin/channex/webhook/setup`                                                                                                                                                                                     | Creates or updates the global Channex webhook URL, event mask, active flag, and headers | Locked to the cutover commander; disabled for normal admin use during rehearsal/cutover because it can repoint the provider endpoint                               | Platform/runtime plus PMS channel-connectivity | Cutover commander                 | Repoint to exported legacy URL, verify event mask/header, and record provider dashboard evidence                    |

## Idempotency and replay rules

### Receipt keys

Every webhook request must first create or find a raw receipt idempotency key:

| Provider                 | Receipt idempotency key                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Stripe                   | `webhook:stripe:<event.id>`                                                                    |
| Xendit invoice           | `webhook:xendit:invoice:<callback.id or invoice id>:<status>`                                  |
| Xendit payout            | `webhook:xendit:payout:<payout id>:<status>`                                                   |
| Channex message          | `webhook:channex:message:<property_id>:<message_id or source_message_id>`                      |
| Channex booking revision | `webhook:channex:booking:<property_id>:<booking_revision_id or channel_booking_id>:<revision>` |
| Channex fallback         | `webhook:channex:<event_type>:<property_id>:<sha256(canonical_payload)>`                       |

If the provider lacks a stable event id, the canonical payload hash must exclude
transport-only fields and include the semantic provider object id and status.

### Domain event keys

Raw receipt dedupe does not replace domain dedupe. Each receipt handler must
also create semantic domain-event keys:

| Domain effect                     | Domain/event key                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Payment authorized                | `payment.authorized:<provider>:<payment_id or provider_payment_id>:<amount>:v1`                |
| Payment captured/paid             | `payment.captured:<provider>:<payment_id or provider_payment_id>:<amount>:v1`                  |
| Payment failed/cancelled/expired  | `payment.terminal:<provider>:<payment_id or provider_payment_id>:<status>:v1`                  |
| Payout status transition          | `payout.status:<provider>:<payout_id>:<status>:v1`                                             |
| Stripe Connect onboarding         | `finance.provider-account.updated:stripe:<account_id>:<charges_enabled>:v1`                    |
| Channex message ingest            | `channex.message.ingest:<property_id>:<thread_id>:<source_message_id>:v1`                      |
| Channex booking ingest            | `channex.booking.ingest:<property_id>:<channel_booking_id>:<revision>:v1`                      |
| ARI push                          | `channex.push-ari:<property_id>:<room_type_id>:<date_start>_<date_end>:<inventory_version>:v1` |
| Rolling calendar auto-open        | `pms.calendar-auto-open:<property_id>:<open_through>:v1`                                       |
| Booking expiry/cancellation sweep | `booking.lifecycle-sweep:<booking_id>:<action>:<deadline_or_window>:v1`                        |

### Job keys

Target jobs must follow the format in
[`jobs-events-contract.md`](jobs-events-contract.md):

```text
<jobType>:<aggregateType>:<aggregateId>:<semanticAction>:<versionOrWindow>
```

Examples for this cutover:

- `payment.reconcile-status:payment:pay_123:stripe-event-evt_123:v1`
- `booking.finalize-instant:booking:book_123:stripe-payment-intent-pi_123:v1`
- `email.payment-confirmed:booking:book_123:guest:v1`
- `finance.reconcile-payout:payout:payout_123:xendit-status-SUCCEEDED:v1`
- `channex.ingest-booking:channel_booking:abc123:revision-7:v1`
- `channex.push-ari:room_type:rt_123:2026-09-12_2026-09-15:v1`

### Replay policy

- Raw receipt lifecycle states are:
  - `observed`: authenticated and durably recorded, no domain mutation attempted;
  - `promoted`: an observed receipt has been claimed for exactly one normalized
    domain event;
  - `succeeded`: the domain event and expected jobs were committed;
  - `failed`: processing failed and retry policy still applies;
  - `dead_lettered`: retry policy is exhausted or the error is non-retryable;
  - `ignored`: authenticated receipt is intentionally non-actionable.
- A mutating replay may promote an `observed` receipt exactly once. Duplicate
  observe-only deliveries return the existing `observed` receipt; duplicate
  mutating deliveries return the existing `promoted`, `succeeded`, `failed`, or
  `dead_lettered` outcome without creating another domain event.
- Provider replay never bypasses idempotency. Replayed receipts return the
  existing receipt/job outcome.
- Failed target processing creates `job_attempts` and, after retry exhaustion,
  `dead_letter_events`; manual replay is audited through `product_audit_events`.
- During legacy-to-target rollback, only receipts with no successful legacy
  mutation may be replayed into legacy or manually reconciled.
- During target retry, legacy routes stay non-mutating. If legacy mutates again,
  target replay stops until the domain owner reconciles the duplicate risk.
- Provider dashboards are not the product audit trail. `external_webhook_events`
  and `product_audit_events` are the cutover audit trail.

## Scheduler freeze matrix

| Legacy job id                        | Current cadence/effect                                                       | Rehearsal state                                                                                                      | Cutover state before target equivalent                   | Target owner                  | Rehearsal owner                   | Cutover owner                     | Rollback                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------- | --------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `expire_pending_bookings`            | Every minute; expires host-response-deadline bookings                        | Disable unless Booking target job owns the same booking lifecycle events                                             | Off before target `booking.lifecycle-sweep` runs         | Booking/checkout              | Booking engineer                  | Booking engineer                  | Stop target sweep, replay/audit target mutations, re-enable legacy only after Booking owner approves                          |
| `cancel_stale_unpaid_bookings`       | Every 10 minutes; cancels pending unpaid card bookings older than 30 minutes | Disable unless Booking target job owns stale unpaid cancellation                                                     | Off before target stale-unpaid job runs                  | Booking/checkout              | Booking engineer                  | Booking engineer                  | Stop target job, verify no target-owned booking remains mid-transition, re-enable legacy                                      |
| `cleanup_expired_drafts`             | Every 10 minutes; deletes expired booking drafts                             | Disable when target owns draft state; otherwise legacy may remain owner for legacy-only drafts                       | Off before target draft cleanup runs                     | Booking/checkout              | Booking engineer                  | Booking engineer                  | Re-enable legacy only for legacy draft table ownership                                                                        |
| `process_property_payouts`           | Hourly; dispatches hotel Stripe/Xendit payouts                               | Disable for rehearsal unless Finance target dispatch is `observe_only`; no live provider transfer from both runtimes | Off before target payout dispatcher is enabled           | Finance                       | Finance engineer                  | Finance engineer                  | Stop target dispatcher, reconcile provider transfer ids, re-enable legacy only for payouts with no target transfer            |
| `process_affiliate_payouts`          | Monthly day 1 at 02:00; dispatches affiliate payouts and notifications       | Disable unless rehearsal date is outside monthly window and finance owner accepts no-op risk                         | Off before target affiliate payout dispatcher is enabled | Finance/marketplace affiliate | Finance engineer                  | Finance engineer                  | Stop target dispatcher, reconcile transfer ids and notifications, re-enable legacy next monthly window only                   |
| `poll_xendit_processing_payouts`     | Every 30 minutes; polls Xendit for processing payouts if webhook failed      | Disable when Xendit target webhook/reconciliation owns payout status                                                 | Off before target payout reconciliation starts           | Finance                       | Finance engineer                  | Finance engineer                  | Stop target reconciliation, re-enable legacy only after target webhook mode returns to observe-only                           |
| `poll_channex_bookings`              | Interval by `CHANNEX_POLL_INTERVAL_MINUTES`; ingests Channex booking feed    | Disable unless target is observe-only and provider feed is frozen                                                    | Off before target Channex booking intake runs            | PMS channel-connectivity      | PMS channel-connectivity engineer | PMS channel-connectivity engineer | Stop target intake, set legacy mutating, replay only target receipts not already mapped                                       |
| `full_channex_ari_sync`              | Daily at `CHANNEX_FULL_SYNC_HOUR`; pushes full ARI to Channex                | Disable for rehearsal unless Channex provider freeze is documented                                                   | Off before target ARI push runs                          | PMS channel-connectivity      | PMS channel-connectivity engineer | PMS channel-connectivity engineer | Stop target ARI jobs, re-enable legacy only after inventory version reconciliation                                            |
| `advance_calendar_auto_open_windows` | Daily at 01:15; opens rolling inventory/calendar windows                     | Disable once target owns inventory/calendar writes and distribution snapshots                                        | Off before target auto-open job runs                     | PMS operations                | PMS operations engineer           | PMS operations engineer           | Stop target job, compare `inventory_days`/legacy calendar horizon, re-enable legacy only for unreconciled legacy-owned hotels |

`poll_channex_messages` is not currently scheduled and must stay manual-only.
If it is used during cutover, PMS channel-connectivity owner must create a
one-time replay record with the requested provider scope, reason, and
idempotency audit result.

## Rollback

### Abort before provider switch

1. Leave providers pointing at legacy URLs.
2. Set target webhook intake to `observe_only` or disable it.
3. Re-enable any legacy scheduler job that was frozen for rehearsal, in the
   reverse order of the freeze matrix.
4. Keep target raw receipts for analysis; do not replay them mutatively.

### Roll back during endpoint switch

1. Stop changing additional provider endpoints.
2. Set the failed provider's target route to `observe_only` with durable receipt
   writes or `proxy_to_legacy`. Do not use a receipt-less 2xx ack.
3. Repoint the provider dashboard endpoint to the exported legacy URL.
4. Set the matching legacy route to `mutating`.
5. Keep schedulers frozen until the domain owner confirms no target job remains
   running for that provider/domain.
6. Re-enable only the scheduler jobs required for the rolled-back provider.
7. Reconcile target receipts created during the failed window:
   - receipts with successful target domain events are not replayed into legacy;
   - receipts without successful target domain events may be replayed or
     manually reconciled by the domain owner;
   - every target-acknowledged event must have a successful target mutation,
     successful legacy mutation, or audited manual disposition;
   - all manual decisions are written to `product_audit_events` or the release
     incident record.

### Roll back after target scheduler enablement

1. Pause target job claims for the affected job type.
2. Wait for running target jobs to finish or mark them cancelled/superseded.
3. Compare job idempotency keys with legacy source rows.
4. Re-enable the legacy job only for resource scopes that have no successful
   target job in the same semantic window.
5. If provider side effects may already have been sent, prefer provider
   reconciliation over blind legacy replay.

## Staging rehearsal requirements

The staging rehearsal passes only if all of these are true:

1. Every live external event source either points at target idempotent intake or
   has a documented provider freeze with owner, start time, end time, and
   rollback owner.
2. Target `observe_only` intake verifies provider authentication and writes raw
   receipts for the active provider gate: Stripe and Channex. Xendit synthetic
   replay may be retained as non-blocking evidence until real runtime usage is
   confirmed.
3. Replaying the same provider sample twice creates one receipt, one normalized
   domain event, and no duplicate jobs.
4. Receipt lifecycle tests prove observe-only duplicate delivery,
   observe-to-mutating promotion, and mutating duplicate delivery.
5. The scheduler freeze matrix is exercised:
   - each disabled legacy job is proven not to fire;
   - each target replacement job is either dry-run/observe-only or explicitly
     deferred;
   - owner approvals are recorded for every row.
6. The Channex admin route freeze matrix is exercised so mutation routes are
   disabled, proxied, or target-owned before target Channex jobs mutate.
7. Channex rehearsal proves one of:
   - target intake receives live Channex events idempotently; or
   - Channex is frozen and no global webhook/message/feed mutation is expected.
8. Finance rehearsal proves Stripe callbacks cannot double-mark a payment or
   payout when old and new URLs both receive retries. Xendit has the same
   requirement only if it is reintroduced into the active cutover scope.
9. Booking rehearsal proves payment-driven instant-book finalization,
   cancellation/expiry sweeps, and guest notification jobs use stable
   idempotency keys.
10. Rollback is rehearsed for at least one provider. For VAY-794 staging
    rehearsal evidence, an abort-before-switch rollback proof is acceptable when
    provider dashboards stay pointed at legacy, target remains non-mutating, the
    target runtime is stopped or disabled after replay, and exports prove legacy
    remains the live delivery path. Production cutover requires the stronger
    roll-back-during-switch path if a provider dashboard endpoint is actually
    changed.
11. Dashboards show provider receipt counts, dedupe hits, dead letters, and job
    lag by provider/domain.

## Implementation tickets ready to create on acceptance

1. **Add target provider webhook intake modes and receipt dedupe**
   - Scope: TypeScript routes for Stripe, Xendit, and Channex in
     `observe_only`, `mutating`, and `ack_only_with_receipt`; write
     `external_webhook_events` and `idempotency_keys`; verify signatures/tokens;
     add replay fixtures.
   - Labels: Backend, Platform.

2. **Add legacy PMS webhook cutover modes**
   - Scope: env-controlled `mutating`, `ack_only_with_receipt`, and
     `proxy_to_target` modes for `apps/pms-api` provider webhook routes; include
     tests that legacy does not mutate in non-mutating modes.
   - Labels: Backend, Platform.

3. **Add legacy PMS scheduler freeze controls**
   - Scope: environment-level scheduler disable plus per-job allowlist/blocklist
     for the nine legacy scheduler jobs; expose startup logs and a health/admin
     check showing active/frozen jobs.
   - Labels: Backend, Platform.

4. **Add legacy Channex admin cutover guards**
   - Scope: env-controlled read-only, disabled, proxy-to-target, and
     target-owned modes for the Channex admin route groups; specifically guard
     provisioning, enable/disable, markups, manual ARI sync, manual booking
     sync, messaging install/backfill, iframe URL, and webhook setup.
   - Labels: Backend, Platform.

5. **Implement Channex booking and message target intake jobs**
   - Scope: normalize Channex receipts into PMS channel events and durable jobs;
     dedupe by property/message/booking revision; keep Booking Engine free of
     Channex imports.
   - Labels: Backend, Platform.

6. **Implement target ARI and calendar scheduler jobs**
   - Scope: target full/incremental ARI push and rolling calendar auto-open jobs
     with idempotency windows, retry/dead-letter behavior, and Channex provider
     attempt records.
   - Labels: Backend, Platform.

7. **Implement target payment/payout webhook reconciliation jobs**
   - Scope: Stripe payment/Connect and Xendit invoice/payout event handling;
     payment/payout status idempotency; provider replay tests; Finance audit
     events.
   - Labels: Backend, Platform.

8. **Implement target booking lifecycle scheduler jobs**
   - Scope: pending booking expiry, stale unpaid cancellation, and expired draft
     cleanup in target Booking with stable lifecycle idempotency and guest-safe
     audit events.
   - Labels: Backend, Platform.

9. **Build C1 staging rehearsal dashboards and replay fixtures**
   - Scope: provider receipt counts, dedupe hits, job lag, dead letters, legacy
     scheduler frozen-state checks, and replay fixtures for Channex, Stripe, and
     Xendit.
   - Labels: Backend, Platform, DX.

10. **Execute C1 staging rehearsal and record go/no-go evidence**

- Scope: run this plan in staging, attach provider exports, freeze matrix
  approvals, replay outputs, rollback proof, and follow-up defects.
- Labels: Platform.
