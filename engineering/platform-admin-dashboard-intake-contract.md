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
