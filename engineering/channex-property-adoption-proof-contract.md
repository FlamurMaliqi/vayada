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
property being adopted, and retains it only for the proof handshake. The
handshake first verifies control and stores secret-free pending evidence. A
binding claim may be committed only after the billing owner withdraws the key
and Vayada receives provider-specific evidence that the same key is permanently
inactive. Channex's current public documentation says non-billing owners cannot
access API-key management and documents manual withdrawal, but it does not
document provider-enforced expiry, a key-status API, or a withdrawal receipt.
A generic `401 Unauthorized` is therefore insufficient withdrawal evidence, and
implementation remains blocked until Channex supplies a verifiable permanent
inactivity signal.

Channex documents that API keys may cover all properties or selected
properties, that a selected-property key can access only those properties, and
that keys can be withdrawn. Its Properties API returns the properties available
to the caller and rejects access to a property outside that key's scope.
Channex also states that a key has the same powers as its user, so the proof key
must be treated as write-capable even though Vayada uses it only for the
required property reads and withdrawal confirmation.

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
- a verified claim being committed while its write-capable proof key remains
  active after a timeout, cancellation, or crash;
- adoption enabling target booking, ARI, webhook, or provider mutation before a
  separate cutover authorizes it.

## Authorized operator flow

1. Resolve the authenticated `RequestContext` and require:
   - `pms.operations.manage`;
   - an active `pms:property-management` entitlement for the exact target;
   - a linked `pms_property` resource for the exact target;
   - an `owner` or `operator` relationship. `front_desk` is not sufficient.
2. For the `verify` phase, accept `targetPropertyId`, `externalPropertyId`,
   `commandId`, and `idempotencyKey`, plus the proof key in the dedicated
   redacted `X-Channex-Proof-Key` header over TLS. Reject the request before
   provider access if any authorization or command identity check fails.
3. Extract the inbound proof header into request-local memory, remove it from the
   inbound request/log context, and set Channex's required `user-api-key` header
   only on the allowlisted outbound requests. Do not forward
   `X-Channex-Proof-Key`.
4. Use the proof key to paginate an unfiltered `GET /api/v1/properties`.
   Permit only `pagination[page]` and `pagination[limit]` query parameters;
   never send `filter[id]`, `filter[title]`, `filter[is_active]`, or any
   caller-derived filter. Require a consistent `meta.total === 1` on every page,
   aggregate every returned property, reject duplicate IDs, require exactly one
   property across the full result, and then require its ID to match
   `externalPropertyId` exactly.
5. Use the proof key to read `GET /api/v1/properties/:id`. Require the same ID
   and a successful response. A list/detail mismatch fails closed.
6. Independently read the same property with the canonical platform key.
   Require the same provider ID and the same normalized stable fields. This
   confirms that the provider object belongs to the production Channex account;
   it does not replace the tenant proof in steps 4 and 5.
7. Persist only a `pending_withdrawal` proof record containing the request
   identity, key fingerprint, normalized detail hashes, and secret-free scope
   evidence: verifier policy version, the fixed unfiltered query shape, page
   count, each validated `meta.total`, the observed property-ID set, a canonical
   scope-evidence hash, validation timestamp, and a 15-minute expiry. This record
   is not a binding claim or reservation and contains no proof secret.
8. The Channex billing account owner withdraws the key, then calls the same
   redacted proof route in the `confirm_withdrawal` phase with the same request
   identity and now-disabled proof key. Require its fingerprint to match the
   pending record. In the same confirmation window, require a successful
   canonical-platform-key read of the expected property as a positive control,
   plus a Channex-specific permanent-withdrawal signal bound to the pending key
   fingerprint or provider key identifier. A generic proof-key `401`, `200`,
   redirect, timeout, `5xx`, or any ambiguous response does not prove permanent
   withdrawal.
9. Re-resolve authorization immediately before persistence. In one serialized
   transaction, reject if:
   - the target has a current or conflicting Channex binding;
   - the external ID is currently reserved or bound by another target;
   - authoritative binding history for either side is `conflict` or `unknown`;
   - organization/resource ownership changed after initial authorization;
   - command/idempotency replay does not match the original request fingerprint.
10. Atomically consume the unexpired pending record and persist a verified,
    non-active binding claim plus secret-free audit evidence. Do not write the
    external ID into the active connection row, enqueue a provider job, or
    include the proof key in a durable command. Vayada reports success or failure
    without echoing any portion of the key.

