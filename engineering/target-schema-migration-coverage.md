# Target Schema Migration Coverage

_VAY-669 migration coverage record. Depends on
[`engineering/target-schema-ownership-map.md`](target-schema-ownership-map.md),
[`engineering/migration-parity-harness.md`](migration-parity-harness.md), and
[`engineering/typescript-rewrite-implementation-roadmap.md`](typescript-rewrite-implementation-roadmap.md)._

## Current Coverage Correction (VAY-1044)

The row-level coverage tables below are the historical VAY-669 planning
snapshot, not the authoritative source-object inventory. Their target-table
notes remain useful, but their disposition, owner, status, parity, and PII cells
may be stale; the VAY-1350 TSV contract below supersedes those cells. Registered
fixture transforms and parity checks now cover active Hotel Catalog, Booking,
Finance, PMS, Marketplace, Distribution, and Platform Media paths. Treat those
cases as **existing work to extend**, even where an older row says `DDL only` or
`not started`.

For Marketplace specifically, that baseline is the landed legacy offer
transform/parity. Hotel-level collaboration preferences and their read model are
a new replacement contract: reuse legacy values only as migration input, then
retire the offer-shaped onboarding tables and projections after parity and
rollback gates pass.

What may still be open is production source extraction, complete coverage of
every historical source table, staging rehearsal, and the new contracts listed
in
[`Adaptive Hotel Onboarding Ownership (VAY-1044)`](target-schema-ownership-map.md#adaptive-hotel-onboarding-ownership-vay-1044).
Do not create duplicate transforms or parity harnesses from the historical
status text. The genuinely new onboarding work is setup drafts/progress, shared
source manifests, the hotel-level Marketplace preference target store/read
model, immutable Marketplace and Booking lifecycles, split PMS source commands
and durable reservation receipts, and per-method Finance readiness.

## Production Source Inventory Contract (VAY-1350)

The authoritative production migration inventory is the machine-readable
[`packages/backend-migration/source-inventory.tsv`](../packages/backend-migration/source-inventory.tsv).
It covers every table, sequence, and extension created by the four legacy
migration histories and runners, plus scheduled/background writers, guarded
provider controls, provider webhooks, and managed object-store references. Each
record has exactly one disposition, target owner, fixture/parity category, PII
classification, retention policy, cutover writer, and follow-up ticket.
`sourceInventory.test.ts` compares the contract with the checked-in migration
and writer code so an omitted object or duplicate owner fails CI.

The registered fixture cases remain synthetic transform/parity evidence. They
do **not** extract production rows and do not prove that complete production
history has been migrated. VAY-1351 owns immutable source extraction; domain
ETL remains in VAY-1352 through VAY-1358, full parity in VAY-1359, and rehearsal
and cutover commands in VAY-1360.

Row-level blockers are not inferred from fixtures: VAY-1352 owns stable user-ID
conflicts, VAY-1354 owns duplicate property ownership/source links, VAY-1355
through VAY-1358 own domain orphan-FK and provider-record reconciliation, and
VAY-1359 blocks cutover on any unresolved result. The inventory's PII,
retention-policy, and cutover-writer fields make data handling and provider
ownership explicit meanwhile. `RETENTION_POLICIES` requires row-bearing source
copies to be destroyed after the approved rollback window; VAY-1363 owns that
window and destruction evidence. Retire-only manual scripts, especially the
Marketplace GDPR recreation and PMS hotel-ID unification scripts, must not run
after the immutable snapshots are taken.

The VAY-1351 extractor must accept all four immutable snapshot identifiers
(`--auth-snapshot-arn`, `--booking-snapshot-arn`,
`--marketplace-snapshot-arn`, and `--pms-snapshot-arn`) plus the exact reviewed
40-character repository commit as `--source-schema-revision`. Before reading
rows it must execute the read-only schema fingerprint and per-active-table count
queries exported by `sourceInventory.ts` inside its repeatable-read, read-only
transaction, and record those results in the snapshot manifest. Media payloads
use the separately versioned manifest owned by VAY-1055. This inventory ticket
adds no production connection or live-row access. The manifest explicitly marks
auth avatars, Booking add-on images, and Booking logo/favicon URLs as fixture
gaps for VAY-1055. Marketplace's upload route also permits arbitrary
client-supplied prefixes; the inventory records that discovery risk separately
from its known `images`, `hotels`, `listings`, `creators`, and `chat` prefixes.

## Access Restriction

All four source databases (auth, marketplace, booking, PMS) remain the sole
production source of truth until the reviewed cutover window described in the
[migration/parity harness design](migration-parity-harness.md). No TypeScript
runtime code — route handlers, RequestContext resolution, domain services, or
read-model refreshes — may open a source database pool for normal product
queries. Source database access is exclusively a migration and parity concern,
executed by reviewed commands in `packages/backend-migration` with explicit
snapshot identifiers, advisory locks, and go/no-go gates. Any TypeScript package
that imports a source database connection outside of migration tooling is a
blocking review finding.

---

## Coverage Tables

Column definitions:

- **Disposition** — `migrate` (row-for-row with transforms), `transform`
  (schema or semantic change required), `retire` (active target table no longer
  needed; source rows not carried forward), `source snapshot only` (kept as
  rollback/audit evidence; no live target owner), `defer` (ownership or
  transform not yet resolved).
- **Status** — `done` (migration disposition is fully covered for that source
  row/group), `done (DDL + transform)` (target DDL, source-to-target transform,
  and parity coverage are merged), `done (DDL only)` (target DDL is merged, but
  source-to-target transforms and parity fixtures are still open), `in progress`
  (DDL, transform, or fixture work is open in a current ticket), `planned`
  (ticket exists or this doc is the planning artifact), `not started`.
- **Parity check** — the harness check category from
  [`migration-parity-harness.md`](migration-parity-harness.md).
- **PII/exposure** — `PII` (table contains personal data subject to retention
  rules), `public` (appears in a public/AI-readable read model), `private`
  (internal only, no public surface), `retired` (no live target).

---

### Auth (`auth-db/migrations`, 5 migration files)

| Source table                | Target domain     | Target table / read model                                                                                       | Disposition          | Status                 | Parity check                                                                                          | PII/exposure |
| --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `users`                     | Identity/auth     | `identity.users`, `identity.external_identities`, `identity.organizations`, `identity.organization_memberships` | transform            | done (DDL + transform) | User count; stable internal IDs; WorkOS external identity uniqueness; membership/resource-link parity | PII          |
| `password_reset_tokens`     | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `email_verification_codes`  | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `email_verification_tokens` | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `email_change_tokens`       | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `totp_secrets`              | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `totp_recovery_codes`       | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `login_audit_log`           | Jobs/events/audit | `platform.product_audit_events`                                                                                 | transform            | done (DDL only)        | Audit event count; actor/correlation metadata parity                                                  | PII          |
| `login_rate_limit`          | Identity/auth     | —                                                                                                               | source snapshot only | done                   | Retired source rows present only in allowed audit/snapshot disposition                                | retired      |
| `cookie_consent`            | Identity/privacy  | `cookie_consent` (privacy-retention equivalent under identity ownership)                                        | migrate              | not started            | Row count; visitor/user scope; consent preference parity                                              | PII          |
| `consent_history`           | Identity/privacy  | `consent_history` (privacy-retention equivalent)                                                                | migrate              | not started            | Append-only row count; grant/withdrawal event distribution                                            | PII          |
| `gdpr_requests`             | Identity/privacy  | `gdpr_requests` (privacy-retention equivalent)                                                                  | migrate              | not started            | Request count; status distribution; lifecycle completeness                                            | PII          |

Notes:

- `users.type` and `users.is_superadmin` are transform inputs only and must not
  appear in any target table or authorization primitive. See
  [`target-schema-ownership-map.md`](target-schema-ownership-map.md) —
  Ownership Rules.
- Privacy-retention tables (`cookie_consent`, `consent_history`,
  `gdpr_requests`) are Vayada-owned but belong to identity/privacy retention,
  not the WorkOS provider auth layer. Their target DDL tickets are separate from
  the WorkOS identity migration.
- Platform jobs/events/audit target DDL landed in VAY-676 via
  `packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql`.
  The `done (DDL only)` status above means source-to-target transforms and
  parity fixtures remain open.

---

### Booking (`apps/booking-api/migrations`, 41 migration files)

| Source table                 | Target domain                          | Target table / read model                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Disposition | Status          | Parity check                                                                             | PII/exposure |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `booking_hotels`             | Hotel catalog + finance + distribution | `hotel_catalog.properties`, `hotel_catalog.property_source_links`, `hotel_catalog.property_slugs`, `hotel_catalog.property_domains`, `hotel_catalog.property_locations`, `hotel_catalog.property_profiles`, `hotel_catalog.property_media`, `hotel_catalog.property_amenities`, `hotel_catalog.property_contact_channels`, `hotel_catalog.property_policy_summaries`, `hotel_catalog.property_public_profile_read_model`, `distribution.public_hotel_bookability_profiles` | transform   | done (DDL only) | Hotel profile/config counts; slug uniqueness; public read model PII exclusion            | public       |
| `booking_hotel_translations` | Hotel catalog                          | `hotel_catalog.property_profiles` (per-locale rows)                                                                                                                                                                                                                                                                                                                                                                                                                        | transform   | done            | Locale coverage per property; fallback behavior parity                                   | private      |
| `booking_addons`             | Booking/checkout + distribution        | `booking.addon_definitions`, public-safe add-on inputs in `distribution.public_room_offer_snapshots`                                                                                                                                                                                                                                                                                                                                                                       | transform   | done (DDL only) | Add-on count per hotel; price/category parity                                            | private      |
| `booking_events`             | Booking/checkout + jobs/events/audit   | `booking.booking_status_events`, `platform.product_audit_events`                                                                                                                                                                                                                                                                                                                                                                                                           | transform   | done (DDL only) | Event count; funnel analytics keyed by hotel slug; guest PII exclusion from audit events | PII          |
| `booking_promo_codes`        | Booking/checkout + distribution        | `booking.promo_applications`, public-safe promo inputs in `distribution.public_quote_read_models`                                                                                                                                                                                                                                                                                                                                                                          | transform   | done (DDL only) | Promo code count; validity window; usage tracking parity                                 | private      |
| `commission_rate_changes`    | Finance                                | `finance.commission_rate_changes`                                                                                                                                                                                                                                                                                                                                                                                                                                          | migrate     | not started     | Audit row count; old/new value integrity; timestamp ordering                             | private      |

Notes:

- Dropped Lodgify tables from the booking migration history have no active
  target owner. They are `source snapshot only` for audit; no parity checks
  required unless a production dependency is rediscovered.
- Booking/checkout target DDL landed in VAY-671 via
  `packages/backend-migration/migrations/0005_booking_checkout.sql`. The
  `not started` statuses above refer to source-to-target transforms and parity
  fixtures, not missing target tables.
- Booking platform status, billing plan, and payout/payment fields embedded in
  `booking_hotels` split across `finance.billing_entitlements`,
  `finance.payment_settings`, and `finance.payout_settings`. Finance target DDL
  landed in VAY-673. VAY-1281 adds immutable affiliate payout payment-evidence
  rows; source transforms and parity fixtures remain open.
- Distribution target DDL landed in VAY-675 via
  `packages/backend-migration/migrations/0009_distribution.sql`. The
  `done (DDL only)` statuses above mean source-to-target transforms and parity
  fixtures remain open.
- Platform jobs/events/audit target DDL landed in VAY-676 via
  `packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql`.
  The `done (DDL only)` statuses above mean source-to-target transforms and
  parity fixtures remain open.

---

### PMS (`apps/pms-api/migrations`, 102 migration files)

| Source table                                                  | Target domain                                           | Target table / read model                                                                                                                                                                                                      | Disposition | Status                     | Parity check                                                                                                                   | PII/exposure |
| ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `hotels`                                                      | Hotel catalog + PMS operations + finance + distribution | `hotel_catalog.properties`, `hotel_catalog.property_source_links`, `hotel_catalog.property_locations`, `hotel_catalog.property_policy_summaries`, `finance.payment_settings`, `distribution.public_hotel_bookability_profiles` | transform   | done (DDL only)            | Hotel count; timezone/address/geo parity; payment settings split                                                               | PII          |
| `room_types`                                                  | PMS operations + distribution                           | `pms.room_types`, `distribution.public_room_offer_snapshots`                                                                                                                                                                   | transform   | done (DDL only)            | Room type count per hotel; rate/occupancy parity; public read model excludes private channel fields                            | private      |
| `rooms`                                                       | PMS operations                                          | `pms.rooms`                                                                                                                                                                                                                    | migrate     | not started                | Physical room instance count; status distribution                                                                              | private      |
| `bookings`                                                    | Booking/checkout + PMS operations                       | `booking.guest_bookings`, `booking.booking_guests`, `pms.operational_booking_assignments`                                                                                                                                      | transform   | not started                | Booking count; status distribution (active/future must match exactly); guest PII retention rules; booking reference uniqueness | PII          |
| `booking_rooms`                                               | PMS operations                                          | `pms.operational_booking_assignments` (positions 1..N)                                                                                                                                                                         | migrate     | not started                | Multi-room assignment count; position integrity                                                                                | private      |
| `booking_additional_guests`                                   | Booking/checkout                                        | `booking.booking_guests`                                                                                                                                                                                                       | migrate     | not started                | Additional guest count per booking; per-person identity parity                                                                 | PII          |
| `booking_notes`                                               | PMS operations                                          | `pms.booking_notes_private`                                                                                                                                                                                                    | migrate     | not started                | Note count per booking; guest-visibility flag; no public/AI surface                                                            | PII          |
| `booking_change_requests`                                     | Booking/checkout                                        | `booking.booking_change_requests`                                                                                                                                                                                              | migrate     | not started                | Change request count; status distribution; decision token integrity                                                            | private      |
| `booking_events` (PMS)                                        | Jobs/events/audit                                       | `platform.product_audit_events`                                                                                                                                                                                                | migrate     | done (DDL only)            | Immutable audit row count; actor/payload JSONB parity                                                                          | private      |
| `booking_drafts`                                              | Booking/checkout                                        | `booking.checkout_contexts` (unmaterialized); `booking.guest_bookings` (materialized)                                                                                                                                          | transform   | not started                | Draft count; expiry/soft-hold integrity; guest PII in unmaterialized drafts                                                    | PII          |
| `booking_checkin_records`                                     | PMS operations                                          | `pms.booking_checkin_records`                                                                                                                                                                                                  | migrate     | not started                | Checkin record count; checklist step completeness                                                                              | private      |
| `booking_checkout_records`                                    | PMS operations                                          | `pms.booking_checkout_records`                                                                                                                                                                                                 | migrate     | not started                | Checkout record count; settled/waived charge integrity                                                                         | private      |
| `booking_checkout_charges`                                    | PMS operations + finance                                | `pms.booking_checkout_charges`, finance read models                                                                                                                                                                            | transform   | not started                | Charge count; payment/waiver status distribution; financial total parity                                                       | private      |
| `room_blocks`                                                 | PMS operations + distribution                           | `pms.room_blocks`, `pms.inventory_days`, `distribution.public_room_offer_snapshots`                                                                                                                                            | migrate     | done (DDL only)            | Block count per room type; date-range integrity; availability side-effects                                                     | private      |
| `affiliates`                                                  | Identity + finance + marketplace                        | `identity.organization_resource_links`, `finance.payout_settings`, `finance.commission_rules`                                                                                                                                  | transform   | not started                | Affiliate count; Stripe Connect ID preservation; approval status parity                                                        | PII          |
| `affiliate_payout_settings`                                   | Finance                                                 | `finance.payout_settings`                                                                                                                                                                                                      | migrate     | not started                | Payout method count per user; PayPal/bank/Stripe/Xendit settings parity                                                        | PII          |
| `affiliate_clicks`                                            | Finance + distribution                                  | attribution read models                                                                                                                                                                                                        | migrate     | not started                | Click count; IP/user-agent retention policy compliance; referral attribution parity                                            | PII          |
| `payments`                                                    | Finance                                                 | `finance.payments`                                                                                                                                                                                                             | migrate     | not started                | Payment count; Stripe/Xendit transaction ID uniqueness; amount/status parity; refund state                                     | PII          |
| `payouts`                                                     | Finance                                                 | `finance.payouts`                                                                                                                                                                                                              | migrate     | not started                | Payout count; transfer ID uniqueness; retry state; payment method parity                                                       | private      |
| `hotel_payment_settings`                                      | Finance                                                 | `finance.payment_settings`, `finance.payment_provider_accounts`                                                                                                                                                                | transform   | not started                | Payment provider count per hotel; Stripe Connect account preservation; enabled method parity                                   | PII          |
| `cancellation_policies`                                       | PMS pricing + Booking/Distribution                      | Structured cancellation snapshots on `pms.rate_plans`; `booking.booking_policy_confirmations`; guest-safe terms in `distribution.public_room_offer_snapshots`                                                                  | transform   | not started                | Policy count per hotel; structured free-cancel cutoff/refund/no-show parity; Booking confirmation source revisions             | private      |
| `channex_connections`                                         | PMS operations + jobs/events/audit                      | `pms.channel_connections`, `pms.channel_sync_status`                                                                                                                                                                           | migrate     | not started                | Connection count per hotel; sync timestamp parity; last ARI sync error state                                                   | private      |
| `channex_room_type_mappings`                                  | PMS operations                                          | `pms.channel_room_type_mappings`                                                                                                                                                                                               | migrate     | not started                | Mapping count; Channex room type ID preservation                                                                               | private      |
| `channex_rate_plan_mappings`                                  | PMS operations                                          | `pms.channel_rate_plan_mappings`                                                                                                                                                                                               | migrate     | not started                | Rate plan mapping count; multi-plan per room integrity                                                                         | private      |
| `channex_booking_mappings`                                    | PMS operations                                          | `pms.channel_booking_mappings`                                                                                                                                                                                                 | migrate     | not started                | Booking mapping count; multi-room slot index integrity                                                                         | private      |
| `channex_channel_markups`                                     | PMS operations                                          | `pms.channel_rate_plan_mappings` (markup fields)                                                                                                                                                                               | migrate     | not started                | Markup count per hotel and channel; percentage value integrity                                                                 | private      |
| `channex_webhook_events`                                      | Jobs/events/audit                                       | `platform.external_webhook_events`                                                                                                                                                                                             | transform   | done (DDL only)            | Webhook delivery log count; pipeline health parity                                                                             | private      |
| `message_threads`                                             | PMS operations                                          | `pms.message_threads`                                                                                                                                                                                                          | migrate     | not started                | Thread count; unread count; last-message metadata parity                                                                       | PII          |
| `messages`                                                    | PMS operations                                          | `pms.messages`                                                                                                                                                                                                                 | migrate     | not started                | Message count per thread; direction/body parity; raw channel payload                                                           | PII          |
| `message_attachments`                                         | PMS operations                                          | `pms.message_attachments`                                                                                                                                                                                                      | migrate     | not started                | Attachment count; S3 key / source URL integrity                                                                                | private      |
| PMS-local `platform.media_objects`, `platform.media_variants` | Platform Media                                          | Canonical `platform.media_objects`, `platform.media_variants`                                                                                                                                                                  | transform   | done (source + target DDL) | Media-object and variant counts; lifecycle/visibility parity; attachment foreign-reference integrity                           | conditional  |
| `checkin_checklist_templates`                                 | PMS operations                                          | `pms.checkin_checklist_templates`                                                                                                                                                                                              | migrate     | not started                | Template count per hotel; step definition parity                                                                               | private      |
| `checkout_inspection_templates`                               | PMS operations                                          | `pms.checkout_inspection_templates`                                                                                                                                                                                            | migrate     | not started                | Template count per hotel; step definition parity                                                                               | private      |
| `property_module_activations`                                 | Finance + typed product readiness                       | `finance.billing_entitlements`; producer readiness projections consumed by `adaptive_property_setup_read_model`                                                                                                                | transform   | not started                | Module activation parity against entitlements plus producer readiness; no canonical `property_setup_status` table              | private      |

Notes:

- Dropped Beds24 integration tables have no active target owner. They are
  `source snapshot only` for audit.
- Old dropped messaging tables (pre-current PMS messaging schema) are migration
  history only; parity checks apply only to live `message_threads` /
  `messages` rows.
- Rate seasons, daily/monthly rate overrides, weekend surcharges, min/max stay
  rules, same-day cutoff, and last-minute discount fields embedded in PMS
  `room_types` or associated rate tables map to `pms.rate_plans` and
  `pms.rate_rules`.
- PMS operations target DDL is added in VAY-672 via
  `packages/backend-migration/migrations/0006_pms_operations.sql`. The
  `not started` statuses above refer to source-to-target transforms and parity
  fixtures, not missing PMS target tables.
- Distribution target DDL is added in VAY-675 via
  `packages/backend-migration/migrations/0009_distribution.sql`. The
  `done (DDL only)` statuses above mean source-to-target transforms and parity
  fixtures remain open.
- Platform jobs/events/audit target DDL is added in VAY-676 via
  `packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql`.
  The `done (DDL only)` statuses above mean source-to-target transforms and
  parity fixtures remain open.
- `booking_drafts` materialization is a conditional transform: unmaterialized
  drafts that expired before payment become checkout context history; drafts
  that resulted in a confirmed booking flow into `booking.guest_bookings` via
  the normal booking transform path.

---

### Marketplace (`apps/marketplace-api/migrations`, 38 migration files)

| Source table                                           | Target domain               | Target table / read model                                                                                            | Disposition          | Status                    | Parity check                                                                                                      | PII/exposure |
| ------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| `users` (local copy, dropped in migration 028)         | Identity/auth               | Historical migration input only                                                                                      | source snapshot only | not started               | Confirm no active rows outside auth-db before cutover                                                             | PII          |
| `creators`                                             | Marketplace + identity      | `marketplace.creator_profiles`, `identity.organization_resource_links`                                               | transform            | done (DDL only)           | Creator count; profile-completion status parity; creator type                                                     | PII          |
| `creator_platforms`                                    | Marketplace                 | `marketplace.creator_platforms`                                                                                      | migrate              | done (DDL only)           | Platform account count per creator; follower/engagement analytics parity                                          | private      |
| `creator_ratings`                                      | Marketplace                 | `marketplace.creator_ratings`                                                                                        | migrate              | done (DDL only)           | Rating count; hotel-to-creator direction; collaboration link integrity                                            | private      |
| `hotel_profiles`                                       | Hotel catalog + marketplace | `hotel_catalog.properties` (catalog identity); `marketplace.marketplace_hotel_profiles` (marketplace-specific state) | transform            | done (DDL/catalog)        | Hotel profile count; email/category columns noted as dropped in migrations                                        | PII          |
| `hotel_listings`                                       | Marketplace + hotel catalog | `marketplace.marketplace_offers`, `hotel_catalog.property_source_links`                                              | transform            | done (transform + parity) | Offer count; source-to-offer link; offer-to-property link; legacy hotel facts retained only for migration prefill | private      |
| `listing_collaboration_offerings`                      | Marketplace                 | `marketplace.offer_compensation_options`                                                                             | transform            | done (transform + parity) | Compensation option count per offer; type, limits, terms, and availability parity                                 | private      |
| `listing_creator_requirements`                         | Marketplace                 | `marketplace.offer_creator_requirements`                                                                             | transform            | done (transform + parity) | Requirement count per offer; platform, country, age, and creator-type parity                                      | private      |
| `password_reset_tokens` (dropped in migration 028)     | Identity/auth               | —                                                                                                                    | source snapshot only | not started               | Retired local auth table                                                                                          | retired      |
| `email_verification_codes` (dropped in migration 028)  | Identity/auth               | —                                                                                                                    | source snapshot only | not started               | Retired local auth table                                                                                          | retired      |
| `email_verification_tokens` (dropped in migration 028) | Identity/auth               | —                                                                                                                    | source snapshot only | not started               | Retired local auth table                                                                                          | retired      |
| `collaborations`                                       | Marketplace                 | `marketplace.collaborations`                                                                                         | migrate              | done (DDL only)           | Collaboration count; status distribution; affiliate tracking fields; negotiated terms parity                      | private      |
| `chat_messages`                                        | Marketplace                 | `marketplace.marketplace_chat_messages`                                                                              | migrate              | done (DDL only)           | Message count per collaboration; type/direction/image message parity                                              | PII          |
| `collaboration_deliverables`                           | Marketplace                 | `marketplace.collaboration_deliverables`                                                                             | migrate              | done (DDL only)           | Deliverable count per collaboration; platform/type/status parity                                                  | private      |
| `cookie_consent` (dropped in migration 028)            | Identity/privacy            | —                                                                                                                    | source snapshot only | not started               | Retired; production rows in auth-db `cookie_consent` are the active source                                        | retired      |
| `consent_history` (dropped in migration 028)           | Identity/privacy            | —                                                                                                                    | source snapshot only | not started               | Retired local consent table                                                                                       | retired      |
| `gdpr_requests` (dropped in migration 028)             | Identity/privacy            | —                                                                                                                    | source snapshot only | not started               | Retired local GDPR table                                                                                          | retired      |
| `newsletter_preferences`                               | Marketplace                 | `marketplace.newsletter_preferences`                                                                                 | migrate              | done (DDL only)           | Preference count; opt-in/out parity; optional country filter                                                      | private      |
| `trips`                                                | Marketplace                 | `marketplace.trips`                                                                                                  | migrate              | done (DDL only)           | Trip count per creator; location/date range parity                                                                | private      |
| `external_collaborations`                              | Marketplace                 | `marketplace.external_collaborations`                                                                                | migrate              | done (DDL only)           | External collaboration count; optional trip link integrity                                                        | private      |
| `invite_codes`                                         | Marketplace                 | `marketplace.invite_codes`                                                                                           | migrate              | done (DDL only)           | Code count; redemption tracking; expiry parity                                                                    | private      |
| `notifications`                                        | Marketplace                 | `marketplace.marketplace_notifications`                                                                              | migrate              | done (DDL only)           | Notification count; read-state distribution; creator approval alert parity                                        | private      |

Notes:

- The marketplace local `users`, `password_reset_tokens`,
  `email_verification_codes`, `email_verification_tokens`, `cookie_consent`,
  `consent_history`, and `gdpr_requests` tables were dropped in migration 028.
  They are `source snapshot only` and blocked from active target migration. The
  parity harness `retired-or-deferred-sources` fixture case must confirm no
  production rows exist outside auth-db for the local auth tables.
- Marketplace `hotel_profiles.email` and `hotel_profiles.category` columns were
  dropped in a later migration; the parity harness must not expect these fields.
- Marketplace target DDL landed in VAY-674 via
  `packages/backend-migration/migrations/0008_marketplace.sql`. The
  `done (DDL only)` statuses above mean source-to-target transforms and parity
  fixtures remain open.

---

## Domain DDL Follow-up Order

The table below lists which target domains still require DDL migration files and
the recommended sequencing. The order respects FK dependencies and the principle
that contracts precede DDL.

DDL tickets must each cover a single domain's schema. They must not mix schema
design, ETL transform logic, and product route behavior in the same PR. See
[`typescript-rewrite-implementation-roadmap.md`](typescript-rewrite-implementation-roadmap.md)
Phase 4 and the DDL Readiness Checklist in
[`target-schema-ownership-map.md`](target-schema-ownership-map.md).

| Order | Domain schema                  | DDL status                                         | Representative remaining target tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Blocking dependency                                                                                                                            |
| ----- | ------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `booking`                      | Done in VAY-671                                    | DDL merged for `quote_sessions`, `checkout_contexts`, `guest_bookings`, `booking_guests`, `addon_definitions`, `booking_addon_selections`, `promo_applications`, `booking_status_events`, `booking_change_requests`, `booking_notes_public`, `direct_booking_summary_read_model`. Source-to-target transforms and parity fixtures remain open.                                                                                                                                                            | Identity DDL done; hotel catalog DDL done; PMS reservation sink contract done (`domain-pms`); finance billing contract done (`domain-finance`) |
| 2     | `pms`                          | Done in VAY-672                                    | DDL added for `room_types`, `rooms`, `rate_plans`, `rate_rules`, `inventory_days`, `room_blocks`, `operational_booking_assignments`, check-in/out records, private notes, messaging, channel mappings, and `channel_sync_status`. Source-to-target transforms and parity fixtures remain open.                                                                                                                                                                                                            | Booking DDL done for `operational_booking_assignments` FK; Channex job/event contracts done (`domain-pms-channex`)                             |
| 3     | `finance`                      | Done in VAY-673; payout evidence added in VAY-1281 | DDL added for `payment_provider_accounts`, `payment_settings`, `payments`, `payouts`, `payout_settings`, `affiliate_payout_payment_evidence`, `commission_rules`, `commission_rate_changes`, `billing_entitlements`, and `finance_visibility_read_model`. Source-to-target transforms and parity fixtures remain open.                                                                                                                                                                                    | Booking DDL done for payment FK; PMS DDL done for channel-payout source links; `domain-finance` contracts done                                 |
| 4     | `marketplace`                  | Done in VAY-674; offer model updated in VAY-1012   | DDL includes `creator_profiles`, `creator_platforms`, `creator_ratings`, `marketplace_hotel_profiles`, `marketplace_offers`, `offer_deliverables`, `offer_compensation_options`, `offer_creator_requirements`, `collaborations`, `collaboration_deliverables`, `marketplace_chat_messages`, `trips`, `external_collaborations`, `marketplace_notifications`, `invite_codes`, `newsletter_preferences`, and `marketplace_offer_read_model`. Marketplace offer transforms and parity fixtures are complete. | Identity, hotel catalog, and finance DDL done; `domain-marketplace` contracts done                                                             |
| 5     | `distribution`                 | Done in VAY-675                                    | DDL added for `public_hotel_bookability_profiles`, `public_room_offer_snapshots`, `public_quote_read_models`, `booking_deep_link_contexts`, `external_api_clients`, and `external_api_usage_events`. Source-to-target transforms and parity fixtures remain open.                                                                                                                                                                                                                                         | Hotel catalog read model done; booking quote sessions and PMS rate/inventory DDL done; public-bookability and GEO validation contracts done    |
| 6     | `platform` (jobs/events/audit) | Done in VAY-676                                    | DDL added for `domain_events`, `outbox_events`, `jobs`, `job_attempts`, `dead_letter_events`, `idempotency_keys`, `product_audit_events`, `external_webhook_events`, plus `schema_migrations` ledger indexes. Source-to-target transforms and parity fixtures remain open.                                                                                                                                                                                                                                | All domain DDL needed to prove event FK references; jobs/events contract done                                                                  |
| 7     | `intelligence`                 | Retired by migration `0090`                        | Historical DDL from VAY-677 is preserved in the immutable migration chain, but the final target state removes the complete schema, its parity fixtures, and its runtime package. No Ask Intelligence implementation work remains open.                                                                                                                                                                                                                                                                    | Future hotel employee agent design starts from VAY-1091 rather than this retired schema                                                        |

---

## Source Migration History Completeness

Every current migration history is represented in this document or explicitly
deferred with rationale.

| Source history                    | File count | Coverage status | Notes                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-db/migrations`              | 5          | Fully covered   | Retired local credential/rate-limit tables are snapshot-only; platform audit DDL added in VAY-676 for login audit events; privacy-retention tables need separate DDL tickets                                                                                                                                                                                                       |
| `apps/marketplace-api/migrations` | 38         | Fully covered   | Dropped local auth tables confirmed retired; marketplace DDL added in VAY-674; finance DDL added in VAY-673 for commission/payout dependencies; transforms/parity fixtures not started                                                                                                                                                                                             |
| `apps/booking-api/migrations`     | 41         | Fully covered   | Dropped Lodgify state is source snapshot only; booking/checkout DDL merged in VAY-671; distribution DDL added in VAY-675; platform audit/event DDL added in VAY-676; ETL transforms and parity fixtures not started                                                                                                                                                                |
| `apps/pms-api/migrations`         | 102        | Fully covered   | Includes the latest Channex ARI error fields and transitional Platform Media attachment registry; dropped Beds24 and old messaging tables are source snapshot only; PMS DDL added in VAY-672; finance DDL added in VAY-673 for payment/payout dependencies; distribution DDL added in VAY-675; platform webhook/audit DDL added in VAY-676; transforms/parity fixtures not started |

Ask Intelligence target DDL historically landed in VAY-677 via
`packages/backend-migration/migrations/0011_intelligence.sql`. Migration `0090`
now removes that schema, all persisted Ask data and audit history, and its
Ask-only permissions. The older migration remains unchanged solely so existing
database migration checksums and fresh replays stay valid. Any future agent
architecture belongs to VAY-1091 and must not treat this retired schema as its
starting contract.
