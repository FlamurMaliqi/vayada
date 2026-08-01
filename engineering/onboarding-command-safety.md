# Onboarding command safety

This contract standardizes setup writes without adding a generic command
framework. It applies the existing `RequestContext`, route policy, idempotency,
audit, transaction, and outbox primitives to each owning domain command.

`hotel_setup.tracks.update` is the first reference implementation. Later
onboarding commands should adopt the same rules while keeping their
domain-specific repositories and results.

## Route and authorization boundary

Protected setup adapters resolve a typed `RequestContext` and call
`enforceRoutePolicy` before invoking a command repository. For commands with a
body, authorization runs in a route-scoped `onRequest` hook, before Fastify
parses that body; an unauthenticated or unauthorized malformed request therefore
returns the same `401` or `403` denial as a well-formed request. The selected
organization and linked resource come from that authorized context; a browser
sequence, header, email address, or legacy ownership column is not an
authorization boundary.

Authorization is checked on every attempt, including an exact retry. A stored
result is only replayed after the current request is authorized for the same
tenant and operation.

`hotel_setup.tracks.update` is an organization-scoped bootstrap command. It
requires an active hotel-group context and
`hotel_catalog.products.manage`, but it does not require a product entitlement
or linked property: track selection precedes property creation and provisions
the selected product entitlements and resource links. Later property-scoped
setup commands apply their relevant entitlement and linked-resource checks.

## Idempotency identity

Each command requires a caller-generated idempotency key. The stored key is
hashed and scoped by operation plus tenant. Reusing a key is safe only when the
full request fingerprint is unchanged.

For `hotel_setup.tracks.update`, the fingerprint is SHA-256 over this exact
`JSON.stringify` field order:

```json
{
  "organizationId": "<authorized organization>",
  "selectedTracks": ["<ordered track values>"],
  "expectedRevision": 0
}
```

The field order and array order are compatibility-sensitive. Do not replace
this serialization with sorted or canonical JSON.

The fingerprint includes all domain inputs and the expected revision. It
excludes the raw idempotency key, actor and permission snapshot, request ID,
correlation ID, source, receipt time, IP/user-agent data, and other audit or
transport metadata. Those values describe an attempt; they do not change the
requested domain mutation. Operation and organization remain part of the
idempotency lookup scope even where they also appear in the fingerprint.

If the same scoped key has a different fingerprint, the command returns `409`
`idempotency_key_conflict`. This includes a changed payload or changed expected
revision.

## Exact retry result

A completed idempotency row stores the whole command result, including
successful response or typed conflict. An exact retry returns that stored
result unchanged. It does not recompute current setup state, update timestamps,
rerun provisioning, write another audit event, or enqueue another side effect.

An in-progress matching key returns `409` `command_in_progress`; callers retry
with the same request and key. Missing or malformed stored result metadata is
treated as an idempotency conflict, never as permission to repeat the write.

## Revision compare-and-set

Every mutable setup aggregate carries an integer revision. The command compares
`expectedRevision` with the locked current revision. A mismatch returns `409`
`track_revision_conflict` with the current revision and records that typed
result under its idempotency key.

The write also uses the prior revision in its update predicate. Organization
and aggregate locks serialize first writes, while this compare-and-set prevents
a concurrent stale command from overwriting a newer accepted value.

## Atomic transaction envelope

One database transaction contains:

1. idempotency reservation;
2. aggregate lock and expected-revision check;
3. accepted domain writes and domain-owned initialization;
4. the product audit event;
5. any required domain event or outbox intent;
6. the completed idempotency result.

Commit only after every required step succeeds. Any error, including an audit
or outbox insert failure, rolls back all six categories. A retry can then safely
run because neither the domain state nor an orphan idempotency reservation was
committed.

An outbox row is optional only when the command has no asynchronous or external
side effect. If accepted work must leave the transaction boundary, its intent
is required and must be inserted in the same transaction; direct fire-and-forget
calls are not allowed.

## External uncertainty and status reads

Do not add a status endpoint for an ordinary synchronous setup write. A
recoverable status read is justified only for long-running work or an external
operation whose outcome can remain uncertain after the request ends.

Such a read reports persisted states such as `pending`, `succeeded`, `failed`,
or `unknown`, tied to the authorized tenant and stable operation ID. It may
report `succeeded` only from durable local completion evidence or a confirmed,
persisted provider result. A timeout, accepted provider request, missing job,
or successful retry dispatch must never be presented as success.

The fixture vocabulary in
`engineering/fixtures/onboarding-command-safety/cases.json` covers exact retry,
changed payload, changed revision, concurrent stale write, and injected audit
rollback for reuse by later setup commands.