The route may perform the read-only proof synchronously through a dedicated
integration verifier. This is a narrow exception to normal durable Channex
management commands because putting the proof secret in a queue or job payload
would violate the secret contract. The route handler itself must still delegate
provider access to the integration boundary rather than calling `fetch`
directly. Both proof phases use this same synchronous boundary; neither phase
may enqueue the secret.

## Key withdrawal and recovery

- Verification failure or a crash before the pending record commits creates no
  claim. The billing owner must withdraw the key before retrying with a new key
  and command identity.
- A committed pending record must be confirmed before its 15-minute expiry. A
  cancellation or expiry records a secret-free terminal outcome and creates no
  claim; the billing owner still withdraws the key before starting again.
- A successful proof-key read during `confirm_withdrawal` means the key remains
  active and returns `proof_key_still_active` without creating a claim.
- A generic `401`, timeout, `5xx`, redirect, failed positive control, or
  ambiguous response records `withdrawal_unverified` and leaves the pending
  record retryable with the same command identity until expiry. It never creates
  a claim.
- A crash after verifiable permanent-withdrawal evidence is received but before
  the claim commits is retried idempotently. A crash after commit returns the
  committed result on exact replay.
- Operator assertion alone is not withdrawal evidence. The accepted
  provider-specific signal and its binding to the pending fingerprint or key
  identifier require explicit product and security review before implementation.

Acceptable lifecycle evidence is a provider-enforced expiry with a verifiable
expiration or an immutable withdrawn-key status/receipt bound to the exact key.
Temporary user/account suspension, a generic authentication failure, a
screenshot, or an unbound operator attestation is not sufficient. The current
public Channex contract exposes no acceptable signal, so the route must remain
disabled even after the QA pair is supplied unless Channex confirms one.

## Provider comparison

Normalize each detail response's `data` object into this fixed schema:

| Normalized key | Exact Channex path                    | Accepted type                   |
| -------------- | ------------------------------------- | ------------------------------- |
| `id`           | `data.id`                             | canonical UUID string           |
| `isActive`     | `data.attributes.is_active`           | boolean                         |
| `title`        | `data.attributes.title`               | non-empty string                |
| `currency`     | `data.attributes.currency`            | three-letter uppercase string   |
| `country`      | `data.attributes.country`             | string or `null`                |
| `state`        | `data.attributes.state`               | string or `null`                |
| `city`         | `data.attributes.city`                | string or `null`                |
| `address`      | `data.attributes.address`             | string or `null`                |
| `postalCode`   | `data.attributes.zip_code`            | string or `null`                |
| `timezone`     | `data.attributes.timezone`            | string or `null`                |
| `propertyType` | `data.attributes.property_type`       | string or `null`                |
| `groupIds`     | `data.relationships.groups.data[].id` | sorted unique UUID string array |

Reject duplicate JSON object keys before normalization. Every path in the table
must be present with exactly the accepted type; a missing path, wrong type,
invalid UUID, or duplicate group ID fails closed. Preserve string values exactly
as returned, including whitespace and case. Preserve nullable fields as explicit
JSON `null`; never omit a schema key. Sort `groupIds` by Unicode code point and
serialize the normalized object with the table's fixed key order.

Exclude transport metadata, pagination, request IDs, photos, settings, contact
fields, and provider field order. Hash the canonical JSON with SHA-256 for both
proof-key and platform-key detail responses; the normalized objects and hashes
must be equal before a pending record may be created.

## Secret handling and audit

- The proof key may transit the target API only for the synchronous `verify`
  and `confirm_withdrawal` phases over TLS.
- Configure ingress and application logging to redact the dedicated proof
  header before the route can be enabled. Verified production edge/access-log,
  application-log, trace, and error-scrubbing configuration is a route-enable
  gate.
- The verifier maps the extracted inbound `X-Channex-Proof-Key` value to a new
  outbound `user-api-key` header only for the configured Channex origin and the
  required `GET` property endpoints. It removes the inbound header before
  transport and rejects redirects so neither header can reach another host.
- Never persist the key in PostgreSQL, a job, idempotency payload, audit body,
  trace, metric, analytics event, exception, or test fixture.
