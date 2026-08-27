# Backend database restructure plan

_VAY-605 decision record. Inputs: VAY-600 WorkOS identity architecture,
VAY-601 Ask Intelligence architecture, VAY-602 target TypeScript backend
structure, VAY-604 AI-agent bookability, and the VAY-605 schema audit._

> **Retirement update:** VAY-601 is a historical input only. Migration `0090`
> removes the retired Ask Intelligence schema and data. Any future hotel
> employee agent starts from VAY-1091 with a new design and storage model.

## Recommendation

Proceed with a **planned big-bang database rewrite**, but do not confuse that
with editing production tables in place.

The target should be a new schema designed from the active VAY-600, VAY-602,
and VAY-604 decisions, built and validated in parallel, then cut over in one
coordinated production migration. The current auth, marketplace, booking, and
PMS databases remain the source of truth until the cutover window. Before that
window, all rewrite work should happen through target-schema DDL, migration
scripts, application compatibility work, staging rehearsals, and cutover
runbooks.

The target should be:

- one internal identity and authorization model for users, organizations,
  memberships, permissions, entitlements, and resource links;
- domain-owned writes, where each table has one authoritative owner;
- typed read models for cross-domain consumers instead of product services
  directly opening each other's database pools;
- public bookability data treated as a distribution concern, with no current
  owner-agent schema;
- Booking Engine and PMS operations separated per
  `engineering/booking-pms-domain-boundaries.md`, so direct booking/checkout
  does not become dependent on Vayada PMS tables and Vayada PMS remains one
  interchangeable PMS implementation;
- deterministic migration scripts from legacy databases into the new schema;
- a rehearsed cutover plan with write freeze, parity checks, rollback, and
  post-cutover monitoring.

VAY-603 should use this plan as the database input to the integrated roadmap.
The roadmap should not assume that the TypeScript backend can safely inherit
the current table boundaries as permanent boundaries, and it should treat the
database rewrite as a program-level cutover rather than a series of independent
production table edits.

## Current schema audit

The repo currently has separate migration histories for:

| Area        | Migration path                    | Current role                                                                                                                                                                                          |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | `auth-db/migrations`              | Shared local identity, consent, GDPR, local password reset, email verification, TOTP, login audit/rate limit.                                                                                         |
| Marketplace | `apps/marketplace-api/migrations` | Creator profiles, hotel profiles/listings, collaboration offers, collaborations, deliverables, chat, trips, notifications, invite/newsletter data.                                                    |
| Booking     | `apps/booking-api/migrations`     | Public booking hotel profile/config, translations, add-ons, promo codes, public events, pricing configuration, platform status, Lodgify remnants.                                                     |
| PMS         | `apps/pms-api/migrations`         | Operational hotels, room types, rooms, bookings, room blocks, payments, payouts, affiliates, channel manager mappings, guest messaging, check-in/check-out, booking notes/events, module activations. |

Important current tables include:

| Area        | Tables found in migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | `users`, `password_reset_tokens`, `email_verification_codes`, `email_verification_tokens`, `email_change_tokens`, `cookie_consent`, `consent_history`, `gdpr_requests`, `totp_secrets`, `totp_recovery_codes`, `login_audit_log`, `login_rate_limit`.                                                                                                                                                                                                                                                                                                                |
| Marketplace | `creators`, `creator_platforms`, `creator_ratings`, `hotel_profiles`, `hotel_listings`, `listing_collaboration_offerings`, `listing_creator_requirements`, `collaborations`, `collaboration_deliverables`, `chat_messages`, `trips`, `external_collaborations`, `notifications`, `invite_codes`, `newsletter_preferences`.                                                                                                                                                                                                                                           |
| Booking     | `booking_hotels`, `booking_hotel_translations`, `booking_addons`, `booking_promo_codes`, `booking_events`, `commission_rate_changes`, `lodgify_connections`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| PMS         | `hotels`, `room_types`, `rooms`, `bookings`, `booking_rooms`, `booking_drafts`, `room_blocks`, `payments`, `payouts`, `hotel_payment_settings`, `cancellation_policies`, `affiliates`, `affiliate_clicks`, `affiliate_payout_settings`, `channex_connections`, `channex_room_type_mappings`, `channex_rate_plan_mappings`, `channex_booking_mappings`, `channex_channel_markups`, `message_threads`, `messages`, `booking_events`, `booking_notes`, `booking_change_requests`, `booking_checkin_records`, `booking_checkout_records`, `property_module_activations`. |

