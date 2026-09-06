# Native Guest Inbox contract

- Status: approved combined-Inbox contract for `native-guest-inbox.v2`
- Owner: PMS Operations
- Decision source: [VAY-905](https://linear.app/vayadacom/issue/VAY-905/define-native-guest-inbox-mvp-and-cutover-plan)
- Contract ticket: [VAY-1369](https://linear.app/vayadacom/issue/VAY-1369/define-the-target-guest-messaging-contract)

## Purpose

This contract defines the target-system boundary for property teams to triage,
coordinate, and reply to guest conversations with optional human-reviewed
assistance. It is implemented in `apps/api`, consumed by `apps/pms-web`, and
owned by the PMS Operations module. Marketplace creator chat remains a separate
product and data model.

The normative examples are in
`engineering/fixtures/native-guest-inbox/cases.json`.

## MVP boundary

Included:

- property-scoped thread list, detail, unread count, read, triage, follow-up,
  assignment, internal-note, direct-email thread start, and manual reply
  commands;
- Booking.com and Airbnb conversations received and delivered through Channex,
  including Airbnb inquiry threads without a booking;
- direct manual email only when a real guest email and an approved property
  sender are available;
- private image or PDF attachments prepared by Platform Media;
- visible queued, retrying, sent, held, and failed delivery states;
- property-scoped quick replies with validated preview before composition;
- translate, summarize, and draft assistance that can never send without a
  separate explicit staff reply command;
- shared property-thread unread state and explicit linked, inquiry, and
  unlinked conversation context.

Excluded:

- Marketplace chat, WhatsApp, SMS, social, web chat, phone, voice, cross-property
  queues, advanced routing, SLA tooling, analytics, and automations;
- autonomous AI sending or actions;
- per-user unread state and silent fallback between delivery channels;
- any Inbox runtime implementation in this contract ticket.

## Ownership and dependencies

| Concern                                           | Owner                           | Inbox dependency                                                |
| ------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| HTTP routes, thread workflow, reply orchestration | PMS Operations                  | Owns this contract and its read model                           |
| Booking identity and guest contact                | PMS Operations booking boundary | Supplies a property-scoped booking link and contact port        |
| Inbound/outbound OTA transport                    | Channex adapter                 | Translates provider payloads; does not own Inbox state          |
| Email transport and approved sender               | Email adapter                   | Delivers only an explicitly resolved email route                |
| Attachment validation and private storage         | Platform Media                  | Purpose `pms.messaging.attachment`                              |
| Durable work, retries, and idempotency            | Platform jobs/events            | Uses the shared outbox, jobs, attempts, and idempotency records |
| Authentication and property access                | Platform identity/access        | Supplies `RequestContext` and `enforceRoutePolicy`              |

Provider payloads are not the authorization or booking source of truth. The API
must resolve the property, booking link, entitlement, and staff relationship
from target-system records.

## Authorization contract

Every route requires an authenticated `RequestContext`, an active
`pms:property-management` entitlement, and access to the canonical
`pms_property` resource in the URL. `owner`, `operator`, and `front_desk`
relationships may receive Inbox permissions through the staff-access policy.

| Operation                                                   | Required permissions                   |
| ----------------------------------------------------------- | -------------------------------------- |
| list, detail, unread count, mark read                       | `pms.inbox.read`                       |
| triage, follow up, assign, note, start thread, manual reply | `pms.inbox.read` and `pms.inbox.reply` |
| execute an available provider-specific action               | `pms.inbox.read` and `pms.inbox.reply` |
| manage/use quick replies                                    | `pms.inbox.read` and `pms.inbox.reply` |
| translate, summarize, draft                                 | `pms.inbox.read` and `pms.inbox.reply` |
| prepare/finalize an Inbox attachment                        | `pms.inbox.reply`                      |

`pms.guest_contact.read` is additionally required to return a guest email or
phone number. Without it, the route remains usable but those fields are omitted;
the guest display name, booking reference, and route availability may still be
shown. Internal route resolution may use a Booking-owned contact port without
exposing the contact value to the caller.

Denials use the shared error envelope and do not reveal whether a thread exists:

| Condition                                | HTTP | Code                      |
| ---------------------------------------- | ---- | ------------------------- |
| no or invalid authentication             | 401  | `unauthenticated`         |
| missing exact Inbox permission           | 403  | `missing_permission`      |
| no PMS entitlement                       | 403  | `missing_entitlement`     |
| suspended or inactive entitlement        | 403  | `inactive_entitlement`    |
| no active link to the requested property | 403  | `missing_resource_access` |

## Domain semantics

### Thread

A thread belongs to exactly one property and has an immutable source identity,
an optional property-scoped booking link, a channel, shared unread state, and a
monotonic `version` used by staff commands.

`attentionState` is exactly `needs_attention`, `follow_up`, or `done`. These are
local, reversible Vayada workflow states and never imply that an OTA provider
closed a conversation. `follow_up` requires a future `followUpAt` and records
the actor. A durable `pms.inbox.follow-up.release` job moves a due thread to
`needs_attention` idempotently only if its scheduled timestamp still matches the
thread; a superseded job is a no-op. `done` and `needs_attention` clear
follow-up metadata.

Every newly accepted inbound guest message increments unread once, updates
activity, advances the version, and moves `follow_up` or `done` to
`needs_attention` in the same transaction. An accepted manual reply does not
automatically complete the thread; staff retain explicit control of triage.
Legacy `no_reply_needed` maps to `done` with reason
`legacy_no_reply_needed` and preserved audit evidence.

`unreadCount` is shared by all staff at the property in v2. `activityAt` plus
`id` is the deterministic recent-first ordering key; `activityAt` is the last
message or internal-note time or, for an empty direct thread, its creation time.

Assignment is optional and points to one active membership with access to the
same property. Assignment changes are versioned and audited. Removing a member's
property access clears their active assignments through an audited reconciliation
job; it does not hide or delete conversations.

An internal note belongs to the property and thread, records its author and
timestamp, advances thread activity/version, and is visible only to authorized
property staff. Notes are never passed to a delivery adapter or returned to a
guest-facing surface.

### Conversation context

`conversationContext.state` is `linked`, `inquiry`, or `unlinked`. A linked
booking must belong to the same property as the thread. An inquiry retains the
provider inquiry identity and only normalized dates/guest counts that the
provider supplied; it does not invent a booking. An unlinked thread remains
readable and shows the provider reference when retained, but the API must not
invent or cross-property-match a booking.

### Message

A message belongs to one thread and property, has direction `inbound` or
`outbound`, sender metadata, retained text, timestamps, and zero or more
attachments. Inbound provider messages are unique by thread and provider source
message ID. Outbound manual messages are unique by the accepted command's
idempotency record.

### Quick reply and assisted content

A quick reply is property-scoped, staff-authored reusable text with a stable
name and optional approved variables. Selecting one performs a preview against
the thread's target booking/property ports. Preview returns rendered text and
unresolved variables but does not create a message or delivery job. Unknown or
required unresolved variables block use in the composer.

Assistance operations are `translate_message`, `translate_draft`, `summarize`,
and `draft_reply`. They use a pinned `throughMessageId` where conversation
context matters, minimize guest PII, and return text labeled as assisted output.
An assistance result is never a Message, never changes thread triage, and never
creates an outbox job. Staff may edit the result and must submit the normal
manual-reply command to send it. Manual reply remains available when the
assistance service is unavailable.

### Attachment

An attachment references a finalized private Platform Media object with purpose
`pms.messaging.attachment`. Manual replies accept finalized media IDs, not raw
URLs or bytes. PMS Operations revalidates property ownership, purpose, readiness,
MIME type, size, and resolved-channel limits immediately before enqueueing.
Approved MVP types are private images and PDFs; provider-specific limits may be
stricter than the platform limit. Stored source URLs and signed serving URLs are
never durable public identifiers.

The allowed MIME types are `image/jpeg`, `image/png`, `image/webp`, `image/gif`,
`image/heic`, `image/heif`, and `application/pdf`.

The existing Platform Media policy for this purpose must change from the broad
compatibility permission `pms.operations.manage` to `pms.inbox.reply` and accept
only the canonical `pms:pms_property` resource. Possessing
`pms.operations.manage` alone must not authorize an Inbox attachment. The final
reply command still requires both Inbox permissions and revalidates that each
media object belongs to its thread's property.

### Delivery state and attempt

The message-level delivery state is the staff-visible projection:

- `queued`: durable work exists and has not completed;
- `retrying`: the last attempt failed transiently and a retry is scheduled;
- `sent`: the adapter accepted the message for delivery;
- `held`: an allowed send is not currently safe because routing, access,
  configuration, or provider outcome is unresolved; no silent fallback occurred;
- `failed`: a terminal validation or delivery failure occurred.

`held` creates no provider attempt. Each actual adapter execution creates an
attempt with outcome `running`, `accepted`, `transient_failure`, or
`terminal_failure`. It records the resolved channel, adapter, attempt number,
timestamps, sanitized provider reference, and normalized failure code. A
transient failure plus a scheduled next run projects `retrying`; an accepted
attempt projects `sent`. A terminal attempt projects `held` for an unchanged
message awaiting safe configuration/review, or `failed` when a corrected command
is required; exhausted retries project `failed`. Scheduling fields may change
while work is active, but a completed attempt's route, outcome, and evidence are
immutable.

A provider delivery/read acknowledgement is an append-only receipt linked to the
message and accepted attempt, not a mutation of completed attempt evidence. It
is exposed only when the provider supplies a trustworthy acknowledgement.

## HTTP contract

All routes are under:

```text
/api/pms/properties/:propertyId/messaging
```

Identifiers are opaque strings. Timestamps are UTC ISO-8601 values. Successful
responses include `contractVersion: "native-guest-inbox.v2"`.

These are the shared wire shapes (nullable fields are returned explicitly unless
marked optional for permission-based redaction):

```ts
type ReplyRoute =
  | {
      state: "ready";
      channel: "ota" | "email";
      providerChannel: string | null;
      reasonCode: null;
    }
  | {
      state: "held";
      channel: null;
      providerChannel: string | null;
      reasonCode:
        | "channel_connection_inactive"
        | "provider_conversation_unavailable"
        | "guest_email_unavailable"
        | "approved_sender_unavailable"
        | "email_policy_disallowed";
    };

type ThreadSummary = {
  id: string;
  version: number;
  attentionState: "needs_attention" | "follow_up" | "done";
  followUpAt: string | null;
  assignedTo: null | { membershipId: string; displayName: string };
  channel: "ota" | "email";
  providerChannel: string | null;
  guest: { displayName: string | null; email?: string; phone?: string };
  conversationContext:
    | {
        state: "linked";
        bookingId: string;
        reference: string;
        stay: {
          checkIn: string;
          checkOut: string;
          nights: number;
          adults: number;
          children: number;
          roomCount: number;
          roomName: string | null;
          roomNumber: string | null;
          status: string;
        };
      }
    | {
        state: "inquiry";
        bookingId: null;
        sourceReference: string;
        arrivalDate: string | null;
        departureDate: string | null;
        adults: number | null;
        children: number | null;
      }
    | { state: "unlinked"; bookingId: null; sourceReference: string | null };
  unreadCount: number;
  activityAt: string;
  lastMessage: {
    preview: string | null;
    at: string | null;
    hasAttachments: boolean;
  };
  replyRoute: ReplyRoute;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  sender: { type: "guest" | "property_user" | "channel" | "system"; name: string | null };
  text: string | null;
  occurredAt: string;
  readAt: string | null;
  attachments: Array<{
    id: string;
    availability: "available" | "unavailable";
    mediaId: string | null;
    filename: string | null;
    contentType: string | null;
    size: number | null;
    accessPath: string | null;
  }>;
  delivery: null | {
    state: "queued" | "retrying" | "sent" | "held" | "failed";
    channel: "ota" | "email" | null;
    reasonCode: string | null;
    providerAcknowledgedAt: string | null;
  };
};

type InternalNote = {
  id: string;
  author: { membershipId: string; displayName: string };
  text: string;
  occurredAt: string;
};

type TimelineItem =
  | { kind: "message"; message: Message }
  | { kind: "internal_note"; note: InternalNote };
```

When present, `accessPath` is an authenticated Platform Media route, not a
durable signed URL. New attachments must return `available` with complete
metadata. An incomplete migrated attachment returns `unavailable` with nullable
metadata and no raw source URL. `Message.delivery` is `null` for inbound
messages. Thread detail returns chronological `TimelineItem` values; internal
notes never appear in guest-facing adapters or exports.

### Mutation idempotency

Every POST requires `Idempotency-Key`. The route re-runs authentication,
permission, entitlement, and property-resource checks before looking up a prior
result. Records use `operation_scope=pms`, `tenant_scope=property`, and a distinct
operation per command:

```text
pms.inbox.thread.start_direct_email
pms.inbox.thread.mark_read
pms.inbox.thread.mark_done
pms.inbox.thread.follow_up
pms.inbox.thread.reopen
pms.inbox.thread.assign
pms.inbox.thread.add_note
pms.inbox.quick_reply.create
pms.inbox.quick_reply.update
pms.inbox.quick_reply.archive
pms.inbox.quick_reply.preview
pms.inbox.assist
pms.inbox.provider.no_reply_needed
pms.inbox.thread.reply
```

The fingerprint input is canonical JSON containing the operation, property ID,
thread or booking ID, and normalized request body. Only its cryptographic hash is
stored. Idempotency and audit metadata exclude message/note/assist text,
filenames, guest contacts, and the raw client key. The same key may therefore be
used independently for another property or operation; reusing it for a different
resource or payload within the same property and operation returns `409
idempotency_conflict`.

Completed records remain replayable for at least 30 days and never expire before
their related message's content-retention window. An outbound message also keeps
a unique non-content source identity derived from the property, thread, and key
hash so expiry or content deletion cannot create a duplicate send.

### List threads

```http
GET /threads?attentionState=needs_attention&unread=true&channel=ota&assignee=me&search=lee&limit=25&cursor=...
```

- `attentionState`: `needs_attention`, `follow_up`, or `done`;
- `unread`: boolean;
- `channel`: `ota` or `email`;
- `assignee`: `me`, `unassigned`, or an eligible membership ID;
- `search`: guest display name, booking/inquiry reference, or retained
  message/note text;
- `limit`: 1–100, default 25;
- `cursor`: opaque recent-first `(activityAt,id)` continuation.

The response returns `items` and `nextCursor`. Each item includes thread ID,
version, attention state, follow-up time, assignee, channel, guest display name,
conversation context/reference, unread count, retained last-message preview and
timestamp, attachment indicator, and current `replyRoute`. Contact values follow
the extra PII permission.

Pagination is snapshot-stable for the cursor boundary: ties use the thread ID,
and an item updated after page one may reappear only in a new traversal. Invalid
or filter-mismatched cursors return `400 invalid_cursor`. `activityAt` is
`GREATEST(COALESCE(last_message_at, created_at),
COALESCE(last_internal_note_at, created_at))`, so an intentionally created empty
direct thread participates in the same non-null keyset ordering.

### Thread detail

```http
GET /threads/:threadId?messageLimit=50&before=...
```

The response returns the complete thread summary, minimal booking or inquiry
context, `replyRoute`, available provider actions, and a chronological page of
messages and internal notes. `previousCursor` loads older timeline items using
an opaque `(occurredAt,kind,id)` boundary, including `kind` as the deterministic
tie-breaker across both tables. Attachment entries expose an authorized private-
media descriptor, never a stored public URL.

`replyRoute` is advisory. The reply command must resolve it again inside its
transaction.

### Unread count

```http
GET /unread-count
```

Returns the number of threads with `unreadCount > 0` and the sum of unread
messages for the property.

### Mark read

```http
POST /threads/:threadId/read
Idempotency-Key: <opaque client key>

{"readThroughMessageId":"msg_123"}
```

Only inbound messages at or before the named message become read. A concurrent
inbound message remains unread. Replaying the same key returns the original
result. A message outside the thread, or a non-inbound boundary, returns `400
validation_failed`.

### Triage, follow-up, assignment, and notes

```http
POST /threads/:threadId/done
POST /threads/:threadId/follow-up
POST /threads/:threadId/reopen
Idempotency-Key: <opaque client key>

{"expectedThreadVersion":12}
{"expectedThreadVersion":12,"followUpAt":"2026-09-03T09:00:00.000Z"}
```

`done` and `reopen` move the thread to `done` and `needs_attention` respectively.
`follow-up` requires a future time, moves it to `follow_up`, and schedules the
durable release job. These commands are local: no provider conversation is
changed. A stale version returns `409 thread_version_conflict`; a same-key
replay returns the original result before the version check.

```http
POST /threads/:threadId/assignment
POST /threads/:threadId/notes
Idempotency-Key: <opaque client key>

{"expectedThreadVersion":12,"assigneeMembershipId":"membership_123"}
{"expectedThreadVersion":12,"text":"Guest prefers a quiet room."}
```

An assignment may be cleared with `assigneeMembershipId: null`. The assignee
must have active access to the URL property. A note is required, staff-only
text. Both commands atomically advance the thread version and activity and
write non-content audit metadata.

### Quick replies and assisted content

```http
GET  /quick-replies
POST /quick-replies
POST /quick-replies/:quickReplyId/update
POST /quick-replies/:quickReplyId/archive
POST /quick-replies/:quickReplyId/preview
POST /threads/:threadId/assist
Idempotency-Key: <opaque client key>
```

Create accepts a stable name and text; update/archive require the quick reply's
expected version. Archived quick replies are omitted from the default list but
remain auditable. Preview accepts the thread ID and returns `renderedText` plus
`unresolvedVariables`; it creates no message or job. The assistance endpoint
accepts one of `translate_message`, `translate_draft`, `summarize`, or
`draft_reply`, plus the source text or `throughMessageId` required by that
operation. It returns labeled assisted text and the pinned message boundary.
It never sends or mutates the thread. Service failure returns `503
assistance_unavailable`; staff can still write and send a manual reply.

### Provider-specific actions

Thread detail may expose `booking_com_no_reply_needed` only when the provider
conversation supports it. The idempotent command is:

```http
POST /threads/:threadId/provider-actions/no-reply-needed
Idempotency-Key: <opaque client key>
```

It returns `202` after atomically recording audit/outbox evidence for a durable
`pms.inbox.provider-action.deliver` job. Execution revalidates the provider
capability and uses a stable provider idempotency reference; ambiguous outcomes
are held for review rather than retried blindly. It does not implicitly change
the Vayada `attentionState`; staff may separately mark the thread done.
Once an action job has been accepted for a thread, detail suppresses the action
and the command rejects a second key so a reload cannot enqueue a duplicate.

### Start a direct email thread

The reply-authorized direct-booking chooser is exposed through the Inbox
permission boundary so staff do not also need `pms.reservation.read`:

```http
GET /direct-bookings
```

It returns up to 500 property-scoped direct bookings whose canonical lifecycle
is `confirmed`, `canceled`, `completed`, or `no_show`. Items contain the booking
ID/reference, guest display name, dates, and canonical lifecycle only; guest
contact values are not included.

```http
POST /threads
Idempotency-Key: <opaque client key>

{"bookingId":"booking_123"}
```

This command makes the email path reachable without inventing an inbound-email
integration. The booking must be an eligible direct, post-booking reservation in
the URL property. It creates or returns the single thread identified by
`source=manual` and `source_thread_id=direct-email:<bookingId>:v1`, with normalized
channel `email`, no messages, and `activityAt=createdAt`. An OTA reservation is
rejected with `400 direct_email_not_allowed` rather than converted to email.

The command returns `201` when created or `200` when the deterministic thread
already exists. A new thread starts `needs_attention` at version `1`. Missing guest email,
sender approval, or email policy does not invent a route; it creates the thread
with the corresponding held `replyRoute` so staff can see the blocker. No
message or delivery job is created.

### Manual reply

```http
POST /threads/:threadId/messages
Idempotency-Key: <opaque client key>

{
  "expectedThreadVersion": 12,
  "text": "Your room is ready.",
  "attachmentMediaIds": ["media_123"]
}
```

At least text or one attachment is required. The caller cannot select or
override a channel. The command revalidates the thread and attachment scope,
resolves the route, persists the outbound message and delivery projection, and
returns `202` with the message's visible delivery state. A ready route atomically
writes its audit and outbox records; the first provider attempt begins only when
the delivery job executes. A held route writes auditable hold evidence but no
outbox row or provider attempt.

The same idempotency key and payload returns the original response. Reusing the
key with a different payload returns `409 idempotency_conflict`. A stale thread
version returns `409 thread_version_conflict` and sends nothing. Acceptance
atomically increments `thread.version` whether the resolved delivery state is
`queued` or `held`, updates the last-message projection, and returns the new
`threadVersion`. Therefore only one of two different replies using the same
expected version can be accepted. Replying from `done` or `follow_up` atomically
moves the thread to `needs_attention`, clears done/follow-up metadata, writes
`pms.inbox.thread.attention_restored_by_reply` audit evidence, and advances the
version only once for the accepted command.

## Routing and transport boundaries

### OTA through Channex

An OTA-sourced conversation may reply only through its linked Channex
conversation and an active messaging-capable channel connection. If that route
is unavailable, the message is `held` with an explicit reason such as
`channel_connection_inactive` or `provider_conversation_unavailable`. The
system must not fall back to email.

Inbound Channex message handling uses these stable idempotency keys:

```text
webhook:channex:message:<propertyId>:<providerMessageId>
channex.message.ingest:<propertyId>:<threadId>:<providerMessageId>:v1
channex.ingest-message:channel_message:<propertyId>:<providerMessageId>:v1
```

The adapter authenticates and normalizes the webhook; PMS Operations
idempotently creates or updates the thread and message. Duplicate delivery does
not duplicate messages, unread increments, or attention-restored audit entries.
Supported Airbnb inquiry webhooks create an `inquiry` thread with provider
identity and supplied dates/guest count, never an invented booking.

### Direct email

A direct thread may use email only when Booking supplies a real guest email and
the property has an active approved sender. Missing contact, consent/policy
failure, or missing sender results in `held`. An OTA thread never becomes an
email thread merely because an email address exists.

### Durable delivery

Ready replies enqueue `pms.guest-message.deliver` through the shared outbox with:

```text
pms.guest-message.deliver:message:<messageId>:manual-send:v1
```

All attempts reuse a stable provider idempotency reference derived from
`messageId`. The adapter passes it as the provider's idempotency key when
supported; email uses a stable message identity. After an ambiguous timeout, an
adapter without native idempotency must reconcile that identity or provider
conversation before retrying. If it cannot prove the provider did not accept the
message, it projects `held/ambiguous_provider_outcome` for manual review and must
not blindly send again.

Retries follow the platform jobs/events contract: bounded exponential backoff
with jitter and at most five attempts by default. Every attempt carries
correlation and causation IDs. Failure mapping is normative:

| Condition                                                    | Visible state/reason                                               | Automatic retry |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | --------------- |
| timeout reconciled as not accepted, provider `429` or `5xx`  | `retrying/transient_provider_failure`                              | yes             |
| ambiguous outcome that cannot be reconciled                  | `held/ambiguous_provider_outcome`                                  | no              |
| entitlement/resource access suspended or revoked before send | `held/access_unavailable`                                          | no              |
| provider configuration or approved sender disappears         | `held/provider_configuration_unavailable`                          | no              |
| property or thread deleted before send                       | audit/dead-letter `resource_deleted`; no Inbox projection survives | no              |
| invalid payload or attachment at execution                   | `failed/invalid_delivery_payload`                                  | no              |
| non-retryable provider rejection                             | `failed/provider_rejected`                                         | no              |
| retry budget exhausted                                       | `failed/retry_exhausted`                                           | no              |

V2 has no held-message replay command. After resolving a routing, access, or
configuration hold, an authorized actor submits a new manual reply with a new
idempotency key; the held message remains audit evidence. An ambiguous provider
outcome must first be resolved manually and cannot be retried by the Inbox.
Failed work requires a corrected new command or an explicitly eligible, audited
dead-letter replay; neither path silently reuses the original send.

### Inbox sending pause and drain (VAY-1381)

`PMS_INBOX_SENDING_ENABLED=false` pauses native Inbox send acceptance and the
shared OTA/email delivery relay/claim loop. The shared environment parser accepts
`true/false`, `yes/no` and `1/0` (case-insensitive); unset/blank defaults to `true`
to preserve existing deployment behavior. Other values fail startup. This does
not change Channex capability modes or callback ownership.

Authenticated, authorized manual replies and provider-action POSTs return
`503 inbox_sending_paused` before calling the command port. No message, job,
attempt, or idempotency result is created by that rejected request. Same-key
requests also return 503 while paused: previously accepted work is preserved,
not canceled, and normal idempotency replay becomes available after resume.
Existing GET projections remain authoritative for previously accepted work.
The pause does not claim that an earlier request was never delivered.

Reads, mark-read, local triage/follow-up/assignment/notes, empty direct-thread
creation, attachment access, quick replies and human-reviewed assistance remain
available under their normal policies. Inbound intake/receipts, unrelated
Booking emails, other PMS jobs and Marketplace chat are not disabled.

SIGTERM/SIGINT invoke graceful API close. Shutdown stops the Inbox worker in
`preClose`, before pools close.
It waits for the already-started relay/claim/provider/completion operation and
does not claim the next job. Provider acceptance, transient failures and
ambiguous outcomes still use the existing durable completion rules. The pause
neither purges queues nor resends messages. A forced process termination cannot
prove completion; retained running/ambiguous attempts require reconciliation.

This is a **per-process deployment setting**, not an instantaneous distributed
switch. Before handback, the named operator must:

1. Roll out the exact reviewed paused revision to every target API/worker
   replica, retaining deployment/task identities and verifying no old
   sending-capable replica or independent Inbox sender remains.
2. Check durable pending/running jobs, attempts, held/ambiguous outcomes and
   provider acceptance. Resolve uncertain work without blind replay. Zero
   running processes or a successful shutdown is not delivery reconciliation.
3. Record the pending-work disposition and sole-provider-owner evidence before
   switching callbacks or restoring legacy consumers. Resume only after
   explicit approval; enabling the flag can deliver previously pending work.

The setting and local tests alone do not authorize a deployment or satisfy
live rollback rehearsal, migration parity, provider/browser smoke or owner
acceptance. Those launch gates remain in VAY-1381.

## Error envelope

```json
{
  "error": {
    "code": "thread_version_conflict",
    "message": "The conversation changed. Refresh and try again.",
    "requestId": "req_123",
    "details": { "currentVersion": 13 }
  }
}
```

Besides authorization errors, routes use `400 validation_failed` or
`invalid_cursor`, `400 direct_email_not_allowed`, `404 thread_not_found`, `409
thread_version_conflict` or `idempotency_conflict`, `413 attachment_too_large`, `415
unsupported_attachment_type`, and `500 read_model_unavailable`. Provider
failures after acceptance are delivery states, not retroactive HTTP failures.
Assistance service failure uses `503 assistance_unavailable` and does not affect
manual composition or sending.

## Target-schema contract

The existing `pms.message_threads`, `pms.messages`, and
`pms.message_attachments` tables remain canonical. Platform Media, jobs/events,
idempotency, and product-audit tables remain shared infrastructure.

Required deltas for implementation tickets:

1. replace legacy status with `attention_state`
   (`needs_attention|follow_up|done`); add monotonic `version`, follow-up and
   done metadata, nullable same-property assignee membership, and inquiry
   context fields;
2. preserve the existing nullable provider-specific `channel` value as
   `provider_channel`; add required normalized `delivery_channel` (`ota|email`)
   used by the wire contract and routing. Backfill Channex sources to `ota`, and
   classify other migrated threads before exposing them;
3. preserve the property-scoped booking foreign key and source-thread uniqueness;
4. add property-scoped internal notes and quick replies; notes advance thread
   activity but never enter a delivery projection;
5. add nullable outbound delivery projection fields to `pms.messages`: normalized
   state/channel/reason, current attempt, and latest trustworthy receipt time;
6. add canonical `pms.message_delivery_attempts` with message/property FKs,
   resolved route, outcome (`running|accepted|transient_failure|terminal_failure`),
   attempt number, scheduling/provider evidence, and normalized failure metadata;
7. add append-only `pms.message_delivery_receipts` for trustworthy provider
   delivery/read acknowledgements linked to message and accepted attempt;
8. derive or transactionally project staff-visible delivery state from message,
   job, and attempt records, never only from a provider payload;
9. preserve incomplete legacy attachments as `unavailable` until VAY-1381 can
   backfill a valid private media object; quarantine any row that cannot be
   safely mapped and never expose its raw `source_url`;
10. use shared idempotency and audit records for assignment, notes, quick-reply
    preview, assistance, provider actions, and delivery rather than parallel
    Inbox-specific ledgers.

Migration must map `no_reply_needed` to `done` before tightening the state
constraint. Schema work belongs to the follow-up implementation tickets, not
VAY-1369.

## Privacy, retention, and audit

- Thread/message/note/assisted text, guest contact, provider payloads, and
  attachments are property-scoped PII. Queries and search indexes preserve that
  scope.
- Guest contacts are omitted without `pms.guest_contact.read`; logs, analytics,
  errors, job payloads, and audit metadata must not contain raw contact values.
- Ingress, access, and APM logging must redact the `search` query value and must
  not record a raw request URL containing it. Cursors contain a filter hash, not
  guest names or message text.
- Store only normalized provider fields needed for behavior. Raw payloads are
  access-controlled, redacted of credentials and expiring URLs, and governed by
  `pii_retention_until`.
- Private attachments are served only through an authorized media boundary.
- Retention/deletion may remove content while keeping minimal non-content audit
  evidence, provider references, timestamps, and action identity.
- Read, triage, follow-up, assignment, note, assisted-content use, provider
  actions, reply acceptance, route holds, delivery attempts, retries, and manual
  replay are correlated and auditable.

## Legacy and VAY-657 divergences

The target deliberately differs from the legacy `/admin/messaging` behavior and
the assumptions captured in VAY-657:

- there is no `no_reply_needed` state; it migrates to auditable `done`;
- Vayada triage is local and reversible and never silently mirrors a
  provider operation;
- a new inbound message moves a `done` or `follow_up` thread to
  `needs_attention`;
- unread state is changed through a message boundary, preventing a concurrent
  inbound message from being accidentally marked read;
- delivery is durable and visible instead of being implied by an HTTP success;
- OTA replies never silently fall back to email;
- attachments are finalized private media objects, not trusted URLs;
- authorization uses exact Inbox permissions, active entitlement, and the
  property resource rather than legacy session or broad admin checks.

## Deferred feature safety

Property-scoped quick replies are included, but they only prepare editable
composer text. Automations remain outside `native-guest-inbox.v2`; this contract
defines no scheduled or event-driven send route for them. A future automation
must be absent/inactive by default, re-check eligibility and route availability
at send time, hold unresolved variables, use a one-send idempotency key, preserve
audit evidence, and forbid OTA-to-email fallback. The fixture proves that v2
does not authorize automated sends.

## Follow-up ownership

- VAY-906 consumes the queue, assignment, note, quick-reply, assistance, and
  thread/message shapes in the Inbox experience design.
- VAY-1372 implements authenticated, idempotent inbound Channex ingestion,
  including supported Airbnb inquiries.
- VAY-1373 implements target schema deltas, the Inbox-specific Platform Media
  permission policy, quick replies, assisted-content ports, and property-scoped
  API/command/read-model boundaries.
- VAY-1375 implements route resolution, durable delivery, retries, and holds.
- VAY-1376 implements the responsive PMS Inbox, quick-reply management, and
  assisted composer against these routes.
- VAY-1381 migrates legacy data, validates parity, and performs reversible
  cutover.

No follow-up may broaden the approved MVP without a new product decision.
