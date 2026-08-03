-- Migration: 0056_marketplace_hotel_collaboration_preferences
-- Owner: domain-marketplace
-- See: VAY-1077, engineering/hotel-onboarding-information-inventory.md (ONB-08)
--
-- Stores only the canonical Marketplace preference aggregate. Drafts, legacy
-- offer evidence, onboarding readiness, and submission state remain outside
-- this table.

CREATE FUNCTION marketplace.hotel_collaboration_preference_selection_is_canonical(
  selection TEXT[],
  allowed_values TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(selection) > 0
     AND selection = ARRAY(
       SELECT allowed_value
       FROM unnest(allowed_values) WITH ORDINALITY
         AS allowed(allowed_value, contract_position)
       WHERE allowed_value = ANY(selection)
       ORDER BY contract_position
     );
$$;

CREATE FUNCTION marketplace.hotel_collaboration_preference_months_are_canonical(
  selected_months SMALLINT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT selected_months = ARRAY(
    SELECT DISTINCT selected_month
    FROM unnest(selected_months) AS months(selected_month)
    WHERE selected_month BETWEEN 1 AND 12
    ORDER BY selected_month
  );
$$;

CREATE FUNCTION marketplace.enforce_hotel_collaboration_preferences_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.revision <> 1)
     OR (TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1) THEN
    RAISE EXCEPTION 'Marketplace preference revisions must start at 1 and advance by 1'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_marketplace_hotel_collaboration_preferences_revision_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE marketplace.hotel_collaboration_preferences (
  property_id         UUID        PRIMARY KEY,
  organization_id     UUID        NOT NULL,
  contract_version    TEXT        NOT NULL,
  revision            INTEGER     NOT NULL,
  compensation_types  TEXT[]      NOT NULL,
  content_platforms   TEXT[]      NOT NULL,
  content_types       TEXT[]      NOT NULL,
  availability_mode   TEXT        NOT NULL,
  selected_months     SMALLINT[]  NOT NULL,
  updated_by_user_id  UUID        NOT NULL REFERENCES identity.users(id),
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_contract
    CHECK (contract_version = 'marketplace-hotel-collaboration-preferences.v1'),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_compensation
    CHECK (marketplace.hotel_collaboration_preference_selection_is_canonical(
      compensation_types,
      ARRAY['free_stay', 'paid', 'discount', 'affiliate']::TEXT[]
    )),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_platforms
    CHECK (marketplace.hotel_collaboration_preference_selection_is_canonical(
      content_platforms,
      ARRAY['instagram', 'tiktok', 'youtube', 'facebook', 'blog', 'x', 'other']::TEXT[]
    )),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_content
    CHECK (marketplace.hotel_collaboration_preference_selection_is_canonical(
      content_types,
      ARRAY[
        'post', 'story', 'short_form_video', 'long_form_video', 'photography', 'other'
      ]::TEXT[]
    )),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_months
    CHECK (marketplace.hotel_collaboration_preference_months_are_canonical(selected_months)),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_availability
    CHECK (
      (availability_mode = 'year_round' AND cardinality(selected_months) = 0)
      OR
      (availability_mode = 'selected_months' AND cardinality(selected_months) > 0)
    ),
  CONSTRAINT chk_marketplace_hotel_collaboration_preferences_timestamps
    CHECK (updated_at >= created_at),
  CONSTRAINT fk_marketplace_hotel_collaboration_preferences_profile
    FOREIGN KEY (property_id, organization_id)
    REFERENCES marketplace.marketplace_hotel_profiles(property_id, organization_id)
    ON DELETE CASCADE
);

CREATE TRIGGER trg_marketplace_hotel_collaboration_preferences_revision
  BEFORE INSERT OR UPDATE ON marketplace.hotel_collaboration_preferences
  FOR EACH ROW
  EXECUTE FUNCTION marketplace.enforce_hotel_collaboration_preferences_revision();
