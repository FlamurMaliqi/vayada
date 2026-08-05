# Target schema ownership map

_VAY-609 contract record, extended by VAY-1044 for adaptive hotel onboarding.
Builds on VAY-600, VAY-602, VAY-603, VAY-605, VAY-607, and VAY-608._

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

| Target table or read model        | Owner                    | Source migration histories / current tables                                                                                     | Notes                                                                                                                                                                                                 |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                           | Identity/auth            | `auth-db/migrations`: `users`; legacy marketplace `users` only as historical migration input if any rows remain.                | Preserve `users.id` as internal principal. A future nullable `interface_locale` stores an explicit employee choice; browser locale remains the non-blocking default. No product `type` authorization. |
| `external_identities`             | Identity/auth            | WorkOS backfill plus `auth-db.users.email`; provider metadata.                                                                  | Maps WorkOS IDs to internal users.                                                                                                                                                                    |
| `organizations`                   | Identity/auth            | Existing user ownership on booking hotels, PMS hotels, marketplace hotel profiles, creators, affiliates, and platform staff.    | Organization kinds: `platform`, `hotel_group`, `creator_workspace`, `affiliate_partner`.                                                                                                              |
| `organization_memberships`        | Identity/auth            | Existing owner/admin user associations, WorkOS memberships, migration transforms from `users.type` and `is_superadmin`.         | `users.type` and `is_superadmin` are transform inputs only.                                                                                                                                           |
| `permission_catalog`              | Identity/auth            | VAY-600/VAY-608 permission contract, not legacy tables.                                                                         | Stable permission keys such as `booking.settings.manage` and `platform.user.suspend`.                                                                                                                 |
| `role_permission_grants`          | Identity/auth            | VAY-600 role model, WorkOS role slugs, product role decisions.                                                                  | Grants permissions by organization kind and role.                                                                                                                                                     |
| `membership_permission_overrides` | Identity/auth            | Future admin exceptions.                                                                                                        | Optional; can be deferred until role grants are insufficient.                                                                                                                                         |
| `organization_resource_links`     | Identity/auth            | `booking_hotels.user_id`, PMS `hotels.user_id`, marketplace `hotel_profiles.user_id`, `creators.user_id`, `affiliates.user_id`. | Links organizations to product resources. Direct `user_id` ownership is not carried forward.                                                                                                          |
| `product_entitlements`            | Identity/auth read model | Finance-owned `billing_entitlements`, product module state, platform status.                                                    | RequestContext entitlement read model only; finance/product domains own upstream writes.                                                                                                              |
| `auth_reconciliation_events`      | Identity/auth            | WorkOS webhooks and migration/linking runs.                                                                                     | Provider reconciliation, not product audit.                                                                                                                                                           |
| `request_context_resource_scope`  | Identity/auth read model | `organization_memberships`, `permission_catalog`, `organization_resource_links`, entitlements.                                  | Read model for RequestContext resolution and tests.                                                                                                                                                   |

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

