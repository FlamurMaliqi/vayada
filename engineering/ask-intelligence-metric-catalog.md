# Ask Intelligence metric catalog

> **Retired on 2026-08-13.** The Ask Intelligence product and runtime described
> here have been removed. This catalog is retained only as historical context
> and is not the source contract for the future VAY-1091 hotel-employee agent.

_VAY-740 catalog record. Builds on VAY-601 Ask Intelligence architecture,
VAY-613 evidence contract, VAY-736 runtime/provider decision, and the
`intelligence` target schema from VAY-677._

## Purpose

Ask Intelligence must answer first from canonical metric definitions, not from
prompt-authored calculations. This catalog defines the first MVP metrics for one
selected hotel organization and one linked property scope.

The MVP metric catalog is read-only and internal-data-only. It does not add
external enrichment, competitor benchmarks, write tools, or arbitrary SQL access.

## Scope Defaults

Unless a metric row says otherwise:

- `resource_scope`: `property`
- `required selected organization`: one active hotel-group organization from
  `RequestContext`
- `required resource link`: selected organization's linked booking/PMS property
- `default comparison`: requested period versus immediately previous period of
  equal length
- `freshness source`: `intelligence.metric_snapshot_runs.source_fresh_at` or
  `intelligence.setup_completeness_snapshots.source_fresh_at`
- `fresh`: generated within the metric's `freshness_slo_seconds`
- `stale`: source is older than the SLO or the source marks the snapshot stale
- `quality`: use the evidence contract values `complete`, `partial`, `stale`,
  `estimated`, `hotelier_entered`, or `unavailable`

Date filters are inclusive at the day level. Runtime tools may normalize UI
shortcuts such as `last_7_days` or `this_month` into explicit `from` / `to`
dates before calling evidence tools.

## Catalog

### `booking.direct_booking_share`

- Domain: direct booking performance
- Definition: direct bookings divided by all owner-visible bookings in the
  selected period. Numerator includes bookings whose normalized source is
  `direct`; denominator includes `direct`, `partner`, `affiliate`, `creator`,
  `ota`, `channel`, and `manual` bookings linked to the selected property and
  not test/migration-only records.
- Unit: `percentage`
- Target source: `intelligence.metric_snapshot_runs` sourced from
  `booking.direct_booking_summary_read_model`; snapshot generation may read
  booking/PMS source assignment fields needed to normalize source.
- Filters: `dateRange`, `comparisonRange`, `bookingStatus`, `source`, and
  `currency` for paired revenue context.
- Freshness: 24h SLO, `aggregate_only`, `complete` only when source
  normalization is available for every included booking.
- Permission: `booking.analytics.read`
- MVP tools: `get_booking_performance`, `get_booking_source_mix`

### `booking.booking_source_mix`

- Domain: booking source mix
- Definition: distribution of booking count and gross booking amount by
  normalized source for the selected property and period. Percentages are each
  source bucket divided by the included total.
- Unit: `percentage`
- Target source: `intelligence.metric_snapshot_runs` sourced from
  `booking.direct_booking_summary_read_model`; source labels come from canonical
  source normalization, not model inference.
- Filters: `dateRange`, `comparisonRange`, `bookingStatus`, `source`,
  `currency`
- Freshness: 24h SLO, `aggregate_only`; `partial` if a source bucket is unknown
  but records remain usable.
- Permission: `booking.analytics.read`
- MVP tools: `get_booking_source_mix`, `get_booking_performance`

### `booking.conversion_funnel`

- Domain: booking funnel
- Definition: step counts and conversion rates for booking-page view,
  quote/search start, checkout start, payment attempt, and confirmed booking.
  Each conversion rate is current step count divided by the prior step count;
  overall conversion is confirmed bookings divided by page views.
- Unit: `percentage`
- Target source: `intelligence.metric_snapshot_runs` after an approved funnel
  snapshot exists. The snapshot can be generated from `booking.quote_sessions`,
  `booking.checkout_contexts`, `booking.guest_bookings`,
  `booking.booking_status_events`, and approved page-view/funnel events. Until
  those inputs exist, tools return `partial` or `unavailable` instead of
  calculating a fake funnel.
- Filters: `dateRange`, `comparisonRange`, `locale`, `device`, `source`, and
  `currency` for revenue-at-step context.
- Freshness: 6h SLO when page-view events are available; `partial` when
  checkout/booking records exist but page-view events are missing.
- Permission: `booking.analytics.read`
- MVP tools: `get_conversion_funnel`

### `booking.gross_booking_revenue`

- Domain: revenue / ADR
- Definition: sum of owner-visible gross booking amount for included bookings in
  the selected period and currency. Use booking amount summaries before
  payout/provider adjustments; finance-restricted net revenue is intentionally
  separate.
- Unit: `currency`
- Target source: `intelligence.metric_snapshot_runs` sourced from
  `booking.direct_booking_summary_read_model.amount_summary`
- Filters: `dateRange`, `comparisonRange`, `bookingStatus`, `currency`,
  `source`, `roomType`
- Freshness: 24h SLO, `aggregate_only`; `partial` if currency conversion or
  amount source is incomplete.
