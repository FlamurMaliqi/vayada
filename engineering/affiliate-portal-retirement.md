# Affiliate portal source retirement

VAY-1498, based on the accepted
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

## Public enrolment retirement (VAY-1499)

The first API slice retires GET `/api/booking-web/hotels/:slug/affiliates/check-email`
and POST `/api/booking-web/hotels/:slug/affiliates` with HTTP 410,
`affiliate_enrollment_retired`, and `Cache-Control: no-store` wherever those routes
are mounted. Neither route calls the old enrolment repository or fallback adapter.
Booking Web no longer offers the guest enrolment button, even when old branding
settings enable it. Missing route configuration continues to fail closed.

Existing `?ref=` cookies/click capture, quote attribution and affiliate account /
Finance routes remain unchanged. The scoped existing-affiliate Connect endpoint
remains for continuity; this slice adds no provider capability. Old affiliate
administration remains a subsequent removal slice; VAY-1499 is not complete.
Do not delete lifecycle history or migration fixtures while removing their old UI/API callers.

The retired Booking Web enrolment modal and its exclusive registration/check-email/
Connect client have been deleted after navigation was disconnected. Server-side
existing-affiliate Connect compatibility remains available independently. Removing
this unused client does not remove referral-cookie capture or payment history.

The target public registration writer, email-existence lookup and obsolete registration
projection tests are removed. Retained Connect checks read existing registration events;
their identity derivation and event/history formats remain unchanged. No historical rows
or applied migrations are removed. Test identities are seeded explicitly as existing data.

Booking Admin `/affiliates` now keeps only an unavailable notice and dashboard link
inside the existing authenticated shell. Sidebar and search no longer offer affiliate
management, including for previously active modules. Lifecycle/commission controls no
longer load or call affiliate APIs. The unused AffiliateWorkspace component, affiliate
service and its obsolete tests have been deleted. Backend administration and shared
Feature Hub advertising/activation remain subsequent cleanup; account state, commissions
and history are not changed.