| Target table or read model           | Owner                             | Source migration histories / current tables                                                                         | Notes                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties`                         | Hotel/property catalog            | Booking `booking_hotels`, PMS `hotels`, marketplace `hotel_profiles` and `hotel_listings`.                          | Canonical internal property identity.                                                                                                                                                                          |
| `property_source_links`              | Hotel/property catalog            | Current product resource IDs from booking/PMS/marketplace.                                                          | Maps canonical property to product-native IDs.                                                                                                                                                                 |
| `property_slugs`                     | Hotel/property catalog            | Booking slug history, booking custom domains, marketplace listing slugs, PMS hotel identity.                        | Owns canonical slug and old slug redirects.                                                                                                                                                                    |
| `property_locations`                 | Hotel/property catalog            | Booking hotel location/map fields, PMS hotel address/geo/timezone/country/city, marketplace hotel profiles.         | Public/private flags per field.                                                                                                                                                                                |
| `property_profiles`                  | Hotel/property catalog            | Booking hotel descriptions, marketplace hotel profiles/listings, PMS property details.                              | Normalized descriptive profile facts.                                                                                                                                                                          |
| `property_media`                     | Hotel/property catalog            | Booking hotel images/branding, marketplace hotel images, PMS room/property media where applicable.                  | Owns property presentation assignments and roles; Platform Media owns objects, variants, processing, and storage.                                                                                              |
| `property_amenities`                 | Hotel/property catalog            | Booking hotel amenities and PMS hotel-level amenities.                                                              | Catalog facts; room-specific amenities stay with PMS. Retired Marketplace requirements are not amenities.                                                                                                      |
| `property_contact_channels`          | Hotel/property catalog            | Booking contact fields, PMS hotel phone/email, marketplace hotel profile contact data.                              | Mark fields public/private.                                                                                                                                                                                    |
| `organization_setup_track_intents`   | Hotel setup/catalog               | Existing target table from adaptive-setup migration work.                                                           | Reuse as the route-intent source while replacing inline task projections; keep the unmerged handoff tables absent. Migration 0029 consumes and drops legacy `property_product_selections`; do not recreate it. |
| `property_setup_sessions`            | Hotel setup/catalog               | New target table.                                                                                                   | One active organization/property setup session; stores route and source revisions, not canonical product facts.                                                                                                |
| `property_setup_step_drafts`         | Hotel setup/catalog               | New target table.                                                                                                   | Per-step allowlisted incomplete input with retention/PII metadata and dirty-field manifests. Never authorizes readiness.                                                                                       |
| `adaptive_property_setup_read_model` | Hotel setup/catalog read model    | Track intent, setup session/drafts, and typed readiness ports from Catalog, Marketplace, Booking, PMS, and Finance. | Computes active steps and progress; product domains remain the owners of readiness.                                                                                                                            |
| `property_public_profile_read_model` | Hotel/property catalog read model | `properties`, `property_profiles`, `property_locations`, `property_media`, `property_amenities`.                    | Consumed by marketplace, distribution/bookability, and landing/public surfaces.                                                                                                                                |

### Booking and Direct Checkout

Owner package: `domain-booking`.

| Target table or read model          | Owner                       | Source migration histories / current tables                                                                  | Notes                                                                                                                                      |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `quote_sessions`                    | Booking/checkout            | Booking hotel pricing config, PMS room/rate data, promo code inputs, add-ons, payment capabilities.          | Authoritative quote identity, request hash, totals, expiry, and selected offers.                                                           |
| `checkout_contexts`                 | Booking/checkout            | Booking-web flow state, quote output, promo/referral state, locale/currency.                                 | Short-lived checkout state for guest flow.                                                                                                 |
| `guest_bookings`                    | Booking/checkout            | PMS `bookings`, PMS `booking_rooms`, PMS booking drafts when materialized, booking public references.        | Guest-facing booking lifecycle contract.                                                                                                   |
| `booking_guests`                    | Booking/checkout            | PMS booking guest fields, additional guests, booker guest details, guest country, arrival fields.            | Guest PII; private retention rules required.                                                                                               |
| `addon_definitions`                 | Booking/checkout            | Booking `booking_addons`, PMS add-on catalog/configuration fields.                                           | Property-scoped add-on catalog; no guest PII.                                                                                              |
| `booking_settings`                  | Booking/checkout            | Booking `booking_hotels` settings columns for add-ons, guest form, benefits, localization, and room filters. | Target settings read/write model activated behind `BOOKING_SETTINGS_SOURCE`.                                                               |
| `booking_design_revisions`          | Booking/checkout            | Booking branding settings plus canonical Catalog media references.                                           | Private versioned design draft; the live page never reads it directly.                                                                     |
| `booking_guest_experience_settings` | Booking/checkout            | Booking language, guest-form, children, and arrival settings plus composed policy references.                | Owns guest-facing settings and policy-confirmation evidence; Catalog stores only its public policy projection.                             |
| `booking_policy_confirmations`      | Booking/checkout            | New target table.                                                                                            | Immutable confirmation hash and actor/time bound to PMS rate-policy, Booking guest-setting, Catalog timezone, and room-capacity revisions. |
| `booking_publication_attempts`      | Booking/checkout            | New target table.                                                                                            | Expected source manifest, readiness result, idempotency key, and publication outcome. Distribution owns the resulting public revision.     |
| `booking_addon_selections`          | Booking/checkout            | Booking `booking_addons`, PMS booking add-on fields, booking add-on quantities/dates.                        | Guest-purchased extras.                                                                                                                    |
| `promo_applications`                | Booking/checkout            | Booking `booking_promo_codes`, PMS promo fields, referral inputs.                                            | Applies discounts/referrals to quote or booking.                                                                                           |
| `booking_status_events`             | Booking/checkout            | Booking `booking_events`, PMS `booking_events`, status changes, cancellation/change/check-in/out lifecycle.  | User-visible booking lifecycle history.                                                                                                    |
| `booking_change_requests`           | Booking/checkout            | PMS `booking_change_requests`.                                                                               | Guest change/cancellation workflow.                                                                                                        |
| `booking_notes_public`              | Booking/checkout            | Public-safe subset of PMS notes/events only when guest-visible.                                              | Private PMS notes remain PMS-owned.                                                                                                        |
| `direct_booking_summary_read_model` | Booking/checkout read model | `guest_bookings`, PMS operational assignments, payments, property catalog.                                   | Consumed by PMS, finance, and Ask Intelligence through permissioned views.                                                                 |

Booking/checkout must not depend on PMS operational tables, Channex mappings,
or a Vayada PMS database connection as its normal source. It may publish booking
events or call PMS integration interfaces so Vayada PMS or an external PMS can
create/update the operational reservation.

### PMS Operations

Owner package: `domain-pms`.

| Target table or read model          | Owner                     | Source migration histories / current tables                                                                | Notes                                                                                                                                                              |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `room_types`                        | PMS operations            | PMS room facts, occupancy, amenities, and media references; legacy price columns are migration input only. | Independently editable room facts. Pricing and calendar never share this write command.                                                                            |
| `rooms`                             | PMS operations            | PMS physical rooms.                                                                                        | Opaque physical-unit identity with a nullable, explicitly verified operational label; generated public-looking room numbers are forbidden.                         |
| `property_pricing_settings`         | PMS operations            | PMS/Booking/Finance currency fields normalized to one property value.                                      | Sole write owner for property pricing currency and mandatory-charge-included confirmation evidence bound to its revision. Booking and Finance consume projections. |
| `rate_plans`                        | PMS operations            | PMS flexible/non-refundable plans and structured cancellation terms.                                       | Stable source configuration; no duplicate base amount on `room_types`.                                                                                             |
| `rate_rules`                        | PMS operations            | PMS seasons, weekend and occupancy rules, stay restrictions, and dated overrides.                          | Versioned source configuration separate from materialized dated prices.                                                                                            |
| `operating_calendars`               | PMS operations            | PMS calendar auto-open settings, operating periods, and default minimum stay.                              | Independently editable recurring source configuration.                                                                                                             |
| `inventory_days`                    | PMS operations            | Materialized calendar, sellable limits, rooms, blocks, and confirmed reservations.                         | Day-level ARI state with source precedence and physical-capacity invariants.                                                                                       |
| `inventory_reservation_receipts`    | PMS operations            | New target table.                                                                                          | Durable idempotent reserve/confirm/release lifecycle; does not expose database transactions.                                                                       |
| `room_blocks`                       | PMS operations            | PMS `room_blocks`.                                                                                         | Operational blockers and maintenance holds.                                                                                                                        |
| `operational_booking_assignments`   | PMS operations            | PMS booking room assignments, `booking_rooms`, room IDs, auto-rearrange settings.                          | Links guest booking records to operational rooms.                                                                                                                  |
| `checkin_checklist_templates`       | PMS operations            | PMS checklist templates/defaults.                                                                          | Hotel operations setup.                                                                                                                                            |
| `checkout_inspection_templates`     | PMS operations            | PMS checkout inspection templates.                                                                         | Hotel operations setup.                                                                                                                                            |
| `booking_checkin_records`           | PMS operations            | PMS `booking_checkin_records`.                                                                             | Operational check-in state.                                                                                                                                        |
| `booking_checkout_records`          | PMS operations            | PMS `booking_checkout_records` and checkout charges.                                                       | Operational checkout state and charges.                                                                                                                            |
| `booking_notes_private`             | PMS operations            | PMS `booking_notes` not marked guest-visible.                                                              | Private operational notes; not public bookability or AI by default.                                                                                                |
| `message_threads` / `messages`      | PMS operations            | PMS current messaging tables; old dropped messaging tables are migration history only.                     | Guest/host messaging if still product-active at cutover.                                                                                                           |
| `channel_connections`               | PMS operations            | PMS `channex_connections`, old Beds24 connections only as retired source audit if needed.                  | External channel connection state.                                                                                                                                 |
| `channel_room_type_mappings`        | PMS operations            | PMS `channex_room_type_mappings`, multi-room mappings.                                                     | Channel manager mapping owner.                                                                                                                                     |
| `channel_rate_plan_mappings`        | PMS operations            | PMS `channex_rate_plan_mappings`, channel markups.                                                         | Channel rate mapping and markup state.                                                                                                                             |
| `channel_booking_mappings`          | PMS operations            | PMS `channex_booking_mappings`, webhook mapping state.                                                     | Channel booking identity mapping.                                                                                                                                  |
| `channel_sync_status`               | PMS operations            | PMS Channex sync errors/status fields, ARI sync state.                                                     | Consumed by jobs/events for retries and observability.                                                                                                             |
| `pms_operations_summary_read_model` | PMS operations read model | Rooms, rates, assignments, channel status, booking summaries.                                              | Consumed by Ask Intelligence and admin dashboards through permissioned views.                                                                                      |

PMS operations owns Channex connectivity because Channex distributes inventory,
rates, restrictions, and OTA reservations for a PMS-style system. PMS operations
must not own direct checkout, public quote sessions, promo/referral application,
or guest-facing Booking Engine confirmation contracts.

### Marketplace

Owner package: `domain-marketplace`.

| Target table or read model                  | Owner                  | Source migration histories / current tables                                     | Notes                                                                                                                    |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `creator_profiles`                          | Marketplace            | Marketplace `creators`, creator type/profile fields.                            | Linked to creator-workspace organization.                                                                                |
| `creator_platforms`                         | Marketplace            | Marketplace `creator_platforms`.                                                | Social/channel presence.                                                                                                 |
| `creator_ratings`                           | Marketplace            | Marketplace `creator_ratings`.                                                  | Creator/hotel collaboration ratings.                                                                                     |
| `marketplace_hotel_profiles`                | Marketplace            | Marketplace `hotel_profiles`; canonical property facts come from Hotel Catalog. | Marketplace-specific moderation and visibility state only.                                                               |
| `hotel_collaboration_preferences`           | Marketplace            | Legacy listing offerings/requirements normalized into hotel-level preferences.  | Four required groups: compensation, platforms, content types, and general availability. No onboarding offer is created.  |
| `marketplace_hotel_profile_submissions`     | Marketplace            | New target table.                                                               | Immutable submitted profile/preference manifest with draft, pending, approved, rejected, and superseded lifecycle.       |
| `active_marketplace_hotel_profile_revision` | Marketplace            | New target pointer.                                                             | Selects one approved immutable revision independently of Booking publication.                                            |
| `collaborations`                            | Marketplace            | Marketplace `collaborations`, proposal terms, negotiation status.               | Creator proposal and accepted agreement owner. Exact deliverables are negotiated here/chat, not during hotel onboarding. |
| `collaboration_deliverables`                | Marketplace            | Marketplace `collaboration_deliverables`.                                       | Agreed deliverable tracking after negotiation.                                                                           |
| `marketplace_chat_messages`                 | Marketplace            | Marketplace `chat_messages`.                                                    | Collaboration chat, separate from PMS guest messaging.                                                                   |
| `trips`                                     | Marketplace            | Marketplace `trips`.                                                            | Creator trip records.                                                                                                    |
| `external_collaborations`                   | Marketplace            | Marketplace `external_collaborations`.                                          | Imported/manual collaboration records.                                                                                   |
| `marketplace_notifications`                 | Marketplace            | Marketplace `notifications`.                                                    | Product notifications, not platform job delivery state.                                                                  |
| `invite_codes`                              | Marketplace            | Marketplace `invite_codes`.                                                     | Referral/invite identity only; onboarding form payloads are retired.                                                     |
| `newsletter_preferences`                    | Marketplace            | Marketplace `newsletter_preferences`.                                           | Marketing preference owner unless moved to a broader communications domain later.                                        |
| `marketplace_hotel_read_model`              | Marketplace read model | Active approved Marketplace revision plus public Catalog facts/media.           | Consumed by Marketplace Web and public Marketplace surfaces.                                                             |

### Finance, Billing, and Payouts

Owner package: `domain-finance`.

| Target table or read model                           | Owner                              | Source migration histories / current tables                                                                 | Notes                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payment_provider_accounts`                          | Finance                            | PMS/Booking provider account configuration.                                                                 | External provider IDs and hosted-onboarding state. Manual methods are not provider accounts.                                                     |
| `payment_settings`                                   | Finance                            | PMS `hotel_payment_settings`, Booking payment method config.                                                | Per-method selection, readiness, blocker, and revision. Pay at hotel is distinct from bank transfer. Pricing currency is a PMS-owned projection. |
| `payments`                                           | Finance                            | PMS `payments`, deposit/balance fields, payment method/status changes.                                      | Guest/payment PII and provider IDs.                                                                                                              |
| `payouts`                                            | Finance                            | PMS `payouts`, payout retry/manual fields, Xendit payout IDs.                                               | Payout lifecycle.                                                                                                                                |
| `payout_settings`                                    | Finance                            | PMS `affiliate_payout_settings`, affiliate bank/payment fields, booking payout details.                     | Affiliate and property payout settings.                                                                                                          |
| `commission_rules`                                   | Finance                            | Booking commission config/defaults, PMS affiliate commission override, marketplace affiliate offering type. | Authoritative fee/commission terms.                                                                                                              |
| `commission_rate_changes`                            | Finance                            | Booking `commission_rate_changes`, PMS commission audit fields.                                             | Audit of commission changes.                                                                                                                     |
| `billing_entitlements`                               | Finance                            | Booking billing plan/platform status, PMS `property_module_activations`, plan/module status.                | Identity/auth consumes a permissioned entitlement read model; finance owns writes.                                                               |
| `finance_visibility_read_model`                      | Finance read model                 | Payments, payouts, commissions, entitlements, selected resource links.                                      | Ask Intelligence/admin dashboards consume only with explicit finance permission.                                                                 |
| `payment_readiness_read_model`                       | Finance read model                 | Payment settings, provider capabilities, and card-execution readiness.                                      | Booking publication consumes method-level readiness; an unready optional method blocks only itself.                                              |
| `platform.media_objects` (`finance.expense.receipt`) | Platform Media / Finance reference | New private Finance expense receipt objects.                                                                | Platform Media owns object lifecycle; Finance owns the property expense association and stores only the media-object reference.                  |
| `expense_categories`                                 | Finance                            | New property-scoped categories with stable seeded system keys.                                              | Display metadata is customizable; historical references restrict deletion.                                                                       |
| `recurring_expense_rules`                            | Finance                            | New recurrence templates.                                                                                   | Generates one idempotent expense per occurrence; future schedule changes do not rewrite history.                                                 |
| `expenses`                                           | Finance                            | New manual, recurring, OTA commission, platform fee and supplier bill ledger.                               | Authoritative expense rows; corrections and reversals are append-only; P&L is computed.                                                          |
| `property_invoice_sequences`                         | Finance                            | New per-property monotonic invoice-number counters.                                                         | Numbers are reserved on draft creation and never reset or reused.                                                                                |
| `invoices`                                           | Finance                            | New persisted invoice headers with optional Booking references and normalized totals.                       | Stored lifecycle is draft, issued or voided; sent, partial, paid and overdue are derived later.                                                  |
| `invoice_lines`                                      | Finance                            | New normalized decimal invoice line items.                                                                  | Line totals are generated; deferred transaction checks keep the header total exact.                                                              |
| `invoice_payment_allocations`                        | Finance                            | New append-only links from issued invoices to existing payment facts.                                       | Database-managed totals serialize concurrent allocation and prevent invoice or payment over-allocation.                                          |

