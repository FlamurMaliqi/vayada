# Affiliate portal source retirement

VAY-1498 and VAY-1499, based on the accepted
[VAY-1497 inventory](https://linear.app/vayadacom/document/affiliate-retirement-inventory-and-continuity-plan-vay-1497-2135f92ca34e).

## Source removal is separate from service cutover

Stop publishing new standalone affiliate images before deleting the application.
The existing deployed portal remains the temporary continuity surface while the
integrated Marketplace product is built. Removing a GitHub build workflow does
not stop ECS, change DNS, move users, or retire an API.

Marketplace currently accepts creator_workspace and hotel_group organizations;
it does not accept affiliate_partner. Do not replace the affiliate login with a
Marketplace redirect until an accepted, verified existing-user path exists.
Do not manufacture creator memberships for affiliate-only accounts.

Keep the deployed portal's auth, reporting, payout-settings and payout-history
API contracts during source removal. VAY-1499 and VAY-1500 must retain these
consumers until cutover. Old hotel booking-domain ?ref URLs are separate from
portal URLs and remain supported by Booking. Preserve identity records,
referral evidence, commission rules, balances, payout evidence and provider IDs.

## Observed deployment baseline

Read-only inspection on 2026-09-06, eu-west-1, cluster
vayada-backend-cluster:

| Service                                 | Task definition                    | State                                        |
| --------------------------------------- | ---------------------------------- | -------------------------------------------- |
| vayada-affiliate-dashboard-service      | vayada-affiliate-dashboard:99      | ACTIVE, desired/running 1, rollout COMPLETED |
| vayada-next-affiliate-dashboard-service | vayada-next-affiliate-dashboard:19 | ACTIVE, desired/running 1, rollout COMPLETED |

The next task definition pins this image digest:

```text
vayada-next-affiliate-dashboard@sha256:96fce14b8754ea70c9af881405fc3c69711d69d7f4c39f11b71db4d316403088
```

ECR retains it with the release tag
next-a2bdf3b38d1dda4af27d41af9ecdf7441e0a8ae4. The inspected next repository
lifecycle policy expires only untagged images after seven days; keep the release
tag. Do not use next-latest as the recovery reference.

The canonical task definition references
vayada-affiliate-dashboard:e3809df436514fc14df84f0adf14f365856fea2c.
It is not changed by this work.

Both https://affiliate.vayada.com/login and
https://next-affiliate.vayada.com/login returned HTTP 200. This proves page
availability only; it does not prove authenticated access, correct balances,
booking attribution or payout execution. These observations are a timestamped
baseline, not a permanent assertion about the deployed state.

## Delivery sequence

1. Remove the application-repo next portal build/deploy workflow. Keep source and
   auth/API tests in this prerequisite change. Check for an already-running build
   or platform dispatch before declaring delivery frozen; workflow deletion does
   not cancel a queued or in-flight run.
2. Remove the old app source, exclusive tests, workspace entries and local
   tooling references in the next source-only change. Keep the tagged deployed
   image and runtime/API contracts. No platform infrastructure changes accompany
   source deletion.
3. Build and verify the integrated account/earnings destination. Inventory real
   owner mappings, active links, financial obligations and provider/queue state
   before any user or API cutover. Preserve quarantine and multi-currency totals.
4. Coordinate the separately reviewed platform redirect/callback/service cutover.
   Only retire the retained API contracts and service after existing-user,
   referral and Finance continuity checks pass.

## Recovery and completion

Before a cutover, source deletion requires no runtime rollback because it does
not change a deployed service. Preserve the current task definition and tagged
image so task replacement does not depend on rebuilding the deleted app.
Recheck artifact retention and service configuration before each later cutover.
If an API change would break the retained portal, stop that release and keep its
compatible API version; never silently move users to an inaccessible destination.

A failure in the eventual integrated destination rolls back its narrow adapter
or routing change with a reviewed recovery artifact. Do not replay payouts,
change provider ownership or downgrade schemas as an automatic rollback step.

Source removal alone does not complete VAY-1498's existing-user continuity
acceptance criterion. Keep the issue open until the accepted destination and
required verification are delivered. Do not report a build freeze, HTTP 200 or
mocked tests as a complete affiliate migration.

## Current source retirement state (VAY-1499)

This section describes the stacked implementation through PR #1688 and this cleanup.
It is not a claim that the stack is merged, deployed or accepted. Source removal and
service/account cutover remain separate, as described above.

### Removed product behavior

Booking Web no longer offers public enrolment. Its ReferModal, exclusive API client,
registration/email-existence repository methods and obsolete projection tests are removed.
Booking Admin `/affiliates` keeps an unavailable notice and dashboard link inside the
existing authenticated shell. Its old workspace, client, sidebar/search entry and
lifecycle/commission UI are removed. The shared Feature Hub catalog no longer advertises
or offers activation of the old affiliate module in Booking Admin or PMS.

The target API retains explicit HTTP 410 responses with `Cache-Control: no-store`:

| Surface          | Retired routes                                                                                                             | Error code                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Public enrolment | GET `/api/booking-web/hotels/:slug/affiliates/check-email`; POST `/api/booking-web/hotels/:slug/affiliates`                | `affiliate_enrollment_retired`        |
| Module changes   | PATCH `/api/pms/properties/:propertyId/module-activations/:moduleId` for the known affiliate module and valid request body | `affiliate_module_activation_retired` |
| Administration   | GET `/api/marketplace/properties/:propertyId/affiliates`; GET detail and POST `/:affiliateId/lifecycle`                    | `affiliate_administration_retired`    |

Existing authorization, property scope, CORS and applicable request validation remain
before the protected retirement responses. Public enrolment is retired wherever its
routes are mounted, including the fallback adapter. Missing configuration remains
fail-closed. Retired administration routes do not read affiliate data or mutate state.

Unused lifecycle and module-activation writers, their obsolete tests, listing SQL/query
parser and exclusive action/command/result/list-input/endpoint exports are removed.
The module route no longer receives a publication-refresh port; other booking consumers
retain their refresh wiring.

### Retained continuity

- Booking `?ref=` cookie/click capture, quote attribution and reservation history remain.
  These paths prove capture/storage, not verified completed-booking attribution.
- Existing-affiliate Connect remains scoped to existing registration evidence. Shared
  provider handling, identity derivation, callbacks and historical events are unchanged.
- Module inventory advertises no supported modules but still reads existing scoped
  activation state. No activation rows or earning agreements are deactivated by cleanup.
- The admin-named repository retains `getAffiliate(propertyId, affiliateId)` for shared
  Finance and its existing close hook. Its record/status types remain required by that
  consumer; old administration reads return 410 independently.
- Portal auth/account and payout settings/history APIs remain for the frozen service.
  The server does not supply the optional dashboard reporting repository; guarded
  unavailable responses are not proof of working deployed reporting.
- Collaboration approval still reports affiliate provisioning requests for enabled terms.
  Response/evidence contracts alone do not prove actual provisioning. Preserve collaboration
  data and trace this behavior through the integrated M1 design before changing it.
- Finance commission configuration, payout operations, fee settings and shared dispatcher
  code remain subject to VAY-1500 reconciliation. No normal affiliate dispatcher caller
  was found in searched source; deployed scheduler/queue/provider ownership is unverified.

Identity records, quarantine, referral evidence, historical lifecycle/audit rows, commission
rules, balances, provider references, payment evidence and applied migrations remain intact.
Python services and platform infrastructure are outside this source cleanup.

### Verification and remaining release work

Per-slice unit/build/browser evidence is recorded in VAY-1499 and the stacked PRs.
Mocked checks and skipped PostgreSQL integration tests do not establish live continuity.
Before completion, integrate reviewed PRs in order, verify the deployed revision and
exercise returning-user access, callbacks, old links through persisted booking evidence,
and unchanged balances/history using bounded synthetic data. No real reservations or
payments belong in smoke testing.

The integrated account destination and service cutover remain VAY-1498 work; conditional
Finance cleanup remains VAY-1500 work. Keep VAY-1499 In Progress until required validation
and explicit acceptance are complete. Do not delete the retained continuity boundary
merely because the standalone source has been removed.
