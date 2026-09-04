-- Migration: 0136_marketplace_offer_matching_criteria
-- Owner: domain-marketplace
-- See: VAY-1408, engineering/marketplace-matching-contract.md
--
-- Absence remains the legacy/unknown state. No existing offer or requirement is
-- converted into a hard filter by this migration.

ALTER TABLE marketplace.offer_deliverables
  ADD COLUMN requirement_level TEXT,
  ADD CONSTRAINT chk_marketplace_offer_deliverables_requirement_level
    CHECK (requirement_level IS NULL OR requirement_level IN ('required', 'preferred'));

ALTER TABLE marketplace.offer_compensation_options
  ADD COLUMN follower_requirement_level TEXT,
  ADD CONSTRAINT chk_marketplace_offer_compensation_follower_requirement_level
    CHECK (
      follower_requirement_level IS NULL
      OR (
        follower_requirement_level IN ('required', 'preferred')
        AND min_followers IS NOT NULL
        AND cardinality(platforms) > 0
      )
    );

ALTER TABLE marketplace.offer_creator_requirements
  ADD COLUMN platform_requirement_level TEXT,
  ADD COLUMN target_countries_requirement_level TEXT,
  ADD COLUMN creator_types_requirement_level TEXT,
  ADD CONSTRAINT chk_marketplace_offer_requirements_levels
    CHECK (
      (platform_requirement_level IS NULL OR platform_requirement_level IN ('required', 'preferred'))
      AND (target_countries_requirement_level IS NULL OR target_countries_requirement_level IN ('required', 'preferred'))
      AND (creator_types_requirement_level IS NULL OR creator_types_requirement_level IN ('required', 'preferred'))
      AND (platform_requirement_level IS DISTINCT FROM 'required' OR cardinality(platforms) > 0)
      AND (
        target_countries_requirement_level IS DISTINCT FROM 'required'
        OR COALESCE(cardinality(target_countries), 0) > 0
      )
      AND (creator_types_requirement_level IS DISTINCT FROM 'required' OR cardinality(creator_types) > 0)
    );

CREATE FUNCTION marketplace.enforce_offer_matching_criteria_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.revision <> 1)
     OR (TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1) THEN
    RAISE EXCEPTION 'Marketplace offer matching criteria revisions must start at 1 and advance by 1'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_offer_matching_criteria_revision_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE marketplace.offer_matching_criteria (
  offer_id            UUID        PRIMARY KEY,
  property_id         UUID        NOT NULL,
  organization_id     UUID        NOT NULL,
  contract_version    TEXT        NOT NULL,
  revision            INTEGER     NOT NULL DEFAULT 1,
  criteria            JSONB       NOT NULL,
  updated_by_user_id  UUID        NOT NULL REFERENCES identity.users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_offer_matching_criteria_contract
    CHECK (contract_version = 'marketplace-offer-matching-criteria.v1'),
  CONSTRAINT chk_marketplace_offer_matching_criteria_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_marketplace_offer_matching_criteria_document
    CHECK (
      jsonb_typeof(criteria) = 'object'
      AND criteria ?& ARRAY[
        'primaryCampaignGoal',
        'availability',
        'contentCategories',
        'contentStyles',
        'usageRights',
        'includedRevisionRounds',
        'expectedEffortHours',
        'expectedCompensationValue',
        'applicationCapacity'
      ]
      AND criteria - ARRAY[
        'primaryCampaignGoal',
        'availability',
        'contentCategories',
        'contentStyles',
        'usageRights',
        'includedRevisionRounds',
        'expectedEffortHours',
        'expectedCompensationValue',
        'applicationCapacity'
      ] = '{}'::jsonb
    ),
  CONSTRAINT chk_marketplace_offer_matching_criteria_timestamps
    CHECK (updated_at >= created_at),
  CONSTRAINT fk_marketplace_offer_matching_criteria_offer
    FOREIGN KEY (offer_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_offers(id, property_id, organization_id)
    ON DELETE CASCADE
);

CREATE TRIGGER trg_marketplace_offer_matching_criteria_revision
  BEFORE INSERT OR UPDATE ON marketplace.offer_matching_criteria
  FOR EACH ROW
  EXECUTE FUNCTION marketplace.enforce_offer_matching_criteria_revision();

COMMENT ON COLUMN marketplace.offer_matching_criteria.updated_by_user_id IS
  'Private audit metadata; never expose through Marketplace offer responses.';
COMMENT ON COLUMN marketplace.offer_matching_criteria.criteria IS
  'Versioned hotel-authored matching criteria. The application contract validates nested values.';