### Distribution and Public Bookability

Owner package: `domain-distribution`.

| Target table or read model          | Owner                    | Source migration histories / current tables                                                                    | Notes                                                                                                                  |
| ----------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `public_booking_content_revisions`  | Distribution/bookability | Immutable manifest assembled by Booking from Catalog, Booking, PMS, and Finance readiness ports.               | Public-safe content revision; never reads mutable setup drafts.                                                        |
| `active_public_booking_revision`    | Distribution/bookability | Successful Booking publication attempts.                                                                       | Atomic pointer to one immutable content revision. Marketplace lifecycle is independent.                                |
| `public_hotel_bookability_profiles` | Distribution/bookability | Active immutable public Booking revision, including its versioned Catalog projection.                          | Public-safe hotel profile for Booking Web and external search; never reads mutable setup.                              |
| `public_room_offer_snapshots`       | Distribution/bookability | Versioned PMS room/rate configuration plus Booking policy and typed Finance readiness projections.             | Immutable published snapshot; live ARI/readiness is revalidated separately.                                            |
| `live_ari_watermarks`               | Distribution/bookability | PMS-produced availability/rate/inventory events.                                                               | Freshness pointer independent of the slower Booking content revision.                                                  |
| `public_quote_read_models`          | Distribution/bookability | Active public Booking revision, `public_room_offer_snapshots`, and typed public payment/promotion projections. | Public quote input; Booking owns `quote_sessions`, and fresh live ARI/readiness are explicit revalidation inputs only. |
| `booking_deep_link_contexts`        | Distribution/bookability | Booking checkout context, booking-web URL behavior, locale/currency/promo/referral state.                      | Lets public quote responses deep-link into checkout.                                                                   |
| `external_api_clients`              | Distribution/bookability | New target table.                                                                                              | Client identity, terms, rate-limit tier, revocation.                                                                   |
| `external_api_usage_events`         | Distribution/bookability | New target table plus API logs.                                                                                | Abuse/rate-limit and public API audit signals.                                                                         |

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

