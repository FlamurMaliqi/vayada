# Booking/PMS Coupling Audit

_VAY-642 audit record. This document inventories existing Booking, PMS,
Marketplace, Auth, and Channex coupling so the TypeScript rewrite can preserve
the intended product split without copying legacy integration shortcuts._

## Purpose

Vayada wants Booking Engine, PMS, Marketplace, and related platform domains to
stay interchangeable. Vayada PMS must be one PMS implementation behind stable
contracts, not the private backend for Vayada Booking Engine.

This audit covers current legacy runtime coupling across the Python APIs and
Booking Web clients. It does not refactor legacy services, change database
topology, add import-boundary tooling, or define the PMS sink contract. Those
belong to follow-up tickets and the existing architecture records.

## Classification Rules

Each coupling is classified by the target owner from
`engineering/target-schema-ownership-map.md`:

- Booking/checkout: guest-facing quote, checkout, direct-booking lifecycle,
  guest-visible status, cancellation, and change requests.
- PMS operations: rooms, room types, inventory, operational reservations, room
  assignment, check-in/out, and channel connectivity.
- Distribution/bookability: public-safe availability, quote, and bookability
  snapshots.
- Finance: payment settings, payments, payouts, commissions, billing, and
  entitlements.
- Identity/auth: users, organizations, memberships, resource links,
  permissions, and RequestContext.
- Hotel catalog: canonical property identity, profile, contact, location,
  media, amenities, and setup facts.
- Jobs/events/audit: durable jobs, outbox events, retries, sync health, audit,
  and notification delivery.

Target disposition means:

- Keep as migration input: acceptable source data for parity/backfill only.
- Replace with read model/interface: target runtime may consume a typed
  contract, not another product's raw tables.
- Remove from target path: do not copy this integration shape into TypeScript.

## Executive Summary

The TypeScript Booking target path is currently cleaner than the legacy Python
apps: `apps/api/src` exposes an optional `BOOKING_DATABASE_URL` and the Booking
reservation route depends on a repository interface, not PMS tables or Channex
symbols.

The highest-risk legacy couplings are elsewhere:

- PMS API owns guest-facing direct booking routes and checkout behavior while
  also writing PMS operational booking rows.
- Booking Web calls PMS public APIs directly for rooms, unavailable dates,
  payment settings, affiliate clicks, and booking lifecycle operations.
- PMS reads and writes Booking Engine hotel/payment/add-on settings through
  `BookingEngineDatabase`.
- Booking API dashboards and billing quote logic read PMS operational tables
  directly.
- Marketplace collaboration acceptance writes PMS affiliate records directly.
- Channex side effects and guest/host notifications are fired from request-path
  code instead of durable job/event boundaries.
- Product auth still relies on shared `auth-db.users.type`, `is_superadmin`,
  direct `user_id` ownership, and `X-Hotel-Id` shortcuts.

These are acceptable current-system facts and migration inputs. They must not
be treated as target architecture.

## Coupling Inventory

