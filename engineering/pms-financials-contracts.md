# PMS Financials v1 contracts and reset boundary

_VAY-1121 decision record for VAY-1092. This document supersedes the Financial
summary, Invoices and Payments presentation sections of
[`finance-route-contracts.md`](finance-route-contracts.md). Payment settings,
provider onboarding, payment facts, payouts and reconciliation remain governed
by that contract._

## Decision

PMS Financials is rebuilt as a new Finance-owned product surface. The existing
TypeScript summary, synthetic invoice, invoice CSV, invoice-scoped manual
payment and PMS payment-ledger presentation are removed before replacement
implementation. Existing payment data and operational Finance capabilities are
preserved.

The replacement contract version is `pms-financials.v1`. Canonical routes live
under `/api/finance/properties/:propertyId/financials`. They do not reuse the old
paths because real invoices and recognized revenue are not compatible with
booking-derived invoice rows or payment-timing summaries. AI Insights remains
out of scope for v1.

## Current state

- PMS Web has an unavailable page, an unsupported service and four dormant
  Financials components.
- The API's summary, invoice and payment-list routes synthesize invoice identity,
  state and a `Stay` line from booking/payment data.
- `finance.finance_visibility_read_model` summarizes payments and payouts. It is
  not a revenue/expense ledger, and the target schema has no expense or real
  invoice aggregates.
- `FINANCE_SOURCE` defaults to `legacy`; target Finance routes are registered
  only when configured. Legacy Python remains untouched.

## Ownership

| Fact or behavior                                            | Canonical owner                           | Financials consumption                                 |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Property pricing currency                                   | PMS                                       | Read-only property context                             |
| Property timezone and locale                                | Hotel Catalog/Identity                    | Calendar and presentation context                      |
| Booking lifecycle, stay dates, nightly charges and source   | Booking, with PMS operational projections | Versioned revenue evidence                             |
| Add-on definitions, purchases and economic snapshots        | Booking                                   | Own revenue or partner commission evidence             |
| OTA channel mapping                                         | Distribution/Booking                      | Canonical channel attribution                          |
| OTA, platform and partner commission rules                  | Finance                                   | Effective-dated rule snapshots                         |
| Payments, provider fees and refunds                         | Finance                                   | Settlement and fee evidence; not the room-revenue date |
| Expense categories, rules and expense instances             | Finance                                   | Authoritative expense ledger                           |
| Operational folios, revisions, lines and payment references | Finance                                   | Operational evidence; official invoice stays external  |
| Rooms, room types and occupied nights                       | PMS                                       | Room-type and per-occupied-night reporting             |
| Documents, email jobs, audit and dead letters               | Platform services with Finance handlers   | Durable side effects and evidence                      |

Finance application services consume typed projections from Booking and PMS.
New route adapters must not add unrestricted cross-domain SQL as the permanent
integration boundary.

## Financial rules

### Property time and currency

- Calendar dates use the property's IANA timezone. Transport timestamps remain
  ISO-8601 UTC.
- The single reporting currency is `pms.property_pricing_settings.currency`.
- Every stored monetary fact retains its currency. V1 performs no implicit FX
  conversion. A mismatched historical fact is excluded from totals and returned
  as an explicit incomplete-evidence count and amount by currency.
- API money and percentage values are decimal strings. The frontend formats
  them with the property's locale and currency; neither the API nor UI may
  hardcode a symbol.
- Rounding occurs at an economic line boundary using currency minor units.
  Aggregates sum rounded lines and never use binary floating point.

### Revenue recognition

- Room revenue is recognized per occupied service night, not when a booking is
  created, paid or checked in. `Revenue Today` therefore means the room amount
  for today's occupied nights plus extras recognized today. Check-in count is
  display context, not the recognition basis.
- Canceled nights are excluded. A retained cancellation/no-show charge is
  recognized only when a typed adjustment fact exists.
