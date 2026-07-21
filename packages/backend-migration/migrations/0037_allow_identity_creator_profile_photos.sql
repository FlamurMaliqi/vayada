-- Migration: 0037_allow_identity_creator_profile_photos
-- Owner: domain-marketplace
--
-- Creator onboarding can reuse the authenticated user's managed identity
-- profile image. Accept that media alongside creator-profile-owned media when
-- calculating marketplace profile completion.

CREATE OR REPLACE FUNCTION marketplace.creator_profile_is_complete(
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
