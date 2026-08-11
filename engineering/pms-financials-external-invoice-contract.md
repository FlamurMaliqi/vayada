# PMS Financials accounting handoff and invoice ownership contract

_VAY-1240 amendment to
[`pms-financials-contracts.md`](pms-financials-contracts.md) for VAY-1092. All
non-folio Financials rules remain unchanged._

## Decision

The Financials MVP has no required accounting-provider integration.

Vayada owns booking-linked financial evidence, operational folios/statements,
and property-scoped CSV exports. A property or its accountant creates any
official accounting or tax invoice outside Vayada using the accounting process
they already use.

Vayada does not allocate an official invoice number, issue or void a tax
invoice, render an official invoice PDF, or claim that a folio or export is an
official invoice. Xero, QuickBooks, and other paid providers are not MVP
dependencies.

## MVP scope

- Create and read property-scoped operational folios from recorded booking,
  charge, and payment evidence.
- Preserve immutable folio revisions with normalized lines and exact source
  references.
- Export Dashboard, Revenue, Expenses, Profit & Loss, and Folio data as CSV.
- Use product language that clearly separates a Vayada folio from an official
  invoice.

The MVP does not select an accounting vendor or implement provider connections,
invoice creation, credit notes, payment allocation, webhooks, reconciliation,
official-document retrieval, or invoice email delivery. Those require a new
decision after pilot demand and commercial cost are known.

## Product language

| Term              | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Folio             | Vayada's operational record of booking charges and referenced payments. Not a tax invoice.   |
| Statement         | A guest-readable presentation of a folio. It must not be labelled as an invoice.             |
| Accounting export | A scoped CSV handoff for the property or accountant. It does not create an accounting entry. |
| Official invoice  | A legal/accounting document created and numbered outside Vayada.                             |

The PMS tab is **Folios**, not **Invoices**. Actions may say **Prepare folio**,
**Mark ready**, and **Export CSV**. They must not say **Issue invoice**, show an
`INV-*` number, or expose Sent/Paid/Overdue as official-invoice states.

## Ownership

| Fact or behavior                                        | Canonical owner              | Vayada responsibility                                |
| ------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Booking, stay, room, and add-on evidence                | Booking/PMS                  | Reference the exact source revision in folio lines.  |
| Payments, refunds, and disputes                         | Finance                      | Reference existing facts; never copy provider state. |
| Folios, revisions, lines, and totals                    | Finance                      | Persist reconstructable operational evidence.        |
| Official identity, numbering, tax rules, and compliance | Property/accounting system   | No MVP lifecycle or calculation.                     |
| CSV generation and access                               | Platform with Finance policy | Authorize, audit, expire, and protect exported data. |

## Folio aggregate

A folio is property scoped and may reference one booking. Each revision records
the recipient snapshot, service dates, currency, normalized lines, total,
payment references, source digest, and source freshness.

Stored revision states are `draft`, `ready`, and `archived`:

- `draft` may be replaced by a new revision.
- `ready` means the evidence is complete enough for operational handoff. It does
  not mean an invoice was issued.
- `archived` removes the folio from the normal active view without deleting it.

Revisions, lines, and payment references are append-only. Corrections create a
new revision; they never rewrite the evidence used by an earlier export. A
non-latest revision is presented as `superseded`, derived from the existence of
a later revision rather than stored by updating history. A ready revision
requires at least one line, one currency, service dates covering every line, and
a total equal to the decimal-safe sum of its lines.

Sourced operational tax-charge evidence may be stored as a `tax` line. Vayada
does not invent that line or decide its legal tax treatment, rate, reporting, or
compliance.

## Typed contract

<!-- prettier-ignore -->
```ts
type Date = string; type Decimal = string;
type Money = { amount: Decimal; currency: string };
type StoredFolioState = "draft" | "ready" | "archived";
type FolioViewState = StoredFolioState | "superseded";
type FolioLine = { lineId: string; position: number;
  kind: "room" | "addon" | "fee" | "tax" | "adjustment";
  description: string; quantity: Decimal; unitAmount: Money; total: Money; serviceOn: Date;
  source: { type: string; id: string; revision: number } };
type Folio = { folioId: string; propertyId: string; bookingId: string | null; revision: number;
  state: FolioViewState; recipient: { name: string; email: string | null };
  serviceFrom: Date; serviceTo: Date; currency: string; lines: FolioLine[]; total: Money;
  paymentRefs: Array<{ paymentId: string; amount: Money }>;
  sourceDigest: string; sourceFreshness: Record<string, string> };
type FolioQuery = { from?: Date; to?: Date; state?: FolioViewState; search?: string;
  sort?: "createdAt_desc" | "serviceFrom_desc" | "amount_desc"; cursor?: string; limit?: number };
type FolioWrite = { commandId: string; idempotencyKey: string; expectedRevision?: number;
  bookingId?: string; recipient: Folio["recipient"]; serviceFrom: Date; serviceTo: Date;
  lines: Array<Omit<FolioLine, "lineId" | "total">>;
  paymentRefs: Array<{ paymentId: string; amount: Money }> };
```

