# Marketplace collaboration lifecycle writes

Contract version: `marketplace-collaboration-lifecycle-writes.v1`.

## Commands

The API supports create, respond, update terms, approve terms, cancel, toggle a
deliverable, and rate a creator. Every command requires an idempotency key and
the same creator-profile or `marketplace_offer` authorization used by reads.

Create accepts `offerId`, `creatorId`, initiator side, optional message, proposed
terms, and proposed deliverables. Pending and negotiating rows are creator
proposals. Once both sides approve, the collaboration becomes the frozen
agreement; later edits to the source offer do not mutate it.

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
