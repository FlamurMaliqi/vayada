# Platform admin, dashboard, and intake contract

_VAY-807 PL1 first slice. Covers the non-media route families from
[`booking-pms-route-migration-inventory.md`](booking-pms-route-migration-inventory.md)
and the public contact-form disposition from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md)._

## Purpose

PL1 is the last Booking/PMS rewrite vertical because it touches cross-product
admin reads, Booking dashboard metrics, and public intake side effects.
This contract narrows the first non-media slice so implementation can proceed
without overlapping the platform media work in VAY-821/VAY-826.

This slice does not migrate image uploads, media serving, media imports, or
storage ownership. `POST /upload/images`, Booking design image upload, and
marketplace `/upload/*` remain owned by the platform media track. PMS listing
import routes are retired with the listing import feature.

Fixture cases live in:

```text
engineering/fixtures/platform-admin-dashboard-intake/cases.json
```

## Contract Version

Every target response or command result in this slice carries:

```ts
type Pl1NonMediaContractVersion = "pl1-non-media.v1";
```

Booking dashboard route responses exposed by `apps/api` carry the narrower
route version:

```ts
type BookingDashboardContractVersion = "booking-dashboard.v1";
```

## Platform Authorization

Platform and super-admin behavior moves from `users.is_superadmin` to a
WorkOS-backed `RequestContext` with:

- selected organization kind `platform`;
- active organization membership;
- platform permission grants such as `platform.admin.read`,
  `platform.finance.read`, and `platform.property.status.manage`;
- a linked `platform:platform:vayada` resource;
- audit metadata from `RequestContext.audit`.

`users.is_superadmin` is a migration input and temporary compatibility fallback
only for legacy Python routes. New TypeScript platform routes must not authorize
directly from that flag.

Route families:

| Legacy route                                                   | Target owner                                                     | Target authorization                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /super-admin/bookings`                                    | Platform admin read model over Booking/PMS/Finance projections   | `platform.admin.read` on platform organization                            |
| `GET /super-admin/affiliate-payouts`                           | Platform finance read model                                      | `platform.finance.read` on platform organization                          |
| `GET /super-admin/affiliate-payouts/{affiliate_id}`            | Platform finance read model scoped to affiliate resource         | `platform.finance.read` plus affiliate payout visibility                  |
| `POST /super-admin/affiliate-payouts/{affiliate_id}/mark-paid` | Finance command, exposed through platform admin facade if needed | `platform.finance.command` or another explicit write-scoped finance grant |
| `GET /platform-admin/growth`                                   | Platform growth read model over public-safe aggregates           | `platform.admin.read` on platform organization                            |
| `PATCH /platform-admin/properties/{property_id}/status`        | Catalog/entitlement command                                      | `platform.property.status.manage` on platform organization                |

Platform read models must not open legacy Booking, PMS, Marketplace, or Auth DB
pools as normal route integration. Before cutover, a compatibility adapter may
read legacy sources, but the route contract is target-shaped and must hide
legacy table names and provider secrets.

## Property Lifecycle

Platform property lifecycle uses the contract version
`platform-property-lifecycle.v1` and the Catalog-owned states `provisioning`,
`active`, `suspended`, and `retired`. `profile_status` remains a separate
Catalog completeness/publication input and must not be used as the lifecycle
state.

Canonical target routes are:

| Route                                                              | Behavior                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/platform/admin/properties/provision`                    | Resolve one active hotel-group membership for the intended account, then reuse the canonical property setup creation transaction.     |
| `GET /api/platform/admin/properties/:propertyId/retirement-impact` | Return current organizations, entitlements, bookings, inventory, Finance, media, and public-exposure impact plus blockers.            |
| `PATCH /api/platform/admin/properties/:propertyId/status`          | Apply an allowed non-retirement transition with an expected lifecycle revision.                                                       |
| `POST /api/platform/admin/properties/:propertyId/retire`           | Re-read impact under lock, require explicit confirmation, block unsafe retirement, and remove public access without deleting history. |
| `DELETE /api/platform/admin/properties/:propertyId`                | Return `hard_delete_not_supported`; no target ownership contract authorizes destructive deletion.                                     |

All commands require `platform.property.status.manage`, the platform operator
resource, an `Idempotency-Key`, a non-empty reason, and audit data from
`RequestContext`. An exact retry returns the stored command result. Reusing a
key with a different request is rejected. `expectedLifecycleRevision` prevents
concurrent commands from silently overwriting one another.

Allowed transitions are:

- `provisioning` to `active`, `suspended`, or `retired`;
- `active` to `suspended` or `retired`;
- `suspended` to `active` or `retired`;
- `retired` to `suspended` as the guarded recovery step.

Moving to `active` requires a complete canonical profile. A suspended or
retired property is not public. Recovery does not republish it: Marketplace and
Distribution owners must run their normal reviewed publication commands.
Retirement preserves Catalog facts, organization links, entitlements, Booking
history, PMS inventory, Finance records, media, and immutable publication
revisions. It suspends the active Marketplace submission and hotel profile,
disables public offer projections, marks the Distribution profile unavailable,
and clears the mutable active public Booking revision pointer in the same
transaction as the lifecycle update and audit.

Retirement is blocked while any active guest booking, unresolved payment, open
payout, or connected/degraded channel connection exists. The impact response
must expose the current counts and actionable blocker messages. Draft bookings
are active for this guard. Finance impact reports retained payment, payout, and
billing-entitlement totals separately from unresolved/open blocker counts.
Retained dependencies are visible but are not blockers by themselves.