The main database problems are structural:

- Auth still centers on `users.type` and `users.is_superadmin`, while VAY-600
  needs WorkOS provider identity plus Vayada-owned organizations, memberships,
  resource links, permissions, entitlements, and audit.
- Product ownership is stored as direct `user_id` columns on resources such as
  `booking_hotels`, PMS `hotels`, marketplace `hotel_profiles`, marketplace
  `creators`, and PMS `affiliates`. This does not model multi-member hotel
  organizations, creator workspaces, affiliates, or platform staff cleanly.
- Product services directly open other product databases. Examples include PMS
  reading booking-engine hotel identity/payment data, booking-api reading PMS
  booking metrics, and marketplace-api reading PMS affiliate data.
- Public bookability data is split across booking profile/config tables, PMS
  room/rate/availability/booking tables, and booking-web URL behavior. There is
  no stable external quote/read model.
- The retired Ask Intelligence schema is not part of the current target state;
  VAY-1091 owns any future hotel employee agent design.
- Operational facts, public distribution facts, finance facts, and owner-facing
  setup facts often live in the same tables or same service contracts.

## Target domain ownership

Each target domain should own writes to its authoritative tables. Other domains
should consume typed services, read models, or events.

| Domain                          | Owns                                                                                                                                                        | Big-bang target posture                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity and authorization      | Internal users, WorkOS identity mappings, organizations, memberships, permissions, resource links, product entitlements, product audit events.              | Model in the new target schema first. Keep `users.id` stable as migrated internal principal IDs; map WorkOS IDs through `external_identities`.               |
| Hotel/property catalog          | Canonical internal property identity, organization links to booking/PMS/marketplace resources, normalized public/private profile attributes.                | Create canonical property tables and migrated links from legacy `booking_hotels`, PMS `hotels`, and marketplace `hotel_profiles`/`hotel_listings`.           |
| Booking and direct checkout     | Quote sessions, checkout context, booking lifecycle contract, guest booking records, booking status, cancellation/change flows.                             | Move guest booking records and quote/checkout state into the target booking domain at cutover. Preserve public booking references and lifecycle semantics.   |
| PMS operations                  | Rooms, room types, inventory, room blocks, operational booking assignment, check-in/out, notes, housekeeping-style facts, channel manager sync state.       | Migrate operational PMS tables into the target PMS domain with cleaner ownership and explicit external-channel mappings.                                     |
| Marketplace                     | Creators, creator platforms, hotel listings for collaborations, collaboration offers, deliverables, ratings, negotiation/chat.                              | Migrate creator, listing, collaboration, deliverable, and chat records into marketplace-owned target tables linked through organizations/resources.          |
| Finance                         | Payment settings, payments, payouts, commissions, affiliate payout settings, billing/pricing configuration, audit of rate/commission changes.               | Define finance-owned target tables before cutover; migrate payments/payouts/commissions without changing external provider identifiers.                      |
| Distribution and AI bookability | Public hotel bookability profile, quote read model, freshness metadata, typed unavailable reasons, deep-link context, external API clients and rate limits. | Build as first-class target tables/read models, not as later patches on old booking/PMS shapes. Public and read-only for external agents.                    |
| Jobs/events/audit               | Durable side-effect jobs, idempotency keys, retries, dead-letter visibility, product audit correlation.                                                     | Include job/event/audit tables in the target schema so cutover does not carry forward untracked fire-and-forget side effects as the default operating model. |

## Identity and authorization tables

These are the first target-schema tables because every later domain depends on a
stable request and resource model. They should be created in the new database
schema and loaded by migration scripts during rehearsals and final cutover.

Recommended tables:

