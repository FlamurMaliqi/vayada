# Channex property adoption proof contract

_VAY-1320 decision record. Builds on
[`pms-channex-management-contract.md`](pms-channex-management-contract.md) and
[`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md)._

## Status

The proposed proof contract is review-ready. Product, design, and security
acceptance are still required. Executing or implementing an adoption remains
blocked until that acceptance is recorded and a product-authorized property
owner supplies one exact target property / external Channex property pair and
proves provider control as described below.

No existing production pair is sanctioned by current evidence. In particular,
target property `7e74ee43-517f-47bd-9167-6733568fea71` has no authoritative link
to any audited legacy Channex binding and must not be paired by name, address,
or operator guesswork.

## Decision

Adoption requires an ephemeral Channex API key scoped to exactly one property.
The Channex billing account owner creates the key, selects only the external
property being adopted, provides the key for one synchronous verification
request, and revokes it immediately after the result. Channex's current
documentation says non-billing owners cannot access API-key management.

Channex documents that API keys may cover all properties or selected
properties, that a selected-property key can access only those properties, and
that keys can be withdrawn. Its Properties API returns the properties available
to the caller and rejects access to a property outside that key's scope.
Channex also states that a key has the same powers as its user, so the proof key
must be treated as write-capable even though Vayada uses it only for two reads.

The production-wide Vayada key proves only account-level access. It must never
be accepted as tenant proof.

Primary provider references:

- [Channex API key access](https://docs.channex.io/application-documentation/api-key-access)
- [Channex Properties API](https://docs.channex.io/api-v.1-documentation/hotels-collection)

## Rejected alternatives

- **Caller-supplied external property ID:** rejected because any authorized PMS
  manager could otherwise bind another tenant's provider property.
- **Name, address, slug, group, or contact similarity:** corroboration only;
  these fields are mutable and are not a Vayada tenant identifier.
- **Provider title/group challenge:** rejected as the default because it mutates
  a live provider property before control is established.
- **Ops-signed manifest:** allowed only after an authoritative legacy-owner to
  target-organization record exists. The current audit found no such link, so
  this is not an available proof method today.

## Threat model

The contract must prevent:

- a property manager adopting a different tenant's external property;
- an account-wide Vayada credential being mistaken for tenant proof;
- a multi-property proof key being narrowed only by a caller-supplied ID;
- concurrent commands binding one external property to multiple targets;
- replay after the actor loses property access or the target changes owner;
- rebinding an external property with unresolved historical booking evidence;
- proof secrets leaking through logs, traces, queues, errors, analytics, audit,
  or support tooling;
- adoption enabling target booking, ARI, webhook, or provider mutation before a
  separate cutover authorizes it.

## Authorized operator flow

1. Resolve the authenticated `RequestContext` and require:
   - `pms.operations.manage`;
   - an active `pms:property-management` entitlement for the exact target;
   - a linked `pms_property` resource for the exact target;
   - an `owner` or `operator` relationship. `front_desk` is not sufficient.
2. Accept `targetPropertyId`, `externalPropertyId`, `commandId`, and
   `idempotencyKey`, plus the proof key in the dedicated redacted
   `X-Channex-Proof-Key` header over TLS. Reject the request before provider
   access if any authorization or command identity check fails.
3. Use the proof key to paginate `GET /api/v1/properties`. Require
   `meta.total === 1`, exactly one returned property across all pages, and an
   exact case-sensitive ID match with `externalPropertyId`.
4. Use the proof key to read `GET /api/v1/properties/:id`. Require the same ID
   and a successful response. A list/detail mismatch fails closed.
5. Independently read the same property with the canonical platform key.
   Require the same provider ID and the same normalized stable fields. This
   confirms that the provider object belongs to the production Channex account;
   it does not replace the tenant proof in steps 3 and 4.
6. Re-resolve authorization immediately before persistence. In one serialized
   transaction, reject if:
   - the target has a current or conflicting Channex binding;
   - the external ID is currently reserved or bound by another target;
   - authoritative binding history for either side is `conflict` or `unknown`;
   - organization/resource ownership changed after initial authorization;
   - command/idempotency replay does not match the original request fingerprint.
7. Persist a verified, non-active binding claim plus secret-free audit evidence.
   Do not write the external ID into the active connection row, enqueue a
   provider job, or include the proof key in a durable command.
8. The Channex billing account owner withdraws the proof key immediately.
   Vayada reports success or failure without echoing any portion of the key.

The route may perform the read-only proof synchronously through a dedicated
integration verifier. This is a narrow exception to normal durable Channex
management commands because putting the proof secret in a queue or job payload
would violate the secret contract. The route handler itself must still delegate
provider access to the integration boundary rather than calling `fetch`
directly.

## Provider comparison

Normalize only stable property fields before hashing:

- provider property ID;
- active state;
- title;
- currency;
- country, state, city, address, and postal code;
- timezone and property type;
- sorted provider group IDs.

Exclude transport metadata, pagination, request IDs, photos, and field order.
Hash canonical JSON with SHA-256 for both proof-key and platform-key responses;
the normalized values must be equal before persistence.

## Secret handling and audit

- The proof key may transit the target API only for this synchronous
  verification over TLS.
- Configure ingress and application logging to redact the dedicated proof
  header before the route can be enabled.
- The verifier may call only the configured Channex origin and the two `GET`
  property endpoints above. It must reject redirects so the proof header cannot
  be forwarded to another host.
- Never persist the key in PostgreSQL, a job, idempotency payload, audit body,
  trace, metric, analytics event, exception, or test fixture.
- Keep only a SHA-256 fingerprint of the key for replay/correlation evidence.
- Record actor/user ID, organization ID, target property ID, external property
  ID, proof method, key fingerprint, both normalized response hashes,
  command/idempotency IDs, timestamps, pre-state, result/reason, and any
  rollback actor/result.
- Store the event with `retention_class = security` and
  `privacy_scope = restricted` for seven years. Retain no proof secret.

## Binding and cutover state

Adoption creates a verified, non-active binding claim. It does not create or
activate a `pms.channel_connections.external_property_id` binding. The adoption
path must not reuse the existing `enable` operation, which may create or mark a
provider property connected. Adoption must not:

- provision, rename, regroup, or delete provider resources;
- import or acknowledge bookings;
- push ARI or install provider applications;
- change webhook configuration;
- stop legacy polling or change legacy booking ownership.

The implementation must add an atomic binding-claim registry, with database
uniqueness for provider plus external property ID and for one live Channex claim
per target property. The registry is the canonical reservation boundary for
every path that stores or activates an external property ID, including adoption,
the existing `enable` checkpoint, cutover, migrations, and manual repair. Each
path must acquire the same reservation in its binding transaction and reject a
reservation owned by another target. Adoption must remain disabled until this
cross-path invariant is enforced.

Existing `pms.channel_connections` only guarantees one provider row per target
property; it does not prevent one Channex external ID from being used by two
target properties, and its current `enable` flow can mark an existing external
ID connected without another provider request. A connection row must therefore
reference a matching registry reservation, or an equivalent database constraint
or trigger must make bypass impossible.

The registry retains binding history and classifies a lookup as `clear`,
`conflict`, or `unknown`. Initial backfill must cover every non-null target
`pms.channel_connections.external_property_id` and every retained target binding
record or audit source. Backfill validation must prove coverage of all durable
target paths that could have stored an external ID; incomplete coverage is
`unknown`, not `clear`. A prior association with another target is an
unconditional conflict. Any future transfer requires a separate reviewed
ownership-release contract defining approvers, authoritative ownership evidence,
atomic consumption, audit, and retention; this adoption contract grants no such
exception.

A separate reviewed cutover command may promote a verified claim into
`pms.channel_connections`. Promotion must recheck authorization, claim state,
legacy ownership, scheduler/webhook freeze gates, and external-ID uniqueness in
one transaction. It is not part of adoption.

## Failure and rollback

Every ambiguous, multi-property, missing-property, mismatched-response,
already-bound, cross-property, cross-organization, stale-authorization,
provider-error, timeout, or persistence-conflict outcome fails closed with no
partial binding.

Rollback changes only the target binding claim to a retained `released` state,
leaves the target connection absent or `disconnected`, and records a restricted
audit event. A released claim remains binding history, is not an ownership
release, and does not authorize another target to adopt the external property.
It does not mutate Channex, delete provider mappings, replay or acknowledge
bookings, or stop legacy polling. Legacy ownership remains active throughout
adoption and rollback.

## Adoption-command acceptance criteria

- The route uses `enforceRoutePolicy` and covers the full denial matrix.
- Only `owner` and `operator` relationships may adopt; `front_desk` is denied.
- A proof key exposing zero or more than one property is denied.
- List and detail proof responses must identify the requested external property.
- Proof-key and canonical-key normalized property responses must match.
- The verifier permits only the configured Channex origin and required `GET`
  endpoints and rejects redirects.
- The proof key is redacted at ingress and never reaches durable storage.
- Authorization and ownership are rechecked in the binding transaction.
- Concurrent attempts cannot bind one external property to two targets.
- Adoption, existing enablement, cutover, migration, and repair paths acquire
  the same provider/external-property reservation before storing or activating
  an external ID.
- Existing or retained conflicting bindings fail closed.
- Binding history is `clear`, `conflict`, or `unknown`; `conflict` and `unknown`
  fail closed, and rollback cannot be interpreted as an ownership release.
- Exact idempotent replay returns the original result; payload drift conflicts.
- Success records the secret-free restricted audit evidence defined above.
- Success stores only a non-active binding claim; it does not populate an active
  connection, and legacy booking ownership remains active.
- Rollback removes/disables only target state and is independently audited.
- Tests cover authorization, scoping, mismatch, secret non-persistence,
  adoption-versus-enable concurrency, incomplete history, replay, provider
  failure, rollback-versus-release semantics, and cutover non-mutation.

## QA pair gate

Before implementation or execution, a product-authorized property owner must
record these two non-secret values in VAY-1320:

```text
targetPropertyId: <exact canonical target UUID>
externalPropertyId: <exact Channex property UUID selected by the proof key>
```

The proof key itself must never be posted in Linear, GitHub, Slack, or a test
fixture. Until both IDs are recorded and the Channex billing account owner
confirms that a single-property key can be created for that external property,
the sanctioned QA pair is **none** and Stage B remains blocked.
