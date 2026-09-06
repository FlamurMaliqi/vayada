# PMS operations route contracts

_VAY-770 contract record. Covers P1/P2 from
[`booking-pms-route-migration-inventory.md`](booking-pms-route-migration-inventory.md)
against the PMS operations target schema from VAY-672
(`packages/backend-migration/migrations/0006_pms_operations.sql`)._

## Purpose

This document defines the route contracts that must exist before implementation
tickets port the largest remaining PMS surface from `pms-api` to `apps/api`.
It is planning-only: Python PMS remains production source of truth until each
slice has an accepted TypeScript route, typed PMS Web client, contract tests,
parity fixtures, and rehearsal sign-off.

The scope is:

- **P1 reads:** rooms, room types, calendar/inventory days, room blocks,
  operational reservation list/detail, and room assignments.
- **P1 inventory writes:** room CRUD/reorder, room-type CRUD/duplicate, room
  blocks, and assignment/move/unassign/swap commands.
- **P2 operational commands:** check-in/out, operational status, private notes,
  additional guest projection through the Booking-owned guest PII boundary,
  no-show, checklist and inspection templates, and checkout charges.

Out of scope: Booking Engine guest lifecycle commands, direct PMS ownership of
guest PII writes, Channex/webhook intake, provider ARI push implementation,
payment provider settlement, payouts, and finance invoices. Those surfaces use
separate contracts.

## Contract Version

Every response and command result carries:

```ts
type PmsOperationsContractVersion = "pms-operations.v1";
```

Breaking changes require a new version. Additive response fields are allowed
only after they are documented here and covered by fixtures.

## Authorization

All routes are protected and must use `enforceRoutePolicy` at the route
boundary.

Required checks:

| Check                 | Read surfaces                                 | Write/command surfaces                        |
| --------------------- | --------------------------------------------- | --------------------------------------------- |
| Permission            | `pms.operations.read`                         | `pms.operations.manage`                       |
| Entitlement           | active `pms:property-management`              | active `pms:property-management`              |
| Entitlement resource  | `pms_property` with `resourceId = propertyId` | `pms_property` with `resourceId = propertyId` |
| Linked resource       | `pms_property` with `resourceId = propertyId` | `pms_property` with `resourceId = propertyId` |
| Allowed relationships | `owner`, `operator`, `front_desk`             | `owner`, `operator`, `front_desk`             |

Authentication failures return `401`. Permission, entitlement, inactive
entitlement, and linked-resource failures return `403`. A valid property with
no matching rows returns a successful empty shape, not `404`.

Temporary compatibility adapters may map `propertyId` to legacy PMS `hotel_id`,
but the route contract uses canonical target `propertyId` and must not expose
legacy table names in responses.

## Shared Scalars

```ts
type PmsDate = string; // YYYY-MM-DD
type PmsUtcDateTime = string; // ISO-8601 UTC with trailing Z
type PmsDecimalAmount = string; // major-unit decimal string
type PmsCurrencyCode = string; // ISO-4217 uppercase
```

Money values are decimal strings in this contract, even when legacy Python
surfaces returned JSON numbers. Inventory counts are integers. Percentages are
numbers. Unknown legacy statuses must be preserved as data on read routes but
must not be accepted as command targets unless the command explicitly allows
them.

## P1 Read Endpoints

| Surface            | Method | Path                                                                   | Target owner tables/read models                                                       |
| ------------------ | ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rooms              | `GET`  | `/api/pms/properties/:propertyId/rooms`                                | `pms.rooms`, `pms.room_types`                                                         |
| Room types         | `GET`  | `/api/pms/properties/:propertyId/room-types`                           | `pms.room_types`, `pms.rate_plans`, `pms.rate_rules`                                  |
| Room type detail   | `GET`  | `/api/pms/properties/:propertyId/room-types/:roomTypeId`               | same as room types                                                                    |
| Resolved rate      | `GET`  | `/api/pms/properties/:propertyId/room-types/:roomTypeId/resolved-rate` | `pms.rate_plans`, `pms.rate_rules`, `pms.inventory_days`                              |
| Calendar           | `GET`  | `/api/pms/properties/:propertyId/calendar`                             | `pms.inventory_days`, `pms.room_blocks`, assignments                                  |
| Reservations       | `GET`  | `/api/pms/properties/:propertyId/reservations`                         | `booking.guest_bookings`, `pms.operational_booking_assignments`, check-in/out records |
| Reservation detail | `GET`  | `/api/pms/properties/:propertyId/reservations/:guestBookingId`         | same as reservations plus notes, guests, charges                                      |