- Keep only a SHA-256 fingerprint of the key for replay/correlation evidence.
- Record actor/user ID, organization ID, target property ID, external property
  ID, proof method and policy version, key fingerprint, both normalized detail
  hashes, unfiltered query policy, page count, each validated `meta.total`,
  observed property IDs, canonical scope-evidence hash, command/idempotency IDs,
  pending expiry, positive-control and withdrawal-confirmation timestamps and
  outcomes, pre-state, result/reason, and any rollback actor/result.
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

Binding evaluation keeps target reservations separate from the expected legacy
owner. Target reservation history is `clear`, `conflict`, or `unknown`.
Initial backfill must cover every non-null target
`pms.channel_connections.external_property_id` and every retained target
binding/audit source. A prior target association with a different target is an
unconditional conflict, and incomplete target coverage is `unknown`, not
`clear`.

Legacy ownership is independently `matched`, `conflict`, or `unknown`. Its
authoritative inventory must include legacy `channex_connections`
(`hotel_id`, `channex_property_id`, and `is_active`), the owning legacy
`hotels` row, `channex_room_type_mappings`,
`channex_rate_plan_mappings`, `channex_booking_mappings` plus their referenced
`bookings.hotel_id`, and the active `poll_channex_bookings` ownership scope.
Provider property IDs observed only in webhook/audit evidence corroborate that
inventory but cannot establish ownership alone.

For adoption, the external ID must resolve to exactly one active legacy
`channex_connections.hotel_id`; every retained mapping and booking-ownership
record must agree with that hotel; and the sanctioned VAY-1320 pair must link
that derived legacy hotel/external ID to the exact target property and target
organization. Missing sources, disagreement, multiple owners, or an unsanctioned
link is `unknown` or `conflict` and fails closed. The matched legacy owner
remains active throughout adoption and is not treated as a conflicting target
claim.

Any future target transfer requires a separate reviewed ownership-release
contract defining approvers, authoritative ownership evidence, atomic
consumption, audit, and retention; this adoption contract grants no such
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
- Scope enumeration is unfiltered, permits only pagination parameters, and
  aggregates every page before accepting exactly one property.
- List and detail proof responses must identify the requested external property.
- Property detail normalization follows the fixed path/type/null/duplicate rules
  above and never omits a schema key.
- Proof-key and canonical-key normalized property responses must match.
- The verifier permits only the configured Channex origin and required `GET`
  endpoints and rejects redirects.
- The proof key is redacted at ingress and never reaches durable storage.
- Production edge/access logs, application logs, traces, errors, and outbound
  client failures have verified secret redaction before the route is enabled.
- A binding claim is committed only after an unexpired pending proof is matched
  to the same key fingerprint, the canonical-key positive control succeeds, and
  an approved provider-specific signal proves permanent key inactivity. A
  generic `401` leaves the proof pending.
- Authorization and ownership are rechecked in the binding transaction.
- Concurrent attempts cannot bind one external property to two targets.
- Adoption, existing enablement, cutover, migration, and repair paths acquire
  the same provider/external-property reservation before storing or activating
  an external ID.
- Target reservation history and authoritative legacy ownership are reconciled
  independently; only target `clear` plus legacy `matched` may proceed.
- After resolving exact idempotent replay, an existing or retained target
  reservation encountered by a new command, or unknown/conflicting target or
  legacy ownership, fails closed.
- Binding history is `clear`, `conflict`, or `unknown`; `conflict` and `unknown`
  fail closed, and rollback cannot be interpreted as an ownership release.
- Exact idempotent replay returns the original result; payload drift conflicts.
- Success records the secret-free restricted detail, unfiltered-scope,
  positive-control, and withdrawal evidence defined above.
- Success stores only a non-active binding claim; it does not populate an active
  connection, and legacy booking ownership remains active.
- Rollback removes/disables only target state and is independently audited.
- Tests cover authorization, scoping, mismatch, filtered-list rejection,
  multi-property pagination, normalization validation, withdrawal
  success/failure/timeout/cancellation/crash recovery, adoption-versus-enable
  concurrency, legacy/target history reconciliation, replay, provider failure,
  rollback-versus-release semantics, and cutover non-mutation.
- Sentinel-secret tests cover pre-route ingress/access logging, application and
  error logging, traces, analytics, outbound redirect/timeout/`5xx` exceptions,
  jobs, idempotency/audit payloads, and fixture/source artifacts.

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

Supplying that pair does not by itself enable implementation. The accepted
provider-specific permanent-inactivity signal described above is also required;
the current public Channex contract does not provide one.
