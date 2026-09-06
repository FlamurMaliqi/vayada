# VAY-1480 staging preflight — 2026-09-06

> **Historical snapshot.** This report predates the isolated maps canary and the
> canonical `0158`/`0159` migration reconciliation. Later canary evidence and the
> current checked-in migration catalog supersede its rollout status and version
> instructions; keep the observations below only as dated preflight evidence.

The rebuilt map is not deployed to shared `next`. Do not treat the local preview
or this integration candidate as a staging smoke result.

## Release candidate

Validation branch `flamurmaliqi2811/vay-1480-staging-validation` combines the map
stack through `60d56f73b`, obsolete-map removal, and main through `df52b1eee`.
Candidate commit: `e2f4e08f0500ab43884e90851736dc93c6df5311`.
The manual merge resolutions retain both Finance KMS and Google example settings,
and keep Surroundings while removing the obsolete RoomMapPanel import.

Current main had already allocated migration versions 0151–0153 to Finance.
The draft map migrations reused 0151/0152, causing discoverMigrations to reject
the combined catalog before API startup. Renumbered the unshipped map migrations
to 0154/0155 without changing their SQL. Added a checked-in-catalog regression.
The exact renames also belong in owning draft PRs #1571 and #1575 so intermediate
merges cannot introduce the collisions. Recheck allocations against main before
merging; other work can reserve these versions concurrently.
Do not rename any applied shared-environment migration or edit its ledger. Earlier
map-only disposable databases used the old numbers and have been removed.

## Checks

- Root build passed on the combined maps/removal candidate before the final
  main merge, which changed only Marketplace follower-requirement UI/tests.
- All 16 focused Booking Admin/Web nearby browser checks passed against those
  production builds. Browser API and Google responses were mocked.
- All 46 focused nearby API/provider/PostgreSQL tests passed.
- Root typecheck passed after the final main merge.
- All 155 migrations applied to a fresh disposable PostgreSQL 16 database;
  replay reported no pending migrations. All six migration-discovery tests passed.
- A broader runner.test.ts invocation returned 16 passes and three failures:
  its trivial-migration test reused an already populated migration ledger;
  a setup-track assertion expected 23503 but received 23514; and its Booking
  table inventory omitted booking_addon_selection_items and same_day_booking_policies.
  The latter two remain unresolved failures involving these expectations; they
  were not independently reproduced on main. The fresh catalog apply
  and replay above were separate checks, not a passing rerun of this suite.

## Observed shared staging prerequisites

Read-only AWS inspection found API task definition 760 in rollout, guest frontend
189 and hotel frontend 331. Recheck stability and capture previous image digests
immediately before any deployment; these are observations, not rollout approval.

1. The map stack remains draft. Complete review of its dependencies and this
   migration correction before shared deployment. CodeRabbit SUCCESS on a draft
   can mean skipped review.
2. The API has PUBLIC_HOTEL_PROFILE_SOURCE=target. The new publicNearby runtime
   is wired only for active_publication. The synthetic hotel's deployed nearby
   endpoint returned HTTP 404. Switching the global source also changes booking
   publication behavior and requires its Booking/PMS/Finance/media dependencies;
   it is not a map-only toggle. Verify that rollout separately rather than
   enabling it just to make this smoke pass.
3. The API task has no GOOGLE_NEARBY_ENABLED or GOOGLE_PLACES_SERVER_API_KEY
   configuration. Provision the server-only credential and deliberate rollout
   scope before expecting automatic discovery. Do not expose it to browsers.
4. The GitHub GOOGLE_MAPS_BROWSER_API_KEY secret name exists. Both frontend
   workflows pass it at build time; actual hosted image contents and referrer
   behavior still need verification. No secret values were inspected here.
5. Existing deployment workflows update shared next services and API startup
   automatically migrates their configured database. They do not provide an
   isolated feature staging slot. Record the migration ledger and rollback plan
   before dispatch, including confirmation that nearby's old versions were never
   applied there; never use the immutable VAY-1361 rehearsal target for writes.

Once those gates are satisfied, use the existing synthetic test hotel and owner:
open Location settings, confirm coordinates/visibility, refresh suggestions,
favorite/hide/add/note, save/reload, and verify the public booking view. Test Hidden
and restore the original property state. Coordinate shared test-property changes;
do not create reservations or payments. Record exact deployed image digests and
separate real browser results from mocked checks.

No shared service, remote property, credential configuration or migration ledger
was changed by this preflight. Staging browser smoke remains outstanding.