### Platform Media

Owner package: Platform Media infrastructure.

| Target table or read model | Owner          | Source migration histories / current tables                               | Notes                                                                                  |
| -------------------------- | -------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `media_objects`            | Platform Media | Booking, Marketplace, and PMS uploads normalized into the media registry. | Owns object identity, purpose, processing/approval state, retention, and storage keys. |
| `media_variants`           | Platform Media | Generated image variants and metadata.                                    | Only safe approved variants may be assigned to a public presentation role.             |
| `media_upload_sessions`    | Platform Media | Product upload-session state.                                             | Private until finalized; finalization never changes a Catalog/PMS assignment.          |

Hotel Catalog owns property logo, cover, and gallery assignments. PMS owns
room-type media assignments. Both reference Platform Media asset IDs and use
expected-revision assignment commands; neither owns object storage.

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

## Adaptive Hotel Onboarding Ownership (VAY-1044)

This section is the checked owner map for the approved V1 fields in
[`hotel-onboarding-information-inventory.md`](hotel-onboarding-information-inventory.md).
The setup draft may temporarily retain allowlisted incomplete values, but it is
never a second canonical owner and never proves product readiness. A complete
step invokes the named domain command with an expected source revision.

Status vocabulary:

- **Reuse**: the target owner, storage, command, and fixture baseline exist.
- **Extend**: keep the existing target work, but split or complete its contract.
- **New**: no compatible target contract exists.
- **Deferred**: intentionally outside V1 onboarding and non-blocking.

### Field-to-owner matrix

