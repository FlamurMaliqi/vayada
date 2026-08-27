# Finance route contracts

> **PMS Financials reset:** VAY-1121 supersedes this document's financial
> summary, synthetic invoice, invoice CSV, invoice-scoped manual payment and PMS
> payment-ledger presentation contracts. See
> [`pms-financials-contracts.md`](pms-financials-contracts.md). Payment settings,
> provider onboarding, payment facts, payouts and reconciliation remain active;
> superseded route rows below are historical compatibility references only.

_VAY-795 contract record. Covers F1 from
[`booking-pms-route-migration-inventory.md`](booking-pms-route-migration-inventory.md)
against the finance target schema from VAY-673
(`packages/backend-migration/migrations/0007_finance.sql`)._

## Purpose

This document defines the finance route contracts and migration slices required
before implementation tickets port the remaining finance surfaces from legacy
`apps/pms-api` to `apps/api`.

The scope is:

- payment settings and cancellation policy used by PMS Web and Booking checkout;
- invoices, manual payments, payment ledger reads, and CSV export;
- property and affiliate payouts;
- Stripe Connect and Xendit onboarding;
- payment, payout, and provider-account reconciliation views;
- the F1a bridge between PMS checkout-charge `mark-paid` and Finance settlement;
- legacy payout scheduler dispositions and rehearsal freeze rules.

This is planning-only. Python PMS remains production source of truth until each
slice has an accepted TypeScript route, typed frontend client or compatibility
adapter, contract fixtures, parity checks, and rehearsal sign-off.

## Contract Version

Every JSON response and command result carries:

```ts
type FinanceRouteContractVersion = "finance-route-contracts.v1";
```

Breaking changes require a new version. Additive fields are allowed only after
they are documented here and covered by fixtures.

## Ownership

| Surface                                                                                                                                         | Target owner                                               | Notes                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Provider accounts, payment settings, payout settings, payments, payouts, commission rules, billing entitlements, finance visibility read models | Finance (`domain-finance`)                                 | Backed by `finance.*` target tables.                                                                                      |
| Public checkout payment capability projection                                                                                                   | Finance source, Booking/distribution facade                | Public responses may expose enabled methods and policy summaries only. No provider account IDs, bank details, or secrets. |
| PMS checkout charge operational state                                                                                                           | PMS operations (`domain-pms`)                              | PMS owns create/waive/mark-paid operational status, not settlement or provider effects.                                   |
| Guest booking lifecycle and guest PII                                                                                                           | Booking/checkout (`domain-booking`)                        | Finance links to `guestBookingId`; Booking owns booking status and guest PII validation/retention.                        |
| Affiliate identity, referral code, public registration, attribution                                                                             | Marketplace/affiliate                                      | Per VAY-768 and VAY-774, Booking Web affiliate routes are facades. Finance owns Stripe/Xendit payout onboarding only.     |
| Affiliate payout accounts, payout ledger, payout dispatch                                                                                       | Finance with marketplace/affiliate resource links          | Marketplace/affiliate supplies affiliate identity/resource ownership. Finance owns provider account and settlement state. |
| Provider webhook receipts, jobs, retries, dead letters, audit                                                                                   | `backend-events` and `backend-audit` with Finance handlers | Follows `jobs-events-contract.md` and `channex-webhook-cutover-plan.md`.                                                  |

Finance routes must not open legacy Booking, PMS, or Marketplace database pools
as normal runtime integration. Temporary compatibility adapters may map target
`propertyId`, `organizationId`, or `affiliateId` to legacy IDs during a slice,
but route contracts use canonical target IDs and do not expose legacy table
names.

## Authorization

All protected routes must use `enforceRoutePolicy` at the route boundary.

| Route family                  | Permission                 | Entitlement                                                                   | Resource link                                                         | Allowed relationships                  |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Property finance reads        | `pms.finance.read`         | active `pms:property-management` or active direct-booking finance entitlement | `pms_property` or canonical `property` with `resourceId = propertyId` | `owner`, `operator`, `finance_manager` |
| Property finance writes       | `pms.finance.manage`       | active finance-capable property entitlement                                   | `pms_property` or canonical `property` with `resourceId = propertyId` | `owner`, `finance_manager`             |
| Property onboarding           | `pms.finance.manage`       | active finance-capable property entitlement                                   | `pms_property` or canonical `property` with `resourceId = propertyId` | `owner`, `finance_manager`             |
| Affiliate payout reads/writes | `affiliate.payout.manage`  | active affiliate entitlement                                                  | `affiliate` with `resourceId = affiliateId`                           | `owner`, `finance_manager`             |
| Platform finance reads        | `platform.finance.read`    | active platform entitlement                                                   | platform organization scope                                           | `platform_admin`, `finance_manager`    |
| Platform finance writes       | `platform.finance.manage`  | active `platform:finance-admin` entitlement                                   | `platform:platform:vayada`                                            | `platform_admin`, `finance_manager`    |
| Marketplace finance reads     | `marketplace.finance.read` | active marketplace entitlement                                                | marketplace organization scope                                        | `owner`, `finance_manager`             |

