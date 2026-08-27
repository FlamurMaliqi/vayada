import type pg from "pg";

export async function transformMarketplace(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT id, email, name, status
    FROM migration_source_marketplace.users
  `);

  await client.query(`
    INSERT INTO identity.organizations
      (id, kind, name, slug, status, workos_org_id, workos_external_id)
    SELECT id, kind, name, slug, status, workos_org_id, workos_external_id
    FROM migration_source_marketplace.organizations
  `);

  await client.query(`
    INSERT INTO identity.organization_memberships
      (id, organization_id, user_id, status, role_key, property_access_mode, access_origin, workos_membership_id, workos_role_slugs)
    SELECT
      memberships.id,
      memberships.organization_id,
      memberships.user_id,
      memberships.status,
      memberships.role_key,
      CASE
        WHEN organizations.kind = 'hotel_group'
          AND memberships.role_key IN ('hotel_owner', 'owner', 'operator') THEN 'all'
        ELSE 'assigned'
      END,
      'agency',
      memberships.workos_membership_id,
      memberships.workos_role_slugs
    FROM migration_source_marketplace.organization_memberships memberships
    LEFT JOIN migration_source_marketplace.organizations organizations
      ON organizations.id = memberships.organization_id
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (id, organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      id,
      organization_id,
      product,
      CASE WHEN resource_type = 'hotel_listing' THEN 'marketplace_offer' ELSE resource_type END,
      resource_id,
      relationship,
      status
    FROM migration_source_marketplace.organization_resource_links
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      link.organization_id,
      link.product,
      link.resource_type,
      link.resource_id,
      'operator',
      link.status
    FROM identity.organization_resource_links link
    WHERE link.product = 'marketplace'
      AND link.resource_type = 'marketplace_offer'
      AND link.relationship = 'owner'
    ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
    DO UPDATE SET status = EXCLUDED.status, updated_at = now()
  `);

  await client.query(`
    INSERT INTO identity.product_entitlements
      (
        id,
        organization_id,
        product,
        entitlement_key,
        status,
        resource_product,
        resource_type,
        resource_id,
        starts_at,
        metadata
      )
    SELECT
      id,
      organization_id,
      product,
      CASE
        WHEN entitlement_key = 'marketplace-hotel-listing' THEN 'marketplace-offer'
        ELSE entitlement_key
      END,
      status,
      resource_product,
      CASE WHEN resource_type = 'hotel_listing' THEN 'marketplace_offer' ELSE resource_type END,
      resource_id,
      starts_at,
      metadata
    FROM migration_source_marketplace.product_entitlements
  `);

  await client.query(`
    INSERT INTO hotel_catalog.properties
      (
        id,
        public_id,
        display_name,
        property_type,
        category,
        default_locale,
        supported_locales,
        profile_status,
        completeness_reasons
      )
    SELECT
      id,
      public_id,
      display_name,
      property_type,
      category,
      default_locale,
      supported_locales,
      profile_status,
      completeness_reasons
    FROM migration_source_marketplace.properties
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT id, property_id, source_system, source_table, source_id, relationship, metadata
    FROM migration_source_marketplace.property_source_links
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status)
    SELECT id, property_id, slug, locale, purpose, status
    FROM migration_source_marketplace.property_slugs
  `);

  await client.query(`
    INSERT INTO finance.commission_rules
      (
        id,
        property_id,
        organization_id,
        rule_scope,
        product,
        commission_type,
        percentage_rate,
        currency,
        status,
        starts_at,
        source_system,
        source_rule_id,
        rule_metadata
      )
    SELECT
      id,
      property_id,
      organization_id,
      rule_scope,
      product,
      commission_type,
      percentage_rate,
      currency,
      status,
      starts_at,
      source_system,
      source_rule_id,
      rule_metadata
    FROM migration_source_marketplace.commission_rules
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
        location_text,
        short_description,
        portfolio_url,
        phone,
        profile_picture_url,
        profile_complete,
        profile_completed_at,
        profile_status,
        profile_metadata,
        pii_retention_until,
        created_at,
        updated_at
      )
    SELECT
      id,
      organization_id,
      owner_user_id,
      'migration',
      source_creator_id,
      display_name,
      creator_type,
      location_text,
      short_description,
      portfolio_url,
      phone,
      profile_picture_url,
      profile_complete,
      profile_completed_at,
      profile_status,
      profile_metadata,
      pii_retention_until,
      created_at,
      updated_at
    FROM migration_source_marketplace.creators
  `);

  await client.query(`
    INSERT INTO marketplace.creator_platforms
      (
        id,
        creator_profile_id,
        organization_id,
        source_system,
        source_platform_id,
        platform,
        handle,
        profile_url,
        follower_count,
        engagement_rate,
        audience_countries,
        audience_age_groups,
        audience_gender_split,
        verification_status,
        platform_metadata,
        created_at,
        updated_at
      )
    SELECT
      platform.id,
      creator.id,
      creator.organization_id,
      'migration',
      platform.source_platform_id,
      platform.platform,
      platform.handle,
      platform.profile_url,
      platform.follower_count,
      platform.engagement_rate,
      platform.audience_countries,
      platform.audience_age_groups,
      platform.audience_gender_split,
      platform.verification_status,
      platform.platform_metadata,
      platform.created_at,
      platform.updated_at
    FROM migration_source_marketplace.creator_platforms platform
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = platform.source_creator_id
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_hotel_profiles
      (
        property_id,
        organization_id,
        source_system,
        source_hotel_profile_id,
        marketplace_profile_status,
        profile_complete,
        profile_completed_at,
        host_summary,
        collaboration_guidelines,
        marketplace_metadata,
        created_at,
        updated_at
      )
    SELECT
      property_id,
      organization_id,
      'migration',
      source_hotel_profile_id,
      marketplace_profile_status,
      profile_complete,
      profile_completed_at,
      host_summary,
      collaboration_guidelines,
      marketplace_metadata,
      created_at,
      updated_at
    FROM migration_source_marketplace.hotel_profiles
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
        raw_location_text,
        image_urls,
        offer_metadata,
        created_at,
        updated_at
      )
    SELECT
      listing.id,
      profile.property_id,
      profile.organization_id,
      'migration',
      listing.source_listing_id,
      listing.title,
      listing.listing_summary,
      listing.accommodation_type,
      listing.listing_status,
      listing.raw_location_text,
      listing.image_urls,
      listing.listing_metadata,
      listing.created_at,
      listing.updated_at
    FROM migration_source_marketplace.hotel_listings listing
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
  `);

  await client.query(`
    INSERT INTO marketplace.offer_compensation_options
      (
        id,
        offer_id,
        property_id,
        organization_id,
        source_system,
        source_compensation_option_id,
        compensation_type,
        availability_months,
        platforms,
        free_stay_min_nights,
        free_stay_max_nights,
        paid_max_amount,
        discount_percentage,
        commission_percentage,
        min_followers,
        currency,
        terms_summary,
        compensation_metadata,
        created_at,
        updated_at
      )
    SELECT
      offering.id,
      listing.id,
      profile.property_id,
      profile.organization_id,
      'migration',
      offering.source_offering_id,
      offering.collaboration_type,
      offering.availability_months,
      offering.platforms,
      offering.free_stay_min_nights,
      offering.free_stay_max_nights,
      offering.paid_max_amount,
      offering.discount_percentage,
      offering.commission_percentage,
      offering.min_followers,
      offering.currency,
      offering.terms_summary,
      offering.offering_metadata,
      offering.created_at,
      offering.updated_at
    FROM migration_source_marketplace.listing_collaboration_offerings offering
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = offering.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
  `);

  await client.query(`
    INSERT INTO marketplace.offer_creator_requirements
      (
        id,
        offer_id,
        property_id,
        organization_id,
        source_system,
        source_requirement_id,
        platforms,
        target_countries,
        target_age_min,
        target_age_max,
        target_age_groups,
        creator_types,
        requirement_metadata,
        created_at,
        updated_at
      )
    SELECT
      requirement.id,
      listing.id,
      profile.property_id,
      profile.organization_id,
      'migration',
      requirement.source_requirement_id,
      requirement.platforms,
      requirement.target_countries,
      requirement.target_age_min,
      requirement.target_age_max,
      requirement.target_age_groups,
      requirement.creator_types,
      requirement.requirement_metadata,
      requirement.created_at,
      requirement.updated_at
    FROM migration_source_marketplace.listing_creator_requirements requirement
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = requirement.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
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
        commission_rule_id,
        source_system,
        source_collaboration_id,
        initiator_type,
        lifecycle_status,
        compensation_type,
        application_message,
        negotiated_terms,
        platform_deliverables,
        preferred_months,
        travel_date_from,
        travel_date_to,
        preferred_date_from,
        preferred_date_to,
        free_stay_min_nights,
        free_stay_max_nights,
        paid_amount,
        discount_percentage,
        affiliate_commission_percentage,
        affiliate_enabled,
        currency,
        affiliate_referral_code,
        affiliate_link,
        creator_consent,
        hotel_agreed_at,
        creator_agreed_at,
        term_last_updated_at,
        responded_at,
        cancelled_at,
        completed_at,
        collaboration_metadata,
        created_at,
        updated_at
      )
    SELECT
      collaboration.id,
      creator.id,
      creator.organization_id,
      profile.property_id,
      profile.organization_id,
      listing.id,
      commission_rule.id,
      'migration',
      collaboration.source_collaboration_id,
      collaboration.initiator_type,
      collaboration.lifecycle_status,
      CASE
        WHEN collaboration.collaboration_type = 'affiliate' THEN NULL
        ELSE collaboration.collaboration_type
      END,
      collaboration.application_message,
      collaboration.negotiated_terms,
      collaboration.platform_deliverables,
      collaboration.preferred_months,
      collaboration.travel_date_from,
      collaboration.travel_date_to,
      collaboration.preferred_date_from,
      collaboration.preferred_date_to,
      collaboration.free_stay_min_nights,
      collaboration.free_stay_max_nights,
      collaboration.paid_amount,
      collaboration.discount_percentage,
      collaboration.creator_fee,
      (
        collaboration.collaboration_type = 'affiliate'
        OR collaboration.source_commission_rule_id IS NOT NULL
        OR collaboration.affiliate_referral_code IS NOT NULL
        OR collaboration.affiliate_link IS NOT NULL
      ),
      collaboration.currency,
      collaboration.affiliate_referral_code,
      collaboration.affiliate_link,
      collaboration.creator_consent,
      collaboration.hotel_agreed_at,
      collaboration.creator_agreed_at,
      collaboration.term_last_updated_at,
      collaboration.responded_at,
      collaboration.cancelled_at,
      collaboration.completed_at,
      collaboration.collaboration_metadata,
      collaboration.created_at,
      collaboration.updated_at
    FROM migration_source_marketplace.collaborations collaboration
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = collaboration.source_creator_id
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = collaboration.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
    LEFT JOIN migration_source_marketplace.commission_rules commission_rule
      ON commission_rule.source_rule_id = collaboration.source_commission_rule_id
  `);

  await client.query(`
    INSERT INTO marketplace.creator_ratings
      (
        id,
        creator_profile_id,
        creator_organization_id,
        property_id,
        hotel_organization_id,
        collaboration_id,
        rating,
        comment,
        created_by_user_id,
        created_at,
        updated_at
      )
    SELECT
      rating.id,
      creator.id,
      creator.organization_id,
      profile.property_id,
      profile.organization_id,
      collaboration.id,
      rating.rating,
      rating.comment,
      rating.created_by_user_id,
      rating.created_at,
      rating.updated_at
    FROM migration_source_marketplace.creator_ratings rating
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = rating.source_creator_id
    JOIN migration_source_marketplace.collaborations collaboration
      ON collaboration.source_collaboration_id = rating.source_collaboration_id
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = collaboration.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
  `);

  await client.query(`
    INSERT INTO marketplace.collaboration_deliverables
      (
        id,
        collaboration_id,
        property_id,
        platform,
        deliverable_type,
        quantity,
        deliverable_status,
        due_at,
        submitted_at,
        completed_at,
        content_url,
        review_notes,
        deliverable_metadata,
        created_at,
        updated_at
      )
    SELECT
      deliverable.id,
      collaboration.id,
      profile.property_id,
      deliverable.platform,
      deliverable.deliverable_type,
      deliverable.quantity,
      deliverable.deliverable_status,
      deliverable.due_at,
      deliverable.submitted_at,
      deliverable.completed_at,
      deliverable.content_url,
      deliverable.review_notes,
      deliverable.deliverable_metadata,
      deliverable.created_at,
      deliverable.updated_at
    FROM migration_source_marketplace.collaboration_deliverables deliverable
    JOIN migration_source_marketplace.collaborations collaboration
      ON collaboration.source_collaboration_id = deliverable.source_collaboration_id
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = collaboration.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
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
        read_at,
        pii_retention_until,
        created_at
      )
    SELECT
      message.id,
      collaboration.id,
      profile.property_id,
      message.sender_user_id,
      message.sender_type,
      message.message_type,
      message.body,
      message.message_metadata,
      message.read_at,
      message.pii_retention_until,
      message.created_at
    FROM migration_source_marketplace.chat_messages message
    JOIN migration_source_marketplace.collaborations collaboration
      ON collaboration.source_collaboration_id = message.source_collaboration_id
    JOIN migration_source_marketplace.hotel_listings listing
      ON listing.source_listing_id = collaboration.source_listing_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
  `);

  await client.query(`
    INSERT INTO marketplace.trips
      (
        id,
        creator_profile_id,
        organization_id,
        source_system,
        source_trip_id,
        name,
        location_text,
        start_date,
        end_date,
        notes,
        trip_metadata,
        created_at,
        updated_at
      )
    SELECT
      trip.id,
      creator.id,
      creator.organization_id,
      'migration',
      trip.source_trip_id,
      trip.name,
      trip.location_text,
      trip.start_date,
      trip.end_date,
      trip.notes,
      trip.trip_metadata,
      trip.created_at,
      trip.updated_at
    FROM migration_source_marketplace.trips trip
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = trip.source_creator_id
  `);

  await client.query(`
    INSERT INTO marketplace.external_collaborations
      (
        id,
        creator_profile_id,
        organization_id,
        trip_id,
        source_system,
        source_external_collaboration_id,
        title,
        hotel_name,
        location_text,
        collaboration_type,
        start_date,
        end_date,
        deliverables_summary,
        notes,
        external_metadata,
        created_at,
        updated_at
      )
    SELECT
      external_collaboration.id,
      creator.id,
      creator.organization_id,
      trip.id,
      'migration',
      external_collaboration.source_external_collaboration_id,
      external_collaboration.title,
      external_collaboration.hotel_name,
      external_collaboration.location_text,
      external_collaboration.collaboration_type,
      external_collaboration.start_date,
      external_collaboration.end_date,
      external_collaboration.deliverables_summary,
      external_collaboration.notes,
      external_collaboration.external_metadata,
      external_collaboration.created_at,
      external_collaboration.updated_at
    FROM migration_source_marketplace.external_collaborations external_collaboration
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = external_collaboration.source_creator_id
    LEFT JOIN migration_source_marketplace.trips trip
      ON trip.source_trip_id = external_collaboration.source_trip_id
     AND trip.source_creator_id = external_collaboration.source_creator_id
  `);

  await client.query(`
    INSERT INTO marketplace.marketplace_notifications
      (
        id,
        recipient_user_id,
        organization_id,
        notification_type,
        title,
        body,
        link_url,
        resource_type,
        resource_id,
        notification_metadata,
        read_at,
        created_at
      )
    SELECT
      id,
      recipient_user_id,
      organization_id,
      notification_type,
      title,
      body,
      link_url,
      resource_type,
      resource_id,
      notification_metadata,
      read_at,
      created_at
    FROM migration_source_marketplace.notifications
  `);

  await client.query(`
    INSERT INTO marketplace.invite_codes
      (
        id,
        code,
        invite_type,
        status,
        payload,
        created_by_user_id,
        redeemed_by_user_id,
        creator_profile_id,
        creator_organization_id,
        property_id,
        redeemed_at,
        expires_at,
        created_at
      )
    SELECT
      invite.id,
      invite.code,
      invite.invite_type,
      invite.status,
      invite.payload,
      invite.created_by_user_id,
      invite.redeemed_by_user_id,
      creator.id,
      creator.organization_id,
      profile.property_id,
      invite.redeemed_at,
      invite.expires_at,
      invite.created_at
    FROM migration_source_marketplace.invite_codes invite
    JOIN migration_source_marketplace.creators creator
      ON creator.source_creator_id = invite.source_creator_id
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = invite.source_hotel_profile_id
  `);

  await client.query(`
    INSERT INTO marketplace.newsletter_preferences
      (
        id,
        user_id,
        organization_id,
        enabled,
        country_filter,
        source_system,
        source_preference_id,
        created_at,
        updated_at
      )
    SELECT
      id,
      user_id,
      organization_id,
      enabled,
      country_filter,
      'migration',
      source_preference_id,
      created_at,
      updated_at
    FROM migration_source_marketplace.newsletter_preferences
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
        location,
        image_urls,
        public_compensation_summary,
        public_creator_requirements,
        source_freshness,
        projected_at
      )
    SELECT
      listing.id,
      profile.property_id,
      listing.source_listing_id,
      slug.slug,
      property.display_name,
      listing.title,
      listing.listing_summary,
      listing.accommodation_type,
      listing.visibility_status,
      listing.public_location,
      listing.image_urls,
      compensation_summary.public_compensation_summary,
      jsonb_build_object(
        'platforms', to_jsonb(requirement.platforms),
        'countries', to_jsonb(requirement.target_countries),
        'ageGroups', to_jsonb(requirement.target_age_groups),
        'creatorTypes', to_jsonb(requirement.creator_types),
        'minFollowers', compensation_summary.minimum_followers
      ),
      listing.source_freshness,
      listing.projected_at
    FROM migration_source_marketplace.hotel_listings listing
    JOIN migration_source_marketplace.hotel_profiles profile
      ON profile.source_hotel_profile_id = listing.source_hotel_profile_id
    JOIN migration_source_marketplace.properties property
      ON property.id = profile.property_id
    JOIN migration_source_marketplace.property_slugs slug
      ON slug.property_id = profile.property_id
     AND slug.status = 'active'
     AND slug.purpose = 'marketplace_overlay'
    JOIN migration_source_marketplace.listing_creator_requirements requirement
      ON requirement.source_listing_id = listing.source_listing_id
    JOIN LATERAL (
      SELECT
        jsonb_agg(
          CASE
            WHEN offering.collaboration_type = 'free_stay'
              THEN jsonb_build_object(
                'type', offering.collaboration_type,
                'months', to_jsonb(offering.availability_months),
                'nights', jsonb_build_object(
                  'min', offering.free_stay_min_nights,
                  'max', offering.free_stay_max_nights
                ),
                'platforms', to_jsonb(offering.platforms)
              )
            WHEN offering.collaboration_type = 'affiliate'
              THEN jsonb_build_object(
                'type', offering.collaboration_type,
                'commissionPercent', offering.commission_percentage::integer,
                'platforms', to_jsonb(offering.platforms)
              )
            ELSE jsonb_build_object(
              'type', offering.collaboration_type,
              'platforms', to_jsonb(offering.platforms)
            )
          END
          ORDER BY offering.public_sort_order
        ) AS public_compensation_summary,
        max(offering.min_followers) AS minimum_followers
      FROM migration_source_marketplace.listing_collaboration_offerings offering
      WHERE offering.source_listing_id = listing.source_listing_id
    ) compensation_summary ON TRUE
  `);
}