Booking writers hold a shared Catalog lifecycle lock before inserting a booking.
Lifecycle suspension/retirement and Booking publication use the same
property-scoped publication lock before locking the Catalog property. A queued
publication can activate content only while the locked Catalog lifecycle is
`active` at the lifecycle revision captured by the publication request, so
neither checkout nor a stale projector retry can restore public activity after
retirement or recovery.

Platform provisioning references identify a durable account workflow, not a UI
dialog attempt. The source link records the intended account and original input
fingerprint; reference reuse with a different account or profile is rejected.
The admin list must load canonical property/account bindings successfully before
it offers provisioning; a partial read outage fails closed.

## Booking Dashboard Reads

Canonical target routes:

| Legacy route                              | Target route                                                           | Target source                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /admin/dashboard/stats`              | `GET /api/booking/properties/:propertyId/dashboard/stats`              | `BookingDashboardMetricsReadPort`                                      |
| `GET /admin/dashboard/bookings-by-source` | `GET /api/booking/properties/:propertyId/dashboard/bookings-by-source` | `BookingDashboardMetricsReadPort.getSourceMix`                         |
| `GET /admin/dashboard/sparklines`         | `GET /api/booking/properties/:propertyId/dashboard/sparklines`         | `BookingDashboardMetricsReadPort.getSparklines`                        |
| `GET /admin/dashboard/conversion-funnel`  | Follow-up                                                              | Platform event/read model over Booking Web telemetry                   |
| `GET /admin/dashboard/page-views`         | `GET /api/booking/properties/:propertyId/dashboard/page-views`         | `BookingDashboardMetricsReadPort.getPageViewTimeline`                  |
| `POST /api/events`                        | Retire after dashboard reads consume target events                     | `platform.domain_events` intake already receives Booking Web telemetry |

All protected dashboard routes require:

- `booking.analytics.read`;
- active `booking:booking-engine` entitlement for the target property;
- linked `booking:booking_hotel:{propertyId}` resource with `owner` or `operator`
  relationship.

The first implementation slice exposed stats, source mix, and sparklines only.
The conversion funnel remains a follow-up. VAY-1284 pins the page-view portion
of the target read model over `platform.domain_events` so the dashboard no
longer depends on legacy Booking event reads.

VAY-1284 pins the page-view portion of that target read model:

- Source only `booking_web.page_visit` evidence written by the Distribution
  Booking Web event sink to `platform.domain_events`; legacy Booking events are
  not a runtime fallback.
- Resolve the requested Booking hotel resource through the canonical property
  link. New telemetry resolves the public profile at intake and persists the
  canonical `property_id` with `tenant_scope = 'property'`; the submitted slug
  remains audit evidence, not the authorization boundary. Older external-scope
  events contribute only when their slug has exactly one catalog property owner,
  so ambiguous or reused slug evidence fails closed.
- Bucket `occurred_at` into inclusive requested local dates using the canonical
  `hotel_catalog.property_locations.timezone`. Missing or invalid timezone
  evidence is a read-model error, not an implicit UTC shift.
- Return every date in the requested window, including zero-valued dates. The
  comparison window is the equally sized, immediately preceding window.
- Count one persisted domain event. The event sink's unique source/event key
  collapses retries carrying the same event/idempotency key; session IDs do not
  turn this into a unique-visitor metric.
- Exclude intake classified as `bot` or `test`, plus events explicitly marked
  `isTestData` or `testData`. Older unclassified evidence remains human so the
  target cutover does not erase accepted historical page views.
- Dashboard totals and page-view sparklines use this same predicate and local
  date boundary, so their values reconcile with the detailed timeline.

The conversion-funnel definition and UI remain a separate follow-up; this
contract does not add or reinterpret funnel steps.

Dashboard responses must not include guest PII, PMS operational notes, provider
IDs, or legacy database/table names.

## Public Contact Intake

Legacy marketplace `POST /contact` is a public email side effect. Target
ownership is platform intake via jobs/events:

1. Validate and normalize public form input.
2. Persist a `platform.domain_events` row such as
   `platform.contact_submission.received`.
3. Enqueue `email.platform-contact-notification` with an idempotency key derived
   from form fingerprint, submitted email, and a short time window.
4. Write a `platform.product_audit_events` row with redacted payload by default
   and private payload only where retention allows.
5. Return success after durable intake is committed, not after SMTP delivery.

Target payload:

```ts
type ContactIntakeRequest = {
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  country?: string | null;
  userType?: string | null;
  message: string;
};
```

The target route path remains a follow-up implementation decision so landing can
cut over intentionally. The important contract is that the target route writes
durable intake and email jobs instead of sending SMTP inline.

## Retired PMS Import Workflows

Legacy PMS listing import routes are retired with the listing import feature:
`POST /admin/import/preview`, `POST /admin/import/confirm`, and
`POST /admin/import/images`.

## First Slice Implementation

This PR implements only the Booking dashboard stats/source/sparkline read
adapter in `apps/api`. It intentionally leaves these as follow-ups:

- platform/super-admin read model repositories and routes;
- platform property status command;
- contact intake route and durable email job;
- dashboard conversion reads over platform events;
- non-media PMS import preview/confirm jobs;
- all media upload/import-media behavior.

## Acceptance For Follow-Ups

- Every new protected route uses `enforceRoutePolicy`.
- Platform routes authorize through platform organization membership, not
  `is_superadmin`.
- Dashboard reads use `BookingDashboardMetricsReadPort` or a target event/read
  model, not `PMS_DATABASE_URL`.
- Public contact intake persists jobs/events before returning success and does
  not depend on inline SMTP.
- Non-media import confirm is idempotent and auditable.
- Media routes remain in the platform media track.