Public Booking Web payment capability routes are not admin finance routes. They
must use public hotel/profile resolution, expose only public-safe payment
capability fields, and must not include provider account IDs, bank account
details, payout status, fee breakdowns, or private cancellation notes.

Authentication failures return `401`. Permission, entitlement, inactive
entitlement, and resource-link failures return `403`. A valid property with no
finance setup returns a successful setup-incomplete shape unless the command
requires a configured provider.

## Shared Scalars

```ts
type FinanceDate = string; // YYYY-MM-DD
type FinanceUtcDateTime = string; // ISO-8601 UTC with trailing Z
type FinanceDecimalAmount = string; // major-unit decimal string
type FinanceCurrencyCode = string; // ISO-4217 uppercase
type FinanceContractVersion = "finance-route-contracts.v1";
```

Money values are decimal strings in this contract, even when legacy Python
surfaces returned JSON numbers. Provider IDs are returned only on permissioned
admin finance routes. Bank account numbers, IBAN, SWIFT, tokens, signing
secrets, and provider secret refs are never returned.

## Canonical Route Families

Canonical target routes live under `/api/finance`. Existing PMS Web and Booking
Web adapters may expose compatibility paths while frontends migrate, but those
facades must call the Finance-owned route/service contract.

| Surface                           | Method      | Canonical path                                                                              | Compatibility facade                                                                               |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Payment settings                  | `GET/PATCH` | `/api/finance/properties/:propertyId/payment-settings`                                      | `/api/pms/properties/:propertyId/payment-settings`, public Booking Web capability read             |
| Cancellation policy               | `GET/PATCH` | `/api/finance/properties/:propertyId/cancellation-policy`                                   | bundled in legacy PMS payment-settings response during migration                                   |
| Financial summary                 | `GET`       | `/api/finance/properties/:propertyId/summary`                                               | `/api/pms/properties/:propertyId/financials/summary`                                               |
| Invoices list                     | `GET`       | `/api/finance/properties/:propertyId/invoices`                                              | `/api/pms/properties/:propertyId/financials/invoices`                                              |
| Invoice CSV export                | `GET`       | `/api/finance/properties/:propertyId/invoices/export.csv`                                   | PMS financials export facade                                                                       |
| Invoice detail                    | `GET`       | `/api/finance/properties/:propertyId/invoices/:invoiceId`                                   | legacy booking-id lookup facade                                                                    |
| Manual payment record             | `POST`      | `/api/finance/properties/:propertyId/invoices/:invoiceId/payments`                          | PMS record-payment modal facade                                                                    |
| Payment ledger                    | `GET`       | `/api/finance/properties/:propertyId/payments`                                              | `/api/pms/properties/:propertyId/financials/payments`                                              |
| Payouts                           | `GET`       | `/api/finance/properties/:propertyId/payouts`                                               | legacy `/admin/payouts` facade                                                                     |
| Affiliate payouts                 | `GET`       | `/api/finance/affiliates/:affiliateId/payouts`                                              | affiliate-dashboard payout ledger                                                                  |
| Platform affiliate payout list    | `GET`       | `/api/finance/platform/affiliate-payouts`                                                   | Platform Admin only; no legacy client                                                              |
| Platform affiliate payout detail  | `GET`       | `/api/finance/platform/affiliate-payouts/:affiliateId`                                      | Platform Admin only; requires `currency`                                                           |
| Platform affiliate mark paid      | `POST`      | `/api/finance/platform/affiliate-payouts/:affiliateId/mark-paid`                            | Platform Admin only; target Finance command                                                        |
| Stripe Connect property account   | `POST`      | `/api/finance/properties/:propertyId/provider-accounts/stripe`                              | legacy `/admin/stripe/connect-account` facade                                                      |
| Stripe Connect onboarding link    | `POST`      | `/api/finance/properties/:propertyId/provider-accounts/:providerAccountId/onboarding-link`  | legacy GET facade may call this command                                                            |
| Xendit bank validation            | `POST`      | `/api/finance/properties/:propertyId/provider-accounts/xendit/bank-validation`              | legacy `/admin/xendit/validate-bank-account` facade                                                |
| Xendit payout reconciliation      | `POST`      | `/api/finance/properties/:propertyId/reconciliation/xendit-payouts`                         | legacy manual reconcile facade                                                                     |
| Reconciliation views              | `GET`       | `/api/finance/properties/:propertyId/reconciliation/*`                                      | none required before F1 reads                                                                      |
| Affiliate payout provider account | `POST`      | `/api/finance/affiliates/:affiliateId/provider-accounts/stripe`                             | Booking Web public affiliate facade may call through finance after marketplace identity resolution |
| Affiliate onboarding link         | `POST`      | `/api/finance/affiliates/:affiliateId/provider-accounts/:providerAccountId/onboarding-link` | Booking Web public affiliate facade returns only `onboardingUrl`                                   |
| Affiliate payout settings         | `GET/PATCH` | `/api/finance/affiliates/:affiliateId/payout-settings`                                      | affiliate-dashboard route after AuthKit                                                            |