| Table                             | Purpose                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_identities`             | Maps WorkOS users and other future providers to `users.id`. Stores provider user ID, provider email cache, verification state, raw profile metadata, first/last seen timestamps.      |
| `organizations`                   | Internal tenant/business container. Kinds should include `platform`, `hotel_group`, `creator_workspace`, and `affiliate_partner`. Stores WorkOS organization mapping when applicable. |
| `organization_memberships`        | Internal membership for `user_id` and `organization_id`, linked to WorkOS membership when applicable. Stores status, role slug, timestamps, and invite/deprovision state.             |
| `permission_catalog`              | Stable product permission keys such as `pms.booking.update`, `booking.settings.manage`, `marketplace.collaboration.review`, and `platform.user.suspend`.                              |
| `role_permission_grants`          | Maps internal role slugs to permission keys, scoped by organization kind and product.                                                                                                 |
| `membership_permission_overrides` | Optional explicit grants/denies for edge cases. This can wait until role grants are insufficient.                                                                                     |
| `organization_resource_links`     | Links an organization to product resources such as `booking_hotel`, `pms_hotel`, `hotel_profile`, `hotel_listing`, `creator_profile`, `affiliate`, and payout/billing accounts.       |
| `product_entitlements`            | Product/module access and limits for the organization or linked resource. Supports plan, enabled modules, active/suspended state, and expiry.                                         |
| `product_audit_events`            | Application audit trail for actor, organization, target resource, action, before/after metadata, request metadata, and WorkOS event correlation.                                      |

Rules:

- Preserve `users.id` as the internal principal ID.
- Add `external_identities` instead of replacing product table foreign keys with
  WorkOS IDs.
- Do not carry `users.type`, `users.is_superadmin`, or product `user_id` owner
  fields forward as authorization primitives. They are migration inputs only.
- Resolve every authenticated request to:

```text
provider identity
-> internal user
-> selected organization
-> active membership
-> permissions
-> linked product resource
-> entitlement and product state
```

## Distribution and AI bookability tables

VAY-604 defines public bookability as a distribution concern. The bookability
layer should serve external agents/search systems without exposing private
tenant data.

Recommended structures:

| Table or read model                 | Purpose                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_hotel_bookability_profiles` | Versioned public snapshot for hotel identity, canonical URLs, custom-domain URL, location, images, amenities, policies, payment capabilities, supported quote parameters, completeness, and generated/freshness metadata. |
| `public_room_offer_snapshots`       | Optional denormalized room/rate snapshot for public quote generation. Use only for fields that are safe to expose publicly.                                                                                               |
| `quote_sessions`                    | Deterministic quote identity/hash, request parameters, selected offers, totals, policy text/version, expiry, freshness, booking URL, promo/referral context, and typed unavailable reasons.                               |
| `booking_deep_link_contexts`        | Short-lived state that lets booking-web open the same dates, guests, room/rate, locale, currency, promo, and referral context returned by the quote API.                                                                  |
| `external_api_clients`              | Client identity, allowed surfaces, status, terms version, contact, rate-limit tier, and revocation state for partner/tool clients.                                                                                        |
| `external_api_usage_events`         | Request audit and abuse/rate-limit signals for public AI/partner API access.                                                                                                                                              |

Rules:

- The public profile and quote contracts should not expose guest PII,
  unpublished room/rate data, private owner settings, payout data, or internal
  operational notes.
- The quote API should return a quote identity/hash and expiry even before
  external agents can create bookings directly.
- MCP/tool integrations should call the same bookability profile and quote
  contracts; they should not become a separate source of truth.
- Booking creation by external tools should remain quote/preview plus checkout
  redirect until explicit guest confirmation, payment/fraud controls,
  idempotency, and audit are implemented.

## Retired Ask Intelligence schema

The earlier VAY-601 tables and rules are retired. Migration `0090` removes the
complete `intelligence` schema, its persisted data, and Ask-only permissions.
Do not add those structures back through this database-rewrite plan. VAY-1091
must define new ownership, authorization, retention, and storage before any
future hotel employee agent implementation begins.

## Carry forward, redesign, retire, transform

### Carry forward

- `users.id` as the stable internal principal.
- Existing product resource IDs for `booking_hotels`, PMS `hotels`,
  marketplace `hotel_profiles`/`hotel_listings`, `creators`, `affiliates`,
  bookings, payments, payouts, rooms, room types, and channel mappings.
- Current guest checkout and booking lifecycle semantics.
- Public booking URLs through redirects or compatibility adapters.
- Channex, Stripe, Xendit, Lodgify cleanup state, email, affiliate, and
  marketplace integration behavior until each integration is explicitly moved.
- Consent history and GDPR request linkage.

### Redesign in the target schema

- `users.type` as product authorization.
- `users.is_superadmin` as platform authorization.
- Direct resource ownership through product `user_id` columns.
- `X-Hotel-Id` as hidden global state. It can remain as an HTTP compatibility
  input, but domain logic should receive an explicit resolved resource context.
