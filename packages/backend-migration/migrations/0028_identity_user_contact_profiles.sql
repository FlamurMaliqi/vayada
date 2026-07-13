-- Migration: 0028_identity_user_contact_profiles
-- Owner: domain-identity
-- Stores the account contact details Vayada uses independently of hotel data.

ALTER TABLE identity.users
  ADD COLUMN phone TEXT,
  ADD COLUMN profile_picture_url TEXT,
  ADD COLUMN profile_picture_media_object_id TEXT;

ALTER TABLE identity.users
  ADD CONSTRAINT chk_identity_users_phone
  CHECK (
    phone IS NULL
    OR char_length(btrim(phone)) BETWEEN 5 AND 64
  ),
  ADD CONSTRAINT chk_identity_users_profile_picture_url
  CHECK (
    profile_picture_url IS NULL
    OR char_length(profile_picture_url) <= 2048
  ),
  ADD CONSTRAINT chk_identity_users_profile_picture_media_object_id
  CHECK (
    profile_picture_media_object_id IS NULL
    OR char_length(profile_picture_media_object_id) <= 2048
  );

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'identity.user.profile_image',
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.listing.gallery',
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