GET routes use `limit` and `offset` where list-like. `limit` defaults to `50`
and clamps to `[1, 500]`. Sort order must be stable and documented by fixture.

## Payment Settings And Cancellation Policy

`GET /api/finance/properties/:propertyId/payment-settings` returns:

```ts
type FinancePaymentSettingsResponse = {
  contractVersion: "finance-route-contracts.v1";
  propertyId: string;
  paymentSettings: {
    paymentsEnabled: boolean;
    paymentProvider: "stripe" | "xendit" | "vayada" | "manual" | "bank_transfer";
    acceptedMethods: Array<
      | "card"
      | "pay_at_property"
      | "xendit"
      | "cash"
      | "bank_transfer"
      | "manual_card"
      | "wallet"
      | "other"
    >;
    defaultCurrency: FinanceCurrencyCode;
    supportedCurrencies: FinanceCurrencyCode[];
    depositPolicy: Record<string, string | number | boolean | null>;
    refundPolicy: Record<string, string | number | boolean | null>;
    taxPolicy: Record<string, string | number | boolean | null>;
    statementDescriptor: string | null;
    requiresManualReview: boolean;
    providerAccount: {
      providerAccountId: string | null;
      provider: "stripe" | "xendit" | "vayada" | "manual" | "bank_transfer" | null;
      status: "setup_incomplete" | "pending" | "active" | "restricted" | "suspended" | "disabled";
      onboardingStatus: "not_started" | "invited" | "in_review" | "completed" | "requires_action";
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      capabilities: string[];
    };
    sourceFreshness: Record<string, string | number | boolean | null>;
  };
};
```

`PATCH /api/finance/properties/:propertyId/payment-settings` accepts
`commandId`, `idempotencyKey`, and a partial settings payload. Currency changes
must not inline-convert PMS room rates, booking amounts, add-on prices, or
payments in the route handler. If redenomination remains a product requirement,
the command must persist the setting change and enqueue explicit jobs with
audited idempotency keys. A partial failure cannot silently leave Booking and
PMS payment flags out of sync.

`GET/PATCH /api/finance/properties/:propertyId/cancellation-policy` owns the
finance-readable policy fields currently stored beside payment settings:

```ts
type CancellationPolicy = {
  freeCancellationDays: number;
  partialRefundPercent: number;
  refundMethod: "original_payment" | "manual_review" | "property_discretion";
  appliesTo: "direct_booking" | "all_guest_bookings";
  updatedAt: FinanceUtcDateTime;
};
```

Booking/checkout consumes a public-safe projection. PMS operational routes must
not duplicate or rewrite cancellation policy directly.

## Invoices And Payments

Invoices are finance read models over Booking guest bookings, PMS operational
context, and Finance payment rows. Booking remains the source for guest booking
lifecycle and guest PII; Finance owns invoice/payment presentation, manual
payment records, and settlement facts.

Invoice list query rules:

- `status` optional, one of `draft`, `sent`, `paid`, `partial`, `overdue`,
  `voided`;
- `search` optional, matching invoice number, booking reference, or permitted
  guest display fields;
- `sort` optional, one of `issuedAt`, `guest`, `amount`;
- `limit` and `offset` as above.

Representative read models:

<!-- prettier-ignore -->
```ts
type FinanceInvoiceListResponse = {
  contractVersion: "finance-route-contracts.v1";
  propertyId: string;
  invoices: FinanceInvoiceListItem[];
  total: number;
  counts: Record<"draft" | "sent" | "paid" | "partial" | "overdue" | "voided", number>;
  limit: number;
  offset: number;
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type FinanceInvoiceListItem = {
  invoiceId: string;
  invoiceNumber: string;
  guestBookingId: string;
  bookingReference: string;
  guest: { displayName: string; email: string | null };
  stay: {
    checkIn: FinanceDate;
    checkOut: FinanceDate;
    roomName: string | null;
    roomNumber: string | null;
  };
  currency: FinanceCurrencyCode;
  totalAmount: FinanceDecimalAmount;
  amountPaid: FinanceDecimalAmount;
  balanceDue: FinanceDecimalAmount;
  status: "draft" | "sent" | "paid" | "partial" | "overdue" | "voided";
  issuedAt: FinanceUtcDateTime;
};

type FinanceInvoiceDetail = FinanceInvoiceListItem & {
  guest: { displayName: string; email: string | null; phone: string | null };
  nights: number;
  charges: Array<{ description: string; detail: string; amount: FinanceDecimalAmount }>;
  payments: FinanceInvoicePayment[];
  subtotal: FinanceDecimalAmount;
};

type FinanceInvoicePayment = {
  paymentId: string;
  method:
    | "card"
    | "pay_at_property"
    | "cash"
    | "bank_transfer"
    | "manual_card"
    | "xendit"
    | "other";
  methodLabel: string;
  amount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  reference: string | null;
  status:
    | "requires_action"
    | "authorized"
    | "pending"
    | "paid"
    | "partially_refunded"
    | "refunded"
    | "failed"
    | "canceled"
    | "disputed";
  recordedAt: FinanceUtcDateTime;
};
```

