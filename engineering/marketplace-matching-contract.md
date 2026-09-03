# Marketplace matching contract

Contract version: `marketplace-matching-contract.v2`.

Decision inputs:

- [VAY-1404 matching recommendation](https://linear.app/vayadacom/document/marketplace-hotel-creator-matching-recommendation-vay-1404-36658c2c005e)
- [VAY-1406 production coverage audit](https://linear.app/vayadacom/document/production-marketplace-matching-signal-coverage-audit-vay-1406-a659eb8a0257)
- [VAY-1442 creator preference vocabulary and analytics decision](https://linear.app/vayadacom/issue/VAY-1442/define-creator-preference-vocabulary-and-save-analytics-contract)
- [VAY-1445 matching event storage and retention decision](https://linear.app/vayadacom/issue/VAY-1445/define-matching-event-storage-and-retention-policy)

This is the source of truth for Marketplace eligibility, two-sided scoring,
explanations, measurement, and rollout. It defines a rules-based service
contract, not a learned or AI ranking model.

Version 2 approves the first-party measurement boundary, qualified-impression
semantics, event deduplication and attribution windows, rating treatment, and
retention/privacy rules. It does not approve production ranking weights,
thresholds, or rollout cohorts.

VAY-1445 records the requester's human product/privacy approval for these
measurement decisions on 2026-09-03. Implementation remains gated on the
notice, deletion/export path, and access controls defined below.

## Current release posture

VAY-1406 found no eligible creators, verified/public offers, provider
connections, matching preferences, or outcomes on 2026-09-01. Therefore no
production weights or thresholds are approved, personalized ordering and
messages stay off, VAY-1418/VAY-1419 must provide creator activation, and the
readiness gates below must pass. These formulas are deterministic, but only a
fully reviewed policy is executable; drafts are for offline evaluation.

## Definitions and identity

A **pair** is exactly one target `creatorProfileId` and one target `offerId`.
The offer determines the hotel property and hotel organization. Source-system
IDs are provenance only and never identify a pair.

- **Eligible pair:** every mandatory rule evaluates to `pass`.
- **Mutually interested pair:** an application or invitation receives a
  positive response and enters `negotiating` or `accepted`.
- **Accepted match:** both sides approve the same frozen collaboration terms
  and the collaboration enters `accepted`.
- **Operationally completed match:** the accepted collaboration enters
  `completed` and every agreed deliverable is completed or approved.
- **Successful match:** an operationally completed match has no unresolved
  cancellation, dispute, block, report, or policy violation and both parties
  record a satisfactory outcome.

If reciprocal satisfaction has not been collected, success is `unknown`, not
`false`. Current hotel-authored creator ratings alone cannot establish a
successful match.

Every evaluation has an immutable `evaluationId`, `evaluatedAt`,
`contractVersion`, and `policyVersion`. Changing a weight, threshold, signal,
freshness rule, reason-code meaning, or tie rule requires a new `policyVersion`.
Historical events retain the version that produced them.

## Evidence states

Every input is represented as one of:

| State            | Meaning                                                                  | Matching behavior                                               |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `known`          | Valid value from an allowed source within its freshness rule.            | May filter, score, or explain.                                  |
| `unknown`        | No value was supplied or collected.                                      | Never coerced to zero, false, or mismatch.                      |
| `stale`          | A value exists but is older than its allowed freshness.                  | Treated as unavailable for filtering, scoring, and explanation. |
| `unavailable`    | Consent, provider capability, privacy threshold, or policy prevents use. | Excluded without penalizing either party.                       |
| `not_applicable` | The rule does not apply to this pair.                                    | Passes or is omitted as the rule specifies.                     |

Declared profile, offer, and preference values remain usable until changed or
the owning record becomes inactive. Provider-derived metrics are `known` only
when the connection is active, the field is in `imported_fields`, consent still
applies, and the successful snapshot is at most 30 days old. No fallback may
present self-declared platform totals as provider-verified evidence.

## Creator preference vocabulary

The first creator-facing matching-preference UI uses this content-category
vocabulary. Stored codes are stable; changing or removing a code requires a
reviewed contract change.

| Stored code          | Creator-facing label |
| -------------------- | -------------------- |
| `travel`             | Travel               |
| `lifestyle`          | Lifestyle            |
| `food_drink`         | Food & drink         |
| `wellness_fitness`   | Wellness & fitness   |
| `adventure_outdoors` | Adventure & outdoors |
| `family`             | Family travel        |
| `luxury`             | Luxury               |
| `fashion_beauty`     | Fashion & beauty     |
| `business_events`    | Business & events    |
| `other`              | Other                |

Creator deliverable preferences reuse the hotel collaboration vocabulary:
`post`, `story`, `short_form_video`, `long_form_video`, `photography`, and
`other`. Compensation types and collaboration goals remain the closed sets in
`marketplace-creator-matching-preferences.v1`.

The UI must keep `unknown` (not answered), explicit `no_preference`, and a
nonempty selected set distinct. An existing stored code outside the current UI
vocabulary is shown as an existing custom preference and preserved until the
creator explicitly removes it. Saving another field must never silently erase
such a value.

## Eligibility

Eligibility is evaluated before scoring and returns:

```ts
type MatchEligibility = {
  status: "eligible" | "ineligible" | "not_evaluable";
  ruleResults: {
    ruleCode: MatchEligibilityRuleCode;
    outcome: "pass" | "conflict" | "unknown";
  }[];
};
```

`conflict` means an explicit mandatory mismatch and produces `ineligible`.
`unknown` means a mandatory rule lacks trusted inputs and produces
`not_evaluable`. Only all-pass pairs are `eligible`; APIs must keep
`not_evaluable` distinct so operators can fix missing data.

| Rule code                        | Mandatory rule and required inputs                                                                                                                                                            | Unknown or stale behavior                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participant_eligible`           | Creator is `active` and complete; hotel profile is `verified` and complete; offer is `verified`, public, and currently available; organizations, resource links, and entitlements are active. | Missing state fails closed as `unknown`. An explicit inactive, suspended, rejected, archived, private, or expired state is `conflict`.                                                          |
| `platform_deliverable_supported` | Every mandatory `(platform, deliverableType)` tuple is supported by the creator; an explicitly alternative group requires at least one matching tuple.                                        | Missing deliverables, tuple requirement mode, or creator platforms/capabilities is `unknown`; a known unsupported mandatory tuple or disjoint alternative group is `conflict`.                  |
| `follower_requirement`           | When a positive minimum is explicitly required, the fresh provider-verified follower count on the same platform meets it. No requirement is `not_applicable`.                                 | Missing, stale, unverified, or wrong-platform evidence is `unknown`, never zero.                                                                                                                |
| `creator_type_required`          | When creator types are explicitly required, the declared creator type is included. An empty requirement is `not_applicable`.                                                                  | Missing creator type is `unknown`; a known non-member is `conflict`.                                                                                                                            |
| `destination_dates_required`     | A requirement explicitly marked mandatory has compatible canonical destination and date/availability ranges on both sides.                                                                    | Until required/preferred flags and structured creator availability exist, this rule is `not_applicable`. Once enabled, a missing mandatory input is `unknown`; known non-overlap is `conflict`. |
| `compensation_required`          | At least one offered compensation type is accepted by the creator when the creator preference contract is enabled.                                                                            | Before explicit creator preferences exist, the rule is `unknown` and the pair is not ready for matching. Known disjoint sets are `conflict`.                                                    |
| `deliverable_required`           | Every mandatory deliverable type is accepted by the creator when the creator preference contract is enabled.                                                                                  | Before explicit creator preferences exist, the rule is `unknown`; known rejection of a mandatory type is `conflict`.                                                                            |
| `audience_requirement`           | An audience criterion may be mandatory only when marked required, approved by product/privacy review, consented, and backed by a fresh provider field.                                        | Missing/stale/unavailable evidence is `unknown`. Audience age and gender rules are disabled for the MVP unless separately approved.                                                             |
| `relationship_available`         | No active collaboration for the pair and no suspension, block, policy restriction, or application-capacity stop.                                                                              | A failed or incomplete lookup is `unknown`; an explicit restriction is `conflict`.                                                                                                              |

Aggregate rules in the table order, with `conflict` taking precedence over
`unknown`, and `unknown` over all-pass. For a mandatory rule, evidence states
`unknown`, `stale`, and `unavailable` all produce rule outcome `unknown`;
`not_applicable` passes only where the table explicitly allows it. Optional
signals are omitted instead.

Optional preferences never exclude a pair. An offer cannot compensate for a
mandatory conflict with a high score elsewhere.

## Two-sided score

An immutable policy manifest defines `policyVersion`, lifecycle
(`draft | shadow | active | retired`), enabled signal codes, side/category
membership, integer signal and category weights, evaluator configuration,
allowed sources, freshness, confidence/ranking gates, rotation, exploration,
attribution, and impression qualification/deduplication. Signal codes are
unique. In an executable `shadow` or `active` policy, enabled weights sum to
`10000` inside each category and enabled category weights sum to `10000` on
each side. Drafts may leave values disabled or unset; executable policies may
not.

The evaluator registry is closed and deterministic:

| Evaluator        | Exact score in basis points                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact_match`    | `10000` when the two known canonical values are equal, otherwise `0`.                                                                                                      |
| `set_coverage`   | `roundHalfUp(10000 * intersectionCount / preferredCount)` for a nonempty policy-named preferred set.                                                                       |
| `range_overlap`  | `roundHalfUp(10000 * overlapUnits / subjectRangeUnits)`; no overlap is `0`. The policy names the subject side, unit, and inclusive or half-open boundary convention.       |
| `bounded_linear` | Require `upper > lower`, clamp the value to the bounds, then calculate `roundHalfUp(10000 * (value - lower) / (upper - lower))`; descending uses `10000 - ascendingScore`. |
| `ordinal_map`    | Look up a canonical enum in an immutable, exhaustive `value -> scoreBps` policy map.                                                                                       |

No free-form evaluator is allowed. `roundHalfUp(n/d)` for non-negative integers
and `d > 0` is `floor((2 * n + d) / (2 * d))` using arbitrary-precision integer
arithmetic.

An enabled signal produces an integer `scoreBps` from `0` to `10000` and an
evidence state. A signal that is not `known` is omitted from the numerator and
denominator; it does not contribute zero.

```text
weightedScore = roundHalfUp(sum(scoreBps * weight) / sum(known weights))
categoryCoverageBps = roundHalfUp(10000 * known signal weights / enabled signal weights)
sideCoverageBps = roundHalfUp(sum(category weight * categoryCoverageBps) / 10000)
```

First calculate each category from its enabled signals, then each side from its
enabled categories. An enabled category with no known signals is `unknown`;
its coverage is zero. Category coverage is propagated into side coverage rather
than counting a partially known category at full weight.

The first policy family uses the approved category hypotheses below. Their
weights are starting values for offline evaluation, not approved production
weights.

| Hotel-fit category                     | Draft weight | Evidence intended after collection                                             |
| -------------------------------------- | -----------: | ------------------------------------------------------------------------------ |
| Target-audience fit                    |           30 | Fresh, consented audience evidence against preferred campaign markets.         |
| Content, platform, and deliverable fit |           25 | Structured required/preferred brief and creator capability.                    |
| Campaign-goal and portfolio fit        |           20 | Campaign goal, creator work mode, and structured portfolio evidence.           |
| Timing and location fit                |           15 | Canonical property destination plus explicit creator availability/trip intent. |
| Reliability and trust                  |           10 | Sufficient completed, reciprocal outcomes; disabled during cold start.         |

| Creator-fit category                | Draft weight | Evidence intended after collection                                       |
| ----------------------------------- | -----------: | ------------------------------------------------------------------------ |
| Destination and date fit            |           30 | Explicit creator destination/date preference against offer availability. |
| Compensation and expected-value fit |           25 | Accepted compensation types and structured value/effort expectations.    |
| Content and platform preference fit |           20 | Creator content/platform preferences against mandatory deliverables.     |
| Brief, effort, and usage-right fit  |           15 | Structured terms, effort, revisions, and usage rights.                   |
| Hotel and collaboration trust       |           10 | Reciprocal hotel/experience outcomes; disabled during cold start.        |

For an eligible pair:

```text
pairFitBps = min(hotelFitBps, creatorFitBps)
tieFitBps  = roundHalfUp((hotelFitBps + creatorFitBps) / 2)
```

If either side has no known enabled category, `pairFitBps` is unavailable and
confidence is `insufficient`. Missing history never lowers a score. Reliability
categories remain disabled until VAY-1415 approves a minimum outcome sample.

## Confidence and ordering

Confidence is separate from fit:

- `insufficient`: the pair is not eligible or either side score is unavailable;
- `low`: the pair is eligible and both side scores exist, but the versioned
  medium-confidence evidence gate is not met;
- `medium`: required declared inputs exist and the policy's approved minimum
  coverage and freshness gates pass;
- `high`: medium passes, all enabled provider-derived inputs are fresh and
  verified, and the approved reciprocal-history sample gate passes.

The exact medium coverage and reciprocal-history thresholds are unresolved.
They must be present in an approved policy version; a disabled history signal
cannot manufacture `high` confidence.

For v1, the **ranked pool** contains only eligible pairs with both side scores
and every enabled signal `known` on both sides, checked from exact signal states
before coverage rounding. Other eligible pairs enter the **exploration pool**,
ordered only by the rotation key. Removing or revoking an enabled input
therefore removes a pair from normal ranking rather than improving it. The
policy declares fixed exploration positions; if none are approved, the
exploration pool follows the ranked pool and is not described as personalized.
A lower-coverage ranked pool requires a new contract version.

The ranked pool is ordered by:

1. `pairFitBps` descending;
2. `tieFitBps` descending;
3. exposure-rotation key ascending;
4. `offerId` ascending as the final invariant.

Confidence does not silently change fit. Exploration positions are mandatory
executable-policy values and remain an unresolved rollout decision.

The rotation key is the hexadecimal SHA-256 of this canonical UTF-8 string:

```text
<policyVersion>|<UTC rotation epoch>|creator:<creatorProfileId>|<offerId>
```

The policy stores a positive integer duration in milliseconds. The service
encodes the epoch as base-10 ASCII
`floor(unixMilliseconds(evaluatedAt) / durationMilliseconds)`; callers cannot
supply it. This makes ties reproducible while rotating exposure over time. The
initial duration and exploration positions remain unresolved rollout decisions.

## Explanation reasons

An explanation reason may be emitted only when its evidence is `known`, the
signal positively contributed to both-side fit or a passed eligibility rule,
and the copy does not reveal private inputs.

| Stable code                | User-safe meaning                                                  | Must not reveal                                               |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `destination_match`        | The creator's selected destination matches the property.           | Private travel notes or precise location.                     |
| `date_overlap`             | Declared travel/availability dates overlap.                        | Hidden blackout dates or an unselected trip.                  |
| `platform_match`           | Requested content uses a platform on the creator profile.          | Handles or private account data.                              |
| `deliverable_match`        | Requested content type matches a creator preference/capability.    | Private minimums or internal scoring.                         |
| `compensation_match`       | An offered compensation type matches a creator preference.         | Private minimum value or negotiation terms.                   |
| `audience_market_match`    | A verified audience is relevant to a target market.                | Percentages, small cohorts, age/gender detail, or thresholds. |
| `campaign_goal_match`      | The creator's selected work mode fits the campaign goal.           | Internal labels not shown in the brief.                       |
| `brief_fit`                | Effort, usage rights, and revision expectations match preferences. | Private acceptance limits.                                    |
| `current_verified_metrics` | Current provider-authorized evidence supports the recommendation.  | Raw metrics unless already public by separate policy.         |
| `positive_outcome_history` | Sufficient completed outcomes support trust.                       | Ratings, disputes, or another party's private feedback.       |

For explanation ordering, a signal's exact integer contribution is
`scoreBps * signalWeight * categoryWeight`; duplicate reason codes keep their
largest contribution. Select at most three reasons by contribution descending,
then the table order above. Do not show a match percentage. Product copy is
rendered from stable codes and public fields, not free-form model output.

## Service and API boundary

The Marketplace domain owns `evaluatePair(creatorProfileId, offerId,
policyVersion, evaluatedAt)` and `rankCreatorOffers(creatorProfileId, offerIds,
policyVersion, evaluatedAt)`. Both return immutable
`MarketplaceMatchEvaluation` values; ranking derives its epoch internally.

The service reads Marketplace-owned facts and typed hotel-catalog projections.
It must not introduce raw cross-product database access. Routes authorize the
viewer before calling it. The creator discovery response may expose confidence
and explanation codes, but internal side scores, weights, thresholds, private
preferences, and evidence values stay server-side.

Every evaluation returns its eligibility result, side/pair score availability,
coverage, confidence, reason codes, and input freshness summary. It never
mutates profiles, offers, collaborations, or preferences.

## Measurement storage boundary

`platform.domain_events` is the canonical append-only envelope for matching
event identity, type, version, occurrence time, correlation, and idempotency.
A normalized Marketplace projection is written in the same transaction and is
the query boundary for pair identity, policy context, impression deduplication,
frozen attribution, monotonic revisions, retention, and reporting. It has a
one-to-one foreign key to its domain event. Neither store may contain a field
forbidden by the privacy rules below.

Normal application roles cannot update or delete either record. A privileged,
audited retention/privacy process is the only exception to append-only storage:
it may erase an expired or deletion-scoped event and its projection together.
The implementation must replace the current unconditional
`platform.domain_events` delete trigger with a narrow exception that permits
only the approved retention function to delete Marketplace matching events.
That function runs as a non-login, least-privilege owner through a
`SECURITY DEFINER` entry point with a fixed search path and execution revoked
from general application roles; only the dedicated retention executor may call
it. It may select only `source_system = 'marketplace'` rows whose event type is
in the `marketplace.match.*` allowlist and whose expiry or approved subject
scope is verified from durable retention/deletion records. It cannot update
events, accept arbitrary SQL predicates, or bypass another product's
append-only protection.

Matching measurement events must not create outbox, job, webhook, dead-letter,
or per-event product-audit rows that retain a foreign key to the domain event.
The retention transaction selects the approved scope, deletes the Marketplace
projection first, deletes matching instrumentation idempotency records, and
then deletes the domain event. It fails closed if an unexpected dependent row
exists. As the final statement in the same transaction, it writes one summary
audit fact containing the retention policy version, reason, execution time, and
row counts, but no erased pair, event, user, organization, property, offer, or
collaboration identifiers. Matching events do not use a third-party analytics
SDK or a separate product-analytics transport.

Raw matching events have no creator- or hotel-facing read route. Internal
aggregate reporting requires the dedicated
`marketplace.matching_metrics.read` permission; raw event access is restricted
to the measurement service and audited privacy/support operations.

## Event vocabulary and attribution

All events use the jobs/events envelope and include `eventId`, `eventType`,
`occurredAt`, `creatorProfileId`, `offerId`, `contractVersion`, and
`correlationId`. `evaluated` requires `policyVersion`, `evaluationId`, and
`evaluationMode: shadow | active`. `impression` additionally requires
`impressionId`, recommendation session, and
`presentationMode: ranked | exploration`. Later action/outcome events use a
tagged attribution union. `recommended` requires those immutable matching IDs
and presentation mode. `organic` sets `policyVersion`, `evaluationId`,
`impressionId`, `recommendationSessionId`, and `presentationMode` to null; it
must not inherit the current policy or invent a presentation mode.

| Event type                                   | Meaning                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `marketplace.match.evaluated.v1`             | One pair was evaluated; includes eligibility codes, fit/coverage, confidence, and reason codes. |
| `marketplace.match.impression.v1`            | An eligible recommendation was actually presented; includes rank and presentation mode.         |
| `marketplace.match.saved.v1`                 | The creator saved an attributed offer.                                                          |
| `marketplace.match.dismissed.v1`             | The creator dismissed an attributed offer with an optional structured reason.                   |
| `marketplace.match.application_submitted.v1` | The creator created a proposal for the pair.                                                    |
| `marketplace.match.invitation_sent.v1`       | The hotel invited the creator for the pair.                                                     |
| `marketplace.match.response_recorded.v1`     | The recipient responded `positive` or `declined`.                                               |
| `marketplace.match.accepted.v1`              | Both parties approved the frozen terms.                                                         |
| `marketplace.match.completed.v1`             | Collaboration and agreed deliverables reached operational completion.                           |
| `marketplace.match.rating_recorded.v1`       | A current one-sided 1–5 collaboration rating was first recorded.                                |
| `marketplace.match.satisfaction_recorded.v1` | One side recorded `satisfied`, `neutral`, or `dissatisfied`.                                    |
| `marketplace.match.guardrail_recorded.v1`    | A versioned cancellation, no-show, dispute, block, report, or policy-violation state changed.   |

Shadow evaluation emits `evaluated` only. It must not emit an `impression` or
claim that the computed order was presented.

### Authoritative producers and current capability

The producer is the same transaction that persists the authoritative fact. It
uses server-owned timestamps; a client timestamp is never a lifecycle or
attribution clock. A producer must be absent where the product has no
authoritative transition.

| Event                   | Authoritative source fact and event identity                                                                                                                                                                                                          | Current v1 capability                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluated`             | The matching service persists one immutable evaluation. Source ID is `evaluationId`, revision `1`, and `occurredAt` is server-owned `evaluatedAt`.                                                                                                    | Deferred to the evaluator implementation; shadow mode never produces an impression.                                                                         |
| `impression`            | The authorized impression route accepts an issued session/pair binding. Source ID is `impressionId`, revision `1`, and `occurredAt` is the server acceptance time.                                                                                    | Deferred to the impression implementation.                                                                                                                  |
| `saved`, `dismissed`    | A persisted creator save/dismiss transition, identified by its source record and monotonic revision.                                                                                                                                                  | No authoritative source exists; do not emit.                                                                                                                |
| `application_submitted` | `POST /api/marketplace/collaborations` creates a creator-initiated collaboration. Source ID is the collaboration ID, revision `1`, and time is `created_at`.                                                                                          | Available once event persistence is added.                                                                                                                  |
| `invitation_sent`       | The same route creates a hotel-initiated collaboration with the collaboration ID, revision `1`, and `created_at`.                                                                                                                                     | Available, but organic in v1 because there is no hotel recommendation surface.                                                                              |
| `response_recorded`     | `POST .../respond` changes a pending collaboration to `negotiating` for a positive response or `declined` for a decline. Source ID is the collaboration ID plus `response`, revision `1`, and time is `responded_at`.                                 | Available once event persistence is added. A positive response is not acceptance.                                                                           |
| `accepted`              | `POST .../approve` changes the collaboration to `accepted` only when both sides have approved the current terms. Source ID is the collaboration ID plus `accepted`, revision `1`, and time is the later of `creator_agreed_at` and `hotel_agreed_at`. | Available once event persistence is added; the first one-sided approval emits nothing.                                                                      |
| `completed`             | A collaboration-level `completed` transition plus completed/approved agreed deliverables.                                                                                                                                                             | No authoritative API transition exists; deliverable toggles alone do not emit completion.                                                                   |
| `rating_recorded`       | The first inserted `creator_ratings` row. Source ID is `ratingId`, revision `1`, and time is `created_at`.                                                                                                                                            | Available once the producer can distinguish the first insert. The current conflict path preserves the first value, so later calls emit no revision.         |
| `satisfaction_recorded` | A persisted response from each side with a monotonic revision.                                                                                                                                                                                        | No authoritative source exists; do not infer it from a rating.                                                                                              |
| `guardrail_recorded`    | `POST .../cancel` changes a collaboration to `cancelled`. Source ID is the collaboration ID plus `cancellation`, revision `1`, state `opened`, and time is `cancelled_at`.                                                                            | Cancellation is available once event persistence is added. No current producer exists for resolution, no-show, dispute, block, report, or policy violation. |

Lifecycle event keys are derived from the named source ID, transition, and
revision, and command replay returns the already persisted event. A later
contract may introduce revisions only after the source model persists them;
calling the current endpoint again cannot synthesize a revision.

Saving creator matching preferences does not emit a product analytics event in
the first UI release. Marketplace has no approved product-event transport, and
a preference update is an input rather than a matching outcome. The VAY-1412
implementation follow-ups own event contracts, consent, retention, storage, and
reporting; clients must not add a one-off analytics endpoint or reuse Booking
Web tracking.

`rating_recorded` requires `ratingId`, monotonic `revision`, `respondentSide`,
`subjectSide`, and an integer score from 1 to 5. The current hotel-authored
creator rating emits revision `1` only for the first persisted value; its
existing conflict behavior does not revise that value. The rating is supporting
evidence and never implies a satisfaction outcome. `satisfaction_recorded`
requires `feedbackId`, monotonic `revision`,
`respondentSide: creator | hotel`, and outcome. Its latest revision per side is
authoritative. `guardrail_recorded` requires `guardrailId`, monotonic `revision`,
`state: opened | resolved`, and one stable code: `cancellation`, `no_show`,
`dispute`, `block`, `report`, or `policy_violation`. Its latest revision is
authoritative. A successful-match reducer requires latest creator and hotel
outcomes both `satisfied` and no guardrail whose latest state is `opened`.
Operational completion or a unilateral rating without both satisfaction
responses leaves success `unknown`, not `false` or `true`. Rating, satisfaction,
and guardrail events are emitted only from authoritative product transitions;
missing product capabilities do not create synthetic outcomes.

A qualified impression is an eligible, server-issued recommendation shown to
the authenticated creator with at least 50% of its card visible for one
continuous second while the document is visible. The browser reports only the
visibility qualification and server-issued recommendation session reference.
The server resolves the viewer, pair, evaluation, policy, rank, slot, and mode,
and stamps the accepted occurrence time. Client-supplied copies of those facts
are ignored or rejected.

The server issues an opaque recommendation session for one authenticated
creator-discovery query. The session is bound to the viewer, creator profile,
surface, policy version, and a canonical fingerprint of filters, search, and
sort. Its fixed lifetime is 30 minutes from server-issued `issuedAt`; pagination
reuses the session without extending it and appends the exact issued
`offerId`/`evaluationId`/rank/slot bindings. A browser refresh or any
filter/search/sort change starts a new session. An impression is accepted only
for an exact binding issued in that unexpired session. Expired sessions and
pair/evaluation substitutions are rejected without an event; an exact replay
of an already completed idempotent request returns its first result even after
session expiry.

The impression deduplication ID is the SHA-256 of:

```text
<policyVersion>|creator_offer_discovery|creator:<creatorProfileId>|<offerId>|<UTC dedup epoch>
```

`creator_offer_discovery` is the only v1 surface code. The deduplication duration
is `86400000` milliseconds. The server derives the UTC epoch as base-10 ASCII
`floor(unixMilliseconds(occurredAt) / 86400000)`. Re-renders, pagination,
virtualization, or repeated sessions within that epoch reuse the same
impression; rank, session, and slot remain immutable event context, not
identity. Exact retries replay the first result. Reuse of an idempotency key
with a different request fingerprint is rejected.

Applications and invitations carry a server-verified `impressionId` when the
action came from a recommendation. A valid direct reference for the same pair,
viewer, and surface wins attribution only when collaboration `created_at` is at
or after the impression's server-stamped `occurredAt` and no more than 30 days
(`2592000000` milliseconds) later. The action inherits that impression's policy
version; a direct reference never bypasses the window. If the direct reference
is absent or invalid, the server searches qualified impressions for the same
pair, viewer, and surface across policy versions within the same window, ordered
by `occurredAt` descending and then `impressionId` ascending. It freezes the
winning impression's policy and matching IDs; if none exists, the action is
`organic`. Hotel-originated invitations are always organic in v1 because
`creator_offer_discovery` is creator-side only.

Attribution is frozen in the collaboration-creation transaction and copied to
later lifecycle events. All comparisons use server timestamps; late client
reports cannot backdate an impression, and an impression recorded after
creation never changes attribution. The frozen snapshot is stored independently
of the impression row, so later outcome events do not require a retained raw
impression. Purging an impression prevents new attribution through it but does
not rewrite attribution already frozen on an existing collaboration. Command
and event idempotency must prevent retries from creating duplicate funnel
outcomes.

## Metrics and guardrails

A recommendation denominator is a deduplicated, user-visible, eligible
`impression`, never a shadow evaluation or `not_evaluable` candidate.

- **Mutual interest rate:** pairs with `response_recorded = positive` per 100
  eligible recommendation impressions.
- **Accepted match rate:** pairs with `accepted` per 100
  eligible recommendation impressions.
- **Completed satisfactory rate:** successful matches per 100 eligible
  recommendation impressions. Unknown reciprocal satisfaction is reported
  separately and excluded from the numerator, not treated as failure.
- **Time to match:** median time from the first attributed eligible impression
  to `accepted`.
- **Supporting funnel:** save, dismiss, application/invitation, response,
  accepted, operational completion, and satisfaction rates.

Every rollout report also segments or monitors:

- `not_evaluable` and empty-result rates;
- unanswered applications/invitations and hotel review-capacity overload;
- exposure concentration by hotel, offer, and creator;
- exposure difference between new and established participants;
- low-confidence and stale-evidence exposure;
- cancellation, no-show, dispute, block, report, and policy-violation rates;
- negative dismiss reasons and creator/hotel dissatisfaction.

Guardrail thresholds and experiment sample sizes are not set by this contract;
VAY-1415 must approve them before a limited cohort.

## Privacy, consent, and retention

- Declared preferences are used only for Marketplace matching and must have
  user-facing edit/delete controls.
- Provider data is used only while the connection and applicable consent are
  active. Revocation makes the evidence unavailable for future evaluations.
- Audience country may be evaluated only from consented, provider-imported
  aggregates. Audience age/gender targeting is disabled in the MVP pending a
  separate product/privacy decision.
- Personal protected traits must not be used to negatively select creators.
- Match events may store internal resource IDs, integer scores/coverage,
  freshness classes, rule/reason codes, rank, and policy versions.
- Match events must not store raw audience distributions, provider payloads,
  handles, contact details, profile/portfolio text, messages, travel notes,
  private preference values, content URLs, or private thresholds.
- User-facing explanations never expose another party's private data.
- Matching measurement is first-party operational product measurement disclosed
  in the privacy notice. It is not marketing communication and does not depend
  on the analytics-cookie toggle. Collection remains feature-flagged off until
  the notice and the retention/delete/export implementation are reviewed.
- Provider-derived evidence may influence an evaluation only while the
  connection, imported-field authorization, applicable consent, and freshness
  are active. Events keep only approved derived classes and codes.
- Identifiable raw matching events and projections expire at
  `recordedAt + 18 calendar months`, calculated in UTC. Client occurrence time
  cannot extend retention. De-identified cohort aggregates expire at the end of
  the aggregate's UTC period plus 36 calendar months.
- A retained aggregate contains no pair, event, impression, session, user,
  creator profile, organization, property, offer, collaboration, or stable
  pseudonymous identifier. Allowed dimensions are UTC week/month,
  `policyVersion`, surface, presentation mode, confidence band, new/established
  participant band, country-or-larger geography, platform, offer type, and
  compensation type. A row may use at most two cohort dimensions in addition to
  time and policy, and is retained or reported only when it contains at least
  10 distinct creators and 10 distinct offers; smaller cells are suppressed or
  merged into `other`. Percentages are not reported when their numerator or
  denominator is suppressed.
- The normalized projection records the subject links needed for deletion:
  actor user, creator profile and organization, hotel organization, property,
  offer, and collaboration where applicable. Deleting a creator profile erases
  every raw event/projection for that profile. Before identity membership or
  `creator_profiles.owner_user_id` is removed, the deletion service snapshots
  the user's creator scope. If the user owns a creator profile at that point,
  every profile-linked raw fact is erased even if the profile is transferred or
  its owner foreign key later becomes null. For a non-owner creator-workspace
  member, only facts where that user is the actor are erased; workspace-owned
  system or other-member facts remain. Deleting a hotel organization, property,
  or offer erases its directly linked raw facts. Deleting an individual hotel
  member likewise erases raw events where that user is the actor but does not
  erase organization-owned facts created by another actor or the system.
  Subject-authored rating or satisfaction facts are erased with that subject.
- An approved deletion request executes the privileged purge graph defined in
  the storage boundary. A documented legal/security obligation may retain only
  a narrower audit fact that irreversibly removes all joinable subject and pair
  identifiers. Truly de-identified aggregates are not rewritten for a later
  account deletion because they cannot be linked back to the subject. A user
  export includes that user's declared matching feedback and satisfaction
  responses, but excludes internal scores, private other-party data, and
  security/audit-only metadata.
- Raw access is least-privilege and audited. Retention cleanup, deletion,
  pseudonymization, and export actions are audited without retaining the erased
  identifiers in the audit payload.

## Rollout gates and flags

All flags default off and have an immediate kill switch:

- `marketplace_matching_shadow_v1`: compute and store evaluations while
  preserving the current order;
- `marketplace_matching_creator_ordering_v1`: order creator offer discovery for
  an allowlisted cohort;
- `marketplace_matching_explanations_v1`: show reasons only with enabled
  personalized ordering.

Before shadow scoring:

1. Every pilot creator is active and complete, and every pilot hotel/offer is
   verified, public, and complete.
2. Every pilot offer has platform, compensation, deliverable, and availability;
   every pilot creator has a platform plus the matching preference fields.
3. Unknown handling, policy versioning, privacy filtering, and deduplicated
   instrumentation have contract tests.
4. Provider signals are disabled unless connection, consent, field import, and
   30-day freshness checks pass.
5. The matching measurement privacy notice, 18-month identifiable retention,
   36-month de-identified aggregate retention, and deletion/export paths are
   reviewed and operational.

Before user-visible ordering:

1. Re-audit the final post-migration pilot population and show non-zero eligible
   supply and demand in every selected cohort.
2. Human reviewers label a representative offline pair set.
3. Shadow results pass approved relevance, empty-result, concentration,
   freshness, and low-confidence gates.
4. Impression-to-outcome instrumentation is live and deduplicated.

Recommendation emails, proactive external messages, and Instagram delivery
remain disabled until on-product ordering is validated. Instagram delivery is
a separate feasibility and provider-approval question.

## Delivery scope

MVP includes required/preferred offer criteria, creator matching preferences,
creator-side server ordering, explanations, event instrumentation, and staged
evaluation. Later work may add hotel-side applicant ranking, reciprocal
reputation, content/booking attribution, saved-search alerts, semantic content
matching, and learned ranking after sufficient outcomes.

Automatic selection, opaque AI scores, scraped/private profile data,
pay-to-rank placement, cold Instagram outreach, and recommendation messages
before product validation are out of scope.

## Unresolved decisions

VAY-1415 or a later versioned policy decision must approve:

- production enabled signals, category/signal weights, and evaluator parameters;
- confidence coverage, history sample, and signal freshness thresholds other
  than the audited 30-day provider ceiling;
- rotation epoch and exploration positions;
- the user-facing reciprocal satisfaction capture and the minimum evidence
  sample for enabling an outcome-history signal;
- cohort definitions, experiment sample sizes, and guardrail thresholds;
- any audience targeting beyond consented country-level aggregates.