Read query rules:

- Calendar requires `from` and `to` date query parameters and rejects ranges
  over 370 days with `400 invalid_date_range`.
- Reservation list supports optional `status`, `arrivalFrom`, `arrivalTo`,
  `search`, `limit`, and `offset`. `limit` defaults to `50` and clamps to
  `[1, 500]`; `offset` defaults to `0`.
- Rooms and room types sort by `sortOrder ASC, name/roomNumber ASC`.
- Calendar rows sort by `stayDate ASC, roomType.sortOrder ASC`.
- All read responses include `sourceFreshness` when derived from a read model or
  migrated snapshot. A missing target projection is `500 read_model_unavailable`,
  not a silent legacy fallback.

Representative read models:

```ts
type PmsRoom = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: "available" | "maintenance" | "out_of_order" | "retired";
  sortOrder: number;
  metadata: Record<string, string | number | boolean | null>;
};

type PmsRoomType = {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: Record<string, string | number | boolean | null>;
  amenities: string[];
  media: { url: string; altText?: string | null }[];
  baseRate: { amountDecimal: PmsDecimalAmount; currency: PmsCurrencyCode };
  active: boolean;
  sortOrder: number;
  ratePlans: PmsRatePlan[];
  rateRulesSummary: PmsRateRulesSummary;
  roomCount: number;
};

type PmsRatePlan = {
  ratePlanId: string;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRate: { amountDecimal: PmsDecimalAmount; currency: PmsCurrencyCode };
  active: boolean;
};

type PmsRateRulesSummary = {
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: number;
};

type PmsRoomBlockSummary = {
  blockId: string;
  roomTypeId: string;
  roomId: string | null;
  startsOn: PmsDate;
  endsOn: PmsDate;
  blockedCount: number;
  reason: string;
  status: "active" | "released" | "expired";
};

type PmsCalendarDay = {
  stayDate: PmsDate;
  roomTypeId: string;
  totalCount: number;
  assignedCount: number;
  occupiedCount: number;
  blockedCount: number;
  availableCount: number;
  status: "open" | "closed" | "limited";
  blocks: PmsRoomBlockSummary[];
  assignmentRefs: string[];
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type PmsOperationalAssignment = {
  assignmentId: string;
  roomTypeId: string;
  ratePlanId: string | null;
  roomId: string | null;
  roomNumber: string | null;
  position: number;
  assignmentStatus:
    | "pending"
    | "assigned"
    | "checked_in"
    | "in_house"
    | "checked_out"
    | "canceled"
    | "released";
  channel: string;
  assignedAt: PmsUtcDateTime | null;
};

type PmsOperationalReservation = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: "direct_booking" | "channel" | "manual" | "migration";
  stay: { checkIn: PmsDate; checkOut: PmsDate; adults: number; children: number };
  primaryGuest: {
    displayName: string;
    email: string | null;
    phone: string | null;
    specialRequests: string | null;
  };
  addOns: { addonId: string; name: string; quantity: number }[];
  assignments: PmsOperationalAssignment[];
  checkin: { completedAt: PmsUtcDateTime | null; pendingFlags: string[] };
  checkout: { completedAt: PmsUtcDateTime | null; pendingFlags: string[] };
  privateNoteCount: number;
  additionalGuestCount: number;
  // Present on reservation detail when the Booking guest PII port is wired.
  additionalGuests?: BookingGuestPii[];
};
```

## P1 Inventory-Affecting Write Endpoints

| Command                                  | Method              | Path                                                                        | ARI effect                                                                     |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Create/update/delete room                | `POST/PATCH/DELETE` | `/api/pms/properties/:propertyId/rooms*`                                    | no immediate ARI push unless room count changes inventory                      |
| Reorder rooms                            | `PATCH`             | `/api/pms/properties/:propertyId/rooms/reorder`                             | none                                                                           |
| Create/update/duplicate/delete room type | `POST/PATCH/DELETE` | `/api/pms/properties/:propertyId/room-types*`                               | enqueue `pms.inventory.ari_changed` when rate/inventory-relevant fields change |
| Create/update/release room block         | `POST/PATCH/DELETE` | `/api/pms/properties/:propertyId/room-blocks*`                              | enqueue `pms.inventory.ari_changed`                                            |
| Assign/move/unassign/swap room           | `PATCH`             | `/api/pms/properties/:propertyId/reservations/:guestBookingId/assignments*` | enqueue calendar projection refresh; ARI only when availability changes        |

