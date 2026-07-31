CREATE TABLE pms.channel_reviews (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  provider              TEXT        NOT NULL CHECK (provider IN ('channex', 'migration')),
  provider_review_id    TEXT        NOT NULL,
  channel               TEXT,
  guest_display_name    TEXT,
  rating                NUMERIC(4,2) CHECK (rating IS NULL OR rating >= 0),
  body                  TEXT        NOT NULL DEFAULT '',
  reply_body            TEXT,
  reviewed_at           TIMESTAMPTZ,
  provider_updated_at   TIMESTAMPTZ,
  provider_snapshot     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_reviews_provider
    UNIQUE (property_id, provider, provider_review_id)
);

CREATE INDEX idx_pms_channel_reviews_property_date
  ON pms.channel_reviews (property_id, COALESCE(reviewed_at, created_at) DESC);
