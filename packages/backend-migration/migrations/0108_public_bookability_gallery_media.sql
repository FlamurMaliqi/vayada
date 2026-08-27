-- Migration: 0108_public_bookability_gallery_media
-- Owner: domain-distribution / domain-hotels
-- See: VAY-1219
--
-- Existing public-bookability rows predate typed media and can remain live
-- indefinitely. Rebuild only their media projection from the canonical
-- Catalog read model so the new gallery-only reader has an immediate,
-- deterministic rollout path.

WITH canonical_gallery AS (
  SELECT
    catalog.property_id,
    COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'type', 'gallery_image',
        'url', gallery.item ->> 'url',
        'alt', gallery.item ->> 'altText'
      )) ORDER BY gallery.ordinality)
      FROM (
        SELECT item, ordinality
        FROM jsonb_array_elements(catalog.media) WITH ORDINALITY media(item, ordinality)
        WHERE media.item ->> 'type' = 'gallery_image'
          AND NULLIF(media.item ->> 'url', '') IS NOT NULL
        ORDER BY ordinality
        LIMIT 10
      ) gallery
    ), '[]'::jsonb) AS media
  FROM hotel_catalog.property_public_profile_read_model catalog
)
UPDATE distribution.public_hotel_bookability_profiles profile
SET media = gallery.media,
    projected_at = now(),
    updated_at = now()
FROM canonical_gallery gallery
WHERE gallery.property_id = profile.property_id
  AND profile.media IS DISTINCT FROM gallery.media;