Each write command accepts `commandId`, `idempotencyKey`, and `expectedVersion`
when updating an existing resource. Successful command responses return the
updated read model plus:

```ts
type PmsCommandMeta = {
  contractVersion: "pms-operations.v1";
  commandId: string;
  idempotencyKey: string;
  acceptedAt: PmsUtcDateTime;
  sideEffects: Array<"calendar_refresh" | "ari_changed" | "audit_event">;
};
```

Implementation tickets must persist side effects through the jobs/events
outbox; route handlers must not call Channex directly.

## P2 Operational Command Endpoints

| Command                                     | Method                  | Path                                                                              | Target owner tables                                                                                                    |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Update operational status                   | `PATCH`                 | `/api/pms/properties/:propertyId/reservations/:guestBookingId/status`             | assignments, `booking_status_events` through Booking-owned event bridge where guest-visible                            |
| Check in                                    | `POST`                  | `/api/pms/properties/:propertyId/reservations/:guestBookingId/check-in`           | `pms.booking_checkin_records`, assignments                                                                             |
| Mark no-show                                | `POST`                  | `/api/pms/properties/:propertyId/reservations/:guestBookingId/no-show`            | assignments, audit event                                                                                               |
| Private notes list/create/delete            | `GET/POST/DELETE`       | `/api/pms/properties/:propertyId/reservations/:guestBookingId/notes*`             | `pms.booking_notes_private`                                                                                            |
| Additional guests list/create/update/delete | `GET/POST/PATCH/DELETE` | `/api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests*` | Booking-owned guest PII command/read port plus PMS detail projection; no PMS direct writes to `booking.booking_guests` |
| Checklist template read/write               | `GET/PUT`               | `/api/pms/properties/:propertyId/check-in-checklist`                              | `pms.checkin_checklist_templates`                                                                                      |
| Inspection template read/write              | `GET/PUT`               | `/api/pms/properties/:propertyId/check-out-inspection`                            | `pms.checkout_inspection_templates`                                                                                    |
| Checkout charge list/create/mark-paid/waive | `GET/POST/POST/POST`    | `/api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges*`  | `pms.booking_checkout_charges`; operational charge state only                                                          |
| Check out                                   | `POST`                  | `/api/pms/properties/:propertyId/reservations/:guestBookingId/check-out`          | `pms.booking_checkout_records`, assignments                                                                            |

P2 commands are private PMS operations unless the command explicitly emits a
Booking guest-visible event. Notes are private by default and must never flow to
public bookability, AI public profile, or guest email contracts.

VAY-780 implements the P2a private notes slice in `apps/api` for list/create/delete.
Private note responses include internal audit metadata, create/delete commands
record PMS product audit events only, and public/guest-visible projections are
covered by fixtures that assert note bodies, note IDs, legacy table names, and
private-note-shaped keys such as `privateNoteId`, `privateNoteBody`,
`bookingNotesPrivate`, and `privateNoteCount` do not appear outside the
authorized PMS notes surface.

Checkout charge payment status is operational in this contract. Provider
collection, invoices, payouts, and reconciliation are finance-owned follow-up
surfaces.

Additional guest writes are a PMS Web operation but not a PMS table ownership
grant. The PMS route may expose the admin workflow shape for compatibility, but
the implementation must call a Booking-owned guest PII command/read port that
owns validation, retention, and guest-visible audit rules. PMS may project the
result onto reservation detail; it must not write `booking.booking_guests`
directly or duplicate guest PII into PMS tables.

VAY-781 implements the Booking guest PII boundary for `apps/api`. The contract
is exported from `@vayada/domain-booking` as `BookingGuestPiiPort`:

```ts
type BookingGuestPii = {
  guestId: string;
  guestBookingId: string;
  role: "booker" | "primary_guest" | "additional_guest";
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  arrivalTime: string | null;
  specialRequests: string | null;
};

type BookingGuestPiiPort = {
  listGuestPiiForPmsOperations(query): Promise<BookingGuestPiiProjection | null>;
  createAdditionalGuestForPmsOperations(command): Promise<BookingGuestPiiCommandResult>;
  updateAdditionalGuestForPmsOperations(command): Promise<BookingGuestPiiCommandResult>;
  deleteAdditionalGuestForPmsOperations(command): Promise<BookingGuestPiiDeleteResult>;
};
```

