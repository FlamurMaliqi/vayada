# Stripe Connect onboarding readiness audit

_VAY-1075 audit record. Initially reviewed against VAY-815, VAY-1064,
VAY-1301, and VAY-947 on 2026-08-28. Reconciled with `main` after all seven
repository implementation children merged on 2026-08-31._

## Result

Stripe Connect onboarding is **not ready for production cutover**. All seven
repository implementation children are merged, but the operational evidence
and approval owned by VAY-947 remain outstanding.

The initial audit found that the target backend already had property-scoped
account creation, onboarding-link issuance, signed webhook receipts, canonical
account.updated reconciliation, and provider-account projection. It identified
seven release gaps:

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

VAY-1342 through VAY-1348 owned the application and retained-data gaps. They are
now merged as PRs #1208, #1210, #1211, #1214, #1300, #1306, and #1313. VAY-947
still owns the operational cutover gap. No production route, provider dashboard,
secret, scheduler, or mutation owner was changed by this audit or by reconciling
this record.

| Issue    | Merged PR | Repository closure                                                       |
| -------- | --------- | ------------------------------------------------------------------------ |
| VAY-1342 | #1208     | Booking Admin return destinations and provider persistence               |
| VAY-1343 | #1210     | Property-scoped canonical post-return reconciliation                     |
| VAY-1344 | #1211     | Bounded Booking Admin return/focus reconciliation and refresh            |
| VAY-1345 | #1214     | Online-card readiness gate requiring provider and execution evidence     |
| VAY-1346 | #1300     | Authorized Marketplace property and Payments-step return context         |
| VAY-1347 | #1306     | Bounded Marketplace return/focus reconciliation and refresh              |
| VAY-1348 | #1313     | Minimized Stripe receipts, 30-day retention, purge, and legacy scrubbing |

The Stripe repository dependencies are therefore complete for VAY-947's
separately authorized staging and production evidence work. This audit does not
assess VAY-947's Channex readiness, prove that production callback ownership has
changed, or authorize online-card payments.

## Initial end-to-end trace

The following sections preserve the 2026-08-28 findings that created the seven
implementation tickets. The closure table above and acceptance mapping below
record their current disposition.

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

Initial gap: handleCreateStripeAccount called the Stripe account command without
first requiring the settings write. A user could select Stripe, start
onboarding, and reload back to the previously persisted provider.

Closed by VAY-1342/#1208.

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

At initial review, apps/api/src/domains/stripeConnect.ts generated:

    Booking Admin:
    /settings?stripe=return
    /settings?stripe=refresh

    Marketplace:
    /setup?stripe=return
    /setup?stripe=refresh

Booking Admin's readSettingsSection defaulted those URLs to Property. The
required destinations were:

    /settings?section=payments&stripe=return
    /settings?section=payments&stripe=refresh

Closed by VAY-1342/#1208.

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

Closed by VAY-1346/#1300.

### 4. Stripe callback intake and retained evidence

At initial review, POST /webhooks/stripe in
apps/api/src/routes/providerWebhooks.ts:

- read the exact raw request body;
- required stripe-signature;
- verified HMAC and timestamp tolerance with STRIPE_WEBHOOK_SECRET;
- parsed only after successful signature verification;
- recursively dropped fields named client_secret, secret, access_token, or
  refresh_token;
- redacted the signature header;
- persisted the remaining headers and event with a payload hash and deduplicated
  receipt;
- promoted effects only when Stripe intake mode was mutating.

For account.updated, the normalizer records the connected account ID and queues
finance.reconcile-provider-account evidence. Whether the production endpoint is
configured for connected-account events with the matching secret is Stripe
Dashboard state, not repository evidence.

At initial review, the receipt boundary was not approved for production. The
remaining event was stored in platform.external_webhook_events.raw_payload with
privacy_scope restricted and ai_visible false. The row defaulted to external
tenant scope and was append-only. The denylist had four names, the focused test
covered client_secret, unknown fields were retained, and no deletion or
retention policy existed. Restricted and AI-invisible storage reduced exposure
but did not justify retaining an open-ended provider event.

VAY-1348/#1313 closed this repository gap with an allowlisted/minimized receipt
shape, Stripe-only retention and purge behavior, legacy scrubbing, and policy
and adversarial coverage. Real secrets and production payloads must never be
copied into Linear, GitHub, chat, logs, or fixtures.

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
requirement is lost. At initial review, tests covered readiness gain and an older
incomplete event arriving after canonical Stripe was active, but not explicit
canonical readiness loss. There was also no authenticated property-scoped
command that invoked this repair after a missed webhook.

VAY-1343/#1210 closed both gaps with the idempotent command, authorization and
denial coverage, readiness gain/loss tests, and a secret-safe response.

### 6. Provider readiness is not payment-method readiness

At initial review, VAY-1064 intentionally kept the card method unready. The
method snapshot in packages/domain-finance/src/paymentReadinessSnapshot.ts did
not consume Stripe provider-account state and always added
online_card_execution_unavailable.

This is a required safety gate, not evidence that online card works. An active
Stripe account proves onboarding/capability state only. It does not prove
PaymentIntent execution, quote and booking linkage, retries, duplicate-charge
protection, or failure recovery.

The provider reconciliation also updated a coarser public bookability
projection. Until both models shared one release decision, that coarse
projection could not authorize online-card publication.

VAY-1345/#1214 closed the bridge:

- consume canonical property provider/capability state;
- require accepted ONB-25A execution evidence in addition to account readiness;
- keep online card dark when either input is absent or stale;
- demote only dependent card methods/rates on capability or evidence loss;
- make setup, launch readiness, and public bookability agree.

