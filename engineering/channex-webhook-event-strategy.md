# Channex webhook event strategy

_VAY-839 research decision. Related: VAY-772, VAY-794._

## Recommendation

Use Channex webhooks as durable triggers and observability, not as the sole
source of truth for provider state. For C1, subscribe to `message`, `booking`,
`review`, and `updated_review`. Keep booking import pull/feed-owned: the webhook should enqueue
or wake the target booking revision ingestion job, and that job should pull the
booking revision/feed from Channex before mutating PMS state.

Do not subscribe to ARI, sync/error, channel lifecycle, or Airbnb request
events in the C1 production switch. Those events either require target
jobs that do not yet own the corresponding side effects, or they are operational
alerts that should first land in a lower-risk observability workflow.

The Channex API documentation lists webhooks for ARI, booking revisions,
unmapped bookings/rates, non-acknowledged bookings, messages, sync/rate errors,
Airbnb request flows, reviews, and channel lifecycle events. It also describes
booking webhooks as a trigger to pull a booking revision/feed, and warns that
webhook calls can arrive out of order, especially for ARI changes. Source:
`https://docs.channex.io/api-v.1-documentation/webhook-collection`, accessed
2026-06-17.

## Current Vayada State

Legacy `apps/pms-api` currently:

- registers or updates a global Channex webhook with `event_mask="message"`,
  `send_data=true`, and `X-Vayada-Webhook-Token`;
- rejects `/webhooks/channex` when `CHANNEX_WEBHOOK_SECRET` is missing;
- verifies `X-Vayada-Webhook-Token`;
- logs every received Channex event into `channex_webhook_events`;
- processes only `event="message"`;
- returns ignored for non-message events;
- imports bookings through the Channex booking revision feed/polling path.

Target `apps/api` currently:

- has Channex webhook receipt classification for message payloads and booking
  revision payloads;
- generates receipt keys for message and booking events;
- previews `channex.message.ingest` and `channex.booking.ingest` domain events
  and jobs;
- falls back to a payload-hash receipt key for unknown Channex event types;
- stores `review` and `updated_review` events through an idempotent durable job
  consumer and exposes property-scoped review reads to the PMS;
- does not yet implement mutating target handlers for every other Channex event class.

## Event Decision Matrix

