# Target schema ownership map

_VAY-609 contract record. Builds on VAY-600, VAY-602, VAY-603, VAY-605,
VAY-607, and VAY-608._

## Purpose

This document converts the VAY-605 database restructure plan into a table-level
ownership map for the planned target schema. It is not production DDL and does
not move data. Its job is to make later DDL and migration tickets answer one
review question at a time: which domain owns this table, which source data feeds
it, and which other domains may consume it.

The target schema should be built for Vayada's domain model, not for the current
auth/marketplace/booking/PMS database split. Current production databases remain
source of truth until the reviewed cutover window.

## Ownership Rules

- Every target table or read model has exactly one write owner.
- Other domains consume typed services, read models, or domain events.
- No TypeScript domain may open another domain's raw tables or legacy database
  pool as normal integration.
- Legacy authorization shortcuts such as `X-Hotel-Id`, `users.type`,
  `users.is_superadmin`, and direct product `user_id` ownership are migration
  inputs only. They are not target tables, target authorization primitives, or
  TypeScript route contracts.
- External provider IDs are preserved where they are business-critical, but
  they do not replace Vayada internal IDs.
- Tables that expose public or AI-readable data must state their public/private
  posture before DDL is written.
- Booking Engine and PMS ownership follows
  `engineering/booking-pms-domain-boundaries.md`: Booking Engine owns
  guest-facing direct-booking contracts; PMS owns operational inventory,
  reservations, room assignment, and channel connectivity. Vayada PMS is one PMS
  implementation, not the Booking Engine backend.

## Topology Posture

Default planning posture: one physical target Postgres database with schemas per
domain:

```text
identity
catalog
booking
pms
marketplace
finance
distribution
intelligence
platform
```

This keeps the big-bang cutover operationally simpler while preserving explicit
domain ownership. If Vayada later chooses multiple physical databases, the
table ownership below should stay the contract and the migration harness must
prove the same parity and access boundaries across physical connections.

Open topology questions before DDL:

- Should audit and jobs live in one `platform` schema or separate `audit` and
  `jobs` schemas?
- Which tables need tenant-local sequences versus globally generated UUIDs?
- Should public bookability snapshots be regular tables, materialized views, or
  generated cache rows with explicit freshness metadata?
- Which target tables require row-level retention rules before production
  cutover?
- Which read models can be rebuilt from authoritative tables versus migrated
  directly from source snapshots?

## Target Owner Map

### Identity and Authorization

Owner package: `domain-identity` with infrastructure support from
`backend-auth` and `backend-authorization`.

| Target table or read model        | Owner                    | Source migration histories / current tables                                                                                     | Notes                                                                                        |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `users`                           | Identity/auth            | `auth-db/migrations`: `users`; legacy marketplace `users` only as historical migration input if any rows remain.                | Preserve `users.id` as internal principal. No product `type` authorization.                  |
| `external_identities`             | Identity/auth            | WorkOS backfill plus `auth-db.users.email`; provider metadata.                                                                  | Maps WorkOS IDs to internal users.                                                           |
| `organizations`                   | Identity/auth            | Existing user ownership on booking hotels, PMS hotels, marketplace hotel profiles, creators, affiliates, and platform staff.    | Organization kinds: `platform`, `hotel_group`, `creator_workspace`, `affiliate_partner`.     |
| `organization_memberships`        | Identity/auth            | Existing owner/admin user associations, WorkOS memberships, migration transforms from `users.type` and `is_superadmin`.         | `users.type` and `is_superadmin` are transform inputs only.                                  |
| `permission_catalog`              | Identity/auth            | VAY-600/VAY-608 permission contract, not legacy tables.                                                                         | Stable permission keys such as `booking.settings.manage` and `platform.user.suspend`.        |
| `role_permission_grants`          | Identity/auth            | VAY-600 role model, WorkOS role slugs, product role decisions.                                                                  | Grants permissions by organization kind and role.                                            |
| `membership_permission_overrides` | Identity/auth            | Future admin exceptions.                                                                                                        | Optional; can be deferred until role grants are insufficient.                                |
| `organization_resource_links`     | Identity/auth            | `booking_hotels.user_id`, PMS `hotels.user_id`, marketplace `hotel_profiles.user_id`, `creators.user_id`, `affiliates.user_id`. | Links organizations to product resources. Direct `user_id` ownership is not carried forward. |
| `product_entitlements`            | Identity/auth read model | Finance-owned `billing_entitlements`, product module state, platform status.                                                    | RequestContext entitlement read model only; finance/product domains own upstream writes.     |
| `auth_reconciliation_events`      | Identity/auth            | WorkOS webhooks and migration/linking runs.                                                                                     | Provider reconciliation, not product audit.                                                  |
| `request_context_resource_scope`  | Identity/auth read model | `organization_memberships`, `permission_catalog`, `organization_resource_links`, entitlements.                                  | Read model for RequestContext resolution and tests.                                          |

