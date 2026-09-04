# PMS manual booking cross-stack contract

_VAY-1247 decision record for VAY-647. This contract aligns the production
legacy Python PMS, the target TypeScript Booking/PMS/Finance domains, canonical
booking attribution, and PMS Financials before either New Booking UI is changed._

## Decision

Manual booking creation is one product command with two temporary backend
implementations:

- legacy Python remains the production source of truth before cutover;
- target TypeScript implements the same behavior against target domains and
  schema, without copying legacy table boundaries;
- PMS Web uses the same versioned command semantics in both release tracks;
- an environment executes exactly one writer. There is no dual write;
- browser UI work starts only after the selected backend path implements the
  required command or an accepted compatibility adapter.

The contract version is `pms-manual-booking.v1`. Breaking request or semantic
changes require a new version. Additive response evidence may be added to v1.

## Current evidence and gaps

| Surface                              | Current behavior                                                                                                                                      | Gap against VAY-647                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy Python `POST /admin/bookings` | Creates one confirmed booking for one physical room; accepts raw `channel`, optional uniform nightly rate, add-ons, phone text, and `specialRequests` | No canonical direct source, rate-plan identity, internal note, idempotency, per-room dates/guests/rates, or atomic paid evidence         |
| Legacy `booking_rooms`               | Stores only additional physical room IDs and positions                                                                                                | Extra rooms inherit the primary room type, dates, guests, and price; this is not VAY-647 heterogeneous multi-room support                |
| Target TypeScript                    | Reads operational reservations, rooms, room types, rate plans, and assignments                                                                        | No PMS manual booking writer; current assignments have no per-assignment dates or guest counts                                           |
| PMS Web                              | Contains one single-room modal; the value called Notes is sent as guest-facing `specialRequests`                                                      | Target service marks create, rate, and add-on reads unsupported; writes are hidden; raw OTA channels are selectable in the dormant modal |
| Attribution                          | VAY-1186 defines canonical channel and direct-source evidence; VAY-1188 system-assigns `direct/booking_engine`                                        | The draft direct-source set omits `email`; manual routes must reject `booking_engine`                                                    |
| Revenue                              | VAY-1183 defines normalized nightly evidence; VAY-1184 owns target PMS-manual producer wiring                                                         | Manual creation must persist exact or explicitly inferred nightly evidence in the booking transaction                                    |
| Payments                             | Finance owns `finance.payments`; VAY-1092 preserves payment facts while rebuilding Financials and folios                                              | A mutable booking payment-status string is not settlement evidence; the removed synthetic invoice-payment command is not reused          |

The old and target stacks therefore need separate implementation PRs. Sharing
this contract does not mean sharing persistence code or writing both databases.

## Domain ownership

| Fact or behavior                                                                          | Canonical target owner   | Legacy representation before cutover                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| Guest booking identity, primary guest, special requests, aggregate total and lifecycle    | Booking                  | `bookings`                                                                           |
| Canonical channel and direct source                                                       | Booking                  | New constrained manual-source field; raw `channel` is compatibility-only             |
| Physical room, stay dates, guests, rate-plan selection and assignment state for each stay | PMS operations           | A normalized legacy stay/room representation; do not overload current extra-room IDs |
| Rate plans, rules, availability and resolved per-night prices                             | PMS operations           | Current room/rate repositories plus explicit snapshots                               |
| Immutable per-night revenue evidence                                                      | Booking                  | Persisted manual price snapshot that migration can map without using current rates   |
| Add-on definition and purchased economic snapshot                                         | Booking                  | Existing booking add-on fields until migrated                                        |
| Expected payment method                                                                   | Booking/checkout context | Booking payment-method compatibility field                                           |
| Received payment, refund and dispute evidence                                             | Finance                  | `payments` row with actor/time/reference evidence                                    |
| Internal note                                                                             | PMS operations           | `booking_notes`; never `special_requests`                                            |
| Guest-facing special requests and phone                                                   | Booking guest PII        | Booking guest fields                                                                 |
| Audit, idempotency and asynchronous availability/email work                               | Platform jobs/audit      | Transactional command record plus post-commit legacy jobs                            |

PMS orchestrates the hotel-user command, but it does not acquire ownership of
Booking guest PII, attribution, revenue, or Finance payment facts. The target
application service calls typed owner ports within one database transaction.
The route adapter must not implement the transaction with unrestricted
cross-domain SQL.

