-- Migration: 0138_marketplace_creator_matching_preferences
-- Owner: domain-marketplace
-- See: VAY-1409, engineering/marketplace-matching-contract.md
--
-- Absence is the unknown state. Existing creator profiles are intentionally not
-- backfilled with inferred preferences.

CREATE FUNCTION marketplace.enforce_creator_matching_preferences_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.revision <> 1)
     OR (TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1) THEN
    RAISE EXCEPTION 'Marketplace creator matching preference revisions must start at 1 and advance by 1'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_creator_matching_preferences_revision_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE marketplace.creator_matching_preferences (
  creator_profile_id  UUID        PRIMARY KEY,
  organization_id     UUID        NOT NULL,
  contract_version    TEXT        NOT NULL,
  revision            INTEGER     NOT NULL DEFAULT 1,
  preferences         JSONB       NOT NULL,
  updated_by_user_id  UUID        NOT NULL REFERENCES identity.users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_creator_matching_preferences_contract
    CHECK (contract_version = 'marketplace-creator-matching-preferences.v1'),
  CONSTRAINT chk_marketplace_creator_matching_preferences_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_marketplace_creator_matching_preferences_document
    CHECK (
      jsonb_typeof(preferences) = 'object'
      AND preferences ?& ARRAY[
        'contentCategories',
        'deliverableTypes',
        'compensationTypes',
        'collaborationGoals',
        'travel'
      ]
      AND preferences - ARRAY[
        'contentCategories',
        'deliverableTypes',
        'compensationTypes',
        'collaborationGoals',
        'travel'
      ] = '{}'::jsonb
    ),
  CONSTRAINT chk_marketplace_creator_matching_preferences_timestamps
    CHECK (updated_at >= created_at),
  CONSTRAINT fk_marketplace_creator_matching_preferences_profile
    FOREIGN KEY (creator_profile_id, organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE
);

CREATE TRIGGER trg_marketplace_creator_matching_preferences_revision
  BEFORE INSERT OR UPDATE ON marketplace.creator_matching_preferences
  FOR EACH ROW
  EXECUTE FUNCTION marketplace.enforce_creator_matching_preferences_revision();

COMMENT ON COLUMN marketplace.creator_matching_preferences.preferences IS
  'Private creator-declared matching inputs. Null fields are intentionally unset; no_preference is explicit.';
COMMENT ON COLUMN marketplace.creator_matching_preferences.updated_by_user_id IS
  'Internal audit metadata; never expose through Marketplace profile responses.';