Identity-owned user lifecycle commands are defined in
[`identity-user-lifecycle-commands.md`](identity-user-lifecycle-commands.md).
Target product domains request `identity.user.*`, `identity.recovery.*`, and
`identity.invite.*` commands instead of writing these tables or legacy Auth DB
tables directly.

Explicitly deferred or retired:

- `password_reset_tokens`, `email_verification_codes`,
  `email_verification_tokens`, `email_change_tokens`, `totp_secrets`,
  `totp_recovery_codes`, and `login_rate_limit` are not target active auth
  systems after WorkOS is authoritative. Retain source snapshots only for
  rollback/audit during the cutover window.
- `cookie_consent`, `consent_history`, and `gdpr_requests` remain Vayada-owned,
  but they belong to identity/privacy retention rather than provider auth.

### Hotel and Property Catalog

Owner package: `domain-hotels`.

Canonical public hotel profile and location ownership is detailed in
[`public-hotel-profile-ownership.md`](public-hotel-profile-ownership.md). That
document is the field-level contract for public identity, address, geo,
timezone, locale, currency, media, amenities, public contacts, and public policy
projection.

| Target table or read model           | Owner                             | Source migration histories / current tables                                                                 | Notes                                                                            |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `properties`                         | Hotel/property catalog            | Booking `booking_hotels`, PMS `hotels`, marketplace `hotel_profiles` and `hotel_listings`.                  | Canonical internal property identity.                                            |
| `property_source_links`              | Hotel/property catalog            | Current product resource IDs from booking/PMS/marketplace.                                                  | Maps canonical property to product-native IDs.                                   |
| `property_slugs`                     | Hotel/property catalog            | Booking slug history, booking custom domains, marketplace listing slugs, PMS hotel identity.                | Owns canonical slug and old slug redirects.                                      |
| `property_locations`                 | Hotel/property catalog            | Booking hotel location/map fields, PMS hotel address/geo/timezone/country/city, marketplace hotel profiles. | Public/private flags per field.                                                  |
| `property_profiles`                  | Hotel/property catalog            | Booking hotel descriptions, marketplace hotel profiles/listings, PMS property details.                      | Normalized descriptive profile facts.                                            |
| `property_media`                     | Hotel/property catalog            | Booking hotel images/branding, marketplace hotel images, PMS room/property media where applicable.          | Source URLs and image ownership.                                                 |
| `property_amenities`                 | Hotel/property catalog            | Booking benefits/amenities, PMS hotel/room type benefits, marketplace requirements/profile fields.          | Catalog facts; room-specific amenities stay with PMS when operational.           |
| `property_contact_channels`          | Hotel/property catalog            | Booking contact fields, PMS hotel phone/email, marketplace hotel profile contact data.                      | Mark fields public/private.                                                      |
| `property_setup_status`              | Hotel/property catalog            | Booking platform status, PMS module activation and setup fields, marketplace completeness fields.           | Source for setup read models; Ask Intelligence consumes snapshots.               |
| `property_product_selections`        | Hotel/property catalog            | Shared setup product-selection intent.                                                                      | Per-property Booking/PMS/Marketplace intent; entitlements remain access/billing. |
| `property_public_profile_read_model` | Hotel/property catalog read model | `properties`, `property_profiles`, `property_locations`, `property_media`, `property_amenities`.            | Consumed by marketplace, distribution/bookability, and landing/public surfaces.  |

