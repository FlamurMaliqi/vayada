# PMS Financials external invoice contract

_VAY-1240 amendment to
[`pms-financials-contracts.md`](pms-financials-contracts.md) for VAY-1092; all
non-invoice rules remain unchanged._

## Decision

Vayada does not issue the official accounting or tax invoice.

Vayada owns the booking-linked financial evidence, an operational folio, and
the workflow that requests an invoice from a property's connected accounting
system. The accounting system owns the official document identity, sequential
number, tax treatment, issue/void/credit-note lifecycle, and statutory record.

The PMS may display and deliver an externally confirmed invoice, but it must
not independently allocate an `INV-*` number, render a second official PDF, or
silently treat a booking, payment, or folio as an issued invoice.

Provider selection and adapter implementation require separate tickets.

## Product language

| Term             | Meaning in Vayada                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Folio            | Vayada-owned operational statement of booking charges and payments. It is not an official invoice.          |
| Invoice draft    | A versioned outbound request prepared from a folio for an accounting connection. It has no official number. |
| Official invoice | A document confirmed by the accounting system with its external ID and official number.                     |
| Credit note      | An accounting-system document that corrects an issued invoice and references that invoice.                  |
| Statement        | A guest-readable view of the folio. It must not be labelled as a tax invoice.                               |

Before confirmation, UI actions say **Prepare folio** and **Create in
accounting**. After confirmation, they may say **Invoice**, show the official
number, and identify the accounting source. A Vayada folio ID is opaque and
must not resemble the property's official invoice sequence.

## Ownership

| Fact or behavior                                      | Canonical owner                                 | Vayada responsibility                                        |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Booking, stay, room and add-on evidence               | Booking/PMS                                     | Project versioned folio lines.                               |
| Provider payments, refunds and disputes               | Finance                                         | Link payment references without copying provider facts.      |
| Folio and folio revisions                             | Finance                                         | Persist the operational statement and its source digest.     |
| Accounting connection and property binding            | Finance integration                             | Resolve one active, authorized property connection.          |
| Tax codes, official tax calculation and fiscalization | Accounting system/property configuration        | Send mapped evidence; reject missing mappings.               |
| Official ID and sequential number                     | Accounting system                               | Store only the confirmed external values.                    |
| Invoice, void and credit-note lifecycle               | Accounting system                               | Mirror confirmed state and preserve sync history.            |
| Official PDF/document                                 | Accounting system                               | Store a protected provider handle or immutable fetched copy. |
| Delivery                                              | Accounting system or a Finance delivery adapter | Deliver only a confirmed external document.                  |
| Audit, idempotency, jobs and dead letters             | Platform services with Finance handlers         | Correlate every request, result and retry.                   |

The provider is authoritative only for connected documents, not Vayada
bookings/revenue/expenses. Dashboard external outstanding sums healthy issued
mirrors only; operational folio balance stays separate and missing/stale mirror
coverage appears in `incompleteEvidence`.

## Aggregate boundary

VAY-1125 replaces the local official-invoice aggregate with these concepts.

### Folio

A property-scoped versioned aggregate stores its IDs/revision, recipient and
billing evidence, service dates, currency, normalized lines and totals, source
references/digest/freshness, and `draft`, `ready`, `superseded`, or `archived`
state. Draft changes create revisions; submitted revisions remain
reconstructable and never change with later booking or payment facts.

### Submission

An immutable submission stores command/idempotency/fingerprint, property,
connection generation and non-secret provider destination, exact folio
revision, operation payload/source digest, and its `accepted`, `pending`,
`retry_wait`, `uncertain`, `confirmed`, `rejected`, `manual_reconciliation`, or
`superseded` state. `uncertain` forbids blind creation; exhausted retries require
an evidenced authorized resolution to `confirmed` or `rejected`.

Only one active or confirmed invoice intent may exist for
`(propertyId, connectionGeneration, folioId, folioRevision)`, regardless of
idempotency key. Another legal document must be an explicit correction.

### External document reference

A property/connection mirror stores provider/document kind and ID, nullable
official identity/dates, currency/totals, separate creation/issuance/payment
states, credit-note lineage, protected document handle, provider version,
payload digest, sync health, submission and folio revision. Uniqueness is
`(connectionGeneration, destinationFingerprint, externalDocumentId)`; all
documents, allocations and webhooks resolve to one property before data access.

