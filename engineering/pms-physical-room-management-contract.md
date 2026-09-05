# PMS physical-room management (VAY-1287)

Extends VAY-1068/VAY-1070 and `pms-operations-route-contracts.md`.
Uses `pms.rooms`, opaque IDs and the room type's `room_units_revision`.

Property-scoped create, update and retire commands require `pms.operations.manage`,
an active property-management entitlement and an explicit property link. Each
command carries an expected unit revision and Idempotency-Key. The repository
rechecks authorization, serializes inventory, room ordering and physical-unit
mutations, and commits the room change, revision, audit and durable events together.
Replay returns the original result, including retirement replay, before examining
the current revision. Changed payloads cannot reuse a key.

Create accepts an operator-confirmed label and optional floor. Update changes
label, floor or operational status without changing room type or identity.
Retirement preserves the row and all historical records. Explicit retirement
may retire a verified label; automatic count reconciliation retains its existing
more conservative label protections. Reservations, assignments, blocks and unsafe
capacity reductions return structured blockers before any room write.

Capacity changes must preserve generated calendar provenance and operational
inventory overrides. Calendar and public availability refreshes are durable and
must not reopen closed inventory or copy provider state. Duplication and room-type
retirement reuse the existing `roomTypeLifecycle.ts` contract and commands.

## Inventory transition

For a current canonical calendar, append a calendar revision with the existing
schedule and room bindings, advancing the changed type's unit revision and
capacity. An unrestricted starting limit follows capacity; a lower explicit
starting limit stays capped. Preserve manual/channel limits, bookings, blocks,
linked stop-sell state and pricing gates. Rebind future materialized days and
coverage atomically; historical days retain their original provenance. Reject
stale/incomplete coverage and overrides that exceed reduced capacity. A calendar
binding requires at least one physical room, so its final unit is protected.
Unconfigured rooms acquire no dates. Existing unconfigured inventory blocks
capacity changes until the target calendar is configured.

Emit existing calendar, ARI and public-bookability outbox events using the
property-local current date through the actual inventory horizon. Reconcile
linked inventory with the existing owner and its durable side effects.