### Booking and Direct Checkout

Owner package: `domain-booking`.

| Target table or read model          | Owner                       | Source migration histories / current tables                                                                  | Notes                                                                            |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `quote_sessions`                    | Booking/checkout            | Booking hotel pricing config, PMS room/rate data, promo code inputs, add-ons, payment capabilities.          | Authoritative quote identity, request hash, totals, expiry, and selected offers. |
| `checkout_contexts`                 | Booking/checkout            | Booking-web flow state, quote output, promo/referral state, locale/currency.                                 | Short-lived checkout state for guest flow.                                       |
| `guest_bookings`                    | Booking/checkout            | PMS `bookings`, PMS `booking_rooms`, PMS booking drafts when materialized, booking public references.        | Guest-facing booking lifecycle contract.                                         |
| `booking_guests`                    | Booking/checkout            | PMS booking guest fields, additional guests, booker guest details, guest country, arrival fields.            | Guest PII; private retention rules required.                                     |
| `addon_definitions`                 | Booking/checkout            | Booking `booking_addons`, PMS add-on catalog/configuration fields.                                           | Property-scoped add-on catalog; no guest PII.                                    |
| `booking_settings`                  | Booking/checkout            | Booking `booking_hotels` settings columns for add-ons, guest form, benefits, localization, and room filters. | Target settings read/write model activated behind `BOOKING_SETTINGS_SOURCE`.     |
| `booking_addon_selections`          | Booking/checkout            | Booking `booking_addons`, PMS booking add-on fields, booking add-on quantities/dates.                        | Guest-purchased extras.                                                          |
| `promo_applications`                | Booking/checkout            | Booking `booking_promo_codes`, PMS promo fields, referral inputs.                                            | Applies discounts/referrals to quote or booking.                                 |
| `booking_status_events`             | Booking/checkout            | Booking `booking_events`, PMS `booking_events`, status changes, cancellation/change/check-in/out lifecycle.  | User-visible booking lifecycle history.                                          |
| `booking_change_requests`           | Booking/checkout            | PMS `booking_change_requests`.                                                                               | Guest change/cancellation workflow.                                              |
| `booking_notes_public`              | Booking/checkout            | Public-safe subset of PMS notes/events only when guest-visible.                                              | Private PMS notes remain PMS-owned.                                              |
| `direct_booking_summary_read_model` | Booking/checkout read model | `guest_bookings`, PMS operational assignments, payments, property catalog.                                   | Consumed by PMS, finance, and Ask Intelligence through permissioned views.       |

Booking/checkout must not depend on PMS operational tables, Channex mappings,
or a Vayada PMS database connection as its normal source. It may publish booking
events or call PMS integration interfaces so Vayada PMS or an external PMS can
create/update the operational reservation.

### PMS Operations

Owner package: `domain-pms`.