`GET /api/finance/properties/:propertyId/payments` is the canonical payment
ledger. It is not an alias for invoice detail rows: it is a paginated finance
read model over `finance.payments`, provider receipts, manual records, and the
PMS checkout-charge settlement bridge. Query rules:

- `status` optional, one of `requires_action`, `authorized`, `pending`, `paid`,
  `partially_refunded`, `refunded`, `failed`, `canceled`, `disputed`;
- `provider` optional, one of `stripe`, `xendit`, `manual`,
  `bank_transfer`, `vayada`;
- `method` optional, matching `FinanceInvoicePayment.method`;
- `from`/`to` optional UTC date-time bounds over `recordedAt`;
- `search` optional, matching booking reference, invoice number, payment
  reference, or permitted guest display fields;
- stable ordering is `recordedAt DESC, paymentId ASC`.

```ts
type FinancePaymentLedgerResponse = {
  contractVersion: "finance-route-contracts.v1";
  propertyId: string;
  payments: FinancePaymentLedgerItem[];
  total: number;
  counts: Record<
    | "requires_action"
    | "authorized"
    | "pending"
    | "paid"
    | "partially_refunded"
    | "refunded"
    | "failed"
    | "canceled"
    | "disputed",
    number
  >;
  limit: number;
  offset: number;
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type FinancePaymentLedgerItem = FinanceInvoicePayment & {
  invoiceId: string | null;
  invoiceNumber: string | null;
  guestBookingId: string | null;
  bookingReference: string | null;
  checkoutChargeId: string | null;
  provider: "stripe" | "xendit" | "manual" | "bank_transfer" | "vayada";
  providerStatus: string | null;
  reconciliationStatus: "matched" | "pending" | "needs_review" | "dead_lettered";
};
```

The ledger must exclude raw provider payloads, card fingerprints, payment-intent
secrets, full guest PII, and processor fee internals unless a later
finance-admin-only export explicitly contracts those fields.

`POST /api/finance/properties/:propertyId/invoices/:invoiceId/payments` records
a manual property-side payment. It requires `commandId`, `idempotencyKey`,
`amount`, `currency`, `paymentMethod`, and optional `reference`. It creates or
updates a `finance.payments` row and emits finance audit/outbox events. It must
not call Stripe, Xendit, Channex, or Booking status commands inline. Booking
status updates, guest notifications, and PMS operational projections are
separate jobs or domain bridges with their own idempotency keys.

CSV export is a read-model/export job after invoice reads are target-owned. The
download route may synchronously stream an existing read model, but long export
generation must be a durable job.

## Payouts

Property and affiliate payouts are finance-owned. Payout reads must expose
provider status and retry/disposition state without returning destination
account numbers or provider secrets.

<!-- prettier-ignore -->
```ts
type FinancePayout = {
  payoutId: string;
  ownerScope: "property" | "organization" | "platform";
  propertyId: string | null;
  organizationId: string | null;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  paymentId: string | null;
  payoutStatus:
    | "pending"
    | "scheduled"
    | "processing"
    | "paid"
    | "failed"
    | "canceled"
    | "reversed";
  amount: FinanceDecimalAmount;
  feeAmount: FinanceDecimalAmount;
  netAmount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  provider: "stripe" | "xendit" | "manual" | "bank_transfer" | "vayada";
  providerPayoutId: string | null;
  scheduledAt: FinanceUtcDateTime | null;
  paidAt: FinanceUtcDateTime | null;
  failedAt: FinanceUtcDateTime | null;
  failureCode: string | null;
  retryCount: number;
};
```

Payout dispatch and polling must run through target jobs after the matching
legacy scheduler jobs are frozen. Route handlers may enqueue a target job but
must not send provider transfers inline.

Affiliate payout settings and payout reads are finance-owned after
Marketplace/affiliate resolves the affiliate resource. Marketplace/affiliate
remains the identity owner for referral codes, commission terms, and affiliate
profile fields; Finance owns provider account, destination validation, payout
schedule, tax/payment metadata, and settlement state.

