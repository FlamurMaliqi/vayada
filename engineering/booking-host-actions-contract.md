# Host booking actions

VAY-1279 extends the target Booking owner with host actions exposed in PMS.
It builds on the [PMS reservation contract](pms-reservation-integration-contract.md),
[acceptance mode contract](booking-acceptance-mode-contract.md), and existing
guest date-change pricing and inventory services.

## Preview and apply

Every host action requires a persisted, actor/property/booking-bound preview.
The preview expires after ten minutes and records the Booking revision, proposed
action, current and proposed stay, price, frozen policy, inventory impact, and
payment disposition. A preview does not reserve inventory or mutate the booking.

Apply accepts only the preview ID and an idempotency key. It locks the booking,
checks the current revision, and recalculates the impact. Changes to price,
policy, eligibility, or availability reject the command with a conflict requiring
a new preview. Client-supplied prices or policy snapshots are never authoritative.
The same key and preview replay the stored result; reusing a key for a different
actor, property, booking, or preview fails. Replaying a successful command works
even after the preview expires or the booking changes again.

The host's internal reason is private audit data. A separate optional guest
message is plain text in the existing lifecycle email and is never interpreted
as markup. Persisted previews and command receipts are not public booking data.

## Eligibility and ownership

Booking owns guest-visible dates and lifecycle. PMS owns assignment cancellation,
inventory release/reservation, and operational projections. Finance owns payment
authorization voids, refunds, and monetary evidence. Distribution owns external
channel mutations. No action may report success merely because a local projection
was changed while its owning provider still considers the booking active.

The existing direct date-change calculator supports confirmed, unpaid
pay-at-property stays, preserving the room offer, occupancy, and currency. It
recalculates the stay total and exposes the resulting policy before apply.
Purchased add-ons and paid stays require additional adjustment support.

Reject applies to pending host requests, producing `declined`. An authorized
card must be voided through Finance before Booking declines the request; an
uncertain provider result must remain retryable and must not release inventory.
Cancel applies to eligible confirmed bookings, producing `canceled`. Neither
action may bypass an operational check-in or a concurrent payment settlement.

Manual PMS actions keep their existing owner contracts. Channel bookings require
an explicit Distribution cancellation capability; the existing inbound revision
ingestion is not an outbound cancellation API. Paid cancellation requires an
explicit Finance refund capability. When either capability is unavailable, the
preview returns a typed unavailability reason and apply cannot mutate the booking.
This contract does not authorize a local-only cancellation or imply a refund.

## Consistency and recovery

For dates already handed to PMS, PMS verifies all assignments against the current
receipt and grants availability credit only for that exact stay and room count.
Apply releases those assignments, reserves the replacement stay, changes Booking,
and rebinds the assignments to the new receipt atomically. Physical room selections
are cleared and disclosed in the preview. The new receipt is adopted by the existing
handoff trigger. Old receipts remain immutable historical evidence: the active
receipt view excludes handed-off receipts no longer referenced by their booking.
Inventory, calendar impact, and capacity reads use that active view so an old stay
cannot continue protecting capacity after an amendment.

The Booking mutation, monetary evidence, transaction-aware inventory port calls,
audit, command receipt, and durable notification/PMS handoff jobs commit together.
A failure rolls the entire database transaction back. Workers retry downstream
delivery using existing scoped job keys. Failed email delivery does not undo an
accepted cancellation. External payment operations need stable provider keys and
provider reconciliation on retry; database rollback cannot undo a provider call.

Routes require `pms.reservation.update`, active entitlement, and property linkage.
Reject/cancel previews and applies additionally require `pms.reservation.cancel`;
apply checks the persisted action before executing the command. The actor and property come from authenticated
context and route scope. A guessed preview ID cannot cross either boundary.

## Review stack and validation

Keep the contract, persisted preview/command foundation, owner adapters, protected
routes, and PMS controls in focused stacked PRs. Each implementation slice must
identify which eligibility cases it enables; unsupported cases remain visible as
typed conflicts rather than silently being omitted.

Tests must cover stale revisions, changed pricing/policy, sold-out inventory,
invalid lifecycle, checked-in stays, actor/property isolation, duplicate commands,
concurrent commands, transactional rollback, provider uncertainty, durable job
replay, private reasons, and the complete route authorization denial matrix.
PMS browser checks must exercise preview, apply, conflict recovery, and an accepted
write followed by a failed refresh without falsely reporting that the write failed.
