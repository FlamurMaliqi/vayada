# PMS calendar auto-open contract

Status: canonical VAY-1432 target contract (`pms-calendar-auto-open.v1`).

DDL, routes, UI, jobs, provider calls, and migration belong to later VAY-624
slices.

## Ownership

| Concern                                                               | Owner                    | Contract                                                               |
| --------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| Auto-open setting and execution                                       | PMS                      | One revisioned setting per property                                    |
| Property timezone                                                     | Hotel Catalog            | PMS reads it through a typed property-profile port                     |
| Operating periods, room capacity, manual limits, blocks, and bookings | PMS                      | Existing canonical inventory contracts remain authoritative            |
| Base and recurring rates                                              | PMS Pricing              | Auto-open reads revisioned pricing sources; it does not copy prices    |
| Booking Engine availability                                           | Distribution             | Reads projected PMS inventory and pricing, never this setting directly |
| OTA availability                                                      | PMS channel connectivity | Consumes ARI-change work generated from canonical PMS inventory        |

Auto-open applies to a property whether or not it has a Channex connection.
Booking and Channex must not store their own auto-open policy or calculate a
second horizon.

## Canonical setting

```ts
type PmsCalendarAutoOpenSetting = {
  contractVersion: "pms-calendar-auto-open.v1";
  propertyId: string;
  revision: number;
  enabled: boolean;
  mode: "rolling" | "fixed";
  rollingMonths: 12 | 18 | 24 | null;
  fixedEndMonth: `${number}-${number}` | null; // canonical YYYY-MM
  updatedAt: string;
};
```

- rolling mode requires one of `12`, `18`, or `24` and requires
  `fixedEndMonth = null`;
- fixed mode requires a real `YYYY-MM` month and requires
  `rollingMonths = null`; an update may not choose a past local month, but a
  stored fixed month remains valid after time passes;
- disabling retains the selected mode and parameter so re-enabling is
  predictable;
- stored `revision` is a positive, monotonically increasing integer;
- an absent row has the virtual read value `revision = 0`, `enabled = false`,
  rolling mode, `rollingMonths = 18`, and no fixed month. It causes no writes or
  jobs until explicitly saved.

Updates use compare-and-set with `expectedRevision`. A successful changed
update advances the revision once. An exact idempotency replay returns the
original result without another setting change, job, event, or audit record.

## Horizon calculation

The read and execution result exposes `propertyLocalDate` (`YYYY-MM-DD`),
canonical IANA `propertyTimeZone`, nullable `targetOpenThrough` (`YYYY-MM-DD`),
and nullable `generatedCoverageThrough` from PMS materialization evidence.

Calculate `propertyLocalDate` from the evaluation instant in the canonical
property timezone. Do not add UTC milliseconds or use the worker timezone.

- disabled: `targetOpenThrough = null`;
- rolling: add `rollingMonths` calendar months to the current local month and
  return that target month's last local date;
- fixed: return the last local date of `fixedEndMonth`.

A fixed target already before `propertyLocalDate` is a valid historical
setting but creates no application job and closes nothing.

For example, 25 May 2026 plus 18 months is 30 November 2027. February uses the
actual calendar, including 29 February in a leap year. The far edge is always a
month end. Materialization starts at the current property-local date; past days
are not recreated.

`targetOpenThrough` is an extension target, not a public-booking maximum.
Reducing the rolling preset, moving a fixed month earlier, switching modes, or
disabling the setting never closes dates that are already open. Therefore
`generatedCoverageThrough` may be later than the current target. Distribution
and channel sync use actual canonical availability, not the setting as a hard
date-picker cap.

This additive rule follows the locked VAY-506 behavior and supersedes the
conflicting shrink example in VAY-624.

## Applying the target

An enabled evaluation extends canonical `pms.inventory_days` through
`max(targetOpenThrough, generatedCoverageThrough)`. It reuses the existing PMS
operating-calendar and inventory materialization contracts instead of adding a
parallel availability store.

The logical evaluation may span more than the current 366-day materialization
bound, especially because fixed mode has no artificial maximum month. The
implementation processes bounded internal batches while exposing one
continuous coverage result. A partial batch must not be reported as complete.

For every property, room type, and candidate date:

- operating periods determine generated `open` or `closed` status;
- manual sellable limits outrank channel and generated limits;
- manual day-level opens or closes, linked stop-sell, blocks, assigned bookings,
  and their source revisions are never reset by auto-open;
- existing bookings are never moved or cancelled;
- a new generated limit is bounded by physical room capacity;
- repeat evaluation with unchanged owner revisions makes no inventory change.

Existing precedence is manual limit > channel limit > generated limit.
Availability is zero when operating-closed or linked-stop-sell; otherwise it is
`max(0, effective limit - assigned - blocked)`.

## Rate safety and warnings

Auto-open resolves the current positive sellable rate from canonical PMS
Pricing for each in-period room/date. It never invents or copies a price.