Pay at hotel readiness is independent and outside this Stripe audit; any
production cutover requires separate acceptance. This audit establishes only
that online card cannot be enabled merely because onboarding looks connected.

### 7. Post-return frontend state

At initial review, Booking Admin loaded Finance settings on mount but did not
reconcile on stripe=return, poll for a bounded propagation window, or refresh
when the original tab regained focus. VAY-1343/#1210 and VAY-1344/#1211 closed
the backend repair and Booking Admin refresh gaps.

Marketplace had a manual “Check Stripe status” action that only reread Finance.
It did not call canonical provider reconciliation or automatically react to
return parameters or original-tab focus, so a missed webhook could leave the
account pending even after a manual reread. VAY-1346/#1300, VAY-1343/#1210, and
VAY-1347/#1306 closed the return-context, repair, and Marketplace refresh gaps.

Neither frontend may infer success from a return parameter. Both must render
only canonical Finance state and use bounded retry.

## Authorization, secret, and data review

| Boundary                   | Finding                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account create/link routes | Property Finance write policy runs after Fastify body parsing but before Finance command parsing and provider calls.                                                                                |
| Accepted permissions       | Either pms.operations.manage plus property-management or booking.settings.manage plus direct-booking-finance.                                                                                       |
| Tenant scope               | Both policy alternatives require the exact property resource and owner/finance_manager relationship; account lookup remains owner-scoped.                                                           |
| Provider API secret        | Server configuration only; used by the server-side Stripe adapter.                                                                                                                                  |
| Webhook secret             | Raw-body signature verification only; stripe-signature is redacted before receipt persistence.                                                                                                      |
| Provider records           | Store account reference and readiness metadata, not Stripe API or signing secrets.                                                                                                                  |
| Webhook receipts           | Stripe receipts are minimized after exact-body verification, restricted and AI-invisible, and covered by a 30-day purge policy. VAY-947 still requires deployed access/purge evidence and approval. |
| Browser response           | Contains the onboarding URL and required account identifiers, not a secret key or raw provider event.                                                                                               |
| Operational proof          | Production connected-account selection, exact endpoint, matching secret, signed delivery, and rollback remain VAY-947 evidence.                                                                     |

## Gap closure and dependency order

1. **VAY-1342 — Fix Stripe onboarding return and provider persistence** —
   merged in #1208.
   - Fix Booking Admin destinations.
   - Persist Stripe before account creation.
2. **VAY-1346 — Fix Marketplace Stripe onboarding return context** — merged in
   #1300.
   - Preserve the authorized property and Payments step.
3. **VAY-1343 — Add Stripe Connect post-return reconciliation** — merged in
   #1210.
   - Add the authenticated property-scoped canonical repair command.
   - Cover readiness gain, loss, authorization, idempotency, and safe errors.
4. **VAY-1344 — Refresh Stripe status after onboarding** — merged in #1211.
   - Add bounded Booking Admin return/focus reconcile and refresh.
5. **VAY-1347 — Refresh Marketplace Stripe status after onboarding** — merged
   in #1306.
   - Add bounded Marketplace return/focus reconcile and refresh.
6. **VAY-1345 — Gate online-card readiness on Stripe account and execution evidence** —
   merged in #1214.
   - Join provider state with accepted ONB-25A evidence.
   - Keep online card dark until the complete gate passes.
7. **VAY-1348 — Harden retained Stripe webhook receipt payloads** — merged in
   #1313.
   - Minimize retained data and define approved retention/access/replay.
8. **VAY-947 — Cut over Stripe and Channex callbacks** — unblocked to begin its
   separately authorized operational evidence work; the production switch
   remains blocked pending that evidence and approval.
   - Prove connected-account delivery and the matching secret.
   - Rehearse signed delivery and rollback before changing ownership.

The repository dependency chain is complete. VAY-947 may begin separately
authorized evidence work, but the production callback switch remains blocked on
the evidence and approval below; merged implementation is not the release gate.

## Rollout and rollback

The implementation tickets have merged behind fail-closed gates. When deployed,
they remain dark while legacy remains the production owner.

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

| VAY-1075 acceptance criterion                             | Evidence / disposition                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Written end-to-end trace                                  | This document sections 1–7.                                                                                            |
| Correct return/refresh destination                        | VAY-1342/#1208 and VAY-1346/#1300 merged with exact Booking Admin and authorized Marketplace context coverage.         |
| Provider selection survives redirect/reload               | VAY-1342/#1208 merged; Marketplace persistence was already ordered before onboarding.                                  |
| Active account cannot remain pending after missed webhook | VAY-1343/#1210, VAY-1344/#1211, and VAY-1347/#1306 merged with backend repair and bounded frontend refresh coverage.   |
| account.updated readiness gain and loss                   | VAY-1343/#1210 merged with canonical gain/loss and repair-command coverage.                                            |
| Method-level payment readiness                            | VAY-1345/#1214 merged; online card remains dark without both canonical provider state and accepted execution evidence. |
| Secret and property authorization                         | Exact policies are documented and covered; production endpoint/secret alignment remains VAY-947 evidence.              |
| Webhook receipt data boundary                             | VAY-1348/#1313 merged with minimized receipts, Stripe-only retention/purge, legacy scrubbing, and PostgreSQL coverage. |
| Discovered gaps have linked implementation ownership      | VAY-1342 through VAY-1348 are merged; VAY-947 retains the explicit operational gate.                                   |
| Findings recorded before close                            | This repository record and VAY-1075 contain the implementation and verification matrix.                                |

VAY-1075 stays **In Progress** until human merge and smoke-test acceptance.
Merging this record does not accept its implementation children, enable online
card, or authorize any production cutover.
