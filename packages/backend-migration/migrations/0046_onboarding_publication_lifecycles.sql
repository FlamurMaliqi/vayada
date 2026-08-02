-- Migration: 0046_onboarding_publication_lifecycles
-- Owner: domain-marketplace, domain-distribution
-- See: engineering/hotel-onboarding-information-inventory.md (ONB-02A)
-- Readiness hashes are recomputed by createReadyProductReadinessEvidence before
-- insert. PostgreSQL persists the complete evidence fields and enforces their
-- version, product, status, hash shape, manifest shape, and property binding.

CREATE TABLE marketplace.hotel_submission_revisions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID        NOT NULL,
  organization_id      UUID        NOT NULL,
  revision_number      INTEGER     NOT NULL CHECK (revision_number > 0),
  readiness_contract_version TEXT  NOT NULL
                                    CHECK (readiness_contract_version = 'onboarding-product-readiness.v1'),
  source_manifest      JSONB       NOT NULL,
  source_manifest_hash TEXT        NOT NULL CHECK (source_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_hash       TEXT        NOT NULL CHECK (readiness_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_product    TEXT        NOT NULL CHECK (readiness_product = 'marketplace'),
  readiness_status     TEXT        NOT NULL CHECK (readiness_status = 'ready'),
  submission_snapshot  JSONB       NOT NULL CHECK (jsonb_typeof(submission_snapshot) = 'object'),
  submitted_by_user_id UUID        NOT NULL REFERENCES identity.users(id),
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, revision_number),
  UNIQUE (id, property_id),
  CHECK (
    jsonb_typeof(source_manifest) = 'object'
    AND source_manifest->>'contractVersion' = 'onboarding-source-manifest.v1'
    AND source_manifest->>'propertyId' = property_id::TEXT
    AND CASE
      WHEN jsonb_typeof(source_manifest->'sources') = 'array'
      THEN jsonb_array_length(source_manifest->'sources') > 0
      ELSE FALSE
    END
  ),
  FOREIGN KEY (property_id, organization_id)
    REFERENCES marketplace.marketplace_hotel_profiles(property_id, organization_id)
);

CREATE TRIGGER trg_marketplace_hotel_submission_revisions_append_only
  BEFORE UPDATE OR DELETE ON marketplace.hotel_submission_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_marketplace_submission_revisions_no_truncate
  BEFORE TRUNCATE ON marketplace.hotel_submission_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

-- Submission revisions are private moderation snapshots. Public Marketplace
-- reads must project explicitly approved public fields rather than exposing them.
CREATE TABLE marketplace.hotel_submission_moderation (
  submission_revision_id UUID        PRIMARY KEY,
  property_id            UUID        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN (
                                     'pending', 'changes_requested', 'approved', 'rejected', 'withdrawn'
                                   )),
  decided_by_user_id     UUID        REFERENCES identity.users(id),
  decision_reason        TEXT,
  decided_at             TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      status = 'pending'
      AND decided_by_user_id IS NULL
      AND decision_reason IS NULL
      AND decided_at IS NULL
    )
    OR (status <> 'pending' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  UNIQUE (submission_revision_id, property_id, status),
  FOREIGN KEY (submission_revision_id, property_id)
    REFERENCES marketplace.hotel_submission_revisions(id, property_id)
);

CREATE TABLE marketplace.active_hotel_submission_revisions (
  property_id            UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  submission_revision_id UUID        NOT NULL UNIQUE,
  moderation_status      TEXT        NOT NULL DEFAULT 'approved' CHECK (moderation_status = 'approved'),
  activation_status      TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (activation_status IN ('active', 'suspended', 'deactivated')),
  activated_by_user_id   UUID        NOT NULL REFERENCES identity.users(id),
  activated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_by_user_id UUID      NOT NULL REFERENCES identity.users(id),
  status_reason          TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (submission_revision_id, property_id, moderation_status)
    REFERENCES marketplace.hotel_submission_moderation(submission_revision_id, property_id, status)
);

CREATE TABLE distribution.public_booking_content_revisions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  revision_number      INTEGER     NOT NULL CHECK (revision_number > 0),
  readiness_contract_version TEXT  NOT NULL
                                    CHECK (readiness_contract_version = 'onboarding-product-readiness.v1'),
  source_manifest      JSONB       NOT NULL,
  source_manifest_hash TEXT        NOT NULL CHECK (source_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_hash       TEXT        NOT NULL CHECK (readiness_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_product    TEXT        NOT NULL CHECK (readiness_product = 'booking'),
  readiness_status     TEXT        NOT NULL CHECK (readiness_status = 'ready'),
  public_content       JSONB       NOT NULL CHECK (jsonb_typeof(public_content) = 'object'),
  built_by_user_id     UUID        NOT NULL REFERENCES identity.users(id),
  built_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, revision_number),
  UNIQUE (id, property_id),
  CHECK (
    jsonb_typeof(source_manifest) = 'object'
    AND source_manifest->>'contractVersion' = 'onboarding-source-manifest.v1'
    AND source_manifest->>'propertyId' = property_id::TEXT
    AND CASE
      WHEN jsonb_typeof(source_manifest->'sources') = 'array'
      THEN jsonb_array_length(source_manifest->'sources') > 0
      ELSE FALSE
    END
  ),
  CHECK (NOT distribution.jsonb_has_distribution_private_key(public_content))
);

CREATE TRIGGER trg_distribution_public_booking_content_revisions_append_only
  BEFORE UPDATE OR DELETE ON distribution.public_booking_content_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_distribution_booking_revisions_no_truncate
  BEFORE TRUNCATE ON distribution.public_booking_content_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TABLE distribution.active_public_booking_revision (
  property_id         UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  content_revision_id UUID        NOT NULL UNIQUE,
  activated_by_user_id UUID       NOT NULL REFERENCES identity.users(id),
  activated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (content_revision_id, property_id)
    REFERENCES distribution.public_booking_content_revisions(id, property_id)
);

CREATE TABLE distribution.live_ari_watermarks (
  property_id          UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  watermark_revision   INTEGER     NOT NULL DEFAULT 1 CHECK (watermark_revision > 0),
  -- Owner-defined opaque PMS/inventory revision; intentionally not a Booking content revision.
  source_revision      TEXT        NOT NULL CHECK (btrim(source_revision) <> ''),
  materialized_through DATE,
  observed_at          TIMESTAMPTZ NOT NULL,
  projected_at         TIMESTAMPTZ NOT NULL,
  CHECK (projected_at >= observed_at)
);
