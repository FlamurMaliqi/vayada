# PMS Channex management contract

_VAY-1285 contract record. Builds on `channex-webhook-cutover-plan.md`,
`jobs-events-contract.md`, and the PMS-owned channel tables in
`target-schema-ownership-map.md`._

## Boundary

PMS owns Channex connection, provisioning, mappings, connected-channel state,
markups, manual synchronization, messaging installation, and iframe access.
The platform jobs/audit layer owns durable command delivery, attempts, retries,
dead letters, and audit correlation.

This contract does not receive or promote provider webhooks. VAY-844 owns
webhook subscription policy, VAY-845 owns booking-receipt promotion, and VAY-947
owns callback cutover.

## Authorization

Every route is protected with `enforceRoutePolicy`.

- Reads require `pms.operations.read`.
- Commands require `pms.operations.manage`.
- Both require an active `pms:property-management` entitlement and a linked
  `pms_property` resource for the requested property.
- Allowed relationships are `owner`, `operator`, and `front_desk`.

The denial matrix is missing/invalid auth (`401`), missing permission, missing
entitlement, inactive entitlement, and missing linked resource (`403`).

## HTTP surface

All responses carry `contractVersion: "pms-channex-management.v1"`.

| Method | Path                                                              | Purpose                                                     |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/api/pms/properties/:propertyId/channex`                         | Complete management snapshot                                |
| `GET`  | `/api/pms/properties/:propertyId/channex/operations/:operationId` | Durable operation progress/failure                          |
| `POST` | `/api/pms/properties/:propertyId/channex/commands`                | Enable, disable, provision, sync, or install messaging      |
| `PUT`  | `/api/pms/properties/:propertyId/channex/markups`                 | Replace channel markups and enqueue provider reconciliation |
| `POST` | `/api/pms/properties/:propertyId/channex/iframe-session`          | Create a short-lived provider iframe session                |

Commands require `commandId` and `idempotencyKey`. A repeated key with the same
request fingerprint returns the existing operation. A repeated key with a
different fingerprint returns `409 idempotency_conflict`.

## Read model

The snapshot is composed only from target PMS and platform tables:

- `pms.channel_connections` for connection and messaging-install state;
- `pms.channel_room_type_mappings` and `pms.channel_rate_plan_mappings`;
- `pms.channel_sync_status` for booking, ARI, mapping, and message health;
- connection metadata for the last provider-confirmed connected-channel cache;
- `platform.jobs`, attempts, and dead letters for current command progress.

Provider reads refresh target state through a command/job or the iframe flow;
the browser never calls Channex directly. A disconnected property returns a
successful empty snapshot.

## Durable operations

Provider-affecting commands enqueue one job in `pms.channex.management` with a
stable key:

```text
channex.management:<operationType>:property:<propertyId>:<idempotencyKey>:v1
```

The route returns `202` after the job and product audit record commit. Workers
claim jobs with leases, append `platform.job_attempts`, and update the PMS
connection/sync read model only after provider success. Retryable timeouts,
`429`, and `5xx` responses use exponential backoff for at most five attempts.
Invalid state/payload and provider rejection are non-retryable. Exhausted or
non-retryable jobs create `platform.dead_letter_events` and an audit-visible
failure outcome.

Manual ARI and booking sync are commands, not inline work. Booking sync wakes
the pull/feed-owned ingestion path; it does not implement webhook receipt
promotion. Markup changes persist target PMS state and enqueue provisioning/ARI
reconciliation under the same operation.

## Cutover guard

Each command capability is configured as `observe_only` or `mutating`.
`observe_only` keeps reads and operation history available but rejects new
provider mutations with `409 channex_capability_not_mutating`. Target mutation
may be enabled only after the matching VAY-788 legacy route group is
`target-owned` or disabled and the relevant legacy scheduler is frozen.

The snapshot exposes effective capability modes so the PMS UI and rehearsal
evidence do not infer ownership from deployment names.
