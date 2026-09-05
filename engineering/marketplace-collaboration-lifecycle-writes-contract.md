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
original offer. Edits also enforce the property-local date and current offering
availability checks from VAY-954. Failures roll back all writes. This is separate from negotiating
terms; it does not approve either party's terms.

Lifecycle mutations lock the collaboration before reading its current state.
Responses accept `expectedUpdatedAt` and return 409 on stale versions; clients
refresh details before retrying. Cancel supports `pendingOnly: true` for request
withdrawal and exposes `cancelledBy` in reads. Edits use existing idempotency and
notification records. No legacy route or database is changed.

## Property-local collaboration dates (VAY-954)

Creator applications require concrete ISO start/end dates, with end after start.
Create and terms edits reject past dates with “Collaboration dates cannot be in
the past.” Today is allowed, using the property's IANA timezone from the catalog
public-profile read model. Missing/invalid timezone blocks the write with an
availability error; browser or server timezone is never a fallback. Edits validate
the merged stored/requested dates, so omitting expired dates cannot bypass validation.
Replacing both travel dates clears superseded preferred dates; otherwise edits also
validate the retained preferred-date pair.
Existing idempotent replays remain replays rather than new applications.

Month-only offering availability is evaluated against the remaining months of the
current property-local year: an option containing only earlier months blocks new
applications with an availability restriction. This intentionally tightens the
legacy behavior; the schema has no year attached to these month names.
