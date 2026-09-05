# Location rebuild validation — VAY-1480

Local validation report, 2026-09-05. **Not a production data reconciliation or release approval.**

## Chosen data and scope

Use disposable PostgreSQL 16 database `nearby_test` and the existing migration
fixtures. No configured target/source connection or approved immutable extraction
run was found in the task checkout. No production connection was guessed.
The user authorized choosing the validation environment. A read-only inventory
after fixture cleanup returned 0 extraction runs, 0 properties and 0 nearby curation
records. These are empty test-database counts, not business-data counts.

No backfill is proposed or executed. Fixture setup and integration tests write
only to the disposable database; this report changes no source or target data.

## Reconciliation disposition

| Data | Evidence and disposition |
| --- | --- |
| Canonical hotel location | Reuse VAY-1351 immutable extraction and VAY-1354 catalog reconciliation. Resolve through `property_source_links`, never hotel names or addresses. Newer target timestamps and location-owner revisions are preserved; equal-time conflicts are blocked. |
| Privacy | Existing catalog writer does not overwrite `address_public`, `geo_public`, or `map_display_mode`. Nearby projection suppresses hidden locations and uses rounded public coordinates for approximate locations. |
| Room location overrides | Preserve PMS `room_types.location_summary` and source room ID. Added record-builder regression verifies address, zero latitude and coordinate precision survive unchanged across repeated conversion. It does not exercise database replay or preservation of newer target room edits. These overrides are not promoted to canonical hotel locations or nearby recommendations. |
| Historical POIs | Legacy Booking rows store label, travel time, color and coordinates without reliable author/provider provenance or the new category contract. Preserve the source rows. Require explicit provenance/category review before any import; do not copy historical travel times or guess Google IDs. |
| New automatic places | Keep discovery IDs/category buckets separate from custom hotel content. Provider coordinates remain transient; discovery failure does not erase curation. |
| Ambiguous/invalid data | Keep the existing catalog/PMS migration blockers. A missing pair, conflicting identity or unknown provenance does not authorize a guessed repair. Actual affected-row counts remain unknown without a real immutable extraction. |

Coordination references: VAY-1351 and VAY-1354 are marked Done in Linear;
VAY-1287 remains In Progress with room-command PRs #1508–#1513. This work changes
none of those production writers or room commands.

## Combined-code evidence

