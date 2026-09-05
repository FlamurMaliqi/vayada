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