```ts
type AffiliatePayoutSettingsResponse = {
  contractVersion: "finance-route-contracts.v1";
  affiliateId: string;
  marketplaceOrganizationId: string | null;
  payoutSettings: {
    payoutsEnabled: boolean;
    payoutProvider: "stripe" | "manual" | "bank_transfer";
    payoutCurrency: FinanceCurrencyCode;
    payoutSchedule: "manual" | "monthly" | "threshold";
    payoutThresholdAmount: FinanceDecimalAmount | null;
    providerAccount: {
      providerAccountId: string | null;
      provider: "stripe" | "manual" | "bank_transfer" | null;
      status: "setup_incomplete" | "pending" | "active" | "restricted" | "suspended" | "disabled";
      onboardingStatus: "not_started" | "invited" | "in_review" | "completed" | "requires_action";
      payoutsEnabled: boolean;
    };
    sourceFreshness: Record<string, string | number | boolean | null>;
  };
};

type AffiliatePayoutSettingsPatch = {
  commandId: string;
  idempotencyKey: string;
  payoutsEnabled?: boolean;
  payoutProvider?: "stripe" | "manual" | "bank_transfer";
  payoutCurrency?: FinanceCurrencyCode;
  payoutSchedule?: "manual" | "monthly" | "threshold";
  payoutThresholdAmount?: FinanceDecimalAmount | null;
};

type AffiliatePayoutLedgerResponse = {
  contractVersion: "finance-route-contracts.v1";
  affiliateId: string;
  payouts: FinancePayout[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: Record<string, string | number | boolean | null>;
};
```

Affiliate payout settings responses must not include referral-code ownership
fields, raw bank account numbers, provider secrets, or marketplace profile PII.

### Platform Admin affiliate payout evidence

The Platform Admin list and detail routes expose Finance-owned payout facts
grouped by affiliate and currency. They may include the affiliate resource ID,
linked organization ID, effective payout method, ledger totals, payout state,
retry state, affiliate lifecycle status, and immutable payment-evidence history.
Lifecycle changes do not hide Finance liabilities or history. Affiliate names, contact
details, referral codes, commission management, and raw payout destinations
remain outside this contract.

`POST /api/finance/platform/affiliate-payouts/:affiliateId/mark-paid` records an
already-completed external manual or bank-transfer payment. The request has the
following exact shape:

```ts
type PlatformAffiliatePayoutMarkPaidRequest = {
  commandId: string;
  idempotencyKey: string;
  currency: FinanceCurrencyCode;
  payoutIds: string[];
  expectedAmount: FinanceDecimalAmount;
  paymentMethod: "manual" | "bank_transfer";
  externalReference: string;
  evidenceReference: string;
  paidAt: FinanceUtcDateTime;
  note?: string | null;
};
```

The command applies only to the exact payout IDs and aggregate amount reviewed
in the detail response. Every row must still be `pending` or `scheduled` in the
requested currency with no provider payout ID, and its effective payout method
must be `manual` or `bank_transfer`. A changed row set or amount returns
`409 stale_payout_snapshot`; `processing`, `failed`,
provider-dispatched, paid, canceled, and reversed payouts are never overridden
by this route. A single command cannot span currencies.

The Finance transaction must lock the eligible payout rows, reserve the
idempotency key, insert append-only evidence and payout-item snapshots, update
the payout ledger, cancel any still-pending dispatcher jobs for the affected
payouts, append a product audit event, and complete the idempotency record as
one atomic unit. External references are unique within the affiliate
organization. Evidence rows and their item snapshots are immutable; a
correction is a new compensating Finance outcome, not an update or delete.

An identical retry returns the original evidence and payout IDs without
additional ledger, evidence, job, or audit writes. Reusing the idempotency key
with different command evidence returns `409 idempotency_conflict`; reusing an
external reference returns `409 duplicate_reference`. Missing evidence,
unsupported methods, cross-affiliate/cross-currency rows, or invalid state
transitions are rejected before mutation. The route does not initiate a
provider payout and does not call a legacy service.

Detail summary, payout rows, and history are read in one repeatable PostgreSQL
snapshot. List consumers must page through `total`; the Platform Admin client
loads every server page so outstanding scopes are not silently omitted.

## Stripe And Xendit Onboarding

Provider account creation commands are idempotent by explicit `idempotencyKey`
and stable owner scope. A repeated Stripe Connect request for the same property
or affiliate returns the existing `providerAccountId` and latest valid
`onboardingUrl`; it must not create duplicate Stripe accounts.

Property Stripe Connect:

```ts
type CreateStripePropertyAccountRequest = {
  commandId: string;
  idempotencyKey: string;
  email: string;
  country: string;
};

type ProviderAccountCommandResponse = {
  contractVersion: "finance-route-contracts.v1";
  providerAccountId: string;
  provider: "stripe" | "xendit";
  providerAccountRef: string;
  status: "setup_incomplete" | "pending" | "active" | "restricted" | "suspended" | "disabled";
  onboardingStatus: "not_started" | "invited" | "in_review" | "completed" | "requires_action";
  commandMeta: FinanceCommandMeta;
};
```

