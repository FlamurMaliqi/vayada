# In-app support — VAY-1008

Implements [VAY-1008](https://linear.app/vayadacom/issue/VAY-1008) against the
[TypeScript backend structure](typescript-backend-structure.md). No legacy API changes.

`POST /api/support` accepts `kind` (`support` or `bug`), `message` (1–4000 trimmed
characters), `product` (marketplace, booking, pms, affiliate) and `page` (a local
pathname, at most 500 characters; no query, fragment or URL). Identity and selected
organization come only from the resolved RequestContext. This is an explicit
identity-only exception to product route policy: support requires no paid product
entitlement, resource link or product permission. Authentication still requires an
active resolved identity and organization membership.

The existing PL1 contact intake repository atomically commits the private message,
identity and context to `platform.domain_events`, its notification job to
`platform.jobs`, and its audit record to `platform.product_audit_events`.
Success means stored, not email delivered. The existing notification job has no
proven active delivery consumer; operators retrieve confidential submissions using
the existing platform contact event/job records. No new recipient is configured.
Identical submissions reuse the existing hourly deduplication key; retry across
an hour boundary can produce another request. Response: 201 `{status: "accepted",
reference}`; 400 invalid input, 401 missing/invalid identity, 503 storage failure.
Errors retain the client draft; requests time out after 20 seconds.

The shared form appears in authenticated Marketplace, Booking, PMS and Affiliate navigation.
Legacy builds with `NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=false` hide it.

VAY-1007 remains Backlog and no help/docs page exists in main. The docs navigation
criterion is deferred to that dependency; no unavailable help link is rendered.
The existing `support@vayada.com` reference is in ProfileCompletionScreen, but this
implementation relies on durable intake rather than assuming mailbox delivery.