- Permission: `booking.analytics.read`
- MVP tools: `get_booking_performance`

### `booking.average_daily_rate`

- Domain: revenue / ADR
- Definition: gross room revenue divided by occupied room nights for included
  bookings in the selected period. Exclude taxes, fees, add-ons, refunds, payout
  fees, and canceled room nights unless the snapshot explicitly labels the
  adjustment.
- Unit: `currency`
- Target source: `intelligence.metric_snapshot_runs` sourced from
  `booking.direct_booking_summary_read_model.amount_summary` and room-night
  counts from `room_summary`; PMS room assignment read models may supply room
  type grouping.
- Filters: `dateRange`, `comparisonRange`, `currency`, `bookingStatus`,
  `roomType`, `source`
- Freshness: 24h SLO, `aggregate_only`; `estimated` only when room-night
  attribution is inferred from dates and occupancy.
- Permission: `booking.analytics.read`
- MVP tools: `get_booking_performance`

### `hotel_catalog.setup_completeness_score`

- Domain: setup completeness
- Definition: overall setup readiness score from required setup areas for the
  selected property. Score is 0-100 and must be accompanied by missing,
  blocking, and stale items when not complete.
- Unit: `score`
- Target source: `intelligence.setup_completeness_snapshots` and, for owner-safe
  setting context, `hotel_catalog.property_setup_status` /
  `distribution.public_hotel_bookability_profiles`
- Filters: `setupArea`, `includeBlockingItems`, `includeStaleItems`, `locale`
- Freshness: 12h SLO, `none` PII policy; `hotelier_entered` when the item is
  first-party setup content rather than system verification.
- Permission: `booking.settings.read` or `pms.read`
- MVP tools: `get_setup_gaps`, `get_hotel_settings_summary`

## Metric Details

### Direct Booking Share

Canonical formula:

```text
direct_booking_share =
  direct_booking_count / included_booking_count
```

Snapshot `value_summary` keys:

- `directBookingCount`
- `includedBookingCount`
- `directSharePct`
- `comparison.directSharePct`
- `comparison.changePct`
- `unknownSourceCount`

The evidence tool must return `partial` when `unknownSourceCount > 0` and the
unknown share could materially change the answer.

### Booking Source Mix

Canonical bucket keys:

- `direct`
- `partner`
- `affiliate`
- `creator`
- `ota`
- `channel`
- `manual`
- `unknown`

Snapshot `value_summary` keys:

- `sourceBuckets[]` with `source`, `bookingCount`, `grossAmount`,
  `bookingSharePct`, and `revenueSharePct`
- `includedBookingCount`
- `grossBookingAmount`
- `currency`

The answer layer may explain source mix but must not invent channel labels that
are not present in the snapshot.

### Conversion Funnel

Canonical funnel steps:

1. `booking_page_view`
2. `quote_started`
3. `checkout_started`
4. `payment_attempted`
5. `booking_confirmed`

Snapshot `value_summary` keys:

- `steps[]` with `stepKey`, `count`, `previousStepConversionPct`, and
  `overallConversionPct`
- `largestDropoffStep`
- `largestDropoffPct`
- `confirmedBookingCount`
- `pageViewCount`

If page-view/funnel events are not loaded, return `partial` with
`unavailableData.reason = source_unavailable` or `empty_result` rather than
backfilling page views from confirmed bookings.

### Revenue And ADR

Canonical revenue fields:

- `grossBookingAmount`: owner-visible gross booking amount in requested currency
- `roomRevenueAmount`: room-only gross amount used for ADR
- `addonAmount`: add-on amount, if available
- `taxFeeAmount`: taxes/fees, if available
- `currency`
- `includedBookingCount`
- `occupiedRoomNights`

Canonical ADR formula:

```text
average_daily_rate =
  roomRevenueAmount / occupiedRoomNights
```

`booking.gross_booking_revenue` is not payout, net revenue, or provider-settled
cash. Finance answers that need net revenue or payout status must use
finance-restricted metrics and `finance.summary.read`, not this MVP revenue
metric.

### Setup Completeness

Setup areas are the values already supported by
`intelligence.setup_completeness_snapshots`:

- `profile`
- `policy`
- `payment`
- `rates`
- `inventory`
- `images`
- `location`
- `marketplace`
- `agent_readiness`
- `overall`

Snapshot fields:

- `completion_status`
- `completeness_score`
- `missing_items[]`
- `blocking_items[]`
- `stale_items[]`
- `freshness_status`

Owner-facing answers may cite setup item labels, but model inputs must not
include private notes, raw provider payloads, credentials, emails, phone
numbers, or payment account identifiers.

## Tool Mapping