The server resolves source and payment references inside the authorized property,
calculates line and folio totals, and rejects client totals or cross-property and
cross-currency evidence. The server does not invent charges, taxes, or payments.

### Canonical routes

| Method      | Path after `/api/finance/properties/:propertyId/financials` | Behavior                                        |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `GET/POST`  | `/folios`                                                   | List folios / create the first draft revision.  |
| `GET/PATCH` | `/folios/:folioId`                                          | Read / append a corrected draft revision.       |
| `POST`      | `/folios/:folioId/ready`                                    | Append an immutable ready revision.             |
| `DELETE`    | `/folios/:folioId`                                          | Append an archived revision; never hard-delete. |
| `POST/GET`  | `/exports` / `/exports/:exportId`                           | Create and retrieve an authorized CSV export.   |

Writes require command idempotency and optimistic revision checks. Matching
replay returns the stored result; changed key reuse is `409`.

## CSV handoff

Only `ready` revisions are eligible for accounting-handoff export. Drafts remain
available through folio reads and are never represented as complete accounting
handoff. Folio CSV uses one row per normalized line and repeats the scoped folio
fields. The stable `pms-financials-folios.v1` columns are:

```text
property_id,folio_id,folio_revision,folio_state,booking_id,
recipient_name,recipient_email,service_from,service_to,currency,folio_total,
line_position,line_kind,line_description,quantity,unit_amount,line_total,
service_on,source_type,source_id,source_revision,payment_reference_ids,
payment_reference_amounts
```

Dates are `YYYY-MM-DD`; money and quantities are exact decimal strings. Payment
references are sorted by payment ID; IDs and amounts are joined with `;` in the
same order, with the folio currency applying to every amount. Empty optional
values are empty cells, never fabricated defaults. The export reflects the
selected immutable ready revision and records its digest in audit evidence.

This is a stable Vayada handoff format, not a provider-specific import contract
or a claim that every jurisdiction's official-invoice fields are complete.

All CSV exports use the same property, date, filter, currency, and authorization
scope as the originating read. Untrusted cells are neutralized against
spreadsheet-formula execution. Filenames contain no guest PII, downloads expire,
and export audit records do not contain the CSV body.

## Authorization and errors

- Reads and exports require `pms.finance.read`; folio writes require
  `pms.finance.manage` and active `module:financials` entitlement.
- Only `owner` and `finance_manager` relationships are eligible.
- `enforceRoutePolicy` runs before validation, folio access, or idempotency
  lookup. Authorized property lookup follows the common `401/403/404` boundary.
- Malformed input is `400`; revision/idempotency conflicts are `409`; missing or
  mismatched booking/payment/source evidence is `422`.
- Recipient data is encrypted at rest, excluded from logs, and returned or
  exported only through an authorized property scope.

## Acceptance examples

| Scenario                 | Required result                                                           |
| ------------------------ | ------------------------------------------------------------------------- |
| Prepare folio            | Server-calculated draft with source references and no official number.    |
| Mark ready               | Immutable revision; UI still labels it Folio/Statement.                   |
| Matching retry           | Same result and no duplicate revision or export.                          |
| Correction               | New revision; prior revisions derive `superseded` and remain unchanged.   |
| Cross-property evidence  | Denied before data or idempotency evidence is disclosed or mutated.       |
| CSV formula text         | Neutralized without altering the stored folio evidence.                   |
| Official invoice request | Not an MVP capability; no local number, PDF, or provider call is created. |

## Changes to existing tickets

| Ticket   | MVP treatment                                                                  |
| -------- | ------------------------------------------------------------------------------ |
| VAY-1125 | Keep folios, immutable revisions, lines, payment references, and constraints.  |
| VAY-1170 | Keep folio/revision schema; derive `superseded` instead of storing it.         |
| VAY-1171 | Keep normalized source/payment evidence; remove accounting/tax mapping fields. |
| VAY-1172 | Cancel invoice allocation and supplier-invoice aggregate work.                 |
| VAY-1173 | Cancel invoice document and delivery aggregate work.                           |
| VAY-1174 | Close the official-invoice allocation slice.                                   |
| VAY-1175 | Close supplier-invoice headers; supplier bills remain expense evidence.        |
| VAY-1176 | Close Vayada official-invoice PDF storage.                                     |
| VAY-1177 | Close Vayada official-invoice delivery.                                        |
| VAY-1132 | Build folio list/detail/write/ready/archive APIs only.                         |
| VAY-1133 | Defer until an accounting provider is selected.                                |
| VAY-1134 | Build CSV exports only; do not retrieve or render official invoice PDFs.       |
| VAY-1137 | Build the Folios and accounting-export UI; remove official-invoice actions.    |

## Implementation sequence

1. Accept this boundary and revise the affected tickets.
2. Land the operational folio header, revision, line, and payment-reference
   schema without an active UI.
3. Add property-scoped folio APIs and CSV exports.
4. Build the Folios UI behind inactive `module:financials` entitlement.
5. Pilot the Financials module and record which accounting products properties
   already use and whether an integration justifies its cost.

A provider adapter begins only after a separate decision names the provider,
supported countries, pricing owner, required accounting mappings, and pilot
property. It is not a VAY-1092 activation requirement.