| Target table or read model          | Owner                     | Source migration histories / current tables                                                                       | Notes                                                                         |
| ----------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `room_types`                        | PMS operations            | PMS `room_types`, room category, benefits, occupancy limits, location fields, pricing fields.                     | Operational room/rate product.                                                |
| `rooms`                             | PMS operations            | PMS `rooms`.                                                                                                      | Physical/operational rooms.                                                   |
| `rate_plans`                        | PMS operations            | PMS rate type, meal plans, rate payment methods, deposit rules, non-refundable/flexible rates.                    | Can feed booking quotes and Channex.                                          |
| `rate_rules`                        | PMS operations            | PMS seasons, daily rates, monthly rates, weekend surcharge, min/max stay, same-day cutoff, last-minute discounts. | Rate restrictions and derived availability.                                   |
| `inventory_days`                    | PMS operations            | PMS rooms, room blocks, bookings, calendar auto-open settings.                                                    | Day-level availability/inventory read/write owner.                            |
| `room_blocks`                       | PMS operations            | PMS `room_blocks`.                                                                                                | Operational blockers and maintenance holds.                                   |
| `operational_booking_assignments`   | PMS operations            | PMS booking room assignments, `booking_rooms`, room IDs, auto-rearrange settings.                                 | Links guest booking records to operational rooms.                             |
| `checkin_checklist_templates`       | PMS operations            | PMS checklist templates/defaults.                                                                                 | Hotel operations setup.                                                       |
| `checkout_inspection_templates`     | PMS operations            | PMS checkout inspection templates.                                                                                | Hotel operations setup.                                                       |
| `booking_checkin_records`           | PMS operations            | PMS `booking_checkin_records`.                                                                                    | Operational check-in state.                                                   |
| `booking_checkout_records`          | PMS operations            | PMS `booking_checkout_records` and checkout charges.                                                              | Operational checkout state and charges.                                       |
| `booking_notes_private`             | PMS operations            | PMS `booking_notes` not marked guest-visible.                                                                     | Private operational notes; not public bookability or AI by default.           |
| `message_threads` / `messages`      | PMS operations            | PMS current messaging tables; old dropped messaging tables are migration history only.                            | Guest/host messaging if still product-active at cutover.                      |
| `channel_connections`               | PMS operations            | PMS `channex_connections`, old Beds24 connections only as retired source audit if needed.                         | External channel connection state.                                            |
| `channel_room_type_mappings`        | PMS operations            | PMS `channex_room_type_mappings`, multi-room mappings.                                                            | Channel manager mapping owner.                                                |
| `channel_rate_plan_mappings`        | PMS operations            | PMS `channex_rate_plan_mappings`, channel markups.                                                                | Channel rate mapping and markup state.                                        |
| `channel_booking_mappings`          | PMS operations            | PMS `channex_booking_mappings`, webhook mapping state.                                                            | Channel booking identity mapping.                                             |
| `channel_sync_status`               | PMS operations            | PMS Channex sync errors/status fields, ARI sync state.                                                            | Consumed by jobs/events for retries and observability.                        |
| `pms_operations_summary_read_model` | PMS operations read model | Rooms, rates, assignments, channel status, booking summaries.                                                     | Consumed by Ask Intelligence and admin dashboards through permissioned views. |

PMS operations owns Channex connectivity because Channex distributes inventory,
rates, restrictions, and OTA reservations for a PMS-style system. PMS operations
must not own direct checkout, public quote sessions, promo/referral application,
or guest-facing Booking Engine confirmation contracts.

### Marketplace

Owner package: `domain-marketplace`.

