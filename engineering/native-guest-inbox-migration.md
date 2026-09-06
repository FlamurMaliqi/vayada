# Native Guest Inbox migration and launch gates

Status: VAY-1381 is in progress. This is not authorization to apply a production
migration, switch callbacks, disable the existing intake, or send guest messages.
The [Inbox contract](native-guest-inbox-contract.md) remains normative.

## Historical message evidence

The existing PMS migration imports typed thread/message/attachment history.
Historical Channex `message` webhook receipts are non-replayable evidence:

- Keep source identity, payload hash, timestamp, migration provenance and verified
  property ownership; do not copy raw message JSON, headers or free-form errors.
- Set the deterministic receipt retention deadline to receipt time plus 30 days,
  as required by migration 0150. The imported payload is already empty. The
  existing expiry function may later record its purge without breaking reruns.
- Missing, ambiguous or unmappable receipt ownership produces a failed,
  non-content migration-scoped receipt with a normalized reason. This does not
  authorize importing a conversation across properties or weaken other ownership
  blockers in the complete PMS plan.
- Typed message body, sender, provider IDs and timestamps remain separate from
  raw provider JSON. The immutable extraction snapshot/checksums remain the source
  for subsequent reconciliation; this change does not delete that evidence.
- Existing target message/receipt rows with nonempty raw payloads block migration
  for a reviewed privacy cleanup. The generic writer must not silently accept
  them or modify append-only receipt history.
- Importing historical receipts creates no jobs, domain events or outbound sends.

## Source Inbox consistency gate

The mapper checks provider natural keys using the target schema's property/source/
thread identity and thread/message identity. It also checks each thread's cached
unread count against inbound messages with no read timestamp, and its summary
against the latest message by `sent_at DESC, id DESC` (the target intake order).
Target previews use the first 280 Unicode code points, preserving whitespace.
The legacy repository uses `(body or "")[:200]`. Accept that exact 200-code-point
prefix of the retained latest message as a known format conversion, or an already
matching target preview. Only after all source consistency checks pass, derive
the target's 280-code-point preview from the retained body; keep the original
source rows and checksums unchanged. Do not accept arbitrary shorter prefixes,
trimming, ellipses, or UTF-16 truncation. Legacy out-of-order inserts can leave
stale preview/direction metadata even when `last_message_at` is correct: those
mismatches still block and require reconciliation, not automatic repair.
Empty threads require null summary fields and zero unread. Mismatches block apply;
reports contain canonical property/record IDs and field names, never message
content or provider keys. Reconcile inconsistent source evidence explicitly.
These are source checks, not proof of actual-target parity or inquiry semantics.

## Existing target Inbox consistency gate

For candidate thread IDs, the target reader checks the actual stored unread total
and latest message by `sent_at DESC, id DESC`, including target-only messages not
present in the extraction. Scope every lookup to the stored property and thread,
in batches of at most 500 thread IDs; unrelated threads are not a cohort audit.
Require matching timestamp, direction and preview, and null summaries/zero unread
for empty threads. Accept the existing 280-code-point intake/import preview or,
for an accepted manual property-user reply, its 500-code-point command preview
(including null preview for an empty-body attachment reply). Do not truncate or
repair target history. This recognizes existing writers, not a new UI policy.

The reader returns only property/thread IDs and mismatched field names. The
existing transaction blocks an inconsistent target before writes, and repeats the
check after writes before commit; a new post-write inconsistency rolls everything
back and returns the verification report with `applied: false` and its blockers
(CLI exit code 2). Keep those transient mismatch details: after rollback, another
dry-run may no longer reproduce them. A clean pre-write dry-run alone does not
prove a prospective merge is safe.
Preserving a newer target row is not permission to skip this integrity check.
This is target cache consistency, not source/target row-count parity, provider
identity reconciliation, or evidence of a successful live rehearsal.

## Historical attachment disposition

Keep an attachment's identity, verified property/message ownership and available
metadata when both legacy storage references are absent or blank. Store null media
ID, storage key and source URL; the existing Inbox read model reports it as
`unavailable` with no access path. The immutable source checksum preserves evidence.

A nonempty invalid `source_url` may use the same unavailable representation only
when the current source run's media quarantine matches its table, attachment/field
identity, purpose, raw-value hash and `INVALID_HTTPS_URL` reason. Never copy the raw
quarantined URL/value. Any existing media binding for an unavailable attachment,
including prior runs and inactive objects, blocks for reconciliation rather than
hiding an ownership/storage conflict. Cross-run source IDs are conflict evidence
only; usable media and quarantine evidence still require the current source run.

