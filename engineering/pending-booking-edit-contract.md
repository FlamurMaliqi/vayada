# Pending booking edits

VAY-959 targets the TypeScript Booking Engine only. This extends
`booking-acceptance-mode-contract.md`, `booking-web-public-api-routing.md`, and
`pms-reservation-integration-contract.md`.

## Guest contract

`Edit Request` appears beside `Withdraw Request` for an unexpired request that
has not been accepted or declined. It reopens the existing room, add-on, guest,
and payment steps with the saved selection. Saving preserves the canonical
guest booking ID, public reference, original creation time, attribution, and
Pending status. Guests can change dates, occupancy, room selection/count,
add-ons, payment method, and special requests. Canceling the editor leaves the
stored request unchanged.

The editor uses the existing property-scoped booking confirmation credential.
Every read, quote, and write verifies that credential server-side. Neither a
booking ID nor an email supplied in editable guest details authorizes an edit.
Guest identity and marketing attribution are not editable through this command.

## Atomic revision

The saved revision is an optimistic concurrency token. Saving an older revision
returns 409, including when another tab edits the request. The transaction locks
the canonical booking row, then rechecks status, acceptance events, payment
state, and the host response deadline using current server time. This is the
same row locked by PMS acceptance/decline. An accepted bank-transfer reservation
awaiting payment is not an editable pending request.

Reuse the checkout quote calculator and validate current settings, occupancy,
room/rate restrictions, add-on rules, and the expected total. Credit only the
request's verified inventory receipt when quoting overlapping dates. Replace
the inventory reservation through the PMS inventory port in the save
transaction. Failed availability checks roll back the entire replacement.
Preserve the original host response deadline; editing must not extend the
hotel's review window or turn a request into an instant booking.

Save the quote association, stay, guest counts, room count, totals, selected
offer, guest requests, payment configuration, and public summary together.
Reconcile promo redemption under its existing lock, without counting the same
booking twice. Preserve original billing/commission contract snapshots.

## Add-on evidence

Purchased add-on rows are immutable under migration 0091. Editing must not
delete or rewrite their economic snapshots. Supersede the old selection as a
whole and insert a new revision; guest, PMS, email, and Finance current-state
reads use a separate active-selection projection. Keep the existing immutable
Finance evidence view addressable by selection ID so persisted folio references
remain resolvable. Reject edits with posted economic evidence; corrections to
posted folios are outside this command. Historical revisions remain available
for audit. A failure in any part of the edit must leave the previous revision
active. Confirmed or paid booking evidence remains immutable.

## Payment changes

Never reuse an authorization for a different amount or currency. Card changes
requiring a new authorization use a distinct, idempotent payment attempt. The
previous authorization remains recoverable until the replacement save has
committed; its release is durable, retryable work. A failed or abandoned new
authorization must not destroy the original request or its authorization.

Replacement attempts live outside the active booking payment projection until
save. Add an explicit active-payment binding, atomically switched on save;
acceptance, expiry, webhook handling, confirmation, and financial totals must
use it. Creating a replacement must not change any newest-payment selector or
add a second authorization to current totals. Abandoned attempts have an
independently scheduled cleanup deadline, including when save is never called.

The final save verifies the replacement authorization's property, amount,
currency, booking binding, and manual-capture status while holding the booking
lock. If hotel acceptance wins the race, reject the edit and release only the
unused replacement authorization. Superseded provider events cannot authorize,
confirm, fail, or expire the current booking revision. Captured/paid bookings
are rejected; this feature does not refund or charge guests implicitly.

Changing away from card releases the old authorization through the same durable
mechanism. Bank-transfer bindings and PayPal instructions follow the new chosen
method, with no stale payment instructions exposed to the guest. Existing
acceptance events always take precedence over a Pending display label.

## Pending states and payment transitions

The authoritative predicate is `pending_payment`, no acceptance event or
accepted-payment deadline, no settled payment or posted economic evidence, and
an unexpired original response deadline. The original response deadline is
`hostResponseDeadlineAt`, falling back to `pendingExpiresAt`; reject missing or
invalid deadlines rather than creating an unlimited editing period. A Pending
UI label alone never establishes eligibility.

Every edit preserves this original deadline, including transitions between
card, cash/pay-at-property, bank transfer, and PayPal. The edited booking remains
a request regardless of current property instant-book settings. All replacement
card authorizations use manual capture. Bank transfer and PayPal replacement
instructions do not authorize automatic acceptance or extend the preserved
review period. An accepted bank transfer awaiting payment is ineligible.

## PMS projection

Enqueue a revision-keyed PMS update in the save transaction. Process an initial
create before its updates, using the canonical latest revision if creation is
still pending. PMS applies each revision once and ignores older revisions;
a delayed update cannot overwrite a newer accepted edit. Update operational
stay, guest counts, room selection, add-ons, and requests as well as the inventory
receipt. Validate provider capabilities before save and reject an unsupported
replacement without altering the current request. The TypeScript Vayada PMS
adapter must support the full edit before enabling its UI.

## Notifications and retries

Record `guest_booking.request_updated` with before/after revision references
and a guest-visible activity entry. Enqueue a hotel notification in the same
transaction, keyed by booking ID and saved revision. Replaying a save returns
the original result without consuming inventory, promo usage, or notifications
again. Reuse the VAY-930 booking email snapshot and queue; do not invoke its
guest confirmation resend command or send a confirmed-booking email.

## Required verification

- End-to-end prefill and save for every editable field, including room count,
  add-on dates/quantities, and supported payment methods.
- Wrong/missing/expired credentials and cross-property identifiers fail closed.
- Accepted, declined, canceled, expired, and accepted-awaiting-payment requests
  reject edits, including concurrent save versus hotel decisions.
- Sold-out overlapping inventory credits only this booking's receipt; failed
  replacements preserve the original inventory and all saved fields.
- Price/settings changes and stale revisions return recoverable conflicts.
- Card reauthorization success, failure, abandonment, provider timeout, save
  rollback, replacement release retries, and delayed old webhooks.
- Add-on financial evidence and promo usage remain correct across edits.
- One hotel email per saved revision; no duplicate email on idempotent replay.

## Stack order

1. Revision and payment-attempt storage contracts with migration checks.
2. Quote/save commands, active-selection reads, and provider reconciliation.
3. Public credential-bound adapters and denial/race integration tests.
4. Prefilled booking flow, browser checks, and full-stack validation.

Each implementation slice requires an independent adversarial review before
its PR is finalized. The contract alone does not implement VAY-959.