- Cross-product reads through `AuthDatabase`, `PmsDatabase`,
  `MarketplaceDatabase`, and `BookingEngineDatabase` as normal integration.
- Booking Engine routes or services that treat PMS tables, Channex tables, or
  `PMS_DATABASE_URL` as their normal reservation source.
- PMS routes or services that own direct-booking checkout, quote/session, promo,
  or guest-facing confirmation contracts.
- Booking quote, checkout context, payment eligibility, and deep-link state as
  one explicit domain contract.
- Hotel setup completeness and agent-readiness as reusable read models.
- Metrics as curated definitions/views instead of ad hoc prompt/database logic.
- Side effects as durable jobs/events with audit, retries, idempotency, and
  dead-letter visibility.

### Do not carry forward as active systems

- Local password login and bcrypt session issuance for migrated users.
- `password_reset_tokens` as a Vayada-owned auth flow after WorkOS is the
  session authority.
- Local account email verification code/token flows after WorkOS owns account
  identity verification for migrated users.
- Local `totp_secrets` and `totp_recovery_codes` after WorkOS MFA is enforced.
- Local login rate limiting that protects only retired password endpoints.
- Legacy marketplace `users` tables that have already been removed from product
  ownership, except for any migration artifacts needed for audit.
- `lodgify_connections` once the dropped Lodgify integration is confirmed to
  have no production dependency.

### Transform during migration

- `external_identities` from existing `users` once WorkOS users are created or
  linked.
- `organizations` from current hotel/admin/creator/affiliate ownership:
  platform organization for Vayada staff, hotel-group organizations for hotel
  businesses, creator-workspace organizations for creators, and
  affiliate-partner organizations for affiliates.
- `organization_memberships` from existing `users.type`, `is_superadmin`, and
  owner/admin associations.
- `organization_resource_links` from `booking_hotels.user_id`, PMS
  `hotels.user_id`, marketplace `hotel_profiles.user_id`, marketplace
  `creators.user_id`, PMS `affiliates.user_id`, and any explicit setup handoff
  mappings.
- `product_entitlements` from booking pricing configuration, platform status,
  PMS `property_module_activations`, billing plans, enabled modules, and
  payment/setup state.
- Public bookability snapshots from `booking_hotels`, booking translations,
  booking add-ons/policies/payment config, PMS room types, PMS availability,
  PMS payment settings, and booking-web canonical URL rules.

## Migration sequence

### Phase 0: Inventory and contracts

- Produce a full table/column inventory with owners, current writers, current
  readers, PII classification, retention sensitivity, external provider IDs,
  and migration risk.
- Confirm the target domain ownership map and the new schema boundaries.
- Define RequestContext, resource-link, bookability quote, jobs/events, audit,
  and finance contracts before writing migration scripts that depend on them.

### Phase 1: Target schema design

- Design the full target schema as DDL in a new database/schema namespace.
- Include identity/resource links, canonical property tables, booking/PMS
  operational tables, marketplace tables, finance tables, bookability tables,
  and jobs/audit tables.
- Define stable IDs, foreign keys, uniqueness, status enums, nullable
  migration fields, PII classifications, indexes, retention rules, and audit
  requirements.
- Review the schema as one design before implementation tickets start building
  cutover code.

### Phase 2: Migration pipeline

- Build deterministic extract/transform/load scripts from auth-db,
  marketplace, booking, and PMS into the target schema.
- Keep current production databases as source of truth while the target schema
  is repeatedly rebuilt in local and staging.
- Make the migration idempotent in rehearsal environments: drop/recreate target
  schema, load source snapshots, validate, and report mismatches.
- Do not dual-write by default. If the final cutover requires a short bridge for
  unavoidable writes, scope it as a separate explicit risk item.

### Phase 3: Application cutover branch

- Update the TypeScript backend roadmap and any required Python compatibility
  code to read/write the target schema.
- Replace legacy authorization paths with RequestContext over organizations,
  memberships, permissions, resource links, and entitlements.
- Keep public URLs and frontend contracts compatible through route adapters and
  redirects, not by preserving old table ownership.
- Replace normal cross-product database pools with target domain services and
  read models.

### Phase 4: Rehearsals and parity checks

