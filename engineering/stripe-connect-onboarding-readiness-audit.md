# Stripe Connect onboarding readiness audit

_VAY-1075 audit record. Reviewed against VAY-815, VAY-1064, VAY-1301, and
VAY-947 on 2026-08-28._

## Result

Stripe Connect onboarding is **not ready for production cutover**.

The target backend already has property-scoped account creation, onboarding-link
issuance, signed webhook receipts, canonical account.updated reconciliation, and
provider-account projection. Seven release gaps remain:

1. Booking Admin returns to the default Settings section and does not persist
   Stripe before starting onboarding.
2. Marketplace returns without the exact property or Payments step.
3. There is no authenticated post-return repair command for delayed or missed
   webhooks.
4. Booking Admin and Marketplace do not perform bounded automatic refresh after
   return or original-tab focus.
5. Provider-account readiness is not connected to VAY-1064 method-level
   readiness; online card deliberately remains unready without ONB-25A execution
   evidence.
6. Stripe webhook receipts retain the redacted remaining event without an
   approved minimization and retention policy.
7. Production connected-account delivery, endpoint-secret alignment, and
   single-writer rollback are operational state that the repository cannot
   prove.

VAY-1342 through VAY-1348 own the application and retained-data gaps. VAY-947
owns the operational cutover gap and is explicitly blocked by all seven
implementation tickets. No production route, provider dashboard, secret,
scheduler, or mutation owner was changed by this audit.

## End-to-end trace

### 1. Customer surfaces and provider selection

Booking Admin owns its target UI in
apps/booking-admin/app/(app)/settings/page.tsx.

- The Payments section resolves the canonical property through
  getBookingHotelPropertyLink.
- getFinancePaymentSettings reads the selected provider and stored account.
- savePaymentProviderSettings maps the form through
  buildFinancePaymentSettingsBody and calls the property payment-settings PATCH
  route.
- The target repository writes the provider choice and placeholder account in
  one database transaction.

Gap: handleCreateStripeAccount calls the Stripe account command without first
requiring the settings write. A user can select Stripe, start onboarding, and
reload back to the previously persisted provider.

Owner: VAY-1342.

Marketplace also starts property Stripe onboarding from
apps/marketplace-web/components/setup/operations/PaymentSetupForm.tsx. Unlike
Booking Admin, it saves payment settings before requesting an account or link
and stops when that write fails. Its provider-selection order is sound.

### 2. Account creation, replay, and authorization

POST /api/finance/properties/:propertyId/provider-accounts/stripe is mounted in
apps/api/src/routes/finance.ts.

- Fastify parses the request, then enforceFinancePropertyWritePolicy runs before
  Finance command parsing or provider calls.
- The policy permits either:
  - pms.operations.manage with the property-management entitlement; or
  - booking.settings.manage with the direct-booking-finance entitlement.
- Both alternatives require an exact pms_property or property resource link and
  an owner or finance_manager relationship.
- The browser supplies command and idempotency IDs, email, country, and an
  allowlisted return surface. It does not choose the Stripe account reference.
- createStripeProviderAccountInClient reuses the property account or creates one
  through FinanceStripeConnectProvider.
- New accounts use owner-scoped Stripe idempotency keys and metadata.
- A provider-success/database-write failure invokes the account-creation
  compensation path.
- The stored account relinks only to the matching Finance Stripe placeholder.

The alternative PMS and Booking authorization paths are intentional: both
surfaces can manage Finance setup for the same exact property, while entitlement
and owner relationship checks remain fail-closed.

The command is property-scoped and replay-safe, but it cannot repair Booking
Admin's missing provider-selection write because relinking requires an existing
Stripe placeholder.

### 3. Onboarding-link issuance and return

The property onboarding-link POST route uses the same property write policy. It
loads the account from the authorized owner scope before accepting either the
internal account ID or provider reference.

apps/api/src/domains/stripeConnect.ts currently generates:

    Booking Admin:
    /settings?stripe=return
    /settings?stripe=refresh

    Marketplace:
    /setup?stripe=return
    /setup?stripe=refresh

Booking Admin's readSettingsSection defaults those URLs to Property. The safe
destinations are:

    /settings?section=payments&stripe=return
    /settings?section=payments&stripe=refresh

Owner: VAY-1342.

Marketplace adaptive setup requires an exact propertyId and step=payments.
Without propertyId the page shows “Choose a hotel to continue”; without the step
it does not reliably resume Payments. The safe server-generated destinations
are:

    /setup?propertyId=<authorized property UUID>&step=payments&stripe=return
    /setup?propertyId=<authorized property UUID>&step=payments&stripe=refresh

The server must derive that UUID from the property-scoped command and continue
to allowlist the configured Marketplace origin; it must not accept an arbitrary
return URL. The returned propertyId remains untrusted browser routing context:
Marketplace and every Finance read or reconcile call must reauthorize the exact
property. Changing the query to a foreign property must fail safely without
state disclosure or a provider call.