| Stage and approved field IDs                                                                                                                                                                              | Canonical owner and target storage                                                                                                | Application command                                                            | Setup/public read model                                                    | Status                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Prerequisite: `hotel.display_name`, `hotel.property_type`                                                                                                                                                 | Hotel Catalog: `properties`                                                                                                       | Existing combined `createPropertyProfile` / `updatePropertyProfile`            | Catalog public profile and adaptive setup                                  | Reuse the aggregate; do not invent a separate identity command                |
| Prerequisite: `hotel.street_address`, `hotel.postal_code`, `hotel.city`, `hotel.country_code`, `hotel.latitude`, `hotel.longitude`, `hotel.timezone`                                                      | Hotel Catalog: `property_locations`                                                                                               | Existing combined `createPropertyProfile` / `updatePropertyProfile`            | Catalog public/private profile projection                                  | Reuse the aggregate; split only if a later contract requires it               |
| Prerequisite: `hotel.locality_public`                                                                                                                                                                     | Hotel Catalog: visibility metadata on `property_locations`                                                                        | Existing combined `createPropertyProfile` / `updatePropertyProfile`            | Catalog public/private profile projection                                  | Required explicit consent before city/country enters a public projection      |
| Prerequisite: `hotel.contact_email`, `hotel.contact_phone`, `hotel.website`                                                                                                                               | Hotel Catalog: `property_contact_channels`                                                                                        | Existing combined `createPropertyProfile` / `updatePropertyProfile`            | Permissioned Catalog profile; public channels only when explicitly public  | Reuse the aggregate; split only if a later contract requires it               |
| Prerequisite: `profile.logo`                                                                                                                                                                              | Hotel Catalog presentation assignment referencing Platform Media                                                                  | `catalog.assignPropertyLogo` after private upload/finalize                     | Catalog public profile, navigation, chat, Marketplace, Booking             | Extend in ONB-05/06                                                           |
| Prerequisite: `organization.selected_track`                                                                                                                                                               | Hotel setup/catalog: existing `organization_setup_track_intents`                                                                  | Existing `updateTracks`                                                        | `adaptive_property_setup_read_model`                                       | Reuse while replacing inline task projections; keep handoff prototypes absent |
| Shell: `user.interface_locale`                                                                                                                                                                            | Identity: nullable per-user locale on `users`                                                                                     | `identity.updateInterfaceLocale`                                               | Employee session/preferences                                               | Deferred backend gap; browser default is non-blocking                         |
| Step 1: `profile.default_locale`                                                                                                                                                                          | Hotel Catalog: locale key on the canonical `property_profiles` summary                                                            | Narrow `catalog.setDefaultContentLocale` write                                 | Catalog public profile and selected product projections                    | New required Step 1 write; blocks each selected public product                |
| Step 1: `profile.short_description`                                                                                                                                                                       | Hotel Catalog: `property_profiles`                                                                                                | Existing `updatePublicPropertyProfile`                                         | `property_public_profile_read_model`                                       | Reuse; remove duplicate long-description semantics                            |
| Step 1: generated `profile.public_slug`                                                                                                                                                                   | Hotel Catalog: `property_slugs`                                                                                                   | Existing publication helper `reserveCanonicalSlug`; move behind a Catalog port | Public profile and publication manifests                                   | Reuse at publication; extend the cross-domain command boundary                |
| Step 1: `profile.hero_image`, `profile.gallery_images`, generated `profile.media_alt_text`                                                                                                                | Hotel Catalog: `property_media` presentation assignments referencing Platform Media assets                                        | `catalog.assignPropertyMedia` with expected revision                           | Catalog public profile; selected product projections                       | Extend in ONB-05/07                                                           |
| Step 1: `profile.amenities`                                                                                                                                                                               | Hotel Catalog: `property_amenities`                                                                                               | `catalog.replacePropertyAmenities`                                             | Catalog public profile                                                     | Extend: owner write is missing                                                |
| Step 2: `marketplace.preferences.compensation_types`                                                                                                                                                      | Marketplace: new `hotel_collaboration_preferences` replacing the landed offer-shaped onboarding model                             | `marketplace.replaceHotelCollaborationPreferences`                             | New `marketplace_hotel_read_model` and Marketplace readiness port          | New replacement; backfill compatible legacy offerings for review              |
| Step 2: `marketplace.preferences.content_platforms`                                                                                                                                                       | Marketplace: new `hotel_collaboration_preferences` replacing the landed offer-shaped onboarding model                             | `marketplace.replaceHotelCollaborationPreferences`                             | New `marketplace_hotel_read_model` and Marketplace readiness port          | New replacement; backfill compatible legacy offering platforms for review     |
| Step 2: `marketplace.preferences.content_types`                                                                                                                                                           | Marketplace: new `hotel_collaboration_preferences` replacing the landed offer-shaped onboarding model                             | `marketplace.replaceHotelCollaborationPreferences`                             | New `marketplace_hotel_read_model` and Marketplace readiness port          | New replacement; no legacy equivalent, so collect explicitly                  |
| Step 2: `marketplace.preferences.availability`                                                                                                                                                            | Marketplace: new `hotel_collaboration_preferences` replacing the landed offer-shaped onboarding model                             | `marketplace.replaceHotelCollaborationPreferences`                             | New `marketplace_hotel_read_model` and Marketplace readiness port          | New replacement; backfill compatible legacy months for review                 |
| Step 3: derived `booking.hero_image`                                                                                                                                                                      | Hotel Catalog canonical-cover projection referencing Platform Media                                                               | No Booking write; inherit active Catalog cover                                 | Private Booking design preview; active Distribution revision after publish | Extend typed cover projection; overrides remain deferred                      |
| Step 3: derived `booking.hero_heading`, `booking.hero_subtext`                                                                                                                                            | Hotel Catalog public profile projection                                                                                           | No Booking write; inherit display name and short summary                       | Private Booking design preview; active Distribution revision after publish | Reuse existing Booking Web fallbacks; overrides remain deferred               |
| Step 3: editable `booking.primary_color`, `booking.font_pairing`                                                                                                                                          | Booking: `booking_design_revisions`                                                                                               | `booking.saveDesignRevision`                                                   | Private Booking design preview; active Distribution revision after publish | Extend: private revision/pointer missing                                      |
| Step 4: `room.name`, `room.category`, `room.max_occupancy`, `room.max_adults`, `room.max_children`, `room.beds`, `room.bedrooms`, `room.bathrooms`, `room.bathroom_type`, `room.size`, `room.description` | PMS: `room_types`                                                                                                                 | `pms.upsertRoomTypeFacts`                                                      | PMS room-setup read model and Distribution room projection                 | Extend: split from the combined create command                                |
| Step 4: `room.unit_count`                                                                                                                                                                                 | PMS: `rooms` as opaque physical units                                                                                             | `pms.reconcileRoomUnits`                                                       | PMS capacity/readiness projection                                          | Extend: nullable verified labels and safe reconciliation missing              |
| Step 4: `room.images`                                                                                                                                                                                     | PMS room-type assignment referencing Platform Media                                                                               | `pms.assignRoomTypeMedia`                                                      | PMS setup and Distribution room gallery                                    | Extend in ONB-05/13                                                           |
| Step 4: reviewed `room.amenities`                                                                                                                                                                         | PMS room-type amenities                                                                                                           | `pms.confirmRoomTypeAmenities`                                                 | PMS setup and Distribution room facts                                      | Extend: vocabulary/empty-review evidence missing                              |
| Step 5: `rate.currency`                                                                                                                                                                                   | PMS: `property_pricing_settings`                                                                                                  | `pms.setPropertyPricingCurrency`                                               | PMS pricing setup; projected read-only to Booking and Finance              | New single-owner setting; normalize duplicates                                |
| Step 5: `rate.base_nightly_rate`, derived `rate.flexible_enabled`, `rate.free_cancellation_deadline_days`                                                                                                 | PMS: flexible `rate_plans` with structured cancellation snapshot                                                                  | `pms.upsertFlexibleRatePlan`                                                   | PMS pricing setup, quote input, Distribution offer snapshot                | Extend: independent update/policy snapshot missing                            |
| Step 5: `rate.non_refundable_enabled`, `rate.non_refundable_discount`, generated `rate.non_refundable_terms`                                                                                              | PMS: derived non-refundable `rate_plans`                                                                                          | `pms.upsertNonRefundableRatePlan`                                              | PMS pricing setup, quote input, guest disclosure                           | Extend: source relationship/readiness missing                                 |
| Step 5: `rate.seasons`, `rate.seasonal_prices`, `rate.weekend_days`, `rate.weekend_surcharge`, `rate.occupancy_prices`                                                                                    | PMS: versioned source `rate_rules`                                                                                                | `pms.replacePricingRules`                                                      | PMS pricing preview; decimal-safe quote input                              | Extend: split source configuration from dated materialization                 |
| Step 5: `rate.mandatory_charges_acknowledged`                                                                                                                                                             | PMS: confirmation evidence on `property_pricing_settings`, bound to its revision                                                  | `pms.confirmMandatoryChargesIncluded`                                          | PMS pricing readiness and Booking publication manifest                     | New; canonical evidence is not a setup draft                                  |
| Step 6: `rate.operating_periods`, `rate.minimum_stay`                                                                                                                                                     | PMS: `operating_calendars`                                                                                                        | `pms.replaceOperatingCalendar`                                                 | PMS calendar setup and readiness port                                      | Extend: independent source contract missing                                   |
| Step 6: `rate.initial_availability`                                                                                                                                                                       | PMS: starting `inventory_days` sellable limits                                                                                    | `pms.confirmInitialSellableLimits`                                             | PMS calendar preview and live ARI projection                               | Extend: confirmation/reconciliation missing                                   |
| Step 7: `guest.default_language`, `guest.children_enabled`, conditional `guest.adult_age_threshold`, `guest.phone_required`, `guest.arrival_time_enabled`, `guest.special_requests_enabled`               | Booking: `booking_guest_experience_settings`                                                                                      | `booking.updateGuestExperience`                                                | Booking setup/readiness and eventual public revision                       | Extend                                                                        |
| Step 7: derived `guest.default_currency`                                                                                                                                                                  | PMS-owned `property_pricing_settings` projected to Booking                                                                        | No Booking write; retire `booking_settings.default_currency` mutation          | Booking setup consistency check and public revision                        | Extend the new PMS owner and projection; fail closed on mismatch              |
| Step 7: `policy.check_in_time`, `policy.check_out_time`                                                                                                                                                   | Booking guest-experience aggregate; Hotel Catalog keeps a public projection                                                       | `booking.updateArrivalPolicies`                                                | Booking setup/readiness and Catalog public policy summary                  | Extend: remove broad cross-domain write                                       |
| Step 7: generated `policy.cancellation_bundle_confirmation`                                                                                                                                               | Booking: immutable `booking_policy_confirmations` bound to every composed source revision                                         | `booking.confirmPolicyBundle`                                                  | Booking readiness/publication manifest                                     | New; canonical evidence is not a setup draft                                  |
| Step 8: derived `payment.enabled`, selected `payment.accepted_methods`, `payment.pay_at_hotel`                                                                                                            | Finance: `payment_settings`                                                                                                       | `finance.replacePaymentMethods`                                                | `payment_readiness_read_model`                                             | Extend to per-method readiness                                                |
| Step 8: `payment.online_card`                                                                                                                                                                             | Finance: `payment_provider_accounts` plus card-execution capability                                                               | `finance.startProviderOnboarding`; provider webhooks update capability         | Method-level Finance readiness                                             | Extend; hosted onboarding exists                                              |
| Step 8: derived `payment.default_currency`                                                                                                                                                                | PMS pricing currency projected into Finance                                                                                       | No Finance currency write                                                      | Finance/Booking consistency check                                          | Extend: remove duplicate ownership                                            |
| Step 8: generated `policy.payment_summary`                                                                                                                                                                | Booking publication projection composed from Finance-ready methods                                                                | No independent settings write                                                  | Booking readiness and public policy summary                                | Extend                                                                        |
| Step 9: `launch.marketplace_submit`                                                                                                                                                                       | Marketplace: immutable `marketplace_hotel_profile_submissions` and active-approved pointer                                        | `marketplace.submitHotelProfile`                                               | Marketplace lifecycle/readiness                                            | New in ONB-02A/09                                                             |
| Step 9: `launch.booking_publish`                                                                                                                                                                          | Booking owns publication attempts/manifests; Distribution owns immutable public revisions, active pointer, and live ARI watermark | `booking.requestPublication`; typed Distribution projector                     | Booking lifecycle plus active public bookability read models               | New/extend in ONB-02A/26                                                      |
| Deferred: `profile.supported_locales`                                                                                                                                                                     | Hotel Catalog: locale coverage derived from translated `property_profiles`                                                        | No V1 command; future translated-content lifecycle                             | Future Catalog translated-profile settings                                 | Deferred; no fallback inferred from employee or guest locale                  |
| Deferred: `profile.custom_domain`                                                                                                                                                                         | Hotel Catalog: `property_domains`                                                                                                 | No V1 setup command; later verified-domain lifecycle                           | Later Catalog domain settings and public routing                           | Deferred; domain verification is outside first-run setup                      |
| Deferred: `room.features`                                                                                                                                                                                 | PMS: future typed `room_type_features`                                                                                            | No V1 command; later PMS room-feature replacement                              | Later PMS room settings and Distribution projection                        | Deferred; do not overload reviewed room amenities                             |
| Deferred: `guest.supported_languages`                                                                                                                                                                     | Booking: future guest-interface capability/configuration                                                                          | No V1 command until translated content and Booking Web share capability truth  | Later Booking localization settings                                        | Deferred; only the default guest language participates in V1                  |
| Deferred: `guest.supported_currencies`                                                                                                                                                                    | Booking/Finance future conversion configuration; PMS remains pricing-currency owner                                               | No V1 command until an end-to-end conversion contract exists                   | Later Booking localization and Finance conversion readiness                | Deferred; never infer conversion from stored display options                  |
| Deferred: `guest.guest_count_enabled`                                                                                                                                                                     | Booking: guest-form settings                                                                                                      | No V1 command; party size remains room-search/occupancy owned                  | Later Booking form settings                                                | Deferred and disabled to avoid a second guest-count source                    |
| Deferred: `payment.bank_transfer_destination`                                                                                                                                                             | Finance: future encrypted destination and masked read model                                                                       | No V1 command; VAY-1041 secure lifecycle required                              | Future permissioned Finance settings; never public or in setup events      | Deferred; absent from V1 rather than stored in drafts                         |

