-- Migration: 0012_booking_settings
-- Owner: domain-booking
-- See: engineering/booking-settings-write-contracts.md, engineering/apps-api-legacy-runtime-dependency-audit.md
--
-- Adds the target Booking settings write/read model used by apps/api behind
-- BOOKING_SETTINGS_SOURCE=target. Legacy booking_hotels remains production
-- source of truth until the cutover write-freeze and final settings snapshot.

CREATE TABLE booking.booking_settings (
  property_id                 UUID        PRIMARY KEY
                                          REFERENCES hotel_catalog.properties(id)
                                          ON DELETE CASCADE,
  show_addons_step            BOOLEAN     NOT NULL DEFAULT TRUE,
  group_addons_by_category    BOOLEAN     NOT NULL DEFAULT TRUE,
  special_requests_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  arrival_time_enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
  guest_count_enabled         BOOLEAN     NOT NULL DEFAULT FALSE,
  benefits                    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  default_currency            CHAR(3)     NOT NULL DEFAULT 'EUR',
  default_language            TEXT        NOT NULL DEFAULT 'en',
  supported_currencies        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  supported_languages         TEXT[]      NOT NULL DEFAULT ARRAY['en']::TEXT[],
  booking_filters             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  custom_filters              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  filter_rooms                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_booking_settings_benefits_array
    CHECK (jsonb_typeof(benefits) = 'array'),
  CONSTRAINT chk_booking_settings_default_currency_upper
    CHECK (default_currency = upper(default_currency)),
  CONSTRAINT chk_booking_settings_default_language
    CHECK (default_language ~ '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$'),
  CONSTRAINT chk_booking_settings_booking_filters_array
    CHECK (jsonb_typeof(booking_filters) = 'array'),
  CONSTRAINT chk_booking_settings_custom_filters_object
    CHECK (jsonb_typeof(custom_filters) = 'object'),
  CONSTRAINT chk_booking_settings_filter_rooms_object
    CHECK (jsonb_typeof(filter_rooms) = 'object'),
  CONSTRAINT chk_booking_settings_source_freshness_object
    CHECK (jsonb_typeof(source_freshness) = 'object')
);

CREATE INDEX idx_booking_settings_updated_at
  ON booking.booking_settings (updated_at DESC);