Owner: VAY-1346.

### 4. Stripe callback intake and retained evidence

POST /webhooks/stripe in apps/api/src/routes/providerWebhooks.ts:

- reads the exact raw request body;
- requires stripe-signature;
- verifies HMAC and timestamp tolerance with STRIPE_WEBHOOK_SECRET;
- parses only after successful signature verification;
- recursively drops fields named client_secret, secret, access_token, or
  refresh_token;
- redacts the signature header;
- persists the remaining headers and event with a payload hash and deduplicated
  receipt;
- promotes effects only when Stripe intake mode is mutating.

For account.updated, the normalizer records the connected account ID and queues
finance.reconcile-provider-account evidence. Whether the production endpoint is
configured for connected-account events with the matching secret is Stripe
Dashboard state, not repository evidence.

The receipt boundary is not yet approved for production. The remaining event is
stored in platform.external_webhook_events.raw_payload with privacy_scope
restricted and ai_visible false. The row defaults to external tenant scope and
is append-only. The denylist has four names, the focused test covers
client_secret, unknown fields are retained, and no deletion or retention policy
exists. Restricted and AI-invisible storage reduces exposure but does not
justify retaining an open-ended provider event.

VAY-1348 owns an allowlisted/minimized receipt shape or a security-approved
retention alternative, including access, purge, replay, and adversarial fixture
tests. Real secrets and production payloads must never be copied into Linear,
GitHub, chat, logs, or fixtures.

VAY-947 owns the production endpoint, connected-account selection, matching
secret, signed observe/smoke evidence, and single-writer switch.

### 5. Canonical provider-account reconciliation

reconcileStripeProviderAccount in apps/api/src/platform/providerWebhooks.ts
retrieves the current Stripe account when the provider adapter is configured. It
does not treat an older webhook's readiness booleans as canonical.

One transaction updates:

- account and onboarding status;
- charges_enabled and payouts_enabled;
- submitted details;
- default currency;
- card-payments capability metadata;
- the dependent coarse public bookability projection.

Provider-account readiness becomes active only when charges, payouts, details,
and card capability are ready. The same update demotes the account when a
requirement is lost. Existing tests cover readiness gain and an older incomplete
event arriving after canonical Stripe is active. They do not cover explicit
canonical readiness loss.

There is also no authenticated property-scoped command that invokes this repair
after a missed webhook. VAY-1343 owns that idempotent command, authorization and
denial coverage, readiness gain/loss tests, and secret-safe response.

### 6. Provider readiness is not payment-method readiness

VAY-1064 intentionally keeps the card method unready. The method snapshot in
packages/domain-finance/src/paymentReadinessSnapshot.ts does not consume Stripe
provider-account state and always adds online_card_execution_unavailable.

This is a required safety gate, not evidence that online card works. An active
Stripe account proves onboarding/capability state only. It does not prove
PaymentIntent execution, quote and booking linkage, retries, duplicate-charge
protection, or failure recovery.

The current provider reconciliation also updates a coarser public bookability
projection. Until both models share one release decision, that coarse projection
must not authorize online-card publication.

VAY-1345 owns the bridge:

- consume canonical property provider/capability state;
- require accepted ONB-25A execution evidence in addition to account readiness;
- keep online card dark when either input is absent or stale;
- demote only dependent card methods/rates on capability or evidence loss;
- make setup, launch readiness, and public bookability agree.

Pay at hotel readiness is independent and outside this Stripe audit; any
production cutover requires separate acceptance. This audit establishes only
that online card cannot be enabled merely because onboarding looks connected.

### 7. Post-return frontend state

Booking Admin loads Finance settings on mount. It does not reconcile on
stripe=return, poll for a bounded propagation window, or refresh when the
original tab regains focus.

Owners: VAY-1343 provides the protected backend repair command; VAY-1344 owns
Booking Admin return/focus refresh.

Marketplace has a manual “Check Stripe status” action that only rereads Finance.
It does not call canonical provider reconciliation and does not automatically
react to return parameters or original-tab focus. A missed webhook can therefore
leave the account pending even after a manual reread.

Owners: VAY-1346 preserves property/step return context; VAY-1343 provides the
repair command; VAY-1347 owns Marketplace return/focus refresh.

Neither frontend may infer success from a return parameter. Both must render
only canonical Finance state and use bounded retry.

## Authorization, secret, and data review