- Run full migration rehearsals on production-like snapshots in staging.
- Compare source and target row counts, totals, status distributions, public
  booking quote outputs, authorization decisions, payment/payout totals,
  and marketplace collaboration states.
- Run application smoke tests against the target schema only.
- Record every mismatch with an owner and block cutover until critical
  mismatches are resolved or explicitly accepted.

### Phase 5: Production cutover

- Announce a maintenance window if a write freeze is required.
- Freeze or queue writes in current apps.
- Take final backups/snapshots of all source databases.
- Run the final migration from source databases into the target schema.
- Run cutover validation gates.
- Deploy app versions configured for the target schema.
- Re-enable writes and monitor error rates, booking creation, payments,
  external integrations, auth/session resolution, and public booking pages.

### Phase 6: Stabilization

- Keep source databases read-only and retained for rollback/audit during the
  agreed retention window.
- Monitor parity-sensitive flows: login/session resolution, hotel selection,
  booking creation, payment capture/refund, Channex sync, affiliate attribution,
  marketplace collaboration changes, and AI quote output.
- Fix target-schema data issues with forward migrations or targeted data repair
  scripts, not by reviving legacy writes.

### Phase 7: Legacy decommission

- Remove local password/TOTP/email-verification dependency for migrated users.
- Remove `users.type`, `is_superadmin`, direct product `user_id` ownership
  checks, hidden `X-Hotel-Id` authorization state, and normal cross-product DB
  pools from active code.
- Archive old migration histories and source snapshots according to retention
  and audit requirements.

## Coexistence, cutover, and rollback

Before cutover:

- Existing Python services and current databases remain production source of
  truth.
- Target schema exists in local/staging and can be rebuilt from source
  snapshots.
- New application code can be developed against target-schema fixtures or
  staging target databases, but it should not partially own production writes
  before the cutover.
- Compatibility adapters preserve HTTP/public behavior; they should not
  preserve old database ownership as a permanent design constraint.

During cutover:

- Prefer a write freeze or queueing window over long-lived dual-write. Dual
  write should be used only if the downtime requirement makes a freeze
  impossible, and it must have reconciliation checks.
- Final migration scripts must log source rows, target rows, counts, transform
  warnings, skipped rows, and checksum/parity results.
- App deployment and database cutover must be one coordinated release with a
  named owner for each validation gate.

Rollback posture:

- Rollback before writes resume: restore old app versions and keep using the
  original databases.
- Rollback after writes resume is harder because target-only writes may have
  occurred. The runbook must define the maximum rollback window, whether target
  writes can be replayed into old databases, and which external side effects
  prevent rollback.
- Source database snapshots must be retained read-only until the rollback
  window is closed.
- No destructive cleanup of old production databases happens in the same
  release as cutover.

## Validation requirements

For every big-bang rewrite implementation ticket:

- Run target-schema DDL locally and in staging.
- Add migration tests or fixture checks for expected rows, constraints, and
  transformed values.
- Compare source and target row counts, uniqueness, checksums where practical,
  and domain-specific totals.
- Validate PII classification and public/private exposure for every target
  table and public read model.
- Add contract tests for RequestContext resource resolution, quote output,
  payment/payout reconciliation, marketplace state, or evidence output
  depending on the domain.
- Include staging rehearsal instructions, cutover gates, and rollback notes.
- For production auth DB changes, remember that auth migrations do not
  auto-run in production today. The big-bang cutover needs an explicit reviewed
  production operation rather than relying on app startup migrations.

Suggested validation checks by domain:

| Domain         | Required validation                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity/auth  | WorkOS ID uniqueness, internal user mapping, active membership, permission resolution, source/target ownership parity.                                                   |
| Resource links | One organization can link to many resources, one resource can reject ambiguous ownership unless explicitly allowed, deleted/suspended resources do not authorize access. |
| Bookability    | Quote parity with existing booking flow, no private fields, correct cache/freshness metadata, typed unavailable reasons, deep-link round trip.                           |
| Finance        | Payment/payout visibility gated by finance permissions, totals reconcile with existing payment/payout rows, commission changes are audited.                              |
| Jobs/events    | Idempotency keys, retry behavior, dead-letter visibility, audit correlation, no duplicate customer-facing side effects.                                                  |

## First schema implementation tickets

These are the first small, testable tickets VAY-603 should schedule after this
plan is accepted. They prepare a big-bang cutover without making partial
production table ownership changes.