Explicitly hidden or excluded from V1 onboarding:

- `guest.supported_languages`, `guest.supported_currencies`,
  `guest.guest_count_enabled`, and `payment.bank_transfer_destination`;
- social contacts, custom domains, room filters, benefits, add-ons, promo codes,
  and last-minute pricing;
- `room.features` plus individual `room.number`, `room.floor`, and
  `room.initial_status`;
- date overrides, advance/maximum-stay restrictions, meal/deposit/payment plans,
  and closed-to-arrival/departure rules;
- taxes, mandatory-fee calculation, deposits, automated refunds, and payout bank
  details;
- Marketplace offer titles, offer photos, deliverable quantities, and creator
  eligibility filters. Onboarding stores hotel-level collaboration preferences;
  exact terms belong to a collaboration/chat agreement.

These exclusions have no unresolved ownership question for ONB-01–05. Their
future owners are already Identity, Catalog, Booking, PMS, Marketplace, or
Finance as described above; they are simply not launch blockers.

### Existing target work to reuse

| Area             | Reuse baseline                                                                                                 | Required disposition                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property profile | Catalog property/location/profile/media/amenity/contact schema, profile transform/parity, and profile revision | Extend for one short summary, amenity writes, media roles, and explicit public/private contacts                                                     |
| Platform Media   | Asset/variant/upload-session registry and URL migration/parity                                                 | Extend with product-neutral authorization and revision-safe Catalog/PMS assignment                                                                  |
| Marketplace      | Legacy offer schema/transform/parity and current collaboration contracts                                       | Reuse only as migration input: backfill hotel-level preferences, retire offer-shaped onboarding/read models, and add immutable submission lifecycle |
| Booking          | Booking settings, design/guest fields, transform/parity, slug handling, and public/private filtering           | Extend with private design revision, policy evidence, source manifest, publication attempt, and active revision                                     |
| PMS              | Room/rate/inventory schema, broad transform/parity, locking/capacity concepts, and rolling-horizon behavior    | Split the combined command; add opaque units, source revisions, decimal-safe pricing, editable calendar source, and durable receipts                |
| Finance          | Provider accounts, payment settings, hosted Stripe onboarding, transform/parity                                | Extend to per-method selection/readiness; keep Pay at hotel separate from bank transfer and card execution                                          |
| Distribution     | Public profile/room/quote projections and parity                                                               | Extend to immutable content revisions, active pointer, publication manifest/attempt, and independent live ARI watermark                             |

Only setup sessions/drafts/progress, the hotel-level Marketplace preference/read
model, shared source manifests, immutable Marketplace and Booking lifecycles,
the split PMS source contracts and durable reservation receipts, and per-method
Finance readiness are greenfield. Existing setup-track storage, fixture
transforms, and parity checks remain baselines to extend, not recreate.

### Retired onboarding consumer inventory

The merged adaptive base still contains the inline setup-task model that the
approved rebuild will replace. The separate setup-task handoff prototype and its
proposed migration never merged and are already absent. Legacy authentication
handoff pages remain a separate compatibility concern and must not be classified
as setup-task handoffs. The replacement work must apply these path-level
dispositions:

- **Migrate/split the prerequisite package:** preserve only hotel identity,
  location, contact, and product-selection behavior in
  `packages/product-onboarding/src/SharedFirstRunPropertySetupWizard.tsx`,
  `sharedFirstRunSetupFlow.ts`, `sharedHotelSetupApi.ts`,
  `sharedHotelSetupGuard.ts`, `returnTo.ts`, `returnTo.test.ts`, and their
  tests. Rewrite
  `packages/product-onboarding/src/index.ts`; delete legacy rooms, branding,
  policies, benefits, add-ons, discount, payment, bank-field, and task-plan
  exports. The current wizard is not keep-as-is because it imports
  `AdaptiveHotelSetupStatus`, reads `setupPlan`, and renders task-plan state.
