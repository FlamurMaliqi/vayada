-- Migration: 0035_marketplace_creator_platform_connections
-- Owner: domain-marketplace
-- See: engineering/marketplace-creator-platform-connections.md
--
-- Stores provider authorization state, connected creator accounts, and dated
-- normalized metric snapshots. Provider credentials live in the credential
-- vault; only opaque references are persisted here.

CREATE FUNCTION marketplace.jsonb_has_creator_platform_secret(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT marketplace.jsonb_has_forbidden_public_key(
    document,
    ARRAY[
      'access_token', 'refresh_token', 'id_token', 'oauth_token', 'token',
      'client_secret', 'secret', 'credentials', 'api_key', 'private_key',
      'code_verifier', 'authorization_code', 'raw_provider_response'
    ]::TEXT[]
  );
$$;

CREATE FUNCTION marketplace.jsonb_is_creator_platform_unavailable_fields(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT
    jsonb_typeof(document) = 'array'
    AND NOT marketplace.jsonb_has_creator_platform_secret(document)
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(document) = 'array' THEN document
          ELSE '[]'::jsonb
        END
      ) AS unavailable(entry)
      WHERE jsonb_typeof(entry) <> 'object'
         OR NOT (entry ? 'field')
         OR NOT (entry ? 'reason')
         OR jsonb_typeof(entry -> 'field') <> 'string'
         OR jsonb_typeof(entry -> 'reason') <> 'string'
         OR entry ->> 'field' NOT IN (
           'followerCount', 'reach', 'views', 'contentItemCount', 'likes',
           'comments', 'shares', 'engagementRate', 'audienceCountries',
           'audienceAgeGroups', 'audienceGenderSplit'
         )
         OR entry ->> 'reason' NOT IN (
           'unsupported', 'privacy_threshold', 'permission_missing',
           'insufficient_data', 'account_type_ineligible', 'provider_omitted'
         )
    );
$$;

ALTER TABLE marketplace.creator_platforms
  ALTER COLUMN engagement_rate TYPE NUMERIC(24, 6),
  ADD CONSTRAINT uq_marketplace_creator_platforms_connection_identity
  UNIQUE (id, creator_profile_id, organization_id, platform);

CREATE FUNCTION marketplace.creator_profile_is_complete(
  p_creator_profile_id UUID,
  p_organization_id UUID,
  p_profile_photo_required BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM marketplace.creator_profiles AS profile
    WHERE profile.id = p_creator_profile_id
      AND profile.organization_id = p_organization_id
      AND NULLIF(BTRIM(profile.display_name), '') IS NOT NULL
      AND NULLIF(BTRIM(profile.location_text), '') IS NOT NULL
      AND NULLIF(BTRIM(profile.short_description), '') IS NOT NULL
      AND NULLIF(BTRIM(profile.phone), '') IS NOT NULL
      AND (
        NOT COALESCE(p_profile_photo_required, FALSE)
        OR EXISTS (
          SELECT 1
          FROM platform.media_objects AS media
          JOIN platform.media_variants AS variant
            ON variant.media_object_id = media.id
           AND variant.variant_name = 'original_safe'
           AND variant.visibility = 'public'
          WHERE media.id::text = profile.profile_metadata ->> 'profilePictureMediaObjectId'
            AND (
              (
                media.owner_organization_id = profile.organization_id
                AND media.resource_product = 'marketplace'
                AND media.resource_type = 'creator_profile'
                AND media.resource_id = profile.id::text
                AND media.purpose = 'marketplace.creator.profile_image'
              )
              OR (
                profile.owner_user_id IS NOT NULL
                AND media.resource_product = 'platform'
                AND media.resource_type = 'user_profile'
                AND media.resource_id = profile.owner_user_id::text
                AND media.created_by_user_id = profile.owner_user_id
                AND media.purpose = 'identity.user.profile_image'
              )
            )
            AND media.storage_kind = 'vayada_managed'
            AND media.visibility = 'public'
            AND media.public_approved = TRUE
            AND media.lifecycle_status = 'active'
            AND media.content_type LIKE 'image/%'
            AND variant.content_type LIKE 'image/%'
            AND variant.public_cdn_url = profile.profile_picture_url
        )
      )
      AND EXISTS (
        SELECT 1
        FROM marketplace.creator_platforms AS platform
        WHERE platform.creator_profile_id = profile.id
          AND platform.organization_id = profile.organization_id
          AND NULLIF(BTRIM(platform.handle), '') IS NOT NULL
          AND platform.follower_count > 0
          AND (
            platform.platform <> 'other'
            OR NULLIF(BTRIM(platform.profile_url), '') IS NOT NULL
          )
      )
  );