1. **Inventory current database ownership and PII**
   - Scope: generate a table/column inventory for auth, marketplace, booking,
     and PMS with current writers, readers, product owner, PII category,
     retention sensitivity, and migration risk.
   - Validation: inventory includes every table from the migration histories,
     marks unknown ownership explicitly, and links to source migration files.

2. **Design the target database schema**
   - Scope: create the full target schema ERD/DDL for identity, hotel catalog,
     booking, PMS operations, marketplace, finance, distribution/bookability,
     and jobs/audit.
   - Validation: schema review covers ownership, FKs, indexes, status enums,
     PII classification, retention, and source-table mappings.

3. **Build the legacy-to-target migration pipeline**
   - Scope: create idempotent local/staging ETL scripts from auth-db,
     marketplace, booking, and PMS into the target schema.
   - Validation: dry-run rebuild of the target schema from seed data with
     source/target counts, mismatch report, and rerunnable output.

4. **Define WorkOS identity and organization transforms**
   - Scope: map existing `users`, `users.type`, `is_superadmin`,
     `booking_hotels.user_id`, PMS `hotels.user_id`, marketplace
     `hotel_profiles.user_id`, marketplace `creators.user_id`, and PMS
     `affiliates.user_id` into target `external_identities`, `organizations`,
     memberships, permissions, resource links, and entitlements.
   - Validation: fixture tests for platform staff, one hotel owner with
     multiple hotels, creator workspace, affiliate partner, and ambiguous
     ownership.

5. **Define RequestContext target contract**
   - Scope: define the query contract that resolves provider identity,
     internal user, selected organization, permissions, linked resource, and
     entitlement. Include compatibility inputs for current JWT and
     `X-Hotel-Id`.
   - Validation: unit tests for allowed/denied hotel, creator, affiliate, and
     platform scopes.

6. **Define public bookability profile and quote schema**
   - Scope: specify target tables/read models for public profile, quote
     sessions, freshness, unavailable reasons, and booking deep-link context.
   - Validation: contract fixtures for bookable, sold-out, payment-disabled,
     min-stay, max-stay, same-day cutoff, promo/referral, and stale data cases.

7. **Design the future hotel employee agent in VAY-1091**
   - Scope: start from current hotel employee workflows and authorization needs;
     do not reuse the retired Ask runtime, contracts, fixtures, or schema.
   - Validation: reviewed design and explicit ownership/storage decisions before
     any implementation ticket.

8. **Create big-bang cutover validation harness**
   - Scope: add shared scripts/tests for staging rehearsals, row-count checks,
     uniqueness checks, ownership parity, quote parity, payment/payout totals,
     public URL checks, and rollback readiness.
   - Validation: harness rebuilds the target schema from local data, prints
     actionable mismatch reports, and fails on ambiguous ownership or critical
     parity gaps.

9. **Write production cutover and rollback runbook**
   - Scope: define maintenance window, write freeze or queueing, backup
     snapshots, migration command sequence, validation gates, deploy order,
     owner assignments, rollback window, and legacy DB retention.
   - Validation: tabletop rehearsal with explicit go/no-go gates and rollback
     decision points.

## Open decisions for VAY-603

VAY-603 should decide these in the integrated roadmap:

- Whether the big-bang target is one physical database with schemas per domain
  or several physical databases cut over in the same release.
- Whether all current Python services are replaced at cutover or whether a
  small compatibility layer remains temporarily against the target schema.
- Whether the production cutover can use a write freeze or needs a short
  queue/dual-write bridge.
- Whether bookability profile/quote read models are implemented as tables,
  materialized views, or generated responses with cache metadata in the target
  schema.
- Which side effects must be converted to jobs/events before cutover and which
  can remain synchronous temporarily.

## Acceptance signal

This plan is ready to feed VAY-603 when:

- the team agrees that the database rewrite is a planned big-bang cutover, with
  discovery, target-schema design, migration scripts, and rehearsals performed
  incrementally before production;
- `users.id` remains the internal principal while WorkOS IDs live in mapping
  tables;
- organization/resource links become the replacement for `users.type`,
  `is_superadmin`, direct product `user_id` checks, and hidden `X-Hotel-Id`
  authorization state;
- public AI bookability remains a distribution domain, while any future hotel
  employee agent is separately designed through VAY-1091;
- the first implementation tickets above are sequenced into the roadmap.