The target adapter lives under the Booking/platform boundary and is the only
new TypeScript code in this slice allowed to mutate `booking.booking_guests`.
PMS route/domain code must call the port. The architecture boundary check
blocks direct `booking.booking_guests` mutations from `pmsOperations` route code
and PMS domain modules.

VAY-782 implements the P2c checklist/inspection template subset in `apps/api`.
`GET /api/pms/properties/:propertyId/check-in-checklist` and
`GET /api/pms/properties/:propertyId/check-out-inspection` use the PMS
operations read policy; the corresponding `PUT` routes use the manage policy
and persist PMS-owned operational setup steps to
`pms.checkin_checklist_templates` and `pms.checkout_inspection_templates`.
Template writes validate that `steps` is an array of bounded step objects with
stable `stepId`, required `label`, and boolean `required` state. Checkout charge
commands are handled by VAY-783; the check-out command remains VAY-784.

VAY-783 implements the P2c checkout charge operational subset in `apps/api`.
`GET /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges`
uses the PMS operations read policy; `POST /checkout-charges`,
`POST /checkout-charges/:chargeId/mark-paid`, and
`POST /checkout-charges/:chargeId/waive` use the PMS operations manage policy
and persist only `pms.booking_checkout_charges` operational state plus PMS audit
events. The legacy F1a guard path
`POST /checkout-charges/:chargeId/paid` remains as a compatibility alias for
the same operational mark-paid command. The check-out command is still VAY-784
and is not implemented by this slice.

`mark-paid` on checkout charges means a front-desk operator marked the
operational charge as settled for checkout. It is not a provider payment
capture, invoice post, payout trigger, or finance reconciliation event.

VAY-784 implements the P2c check-out command in `apps/api`.
`POST /api/pms/properties/:propertyId/reservations/:guestBookingId/check-out`
uses the PMS operations manage policy and persists `pms.booking_checkout_records`
with inspection results, checkout notes, charge settlement snapshots, pending
flags, and explicit finance handoff metadata. The command updates valid
reservation assignments to `checked_out`, records PMS audit only, and keeps
unsettled paid-charge behavior finance-owned: provider collection, invoice
posting, payouts, reconciliation, and finance dispatch are not performed by this
route.

## Error Categories

