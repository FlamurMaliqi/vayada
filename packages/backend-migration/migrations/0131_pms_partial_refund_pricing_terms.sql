-- Keep pms-pricing.v1 rows readable by older application instances during a
-- rolling deploy. Rich cancellation terms live behind a reader-first sidecar
-- contract; the canonical v1 snapshot remains its original four-field shape.

CREATE FUNCTION pms.flexible_cancellation_policy_is_valid(policy JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE((
    jsonb_typeof(policy) = 'object'
    AND policy - ARRAY[
      'type',
      'freeCancellationDeadlineDays',
      'afterDeadlinePenalty',
      'noShowPenalty',
      'text',
      'flexibleCancellationType',
      'partialRefundCancelWindowDays',
      'partialRefundAmountPercent',
      'partialRefundTiers'
    ]::TEXT[] = '{}'::JSONB
    AND policy @> jsonb_build_object(
      'type', 'free_until_days_before_arrival',
      'afterDeadlinePenalty', 'full_booking_amount',
      'noShowPenalty', 'full_booking_amount'
    )
    AND jsonb_typeof(policy->'freeCancellationDeadlineDays') = 'number'
    AND policy->>'freeCancellationDeadlineDays' ~ '^(0|[1-9][0-9]{0,2})$'
    AND (policy->>'freeCancellationDeadlineDays')::INTEGER BETWEEN 0 AND 365
    AND (
      NOT policy ? 'text'
      OR (jsonb_typeof(policy->'text') = 'string' AND btrim(policy->>'text') <> '')
    )
    AND (
      NOT policy ? 'flexibleCancellationType'
      OR (
        jsonb_typeof(policy->'flexibleCancellationType') = 'string'
        AND policy->>'flexibleCancellationType' IN ('free', 'partial_refund')
      )
    )
    AND (
      NOT policy ? 'partialRefundCancelWindowDays'
      OR (
        jsonb_typeof(policy->'partialRefundCancelWindowDays') = 'number'
        AND policy->>'partialRefundCancelWindowDays' ~ '^[1-9][0-9]{0,2}$'
        AND (policy->>'partialRefundCancelWindowDays')::INTEGER BETWEEN 1 AND 365
      )
    )
    AND (
      NOT policy ? 'partialRefundAmountPercent'
      OR (
        jsonb_typeof(policy->'partialRefundAmountPercent') = 'number'
        AND policy->>'partialRefundAmountPercent' ~ '^[1-9][0-9]?$'
        AND (policy->>'partialRefundAmountPercent')::INTEGER BETWEEN 1 AND 99
      )
    )
    AND (
      NOT policy ? 'partialRefundTiers'
      OR (
        jsonb_typeof(policy->'partialRefundTiers') = 'array'
        AND jsonb_array_length(policy->'partialRefundTiers') <= 10
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(policy->'partialRefundTiers') AS item(tier)
          WHERE jsonb_typeof(tier) <> 'object'
            OR tier - ARRAY['minDaysBeforeCheckIn', 'refundPercent']::TEXT[] <> '{}'::JSONB
            OR jsonb_typeof(tier->'minDaysBeforeCheckIn') IS DISTINCT FROM 'number'
            OR tier->>'minDaysBeforeCheckIn' !~ '^(0|[1-9][0-9]{0,2})$'
            OR (tier->>'minDaysBeforeCheckIn')::INTEGER NOT BETWEEN 0 AND 365
            OR jsonb_typeof(tier->'refundPercent') IS DISTINCT FROM 'number'
            OR tier->>'refundPercent' !~ '^(0|[1-9][0-9]?|100)$'
            OR (tier->>'refundPercent')::INTEGER NOT BETWEEN 0 AND 100
        )
        AND (
          SELECT count(*) = count(DISTINCT tier->>'minDaysBeforeCheckIn')
          FROM jsonb_array_elements(policy->'partialRefundTiers') AS item(tier)
        )
      )
    )
    AND (
      policy->>'flexibleCancellationType' IS DISTINCT FROM 'partial_refund'
      OR (
        jsonb_typeof(policy->'partialRefundTiers') = 'array'
        AND jsonb_array_length(policy->'partialRefundTiers') BETWEEN 1 AND 10
      )
    )), FALSE);
$$;

CREATE TABLE pms.flexible_rate_plan_cancellation_extensions (
  flexible_rate_plan_id      UUID        PRIMARY KEY,
  property_id                UUID        NOT NULL,
  room_type_id               UUID        NOT NULL,
  pricing_contract_version   TEXT        NOT NULL DEFAULT 'pms-pricing.v1',
  extension_contract_version TEXT        NOT NULL DEFAULT 'pms-cancellation-policy.v1',
  cancellation_terms         JSONB       NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pms_flexible_cancellation_extension_plan
    FOREIGN KEY (
      flexible_rate_plan_id, property_id, room_type_id, pricing_contract_version
    )
    REFERENCES pms.rate_plans (id, property_id, room_type_id, pricing_contract_version)
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  CONSTRAINT chk_pms_flexible_cancellation_extension_contracts
    CHECK (
      pricing_contract_version = 'pms-pricing.v1'
      AND extension_contract_version = 'pms-cancellation-policy.v1'
    ),
  CONSTRAINT chk_pms_flexible_cancellation_extension_terms
    CHECK (pms.flexible_cancellation_policy_is_valid(cancellation_terms))
);

CREATE INDEX idx_pms_flexible_cancellation_extensions_property_room
  ON pms.flexible_rate_plan_cancellation_extensions (property_id, room_type_id);
