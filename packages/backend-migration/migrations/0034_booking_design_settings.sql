-- Migration: 0034_booking_design_settings
-- Owner: domain-booking
--
-- Booking Engine presentation settings are product-specific overrides. The
-- canonical hotel name, description, and catalog media remain owned by
-- hotel_catalog and are used whenever an override is empty.

ALTER TABLE booking.booking_settings
  ADD COLUMN hero_image_url TEXT,
  ADD COLUMN hero_heading TEXT,
  ADD COLUMN hero_subtext TEXT,
  ADD COLUMN primary_color TEXT NOT NULL DEFAULT '#4F46E5',
  ADD COLUMN font_pairing TEXT NOT NULL DEFAULT 'high-end-serif';

ALTER TABLE booking.booking_settings
  ADD CONSTRAINT chk_booking_settings_primary_color
    CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT chk_booking_settings_font_pairing
    CHECK (font_pairing IN (
      'high-end-serif',
      'modern-minimalist',
      'grand-classic',
      'imperial-serif',
      'italiana-serif'
    ));