A nonempty S3 key takes precedence over an unused source URL, matching the media
importer. Valid references still require an active property-scoped private Platform
Media object; missing imports, failed downloads, mismatched quarantines and unsafe
media are blockers, not automatic unavailable fallbacks. This does not backfill
files or approve a live quarantine inventory. Later repair of immutable imported
attachment rows requires an explicit reviewed backfill, not a silent rerun update.

## Remaining release gates

### Approved historical inquiry read rule (2026-09-05)

Verified historical Airbnb system inquiries are inbound messages from `system`.
Keep a recorded `read_at`; when it is absent, count the inquiry as unread for
staff review. Never invent a read timestamp or reopen a closed/no-reply-needed
conversation. Recompute only unread totals and latest-message direction after
the existing source consistency checks pass; preserve timestamps and source
checksums. Historical import still creates no jobs, receipts or guest sends.

The first slice handles the legacy flat message-attributes shape with sender
`system`, message `inquiry`, a `meta.live_feed_event_id` and same-property
`meta.booking_details`. Verify retained provider identities and the canonical
Channex property binding; incomplete/conflicting evidence blocks for review.
For that verified profile, an unlinked thread becomes `inquiry`, retaining the
provider inquiry ID in `source_booking_id` (the target inquiry reference field).
Preserve supplied stay dates and adult/child counts using the target intake's
field aliases. Missing details remain null; dates must be a real, ordered pair
and counts must be numeric integers from 0 through 100. Conflicting aliases,
inquiry IDs, existing unlinked source references or repeated inquiry details
block for reconciliation rather than choosing a value by extraction order.
Existing linked bookings retain their booking reference and no inquiry context.
Only normalized fields are stored, never the source payload. These fields use
the existing target schema and normal provenance/reconciliation guards; a
previous import can require review rather than being silently overwritten.
Flat legacy payloads with explicit `provider_inquiry_id`, `inquiry_id`,
`meta.live_feed_event_id`, nonempty nested `inquiry`, or inquiry-type markers use
the same normalization after verification. Empty metadata is not inquiry evidence.
Require one consistent supplied inquiry identity and a supplied property UUID
matching the thread's canonical Channex binding; missing identity is not replaced
by a thread ID. All supplied message/thread/property/channel identities must agree.
Supported string senders retain guest, channel or property-user classification;
verified system inquiries use the approved inbound/read rule above. Non-system
direction must already agree with its sender. Raw booking references, unsupported
senders and conflicting metadata block instead of being guessed or discarded.
This covers retained flat webhook/polling evidence, not arbitrary envelopes or
metadata recoverable only by a provider fetch. Those forms and actual-source
coverage remain rehearsal gates. This is not approval to overwrite existing
target history or to apply a production migration.

Before a production apply or guest Inbox acceptance, record evidence for:

1. Actual source/target row counts, provider natural-key uniqueness, property and
   booking ownership, ordering, unread totals and last-message summary parity.
   Resolve differences explicitly; copying cached legacy thread totals is not
   proof of parity. Review overlap with any threads already created by target
   intake before choosing an identity reconciliation.
2. Inquiry normalization: preserve provider inquiry identity and supplied stay
   details, and correct historical system-inquiry direction before launch.
3. Private attachment reconciliation, including approved unavailable/quarantine
   dispositions. No provider URL may become a public attachment fallback.
4. The VAY-1370 production **and** staging read-only prototype audit. Repository
   rollback or an accepted research ticket does not prove live residue is absent.
   Do not delete prototype definitions/history or cancel the old issue cluster
   until its live disposition is reviewed. Templates/automations remain deferred.
5. A production-like rehearsal on a verified extraction snapshot: deterministic
   reruns, actionable PII-free discrepancy reports, rollback evidence and named
   cutover ownership. Deploying migration-compatible code is not this rehearsal.
6. A reviewed callback/worker cutover and explicit test property/conversation.
   Verify receive, duplicate delivery, read, manual reply, attachment, close,
   reopen, retry/failure and audit behavior in the browser. Keep the old intake
   unchanged until that cutover is approved; prevent dual processing/sending.

Run the focused mapper/reconciliation tests with one worker. PostgreSQL writer
coverage runs in PR CI on PostgreSQL 16 and 17 against freshly applied migrations.
If local Docker is stopped, leave it stopped and report local integration as
unverified; do not substitute production writes for an isolated test database.