## Canonical command

The target route is:

```text
POST /api/pms/properties/:propertyId/manual-bookings
```

It requires `pms.operations.manage`, the active `pms:property-management`
entitlement, a linked `pms_property`, and an `owner`, `operator`, or
`front_desk` relationship through `enforceRoutePolicy`.

A `paid` settlement additionally requires the accepted property Finance-write
policy (`pms.finance.manage`, a finance-capable property entitlement, and an
`owner` or `finance_manager` relationship). Authorization runs before command
or idempotency lookup. An operator without Finance access may create the same
booking as `unpaid`; the UI must not offer Paid to that operator.

The legacy compatibility route remains `POST /admin/bookings`. Its adapter maps
the same logical command into legacy persistence and may temporarily accept the
old single-room body. The canonical body is authoritative for new UI work.

| Old-body input          | Compatibility behavior before VAY-1258                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| No `contractVersion`    | Detect exact old shape; return `BookingAdminResponse`, not v1 `Result`                    |
| `channel = direct`      | Persist channel `direct` and compatibility source `unknown`; never invent a manual source |
| Any other channel       | Reject with `422 invalid_source`, including OTA, website, Booking Engine/Vayada           |
| Missing payment         | Persist expected method `unknown`, unpaid, and no received-payment row                    |
| Numeric `nightlyRate`   | Require finite/non-negative; convert with decimal text and snapshot in property currency  |
| Missing idempotency key | No replay guarantee; audit compatibility use and never synthesize a stable key            |
| Old add-on fields       | Preserve old single-stay quantity rules and snapshot their resolved economics             |

The adapter is feature-gated, fixture-tested with the deployed modal payload,
and removed after VAY-1258 is deployed and audited old-shape traffic reaches
zero. New v1 callers never accept `unknown` source or expected method.

<!-- prettier-ignore -->
```ts
type Date = string; type Decimal = string;
type Money = { amountDecimal: Decimal; currency: string };
type Command = {
  contractVersion: "pms-manual-booking.v1";
  commandId: string;
  idempotencyKey: string;
  guest: {
    firstName: string; lastName: string; email: string;
    phoneE164: string | null; countryCode: string | null;
    specialRequests: string | null;
  };
  privateNote: string | null;
  directSource: "call" | "email" | "whatsapp" | "walk_in" | "social_media" | "other";
  stays: Array<{
    position: number; roomId: string; checkIn: Date; checkOut: Date;
    adults: number; children: number; ratePlanId: string | null;
    pricing:
      | { kind: "rate_plan"; manualOverride: Money | null }
      | { kind: "custom"; nightlyAmount: Money };
  }>;
  addOns: Array<{
    addonId: string; packageCount: number;
    serviceUnits: Array<{ serviceDate: Date | null; guestCount: number | null }>;
  }>;
  payment: {
    expectedMethod: "pay_at_property" | "bank_transfer" | "manual_card" | "cash" | "other";
    settlement:
      | { status: "unpaid" }
      | { status: "paid"; reference: string | null };
  };
};
```

Both stacks also expose a side-effect-free preview for the same `stays` and
`addOns` selections:

```text
POST /api/pms/properties/:propertyId/manual-bookings/preview
POST /admin/bookings/preview                         # legacy adapter
```

<!-- prettier-ignore -->
```ts
type PreviewCommand = Pick<Command, "contractVersion" | "stays" | "addOns">;
type PreviewResult = {
  contractVersion: "pms-manual-booking.v1"; currency: string;
  stays: Array<{
    position: number; roomId: string; ratePlanId: string | null;
    nightly: Array<{ serviceDate: Date; standard: Money | null; applied: Money }>;
    standardTotal: Money | null; appliedTotal: Money;
  }>;
  addOns: Array<{
    addonId: string; pricingModel: "per_stay" | "per_night" | "per_guest" | "per_guest_night";
    unitPrice: Money; packageCount: number;
    serviceUnits: Command["addOns"][number]["serviceUnits"]; total: Money;
  }>;
  grandTotal: Money;
};
```

Both endpoints return `{ code, message, field?, stayPosition? }` on failure:

| HTTP  | Codes                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` | `invalid_body`, `unknown_field`                                                                                                                         |
| `403` | `forbidden`, `entitlement_required`; create also uses `paid_forbidden`                                                                                  |
| `404` | `property_not_found`, `room_not_found`, `rate_plan_not_found`, `rate_not_found`, `addon_not_found`                                                      |
| `409` | `room_unavailable`; create also uses `idempotency_conflict`                                                                                             |
| `422` | `invalid_dates`, `occupancy_exceeded`, `currency_mismatch`, `inactive_rate_plan`, `invalid_addon_selection`, `invalid_source`, `invalid_payment_method` |

Preview is display evidence, not a reservation or price lock; it has no
idempotency reservation. Create revalidates and recalculates inside the booking
transaction. The browser never submits an authoritative total.

`bookingChannel` is deliberately absent. The server always persists `direct`.
`booking_engine` is also absent. It is reserved for the Booking Web producer and
must be rejected if injected through aliases, unknown fields, or a legacy raw
channel field. The UI label **Phone** maps to `call`.

Email is accepted as a canonical direct source. VAY-647 explicitly requires
hosts to record bookings received by email, and treating it as `other` would
discard Financials attribution. VAY-1186 must include `email` before VAY-1187 or
the target manual writer can be accepted.

## Validation and pricing rules

- Unknown request keys are rejected on command routes.
- `commandId` and `idempotencyKey` are required and bounded. An exact replay
  returns the original result; changed payload reuse returns `409`.
- A command contains 1 to 20 stays. Positions are unique and contiguous from 1.
- Each room and rate plan belongs to the authorized property. A selected rate
  plan is active and belongs to that stay's room type.
- Check-out is after check-in. Each room is available for its full stay, and
  duplicate/overlapping use of the same physical room is rejected.
- Both writers lock selected physical-room rows in sorted room-ID order, then
  recheck every date window and insert in the same transaction. A concurrent
  overlap test must produce one success and one `409 room_unavailable`.
- Adults are at least 1, children are non-negative, and occupancy is validated
  per stay rather than against a booking-wide maximum.
- All money is a non-negative base-10 decimal string in the property pricing
  currency. JSON floating-point prices and client-computed totals are rejected.
- `rate_plan` pricing is resolved server-side for every service night from the
  selected plan and then snapshotted. A manual override replaces each nightly
  plan amount but preserves the chosen plan ID and comparison evidence.
- Additional-guest pricing uses a matching current Booking guest-policy
  projection to decide whether children count. If that optional projection is
  absent or its pricing fingerprint, selected rate, or additional-guest source
  does not match current PMS evidence, all selected occupants count.
- `custom` pricing requires an explicit nightly amount and has no rate-plan ID.
  There is no silent fallback to the current flexible/base rate.
- Per-night evidence is `exact` for resolved plans and uniform manual amounts.
  An inferred equal allocation is allowed only in migration or a separately
  authorized correction command that explicitly chooses `inferred`; the New
  Booking UI never submits `missing` or implicit allocation.
- Add-on IDs are unique and booking-level. The server resolves the active
  definition, pricing model, unit price and currency, then snapshots them.
- `packageCount` is positive. `per_stay` uses one null/null unit; `per_guest`
  uses one null-date unit with guest count bounded by summed stay occupancy.
- `per_night` uses one null-guest unit per distinct service date.
  `per_guest_night` uses one guest-count unit per distinct date. Each date must
  be covered by a stay and its count cannot exceed occupancy on that date; room
  overlap does not multiply a date. Total is unit price times package count
  times the sum of each unit's guest count, or one when null.
- Email is required for v1. Phone is optional, but a supplied value is stored in
  E.164 form; `countryCode` is the guest country and is not a dial-code field.
- `privateNote` is access-controlled PMS data. `specialRequests` is guest-facing
  Booking PII and may be used by confirmed guest communication.

The booking-wide dates are `min(stays.checkIn)` and `max(stays.checkOut)`;
`roomCount` is `stays.length`; adults and children are separately summed across
stays. These are occupancy-slot summaries, so a person assigned to two rooms is
intentionally counted twice. Availability, pricing and calendar placement use
the individual stays.

## Payment rule

`unpaid` creates no received-payment fact. The booking balance equals the
server-calculated grand total and its derived payment state is unpaid.

Expected payment method is Booking-owned intent for both paid and unpaid
bookings. Target Booking persists the canonical enum through an owner port.
Legacy adds a canonical field rather than forcing `manual_card`, `cash`, or
`other` through the narrower historical `payment_method` constraint. Its old
compatibility projection is non-authoritative; migration reads the new field.
Every method is tested with paid and unpaid creation.

`paid` means the host records full settlement at creation. In the same
transaction, Finance creates one manual `finance.payments` fact for the grand
total with:

- the selected method, including the permitted `paid + pay_at_property` edge
  case;
- `status = paid`, `payment_kind = manual`, property, booking and currency;
- actor, accepted timestamp, idempotency/source reference, and optional
  operator reference; and
- no provider identifiers, invoice allocation, payout, or external accounting
  side effect.

Only after that insert succeeds may the booking derive `paymentStatus = paid`
and zero balance. Failure rolls back the guest booking, stays, guests, source,
nightly evidence, add-ons, note and payment together. A status string by itself
never proves payment. VAY-648 may reuse the same Finance-owned evidence command
for later **Mark as paid** behavior.

Manual creation does not create an invoice. VAY-1092 folios may later reference
the Finance payment ID; an operational folio is not an official tax invoice.

## Atomic write and response

The successful transaction commits, in owner order:

1. command/idempotency reservation and audit context;
2. Booking guest booking with `source_system = pms`, canonical attribution,
   expected payment method and aggregate totals;
3. Booking guest PII and guest-facing special requests;
4. one PMS operational stay/assignment per command stay;
5. exact Booking nightly revenue evidence and add-on economic snapshots;
6. optional PMS private note;
7. optional Finance manual payment evidence; and
8. transactional outbox/audit records for calendar refresh, availability/ARI,
   guest confirmation, and read-model refresh.

Legacy Python must use one acquired connection/transaction for the equivalent
persistence. Email and Channex/ARI calls run only after commit; failures are
observable and retryable and do not cause a second booking.

<!-- prettier-ignore -->
```ts
type Result = {
  contractVersion: "pms-manual-booking.v1";
  outcome: "created" | "replayed";
  commandId: string; idempotencyKey: string;
  guestBookingId: string; bookingReference: string;
  bookingChannel: "direct"; directSource: Command["directSource"];
  stayCount: number; checkIn: Date; checkOut: Date;
  total: Money; balance: Money; paymentStatus: "unpaid" | "paid";
  paymentEvidenceId: string | null;
  sideEffects: Array<"calendar_refresh" | "ari_changed" | "guest_confirmation" | "audit_event">;
};
```

Responses never expose private note bodies, raw provider data, payment
credentials, or unrestricted guest PII beyond the authorized PMS response.

## Field ownership and cross-stack treatment

| Field/capability  | Validation                                     | Source of truth and persistence         | Legacy Python                 | Target TypeScript            | UI/cutover                                 |
| ----------------- | ---------------------------------------------- | --------------------------------------- | ----------------------------- | ---------------------------- | ------------------------------------------ |
| `stays[]`         | Property, room, dates, occupancy, availability | PMS per-stay rows                       | New normalized evidence       | PMS assignments/stay schema  | Never fake with extra-room IDs             |
| Rate plan/pricing | Active matching plan or explicit custom amount | PMS selection; Booking nightly snapshot | Plan ID and exact nights      | PMS plan + VAY-1184 evidence | Server preview is authoritative            |
| Guest/phone       | Required name/email; optional E.164 phone      | Booking guest PII                       | Booking guest fields          | Booking owner port           | Property country only defaults dial code   |
| Special requests  | Bounded guest-facing text                      | Booking guest PII                       | `bookings.special_requests`   | Booking owner port           | Separate from internal note                |
| Private note      | PMS-authorized bounded text                    | PMS private notes                       | Transactional `booking_notes` | PMS note owner port          | Never guest-visible                        |
| Direct source     | Canonical enum; reject OTA/Booking Engine      | Booking attribution                     | Constrained canonical field   | VAY-1186/1187                | Required; channel fixed to Direct          |
| Expected method   | Canonical enum for paid and unpaid             | Booking payment intent                  | New canonical field           | Booking owner port           | Display on detail/check-in                 |
| Settlement        | Paid requires Finance policy and full amount   | Finance payment evidence                | Atomic captured row           | VAY-1253 Finance port        | Hide Paid without permission/evidence path |
| Add-ons           | Active property item and model-specific units  | Booking economic snapshot               | Normalized selection snapshot | Booking add-on owner port    | One booking-level section                  |
| Replay            | Same key + same payload only                   | Platform command record                 | Transactional record          | Platform owner port          | Generate one key per submit action         |
| Done button       | Primary design token                           | Shared frontend                         | Backported release            | Target main                  | Visual only                                |

## Migration, parity and cutover

1. Implement legacy schema, preview and writer first because Python currently
   owns production writes. Keep old single-room requests working during rollout.
2. Implement target schema/owner ports and the target writer in stacked PRs.
   Target code does not read or write the legacy PMS database.
3. Run shared contract fixtures against both adapters. Required cases include
   one custom-rate stay, cross-season rate plan, different-date multi-room,
   booking-engine injection, Email attribution, room conflict, exact replay,
   changed replay, paid rollback, private/guest note separation, and cross-
   property denial.
4. Migration maps only explicitly stored legacy manual sources and price
   snapshots. Historical raw `direct` rows remain canonical `unknown`; source
   and price are never guessed from current state.
5. Reconcile booking, stay, nightly amount, add-on, payment and source counts and
   totals before cutover. Missing evidence is reported, not coerced to paid or
   inferred.
6. Activate the target writer and target PMS Web together behind the normal
   cutover gate. Do not dual-write. Keep legacy rollback data read-only through
   the agreed window.
7. Run configured-property browser acceptance after VAY-1043 supplies the
   required hotel/property setup path.

The production legacy PMS Web is a frozen release path. A UI backport needs an
explicit legacy release ticket; adding a legacy client back to target `main`
would violate the VAY-981 no-legacy-admin-call boundary.

## Dependency order

```text
VAY-1247 contract
  -> VAY-1186 canonical attribution (include Email)
       -> VAY-1187 target manual attribution producer
  -> VAY-1183 normalized nightly evidence
       -> VAY-1184 target manual nightly producer
  -> VAY-1248 legacy schema -> VAY-1249 preview -> VAY-1250 writer -> VAY-1262 consumers
  -> VAY-1251 target stay schema -> VAY-1252 target preview
  -> VAY-1253 Finance settlement port
       -> VAY-1254 target writer -> VAY-1187 + VAY-1184 -> VAY-1255 client + VAY-1261 projections
  -> VAY-1256 shared fields -> VAY-1257 heterogeneous-room UI
  -> VAY-1261 + VAY-1262 + VAY-1257 -> VAY-1263 downstream UI -> VAY-1258 legacy backport
  -> VAY-1259 migration and adapter parity
  -> VAY-1260 browser verification (also blocked by VAY-1043)