$$;

CREATE TABLE marketplace.creator_platform_authorizations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id   UUID        NOT NULL,
  organization_id      UUID        NOT NULL,
  actor_user_id        UUID        NOT NULL REFERENCES identity.users(id),
  platform             TEXT        NOT NULL,
  provider             TEXT        NOT NULL,
  target_platform_id   UUID,
  status               TEXT        NOT NULL DEFAULT 'authorizing',
  state_digest         TEXT        NOT NULL,
  credential_ref       TEXT,
  candidates           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  granted_scopes       TEXT[]      NOT NULL DEFAULT '{}',
  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  error_code           TEXT,
  credential_cleaned_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_creator_platform_authorizations_state
    UNIQUE (state_digest),
  CONSTRAINT uq_marketplace_creator_platform_authorizations_connection_identity
    UNIQUE (id, creator_profile_id, organization_id, platform, provider),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_platform
    CHECK (platform IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_provider
    CHECK (provider IN ('meta', 'tiktok', 'google')),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_provider_platform
    CHECK (
      (provider = 'meta' AND platform IN ('instagram', 'facebook'))
      OR (provider = 'tiktok' AND platform = 'tiktok')
      OR (provider = 'google' AND platform = 'youtube')
    ),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_status
    CHECK (status IN (
      'authorizing', 'processing', 'pending_account_selection', 'active', 'failed', 'expired'
    )),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_state_digest
    CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_refs
    CHECK (
      credential_ref IS NULL OR btrim(credential_ref) <> ''
    ),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_candidates
    CHECK (
      jsonb_typeof(candidates) = 'array'
      AND NOT marketplace.jsonb_has_creator_platform_secret(candidates)
    ),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_scopes
    CHECK (array_position(granted_scopes, NULL) IS NULL),
  CONSTRAINT chk_marketplace_creator_platform_authorizations_dates
    CHECK (
      expires_at > created_at
      AND (
        consumed_at IS NULL
        OR (consumed_at >= created_at AND consumed_at <= expires_at)
      )
    ),
  CONSTRAINT fk_marketplace_creator_platform_authorizations_creator_org
    FOREIGN KEY (creator_profile_id, organization_id)
    REFERENCES marketplace.creator_profiles(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_marketplace_creator_platform_authorizations_target_platform
    FOREIGN KEY (target_platform_id, creator_profile_id, organization_id, platform)
    REFERENCES marketplace.creator_platforms(
      id,
      creator_profile_id,
      organization_id,
      platform
    )
    ON DELETE SET NULL (target_platform_id)
);

CREATE INDEX idx_marketplace_creator_platform_authorizations_creator_status
  ON marketplace.creator_platform_authorizations (
    creator_profile_id,
    organization_id,
    status
  );

CREATE INDEX idx_marketplace_creator_platform_authorizations_credential_cleanup
  ON marketplace.creator_platform_authorizations (
    credential_cleaned_at,
    status,
    expires_at
  )
  WHERE credential_cleaned_at IS NULL;

CREATE TABLE marketplace.creator_platform_credential_cleanup_jobs (
  credential_ref    TEXT        PRIMARY KEY,
  authorization_id  UUID        NOT NULL,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  last_error_code   TEXT,
  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleanup_claim_id  UUID,
  cleanup_claim_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_creator_platform_cleanup_ref
    CHECK (btrim(credential_ref) <> ''),
  CONSTRAINT chk_marketplace_creator_platform_cleanup_attempts
    CHECK (attempts >= 0),
  CONSTRAINT chk_marketplace_creator_platform_cleanup_claim
    CHECK (
      (cleanup_claim_id IS NULL AND cleanup_claim_expires_at IS NULL)
      OR (cleanup_claim_id IS NOT NULL AND cleanup_claim_expires_at IS NOT NULL)
    )
);

CREATE FUNCTION marketplace.queue_creator_platform_credential_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.credential_ref IS NOT NULL AND OLD.credential_cleaned_at IS NULL THEN
    INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
      credential_ref,
      authorization_id
    ) VALUES (
      OLD.credential_ref,
      OLD.id
    )
    ON CONFLICT (credential_ref) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_marketplace_creator_platform_authorization_cleanup
BEFORE DELETE ON marketplace.creator_platform_authorizations
FOR EACH ROW
EXECUTE FUNCTION marketplace.queue_creator_platform_credential_cleanup();

