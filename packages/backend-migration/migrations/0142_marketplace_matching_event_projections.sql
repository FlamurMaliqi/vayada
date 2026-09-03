-- Migration: 0142_marketplace_matching_event_projections
-- Owner: domain-marketplace
-- See: VAY-1447, engineering/marketplace-matching-contract.md

ALTER TABLE marketplace.collaborations
  ADD CONSTRAINT uq_marketplace_collaborations_matching_identity
  UNIQUE (id, creator_profile_id, creator_organization_id, offer_id, property_id, hotel_organization_id);

ALTER TABLE platform.domain_events
  ADD CONSTRAINT chk_platform_matching_event_private_payload
  CHECK (
    source_system <> 'marketplace' OR event_type NOT LIKE 'marketplace.match.%'
    OR (payload = '{}'::JSONB AND event_metadata = '{}'::JSONB)
  );

CREATE TABLE marketplace.matching_event_projections (
  domain_event_id         UUID        PRIMARY KEY,
  event_type              TEXT        NOT NULL,
  source_id               TEXT        NOT NULL,
  revision                INTEGER     NOT NULL,
  actor_user_id           UUID,
  creator_profile_id      UUID        NOT NULL,
  creator_organization_id UUID        NOT NULL,
  hotel_organization_id   UUID        NOT NULL,
  property_id             UUID        NOT NULL,
  offer_id                UUID        NOT NULL,
  collaboration_id        UUID,
  contract_version        TEXT        NOT NULL,
  correlation_id          TEXT        NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL,
  retention_expires_at    TIMESTAMPTZ GENERATED ALWAYS AS (
    (recorded_at AT TIME ZONE 'UTC' + INTERVAL '18 months') AT TIME ZONE 'UTC'
  ) STORED,
  CONSTRAINT uq_marketplace_matching_event_source
    UNIQUE (event_type, source_id, revision),
  CONSTRAINT chk_marketplace_matching_event_type
    CHECK (event_type IN (
      'marketplace.match.evaluated.v1',
      'marketplace.match.impression.v1',
      'marketplace.match.saved.v1',
      'marketplace.match.dismissed.v1',
      'marketplace.match.application_submitted.v1',
      'marketplace.match.invitation_sent.v1',
      'marketplace.match.response_recorded.v1',
      'marketplace.match.accepted.v1',
      'marketplace.match.completed.v1',
      'marketplace.match.rating_recorded.v1',
      'marketplace.match.satisfaction_recorded.v1',
      'marketplace.match.guardrail_recorded.v1'
    )),
  CONSTRAINT chk_marketplace_matching_event_base
    CHECK (
      contract_version = 'marketplace-matching-contract.v2'
      AND revision BETWEEN 1 AND 2147483647
      AND source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
      AND correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND isfinite(occurred_at) AND isfinite(recorded_at)
      AND occurred_at <= recorded_at
    ),
  CONSTRAINT fk_marketplace_matching_event_domain
    FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_marketplace_matching_event_actor
    FOREIGN KEY (actor_user_id) REFERENCES identity.users(id),
  CONSTRAINT fk_marketplace_matching_event_creator
    FOREIGN KEY (creator_profile_id, creator_organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id),
  CONSTRAINT fk_marketplace_matching_event_offer
    FOREIGN KEY (offer_id, property_id, hotel_organization_id)
    REFERENCES marketplace.marketplace_offers(id, property_id, organization_id),
  CONSTRAINT fk_marketplace_matching_event_collaboration
    FOREIGN KEY (
      collaboration_id, creator_profile_id, creator_organization_id,
      offer_id, property_id, hotel_organization_id
    ) REFERENCES marketplace.collaborations (
      id, creator_profile_id, creator_organization_id,
      offer_id, property_id, hotel_organization_id
    )
);

CREATE INDEX idx_marketplace_matching_event_retention
  ON marketplace.matching_event_projections (retention_expires_at);

CREATE FUNCTION marketplace.enforce_matching_event_envelope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  envelope platform.domain_events%ROWTYPE;
BEGIN
  SELECT * INTO envelope FROM platform.domain_events WHERE id = NEW.domain_event_id;
  IF NOT FOUND OR envelope.source_system <> 'marketplace'
     OR envelope.event_key <> (NEW.event_type || ':' || NEW.source_id || ':' || NEW.revision::TEXT)
     OR envelope.event_version <> 1
     OR envelope.event_type <> NEW.event_type
     OR envelope.occurred_at <> NEW.occurred_at
     OR envelope.recorded_at <> NEW.recorded_at
     OR envelope.property_id <> NEW.property_id
     OR envelope.correlation_id IS DISTINCT FROM NEW.correlation_id
     OR envelope.actor_user_id IS DISTINCT FROM NEW.actor_user_id
     OR envelope.resource_product <> 'marketplace'
     OR envelope.resource_type <> 'matching_event'
     OR envelope.resource_id <> NEW.source_id THEN
    RAISE EXCEPTION 'Matching projection does not match its platform domain event'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_matching_event_envelope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_marketplace_matching_event_validate
  BEFORE INSERT ON marketplace.matching_event_projections
  FOR EACH ROW EXECUTE FUNCTION marketplace.enforce_matching_event_envelope();

CREATE TRIGGER trg_marketplace_matching_event_append_only
  BEFORE UPDATE OR DELETE ON marketplace.matching_event_projections
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_marketplace_matching_event_no_truncate
  BEFORE TRUNCATE ON marketplace.matching_event_projections
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