| ID  | Current coupling                                                                                                                                                                                                                                                                                                                  | Direction                                     | Current behavior                                                                                                                                                                                                       | Target owner                                                                       | Target disposition                                                                                                                                                                                                                                                                                                                                                                                                                    | Risk/order |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C00 | `apps/booking-web/services/api/client.ts`, `apps/booking-web/services/api/hotel.ts`, `apps/booking-web/services/api/booking.ts`                                                                                                                                                                                                   | Booking Web calls PMS public API              | Booking Web configures `NEXT_PUBLIC_PMS_URL` and calls PMS for rooms, unavailable dates, affiliate clicks, payment settings, booking create/confirm/lookup/status/cancel/change flows.                                 | Booking/checkout, Distribution/bookability, PMS operations, Finance                | Remove from target path. Booking Web should call Booking/distribution contracts; Vayada PMS stays hidden behind adapters/read models.                                                                                                                                                                                                                                                                                                 | 1          |
| C01 | `apps/pms-api/app/routers/bookings.py`, `apps/pms-api/app/services/booking_service.py`, `apps/pms-api/app/repositories/booking_repo.py`                                                                                                                                                                                           | PMS API owns Booking flow                     | Public guest booking, lookup, payment settings, cancellation, and change request routes live in PMS API and create/update PMS `bookings` rows.                                                                         | Booking/checkout plus PMS operations                                               | Remove from target path. Booking owns guest booking lifecycle and hands off to PMS reservation sink. PMS owns operational reservation state.                                                                                                                                                                                                                                                                                          | 2          |
| C02 | `apps/pms-api/app/services/hotel_identity_service.py`                                                                                                                                                                                                                                                                             | PMS API reads/writes Booking DB               | PMS reads Booking hotel name, currency, payment flags, terms, add-ons, and updates currency, add-on prices, payment flags, and instant-book flags in Booking DB.                                                       | Hotel catalog, Booking/checkout, PMS operations, Finance, Distribution/bookability | **[VAY-652]** Replace hotel identity reads with `HotelIdentityReadPort` from `@vayada/domain-hotels`. Replace payment reads and writes with `PaymentSettingsReadPort` and `UpdatePaymentMethodsCommand` from `@vayada/domain-finance`; route the property pricing-currency write to the PMS-owned `pms.setPropertyPricingCurrency` target contract. Cross-domain writes become typed commands with idempotency keys and audit trails. | 3          |
| C03 | `apps/pms-api/app/services/payout_service.py`                                                                                                                                                                                                                                                                                     | PMS API reads/writes Booking DB               | PMS reads billing plan, commission defaults, platform status, and pending billing switch state from Booking DB; it updates pending billing switch fields.                                                              | Finance                                                                            | **[VAY-652]** Replace billing plan reads with `BillingConfigReadPort` from `@vayada/domain-finance`. Replace payout calculation with `calculatePayoutSplit()`. Replace billing plan writes with `UpdateBillingPlanCommand`. Pending billing switch state moves to a Finance-owned scheduler, not inline Booking DB mutation.                                                                                                          | 4          |
| C04 | `apps/booking-api/app/repositories/dashboard_repo.py`                                                                                                                                                                                                                                                                             | Booking API reads PMS DB                      | Booking dashboard queries PMS `bookings` for revenue, next arrival, source mix, sparklines, and combines that with Booking `booking_events`.                                                                           | Booking/checkout read model, PMS operations read model, Finance                    | **[VAY-651]** Replace with `BookingDashboardMetricsReadPort` from `@vayada/domain-booking`. Revenue, booking count, avg rate, source mix, sparklines, and live-since date are Booking-owned metrics; next arrival comes from `PmsOperationalReservationReadPort`. TypeScript Booking routes must inject the port and never open `PMS_DATABASE_URL`.                                                                                   | 5          |
| C05 | `apps/booking-api/app/services/billing_service.py`                                                                                                                                                                                                                                                                                | Booking API reads PMS DB                      | Billing quote counts active PMS rooms by joining PMS `rooms` and `room_types`.                                                                                                                                         | Finance plus PMS operations read model                                             | **[VAY-651]** Replace with `RoomInventoryReadPort` from `@vayada/domain-pms`. The PMS adapter implements the port; Finance billing consumes `getRoomInventorySnapshot()` to price fixed-plan subscriptions. No TypeScript Booking or Finance code opens `PMS_DATABASE_URL` for this query.                                                                                                                                            | 6          |
| C06 | `apps/booking-api/app/services/marketplace_service.py`                                                                                                                                                                                                                                                                            | Booking API reads Marketplace DB              | Booking setup prefill reads Marketplace `hotel_profiles` by `user_id`.                                                                                                                                                 | Hotel catalog                                                                      | Replace with canonical property/profile read model.                                                                                                                                                                                                                                                                                                                                                                                   | 7          |
| C07 | `apps/marketplace-api/app/services/affiliate.py`                                                                                                                                                                                                                                                                                  | Marketplace API writes PMS DB                 | Accepting a Marketplace collaboration finds a PMS hotel by `user_id`, inserts a PMS `affiliates` row, then writes referral fields back to Marketplace collaboration state.                                             | Marketplace, Finance, PMS operations                                               | Replace with marketplace collaboration event and affiliate/commission provisioning boundary. Do not write PMS tables from Marketplace. VAY-653 defines the command/port boundary in @vayada/domain-marketplace (ProvisionCollaborationAffiliateCommand, CollaborationAffiliatePort). affiliate.py must be wired to this port before the Python service is retired.                                                                    | 8          |
| C08 | `apps/pms-api/app/services/channex/inbound.py`                                                                                                                                                                                                                                                                                    | Channex/PMS reads Booking DB                  | Channex inbound booking handling reads Booking notification preferences/contact email before creating PMS booking rows and sending OTA booking alerts.                                                                 | PMS operations, Jobs/events/audit, Notifications/settings                          | Keep Channex ingestion PMS-owned, but replace Booking DB preference reads with a notification/settings read model and durable delivery job.                                                                                                                                                                                                                                                                                           | 9          |
| C09 | `apps/pms-api/app/routers/admin_bookings.py`, `apps/pms-api/app/routers/admin_room_blocks.py`, `apps/pms-api/app/services/booking_change_service.py`, `apps/pms-api/app/services/scheduler.py`                                                                                                                                    | Request-path code triggers Channex/email/jobs | Admin booking, room-block, and guest change flows call Channex ARI pushes, email sends, payout jobs, and polling tasks with request-path or scheduler-side effects.                                                    | Jobs/events/audit plus PMS operations                                              | Replace with durable jobs/outbox events for sync, notification, payout, and audit effects.                                                                                                                                                                                                                                                                                                                                            | 10         |
| C10 | `apps/pms-api/app/repositories/platform_admin_repo.py`                                                                                                                                                                                                                                                                            | PMS API reads/writes Booking DB               | Platform admin views read Booking hotels/events, update Booking `platform_status`, and combine PMS booking metrics with Booking page views.                                                                            | Platform admin, Hotel catalog, Booking/checkout, Finance                           | Replace with platform admin read models and explicit catalog/entitlement commands.                                                                                                                                                                                                                                                                                                                                                    | 11         |
| C11 | `apps/pms-api/app/dependencies.py`, `apps/booking-api/app/dependencies.py`, `apps/marketplace-api/app/dependencies.py`, `apps/booking-api/app/repositories/user_repo.py`, `apps/marketplace-api/app/repositories/user_repo.py`, `apps/marketplace-api/app/routers/admin/users.py`, `apps/pms-api/app/routers/admin_affiliates.py` | Product APIs read/write shared Auth DB        | Product auth checks read `auth-db.users`, often using `users.type`, `is_superadmin`, direct product `user_id`, and `X-Hotel-Id`; product flows also create/update/delete users, passwords, statuses, and reset tokens. | Identity/auth                                                                      | Keep auth DB as migration input. Target uses WorkOS-backed identity, organization memberships, resource links, permissions, user-lifecycle commands, and RequestContext. VAY-656 defines the command contract in `engineering/identity-user-lifecycle-commands.md`.                                                                                                                                                                   | 12         |
| C12 | `docker-compose.yml`, `apps/*-api/app/config.py`, `apps/*-api/app/database.py`                                                                                                                                                                                                                                                    | Runtime cross-DB pools                        | Legacy services carry optional cross-product database URLs such as `PMS_DATABASE_URL`, `BOOKING_ENGINE_DATABASE_URL`, and `MARKETPLACE_DATABASE_URL`.                                                                  | Platform/runtime boundaries                                                        | Do not reproduce as normal TypeScript runtime topology. Use one target DB with schema ownership or explicit service/read-model interfaces.                                                                                                                                                                                                                                                                                            | 13         |
| C13 | `apps/api/src/routes/bookingReservations.ts`, `apps/api/src/config.ts`                                                                                                                                                                                                                                                            | TypeScript target Booking route               | Current TS Booking reservation route accepts a product-level repository interface and does not depend on `PMS_DATABASE_URL` or Channex.                                                                                | Booking/checkout                                                                   | Preserve. Future repository implementations must stay behind Booking-owned interfaces/read models.                                                                                                                                                                                                                                                                                                                                    | Guardrail  |