Affiliate Stripe Connect uses the same finance provider-account contract after
Marketplace/affiliate resolves and authorizes the affiliate resource. Booking
Web may keep returning the compatibility shape consumed by `ReferModal`
(`onboardingUrl`), but it may not own the affiliate identity or provider account.

Xendit bank validation verifies the provider-visible account before payout
settings are saved. Validation responses may include provider validation status
and masked destination metadata. They must not persist raw account numbers
outside the configured sensitive destination reference.

## Reconciliation Views

Reconciliation views are permissioned reads over provider receipts, finance
payments/payouts, provider accounts, jobs, dead letters, and product audit.

| View                   | Path                                                                   | Purpose                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Payment reconciliation | `/api/finance/properties/:propertyId/reconciliation/payments`          | Compare `finance.payments`, Stripe payment intent receipts, Xendit invoice callbacks, Booking lifecycle effects, and pending jobs. |
| Payout reconciliation  | `/api/finance/properties/:propertyId/reconciliation/payouts`           | Compare `finance.payouts`, Stripe transfers, Xendit payout callbacks/polls, retry state, and dead letters.                         |
| Provider accounts      | `/api/finance/properties/:propertyId/reconciliation/provider-accounts` | Surface Connect/Xendit onboarding state drift, required action, and webhook receipt freshness.                                     |

```ts
type FinanceReconciliationItem = {
  subjectId: string;
  subjectType: "payment" | "payout" | "provider_account";
  provider: "stripe" | "xendit" | "manual" | "bank_transfer" | "vayada";
  financeStatus: string;
  providerStatus: string | null;
  latestReceiptStatus: "matched" | "missing" | "stale" | "dead_lettered" | "not_applicable";
  jobStatus: "idle" | "queued" | "running" | "failed" | "dead_lettered";
  recommendedAction: "none" | "enqueue_reconcile" | "manual_review" | "refresh_provider_state";
  lastReceiptAt: FinanceUtcDateTime | null;
  lastJobAt: FinanceUtcDateTime | null;
};

type FinanceReconciliationViewResponse = {
  contractVersion: "finance-route-contracts.v1";
  propertyId: string;
  items: FinanceReconciliationItem[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: Record<string, string | number | boolean | null>;
};
```

Manual reconciliation commands create jobs:

- `payment.reconcile-status:payment:<paymentId>:<provider-event-or-manual-run>:v1`;
- `finance.reconcile-payout:payout:<payoutId>:<provider-status-or-manual-run>:v1`;
- `finance.provider-account.reconcile:provider_account:<providerAccountId>:<provider-event-or-manual-run>:v1`.

Reconciliation routes must never bypass webhook/job idempotency. Provider
dashboards are evidence sources, not the product audit trail.

## F1a PMS Checkout-Charge Settlement Bridge

PMS operations owns checkout-charge operational state. Finance owns settlement.
The bridge contract is:

1. PMS `mark-paid` persists the operational charge state and emits a durable
   event or calls a Finance command boundary in the same transaction/outbox:
   `pms.checkout_charge.marked_paid`.
2. The event payload contains `propertyId`, `guestBookingId`, `checkoutChargeId`,
   `amount`, `currency`, `paymentMethod`, optional `reference`, `markedPaidAt`,
   `operatorUserId`, and `pmsCommandId`.
3. Finance consumes the event through the command
   `finance.checkout_charge.settle_manual` and creates a `finance.payments` row
   with `source_system = "finance"`, `payment_kind = "manual"` or
   `"adjustment"`, status `paid`, and metadata linking the PMS checkout charge.
4. The finance idempotency key is:

```text
finance.checkout-charge-settlement:checkout_charge:<checkoutChargeId>:mark-paid:<pmsCommandId>:v1
```

5. Duplicate PMS `mark-paid` retries return the original PMS result and the
   existing finance payment/bridge outcome. Conflicting duplicate keys return
   `409 idempotency_conflict`.
6. The bridge does not capture cards, create provider invoices, dispatch
   payouts, or reconcile provider webhooks inline. Those are finance jobs.
7. If the finance bridge is not implemented for staging rehearsal, PMS
   checkout-charge `mark-paid` must be frozen for unsettled charges. The command
   returns `409 finance_bridge_required` with no operational mutation. Charge
   create and waive may remain enabled because they do not claim settlement.

This rule is concrete enough for VAY-783: P2c may implement operational
checkout charges, but `mark-paid` must either enqueue the Finance bridge event
or be disabled by rehearsal configuration. PMS operations must not implement
provider settlement itself.

## Legacy Scheduler Dispositions