## Provider-neutral contract

<!-- prettier-ignore -->
```ts
type Date = string; type Decimal = string;
type Money = { amount: Decimal; currency: string };
type Address = { line1: string; line2?: string; city: string; region?: string; postalCode?: string; countryCode: string };
type Recipient = { name: string; email: string | null; billingAddress?: Address;
  taxIdentifiers: Array<{ type: string; value: string; countryCode?: string }> };
type FolioLine = { lineId: string; kind: "room" | "addon" | "fee" | "tax" | "adjustment";
  description: string; quantity: Decimal; unitAmount: Money; total: Money; serviceOn: Date;
  sourceRef: { type: string; id: string; revision: number }; accountingMappingRef: string; taxTreatmentRef: string };
type FolioSnapshot = { folioId: string; propertyId: string; bookingId: string | null; revision: number;
  recipient: Recipient; serviceFrom: Date; serviceTo: Date; currency: string; lines: FolioLine[]; total: Money;
  paymentRefs: Array<{ paymentId: string; amount: Money }>; sourceDigest: string };
type CommandBase = { commandId: string; idempotencyKey: string; connectionId: string; connectionGeneration: string };
type AccountingCommand = CommandBase & (
  | { kind: "invoice"; folioId: string; expectedFolioRevision: number }
  | { kind: "credit_note"; correctionFolioId: string; expectedFolioRevision: number;
      originalExternalDocumentId: string; expectedExternalVersion: string | null; reason: string }
  | { kind: "void"; externalDocumentId: string; expectedExternalVersion: string | null; reason: string }
  | { kind: "payment_allocation"; externalDocumentId: string; expectedExternalVersion: string | null;
      paymentId: string; amount: Money; allocatedOn: Date }
  | { kind: "allocation_reversal"; externalDocumentId: string; expectedExternalVersion: string | null;
      reversesExternalAllocationId: string; financeAdjustment: { kind: "refund" | "dispute"; id: string }; amount: Money; reversedOn: Date }
);
type OperationState = "accepted" | "pending" | "retry_wait" | "uncertain" |
  "confirmed" | "rejected" | "manual_reconciliation" | "superseded";
type ExternalDocument = { provider: string; connectionId: string; connectionGeneration: string;
  destinationFingerprint: string; externalDocumentId: string;
  kind: "invoice" | "credit_note"; officialNumber: string | null;
  creationState: "draft" | "created"; issueState: "not_issued" | "pending_approval" | "issue_rejected" | "issued" | "voided";
  paymentState: "unpaid" | "partial" | "paid"; issuedOn: Date | null; dueOn: Date | null; currency: string;
  subtotal: Money; tax: Money; total: Money; allocated: Money; outstanding: Money; originalExternalDocumentId: string | null;
  documentAvailable: boolean; externalVersion: string | null;
  syncHealth: "healthy" | "requires_review" | "manual_reconciliation"; confirmedAt: string; syncedAt: string };
type OperationResult = { kind: "document"; document: ExternalDocument } |
  { kind: "allocation"; externalAllocationId: string; externalReversalId?: string; state: "pending" | "confirmed" | "reversed" } |
  { kind: "rejection"; code: string; message: string };
type AccountingOperation = { operationId: string; kind: AccountingCommand["kind"];
  state: OperationState; result: OperationResult | null; nextRetryAt: string | null };
```

Provider adapters translate this canonical request into provider-specific
accounts, contacts, items, tax codes, tracking categories, and payment methods.
Provider IDs or raw payloads must not leak into the domain contract beyond the
normalized external reference and protected diagnostic evidence.

The outbound request includes only fields supported by reviewed property
mappings. Missing account, tax, recipient, currency, or connection evidence is
a typed precondition failure; Vayada must not invent or silently default it.
Each line mapping states whether amounts are tax-inclusive, tax-exclusive,
exempt, or out of scope. An adapter must not send both an explicit tax line and
provider-calculated tax for the same economic component. Provider-confirmed
subtotal, tax, and total are reconciled against the submitted snapshot before
the reference is considered healthy.