## Migration and Backfill Inputs

These scripts are useful source-history or parity tools, but they are not target
runtime patterns:

| Script                                                         | Current purpose                                                            | Target treatment                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/booking-api/scripts/backfill_benefits_from_pms.py`       | Copies PMS hotel benefits into Booking `booking_hotels.benefits`.          | Migration input only. Target property amenities belong to hotel catalog.                                            |
| `apps/pms-api/scripts/sync_hotel_names_from_booking_engine.py` | Syncs canonical Booking hotel name/slug into stale PMS hotel copies.       | Migration input only. Target property identity belongs to hotel catalog with source links.                          |
| `apps/pms-api/scripts/unify_hotel_ids.py`                      | Aligns PMS hotel IDs with Booking hotel IDs and rewrites PMS foreign keys. | Migration input only. Target uses canonical property IDs and `property_source_links`/`organization_resource_links`. |

## Channex Boundary Notes

Channex remains PMS-owned in the target architecture because it distributes
availability, rates, restrictions, and OTA reservations to a PMS-style system.
The risky part is not that PMS talks to Channex. The risky part is request-path
code combining Channex sync, Booking settings reads, notification delivery,
payout side effects, and PMS booking mutation in one flow.

Target Channex shape:

- PMS adapter owns Channex property, room, rate, availability, restriction, and
  channel booking mappings.
- Inbound Channex revisions produce PMS operational reservation events and, when
  guest-visible state is needed, Booking-domain booking events.
- ARI pushes, retries, webhook processing, notification delivery, and audit
  entries move through jobs/events with idempotency keys and retry visibility.
- Booking Engine does not import Channex code, mention Channex route contracts,
  or require Channex IDs except as opaque external references exposed by a PMS
  integration contract.

## Removal and Replacement Order

1. Preserve the TypeScript Booking guardrail: no `PMS_DATABASE_URL`, Channex
   symbols, PMS table names, or PMS implementation imports in Booking route
   adapters.
2. Move Booking Web public flows behind Booking/distribution APIs instead of
   direct PMS public API calls.
3. Land the PMS reservation sink contract and route direct booking creation
   through a Booking-owned handoff instead of PMS public checkout routes.
4. Split guest booking state from operational reservation state. Booking owns
   guest-visible lifecycle and change requests; PMS owns assignments,
   check-in/out, operational notes, and channel mapping state.
5. Replace PMS `BookingEngineDatabase` reads/writes for hotel identity, payment
   settings, add-ons, terms, billing, and commissions with catalog, finance,
   distribution, and booking read models or commands.
6. Replace Booking API PMS dashboard and billing reads with curated metrics and
   entitlement snapshots.
7. Replace Marketplace-to-PMS affiliate writes with an event/service boundary.
8. Replace fire-and-forget Channex/email/payout side effects with durable
   jobs/events and audit records.
9. Replace product auth shortcuts and product-owned Auth DB writes with
   WorkOS-backed user-lifecycle commands, RequestContext,
   organization memberships, resource links, permissions, and entitlement read
   models.
10. Retire legacy cross-product database URL wiring after the TypeScript target
    path has equivalent read models, commands, parity coverage, and rollout
    gates.

## Recommended Follow-Up Tickets

Existing related tickets already cover part of the removal plan:

- VAY-640: package-level import boundaries for TypeScript domains.
- VAY-641: PMS reservation integration contract for Vayada PMS and external PMS
  adapters.
- VAY-612: public bookability contract for public-safe hotel/profile/quote
  reads.
- VAY-644: Booking-to-PMS handoff service for direct bookings.

Additional migration slices created from this audit:

| Issue                                                                               | Why it is needed                                                                                                                                                           | Couplings covered |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| VAY-655: Route Booking Web public flows through Booking and distribution APIs       | Defines `engineering/booking-web-public-api-routing.md` and removes Booking Web dependency on PMS public APIs for rooms, payment settings, bookings, and affiliate clicks. | C00, C01          |
| VAY-651: Replace Booking dashboard PMS DB reads with metrics read models            | Removes Booking API dependency on PMS operational tables for revenue/source/arrival dashboards.                                                                            | C04, C05          |
| VAY-652: Move PMS hotel identity and payment settings off Booking DB reads/writes   | Removes the broadest PMS to Booking database dependency before target schema cutover.                                                                                      | C02, C03, C10     |
| VAY-653: Replace Marketplace-to-PMS affiliate provisioning cross-DB write           | Keeps Marketplace collaboration lifecycle independent from Vayada PMS implementation tables.                                                                               | C07               |
| VAY-654: Move Channex-triggered notifications and ARI side effects into jobs/events | Makes Channex sync, email, payout, and audit side effects retryable and observable.                                                                                        | C08, C09          |
| VAY-656: Move product-owned Auth DB writes behind identity user-lifecycle commands  | Prevents Booking, Marketplace, and PMS product flows from mutating identity tables directly.                                                                               | C11               |

The legacy product auth shortcut risk is covered by VAY-608 RequestContext
direction, identity-schema follow-up work such as VAY-616, and VAY-656 for
product-owned Auth DB writes.

## Acceptance for Future PRs

Any future implementation PR touching booking, PMS, availability, Channex,
payments, or tenant/auth boundaries should answer these review questions:

- Does the change preserve Vayada PMS as one interchangeable PMS adapter?
- Is every cross-domain read represented as a read model or interface, not a raw
  table or legacy database pool?
- Is every cross-domain write represented as a command/event with idempotency
  and audit when it affects bookings, inventory, payments, or channel sync?
- Are migration/backfill scripts clearly separated from target runtime code?
- Did an independent subagent adversarial review run before PR finalization?