CREATE TABLE marketplace.creator_platform_connections (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id         UUID        NOT NULL,
  platform_id              UUID        NOT NULL,
  creator_profile_id       UUID        NOT NULL,
  organization_id          UUID        NOT NULL,
  platform                 TEXT        NOT NULL,
  provider                 TEXT        NOT NULL,
  provider_grant_subject_id TEXT,
  external_account_id      TEXT        NOT NULL,
  external_account_type    TEXT,
  status                   TEXT        NOT NULL DEFAULT 'active',
  capabilities             TEXT[]      NOT NULL DEFAULT '{}',
  imported_fields          TEXT[]      NOT NULL DEFAULT '{}',
  unavailable_fields       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  credential_ref           TEXT,
  access_token_expires_at  TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  last_sync_attempt_at     TIMESTAMPTZ,
  last_successful_sync_at  TIMESTAMPTZ,
  sync_lease_id            UUID,
  sync_lease_expires_at    TIMESTAMPTZ,
  last_error_code          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marketplace_creator_platform_connections_authorization
    UNIQUE (authorization_id),
  CONSTRAINT uq_marketplace_creator_platform_connections_platform_id
    UNIQUE (platform_id),
  CONSTRAINT uq_marketplace_creator_platform_connections_external_account
    UNIQUE (platform, external_account_id),
  CONSTRAINT uq_marketplace_creator_platform_connections_identity
    UNIQUE (id, platform_id, creator_profile_id, organization_id),
  CONSTRAINT chk_marketplace_creator_platform_connections_platform
    CHECK (platform IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  CONSTRAINT chk_marketplace_creator_platform_connections_provider
    CHECK (provider IN ('meta', 'tiktok', 'google')),
  CONSTRAINT chk_marketplace_creator_platform_connections_provider_platform
    CHECK (
      (provider = 'meta' AND platform IN ('instagram', 'facebook'))
      OR (provider = 'tiktok' AND platform = 'tiktok')
      OR (provider = 'google' AND platform = 'youtube')
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_status
    CHECK (status IN ('active', 'reconnect_required', 'revoked', 'sync_failed')),
  CONSTRAINT chk_marketplace_creator_platform_connections_external_account
    CHECK (
      btrim(external_account_id) <> ''
      AND (external_account_type IS NULL OR btrim(external_account_type) <> '')
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_grant_subject
    CHECK (
      provider_grant_subject_id IS NULL OR btrim(provider_grant_subject_id) <> ''
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_capabilities
    CHECK (
      array_position(capabilities, NULL) IS NULL
      AND capabilities <@ ARRAY[
        'followerCount', 'reach', 'views', 'contentItemCount', 'likes',
        'comments', 'shares', 'engagementRate', 'audienceCountries',
        'audienceAgeGroups', 'audienceGenderSplit'
      ]::TEXT[]
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_imported_fields
    CHECK (
      array_position(imported_fields, NULL) IS NULL
      AND imported_fields <@ capabilities
      AND imported_fields <@ ARRAY[
        'followerCount', 'reach', 'views', 'contentItemCount', 'likes',
        'comments', 'shares', 'engagementRate', 'audienceCountries',
        'audienceAgeGroups', 'audienceGenderSplit'
      ]::TEXT[]
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_unavailable_fields
    CHECK (marketplace.jsonb_is_creator_platform_unavailable_fields(unavailable_fields)),
  CONSTRAINT chk_marketplace_creator_platform_connections_credential_ref
    CHECK (
      (status = 'revoked' AND credential_ref IS NULL)
      OR (
        status <> 'revoked'
        AND credential_ref IS NOT NULL
        AND btrim(credential_ref) <> ''
      )
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_sync_dates
    CHECK (
      last_successful_sync_at IS NULL
      OR (
        last_sync_attempt_at IS NOT NULL
        AND last_successful_sync_at <= last_sync_attempt_at
      )
    ),
  CONSTRAINT chk_marketplace_creator_platform_connections_sync_lease
    CHECK (
      (sync_lease_id IS NULL AND sync_lease_expires_at IS NULL)
      OR (sync_lease_id IS NOT NULL AND sync_lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT fk_marketplace_creator_platform_connections_authorization
    FOREIGN KEY (
      authorization_id,
      creator_profile_id,
      organization_id,
      platform,
      provider
    )
    REFERENCES marketplace.creator_platform_authorizations(
      id,
      creator_profile_id,
      organization_id,
      platform,
      provider
    ),
  CONSTRAINT fk_marketplace_creator_platform_connections_platform
    FOREIGN KEY (platform_id, creator_profile_id, organization_id, platform)
    REFERENCES marketplace.creator_platforms(
      id,
      creator_profile_id,
      organization_id,
      platform
    )
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_creator_platform_connections_creator_status
  ON marketplace.creator_platform_connections (
    creator_profile_id,
    organization_id,
    status
  );

CREATE INDEX idx_marketplace_creator_platform_connections_sync
  ON marketplace.creator_platform_connections (status, last_successful_sync_at);

CREATE TABLE marketplace.creator_platform_metric_snapshots (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id            UUID          NOT NULL,
  platform_id              UUID          NOT NULL,
  creator_profile_id       UUID          NOT NULL,
  organization_id          UUID          NOT NULL,
  captured_at              TIMESTAMPTZ   NOT NULL,
  window_days              SMALLINT      NOT NULL DEFAULT 30,
  window_start             DATE          NOT NULL,
  window_end               DATE          NOT NULL,
  follower_count           INTEGER,
  content_item_count       INTEGER,
  likes                    BIGINT,
  comments                 BIGINT,
  shares                   BIGINT,
  reach                    BIGINT,
  views                    BIGINT,
  engagement_rate          NUMERIC(24, 6),
  audience_countries       JSONB,
  audience_age_groups      JSONB,
  audience_gender_split    JSONB,
  imported_fields          TEXT[]        NOT NULL DEFAULT '{}',
  unavailable_fields       JSONB         NOT NULL DEFAULT '[]'::jsonb,
  formula_version          TEXT          NOT NULL DEFAULT 'creator-platform-engagement.v1',
  provider_metrics         JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_window
    CHECK (
      window_days IN (30, 90)
      AND window_end > window_start
      AND window_end - window_start = window_days
    ),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_counts
    CHECK (
      (follower_count IS NULL OR follower_count >= 0)
      AND (content_item_count IS NULL OR content_item_count >= 0)
      AND (likes IS NULL OR likes >= 0)
      AND (comments IS NULL OR comments >= 0)
      AND (shares IS NULL OR shares >= 0)
      AND (reach IS NULL OR reach >= 0)
      AND (views IS NULL OR views >= 0)
      AND (engagement_rate IS NULL OR engagement_rate >= 0)
    ),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_demographics
    CHECK (
      (audience_countries IS NULL OR jsonb_typeof(audience_countries) = 'array')
      AND (audience_age_groups IS NULL OR jsonb_typeof(audience_age_groups) = 'array')
      AND (
        audience_gender_split IS NULL
        OR jsonb_typeof(audience_gender_split) = 'object'
      )
    ),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_imported_fields
    CHECK (
      array_position(imported_fields, NULL) IS NULL
      AND imported_fields <@ ARRAY[
        'followerCount', 'reach', 'views', 'contentItemCount', 'likes',
        'comments', 'shares', 'engagementRate', 'audienceCountries',
        'audienceAgeGroups', 'audienceGenderSplit'
      ]::TEXT[]
    ),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_unavailable_fields
    CHECK (marketplace.jsonb_is_creator_platform_unavailable_fields(unavailable_fields)),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_formula
    CHECK (formula_version = 'creator-platform-engagement.v1'),
  CONSTRAINT chk_marketplace_creator_platform_snapshots_json_secrets
    CHECK (
      NOT marketplace.jsonb_has_creator_platform_secret(
        COALESCE(audience_countries, '[]'::jsonb)
      )
      AND NOT marketplace.jsonb_has_creator_platform_secret(
        COALESCE(audience_age_groups, '[]'::jsonb)
      )
      AND NOT marketplace.jsonb_has_creator_platform_secret(
        COALESCE(audience_gender_split, '{}'::jsonb)
      )
      AND NOT marketplace.jsonb_has_creator_platform_secret(provider_metrics)
    ),
  CONSTRAINT fk_marketplace_creator_platform_snapshots_connection
    FOREIGN KEY (connection_id, platform_id, creator_profile_id, organization_id)
    REFERENCES marketplace.creator_platform_connections(
      id,
      platform_id,
      creator_profile_id,
      organization_id
    )
    ON DELETE CASCADE
);

CREATE INDEX idx_marketplace_creator_platform_snapshots_connection_captured
  ON marketplace.creator_platform_metric_snapshots (connection_id, captured_at DESC);

CREATE INDEX idx_marketplace_creator_platform_snapshots_creator_captured
  ON marketplace.creator_platform_metric_snapshots (
    creator_profile_id,
    organization_id,
    captured_at DESC
  );