| Tool ID                      | Metrics returned                                                                              | Required scope              | Permission gates                                                         | Notes                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `get_booking_performance`    | `booking.direct_booking_share`, `booking.gross_booking_revenue`, `booking.average_daily_rate` | one linked booking property | `intelligence.ask.read`, `booking.analytics.read`                        | Primary performance tool for "why did bookings/revenue/direct share change?"        |
| `get_booking_source_mix`     | `booking.booking_source_mix`, optionally `booking.direct_booking_share`                       | one linked booking property | `intelligence.ask.read`, `booking.analytics.read`                        | Returns source buckets and comparisons; no cross-tenant benchmarking.               |
| `get_conversion_funnel`      | `booking.conversion_funnel`                                                                   | one linked booking property | `intelligence.ask.read`, `booking.analytics.read`                        | Returns `partial` until page-view/funnel events are present and fresh.              |
| `get_setup_gaps`             | `hotel_catalog.setup_completeness_score` plus setup-area snapshots                            | one linked property         | `intelligence.ask.read` and either `booking.settings.read` or `pms.read` | Returns missing/blocking/stale setup items.                                         |
| `get_hotel_settings_summary` | `hotel_catalog.setup_completeness_score` plus owner-safe public/setup settings                | one linked property         | `intelligence.ask.read` and either `booking.settings.read` or `pms.read` | Provides context for recommendations; does not expose credentials or private notes. |

## Unavailable And Quality Rules

Evidence tools must map source conditions to evidence-contract states:

| Condition                                                                        | Tool status      | Unavailable reason or quality                              |
| -------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| No selected organization or property                                             | `invalid_scope`  | `missing_scope`                                            |
| Property is not linked to selected organization                                  | `not_authorized` | `not_linked_resource`                                      |
| Missing permission                                                               | `not_authorized` | `missing_permission`                                       |
| Snapshot exists but is older than SLO                                            | `partial`        | `quality = stale`, `unavailableData.reason = stale_source` |
| Authorized query returns no rows                                                 | `unavailable`    | `empty_result`                                             |
| Funnel requires page-view events that are not loaded                             | `partial`        | `source_unavailable`                                       |
| Metric is outside this MVP catalog                                               | `unavailable`    | `source_not_in_catalog`                                    |
| Requested answer requires competitor, review, event, weather, or OTA parity data | `unavailable`    | `external_data_needed`                                     |
| Answer would require restricted guest/staff/payment data in the model prompt     | `unavailable`    | `pii_restricted`                                           |

## Fixture Expectations

VAY-746 should add or update target fixtures so each catalog metric has at least
one authorized evidence path and one unavailable/partial path.

Minimum fixture rows:

| Metric key                               | Expected fixture value summary                                                                                                                 | Expected evidence reference                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `booking.direct_booking_share`           | `directBookingCount = 30`, `includedBookingCount = 48`, `directSharePct = 62.5`, previous-period comparison present                            | `toolId = get_booking_performance`, `sourceOwner = booking`, `sourceView = direct_booking_summary_read_model`, `quality = complete`, `sampleSize = 48` |
| `booking.booking_source_mix`             | `sourceBuckets` contains at least `direct` and `partner`, bucket shares sum to 100 excluding rounding, `unknown` bucket is 0 for complete case | `toolId = get_booking_source_mix`, `metricKey = booking.booking_source_mix`, `quality = complete`                                                      |
| `booking.conversion_funnel`              | `steps` includes all five canonical steps, `largestDropoffStep` is present, and a second fixture marks page views unavailable                  | `toolId = get_conversion_funnel`, complete case uses `quality = complete`; missing page-view case returns `partial` with `source_unavailable`          |
| `booking.gross_booking_revenue`          | `grossBookingAmount = 18400`, `currency = EUR`, `includedBookingCount = 12`, previous-period comparison present                                | `toolId = get_booking_performance`, `metricKey = booking.gross_booking_revenue`, `quality = complete`                                                  |
| `booking.average_daily_rate`             | `roomRevenueAmount = 16800`, `occupiedRoomNights = 42`, `averageDailyRate = 400`, `currency = EUR`                                             | `toolId = get_booking_performance`, `metricKey = booking.average_daily_rate`, `quality = complete` or `estimated` when room nights are inferred        |
| `hotel_catalog.setup_completeness_score` | overall complete score `100`, payment area incomplete score `70`, blocking item `online_payment`, missing item `deposit_policy`                | `toolId = get_setup_gaps`, `sourceOwner = intelligence` or `hotel_catalog`, `quality = complete` for overall and `partial` for incomplete area         |

Fixture safety assertions:

- no guest email, phone, full name, room number, payment provider ID, payout
  account, private note, raw SQL, or raw provider payload appears in
  `value_summary`, filters, setup items, evidence references, answer blocks, or
  audit rows;
- denied cross-tenant requests expose no sample size, aggregate ID, or metric
  value for the unauthorized property;
- external enrichment questions return `external_data_needed` and do not create
  fake competitor, event, review, weather, or OTA parity metrics.

## Implementation Handoff

VAY-746 should register read-only evidence tools against this catalog. It should
not add model-authored formulas, write-capable tools, external enrichment, or
finance-restricted metrics unless a separate ticket defines those metrics and
permissions.

The first implementation can use `intelligence.metric_snapshot_runs` and
`intelligence.setup_completeness_snapshots` as the stable evidence source even
when snapshot generation is still fixture-backed. Runtime tools should return
`partial` or `unavailable` rather than calculating uncataloged metrics ad hoc.
