-- Migration: 0129_production_legacy_media_migration
-- Owner: platform-media / VAY-1055
--
-- Durable evidence for the one-time legacy URL import. The source tuple is
-- intentionally the idempotency key: a later extraction may not silently
-- replace media imported from a different immutable source run.

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose = 'booking.header_logo'
      THEN media_visibility = 'public'
    WHEN media_purpose IN (
      'identity.user.profile_image',
      'booking.addon.image',
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.offer.media',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image',
      'finance.expense.receipt'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

CREATE TABLE platform.production_media_migration_runs (
  source_run_id          TEXT        PRIMARY KEY,
  inventory_sha256       TEXT        NOT NULL CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  config_sha256          TEXT        NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  status                 TEXT        NOT NULL
                                      CHECK (status IN ('running', 'blocked', 'completed')),
  planned_count          INTEGER     NOT NULL DEFAULT 0 CHECK (planned_count >= 0),
  completed_count        INTEGER     NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  missing_count          INTEGER     NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  corrupt_count          INTEGER     NOT NULL DEFAULT 0 CHECK (corrupt_count >= 0),
  failed_count           INTEGER     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  blocker_count          INTEGER     NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  report_checksum_sha256 TEXT        CHECK (
                                      report_checksum_sha256 IS NULL
                                      OR report_checksum_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  CONSTRAINT fk_production_media_migration_runs_source
    FOREIGN KEY (source_run_id)
    REFERENCES platform.source_extraction_runs(run_id),
  CONSTRAINT chk_production_media_migration_runs_completion
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL AND blocker_count = 0)
      OR (status <> 'completed' AND completed_at IS NULL)
    )
);

CREATE TABLE platform.production_media_migration_items (
  source_run_id          TEXT        NOT NULL,
  source_system          TEXT        NOT NULL
                                      CHECK (source_system IN ('booking', 'marketplace', 'pms')),
  source_table           TEXT        NOT NULL,
  source_row_id          TEXT        NOT NULL,
  purpose                TEXT        NOT NULL,
  source_field           TEXT        NOT NULL,
  source_url             TEXT        NOT NULL CHECK (source_url LIKE 'https://%'),
  source_updated_at      TIMESTAMPTZ NOT NULL,
  source_reference_sha256 TEXT       NOT NULL CHECK (source_reference_sha256 ~ '^[0-9a-f]{64}$'),
  media_object_id        UUID,
  item_status            TEXT        NOT NULL
                                      CHECK (item_status IN (
                                        'planned', 'processing', 'completed',
                                        'missing', 'corrupt', 'failed'
                                      )),
  attempt_count          INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code             TEXT,
  content_checksum_sha256 TEXT       CHECK (
                                      content_checksum_sha256 IS NULL
                                      OR content_checksum_sha256 ~ '^[0-9a-f]{64}$'
                                    ),
  size_bytes             BIGINT      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  evidence               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  PRIMARY KEY (source_run_id, source_system, source_table, source_row_id, purpose),
  CONSTRAINT fk_production_media_migration_items_run
    FOREIGN KEY (source_run_id)
    REFERENCES platform.production_media_migration_runs(source_run_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_production_media_migration_items_object
    FOREIGN KEY (media_object_id)
    REFERENCES platform.media_objects(id),
  CONSTRAINT chk_production_media_migration_items_completion
    CHECK (
      (
        item_status = 'completed'
        AND media_object_id IS NOT NULL
        AND content_checksum_sha256 IS NOT NULL
        AND completed_at IS NOT NULL
        AND error_code IS NULL
      )
      OR (
        item_status <> 'completed'
        AND completed_at IS NULL
        AND media_object_id IS NULL
      )
    )
);

CREATE INDEX idx_production_media_migration_items_status
  ON platform.production_media_migration_items (source_run_id, item_status, source_system, source_table);

CREATE INDEX idx_production_media_migration_items_source_url
  ON platform.production_media_migration_items (source_url);