The F1 scheduler rows extend the freeze matrix in
[`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md).

| Legacy job id                    | Current effect                                             | Rehearsal state                                                                               | Target enablement rule                                                                                                                                  | Rollback                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `process_property_payouts`       | Dispatches hotel Stripe/Xendit payouts.                    | Disabled unless target payout dispatcher is observe-only and cannot send provider transfers.  | Enable target dispatch only after legacy job is off for the affected property scope and reconciliation views show no active legacy transfer window.     | Stop target dispatcher, reconcile provider transfer IDs, re-enable legacy only for payouts with no successful target transfer.     |
| `process_affiliate_payouts`      | Dispatches affiliate payouts and notifications monthly.    | Disabled unless rehearsal is outside the monthly window and Finance owner accepts no-op risk. | Enable target affiliate payout dispatcher after affiliate payout ledger, notification audit, and marketplace/affiliate resource links are target-owned. | Stop target dispatcher, reconcile transfer IDs and notification audit, re-enable legacy only for the next approved monthly window. |
| `poll_xendit_processing_payouts` | Polls Xendit processing payouts and marks success/failure. | Disabled when target Xendit webhook/reconciliation owns payout status.                        | Enable target payout reconciliation before target payout dispatch. No dual polling.                                                                     | Stop target reconciliation, return target webhook mode to observe-only, then re-enable legacy polling if required.                 |

Manual legacy route `POST /admin/xendit/reconcile-payouts` follows the same
disposition as `poll_xendit_processing_payouts`: it is disabled, proxied to
target, or target-owned during rehearsal. It cannot run mutatively in legacy
while target reconciliation can mutate the same payouts.

## Error Categories

| Category         | Status         | Codes                                                                                                                                                 |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication` | `401`          | `unauthenticated`, `invalid_token`                                                                                                                    |
| `authorization`  | `403`          | `missing_permission`, `missing_entitlement`, `inactive_entitlement`, `missing_resource_access`                                                        |
| `validation`     | `400`          | `invalid_query`, `invalid_body`, `invalid_currency`, `invalid_payment_method`, `invalid_provider`, `invalid_date_range`, `provider_validation_failed` |
| `conflict`       | `409`          | `version_conflict`, `idempotency_conflict`, `provider_account_exists`, `finance_bridge_required`, `payout_already_dispatched`                         |
| `not_found`      | `404`          | `payment_settings_not_found`, `invoice_not_found`, `payment_not_found`, `payout_not_found`, `provider_account_not_found`, `affiliate_not_found`       |
| `read_model`     | `500`          | `read_model_unavailable`, `finance_visibility_unavailable`                                                                                            |
| `provider`       | `502`          | `provider_unavailable`, `provider_rejected`, `provider_timeout`                                                                                       |
| `side_effect`    | `202` or `500` | `side_effect_queued`, `side_effect_failed`                                                                                                            |

Commands that durably persist but queue asynchronous side effects may return
`202 side_effect_queued`. They must still return accepted command metadata and
enough read-model state for the caller to avoid duplicate submission.

```ts
type FinanceCommandMeta = {
  contractVersion: "finance-route-contracts.v1";
  commandId: string;
  idempotencyKey: string;
  acceptedAt: FinanceUtcDateTime;
  sideEffects: Array<
    "audit_event" | "reconciliation_job" | "payout_job" | "booking_projection_refresh"
  >;
};
```

## Fixtures

Representative contract fixtures live in:

```text
engineering/fixtures/finance-route-contracts/cases.json
```

They complement the target migration fixture at
`packages/backend-migration/fixtures/cases/finance/`: migration fixtures prove
source-to-target transforms, while route fixtures prove HTTP contract behavior,
authorization, sensitive-field exclusions, idempotency, scheduler freeze
dispositions, and frontend-visible state.

The fixture set must cover:

- payment settings and cancellation policy reads/writes;
- public-safe payment capability projection;
- invoice list/detail, payment ledger, manual record-payment command, and CSV
  export disposition;
- property and affiliate payout reads without sensitive destination fields;
- Stripe property and affiliate onboarding idempotency;
- Xendit bank validation and payout reconciliation job enqueue;
- reconciliation views over payments, payouts, provider accounts, receipts,
  jobs, and dead letters;
- F1a checkout-charge settlement bridge and freeze fallback;
- authorization denial matrix;
- scheduler freeze and no dual provider transfer/polling.

## Fixed Plan subscription routes

Booking Admin uses the target Finance source of truth for plan switching:

| Method | Route                                                      | Behavior                                                                                                           |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/finance/properties/:propertyId/plan-status`          | Current Commission/Fixed state, active-room price, exact 30-day period, next billing date, and cancellation state. |
| `POST` | `/api/finance/properties/:propertyId/fixed-plan/checkout`  | Creates an idempotent hosted Stripe subscription Checkout. It does not activate Fixed.                             |
| `POST` | `/api/finance/properties/:propertyId/customer-portal`      | Creates a short-lived Stripe Customer Portal URL.                                                                  |
| `POST` | `/api/finance/properties/:propertyId/switch-to-commission` | Schedules Stripe cancellation at the current period end without proration.                                         |

Stripe `invoice.paid` is the activation boundary. Webhook receipts are durable
and idempotent; a delayed event cannot overwrite a newer provider event.
`invoice.payment_failed` keeps the Fixed entitlement, leaves retries to Stripe,
and enqueues one internal Finance notification. `invoice.upcoming` snapshots the
current active-room count and updates subscription quantity with no proration so
the change appears on the next invoice. A terminal subscription deletion moves
the property back to Commission.

Every new booking stores its Finance plan and commission terms at creation.
Later plan or rate changes never rewrite that booking snapshot.

Checkout is exposed only when target Finance, target Booking checkout, the
Stripe API secret, a verified webhook secret, and mutating Stripe intake are all
configured. The API derives Checkout email from the authenticated actor rather
than accepting a browser-supplied address.

## Reads-Before-Writes Slice Order

| Slice | Scope                                                                                                        | Rehearsal gate |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------------- |
| F1a   | PMS checkout-charge settlement bridge or explicit mark-paid freeze rule                                      | Yes            |
| F1b   | Payment settings and cancellation policy reads, public-safe payment capability projection, denial matrix     | Yes            |
| F1c   | Invoice list/detail, financial summary, payment ledger reads, CSV export disposition                         | Yes            |
| F1d   | Manual payment record command with idempotency, audit, and Booking/PMS projection jobs                       | Yes            |
| F1e   | Property payout reads and reconciliation views before any target provider dispatch                           | Yes            |
| F1f   | Stripe Connect property and affiliate onboarding commands with idempotency and compensation                  | Yes            |
| F1g   | Xendit bank validation and payout reconciliation jobs; legacy polling/manual reconcile freeze                | Yes            |
| F1h   | Target property payout dispatcher after reconciliation and legacy scheduler freeze                           | Yes            |
| F1i   | Target affiliate payout dispatcher after marketplace/affiliate identity and payout settings are target-owned | Yes            |

Reads must land before writes for each surface. Provider dispatch follows
reconciliation, not the other way around. Staging rehearsal cannot start while
payment settings, invoices, payouts, or provider webhooks are still mutating in
legacy unless the live provider and scheduler paths are explicitly frozen with
an owner, start time, end time, and rollback owner.

## First Implementation Tickets

Ready to create after this contract is accepted:

1. **Implement F1a checkout-charge finance settlement bridge or freeze guard**
   - Scope: PMS P2c `mark-paid` emits `pms.checkout_charge.marked_paid` for
     Finance or returns `409 finance_bridge_required` under rehearsal freeze;
     idempotency and no provider calls.
2. **Implement finance payment settings and cancellation policy read routes**
   - Scope: target Finance repository, public-safe payment capability
     projection, PMS/Booking compatibility facades, denial matrix, sensitive
     field exclusions.
3. **Implement finance invoice and payment ledger reads**
   - Scope: summary, invoice list/detail, ledger, CSV export disposition,
     source freshness, empty states, pagination/search/sort fixtures.
4. **Implement finance manual payment record command**
   - Scope: idempotent `finance.payments` write, audit/outbox events, no inline
     provider calls, Booking/PMS projection refresh jobs.
5. **Implement finance payout reads and reconciliation views**
   - Scope: property payout read model, payment/payout/provider-account
     reconciliation views, dead-letter/job visibility.
6. **Implement Stripe Connect onboarding commands for properties and affiliates**
   - Scope: idempotent provider account creation, onboarding links,
     compensation for provider-success/DB-write failure, VAY-774 facade shape.
7. **Implement Xendit bank validation and target payout reconciliation jobs**
   - Scope: bank validation, payout status reconciliation, legacy manual
     reconcile and polling freeze, provider replay fixtures.
8. **Implement target property payout dispatcher**
   - Scope: dispatch after reconciliation readiness, no dual legacy scheduler,
     provider attempt audit, rollback rules.
9. **Implement target affiliate payout dispatcher and payout settings**
   - Scope: affiliate payout settings, monthly batch dispatcher,
     marketplace/affiliate resource boundary, notification audit.

Each ticket must keep its PR narrow, link this contract, and state whether it is
a staging rehearsal gate.

## References

- `engineering/booking-pms-route-migration-inventory.md`
- `engineering/channex-webhook-cutover-plan.md`
- `engineering/pms-operations-route-contracts.md`
- `engineering/jobs-events-contract.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/target-schema-migration-coverage.md`
- `engineering/migration-parity-harness.md`
- `packages/backend-migration/migrations/0007_finance.sql`
- `packages/backend-migration/fixtures/cases/finance/`
- `packages/domain-finance/src/index.ts`