- Property-owned add-ons recognize full gross on their fulfillment date.
  Partner add-ons recognize only the snapshotted property commission.
- If an add-on has no fulfillment date, the linked stay date is used and marked
  `inferred`; purchase date is the final fallback and is also marked `inferred`.
- Gross room revenue is before OTA commission. OTA commission is an expense,
  so P&L does not subtract it twice. Net room revenue is a Revenue-tab metric:
  gross room revenue minus OTA commission.
- Refunds and corrections create dated adjustment evidence; they do not silently
  rewrite a closed historical period.
- ADR is recognized room revenue divided by occupied room-nights. Attach rate is
  bookings with at least one fulfilled add-on divided by eligible bookings.

### Period comparisons

- Today compares with the same property-local weekday seven days earlier.
- MTD compares elapsed days with the same ordinal span of the prior month,
  capped at that month's end.
- An arbitrary range compares with the immediately preceding equal-length range.
- YTD compares with the same property-local dates in the prior year.
- Percentage change is `null` when the comparison denominator is zero. Absolute
  values are still returned.

### OTA commission rules

- Canonical OTA keys are `booking_com`, `airbnb`, `expedia`, `agoda` and
  `other_ota`, aligned with Booking attribution.
- Finance owns property-scoped percentage rule versions. Rates are decimal
  strings from 0 through 100 with at most four fractional digits.
- Effective windows are half-open `[startsAt, endsAt)` and cannot overlap for
  one property/channel. A boundary where one version ends and another starts is
  valid.
- Resolution returns one applied rule identity/rate or explicit missing
  evidence. It never substitutes a default rate.
- Reporting consumes an immutable applied snapshot; changing a rule does not
  reprice historical reservation economics.

### Expenses

- Categories are property scoped. Defaults have stable system keys while their
  display names, colors and order may be customized.
- Categories referenced by history are archived, not deleted. System categories
  used by automation cannot be archived while an active rule needs them.
- Expense origins are `manual`, `recurring`, `ota_commission`, `platform_fee`
  and `supplier_bill`. Paid state is separate from origin.
- Every expense has an immutable accounting date, `incurredOn`; `paidOn` records
  settlement only. Manual and supplier expenses require their service/invoice
  date, recurring instances use the occurrence date, provider fees use the
  provider evidence date, and OTA commission follows the associated room
  revenue service night.
- A recurring rule generates one instance per due occurrence. Upcoming reads
  project the next occurrence; they do not pre-create an unbounded future ledger.
- Editing a recurrence affects future occurrences only. Disabling it leaves
  history unchanged.
- Generated expenses have a stable source key. Replays update no second row.
  Source correction or cancellation records a correction/reversal and preserves
  audit history instead of hard deleting the original.
- Corrections use their own `incurredOn` and reference the reversed expense.
  They do not rewrite a closed prior accounting period.
- Provider fees are recorded only from provider evidence. Missing fees are
  reported as incomplete evidence and are never estimated silently.

### Folios and accounting handoff

Vayada owns normalized operational folios and CSV handoff; a property or its
accountant owns official invoices outside Vayada. VAY-1240 replaces all local
official numbering, lifecycle, document and delivery rules through
[`pms-financials-external-invoice-contract.md`](pms-financials-external-invoice-contract.md).

## HTTP contract

### Typed request and response shapes