| Category         | Status         | Codes                                                                                                                                                                      |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication` | `401`          | `unauthenticated`, `invalid_token`                                                                                                                                         |
| `authorization`  | `403`          | `missing_permission`, `missing_entitlement`, `inactive_entitlement`, `missing_resource_access`                                                                             |
| `validation`     | `400`          | `invalid_query`, `invalid_body`, `invalid_date_range`, `invalid_status_transition`, `invalid_guest_pii`                                                                    |
| `conflict`       | `409`          | `version_conflict`, `room_unavailable`, `assignment_conflict`, `idempotency_conflict`                                                                                      |
| `not_found`      | `404`          | `room_not_found`, `room_type_not_found`, `reservation_not_found`, `block_not_found`, `note_not_found`, `guest_not_found`, `additional_guest_not_found`, `charge_not_found` |
| `read_model`     | `500`          | `read_model_unavailable`                                                                                                                                                   |
| `side_effect`    | `202` or `500` | `side_effect_queued`, `side_effect_failed`                                                                                                                                 |

Commands that durably persist but queue asynchronous side effects may return
`202` with `side_effect_queued`. They must still return the accepted command
metadata and enough read-model state for PMS Web to avoid duplicate submission.

## Fixtures

Representative contract fixtures live in:

```text
engineering/fixtures/pms-operations-route-contracts/cases.json
```

They intentionally complement the target migration fixture at
`packages/backend-migration/fixtures/cases/pms-operations/`: migration fixtures
prove source-to-target transforms, while route fixtures prove HTTP contract
behavior, authorization, and frontend-visible state.

The fixture set must cover:

- assigned and unassigned reservations;
- room-type and room-level blocks;
- calendar rows where assigned + blocked + available equals total;
- ARI-affecting writes queued through jobs/events;
- no direct Channex call from route handlers;
- check-in/out record shape, pending flags, checklist/inspection templates;
- operational status, no-show, additional guest boundary, and checkout charge
  create/mark-paid/waive commands;
- private notes excluded from public and guest-visible payloads;
- checkout charges paid/waived without claiming finance settlement ownership.

## Reads-Before-Writes Slice Order

| Slice | Scope                                                                      | Rehearsal gate                         |
| ----- | -------------------------------------------------------------------------- | -------------------------------------- |
| P1a   | Rooms and room types read contracts, PMS Web typed clients, denial matrix  | Yes                                    |
| P1b   | Calendar, room blocks, reservation list/detail reads                       | Yes                                    |
| P1c   | Assignment reads and assignment commands                                   | Yes                                    |
| P1d   | Room, room-type, and room-block writes with outbox-backed ARI side effects | Yes                                    |
| P2a   | Check-in, no-show, operational status, private notes                       | Yes                                    |
| P2b   | Additional guests and guest-operation detail projection                    | Yes                                    |
| P2c   | Checklist/inspection templates, checkout charges, check-out command        | Yes                                    |
| F1a   | Finance/provider settlement bridge for paid charges                        | Finance gate unless charges are frozen |

The staging rehearsal cannot start while PMS Web still depends on legacy PMS
routes for inventory, operational reservations, room assignment, check-in/out,
notes, or guest operations. If F1a is not complete, paid checkout charges must
be explicitly frozen or routed through an accepted finance contract for the
rehearsal window; PMS operations must not implement provider settlement itself.

## First Implementation Tickets

Ready to create after this contract is accepted:

1. **Implement PMS rooms and room-types read routes against target fixtures**
   - Scope: P1a route adapters, repository interfaces, denial matrix, typed PMS
     Web read clients, fixture cases `rooms-room-types-read` and authorization.
2. **Implement PMS calendar, room blocks, and reservation read routes**
   - Scope: P1b list/detail reads from target read models, empty states,
     pagination/search, fixture cases `calendar-blocks-read`,
     `reservations-assigned-unassigned`.
3. **Implement PMS room assignment commands**
   - Scope: P1c assign/move/unassign/swap command contract, conflict handling,
     idempotency, calendar refresh outbox events.
4. **Implement PMS inventory writes with ARI side-effect outbox events**
   - Scope: P1d rooms, room types, room blocks writes; no direct Channex calls;
     `pms.inventory.ari_changed` outbox validation.
5. **Implement PMS operational status, check-in, and no-show commands**
   - Scope: P2a status transitions, check-in, no-show, command metadata, denial
     matrix, and assignment state projection.
6. **Implement PMS private notes routes**
   - Scope: private note list/create/delete, public/guest exclusion assertions,
     note audit metadata, and no public read-model exposure.
7. **Define and wire the Booking guest PII port for PMS additional guests**
   - Scope: Booking-owned additional guest create/update/delete/read contract,
     PMS detail projection, retention/audit rules, and no direct PMS writes to
     `booking.booking_guests`.
8. **Implement PMS checklist and inspection template routes**
   - Scope: check-in checklist template read/write, check-out inspection
     template read/write, template validation fixtures.
9. **Implement PMS checkout charge operational commands**
   - Scope: charge list/create/mark-paid/waive, operational state only, explicit
     finance non-ownership assertions.
10. **Implement PMS check-out command**
    - Scope: checkout record creation, inspection result persistence, pending
      flags, assignment status update, and freeze/finance handoff note for any
      unsettled paid-charge behavior.

Each ticket must keep its PR narrow, link this contract, and state whether it is
a staging rehearsal gate.

## References

- `engineering/booking-pms-route-migration-inventory.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/target-schema-migration-coverage.md`
- `engineering/pms-reservation-integration-contract.md`
- `engineering/jobs-events-contract.md`
- `packages/backend-migration/migrations/0006_pms_operations.sql`
- `packages/backend-migration/fixtures/cases/pms-operations/`

## VAY-960: manual cancellation guest message

`POST /properties/:propertyId/reservations/:guestBookingId/cancel` accepts a
separate optional `guestMessage` string (at most 5000 characters). The internal
`reason` is required and remains in private audit evidence only. The guest
message normalizes CRLF/CR to LF and trims outer whitespace; blank means no custom
copy. A cancellation email is queued atomically with cancellation using the shared
booking notification snapshot and durable delivery worker introduced by VAY-930.
The plain-text email preserves paragraphs and treats markup as literal text.
Replays do not queue a second email; changing the message with a used idempotency
key conflicts. No schema change is required.

This command continues to support confirmed manual PMS bookings only. Direct and
channel bookings remain unavailable in this UI until their cancellation contracts
are implemented. The UI requests no retained charge and does not issue refunds.
