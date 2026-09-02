import type pg from "pg";

export async function transformMediaUrlMigration(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT id, email, name, status
    FROM migration_source_media.users
  `);

  await client.query(`
    INSERT INTO identity.organizations (id, kind, name, slug, status)
    SELECT id, kind, name, slug, status
    FROM migration_source_media.organizations
  `);

  await client.query(`
    INSERT INTO hotel_catalog.properties
      (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status)
    SELECT
      id,
      public_id,
      display_name,
      property_type,
      category,
      default_locale,
      supported_locales,
      profile_status
    FROM migration_source_media.properties
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT id, property_id, source_system, source_table, source_id, relationship, metadata
    FROM migration_source_media.property_source_links
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs (id, property_id, slug, purpose, status)
    SELECT id, property_id, slug, purpose, status
    FROM migration_source_media.property_slugs
  `);

  await client.query(`
    INSERT INTO marketplace.creator_profiles
      (
        id,
        organization_id,
        owner_user_id,
        source_system,
        source_creator_id,
        display_name,
        creator_type,
        profile_picture_url,
        profile_complete,
        profile_status
      )
    SELECT
      id,
      organization_id,
      owner_user_id,
      'migration',
      source_creator_id,
      display_name,
      creator_type,
      profile_picture_url,
      profile_complete,
      profile_status
    FROM migration_source_media.marketplace_creators
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_hotel_profiles
      (
        property_id,
        organization_id,
        source_system,
        source_hotel_profile_id,
        marketplace_profile_status,
        profile_complete
      )
    SELECT
      property_id,
      organization_id,
      'migration',
      source_hotel_profile_id,
      marketplace_profile_status,
      profile_complete
    FROM migration_source_media.marketplace_hotel_profiles
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_offers
      (
        id,
        property_id,
        organization_id,
        source_system,
        source_offer_id,
        title,
        offer_summary,
        accommodation_type,
        offer_status,
        image_urls
      )
    SELECT
      id,
      property_id,
      organization_id,
      'migration',
      source_listing_id,
      title,
      listing_summary,
      accommodation_type,
      listing_status,
      image_urls
    FROM migration_source_media.marketplace_hotel_listings
  `);

  await client.query(`
    INSERT INTO marketplace.collaborations
      (
        id,
        creator_profile_id,
        creator_organization_id,
        property_id,
        hotel_organization_id,
        offer_id,
        source_system,
        source_collaboration_id,
        initiator_type,
        lifecycle_status,
        compensation_type,
        free_stay_min_nights,
        free_stay_max_nights,
        currency,
        creator_consent
      )
    SELECT
      id,
      creator_profile_id,
      creator_organization_id,
      property_id,
      hotel_organization_id,
      listing_id,
      'migration',
      source_collaboration_id,
      initiator_type,
      lifecycle_status,
      collaboration_type,
      free_stay_min_nights,
      free_stay_max_nights,
      currency,
      creator_consent
    FROM migration_source_media.marketplace_collaborations
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_chat_messages
      (
        id,
        collaboration_id,
        property_id,
        sender_user_id,
        sender_type,
        message_type,
        body,
        message_metadata,
        created_at
      )
    SELECT
      id,
      collaboration_id,
      property_id,
      sender_user_id,
      sender_type,
      message_type,
      body,
      message_metadata,
      created_at
    FROM migration_source_media.marketplace_chat_messages
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_offer_read_model
      (
        offer_id,
        property_id,
        public_id,
        canonical_slug,
        display_name,
        offer_title,
        offer_summary,
        accommodation_type,
        visibility_status,
        image_urls,
        source_freshness
      )
    SELECT
      listing.id,
      listing.property_id,
      property.public_id,
      slug.slug,
      property.display_name,
      listing.title,
      listing.listing_summary,
      listing.accommodation_type,
      'public',
      listing.image_urls,
      '{"source": "media-url-migration"}'::jsonb
    FROM migration_source_media.marketplace_hotel_listings listing
    JOIN migration_source_media.properties property
      ON property.id = listing.property_id
    JOIN migration_source_media.property_slugs slug
      ON slug.property_id = listing.property_id
     AND slug.purpose = 'marketplace_overlay'
     AND slug.status = 'active'
  `);

  await client.query(`
    INSERT INTO pms.room_types
      (
        id,
        property_id,
        source_system,
        source_room_type_id,
        name,
        description,
        category,
        occupancy_limits,
        room_attributes,
        amenities_snapshot,
        media_snapshot,
        base_rate_amount,
        currency,
        active,
        sort_order
      )
    SELECT
      id,
      property_id,
      'migration',
      source_room_type_id,
      name,
      description,
      category,
      occupancy_limits,
      room_attributes,
      amenities_snapshot,
      media_snapshot,
      base_rate_amount,
      currency,
      active,
      sort_order
    FROM migration_source_media.pms_room_types
  `);

  await client.query(`
    INSERT INTO pms.message_threads
      (
        id,
        property_id,
        guest_booking_id,
        source,
        source_thread_id,
        provider_channel,
        delivery_channel,
        attention_state,
        done_at,
        done_reason,
        conversation_context_state,
        unread_count
      )
    SELECT
      id,
      property_id,
      NULL,
      source,
      source_thread_id,
      channel,
      CASE WHEN source = 'manual' THEN 'email' ELSE 'ota' END,
      CASE WHEN status = 'open' THEN 'needs_attention' ELSE 'done' END,
      CASE WHEN status = 'open' THEN NULL ELSE now() END,
      CASE status
        WHEN 'no_reply_needed' THEN 'legacy_no_reply_needed'
        WHEN 'closed' THEN 'legacy_closed'
      END,
      'unlinked',
      unread_count
    FROM migration_source_media.pms_message_threads
  `);

  await client.query(`
    INSERT INTO pms.messages
      (
        id,
        property_id,
        thread_id,
        source_message_id,
        direction,
        sender_type,
        sender_user_id,
        sender_display_name,
        body,
        sent_at,
        received_at,
        raw_payload
      )
    SELECT
      id,
      property_id,
      thread_id,
      source_message_id,
      direction,
      sender_type,
      sender_user_id,
      sender_display_name,
      body,
      sent_at,
      received_at,
      raw_payload
    FROM migration_source_media.pms_messages
  `);

  await client.query(`
    INSERT INTO pms.message_attachments
      (
        id,
        property_id,
        message_id,
        s3_key,
        source_url,
        filename,
        content_type,
        size_bytes,
        source_attachment_id
      )
    SELECT
      id,
      property_id,
      message_id,
      s3_key,
      source_url,
      filename,
      content_type,
      size_bytes,
      source_attachment_id
    FROM migration_source_media.pms_message_attachments
  `);

  await client.query(`
    INSERT INTO platform.media_objects
      (
        id,
        bucket,
        storage_key,
        storage_kind,
        visibility,
        purpose,
        owner_organization_id,
        property_id,
        resource_product,
        resource_type,
        resource_id,
        lifecycle_status,
        content_type,
        size_bytes,
        checksum_sha256,
        width_px,
        height_px,
        original_filename,
        source_url,
        source_system,
        source_table,
        source_row_id,
        source_metadata,
        public_approved,
        created_by_user_id
      )
    SELECT
      media_object_id,
      CASE WHEN storage_kind = 'vayada_managed' THEN platform_bucket ELSE NULL END,
      CASE WHEN storage_kind = 'vayada_managed' THEN target_storage_key ELSE NULL END,
      storage_kind,
      visibility,
      CASE
        WHEN purpose = 'marketplace.listing.gallery' THEN 'marketplace.offer.media'
        ELSE purpose
      END,
      owner_organization_id,
      property_id,
      resource_product,
      CASE
        WHEN resource_product = 'marketplace' AND resource_type = 'hotel_listing'
          THEN 'marketplace_offer'
        ELSE resource_type
      END,
      resource_id,
      CASE WHEN storage_kind = 'external_reference' THEN 'external_reference' ELSE 'active' END,
      content_type,
      size_bytes,
      checksum_sha256,
      width_px,
      height_px,
      original_filename,
      source_url,
      source_system,
      source_table,
      source_row_id,
      source_metadata || jsonb_build_object(
        'sourceField', source_field,
        'legacyBucket', legacy_bucket,
        'legacyKey', legacy_key,
        'migrationCase', 'media-url-migration'
      ),
      public_approved,
      created_by_user_id
    FROM migration_source_media.legacy_media_urls
  `);

  await client.query(`
    INSERT INTO platform.media_variants
      (
        id,
        media_object_id,
        variant_name,
        visibility,
        storage_key,
        content_type,
        width_px,
        height_px,
        size_bytes,
        checksum_sha256,
        public_cdn_url
      )
    SELECT
      id,
      media_object_id,
      variant_name,
      visibility,
      storage_key,
      content_type,
      width_px,
      height_px,
      size_bytes,
      checksum_sha256,
      public_cdn_url
    FROM migration_source_media.media_variants
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_media
      (
        id,
        property_id,
        media_type,
        url,
        alt_text,
        sort_order,
        source_system,
        public_approved,
        rights_metadata,
        platform_media_object_id
      )
    SELECT
      id,
      property_id,
      media_type,
      url,
      alt_text,
      sort_order,
      source_system,
      public_approved,
      rights_metadata,
      platform_media_object_id
    FROM migration_source_media.booking_property_media
  `);

  await client.query(`
    WITH canonical_slugs AS (
      SELECT property_id, slug
      FROM hotel_catalog.property_slugs
      WHERE purpose = 'canonical'
        AND status = 'active'
    ),
    media AS (
      SELECT
        property_media.property_id,
        jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'id', property_media.id::text,
            'type', property_media.media_type,
            'url', variant.public_cdn_url,
            'altText', property_media.alt_text,
            'sortOrder', property_media.sort_order,
            'platformMediaObjectId', property_media.platform_media_object_id::text
          ))
          ORDER BY property_media.sort_order, property_media.id
        ) AS media
      FROM hotel_catalog.property_media property_media
      JOIN platform.media_objects media_object
        ON media_object.id = property_media.platform_media_object_id
       AND media_object.visibility = 'public'
       AND media_object.public_approved = TRUE
       AND media_object.lifecycle_status = 'active'
      JOIN platform.media_variants variant
        ON variant.media_object_id = media_object.id
       AND variant.visibility = 'public'
       AND variant.variant_name = 'original_safe'
      WHERE property_media.public_approved = TRUE
      GROUP BY property_media.property_id
    )
    INSERT INTO hotel_catalog.property_public_profile_read_model
      (
        property_id,
        public_id,
        display_name,
        canonical_slug,
        default_locale,
        supported_locales,
        profile_status,
        completeness_reasons,
        media,
        source_freshness
      )
    SELECT
      property.id,
      property.public_id,
      property.display_name,
      canonical_slugs.slug,
      property.default_locale,
      property.supported_locales,
      property.profile_status,
      '{}',
      COALESCE(media.media, '[]'::jsonb),
      '{"source": "media-url-migration"}'::jsonb
    FROM hotel_catalog.properties property
    JOIN canonical_slugs ON canonical_slugs.property_id = property.id
    LEFT JOIN media ON media.property_id = property.id
    ON CONFLICT (property_id) DO UPDATE SET
      media = EXCLUDED.media,
      source_freshness = EXCLUDED.source_freshness,
      projected_at = now()
  `);

  await client.query(`
    UPDATE marketplace.creator_profiles creator
    SET profile_picture_url = source.target_profile_picture_url
    FROM migration_source_media.marketplace_creator_profile_references source
    WHERE creator.id = source.creator_profile_id
  `);

  await client.query(`
    UPDATE marketplace.marketplace_offers offer
    SET image_urls = source.target_image_urls
    FROM migration_source_media.marketplace_listing_image_references source
    WHERE offer.id = source.listing_id
  `);

  await client.query(`
    UPDATE marketplace.marketplace_offer_read_model read_model
    SET image_urls = source.target_image_urls
    FROM migration_source_media.marketplace_listing_image_references source
    WHERE read_model.offer_id = source.listing_id
  `);

  await client.query(`
    UPDATE marketplace.marketplace_chat_messages message
    SET message_metadata = message.message_metadata || jsonb_build_object(
      'mediaObjectId', source.media_object_id,
      'attachmentSource', 'platform_media_migration'
    )
    FROM migration_source_media.marketplace_chat_media_references source
    WHERE message.id = source.message_id
  `);

  await client.query(`
    UPDATE platform.media_objects media
    SET retained_until = message.created_at + interval '2 years',
        source_metadata = media.source_metadata || jsonb_build_object(
          'retentionPolicy', 'chat-message-created-at-plus-2-years'
        ),
        updated_at = now()
    FROM marketplace.marketplace_chat_messages message
    WHERE media.purpose = 'marketplace.collaboration_chat.attachment'
      AND media.storage_kind = 'vayada_managed'
      AND media.resource_type = 'collaboration_chat_message'
      AND media.resource_id = message.id::text
      AND media.retained_until IS NULL
  `);

  await client.query(`
    UPDATE pms.room_types room_type
    SET media_snapshot = source.target_media_snapshot
    FROM migration_source_media.pms_room_media_references source
    WHERE room_type.id = source.room_type_id
  `);

  await client.query(`
    UPDATE pms.message_attachments attachment
    SET
      s3_key = source.target_s3_key,
      source_url = source.target_source_url,
      platform_media_object_id = source.platform_media_object_id
    FROM migration_source_media.pms_attachment_references source
    WHERE attachment.id = source.attachment_id
  `);
}