<!-- prettier-ignore -->
```ts
type Date = string; type Decimal = string; type Ratio = Decimal; // date: YYYY-MM-DD; ratio: 0..1
type Money = { amount: Decimal; currency: string }; type Page<T> = { items: T[]; nextCursor: string | null; limit: number };
type ExpenseOrigin = "manual" | "recurring" | "ota_commission" | "platform_fee" | "supplier_bill";
type ExpensePayment = { paymentStatus: "paid"; paidOn: Date } | { paymentStatus: "unpaid"; paidOn: null };
type ExpensePaymentWrite = { paymentStatus: "paid"; paidOn: Date } | { paymentStatus: "unpaid"; paidOn?: null };
type ExpenseSettlementPatch = ExpensePaymentWrite | { paymentStatus?: never; paidOn?: never };
type MoneyMetric = { value: Money; absoluteChange: Money; percentChange: Ratio | null };
type CountMetric = { value: number; absoluteChange: number; percentChange: Ratio | null };
type Envelope = { contractVersion: "pms-financials.v1"; propertyId: string; currency: string;
  timeZone: string; generatedAt: string; sourceFreshness: Record<string, string>;
  incompleteEvidence: Array<{ code: string; count: number; amount?: Money }> };
type Command = { commandId: string; idempotencyKey: string; expectedRevision?: number };
type Range = { from: Date; to: Date }; type Cursor = { cursor?: string; limit?: number };
type DashboardQuery = { asOf?: Date }; type RevenueQuery = Range;
type ExpenseQuery = Range & Cursor & { categoryId?: string; paymentStatus?: "paid" | "unpaid"; recurring?: boolean;
  origin?: ExpenseOrigin; search?: string; sort?: "incurredOn_desc" | "amount_desc" };
type ProfitLossQuery = { year: number };
type FolioState = "draft" | "ready" | "superseded" | "archived";
type FolioQuery = Cursor & { from?: Date; to?: Date; state?: FolioState; search?: string;
  sort?: "createdAt_desc" | "serviceFrom_desc" | "amount_desc" };
type FolioExportQuery = Omit<FolioQuery, "state"> & { state: "ready" };
type Category = { id: string; systemKey: string | null; name: string; color: string; sortOrder: number; archived: boolean; revision: number };
type Expense = { id: string; categoryId: string; origin: ExpenseOrigin; incurredOn: Date; vendor: string; amount: Money;
  recurringRuleId: string | null; sourceKey: string | null; reversesExpenseId: string | null; revision: number } & ExpensePayment;
type RecurringRule = { id: string; categoryId: string; vendor: string; amount: Money; notes?: string;
  paymentStatus: "paid" | "unpaid"; cadence: "weekly" | "monthly" | "yearly"; startsOn: Date;
  nextDueOn: Date; endsOn: Date | null; active: boolean; revision: number };
type CategoryWrite = Command & { name: string; color: string; sortOrder: number }; type CategoryPatch = Command & Partial<Pick<Category, "name" | "color" | "sortOrder">>;
type ExpenseWrite = Command & { incurredOn: Date; vendor: string; categoryId: string; amount: Money; notes?: string;
  supplierInvoiceNumber?: string; recurrence?: { cadence: "weekly" | "monthly" | "yearly"; startsOn: Date; endsOn?: Date } } & ExpensePaymentWrite;
type ExpensePatch = Command & Partial<Omit<ExpenseWrite, keyof Command | "recurrence" | keyof ExpensePaymentWrite>> & ExpenseSettlementPatch;
type RecurrencePatch = Command & Partial<Pick<RecurringRule,
  "categoryId" | "vendor" | "amount" | "notes" | "paymentStatus" | "cadence" | "nextDueOn" | "endsOn">>;
type ExportWrite = Command & ({ tab: "dashboard"; filters: DashboardQuery } |
  { tab: "revenue"; filters: RevenueQuery } | { tab: "expenses"; filters: ExpenseQuery } |
  { tab: "profit_loss"; filters: ProfitLossQuery } | { tab: "folios"; filters: FolioExportQuery }) &
  { format: "csv" };
type Disposition = { resourceId: string } & (
  { state: "pending" | "failed"; downloadUrl?: never; expiresAt?: never } |
  { state: "ready"; downloadUrl: string; expiresAt: string });
type DashboardResponse = Envelope & { cards: { revenueToday: MoneyMetric; revenueMtd: MoneyMetric;
  expensesMtd: MoneyMetric; profitMtd: MoneyMetric };
  daily: Array<{ date: Date; revenue: Money; expenses: Money }>;
  upcoming: Array<{ date: Date; kind: string; amount: Money; predicted: boolean }> };
type RevenueResponse = Envelope & { summary: { grossRoom: MoneyMetric; otaCommission: MoneyMetric; netRoom: MoneyMetric;
  upsell: MoneyMetric; nights: CountMetric; adr: MoneyMetric; attachRate: { value: Ratio; absoluteChange: Decimal; percentChange: Ratio | null } };
  channels: Array<{ channel: string; gross: Money; commission: Money; net: Money; share: Ratio }>;
  directSources: Array<{ source: string; revenue: Money; share: Ratio }>;
  upsells: Array<{ ownership: "property" | "partner"; revenue: Money }>;
  roomTypes: Array<{ roomTypeId: string; nights: number; revenue: Money; adr: Money }> };
type ExpensesResponse = Envelope & { summary: { totalMtd: MoneyMetric; perOccupiedNight: MoneyMetric;
  unpaidAmount: MoneyMetric; unpaidCount: CountMetric };
  categories: Array<{ category: Category; amount: Money }>; page: Page<Expense> };
type ProfitLossResponse = Envelope & { summary: { revenueYtd: MoneyMetric; expensesYtd: MoneyMetric; netProfitYtd: MoneyMetric };
  months: Array<{ month: string; revenue: Money; expenses: Money; netProfit: Money;
  expenseCategories: Record<string, Money> }> };
type FolioSummary = { folioId: string; bookingId: string | null; revision: number; state: FolioState;
  serviceFrom: Date; serviceTo: Date; total: Money; createdAt: string };
type FolioListResponse = Envelope & { page: Page<FolioSummary> };
type ItemResponse<T> = Envelope & { item: T }; type CommandResponse<T> = ItemResponse<T> & { outcome: "created" | "updated" | "replayed" };
type CommandReceipt = { contractVersion: "pms-financials.v1"; propertyId: string; resourceId: string;
  outcome: "created" | "updated" | "replayed" }; type WriteResponse<T> = CommandResponse<T> | CommandReceipt;
```