| Event mask              | C1 decision                                              | Post-C1 decision                                              | Rationale                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`               | Subscribe and process                                    | Keep                                                          | Required for real-time guest/channel messaging. Current legacy path already processes it, and target receipt/job contracts exist.                                        |
| `booking`               | Subscribe as trigger; pull revision/feed before mutation | Keep as the canonical booking webhook                         | Covers new, modified, and cancelled booking revisions without duplicate subtype subscriptions. Channex expects PMS to pull the revision/feed after receiving this event. |
| `booking_new`           | Do not subscribe                                         | Ignore unless `booking` proves too broad                      | Redundant with `booking`; subscribing to both risks duplicate receipt/job paths for the same revision.                                                                   |
| `booking_modification`  | Do not subscribe                                         | Ignore unless `booking` proves too broad                      | Redundant with `booking`; same duplicate-risk concern.                                                                                                                   |
| `booking_cancellation`  | Do not subscribe                                         | Ignore unless `booking` proves too broad                      | Redundant with `booking`; same duplicate-risk concern.                                                                                                                   |
| `booking_unmapped_room` | Do not subscribe for C1                                  | Add as operational alert after support workflow exists        | High-priority mapping issue, but not a booking mutation path. Needs notification/triage ownership before activation.                                                     |
| `booking_unmapped_rate` | Do not subscribe for C1                                  | Add as operational alert after support workflow exists        | Mapping issue with lower scope than unmapped room; should route to support/ops, not booking ingestion mutation.                                                          |
| `non_acked_booking`     | Do not subscribe for C1                                  | Add after target ack/retry dashboards exist                   | Useful as safety alert for missed acknowledgements, but should not mutate bookings directly.                                                                             |
| `ari`                   | Do not subscribe for C1                                  | Defer until target ARI pull/reconcile jobs exist              | Channex warns ARI webhooks can arrive out of order; treat as a trigger to pull current state, never as source-of-truth payload.                                          |
| `sync_error`            | Do not subscribe for C1                                  | Add as operational alert                                      | Useful for channel health dashboards and support, but not required for C1 mutating cutover.                                                                              |
| `sync_warning`          | Do not subscribe for C1                                  | Add as operational alert                                      | Same as `sync_error`, with lower severity.                                                                                                                               |
| `rate_error`            | Do not subscribe for C1                                  | Add as operational alert                                      | Needs rate-plan/ARI owner workflow and dashboard before activation.                                                                                                      |
| `reservation_request`   | Do not subscribe                                         | Defer until Airbnb request/approve/deny product flow exists   | Airbnb-specific workflow, not part of current C1 cutover.                                                                                                                |
| `alteration_request`    | Do not subscribe                                         | Defer until Airbnb alteration workflow exists                 | Airbnb-specific workflow, not part of current C1 cutover.                                                                                                                |
| `accepted_reservation`  | Do not subscribe                                         | Defer with Airbnb request workflow                            | Derived from a deferred request flow.                                                                                                                                    |
| `declined_reservation`  | Do not subscribe                                         | Defer with Airbnb request workflow                            | Derived from a deferred request flow.                                                                                                                                    |
| `inquiry`               | Do not subscribe                                         | Defer unless PMS messaging/product scope requires it          | Airbnb-specific and overlaps with messaging UX decisions.                                                                                                                |
| `review`                | Subscribe and process                                    | Keep                                                          | The target PMS owns durable, idempotent review storage and a protected read surface.                                                                                     |
| `updated_review`        | Subscribe and upsert                                     | Keep                                                          | Uses the same provider review identity, so revisions update the existing review instead of duplicating it.                                                               |
| `new_channel`           | Do not subscribe                                         | Add only if channel lifecycle automation is product-owned     | Channel lifecycle state is currently admin/setup-owned, not an automatic mutating event.                                                                                 |
| `updated_channel`       | Do not subscribe                                         | Add only if channel lifecycle automation is product-owned     | Same as `new_channel`.                                                                                                                                                   |
| `disconnected_channel`  | Do not subscribe                                         | Add as operational alert after channel health workflow exists | Important alert, but should not auto-mutate until owner workflow exists.                                                                                                 |
| `disconnect_listing`    | Do not subscribe                                         | Defer to Airbnb/channel lifecycle workflow                    | Airbnb/channel-lifecycle-specific.                                                                                                                                       |
| `activate_channel`      | Do not subscribe                                         | Add only if channel lifecycle automation is product-owned     | Same channel lifecycle concern.                                                                                                                                          |
| `deactivate_channel`    | Do not subscribe                                         | Add only if channel lifecycle automation is product-owned     | Same channel lifecycle concern.                                                                                                                                          |

## C1 Subscription Shape

Use global webhooks, not property-scoped webhooks, for C1.

Reasons:

- current legacy setup assumes one account-level/global webhook;
- one global callback is easier to switch and roll back in the provider
  dashboard;
- per-property setup would add drift risk during cutover;
- payloads include `property_id`, and target receipt keys already include
  property scope.

If Channex only accepts one `event_mask` value per webhook, create or update one
global webhook for `message` and one global webhook for `booking`, both pointing
to the same callback URL with the same `X-Vayada-Webhook-Token`. Do not invent a
comma-separated or array-shaped `event_mask` without confirming Channex accepts
that shape in staging first.

Set `send_data=true` for both C1 webhooks. The target should still treat booking
payloads as hints and pull the revision/feed before mutation. Disabling
`send_data` would make dedupe and debugging weaker during the switch.

## Target Receipt and Job Ownership

### Message

- Raw receipt key:
  `webhook:channex:message:<property_id>:<message_id or source_message_id>`.
- Domain event key:
  `channex.message.ingest:<property_id>:<thread_id>:<source_message_id>:v1`.
- Job key:
  `channex.ingest-message:channel_message:<property_id>:<source_message_id>:v1`.
- Owner: PMS channel-connectivity.
- Target behavior: ingest or update PMS message/thread state idempotently.

### Booking

- Raw receipt key:
  `webhook:channex:booking:<property_id>:<booking_revision_id or channel_booking_id>:<revision>`.
- Domain event key:
  `channex.booking.ingest:<property_id>:<channel_booking_id>:<revision>:v1`.
- Job key:
  `channex.ingest-booking:channel_booking:<property_id>:<channel_booking_id>:revision-<revision>:v1`.
- Owner: PMS channel-connectivity.
- Target behavior: enqueue a durable inbound revision job that pulls the
  revision/feed from Channex, then processes create/modify/cancel idempotently.

### Deferred Operational Alerts

For `booking_unmapped_room`, `booking_unmapped_rate`, `non_acked_booking`,
`sync_error`, `sync_warning`, and `rate_error`, the first implementation should
write raw receipts and route alerts to PMS/channel operations. These should not
mutate inventory, bookings, mappings, or ARI directly.

### Deferred ARI

For `ari`, the target should never mutate from the webhook payload alone. The
only acceptable target behavior is: receive event, dedupe receipt, enqueue a
pull/reconcile job for the changed property/date scope, and compare current
Channex/provider state with Vayada-owned PMS inventory/ARI state before any
write.

## Cutover and Rollback Interaction

During C1:

- legacy remains the only mutating owner until the provider endpoint switch;
- target may run in `observe_only` and record message/booking receipts;
- legacy `poll_channex_bookings` must be frozen before target booking ingestion
  becomes mutating;
- target booking webhook jobs must not run mutating while legacy polling still
  processes the same feed/revisions;
- old legacy callback URLs should stay reachable in `ack_only_with_receipt` or
  `proxy_to_target` for the Channex retry horizon after switch;
- rollback sets target Channex intake back to `observe_only`, restores legacy
  `mutating`, and re-enables `poll_channex_bookings` only after the PMS owner
  confirms no target booking ingestion job remains running.

If `booking` is enabled as a C1 webhook before target booking processing is
mutating, the target must treat it as observe-only evidence or a non-mutating
job preview. It must not acknowledge Channex booking revisions on behalf of the
mutating owner until target owns booking ingestion.

## Follow-Up Implementation Tickets

1. VAY-844: Update Channex webhook setup to support the VAY-839 event policy.
   - Add a configurable desired event set with C1 default `message,booking`.
   - Reconcile one global webhook per event mask unless Channex staging proves a
     multi-mask request shape.
   - Keep `send_data=true`, `is_global=true`, and
     `X-Vayada-Webhook-Token`.

2. VAY-845: Implement target Channex booking webhook job promotion.
   - Promote observed `booking` receipts into durable
     `channex.ingest-booking` jobs only after target owns booking ingestion.
   - Pull booking revision/feed before mutation.
   - Prove duplicate `booking`, `booking_new`, `booking_modification`, and
     `booking_cancellation` samples cannot double-import a revision.

3. VAY-846: Add Channex operational alert webhook intake.
   - Cover `booking_unmapped_room`, `booking_unmapped_rate`,
     `non_acked_booking`, `sync_error`, `sync_warning`, and `rate_error`.
   - Route to PMS/channel operations dashboards or notifications.
   - Keep alerts non-mutating.

4. VAY-847: Add an ARI webhook pull/reconcile design ticket.
   - Define the pull/reconcile job contract for `ari`.
   - Explicitly reject interpreting out-of-order ARI webhook payloads as the
     source of truth.
   - Gate activation behind target ARI scheduler ownership.