| Target table or read model     | Owner                  | Source migration histories / current tables                                     | Notes                                                                             |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `creator_profiles`             | Marketplace            | Marketplace `creators`, creator type/profile fields.                            | Linked to creator-workspace organization.                                         |
| `creator_platforms`            | Marketplace            | Marketplace `creator_platforms`.                                                | Social/channel presence.                                                          |
| `creator_ratings`              | Marketplace            | Marketplace `creator_ratings`.                                                  | Creator/hotel collaboration ratings.                                              |
| `marketplace_hotel_profiles`   | Marketplace            | Marketplace `hotel_profiles`; canonical property facts come from hotel catalog. | Marketplace-specific hotel profile state.                                         |
| `marketplace_offers`           | Marketplace            | Legacy Marketplace `hotel_listings`.                                            | Hotel-authored collaboration briefs linked to canonical properties.               |
| `offer_deliverables`           | Marketplace            | New canonical data.                                                             | Content and timing requested by the hotel.                                        |
| `offer_compensation_options`   | Marketplace            | Legacy `listing_collaboration_offerings`.                                       | Compensation modes and limits the hotel accepts.                                  |
| `offer_creator_requirements`   | Marketplace            | Legacy `listing_creator_requirements`.                                          | Creator eligibility filters attached to an offer.                                 |
| `collaborations`               | Marketplace            | Marketplace `collaborations`, proposal terms, negotiation status.               | Creator proposal and accepted agreement owner.                                    |
| `collaboration_deliverables`   | Marketplace            | Marketplace `collaboration_deliverables`.                                       | Deliverable tracking.                                                             |
| `marketplace_chat_messages`    | Marketplace            | Marketplace `chat_messages`.                                                    | Collaboration chat, separate from PMS guest messaging.                            |
| `trips`                        | Marketplace            | Marketplace `trips`.                                                            | Creator trip records.                                                             |
| `external_collaborations`      | Marketplace            | Marketplace `external_collaborations`.                                          | Imported/manual collaboration records.                                            |
| `marketplace_notifications`    | Marketplace            | Marketplace `notifications`.                                                    | Product notifications, not platform job delivery state.                           |
| `invite_codes`                 | Marketplace            | Marketplace `invite_codes`.                                                     | Marketplace invite/referral codes.                                                |
| `newsletter_preferences`       | Marketplace            | Marketplace `newsletter_preferences`.                                           | Marketing preference owner unless moved to a broader communications domain later. |
| `marketplace_offer_read_model` | Marketplace read model | Marketplace offers plus property catalog facts and public media.                | Consumed by marketplace web and public marketplace surfaces.                      |

### Finance, Billing, and Payouts

Owner package: `domain-finance`.

| Target table or read model      | Owner              | Source migration histories / current tables                                                                 | Notes                                                                              |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `payment_provider_accounts`     | Finance            | PMS/booking hotel payment settings, Stripe/Xendit/PayPal/manual/bank-transfer configuration.                | External provider IDs preserved.                                                   |
| `payment_settings`              | Finance            | PMS `hotel_payment_settings`, booking payment method config.                                                | Payment capabilities used by booking and distribution read models.                 |
| `payments`                      | Finance            | PMS `payments`, deposit/balance fields, payment method/status changes.                                      | Guest/payment PII and provider IDs.                                                |
| `payouts`                       | Finance            | PMS `payouts`, payout retry/manual fields, Xendit payout IDs.                                               | Payout lifecycle.                                                                  |
| `payout_settings`               | Finance            | PMS `affiliate_payout_settings`, affiliate bank/payment fields, booking payout details.                     | Affiliate and property payout settings.                                            |
| `commission_rules`              | Finance            | Booking commission config/defaults, PMS affiliate commission override, marketplace affiliate offering type. | Authoritative fee/commission terms.                                                |
| `commission_rate_changes`       | Finance            | Booking `commission_rate_changes`, PMS commission audit fields.                                             | Audit of commission changes.                                                       |
| `billing_entitlements`          | Finance            | Booking billing plan/platform status, PMS `property_module_activations`, plan/module status.                | Identity/auth consumes a permissioned entitlement read model; finance owns writes. |
| `finance_visibility_read_model` | Finance read model | Payments, payouts, commissions, entitlements, selected resource links.                                      | Ask Intelligence/admin dashboards consume only with explicit finance permission.   |

### Distribution and Public Bookability

Owner package: `domain-distribution`.