If no positive rate resolves, the inventory day may be materialized for
operational continuity, but its generated sellable limit is `0`. Booking and
channel projections also apply rate eligibility as an orthogonal gate: missing
rate means projected availability `0` even when a preserved manual or channel
limit is higher than the generated limit. The gate never rewrites those owner
values. A later `pms.pricing_source.changed` revision re-enqueues evaluation
and may lift the generated limit without changing manual, block, or booking
state.

A rate-eligibility transition is a changed room/date range even when the
inventory row's effective count is unchanged. It emits projection-refresh and
ARI work. `unchanged` means neither inventory fields nor projected rate
eligibility changed.

Warnings are derived, not stored policy copies. Their exact shape is
`{ code: "missing_rate"; roomTypeId: string; from: string; through: string }`,
with dates in `YYYY-MM-DD`.

Adjacent missing-rate dates for the same room type are coalesced. The UI may
group complete calendar-month ranges into the VAY-506 message, but API fields
remain machine-readable. Missing rates produce a successful partial result
with warnings; they never produce zero-priced or price-less sellable ARI.

Invalid timezone, stale source revisions, inventory invariant violations, and
write failures are errors, not warnings. They fail closed and remain retryable
where the underlying error is transient.

## Triggers and execution

A changed setting commits, in one transaction, the setting revision, product
audit, and `pms.calendar_auto_open.setting_changed` domain event. Its event key
is `pms.calendar-auto-open.setting:<propertyId>:revision-<revision>:v1` and its
payload carries only property id, revision, enabled state, and mode. An enabled
setting with a non-expired target also commits a durable job-enqueue outbox
intent; a disabled or expired fixed setting does not create application work.
Provider calls do not occur in that transaction. Eligible saves run
immediately; the host does not wait for the recurring scheduler.

The PMS-owned scheduler runs at least daily and paginates every enabled
property, including PMS-only and Booking-only properties. It recalculates the
property-local month boundary and enqueues only when the target or an owner
source revision is not reflected in current materialization. One property's
failure cannot stop later properties. Fixed policies do not advance with time,
but pricing, calendar, room-set, or explicit setting changes may re-evaluate
their unchanged future target. The scheduler skips an expired fixed target
regardless of source changes until the setting moves forward.

Before writing, a worker rereads the setting and owner revisions under the PMS
property guard. A disabled setting or stale source fingerprint completes as an
`unchanged` no-op with no inventory or projection/ARI write.

The application job uses the PMS-owned `pms.inventory.scheduler` queue, not the
Channex provider queue. The canonical source object's keys, in order, are
`contractVersion` (`pms-calendar-auto-open-source.v1`), `settingRevision`,
`propertyProfileRevision`, `propertyTimeZone`, `operatingCalendarRevision`,
`rooms`, and `pricing`. Each exact room entry is `{ roomTypeId,
roomFactsRevision, roomUnitsRevision }`; pricing's ordered keys are
`pricingCurrencyRevision`, `flexibleRatePlans`, and
`optionalPricingAggregateRevision`, with exact plan entries `{ roomTypeId,
flexibleRatePlanRevision }`.

Sort both arrays by `roomTypeId` in ascending Unicode code-unit order. Serialize
keys in the stated order with `JSON.stringify`, SHA-256 the UTF-8 bytes, and use
lowercase hex. Inventory output revisions are excluded to prevent an enqueue
loop.

```text
domain event:
pms.calendar-auto-open:<propertyId>:<openThrough>:source-<sourceFingerprint>:v2

job:
pms.calendar-auto-open:property:<propertyId>:open-through-<openThrough>:source-<sourceFingerprint>:v2
```

Exact duplicate evaluations reuse the job and event. A source change at the
same fixed horizon creates new work; the old horizon-only `v1` key could not.

When inventory or rate-gate ranges change, the job succeeds only after canonical inventory, audit
evidence, and the `pms.inventory.projection_refresh_requested` outbox intent
commit. An `unchanged` job commits its audit/result without projection or ARI
work. Distribution publishes changed effective inventory to the Booking Engine,
and changed room/date ranges produce the existing `pms.inventory.ari_changed`
work for channel connectivity. Channex retry/dead-letter behavior remains owned
by its adapter; no connection is required for the PMS/Booking result to succeed.

## Audit and observable result

Setting audits record the user actor, property, previous and next revision,
enabled state, mode, parameter, request/correlation ids, and timestamp.
Application audits record the system actor, source fingerprint, evaluated
horizon, changed-day count, warning count, inventory materialization revision,
and linked outbox/job ids. They contain no prices or provider credentials.

An execution reports `applied`, `partial`, or `unchanged`. `partial` means
canonical rows reached the requested coverage but one or more dates remain
non-sellable with `missing_rate` warnings. A retry or duplicate must not inflate
changed-day counts or emit duplicate projection/ARI work.

The executable examples are in
[`fixtures/pms-calendar-auto-open/cases.json`](fixtures/pms-calendar-auto-open/cases.json).
