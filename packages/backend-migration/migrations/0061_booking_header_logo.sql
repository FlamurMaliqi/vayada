-- Migration: 0061_booking_header_logo
-- Purpose: Add an explicit Booking-owned header logo and its platform-media purpose.

BEGIN;

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
      'pms.import.source_image'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

ALTER TABLE booking.booking_settings
  ADD COLUMN header_logo_url TEXT;

COMMENT ON COLUMN booking.booking_settings.header_logo_url IS
  'Nullable Booking-owned public CDN URL for the Booking Engine header. NULL preserves the property-name fallback.';

COMMIT;