| Boundary                   | Finding                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account create/link routes | Property Finance write policy runs after Fastify body parsing but before Finance command parsing and provider calls.                                      |
| Accepted permissions       | Either pms.operations.manage plus property-management or booking.settings.manage plus direct-booking-finance.                                             |
| Tenant scope               | Both policy alternatives require the exact property resource and owner/finance_manager relationship; account lookup remains owner-scoped.                 |
| Provider API secret        | Server configuration only; used by the server-side Stripe adapter.                                                                                        |
| Webhook secret             | Raw-body signature verification only; stripe-signature is redacted before receipt persistence.                                                            |
| Provider records           | Store account reference and readiness metadata, not Stripe API or signing secrets.                                                                        |
| Webhook receipts           | Remaining recursively redacted event is restricted, AI-invisible, append-only, open-ended, and has no approved retention policy. VAY-1348 blocks cutover. |
| Browser response           | Contains the onboarding URL and required account identifiers, not a secret key or raw provider event.                                                     |
| Operational proof          | Production connected-account selection, exact endpoint, matching secret, signed delivery, and rollback remain VAY-947 evidence.                           |

## Gap ownership and dependency order

1. **VAY-1342 — Fix Stripe onboarding return and provider persistence**
   - Fix Booking Admin destinations.
   - Persist Stripe before account creation.
2. **VAY-1346 — Fix Marketplace Stripe onboarding return context**
   - Preserve the authorized property and Payments step.
3. **VAY-1343 — Add Stripe Connect post-return reconciliation**
   - Add the authenticated property-scoped canonical repair command.
   - Cover readiness gain, loss, authorization, idempotency, and safe errors.
4. **VAY-1344 — Refresh Stripe status after onboarding**
   - Add bounded Booking Admin return/focus reconcile and refresh.
5. **VAY-1347 — Refresh Marketplace Stripe status after onboarding**
   - Add bounded Marketplace return/focus reconcile and refresh.
6. **VAY-1345 — Gate online-card readiness on Stripe account and execution evidence**
   - Join provider state with accepted ONB-25A evidence.
   - Keep online card dark until the complete gate passes.
7. **VAY-1348 — Harden retained Stripe webhook receipt payloads**
   - Minimize retained data and define approved retention/access/replay.
8. **VAY-947 — Cut over Stripe and Channex callbacks**
   - Prove connected-account delivery and the matching secret.
   - Rehearse signed delivery and rollback before changing ownership.

VAY-1344 is blocked by VAY-1343. VAY-1347 is blocked by VAY-1343 and VAY-1346.
VAY-1345 is blocked by VAY-1343. VAY-947 is blocked in Linear by VAY-1342
through VAY-1348; a related-link convention is not the release gate.

## Rollout and rollback

The implementation tickets land dark on the target stack while legacy remains
the production owner.

Rollout order:

1. deploy VAY-1342 and VAY-1346; test both exact return destinations and
   provider persistence;
2. deploy VAY-1343; exercise gain, loss, replay, denial, and missed-webhook
   repair against a sanctioned test connected account;
3. deploy VAY-1344 and VAY-1347; browser-smoke return, focus, bounded retry, and
   failure on both surfaces;
4. accept VAY-1345's method-level gate; keep online card disabled until the
   sanctioned ONB-25A execution evidence passes;
5. accept VAY-1348's minimized receipt and retention boundary;
6. execute VAY-947's signed observe-only rehearsal and separately approve the
   production callback switch.

Before callback cutover, application rollback leaves legacy as the only writer.
During VAY-947, never run legacy and target mutatively for the same Stripe event
stream. Rollback must first make target intake non-mutating, stop manual repair,
pause and drain target promotion workers, record the cutoff, and verify that no
target mutation remains in flight. Only then may callback ownership return to
legacy. Target promotion or retry stays prohibited while legacy owns the stream;
receipt/provider comparison is read-only until a separately approved switch.

## Acceptance mapping

| VAY-1075 acceptance criterion                             | Evidence / disposition                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Written end-to-end trace                                  | This document sections 1–7.                                                                    |
| Correct return/refresh destination                        | Booking Admin gap: VAY-1342. Marketplace exact property/step gap: VAY-1346.                    |
| Provider selection survives redirect/reload               | Booking Admin gap: VAY-1342. Marketplace already persists settings before onboarding.          |
| Active account cannot remain pending after missed webhook | Backend repair: VAY-1343. Frontend consumers: VAY-1344 and VAY-1347.                           |
| account.updated readiness gain and loss                   | Canonical provider update supports both; VAY-1343 adds explicit loss and repair-command tests. |
| Method-level payment readiness                            | VAY-1064 remains fail-closed; VAY-1345 owns the provider plus execution evidence gate.         |
| Secret and property authorization                         | Exact alternative policies documented above; production secret alignment remains VAY-947.      |
| Webhook receipt data boundary                             | Existing restricted storage is insufficiently minimized; VAY-1348 blocks cutover.              |
| Discovered gaps have linked implementation ownership      | VAY-1342 through VAY-1348; VAY-947 is blocked by all seven.                                    |
| Findings recorded before close                            | Repository record here; summary and PR evidence will be linked on VAY-1075.                    |

VAY-1075 stays **In Progress** until this audit PR is reviewed. Merging this
record does not accept its implementation children, enable online card, or
authorize any production cutover.
