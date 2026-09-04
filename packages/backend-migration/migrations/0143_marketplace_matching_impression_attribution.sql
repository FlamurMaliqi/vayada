-- Migration: 0143_marketplace_matching_impression_attribution
-- Owner: domain-marketplace
-- See: VAY-1455, engineering/marketplace-matching-contract.md

ALTER TABLE marketplace.collaborations
  ADD COLUMN matching_attribution_kind TEXT NOT NULL DEFAULT 'organic',
  ADD COLUMN matching_policy_version TEXT, ADD COLUMN matching_evaluation_id UUID,
  ADD COLUMN matching_impression_id TEXT, ADD COLUMN matching_recommendation_session_id TEXT,
  ADD COLUMN matching_surface TEXT, ADD COLUMN matching_presentation_mode TEXT,
  ADD CONSTRAINT chk_marketplace_collaboration_matching_attribution
  CHECK (COALESCE(
    (
      matching_attribution_kind = 'organic'
      AND num_nonnulls(
        matching_policy_version, matching_evaluation_id, matching_impression_id,
        matching_recommendation_session_id, matching_surface, matching_presentation_mode
      ) = 0
    ) OR (
      matching_attribution_kind = 'recommended'
      AND initiator_type = 'creator'
      AND matching_policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      AND matching_evaluation_id IS NOT NULL
      AND matching_impression_id ~ '^[0-9a-f]{64}$'
      AND matching_recommendation_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND matching_surface = 'creator_offer_discovery'
      AND matching_presentation_mode IN ('ranked', 'exploration')
    ), FALSE
  ));

ALTER TABLE marketplace.matching_event_projections
  ADD COLUMN policy_version TEXT, ADD COLUMN evaluation_id UUID,
  ADD COLUMN evaluation_mode TEXT, ADD COLUMN impression_id TEXT,
  ADD COLUMN recommendation_session_id TEXT, ADD COLUMN surface TEXT,
  ADD COLUMN presentation_mode TEXT, ADD COLUMN impression_rank INTEGER,
  ADD COLUMN impression_slot INTEGER, ADD COLUMN attribution_kind TEXT,
  ADD CONSTRAINT chk_marketplace_matching_event_context
  CHECK (COALESCE(
    (
      event_type = 'marketplace.match.evaluated.v1'
      AND revision = 1
      AND num_nonnulls(
        collaboration_id, attribution_kind, impression_id, recommendation_session_id,
        surface, presentation_mode, impression_rank, impression_slot
      ) = 0
      AND policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      AND lower(source_id) = evaluation_id::TEXT
      AND evaluation_mode IN ('shadow', 'active')
    ) OR (
      event_type = 'marketplace.match.impression.v1'
      AND revision = 1
      AND num_nonnulls(collaboration_id, attribution_kind, evaluation_mode) = 0
      AND policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      AND evaluation_id IS NOT NULL
      AND impression_id ~ '^[0-9a-f]{64}$'
      AND source_id = impression_id
      AND recommendation_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND surface = 'creator_offer_discovery'
      AND presentation_mode IN ('ranked', 'exploration')
      AND impression_rank >= 1
      AND impression_slot >= 1
    ) OR (
      event_type NOT IN ('marketplace.match.evaluated.v1', 'marketplace.match.impression.v1')
      AND num_nonnulls(evaluation_mode, impression_rank, impression_slot) = 0
      AND (
        (
          event_type IN ('marketplace.match.saved.v1', 'marketplace.match.dismissed.v1')
          AND collaboration_id IS NULL
        ) OR (
          event_type NOT IN ('marketplace.match.saved.v1', 'marketplace.match.dismissed.v1')
          AND collaboration_id IS NOT NULL
        )
      )
      AND (
        (
          attribution_kind = 'organic'
          AND num_nonnulls(
            policy_version, evaluation_id, impression_id, recommendation_session_id,
            surface, presentation_mode
          ) = 0
        ) OR (
          attribution_kind = 'recommended'
          AND policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
          AND evaluation_id IS NOT NULL
          AND impression_id ~ '^[0-9a-f]{64}$'
          AND recommendation_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
          AND surface = 'creator_offer_discovery'
          AND presentation_mode IN ('ranked', 'exploration')
        )
      )
      AND (
        event_type <> 'marketplace.match.invitation_sent.v1'
        OR attribution_kind = 'organic'
      )
    ), FALSE
  ));

CREATE UNIQUE INDEX uq_marketplace_matching_qualified_impression
  ON marketplace.matching_event_projections (
    policy_version, surface, creator_profile_id, offer_id,
    ((occurred_at AT TIME ZONE 'UTC')::DATE)
  ) WHERE event_type = 'marketplace.match.impression.v1';

CREATE FUNCTION marketplace.prevent_matching_attribution_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.matching_attribution_kind, OLD.matching_policy_version,
    OLD.matching_evaluation_id, OLD.matching_impression_id,
    OLD.matching_recommendation_session_id, OLD.matching_surface,
    OLD.matching_presentation_mode
  ) IS DISTINCT FROM ROW(
    NEW.matching_attribution_kind, NEW.matching_policy_version,
    NEW.matching_evaluation_id, NEW.matching_impression_id,
    NEW.matching_recommendation_session_id, NEW.matching_surface,
    NEW.matching_presentation_mode
  ) THEN
    RAISE EXCEPTION 'Matching collaboration attribution is immutable'
      USING ERRCODE = '55000',
            CONSTRAINT = 'immutable_marketplace_collaboration_matching_attribution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_marketplace_collaboration_matching_attribution_immutable
  BEFORE UPDATE OF matching_attribution_kind, matching_policy_version,
    matching_evaluation_id, matching_impression_id,
    matching_recommendation_session_id, matching_surface,
    matching_presentation_mode
  ON marketplace.collaborations
  FOR EACH ROW EXECUTE FUNCTION marketplace.prevent_matching_attribution_mutation();

CREATE FUNCTION marketplace.enforce_matching_collaboration_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  frozen marketplace.collaborations%ROWTYPE;
BEGIN
  IF NEW.collaboration_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO frozen FROM marketplace.collaborations WHERE id = NEW.collaboration_id;
  IF NOT FOUND OR ROW(
    frozen.matching_attribution_kind, frozen.matching_policy_version,
    frozen.matching_evaluation_id, frozen.matching_impression_id,
    frozen.matching_recommendation_session_id, frozen.matching_surface,
    frozen.matching_presentation_mode
  ) IS DISTINCT FROM ROW(
    NEW.attribution_kind, NEW.policy_version, NEW.evaluation_id, NEW.impression_id,
    NEW.recommendation_session_id, NEW.surface, NEW.presentation_mode
  ) THEN
    RAISE EXCEPTION 'Matching event does not use the collaboration frozen attribution'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_matching_collaboration_attribution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_marketplace_matching_event_attribution
  BEFORE INSERT ON marketplace.matching_event_projections
  FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_matching_collaboration_attribution();