- **Keep/reduce the shared API:** retain property/profile and selected-track
  behavior in `apps/api/src/routes/sharedHotelSetupStatus.ts` and its tests, but
  remove task facts and task destinations from that route and
  `apps/api/src/platform/sharedHotelSetupStatusReadModel.ts`.
- **Repoint normal app switching before removing the adaptive payload:**
  `apps/marketplace-web/components/layout/AppSwitcher.tsx`,
  `apps/booking-admin/components/layout/Sidebar.tsx`, and
  `apps/pms-web/components/layout/Sidebar.tsx` currently read
  `organization.tracks[].components[].access`. Preserve their behavior by
  moving them to the permissioned entitlement/access read model; selected-track
  intent alone must not decide effective product access.
- **Keep the unmerged setup-task handoff prototype absent:** do not recreate
  `hotelSetupHandoffRepository`, `hotelSetupHandoffs` routes/tests,
  `hotelSetupHandoff` domain exports, or `hotel_catalog.setup_handoffs` storage.
  No forward retirement migration is required because neither the prototype nor
  `0042_hotel_setup_handoffs.sql` landed. The merged `0042` migration is
  `0042_canonical_property_profile_revision.sql` and is unrelated immutable
  history.
- **Retire the remaining inline task runtime deliberately:** rewrite or remove
  `packages/domain-hotels/src/adaptiveHotelSetup.ts`, its tests/exports, and the
  task-oriented implementation contract in
  `engineering/adaptive-hotel-onboarding.md` only when the replacement shell and
  producer readiness ports land. This retirement concerns inline task facts and
  destinations, not a handoff repository or table.
- **Preserve the selected-track contract:** keep
  `packages/backend-migration/migrations/0040_adaptive_hotel_setup.sql` and the
  `updateTracks` repository path. It is the existing canonical route-intent
  storage, not part of the retired task/handoff model.
- **Delete or reduce Marketplace task routing:** remove
  `apps/marketplace-web/components/setup/SetupTaskFormRouter.tsx`,
  `MarketplaceSetupTaskForm.tsx`, `components/setup/operations/*`,
  `services/api/hotelOperationsSetupClient.ts`, and their tests. Reduce
  `components/setup/SharedHotelSetupPage.tsx` to prerequisite/canonical setup
  hosting. Do not recreate the removed profile-completion task context. Preserve
  Marketplace authentication handoff/login behavior and its tests.
- **Keep cross-product task destinations absent:** the Booking Admin and PMS
  setup-task route utilities and destination adapters were removed before merge;
  do not recreate them. Preserve the existing authentication handoff pages and
  specs, plus redirects/guards that send an incomplete hotel to canonical
  `/setup`. Keep shared cross-app URL variables in frontend `.env.example` files
  and Docker build arguments because normal app switching and authentication
  consume them.
- **Rewrite task-specific browser coverage:** preserve
  `tests/e2e/booking-admin/handoff-authkit.spec.ts`,
  `tests/e2e/marketplace-web/handoff-authkit.spec.ts`, and
  `tests/e2e/pms-web/handoff.spec.ts` as authentication compatibility coverage.
  Remove only retired task activation scenarios from
  `tests/e2e/marketplace-web/setup-activation.spec.ts`. Rewrite the Booking Admin
  setup, Marketplace smoke, and shared setup mocks in
  `tests/e2e/booking-admin/setup.spec.ts`,
  `tests/e2e/marketplace-web/smoke.spec.ts`,
  `tests/e2e/support/bookingAdminMocks.ts`, `pmsWebMocks.ts`, and
  `sharedHotelSetupMocks.ts` around the minimal prerequisite contract.
- **Migrate Vayada Admin in ONB-04A:** replace the eight-step/raw-bank payload
  in `apps/vayada-admin/app/dashboard/invite-codes/page.tsx`,
  `apps/vayada-admin/services/api/inviteCodes.ts`, and
  `apps/api/src/routes/marketplaceAdmin.ts` with identity, organization,
  property, and selected-track intent. Validate a narrow payload instead of
  storing arbitrary JSON.
- **Delete old invite prefill after ONB-04A:** remove arbitrary onboarding
  prefill/lookup/redeem behavior from
  `apps/marketplace-api/app/routers/invite_codes.py` and unused Booking Admin
  invite-prefill translations. Invitation identity may remain.
- **Rewrite stale assertions/docs:** update
  `apps/api/src/hotelSetupTrackCommand.test.ts`,
  `engineering/marketplace-v6-notifications-newsletter-invite-contract.md`,
  `engineering/marketplace-route-migration-inventory.md`, and
  `engineering/next-stack-legacy-dependency-inventory.md` to describe only
  property/track provisioning and the reduced invite contract.

This list covers all current hotel-setup task consumers and confirms that the
separate setup-task handoff prototype is absent. Authentication handoff pages
and unrelated uses of “handoff” in booking-change or external integration
workflows are not part of this retirement.

## Source Migration Coverage

This section ensures every current migration history is represented. Counts are
from the repo at the time of this decision.