`from`/`to` are inclusive. Invalid ranges return `400`. Cursors are opaque,
base64url/versioned filter snapshots; limit defaults to 50 and caps at 200.
Expense order is `incurredOn DESC, id ASC`; folio order is the requested sort
then `id ASC`. All writes use server audit context. Export filters must exactly
match the named tab's query type after normalization; unknown keys return `400`.

### Canonical routes

| Method             | Path after `/api/finance/properties/:propertyId/financials` | Request → response                                                              |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET`              | `/dashboard`                                                | `DashboardQuery` → `DashboardResponse`                                          |
| `GET`              | `/revenue`                                                  | `RevenueQuery` → `RevenueResponse`                                              |
| `GET/POST`         | `/expense-categories`                                       | none / `CategoryWrite` → `ItemResponse<Category[]>` / `WriteResponse<Category>` |
| `PATCH/DELETE`     | `/expense-categories/:categoryId`                           | `CategoryPatch` / `Command` → `WriteResponse<Category>`                         |
| `GET/POST`         | `/expenses`                                                 | `ExpenseQuery` / `ExpenseWrite` → conditional response; see below               |
| `GET/PATCH/DELETE` | `/expenses/:expenseId`                                      | none / `ExpensePatch` / `Command` → item / `WriteResponse<Expense>`             |
| `GET/PATCH/DELETE` | `/recurring-expenses/:ruleId`                               | none / `RecurrencePatch` / `Command` → item / `WriteResponse<RecurringRule>`    |
| `GET`              | `/profit-loss`                                              | `ProfitLossQuery` → `ProfitLossResponse`                                        |
| See VAY-1240       | `/folios` and `/folios/:folioId/*`                          | Operational folio list, revision, ready and archive contracts                   |
| `POST/GET`         | `/exports` / `/exports/:exportId`                           | `ExportWrite` / none → `CommandResponse<Disposition>` / item response           |

V1 exports CSV for all five tabs. It does not create, retrieve, render, or send
an official invoice document and does not promise PDF renditions.

`POST /expenses` returns `WriteResponse<Expense>` without `recurrence`. With `recurrence`, it creates and returns only a `WriteResponse<RecurringRule>`; VAY-1232 owns future expense generation, and no current expense is created because no atomic expense-and-rule coordinator exists.

P&L is computed from ledger/evidence rows; no second source-of-truth table is
introduced.

### Authorization and errors

- Reads and both export routes require `pms.finance.read`; other writes require
  `pms.finance.manage`. All require active PMS `property-management` and `module:financials`
  entitlements for the selected property.
- Allowed relationships are `owner` and `finance_manager`. A PMS Manager must be
  mapped to `finance_manager`; generic `operator`, `front_desk` and housekeeping
  relationships do not gain Financials access implicitly.
- `pms.finance.manage` does not imply read. VAY-1138 must grant
  `pms.finance.read` to `finance_manager` as an explicit migration before that
  relationship is activated. A resource-bearing `CommandResponse<T>` also
  requires read authorization; manage-only callers receive `CommandReceipt`.
- Route adapters call `enforceRoutePolicy` before reads, idempotency lookup or
  validation that could disclose property data.
- `401` means invalid/missing authentication. `403` covers permission,
  entitlement, module and property-link denial. `404` is used only after scope is
  authorized. `400` is malformed input; `409` is revision/idempotency/lifecycle
  conflict; `422` is a valid command blocked by currency or source evidence.
- Responses never contain provider secrets, raw provider payloads, bank account
  numbers, unrestricted object URLs or guest PII outside the authorized folio
  scope.

## Target storage and projections

VAY-1124 and VAY-1125 finalize DDL names. Required aggregates are expense
categories/instances/recurrences; folios/revisions/lines/payment references;
and source keys, revisions and correction state. Dashboard, Revenue and P&L
models are rebuildable projections, not a second ledger. Expense attachments
store protected Platform Media references, not blobs or public URLs.

## Reset inventory

### Delete in VAY-1122

From `apps/api/src/routes/finance.ts`:

- routes `/finance/properties/:propertyId/summary`, `/invoices`,
  `/invoices/export.csv`, `/invoices/:invoiceId`,
  `/invoices/:invoiceId/payments` and `/payments`;
- summary/invoice/payment-ledger row types, query parsers, empty responses,
  mappers and SQL loaders;
- `recordManualPayment` and its invoice-based idempotency, event, outbox, job,
  audit and persistence helpers; and
- these exact `apps/api/src/finance.test.ts` tests: `passes F1c invoice and
payment ledger fixture cases in target mode`; `passes the F1d manual payment
record fixture in target mode`; `replays the F1d manual payment idempotency key
without duplicate side effects`; `passes the F1d manual payment validation
rejection fixtures`; `rejects invalid target manual payment commands before
insert side effects`; `persists manual payment dedupe and platform side-effect
keys by property scope`; `enqueues final guest confirmation email for
bank-transfer manual payments`; `does not enqueue final guest confirmation
email for partial bank-transfer payments`; `returns financial summary with
source freshness from the Finance read model`; `returns a CSV export
disposition instead of streaming a legacy export`; and `supports invoice
search, sort, and pagination over the target read model`. Split
  `returns empty states for finance ledger reads without treating setup as an
error` so its payout and reconciliation assertions remain.

From `packages/domain-finance/src/index.ts`:

- `FinanceInvoice*`, `FinanceFinancialSummary*`, `FinancePaymentLedger*`,
  `FinanceInvoiceListQuery`, `FinancePaymentLedgerQuery`, invoice CSV types,
  `RecordManualInvoicePaymentPayload`, `FinanceManualPaymentRecord*` and their
  repository methods;
- `FINANCE_MANUAL_PAYMENT_SIDE_EFFECTS`, `FinanceManualPaymentSideEffect`, the
  manual-payment members of `FinanceCommand` and `financeCommandTypes`,
  `FinanceProjectionRefreshJob` and
  `buildManualPaymentProjectionJobIdempotencyKey`;
- from `packages/domain-finance/src/index.test.ts`, delete `describe("manual
payment record command")` and remove only the manual-payment expectation from
  `exports finance command types`; preserve the checkout-charge settlement tests;
- split or rename the remaining ledger repository so payout and reconciliation
  ports stay intact; and
- retain core payment status/method scalars when another Finance capability uses
  them.

Delete these exact fixture cases from
`engineering/fixtures/finance-route-contracts/cases.json`:
`invoice-list-read`, `invoice-detail-read`, `manual-payment-record-command`, its
`-idempotency-replay`, `-currency-mismatch`, `-overpayment`, `-no-balance`,
`-paid-invoice`, `-voided-invoice` and `-amount-out-of-range` cases,
`payment-ledger-read`, `financial-summary-read`, `invoice-export-disposition`,
`invoice-empty-state`, `invoice-search-sort-pagination` and
`payment-ledger-empty-state`. Retarget the two `authorization-denial-matrix-*`
fixtures to a preserved protected Finance route; they test shared authorization
and must not be deleted.

The removed routes are not kept as fake empty or compatibility responses. Before
the replacement is active they return the normal unregistered `404`.

### Delete in VAY-1123

- `apps/pms-web/services/financials/index.ts`;
- `apps/pms-web/components/financials/InvoicesTab.tsx`, `PaymentsTab.tsx`,
  `InvoiceDetailModal.tsx` and `RecordPaymentModal.tsx`; and
- the contiguous `financials.title` through `financials.recordError` key range
  from `apps/pms-web/messages/{de,en,es,fr,id,it,ja,nl,ru,zh}.json`. Preserve
  `layout.sidebar.financials` for the unavailable route.

Keep the unavailable route page and keep `financials` hidden in Feature Hub
until VAY-1138 activates the replacement.

### Preserve

Preserve payment/provider/payout/commission/entitlement rows and migrations;
settings, cancellation, onboarding, payout, reconciliation and payment-capability
routes; readiness/dispatch/checkout, Booking and affiliate consumers; platform
idempotency, event, job and audit infrastructure; and legacy Python Financials.

No reset ticket drops a Finance table, deletes production data, changes provider
credentials or disables payment/payout jobs.

## Backfill, activation and rollback

1. Land this contract, then remove the inactive TypeScript/frontend surface.
2. Add target schema and cross-domain projections behind no active UI.
3. Backfill recognized revenue from available stay/add-on evidence. Preserve
   unknown channel, commission and currency evidence as explicit exceptions;
   do not synthesize invoices, payments or allocations from bookings.
4. Seed default categories; do not invent historical manual expenses. Backfill
   OTA commissions only where an effective rate snapshot is provable.
5. Reconcile totals, counts, source exceptions, immutable folio revisions and
   generated expense idempotency in rehearsals.
6. Ship new routes and UI while `module:financials` remains inactive by default.
7. Activate per property only after permission, migration, API, export and
   browser gates pass.

Rollback deactivates the module and reverts application traffic. It does not
delete new ledger rows or repeat successful exports blindly. Export job keys
remain stable across retries or rollback.

## Validation gates

- Migrations pass from empty and upgraded databases; financial fixtures reconcile
  by property/date/currency and expose missing evidence.
- Generated expenses pass replay, concurrency, correction and cancellation tests.
- Folios pass property isolation, revision sequencing, total integrity,
  correction, replay, archive and accounting-export tests.
- Every protected route passes the full authorization and inactive-module matrix.
- CSV exports match normalized filters and neutralize spreadsheet formulas.
- Preserved Finance/payment/affiliate suites remain green after reset/activation.
- PMS Web build, lint, accessibility checks and the Financials browser golden
  path pass in an activated-property fixture.