The adapter result includes the durable operation ID/state and either the
external document reference, an external allocation reference, or a typed
redacted rejection. Allocation commands enforce property/currency scope,
cumulative outstanding amount, stable intent identity, and refund/dispute
reversal lineage.

### Canonical invoice routes

| Method      | Path after `/api/finance/properties/:propertyId/financials`                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `GET/POST`  | `/folios`                                                                                                     |
| `GET/PATCH` | `/folios/:folioId`                                                                                            |
| `POST`      | `/folios/:folioId/invoice-operations` to create externally                                                    |
| `GET`       | `/invoice-operations/:operationId` for durable recovery state                                                 |
| `GET`       | `/external-invoices`; `/external-invoices/:documentId`                                                        |
| `POST`      | `/external-invoices/:documentId/corrections`, `/void`, `/allocations`, `/allocation-reversals`, `/deliveries` |
| `GET`       | `/external-invoices/:documentId/document`                                                                     |

## State and command flow

### Create an official invoice

1. Authorize the actor, organization, property, entitlement, and active
   accounting connection before property data or idempotency evidence is read.
2. Lock/read the requested folio revision and verify that it is `ready`, its
   evidence is current enough, its currency matches the connection, and all
   required accounting/tax mappings exist.
3. Reserve the command and invoice-intent business key, and persist the exact
   snapshot plus immutable destination binding before dispatch.
4. Enqueue one durable provider operation. Do not hold a database transaction
   open across the network call.
5. Store technical creation separately from legal issue state; a provider
   draft or pending approval is not an official invoice.
6. Expose the Invoice label, official number, and delivery only after the
   provider confirms `issued` with an official identity.

A completed matching retry returns the stored result. An active retry returns
the operation status and may perform a read-only provider lookup, but never a
second blind create. Changed key reuse is a conflict; a different key for the
same active invoice-intent business key resolves to that existing operation.

### Provider rejection

A pre-creation rejection records a redacted reason and no external reference.
An `issue_rejected` document keeps its reference, remains non-official and
non-deliverable, and requires correction or review. Both remain auditable.

### Timeout after provider success

A transport ambiguity records `uncertain`; retry first looks up the provider
request and mutates again only after proving absence. Providers unable to prove
the outcome require manual reconciliation. Retryable failures use bounded
`retry_wait`; exhaustion/dead letter is a readable `manual_reconciliation`
operation requiring audited resolution. Dispatch, lookup and webhooks use the
immutable tenant/entity/connection generation. Credential rotation proceeds
only for the same destination; retargeting requires a new command.

### External edits and reconciliation

Verified, deduplicated webhooks are preferred; polling repairs gaps. Inbound
events resolve the immutable destination, enforce provider version order, and
store restricted evidence. External edits advance the mirror, never the folio;
material digest mismatch becomes `requires_review` and does not alter Vayada
revenue, expense or payment facts. Mutations/delivery require healthy expected
version. Without versions, compare a fresh digest under lock or reconcile
manually.

### Corrections, credit notes and voids

Issued invoices are never edited through folios. A new folio revision and
provider operation reference the original; the accounting system creates the
credit note/corrective invoice/void and Vayada mirrors its lineage. Unsupported
correction returns `unsupported_operation` for manual accounting—never a
Vayada-only negative PDF or number.

### Payments

Finance owns payment/refund/dispute evidence; accounting owns invoice
allocation. Commands reference, never copy, a Finance payment and expose both
operational and last-synced accounting state. Currency/property mismatches fail
before dispatch; retries follow uncertain-outcome rules.

### Documents and delivery

Vayada may expose a short-lived provider link, retain a provider-created file in
Platform Media, or request provider delivery; it never renders the official
invoice. Downloads need Financials authorization or a reviewed guest token.
Files are keyed by external document/version/digest; stable delivery retries
are blocked when the document is absent or sync is unhealthy.

## Authorization, audit and errors

- Reads require `pms.finance.read`; folio and external commands require
  `pms.finance.manage` and the active `module:financials` entitlement.
- Only `owner` and `finance_manager` relationships are eligible. The route
  boundary uses `enforceRoutePolicy` before validation, connection lookup,
  idempotency lookup, or provider dispatch.
- The selected accounting connection must be active and linked to the same
  property and organization as the folio and actor context.