Validated local integration commit `cc2ec1187`: guest rebuild `c43c988ab`
(VAY-1479 final PR #1589) plus old-map removal `c6cb7ecf4` (PR #1565).
The merge has one import conflict in the booking home page: retain the
`Surroundings` import and remove `RoomMapPanel`. Preserve the new `<Surroundings>`
mount. No other conflict occurred. Room record-builder regression is commit `1ffd03d51`.

The integration branch is validation evidence, not a replacement for merging
the reviewed PR stack. Searches in Booking Web/Admin found no runtime references
to `RoomMapPanel`, `LocationMapPreview`, `booking/LocationMap`, `showRoomDetailMap`
or `pointsOfInterest` after combining both branches.

## Checks

- All 152 target migrations applied in a fresh disposable database.
- Root workspace build and typecheck passed on the combined implementation.
- Booking Web/Admin builds passed as part of root build; lint had 0 errors
  (16 existing Booking Web warnings, 10 existing Booking Admin warnings).
- Six migration suites passed 30 tests; the added room-location record-builder test
  also passed (13 room tests total, 31 unique migration tests across these runs).
- Eight nearby/publication API suites passed all 54 tests with PostgreSQL enabled.
- All 95 browser checks passed: 86 Booking Web smoke tests and 9 hotel-editor
  nearby tests, on the combined old-removal/new-feature implementation.

The first API integration attempt overlapped a catalog-writer test that replaces
schemas. It failed on missing tables. Recreated the disposable database, applied
all migrations, then reran API tests after the migration tests finished: 54 passed.
Run those two database test groups sequentially or in separate databases.

## Remaining release evidence

Real-data reconciliation still requires a completed, verified immutable extraction
run and its target source links. Use the existing migration snapshot readers;
retain source run IDs/checksums, report conflicts, and review a read-only report
before authorizing any additive/idempotent backfill.

Browser checks use mocked API/Google responses. A real hotel flow through the
deployed API/database, Google account/API/billing/referrer/quota checks, live
attribution and SDK keyboard behavior remain unverified. No credentials were
available for that validation. Keep provider activation disabled and the rebuild
PRs draft until that evidence and human merge/shipped acceptance are supplied.

## Follow-up: selected real staging evidence

A subsequent lookup of [VAY-1361](https://linear.app/vayadacom/issue/VAY-1361)
found newer real-data evidence that was not configured in this checkout. Select
its retained isolated target `vayada_target_staging_824c10d8_b074ab` and immutable
source run `vay1351-284859bacf5c049394f9f5e6` for the remaining read-only location
reconciliation. Do not substitute the shared production/auth database.

VAY-1361 records orchestration `vay1360-b074ab30e0ff1559080d6942`, release
`824c10d89e11a84bc7ea298577f80040bf5ff840`, parity GO and AWAITING_SMOKE.
Read-only AWS inspection independently confirmed its ECS task
`ad41ac4718d1431d8aa7ede89d15096c` stopped with expected exit 4 and image digest
`sha256:fb1493a317838fd2bb5f6278c2e3a883d5d421c70357d521e8e1ded339e04814`.
The parity result is recorded evidence from VAY-1361, not a new location-specific
query or validation of the unmerged map rebuild on that older release.

VAY-1361's latest application preflight reports no isolated application/test-auth
runtime bound to that target/release. Reuse that existing rehearsal work for the
runtime prerequisite; retain the run and its evidence. Real location counts,
map-specific reconciliation and live Google checks remain pending. This
follow-up launched no task, changed no database and switched no service binding.

## Real-data read-only result

Executed the selected staging check on 2026-09-05 in diagnostic task
`e3584e769d08452ba55c9d7a86e7c2f3`, using runner definition :18 and the pinned
image above. Account, isolated RDS resource, endpoint, database, role, release,
source run, orchestration state and parity were checked before querying.
PostgreSQL session `default_transaction_read_only=on`, explicit read-only
inventory transaction and bounded statement/lock timeouts protected the run.
The existing catalog transaction ran in `dry-run` mode and rolled back.
Independent operational review found no execution blockers. Output contains
aggregate counts and evidence identifiers, with no credentials or source values.

| Check | Observed result |
| --- | --- |
| Canonical properties | 341; all have an active source link |
| Canonical locations | 341 rows; 1 complete coordinate pair, 340 missing pairs, 0 partial pairs, 0 invalid ranges |
| Current privacy | All 341 maps hidden; 0 public coordinates and 0 public addresses |
| PMS room source matching | 436 source rows, 436 matched target rows, 0 unmatched |
| Room location overrides | 13 source rows contain overrides; 0 raw address/coordinate differences across matched room rows |
| Historical Booking POIs | 221 hotel source rows contain the top-level field; 2 have nonempty arrays |
| New nearby schema | Curation table absent on this older rehearsal release |
| Existing catalog dry-run | 0 blockers, 0 writes, `applied=false`; all 2,806 preserved catalog records are identical |
| Existing source quarantines | 120 source rows; reasons and location relevance were not emitted by this aggregate diagnostic |

Catalog checksum:
`839d28dfe0392360c3ce1b4762c1ccda33da589b51ade91bce74c2d0d3ed5c3b`.
This supersedes the earlier lack of real-data counts. No corrective catalog
backfill is indicated by this dry-run. Zero blockers does not resolve the 120
existing quarantined source rows or establish that all source data is usable.
Preserve the 13 room overrides and the
2 legacy POI source rows; POI authorship/category review is still required before
any new import. Do not infer public consent or invent coordinates for the 340
hotels with missing pairs. Nearby display requires confirmed coordinates and
an explicit public visibility choice through the new editor.

Evidence limits: catalog totals cover all catalog entities; the room comparison
checks address/coordinates and source IDs, not every PMS field. POI counts cover
the top-level Booking field only. Inventory and catalog planning used separate
read-only snapshots. This older image does not contain the new nearby schema
or rebuilt UI, so its results do not validate the feature against the deployed
API. The isolated app setup remains with VAY-1361. No Google configuration was
found in local settings, `/vayada/` SSM parameter names, or Secrets Manager names
matching google/maps/places. Live Google and rebuilt-app checks remain pending.
