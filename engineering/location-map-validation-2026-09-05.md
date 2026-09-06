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

## Live Google integration check

On 2026-09-05, connected the two Google keys to a private local test setup,
outside the repository. Backend key remains server-only and restricted to
Places API (New). The browser key retains 15 allowed website entries.

The actual `discoverGoogleNearby` adapter made its four bounded live requests
at a synthetic public Paris location. All returned HTTP 200; the adapter returned
`ready` with 39 places across nature, food, activities and transport. Only place
IDs/categories were retained for the browser check; no provider coordinates or
descriptive content were written to an application database.

Mounted the actual shared `NearbyPreview` component at the approved local guest
origin with one live result per category and one synthetic custom recommendation.
The initial real UI Kit requests failed with an API-authorization error. Added
Places UI Kit to the existing browser-key API allowlist, retaining its other APIs
and all website restrictions. After reload, the map, four real Google compact
cards, map attribution, card attribution and destination-only directions links
rendered. Clicking a real map marker selected and focused its corresponding
card; Tab then reached the Google review link. The approximate-location circle
and synthetic hotel note remained visible.

This is live provider/actual-component evidence, not a deployed full-application
test. The harness supplied the preview payload and did not exercise authentication,
curation PUT, database persistence or guest publication end to end. Prior mocked
browser tests cover those editor interactions; real save/reload still requires
the suitable isolated application runtime tracked in VAY-1361. No production
service deployment, feature-flag activation, hotel privacy change or booking was
performed. Google's legacy Marker deprecation warning remains non-blocking;
no claim is made of comprehensive keyboard or all-provider-outage certification.

## Storage-backed feature integration — 2026-09-06

Ran the actual NearbyEditor and guest Surroundings components against the actual
Fastify routes and PostgreSQL repositories in a temporary local shell. Applied
the current migrations to a disposable PostgreSQL 16 database and seeded one
synthetic hotel, local authorization records, and an active publication fixture.
Used the existing reusable hotel owner's WorkOS login, verified its signature,
issuer and audience, and kept the short-lived access token server-side. Missing
and invalid tokens returned 401; the verified owner could read the local hotel.
No remote property records or immutable VAY-1361 rehearsal data were changed.

Manual live browser checks passed:

- Live discovery returned 39 places. Favorited one, added a note, hid another,
  added a custom place and saved through the real curation PUT (200).
- Reloading the editor preserved the favorite, hidden choice, note and custom
  place. The public guest endpoint returned 200 and rendered the recommendation,
  note and custom place with the approximate-area map.
- Saving Hidden through the real profile PUT returned 200; reloading the guest
  view displayed only “Contact us for location details,” with no map or places.
- Restoring Approximate returned 200. Discovery then enforced its property-wide
  cooldown (429), and the editor required review of saved places. The test did
  not bypass this limit or assert automatic rediscovery after the change.

Initial location-save attempts failed because the synthetic seed lacked postal
code and required contact channels. Completed those synthetic fields locally,
reloaded the editor, and reran the successful privacy checks above.

This validates the feature's auth, storage and browser path in a local shell.
It does not validate deployed navigation, publication creation, remote property
persistence, or the immutable rehearsal release. The active publication and
authorization mapping were synthetic fixtures, not newly created WorkOS roles.

### Deferred Google card regression

The full list exposed a real bug: the component's eight-second watchdog removed
offscreen Google widgets before they loaded. In a controlled 39-card probe, 29
loaded immediately; the remaining ten loaded only after scrolling. Extending
the deadline to 30 seconds still removed those ten if they remained offscreen.

The fix limits the watchdog to SDK import and lets mounted widgets report their
own errors. With the actual fixed component, all 39 remained mounted and all
loaded; the last ten completed about 20.6 seconds after mounting, when scrolled
into view. No provider text
or coordinates were persisted by the probe. Import timeout/rejection, explicit
provider errors, coordinate validation and cleanup remain intact. A mounted
widget that never emits load or error remains pending.

Added a regression that advances the clock past eight seconds before dispatching
Google's load event and verifies the card survives and receives directions.
Independent adversarial review found no actionable findings in the fix and test.

Root typecheck, guest production build and guest lint passed (zero errors,
16 existing warnings). All seven focused surroundings browser checks passed,
including the new delayed-load regression. The first run had four failures and
three passes because the temporary proxy lacked wildcard routing and the build
lacked the test browser-key sentinel; corrected both and reran successfully.
Automated checks mock Google and API responses; the 39-card probe used live Google.
Stopped the authenticated shell, deleted its session file, removed the disposable
database, and restored the design preview. No deployment or release acceptance.
