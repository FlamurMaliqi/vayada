# Marketplace collaboration lifecycle writes

Contract version: `marketplace-collaboration-lifecycle-writes.v1`.

## Commands

The API supports create, respond, update terms, approve terms, cancel, toggle a
deliverable, and rate a creator. Every command requires an idempotency key and
the same creator-profile or `marketplace_offer` authorization used by reads.

Create accepts `offerId`, optional message, proposed terms, and proposed
deliverables. Hotel invitations identify their target with `creatorId`.
Creator applications derive the creator from the authenticated creator-profile
resource link and require a nonblank `whyGreatFit`, explicit boolean
`consent: true`, a `compensationOptionId` belonging to the offer, at least one
valid deliverable, and a valid ISO travel-date range. The
authenticated organization exclusively determines the initiator side;
`side`/`initiatorSide` request fields are ignored and are not part of the typed
create contract. Creators may apply only to verified offers, while hotel operators
may invite creators from pending or verified offers they operate. The selected
option's terms, summary, eligibility fields, and metadata are copied into an
immutable collaboration snapshot. Pending and negotiating rows are creator
proposals. Once both sides approve, the collaboration becomes the frozen
agreement; later edits to the source offer do not mutate it.

Lifecycle idempotency records are scoped to the selected organization. A replay
is returned only after the stored collaboration is re-authorized against the
caller's current creator-profile or Marketplace-offer resource links. A replay
can never return a response stored for another tenant or command side/resource.

Primary compensation is one of `free_stay`, `paid`, `discount`, or `custom`.
Affiliate participation is represented separately by `affiliateEnabled` and
`affiliateCommissionPercentage`. Accepting a collaboration emits
`marketplace.affiliate.provision.command_requested` only when affiliate is
enabled.

```text
marketplace.affiliate.provision:collaboration:<collaborationId>:v1
```

Lifecycle commands write Marketplace tables and side-effect records only. They
must not write PMS, finance, or affiliate-owned tables directly.

Fixture coverage lives in
`engineering/fixtures/marketplace-collaboration-lifecycle-writes/cases.json`.

## Pending creator application edits (VAY-953)

`PUT /api/marketplace/collaborations/:id/application` uses the creator create
payload and requires `expectedUpdatedAt` from the collaboration read. Only the
owning creator may edit a creator-initiated pending request. It replaces message,
dates, deliverables and the selected compensation snapshot atomically, retaining
the request ID and pending status. The compensation option must belong to the
original offer. Failures roll back all writes. This is separate from negotiating
terms; it does not approve either party's terms.

Lifecycle mutations lock the collaboration before reading its current state.
Responses accept `expectedUpdatedAt` and return 409 on stale versions; clients
refresh details before retrying. Cancel supports `pendingOnly: true` for request
withdrawal and exposes `cancelledBy` in reads. Edits use existing idempotency and
notification records. No legacy route or database is changed.