- Audit records include actor, organization, property, connection, folio and
  revision, command, external reference, before/after sync state, correlation
  ID, and redacted outcome. Provider secrets and unrestricted URLs are absent.
- Recipient, address and tax fields use provider/jurisdiction allowlists,
  encrypted access-controlled storage, and PII-safe keyed fingerprints. Raw PII
  never enters logs, idempotency keys or ordinary audit payloads. Before
  activation, each adapter defines retention/anonymization for snapshots, raw
  events and cached documents, including accounting holds and deletion rights.
- `401` is missing/invalid authentication. `403` is permission, entitlement,
  relationship, resource-link, or connection-scope denial. `404` follows an
  authorized lookup. `400` is malformed input. `409` is revision,
  idempotency, lifecycle, or ambiguous-sync conflict. `422` is missing or
  mismatched accounting evidence. `502/503` is a retryable provider failure;
  an uncertain outcome uses a durable operation response, not a blind error.

## Acceptance examples

| Scenario                     | Required result                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Successful creation          | One provider request, one external reference, official number shown only after confirmation. |
| Matching replay              | Same operation/result; no second mutating provider call or document.                         |
| Different key, same intent   | Resolves to the active operation; no duplicate official invoice.                             |
| Changed-key reuse            | `409`; no provider call or new side effect.                                                  |
| Provider rejection           | Durable redacted rejection; no external document; folio remains correctable.                 |
| Timeout after success        | `uncertain`, then lookup and confirmation of the original document.                          |
| Retry exhaustion             | Readable manual-reconciliation state and audited resolution.                                 |
| Provider draft               | Stored as pre-issue state; never labelled or delivered as an official invoice.               |
| Retargeted connection        | Old operation cannot dispatch to the new provider tenant/entity.                             |
| External edit                | Mirrored state advances; folio stays immutable; material mismatch requires review.           |
| Correction                   | New folio revision and provider credit-note/correction linked to the original.               |
| Payment allocation           | Existing Finance payment is referenced once and provider allocation is reconciled.           |
| Cross-property request/event | Denied before tenant data or idempotency evidence is disclosed or mutated.                   |
| Missing tax/account mapping  | Typed `422`; no fallback mapping and no provider call.                                       |

## Changes to existing tickets

| Ticket   | Retain                                                                                        | Remove or replace                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAY-1125 | Normalized lines, payment references, booking/expense links, constraints and migration tests. | Remove sequences/local official lifecycle; add folio revisions, immutable destination submissions, business uniqueness, external mirrors and sync evidence. |
| VAY-1132 | Authorization, decimal totals, filters, external-summary coverage, audit and idempotency.     | Replace local issue/void/payment APIs with folio, operation-status, external create/correct/void/allocation and reconciliation routes.                      |
| VAY-1133 | Protected download/delivery, durable retries and authorization.                               | Remove official-PDF rendering; retrieve, version, protect and deliver only healthy accounting-system documents.                                             |
| VAY-1134 | All filtered CSV/security behavior.                                                           | Replace generated invoice PDF export with confirmed external-document retrieval.                                                                            |
| VAY-1137 | List/detail, status, document and supplier-expense entry.                                     | Use folio/external-invoice terminology and actions; remove local number, issuance and PDF behavior.                                                         |

Supplier bills remain expense evidence under the Expenses boundary. This
decision does not make Vayada an accounts-payable or supplier-invoice system.

## Implementation sequence

1. Accept this contract and revise the five affected tickets.
2. Pilot one destination/property, including eligibility, accounts and tax codes.
3. Implement folio and external-reference schema without an active UI.
4. Implement one provider adapter and its webhook/polling reconciliation.
5. Add PMS routes and UI behind inactive `module:financials` entitlement.
6. Rehearse all acceptance examples against a provider sandbox.

Rollout requires safe uncertain-outcome recovery, property isolation, document
retrieval, corrections and allocation in the pilot.

## Open business inputs

Production activation is blocked on:

- Vayada's launch property countries and applicable tax/fiscalization rules;
- whether the property or Vayada is merchant of record for each payment flow;
- the first accounting destination and pilot property's real configuration;
- who approves a folio before external creation;
- whether the provider or Vayada delivers the confirmed document; and
- retention and support policy for externally edited or reconciled invoices.