| Target table or read model          | Owner                    | Source migration histories / current tables                                                                  | Notes                                                                      |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `public_hotel_bookability_profiles` | Distribution/bookability | Property catalog, booking hotel public profile/config, PMS payment/availability readiness, booking-web URLs. | Public-safe hotel profile for external agents/search.                      |
| `public_room_offer_snapshots`       | Distribution/bookability | PMS room/rate availability, booking add-ons/policies/payment capabilities.                                   | Public-safe snapshot only; no unpublished/private operational data.        |
| `public_quote_read_models`          | Distribution/bookability | Booking `quote_sessions`, PMS availability/rates, payment settings, promo/referral public rules.             | Read model for public quote API; booking owns canonical quote persistence. |
| `booking_deep_link_contexts`        | Distribution/bookability | Booking checkout context, booking-web URL behavior, locale/currency/promo/referral state.                    | Lets public quote responses deep-link into checkout.                       |
| `external_api_clients`              | Distribution/bookability | New target table.                                                                                            | Client identity, terms, rate-limit tier, revocation.                       |
| `external_api_usage_events`         | Distribution/bookability | New target table plus API logs.                                                                              | Abuse/rate-limit and public API audit signals.                             |

### Ask Intelligence

Owner package: `domain-intelligence`.

| Target table or read model     | Owner            | Source migration histories / current tables                                                                           | Notes                                                                         |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `metric_definitions`           | Ask Intelligence | New target catalog, informed by booking/PMS/finance/marketplace metrics.                                              | Defines metrics, visibility, units, and permission requirements.              |
| `metric_snapshot_runs`         | Ask Intelligence | PMS bookings/payments/rooms, booking events, marketplace collaborations, finance read models.                         | Snapshot provenance and freshness.                                            |
| `setup_completeness_snapshots` | Ask Intelligence | Property setup status, booking platform status, PMS module activation/setup fields, marketplace profile completeness. | Owner-facing setup gaps and agent readiness.                                  |
| `ai_evidence_catalog`          | Ask Intelligence | New target registry.                                                                                                  | Approved evidence tools/views and unavailable-data behavior.                  |
| `ask_conversations`            | Ask Intelligence | New target table.                                                                                                     | Conversation metadata, organization/resource scope, retention state.          |
| `ask_runs`                     | Ask Intelligence | New target table.                                                                                                     | One answer attempt with model/prompt/schema versions.                         |
| `ask_tool_calls`               | Ask Intelligence | New target table.                                                                                                     | Tool execution trace, evidence IDs, auth/unavailable outcomes.                |
| `ask_answer_audits`            | Ask Intelligence | New target table.                                                                                                     | Material claims, evidence references, answer envelope, review/debug metadata. |

### Jobs, Events, and Audit

Owner packages: `backend-events`, `backend-audit`, and platform infrastructure.

| Target table or read model | Owner             | Source migration histories / current tables                                                                 | Notes                                                       |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `domain_events`            | Jobs/events/audit | Booking events, PMS booking events, marketplace notifications, Channex webhook events, future domain emits. | Durable event log for domain changes.                       |
| `outbox_events`            | Jobs/events/audit | New target table.                                                                                           | Transactional outbox for side effects.                      |
| `jobs`                     | Jobs/events/audit | Current fire-and-forget side effects from email, Channex, payments, notifications, booking changes.         | Durable job identity and status.                            |
| `job_attempts`             | Jobs/events/audit | New target table.                                                                                           | Retry/failure history.                                      |
| `dead_letter_events`       | Jobs/events/audit | New target table.                                                                                           | Dead-letter visibility and recovery.                        |
| `idempotency_keys`         | Jobs/events/audit | Booking/payment/external side-effect idempotency decisions.                                                 | Prevents duplicate customer-facing side effects.            |
| `product_audit_events`     | Jobs/events/audit | Auth login audit, commission audits, booking events, notes/events, admin actions, WorkOS event correlation. | Product/application audit across domains.                   |
| `external_webhook_events`  | Jobs/events/audit | PMS `channex_webhook_events`, payment provider webhooks, WorkOS webhook ingestion records.                  | Raw receipt/audit; domain owners consume normalized events. |

## Source Migration Coverage

This section ensures every current migration history is represented. Counts are
from the repo at the time of this decision.

