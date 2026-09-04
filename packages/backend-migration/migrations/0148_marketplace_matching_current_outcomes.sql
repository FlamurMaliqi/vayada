-- Migration: 0148_marketplace_matching_current_outcomes
-- Owner: domain-marketplace; see VAY-1459, engineering/marketplace-matching-contract.md

DROP INDEX marketplace.uq_marketplace_matching_satisfaction_revision;
CREATE TABLE marketplace.current_matching_outcomes (
  source_id               UUID        PRIMARY KEY,
  source_kind             TEXT        NOT NULL,
  collaboration_id        UUID        NOT NULL,
  creator_profile_id      UUID        NOT NULL,
  creator_organization_id UUID        NOT NULL,
  hotel_organization_id   UUID        NOT NULL,
  property_id             UUID        NOT NULL,
  offer_id                UUID        NOT NULL,
  subject_user_id         UUID        REFERENCES identity.users(id) ON DELETE CASCADE,
  actor_user_id           UUID        REFERENCES identity.users(id) ON DELETE CASCADE,
  respondent_side         TEXT,
  satisfaction_outcome    TEXT,
  guardrail_state         TEXT,
  guardrail_code          TEXT,
  revision                INTEGER     NOT NULL,
  transition_xid          XID8        NOT NULL DEFAULT pg_current_xact_id(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT chk_marketplace_current_matching_outcome_shape CHECK (
    (
      source_kind = 'satisfaction'
      AND subject_user_id IS NOT NULL AND actor_user_id IS NOT NULL
      AND respondent_side IN ('creator', 'hotel')
      AND satisfaction_outcome IN ('satisfied', 'neutral', 'dissatisfied')
      AND num_nonnulls(guardrail_state, guardrail_code) = 0
    ) OR (
      source_kind = 'guardrail'
      AND num_nonnulls(respondent_side, satisfaction_outcome) = 0
      AND guardrail_state IN ('opened', 'resolved')
      AND guardrail_code IN (
        'cancellation', 'no_show', 'dispute', 'block', 'report', 'policy_violation'
      )
    )
  ),
  CONSTRAINT chk_marketplace_current_matching_outcome_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_marketplace_current_matching_outcome_timestamps
    CHECK (isfinite(created_at) AND isfinite(updated_at) AND updated_at >= created_at),
  CONSTRAINT fk_marketplace_current_matching_outcome_collaboration
    FOREIGN KEY (
      collaboration_id, creator_profile_id, creator_organization_id,
      offer_id, property_id, hotel_organization_id
    ) REFERENCES marketplace.collaborations (
      id, creator_profile_id, creator_organization_id,
      offer_id, property_id, hotel_organization_id
    ) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_marketplace_current_matching_satisfaction_side
  ON marketplace.current_matching_outcomes (collaboration_id, respondent_side)
  WHERE source_kind = 'satisfaction';
CREATE INDEX idx_marketplace_current_matching_outcomes_collaboration
  ON marketplace.current_matching_outcomes (collaboration_id, source_kind);
CREATE INDEX idx_marketplace_current_matching_outcomes_subject
  ON marketplace.current_matching_outcomes (subject_user_id);
CREATE INDEX idx_marketplace_current_matching_outcomes_actor
  ON marketplace.current_matching_outcomes (actor_user_id);

CREATE FUNCTION marketplace.enforce_current_matching_outcome_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'Matching outcome revisions must start at 1'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_marketplace_current_matching_outcome_revision_transition';
    END IF;
    NEW.created_at := statement_timestamp();
  ELSIF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Matching outcome revisions must advance by 1'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_current_matching_outcome_revision_transition';
  ELSIF ROW(
    NEW.source_id, NEW.source_kind, NEW.collaboration_id, NEW.creator_profile_id,
    NEW.creator_organization_id, NEW.hotel_organization_id, NEW.property_id,
    NEW.offer_id, NEW.subject_user_id, NEW.respondent_side, NEW.guardrail_code, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.source_id, OLD.source_kind, OLD.collaboration_id, OLD.creator_profile_id,
    OLD.creator_organization_id, OLD.hotel_organization_id, OLD.property_id,
    OLD.offer_id, OLD.subject_user_id, OLD.respondent_side, OLD.guardrail_code, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Matching outcome source identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_current_matching_outcome_stable_identity';
  END IF;
  NEW.updated_at := statement_timestamp();
  NEW.transition_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_marketplace_current_matching_outcome_transition
  BEFORE INSERT OR UPDATE ON marketplace.current_matching_outcomes
  FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_current_matching_outcome_transition();

CREATE FUNCTION marketplace.validate_current_matching_outcome_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN (
    'marketplace.match.satisfaction_recorded.v1',
    'marketplace.match.guardrail_recorded.v1'
  ) AND NOT EXISTS (
    SELECT 1 FROM marketplace.current_matching_outcomes source
    WHERE source.source_id::TEXT = NEW.source_id
      AND source.transition_xid = pg_current_xact_id()
      AND source.revision = NEW.revision
      AND source.collaboration_id = NEW.collaboration_id
      AND source.creator_profile_id = NEW.creator_profile_id
      AND source.creator_organization_id = NEW.creator_organization_id
      AND source.hotel_organization_id = NEW.hotel_organization_id
      AND source.property_id = NEW.property_id AND source.offer_id = NEW.offer_id
      AND source.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND source.updated_at = NEW.occurred_at
      AND (
        (
          source.source_kind = 'satisfaction'
          AND NEW.event_type = 'marketplace.match.satisfaction_recorded.v1'
          AND source.respondent_side = NEW.respondent_side
          AND source.satisfaction_outcome = NEW.satisfaction_outcome
        ) OR (
          source.source_kind = 'guardrail'
          AND NEW.event_type = 'marketplace.match.guardrail_recorded.v1'
          AND source.guardrail_state = NEW.guardrail_state
          AND source.guardrail_code = NEW.guardrail_code
        )
      )
  ) THEN
    RAISE EXCEPTION 'Matching outcome event does not match its current source transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_matching_event_current_source_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_marketplace_matching_event_current_source_transition
  BEFORE INSERT ON marketplace.matching_event_projections
  FOR EACH ROW EXECUTE FUNCTION marketplace.validate_current_matching_outcome_projection();

CREATE FUNCTION marketplace.require_current_matching_outcome_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.current_matching_outcomes
    WHERE source_id = NEW.source_id
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.matching_event_projections event
    WHERE event.source_id = NEW.source_id::TEXT
      AND event.revision = NEW.revision
      AND event.collaboration_id = NEW.collaboration_id
      AND event.creator_profile_id = NEW.creator_profile_id
      AND event.creator_organization_id = NEW.creator_organization_id
      AND event.hotel_organization_id = NEW.hotel_organization_id
      AND event.property_id = NEW.property_id AND event.offer_id = NEW.offer_id
      AND event.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND event.occurred_at = NEW.updated_at
      AND (
        (
          NEW.source_kind = 'satisfaction'
          AND event.event_type = 'marketplace.match.satisfaction_recorded.v1'
          AND event.respondent_side = NEW.respondent_side
          AND event.satisfaction_outcome = NEW.satisfaction_outcome
        ) OR (
          NEW.source_kind = 'guardrail'
          AND event.event_type = 'marketplace.match.guardrail_recorded.v1'
          AND event.guardrail_state = NEW.guardrail_state
          AND event.guardrail_code = NEW.guardrail_code
        )
      )
  ) THEN
    RAISE EXCEPTION 'Matching outcome transition requires its measurement event'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_current_matching_outcome_projection_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_marketplace_current_matching_outcome_projection_required
  AFTER INSERT OR UPDATE ON marketplace.current_matching_outcomes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION marketplace.require_current_matching_outcome_projection();
