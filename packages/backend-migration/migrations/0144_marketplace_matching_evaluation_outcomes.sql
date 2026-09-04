-- Migration: 0144_marketplace_matching_evaluation_outcomes
-- Owner: domain-marketplace; see VAY-1456, VAY-1458, engineering/marketplace-matching-contract.md
ALTER TABLE marketplace.matching_event_projections
  ADD COLUMN eligibility_status TEXT, ADD COLUMN eligibility_rule_outcomes TEXT[],
  ADD COLUMN hotel_fit_bps INTEGER, ADD COLUMN creator_fit_bps INTEGER,
  ADD COLUMN pair_fit_bps INTEGER, ADD COLUMN hotel_coverage_bps INTEGER,
  ADD COLUMN creator_coverage_bps INTEGER, ADD COLUMN confidence TEXT,
  ADD COLUMN reason_codes TEXT[], ADD COLUMN evidence_known_count INTEGER,
  ADD COLUMN evidence_unknown_count INTEGER, ADD COLUMN evidence_stale_count INTEGER,
  ADD COLUMN evidence_unavailable_count INTEGER, ADD COLUMN evidence_not_applicable_count INTEGER,
  ADD COLUMN respondent_side TEXT, ADD COLUMN subject_side TEXT,
  ADD COLUMN response_value TEXT, ADD COLUMN rating_score INTEGER,
  ADD COLUMN satisfaction_outcome TEXT, ADD COLUMN dismissal_reason_code TEXT,
  ADD COLUMN guardrail_state TEXT, ADD COLUMN guardrail_code TEXT,
  ADD CONSTRAINT chk_marketplace_matching_event_evaluation CHECK (COALESCE(
    (
      event_type = 'marketplace.match.evaluated.v1'
      AND cardinality(eligibility_rule_outcomes) = 9
      AND eligibility_rule_outcomes <@ ARRAY['pass', 'conflict', 'unknown']::TEXT[]
      AND array_position(eligibility_rule_outcomes, NULL) IS NULL
      AND eligibility_status = CASE
        WHEN array_position(eligibility_rule_outcomes, 'conflict') IS NOT NULL THEN 'ineligible'
        WHEN array_position(eligibility_rule_outcomes, 'unknown') IS NOT NULL THEN 'not_evaluable'
        ELSE 'eligible'
      END
      AND (hotel_fit_bps IS NULL OR hotel_fit_bps BETWEEN 0 AND 10000)
      AND (creator_fit_bps IS NULL OR creator_fit_bps BETWEEN 0 AND 10000)
      AND (pair_fit_bps IS NULL OR pair_fit_bps BETWEEN 0 AND 10000)
      AND hotel_coverage_bps BETWEEN 0 AND 10000
      AND creator_coverage_bps BETWEEN 0 AND 10000
      AND confidence IN ('insufficient', 'low', 'medium', 'high')
      AND cardinality(reason_codes) BETWEEN 0 AND 3
      AND reason_codes <@ ARRAY[
        'destination_match', 'date_overlap', 'platform_match', 'deliverable_match', 'compensation_match',
        'audience_market_match', 'campaign_goal_match', 'brief_fit', 'current_verified_metrics', 'positive_outcome_history'
      ]::TEXT[]
      AND array_position(reason_codes, NULL) IS NULL
      AND (cardinality(reason_codes) < 2 OR reason_codes[1] <> reason_codes[2])
      AND (cardinality(reason_codes) < 3 OR (reason_codes[1] <> reason_codes[3]
        AND reason_codes[2] <> reason_codes[3]))
      AND evidence_known_count >= 0 AND evidence_unknown_count >= 0
      AND evidence_stale_count >= 0 AND evidence_unavailable_count >= 0
      AND evidence_not_applicable_count >= 0
      AND (
        (
          eligibility_status <> 'eligible'
          AND num_nonnulls(hotel_fit_bps, creator_fit_bps, pair_fit_bps) = 0
          AND confidence = 'insufficient'
        ) OR (
          eligibility_status = 'eligible'
          AND (hotel_fit_bps IS NOT NULL OR hotel_coverage_bps = 0)
          AND (creator_fit_bps IS NOT NULL OR creator_coverage_bps = 0)
          AND pair_fit_bps IS NOT DISTINCT FROM CASE
            WHEN hotel_fit_bps IS NULL OR creator_fit_bps IS NULL THEN NULL
            ELSE LEAST(hotel_fit_bps, creator_fit_bps) END
          AND (
            (pair_fit_bps IS NULL AND confidence = 'insufficient')
            OR (pair_fit_bps IS NOT NULL AND confidence IN ('low', 'medium', 'high'))
          )
        )
      )
    ) OR (
      event_type <> 'marketplace.match.evaluated.v1'
      AND num_nonnulls(
        eligibility_status, eligibility_rule_outcomes, hotel_fit_bps, creator_fit_bps,
        pair_fit_bps, hotel_coverage_bps, creator_coverage_bps, confidence, reason_codes,
        evidence_known_count, evidence_unknown_count, evidence_stale_count,
        evidence_unavailable_count, evidence_not_applicable_count
      ) = 0
    ), FALSE
  )),
  ADD CONSTRAINT chk_marketplace_matching_event_outcome CHECK (COALESCE(
    (
      event_type = 'marketplace.match.dismissed.v1'
      AND source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND num_nonnulls(
        respondent_side, subject_side, response_value, rating_score,
        satisfaction_outcome, guardrail_state, guardrail_code
      ) = 0
      AND (
        dismissal_reason_code IS NULL OR dismissal_reason_code IN (
          'destination_not_suitable', 'dates_not_suitable', 'compensation_not_suitable',
          'deliverables_not_suitable', 'brief_not_suitable', 'not_interested', 'other'
        )
      )
    ) OR (
      event_type = 'marketplace.match.response_recorded.v1'
      AND respondent_side IN ('creator', 'hotel')
      AND response_value IN ('positive', 'declined')
      AND num_nonnulls(
        subject_side, rating_score, satisfaction_outcome,
        dismissal_reason_code, guardrail_state, guardrail_code
      ) = 0
    ) OR (
      event_type = 'marketplace.match.rating_recorded.v1'
      AND source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND respondent_side IN ('creator', 'hotel')
      AND subject_side IN ('creator', 'hotel')
      AND respondent_side <> subject_side
      AND rating_score BETWEEN 1 AND 5
      AND num_nonnulls(
        response_value, satisfaction_outcome, dismissal_reason_code,
        guardrail_state, guardrail_code
      ) = 0
    ) OR (
      event_type = 'marketplace.match.satisfaction_recorded.v1'
      AND source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND respondent_side IN ('creator', 'hotel')
      AND satisfaction_outcome IN ('satisfied', 'neutral', 'dissatisfied')
      AND num_nonnulls(
        subject_side, response_value, rating_score, dismissal_reason_code,
        guardrail_state, guardrail_code
      ) = 0
    ) OR (
      event_type = 'marketplace.match.guardrail_recorded.v1'
      AND source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND guardrail_state IN ('opened', 'resolved')
      AND guardrail_code IN (
        'cancellation', 'no_show', 'dispute', 'block', 'report', 'policy_violation'
      )
      AND num_nonnulls(
        respondent_side, subject_side, response_value, rating_score,
        satisfaction_outcome, dismissal_reason_code
      ) = 0
    ) OR (
      event_type NOT IN (
        'marketplace.match.dismissed.v1', 'marketplace.match.response_recorded.v1',
        'marketplace.match.rating_recorded.v1', 'marketplace.match.satisfaction_recorded.v1',
        'marketplace.match.guardrail_recorded.v1'
      )
      AND num_nonnulls(
        respondent_side, subject_side, response_value, rating_score,
        satisfaction_outcome, dismissal_reason_code, guardrail_state, guardrail_code
      ) = 0
    ), FALSE
  ));
CREATE UNIQUE INDEX uq_marketplace_matching_satisfaction_revision
  ON marketplace.matching_event_projections (collaboration_id, respondent_side, revision)
  WHERE event_type = 'marketplace.match.satisfaction_recorded.v1';
CREATE UNIQUE INDEX uq_marketplace_matching_guardrail_revision
  ON marketplace.matching_event_projections (collaboration_id, source_id, revision)
  WHERE event_type = 'marketplace.match.guardrail_recorded.v1';
COMMENT ON COLUMN marketplace.matching_event_projections.eligibility_rule_outcomes IS 'Outcomes in the contract-defined eligibility rule order; codes are not duplicated per event.';