| Source history                    | File count | Target disposition                                                                                                                                          |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-db/migrations`              | 5          | Identity/auth owns internal users, external identities, organizations, memberships, permissions, consent/privacy retention, and auth reconciliation.        |
| `apps/marketplace-api/migrations` | 38         | Marketplace owns creator/listing/collaboration/trip/chat/notification tables. Removed local auth tables are retired; consent/GDPR history maps to privacy.  |
| `apps/booking-api/migrations`     | 41         | Property catalog, booking/checkout, finance, and distribution split ownership of current booking hotel profile/config, add-ons, promos, events, and status. |
| `apps/pms-api/migrations`         | 100        | PMS operations, booking/checkout, finance, distribution, Ask Intelligence, and jobs/events split ownership of operational PMS facts and side-effect state.  |

### Current Source Table Mapping

| Current source table or group                                                                                 | Target owner(s)                                      | Target table/read model examples                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Auth `users`                                                                                                  | Identity/auth                                        | `users`, `external_identities`, `organizations`, `organization_memberships`.                                        |
| Auth password reset, email verification/change, local TOTP, login rate-limit tables                           | Deferred/retired after WorkOS                        | Source snapshots only for rollback/audit; not active target auth systems.                                           |
| Auth consent and GDPR tables                                                                                  | Identity/privacy                                     | `cookie_consent`, `consent_history`, `gdpr_requests` or privacy-retention equivalent under identity ownership.      |
| Marketplace removed auth tables                                                                               | Deferred/retired                                     | Historical source only if any production rows remain outside auth-db.                                               |
| Marketplace `creators`, `creator_platforms`, `creator_ratings`                                                | Marketplace plus identity links                      | `creator_profiles`, `creator_platforms`, `creator_ratings`, `organization_resource_links`.                          |
| Marketplace `hotel_profiles`, `hotel_listings`                                                                | Hotel catalog and marketplace                        | `properties`, `property_profiles`, `marketplace_hotel_profiles`, `marketplace_offers`.                              |
| Marketplace listing requirements/offerings                                                                    | Marketplace                                          | `offer_creator_requirements`, `offer_compensation_options`, `offer_deliverables`.                                   |
| Marketplace collaborations, deliverables, chat, trips, external collaborations                                | Marketplace                                          | `collaborations`, `collaboration_deliverables`, `marketplace_chat_messages`, `trips`, `external_collaborations`.    |
| Marketplace notifications, invite codes, newsletter preferences                                               | Marketplace                                          | `marketplace_notifications`, `invite_codes`, `newsletter_preferences`.                                              |
| Booking `booking_hotels` and translations                                                                     | Hotel catalog, booking, finance, distribution        | `properties`, `property_profiles`, `quote_sessions`, `payment_settings`, `public_hotel_bookability_profiles`.       |
| Booking add-ons and promo codes                                                                               | Booking/checkout and distribution                    | `addon_definitions`, `booking_addon_selections`, `promo_applications`, public-safe quote inputs.                    |
| Booking events and commission changes                                                                         | Booking/checkout, finance, audit                     | `booking_status_events`, `commission_rate_changes`, `product_audit_events`.                                         |
| Booking platform status, billing plan, payout/payment fields                                                  | Finance and identity entitlement read model          | `billing_entitlements`, `payment_settings`, `payout_settings`, `request_context_resource_scope`.                    |
| Booking Lodgify tables and dropped Lodgify state                                                              | Deferred/retired                                     | No active target owner unless production dependency is rediscovered.                                                |
| PMS `hotels`                                                                                                  | Hotel catalog, PMS operations, finance, distribution | `properties`, `property_source_links`, PMS settings, `payment_settings`, `public_hotel_bookability_profiles`.       |
| PMS `room_types`, `rooms`, rates, seasons, stay restrictions, room locations                                  | PMS operations and distribution read models          | `room_types`, `rooms`, `rate_plans`, `rate_rules`, `public_room_offer_snapshots`.                                   |
| PMS `bookings`, `booking_rooms`, `booking_drafts`, additional guests, check-in/out records                    | Booking/checkout and PMS operations                  | `guest_bookings`, `booking_guests`, `operational_booking_assignments`, `booking_checkin_records`, checkout records. |
| PMS `room_blocks` and availability/calendar settings                                                          | PMS operations and distribution read models          | `room_blocks`, `inventory_days`, `public_room_offer_snapshots`.                                                     |
| PMS payments, payouts, payment settings, cancellation policies, deposits, manual/bank-transfer payment states | Finance and booking/checkout                         | `payments`, `payouts`, `payment_settings`, `commission_rules`, booking payment state.                               |
| PMS affiliates, affiliate clicks, affiliate payout settings                                                   | Identity/auth, finance, marketplace/distribution     | `organizations`, `organization_resource_links`, `payout_settings`, `commission_rules`, attribution read models.     |
| PMS Channex connections, mappings, markups, webhook events, sync errors                                       | PMS operations and jobs/events/audit                 | `channel_connections`, mappings, `channel_sync_status`, `external_webhook_events`, `jobs`.                          |
| PMS old Beds24 integration tables                                                                             | Deferred/retired                                     | Source audit only; no active target owner after dropped integration.                                                |
| PMS messaging tables                                                                                          | PMS operations                                       | `message_threads`, `messages` if active at cutover; old dropped messaging tables are history only.                  |
| PMS booking notes/events/change requests                                                                      | PMS operations, booking/checkout, jobs/events/audit  | Private notes, guest-visible status events, `booking_change_requests`, `product_audit_events`.                      |
| PMS property module activations and setup/checklist/dashboard status fields                                   | Finance, hotel catalog, Ask Intelligence             | `billing_entitlements`, `property_setup_status`, `setup_completeness_snapshots`.                                    |

## Cross-Domain Access Contracts

| Consumer need                                      | Producer owner           | Access boundary                                                                                                                              |
| -------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| RequestContext resource resolution                 | Identity/auth            | `request_context_resource_scope` read model; no product DB pools.                                                                            |
| Public hotel profile for marketplace/landing       | Hotel catalog            | `property_public_profile_read_model`; marketplace may add marketplace-owned listing fields.                                                  |
| Public AI bookability and quotes                   | Distribution/bookability | `public_hotel_bookability_profiles`, `public_room_offer_snapshots`, `public_quote_read_models`.                                              |
| PMS calendar/operations view of guest bookings     | Booking/checkout         | `direct_booking_summary_read_model` plus PMS-owned operational assignments.                                                                  |
| Booking Engine handoff to a PMS                    | PMS operations           | `engineering/pms-reservation-integration-contract.md` PMS reservation sink; Vayada PMS and external PMS systems implement the same boundary. |
| Finance dashboards and payout visibility           | Finance                  | `finance_visibility_read_model` gated by finance permission keys.                                                                            |
| Ask Intelligence hotel performance answers         | Ask Intelligence         | Evidence tools over curated booking/PMS/finance/read-model inputs; no arbitrary SQL.                                                         |
| Channex side-effect retries and webhook processing | PMS + jobs/events/audit  | PMS owns normalized channel state; jobs/audit owns raw receipts, job attempts, and dead-letter state.                                        |
| Product audit timelines                            | Jobs/events/audit        | `product_audit_events` with actor, organization, target resource, action, and correlation metadata.                                          |

## DDL Readiness Checklist

Before opening DDL tickets against this map:

- Each target table has an owner package and schema.
- Each migrated table has a source history and transform owner.
- Each public/read-model table has a public/private field posture.
- Each cross-domain consumer uses a read model, service, or event.
- Each retired source table has a retention/rollback disposition.
- Topology decision is recorded: one physical DB with schemas or multiple
  physical DBs cut over together.

## Follow-Up Tickets

- VAY-610 should use this map to design the migration/parity harness.
- DDL tickets should be split by owner domain and should not mix schema design,
  ETL implementation, and product route behavior in one PR.
- VAY-611 should use the owner package names here when deciding shared backend
  package boundaries.
