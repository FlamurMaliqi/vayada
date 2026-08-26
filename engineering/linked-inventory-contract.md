# Linked Inventory Contract

_VAY-1338 contract record. Builds on the target-schema ownership map, PMS
inventory materialization, public bookability projection, and jobs/events
contracts._

## Decision

PMS owns linked inventory. A linked inventory group contains two or more room
types for one property that are alternative ways to sell the same physical
space. A room type belongs to at most one group.

The PMS configuration surface uses group-level management: a hotel user names a
group and replaces its complete member set atomically. Pairwise room links are
not a second source of truth.

For every stay night, any active inventory reservation receipt, operational
booking assignment, or manual room block in one member makes the whole group
unavailable. The originating booking or manual block remains the visible source
record. PMS materializes protected derived blocks for the other members and a
non-additive group stop-sell gate for every member so calendar, public
bookability, manual-booking validation, and channel ARI all consume the same
inventory state without a handoff gap.

## Target Ownership

`domain-pms` owns:

- `pms.linked_inventory_groups`;
- the nullable linked-group membership on `pms.room_types`;
- linked-block reconciliation and inventory-day updates;
- the linked group configuration routes and read model;
- PMS calendar explanation metadata; and
- inventory-change events that drive Distribution and Channex ARI jobs.

Booking and Distribution do not write group membership or inspect Channex
mappings. They consume PMS inventory/public-offer contracts.

## Storage Contract

`pms.linked_inventory_groups` stores:

- `id`, `property_id`, and `name`;
- `revision` for optimistic concurrency; and
- creation/update audit timestamps.

`pms.room_types.linked_inventory_group_id` is nullable and uses a composite
foreign key with `property_id`. The single column enforces at most one group per
room type. A configuration command must reject:

- fewer than two distinct members;
- members outside the selected property;
- a member already assigned to another group; and
- an empty or duplicate group name within the property.

`pms.room_blocks` distinguishes:

- `manual`: a hotel-user block;
- `linked_booking`: a protected block derived from an operational assignment;
- `linked_manual_block`: a protected block derived from a manual block.

Derived rows carry exactly one causal reference: an inventory reservation
receipt or operational assignment for `linked_booking`, or a manual room block
for `linked_manual_block`. They also carry the source room type. Partial unique
indexes make one derived block per cause and target room type. Kind-dependent
checks require exactly the matching cause column, and property-scoped composite
foreign keys bind the cause, source room type, and target room type to the same
property. The source and target room types must differ.

`pms.inventory_days` stores a linked stop-sell flag and linked-source revision.
The flag is a non-additive gate, not another capacity count. When true,
`available_count` is zero. Explanatory linked-block rows remain per cause, but
their contribution to `blocked_count` saturates at remaining physical capacity:
`assigned_count + blocked_count` never exceeds `total_count` even when several
causes overlap.

Derived block dates use the existing inclusive room-block range. Booking
assignments remain checkout-exclusive, so a stay `[check_in, check_out)` becomes
`starts_on = check_in` and `ends_on = check_out - 1 day`.

## Configuration Commands

The target API exposes property-scoped list, create, replace, and delete
operations under:

```text
/api/pms/properties/:propertyId/linked-inventory-groups
```

All write routes enforce `pms.operations.manage`, require an idempotency key,
and use the current group revision for replacement/deletion. A write locks the
property inventory scope, group, and affected room types before validating and
committing the membership change.

Changing membership reconciles all active reservation receipts, assignments,
and manual blocks for the affected room types before commit. The response is
truthful only after derived blocks, inventory days, audit, and outbox intents
commit atomically.

Create/replace rejects `linked_inventory_overlap_conflict` when active real
causes from two proposed members overlap on any night. Saturated linked state
must not legitimize a pre-existing double-booking. The response identifies the
member room types and conflicting range so the hotel can resolve it before
retrying; there is no implicit override.

Deleting a group removes its membership and derived linked blocks. It never
deletes the originating bookings or manual blocks.

The list/read response includes group ID, name, revision, and member room-type
IDs. PMS Rooms & Rates renders group management on that page and a `Linked`
badge for every member; the badge resolves its label from the group read model.

## Linked-Block Reconciliation

Reconciliation derives current state; lifecycle handlers do not append
best-effort blocks.

Every inventory-affecting command acquires the shared property/group advisory
lock and then locks members and inventory days in room-type/date order before
availability validation. It revalidates after locking. Concurrent commands on
different group members therefore serialize; the later command returns a typed
availability conflict instead of committing a second cause.

For every active reservation receipt or assignment in a group:

- create or update one `linked_booking` block for every other member;
- set its range from the receipt or assignment's effective stay dates;
- set the group stop-sell gate for every member, including the source;
- transfer causality from a handed-off receipt to its assignment atomically so
  there is no double count or sellable gap; and
- remove derived rows whose receipt/assignment was cancelled, released, moved
  out of the group, or changed dates.

For every active manual block in a group:

- create or update one `linked_manual_block` for every other member;
- preserve the source block's inclusive dates; and
- remove the derived rows when the source block is released or moved.

Derived blocks never act as sources for more derived blocks. They cannot be
edited or released through manual-block routes. Multiple overlapping causes are
retained for explanation, while the group stop-sell and capacity contribution
remain non-additive.

The reconciler locks affected inventory days, recomputes the group stop-sell,
saturates `blocked_count` to remaining physical capacity, and recomputes
`available_count` with the existing physical-capacity and sellable-limit
invariants. Every mutation dirties the union of the old and new date windows. It
is invoked by:

- inventory reservation receipt reserve, release, and assignment handoff;
- booking assignment create, stay-date change, room-type move, cancellation,
  and release;
- manual block create, update, and release; and
- linked-group membership create, replace, and delete; and
- physical-room create/retire, room-type activate/deactivate/delete, and
  capacity rematerialization.

A room-type lifecycle command must either preserve a group with at least two
active members or atomically dissolve it and reconcile the former members. It
must not leave a one-member active group.

## Reservation Handoff Correlation

The PMS reservation sink create command carries the opaque
`PmsInventoryReservationReceipt` returned by the Booking inventory reservation
port. Target direct bookings must provide it; Booking persists and forwards the
token without parsing storage identity.

Under the same property/group inventory lock, the Vayada PMS adapter verifies
that receipt property, room type, dates, and room count exactly match the create
command. It atomically creates the command's `numberOfRooms` assignment
positions and adopts the receipt. One receipt may therefore cause multiple
assignments for the same booking, but it is adopted once and the assignment
count must equal the receipt room count. A mismatch returns a typed conflict and
writes neither assignments nor linked state.

Receipt reserve establishes linked stop-sell before checkout commits. Receipt
release removes it when checkout fails. Exact receipt adoption replaces that
temporary cause with assignments in one transaction, eliminating both a
sellable handoff gap and double capacity consumption. No Booking-table heuristic
or provider-specific reference may substitute for the receipt token.

## Availability Consumers

Availability checks must use the reconciled PMS inventory state:

- Booking Engine searches receive linked sold-out state through Distribution's
  public room-offer projection;
- manual booking and assignment commands reject inventory consumed by linked
  blocks;
- PMS calendar reads include the derived block kind and source summary; and
- Channex ARI reads the reconciled `pms.inventory_days.available_count`.

The source room type continues to show the real booking or manual block. Other
members show a protected linked block. Calendar clients render linked blocks
distinctly and identify the source booking/room type or manual block without
making the block editable.

## Events and Channex

Every reconciliation transaction emits one `pms.inventory.changed` event and
outbox intents for every affected room type over the union of old and new date
ranges:

- `distribution.public-bookability` refreshes public offers;
- `pms.calendar-projection` refreshes the PMS calendar; and
- `pms.channel-manager` enqueues durable `channex.push-ari` work.

Channex remains PMS-owned. The Booking domain never calls it directly. Existing
idempotency, retry, provider-attempt, and dead-letter behavior applies. Before a
push, the handler reads the latest inventory revision and values; work carrying
an older revision is superseded or converges by pushing that latest state. A
local booking or block change commits only when the required outbox intents
commit; provider delivery remains asynchronous and visible through channel sync
state.

## Validation

Implementation slices must cover:

- group membership property scope, minimum size, uniqueness, revision conflict,
  and one-group-per-room-type constraints;
- reservation receipt reserve/release/handoff, assignment
  create/cancel/date-change/move/release, and manual block create/update/release
  reconciliation;
- exact multi-room receipt adoption and mismatch rollback;
- protected derived blocks and causal calendar metadata;
- sold-out public offers and manual-booking rejection;
- ARI outbox intents for all affected group members;
- group membership changes with existing bookings or manual blocks;
- capacity/member lifecycle changes and concurrent writes to different group
  members;
- rejection of group membership with existing cross-member overlaps;
- old-range reopening after date changes; and
- out-of-order ARI retries converging on the latest inventory revision.

## References

- `engineering/target-schema-ownership-map.md`
- `engineering/booking-pms-domain-boundaries.md`
- `engineering/jobs-events-contract.md`
- `engineering/pms-reservation-integration-contract.md`
- `engineering/public-bookability-contract.md`
