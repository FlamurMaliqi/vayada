# PMS room-assignment optimization contract

_VAY-667 target TypeScript contract._

## Scope

This contract applies only to the target TypeScript PMS. Legacy Python behavior
is not changed. PMS Operations owns the setting, assignment optimizer, room
moves, and shuffle history.

The optimizer runs independently for one property and one room type. It may
move future confirmed reservations between verified physical rooms of that same
type. It never changes the room type, stay dates, rate plan, price, guest facts,
or booking lifecycle.

## Inputs and constraints

Stays use half-open date ranges `[checkIn, checkOut)`. A checkout and check-in
on the same date do not overlap and are the preferred zero-gap placement.

The optimization snapshot contains:

- active, operationally verified physical rooms in calendar order;
- assigned and unassigned exact-stay assignments for the room type;
- active room-specific blocks;
- a command reason: `create`, `cancel`, or `modify`;
- the property-local current date supplied by the caller.

An occupancy is immovable when it is a room block, already checked in,
in-house, checked out, starts before the property-local current date, or is
explicitly pinned by a future assignment contract. Pinned future reservations
are supported as an input constraint but the pinning UI and write command are
outside VAY-667.

Only future confirmed reservations are movable. Direct, manual, and OTA/channel
reservations use the same rule. A reservation assignment stays in one physical
room for its entire stay.

## Packing rule

The planner is deterministic and greedy:

1. Sort movable stays by the number of rooms allowed by immovable occupancy,
   then check-in, longest stay first, and stable assignment ID. This preserves
   scarce room options before packing flexible stays.
2. Reject rooms that overlap any already placed occupancy.
3. Prefer a room already in use, minimizing the number of opened rooms.
4. Within used rooms, minimize the incremental total internal gap-nights and
   prefer the tighter upcoming immovable boundary so later stays retain the
   least-constrained room.
5. Prefer the smaller adjacent boundary gap, then more placed occupancy.
6. Break remaining ties by calendar sort order and stable room ID.

This deliberately keeps the implementation bounded; VAY-667 does not introduce
an external optimization solver. If the greedy pass cannot place every stay, a
bounded deterministic reassignment fallback tries the stay with the fewest
current room choices first. An `O(n log n)` peak-concurrency check rejects clear
overcapacity before that fallback. Budget exhaustion is a distinct retryable
result and is never reported as true infeasibility. Equivalent fallback states
are memoized, and a durable retry can request an explicitly higher bounded
budget. The result includes before/after internal gap-night metrics, used-room
counts, and exact assignment moves. If every stay is already
assigned and the candidate would use more rooms, or would add gap-nights without
reducing used rooms, the existing feasible assignment is retained.

If the snapshot cannot place every movable assignment, no room move is written.
An unassigned assignment must be included in the same planning pass and becomes
assigned whenever the plan is feasible. Room types with fewer than two verified
physical rooms skip rearrangement.

## Transaction and persistence

The PMS command adapter must:

1. acquire the existing property/room-type physical-unit mutation lock;
2. lock the room rows and affected assignment rows in stable ID order;
3. read the setting, assignments, blocks, lifecycle, and exact stay dates inside
   that transaction;
4. plan from that locked snapshot;
5. revalidate room identity and apply every move atomically;
6. append one PMS audit event per moved assignment with from/to room IDs,
   command reason, and shared correlation ID;
7. enqueue one calendar refresh after a successful non-empty move set.

Concurrent assignment, block, room-status, or room-label mutations use the same
lock. A planner failure or stale/invalid snapshot rolls back without partial
moves. Replaying a command returns the prior result and never duplicates audit
events.

The property setting defaults to enabled to preserve the existing PMS product
default. When disabled, automatic triggers are no-ops; manual room assignment
commands continue to work.

## Triggers and HTTP surface

Successful target reservation creation, cancellation, and stay-date modification
request optimization for every affected room type after their owned facts are
valid. The optimization runs in the caller transaction when possible; otherwise
a durable idempotent PMS job owns the retry. It must not be a fire-and-forget
promise.

Settings and shuffle-history routes require the existing
`pms.operations.manage` permission, active PMS entitlement, and property owner
or operator relationship. Every repository query remains property scoped.

## Frontend behavior

The calendar silently refreshes after successful moves. The UI shows one
five-second toast:

> N bookings rearranged for optimal room usage · View log

`View log` opens the property-scoped shuffle history. No confirmation dialog or
movement animation is added. Zero moves produce no toast.

## Verification

Required fixtures cover:

- same-day turnover and sequential lower-room packing;
- overlapping stays requiring multiple rooms;
- an unassigned stay placed by repacking;
- active blocks and checked-in/checked-out immovable stays;
- single-unit and disabled-setting no-ops;
- create, cancellation, and date-modification triggers;
- atomic rollback and concurrent room/block mutation;
- property authorization and cross-property isolation;
- shuffle audit rows, calendar refresh, toast, and history link;
- a representative 20-room workload completing without an external solver.