```

VAY-648 owns payment-state derivation, OTA evidence, historical balance repair,
and later mark-paid/list/detail behavior. This contract owns only the payment
input and atomic evidence created with a new manual booking.

## Implementation slicing rules

- Contract, schema, preview, owner ports, legacy writer, target writer, UI field
  groups, migration/parity, and browser verification are separate tickets and
  PRs.
- VAY-1184 and VAY-1187 remain the target revenue and attribution producer
  tickets; do not duplicate them inside the target writer PR.
- Each PR answers one review question and targets no more than 400 changed
  non-generated lines.
- Both backend paths must cover transaction rollback, authorization/property
  isolation, idempotency replay, unavailable rooms, and source injection.
- Legacy and target consumer slices must expose every stay to calendar, detail,
  check-in and guest communication before browser verification.
- UI implementation cannot weaken backend validation or compute authoritative
  prices/totals in the browser.

## References

- VAY-647, VAY-648, VAY-1043, VAY-1092, VAY-1121, VAY-1183, VAY-1184,
  VAY-1186, VAY-1187 and VAY-1188.
- [`pms-operations-route-contracts.md`](pms-operations-route-contracts.md)
- VAY-1121 draft `engineering/pms-financials-contracts.md` in
  [PR #705](https://github.com/vayada-marketplace/vayada/pull/705)
- [`booking-pms-domain-boundaries.md`](booking-pms-domain-boundaries.md)
- [`pms-reservation-integration-contract.md`](pms-reservation-integration-contract.md)
