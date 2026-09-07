# Mixed room booking combinations

[VAY-910](https://linear.app/vayadacom/issue/VAY-910) extends the target TypeScript
Booking Engine. VAY-1043 is Done. This contract builds on
`booking-pms-domain-boundaries.md`, `pms-reservation-integration-contract.md`,
`linked-inventory-contract.md`, and `pending-booking-edit-contract.md`.

## Existing constraint

Public search and checkout currently compare the whole party with one room's
occupancy. Increasing room count multiplies price and inventory consumption but
does not allocate guests across rooms. Checkout snapshots contain one room type;
the inventory port reserves one room type and returns one receipt. Pending edits,
PMS handoff, guest changes, and lifecycle releases consume that shape. A search
card alone cannot make a mixed selection bookable.

## Selection and search

Product decision accepted: keep each room line's own cancellation terms (Flamur,
2026-09-06). Quote, cancellation, and refund aggregation must preserve these
terms; existing checkout's single-policy shape remains supported for old bookings.

A selection consists of room lines under one property, stay, currency, guest
party, booking reference, payment, and acceptance decision. Each line identifies
an exact public offer/rate plan, room type, quantity, and explicit per-room adult
and child allocation. Allocations sum exactly to the requested party. Every room
has at least one adult; respect each room's adult, child, and total occupancy
limits. Quantities sum to the booking's room count.

Search retains valid single-type options, including multiple rooms of one type.
When none can accommodate the party, search builds mixed-type options from
currently eligible full-stay offers. Every night must satisfy freshness,
publication, inventory, arrival/departure restrictions, and rate restrictions.
An unavailable or missing occupancy bound is not evidence of capacity.

Use one exact rate plan per room type within a selection; different rate plans
for that type are alternative selections. All rooms of a type are reserved as
one line, even when their guest allocations differ. Rate plans sharing a room
type consume the same inventory. Distinct room types
in one PMS linked-inventory group are alternatives and cannot appear together.
Distribution consumes a PMS-owned conflict read model; it must not infer
independence from different room type IDs or sum linked capacity.

Enumerate feasible allocations with memoized states that include candidate
position, allocated guests, remaining shared stock, linked-group choices, and
the common payment-method intersection. Discard a partial option only when its
feasible extensions are equivalent; equal guest counts alone are insufficient.
Retain a deterministic cheapest representative within that equivalence. Rank results
by full-stay total, then room count, then stable offer identifiers. Limit displayed
options after feasibility evaluation; do not truncate candidate room types before
checking whether a combination exists. Return a bounded set of alternatives,
without promising enumeration of every permutation or global price optimality
when booking-level promotions change the ordering.

The response includes line names, quantities, guest allocation, rate terms,
payment options, full-stay line prices, combined totals, and expiry. Monetary
aggregation uses exact minor units. Rates must have a common supported payment
method and currency. Price promotions per their canonical eligibility and apply
booking-wide fixed discounts once; do not independently redeem one promo per
line or assume a room-specific promo applies to all rooms. Add-ons are selected
and priced once at booking scope.

Preserve VAY-912's distinction between unavailable capacity, unsupported guest
input, stale/unavailable source data, and other stay restrictions. A valid mixed
option suppresses the capacity error. Never label a search exhausted by an
internal limit as insufficient property capacity.

## Quote and atomic reservation

The server accepts room lines as identifiers, quantities, and allocations only;
client prices, occupancy, inventory, and policy snapshots are untrusted. Resolve
and price every line from current canonical evidence. Persist a versioned
selection snapshot with line economic/policy evidence and summed totals. Include
all lines in quote binding, idempotency fingerprints, and payment amount checks.
Existing one-type snapshots remain readable as one line.

At create/save, hold the existing booking/property inventory lock order and
revalidate every line's current occupancy, restrictions, rate, payment readiness,
and inventory. Require a refreshed quote if economic or policy evidence changed.
Reserve all lines in one database transaction through the PMS port. Linked-group
reconciliation must run between reservations so a competing linked member cannot
also succeed. Any line failure rolls back all inventory, booking, promo, payment
binding, and outbox mutations. Do not create separate guest bookings per line.

PMS returns a versioned bundle of opaque receipts, one per reserved room line.
Booking forwards the bundle without reconstructing PMS-owned receipt contents.
Reserve/release/replay and receipt adoption are atomic for the complete selection.
Canceled, declined, expired, and abandoned bookings release every applicable
receipt exactly once. A malformed or incomplete bundle fails closed.

PMS handoff carries each line and its matching receipt. Assignment quantities and
dates must match each receipt under the existing deferred adoption checks. Guest,
owner, email, and financial views show all room lines; none may display only the
first line while using the combined total. Cancellation evaluates the preserved
terms per line and aggregates the resulting amounts; shared add-on rules remain
booking-scoped. Confirmed change requests retain all unchanged lines and quote
the complete replacement selection.

## Pending edits and checkout UI

VAY-959's eligibility, credentials, original deadline, revision locks, payment
replacement, and immutable financial evidence rules remain mandatory. Prefill all
room lines. Credit only verified reserved receipts belonging to this booking,
against their matching room types and overlapping dates. Replace the complete
selection atomically; failed saves leave the original selection and receipts
intact. Switching between single and mixed selections preserves the reference.

Show "Accommodation for N guests", each room quantity/name, allocation and rate
terms, and the combined full-stay price. Carry the selection through add-ons,
guest details, payment, confirmation, draft restoration, and the pending editor.
Changing dates or guests requires revalidation; an expired selection cannot be
silently replaced with its first room. Preserve existing styling, accessibility,
localization, and analytics step behavior.

## Dependency-ordered delivery

Each implementation PR targets roughly 400 changed non-generated lines and is
independently reviewed. These are stack boundaries, not optional scope cuts:

1. Versioned room-selection and receipt-bundle contracts with strict parsers.
2. PMS atomic bundle reservation/release/adoption and concurrency integration.
3. Canonical multi-line quote/pricing, bindings, and booking persistence.
4. Lifecycle, guest/PMS/email/financial projections, and confirmed changes.
5. Pending-edit credits, replacement, and payment/replay regression coverage.
6. Public combination search with linked-capacity and restriction evidence.
7. Selection cards and complete checkout/editor propagation with browser checks.

Do not expose mixed options before all consumers safely support them. No legacy
Python changes, infrastructure changes, implicit merge, real reservations,
payments, or externally sent messages are authorized by this contract.

## Release evidence

- Six guests across 2 Double + 1 Twin; one of each of three room types; sufficient
  same-type capacity; insufficient total capacity; adults/children constraints.
- Multiple rate plans sharing stock and linked room types never double count.
- A cheaper partial option with incompatible inventory/payment extensions cannot
  hide a more expensive partial option that can accommodate the complete party.
- Sold-out middle night, stale evidence, arrival/departure/min/max-stay failures,
  changed occupancy or price, incompatible payments, and exact combined amounts.
- Two simultaneous buyers of the last combination: one winner and no partial
  reservations; failed create/edit and idempotent replay preserve inventory.
- Cancellation/decline/expiry release all lines; receipt handoff never consumes
  inventory twice; pending edits survive acceptance/payment races correctly.
- Browser selection through confirmation and pending-edit prefill/save, with all
  names, quantities, policies, and totals present. Mocked tests are labeled.
- Deployed smoke only after verifying the running merged API/frontend revision.
  Coordinate shared fixtures with VAY-959; use bounded synthetic data and preserve
  reusable accounts, existing bookings, and Inbox fixtures. Record precise blockers
  and keep VAY-910 In Progress until explicit acceptance.