| Source history                    | File count | Target disposition                                                                                                                                                         |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-db/migrations`              | 5          | Identity/auth owns internal users, external identities, organizations, memberships, permissions, consent/privacy retention, and auth reconciliation.                       |
| `apps/marketplace-api/migrations` | 38         | Marketplace owns creator/listing/collaboration/trip/chat/notification tables. Removed local auth tables are retired; consent/GDPR history maps to privacy.                 |
| `apps/booking-api/migrations`     | 41         | Property catalog, booking/checkout, finance, and distribution split ownership of current booking hotel profile/config, add-ons, promos, events, and status.                |
| `apps/pms-api/migrations`         | 102        | PMS operations, booking/checkout, finance, distribution, Ask Intelligence, Platform Media, and jobs/events split ownership of operational PMS facts and side-effect state. |

### Current Source Table Mapping

| Current source table or group                                                              | Target owner(s)                                      | Target table/read model examples                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth `users`                                                                               | Identity/auth                                        | `users`, `external_identities`, `organizations`, `organization_memberships`.                                                                                                                   |
| Auth password reset, email verification/change, local TOTP, login rate-limit tables        | Deferred/retired after WorkOS                        | Source snapshots only for rollback/audit; not active target auth systems.                                                                                                                      |
| Auth consent and GDPR tables                                                               | Identity/privacy                                     | `cookie_consent`, `consent_history`, `gdpr_requests` or privacy-retention equivalent under identity ownership.                                                                                 |
| Marketplace removed auth tables                                                            | Deferred/retired                                     | Historical source only if any production rows remain outside auth-db.                                                                                                                          |
| Marketplace `creators`, `creator_platforms`, `creator_ratings`                             | Marketplace plus identity links                      | `creator_profiles`, `creator_platforms`, `creator_ratings`, `organization_resource_links`.                                                                                                     |
| Marketplace `hotel_profiles`, `hotel_listings`                                             | Hotel Catalog and Marketplace                        | `properties`, `property_profiles`, `marketplace_hotel_profiles`, collaboration preferences, and immutable profile-submission migration input. Legacy offers are not target onboarding records. |
| Marketplace listing requirements/offerings                                                 | Marketplace                                          | Normalize reusable values into hotel-level collaboration preferences; retire listing/offer rows after parity and rollback gates.                                                               |
| Marketplace collaborations, deliverables, chat, trips, external collaborations             | Marketplace                                          | `collaborations`, `collaboration_deliverables`, `marketplace_chat_messages`, `trips`, `external_collaborations`.                                                                               |
| Marketplace notifications, invite codes, newsletter preferences                            | Marketplace                                          | `marketplace_notifications`, `invite_codes`, `newsletter_preferences`.                                                                                                                         |
| Booking `booking_hotels` and translations                                                  | Hotel catalog, booking, finance, distribution        | `properties`, `property_profiles`, `quote_sessions`, `payment_settings`, `public_hotel_bookability_profiles`.                                                                                  |
| Booking add-ons and promo codes                                                            | Booking/checkout and distribution                    | `addon_definitions`, `booking_addon_selections`, `promo_applications`, public-safe quote inputs.                                                                                               |
| Booking events and commission changes                                                      | Booking/checkout, finance, audit                     | `booking_status_events`, `commission_rate_changes`, `product_audit_events`.                                                                                                                    |
| Booking platform status, billing plan, payout/payment fields                               | Finance and identity entitlement read model          | `billing_entitlements`, `payment_settings`, `payout_settings`, `request_context_resource_scope`.                                                                                               |
| Booking Lodgify tables and dropped Lodgify state                                           | Deferred/retired                                     | No active target owner unless production dependency is rediscovered.                                                                                                                           |
| PMS `hotels`                                                                               | Hotel catalog, PMS operations, finance, distribution | `properties`, `property_source_links`, PMS settings, `payment_settings`, `public_hotel_bookability_profiles`.                                                                                  |
| PMS `room_types`, `rooms`, rates, seasons, stay restrictions, room locations               | PMS operations and distribution read models          | `room_types`, `rooms`, `rate_plans`, `rate_rules`, `public_room_offer_snapshots`.                                                                                                              |
| PMS `bookings`, `booking_rooms`, `booking_drafts`, additional guests, check-in/out records | Booking/checkout and PMS operations                  | `guest_bookings`, `booking_guests`, `operational_booking_assignments`, `booking_checkin_records`, checkout records.                                                                            |
| PMS `room_blocks` and availability/calendar settings                                       | PMS operations and distribution read models          | `room_blocks`, `inventory_days`, `public_room_offer_snapshots`.                                                                                                                                |
| PMS payments, payouts, payment settings, deposits, manual/bank-transfer payment states     | Finance and booking/checkout                         | `payments`, `payouts`, `payment_settings`, booking payment state.                                                                                                                              |
| PMS cancellation policies                                                                  | PMS operations, Booking/checkout, Distribution       | Structured terms on `rate_plans`, confirmation evidence in `booking_policy_confirmations`, and guest-safe `public_room_offer_snapshots`.                                                       |
| PMS affiliates, affiliate clicks, affiliate payout settings                                | Identity/auth, finance, marketplace/distribution     | `organizations`, `organization_resource_links`, `payout_settings`, `commission_rules`, attribution read models.                                                                                |
| PMS Channex connections, mappings, markups, webhook events, sync errors                    | PMS operations and jobs/events/audit                 | `channel_connections`, mappings, `channel_sync_status`, `external_webhook_events`, `jobs`.                                                                                                     |
| PMS old Beds24 integration tables                                                          | Deferred/retired                                     | Source audit only; no active target owner after dropped integration.                                                                                                                           |
| PMS messaging tables                                                                       | PMS operations                                       | `message_threads`, `messages` if active at cutover; old dropped messaging tables are history only.                                                                                             |
| PMS-local `platform.media_objects` / `platform.media_variants`                             | Platform Media                                       | Reconcile the transitional PMS-local registry into canonical Platform Media and preserve attachment references; do not create another media owner.                                             |
| PMS booking notes/events/change requests                                                   | PMS operations, booking/checkout, jobs/events/audit  | Private notes, guest-visible status events, `booking_change_requests`, `product_audit_events`.                                                                                                 |
| PMS property module activations and setup/checklist/dashboard status fields                | Finance, Hotel setup read model, Ask Intelligence    | `billing_entitlements`, typed product readiness ports consumed by `adaptive_property_setup_read_model`, and `setup_completeness_snapshots`; no canonical `property_setup_status` table.        |

## Cross-Domain Access Contracts

| Consumer need                                      | Producer owner                  | Access boundary                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RequestContext resource resolution                 | Identity/auth                   | `request_context_resource_scope` read model; no product DB pools.                                                                                                              |
| Adaptive hotel setup route/progress                | Hotel setup/catalog             | `adaptive_property_setup_read_model` composes selected tracks, drafts, and typed domain readiness ports; it never joins product tables or decides readiness itself.            |
| Public hotel profile for marketplace/landing       | Hotel catalog                   | `property_public_profile_read_model`; marketplace may add marketplace-owned listing fields.                                                                                    |
| Property and room media                            | Platform Media + assignee owner | Platform Media owns safe objects/variants; Catalog and PMS own expected-revision presentation assignments. Finalizing an upload never publishes it.                            |
| Public AI bookability and quotes                   | Distribution/bookability        | `public_hotel_bookability_profiles`, `public_room_offer_snapshots`, `public_quote_read_models`.                                                                                |
| Booking publication                                | Booking + Distribution          | Booking submits a source manifest after typed readiness checks; Distribution atomically creates/selects an immutable public revision while PMS updates live ARI independently. |
| Payment-method readiness                           | Finance                         | `payment_readiness_read_model`; Booking consumes method-level selected/ready/blocker state and never reads provider tables.                                                    |
| PMS calendar/operations view of guest bookings     | Booking/checkout                | `direct_booking_summary_read_model` plus PMS-owned operational assignments.                                                                                                    |
| Booking Engine handoff to a PMS                    | PMS operations                  | `engineering/pms-reservation-integration-contract.md` PMS reservation sink; Vayada PMS and external PMS systems implement the same boundary.                                   |
| Finance dashboards and payout visibility           | Finance                         | `finance_visibility_read_model` gated by finance permission keys.                                                                                                              |
| Ask Intelligence hotel performance answers         | Ask Intelligence                | Evidence tools over curated booking/PMS/finance/read-model inputs; no arbitrary SQL.                                                                                           |
| Channex side-effect retries and webhook processing | PMS + jobs/events/audit         | PMS owns normalized channel state; jobs/audit owns raw receipts, job attempts, and dead-letter state.                                                                          |
| Product audit timelines                            | Jobs/events/audit               | `product_audit_events` with actor, organization, target resource, action, and correlation metadata.                                                                            |

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
