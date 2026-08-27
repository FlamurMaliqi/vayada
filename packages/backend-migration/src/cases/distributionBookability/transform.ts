import type pg from "pg";

export async function transformDistributionBookability(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT owner_user_id, owner_email, owner_name, owner_status
    FROM migration_source_distribution.bookability_snapshot_inputs
    UNION ALL
    SELECT platform_reviewer_user_id, platform_reviewer_email, platform_reviewer_name, platform_reviewer_status
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO identity.organizations
      (id, kind, name, slug, status, workos_org_id, workos_external_id)
    SELECT
      organization_id,
      organization_kind,
      organization_name,
      organization_slug,
      organization_status,
      workos_org_id,
      workos_external_id
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO identity.organization_memberships
      (id, organization_id, user_id, status, role_key, property_access_mode, access_origin, workos_membership_id, workos_role_slugs)
    SELECT
      membership_id,
      organization_id,
      owner_user_id,
      membership_status,
      role_key,
      'all',
      'agency',
      workos_membership_id,
      workos_role_slugs
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (id, organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      booking_resource_link_id,
      organization_id,
      'booking',
      'booking_hotel',
      booking_hotel_resource_id,
      'owner',
      'active'
    FROM migration_source_distribution.bookability_snapshot_inputs
    UNION ALL
    SELECT
      pms_resource_link_id,
      organization_id,
      'pms',
      'pms_hotel',
      pms_hotel_resource_id,
      'operator',
      'active'
    FROM migration_source_distribution.bookability_snapshot_inputs
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
      booking_entitlement_id,
      organization_id,
      'booking',
      'booking-engine',
      'active',
      'booking',
      'booking_hotel',
      booking_hotel_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_distribution.bookability_snapshot_inputs
    UNION ALL
    SELECT
      pms_entitlement_id,
      organization_id,
      'pms',
      'pms-core',
      'active',
      'pms',
      'pms_hotel',
      pms_hotel_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_distribution.bookability_snapshot_inputs
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
      property_id,
      property_public_id,
      property_display_name,
      property_type,
      property_category,
      default_locale,
      supported_locales,
      catalog_profile_status,
      completeness_reasons
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT
      booking_property_source_link_id,
      property_id,
      'booking',
      'booking_hotels',
      booking_hotel_resource_id,
      'canonical_input',
      source_metadata
    FROM migration_source_distribution.bookability_snapshot_inputs
    UNION ALL
    SELECT
      pms_property_source_link_id,
      property_id,
      'pms',
      'hotels',
      pms_hotel_resource_id,
      'operational_input',
      source_metadata
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status)
    SELECT property_slug_id, property_id, canonical_slug, NULL, 'canonical', 'active'
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
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
        location,
        descriptions,
        media,
        amenities,
        public_contacts,
        public_policy,
        source_freshness,
        projected_at
      )
    SELECT
      property_id,
      property_public_id,
      property_display_name,
      canonical_slug,
      default_locale,
      supported_locales,
      catalog_profile_status,
      completeness_reasons,
      catalog_location,
      catalog_descriptions,
      catalog_media,
      to_jsonb(amenity_keys),
      catalog_public_contacts,
      catalog_public_policy,
      catalog_source_freshness,
      catalog_projected_at
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO booking.quote_sessions
      (
        id,
        property_id,
        request_hash,
        public_quote_reference,
        requested_check_in,
        requested_check_out,
        adults,
        children,
        requested_room_count,
        currency,
        status,
        selected_offer_snapshot,
        totals,
        unavailable_reasons,
        policy_snapshot,
        source_freshness,
        promo_code,
        referral_code,
        expires_at,
        created_at,
        updated_at
      )
    SELECT
      quote_session_id,
      property_id,
      request_hash,
      public_quote_reference,
      requested_check_in,
      requested_check_out,
      adults,
      children,
      requested_room_count,
      currency,
      booking_quote_status,
      selected_offer_snapshot,
      booking_quote_totals,
      booking_quote_unavailable_reasons,
      booking_policy_snapshot,
      booking_source_freshness,
      promo_code,
      referral_code,
      quote_expires_at,
      quote_created_at,
      quote_updated_at
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO booking.checkout_contexts
      (
        id,
        quote_session_id,
        property_id,
        locale,
        currency,
        status,
        guest_input,
        selected_addons,
        payment_context,
        promo_context,
        expires_at,
        created_at,
        updated_at
      )
    SELECT
      checkout_context_id,
      quote_session_id,
      property_id,
      checkout_locale,
      currency,
      checkout_status,
      checkout_guest_input,
      selected_addons,
      checkout_payment_context,
      checkout_promo_context,
      checkout_expires_at,
      checkout_created_at,
      checkout_updated_at
    FROM migration_source_distribution.bookability_snapshot_inputs
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
        base_rate_amount,
        currency,
        active,
        sort_order,
        location_summary
      )
    SELECT
      room_type_id,
      property_id,
      'migration',
      source_room_type_id,
      room_type_name,
      room_type_description,
      room_type_category,
      room_occupancy_limits,
      room_attributes,
      room_amenities_snapshot,
      room_base_rate_amount,
      room_currency,
      room_active,
      room_type_sort_order,
      room_location_summary
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO pms.rooms
      (id, property_id, room_type_id, source_system, source_room_id, room_number, floor, status, sort_order, room_metadata)
    SELECT
      room_id,
      property_id,
      room_type_id,
      'migration',
      source_room_id,
      room_number,
      room_floor,
      room_status,
      room_sort_order,
      room_metadata
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO pms.rate_plans
      (
        id,
        property_id,
        room_type_id,
        code,
        name,
        rate_type,
        meal_plan,
        payment_policy,
        deposit_policy,
        cancellation_policy_snapshot,
        base_rate_amount,
        currency,
        active
      )
    SELECT
      rate_plan_id,
      property_id,
      room_type_id,
      rate_plan_code,
      rate_plan_name,
      rate_type,
      meal_plan,
      payment_policy,
      payment_deposit_policy,
      cancellation_policy_snapshot,
      rate_base_amount,
      rate_currency,
      rate_active
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO pms.inventory_days
      (property_id, room_type_id, stay_date, total_count, assigned_count, blocked_count, available_count, status, source_freshness)
    SELECT
      source.property_id,
      inventory."roomTypeId",
      inventory."stayDate",
      inventory."totalCount",
      inventory."assignedCount",
      inventory."blockedCount",
      inventory."availableCount",
      inventory.status,
      inventory."sourceFreshness"
    FROM migration_source_distribution.bookability_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.inventory_source_rows) AS inventory(
      "roomTypeId" uuid,
      "stayDate" date,
      "totalCount" integer,
      "assignedCount" integer,
      "blockedCount" integer,
      "availableCount" integer,
      status text,
      "sourceFreshness" jsonb
    )
  `);

  await client.query(`
    INSERT INTO finance.payment_provider_accounts
      (
        id,
        property_id,
        account_scope,
        provider,
        provider_account_id,
        status,
        onboarding_status,
        charges_enabled,
        payouts_enabled,
        default_currency,
        capabilities,
        account_metadata,
        sensitive_config_ref
      )
    SELECT
      provider_account_id,
      property_id,
      'property',
      provider,
      provider_account_ref,
      provider_account_status,
      provider_onboarding_status,
      charges_enabled,
      payouts_enabled,
      provider_default_currency,
      provider_capabilities,
      provider_account_metadata,
      sensitive_config_ref
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO finance.payment_settings
      (
        property_id,
        provider_account_id,
        payments_enabled,
        accepted_methods,
        default_currency,
        deposit_policy,
        refund_policy,
        tax_policy,
        statement_descriptor,
        source_system,
        source_settings_id
      )
    SELECT
      property_id,
      provider_account_id,
      payments_enabled,
      accepted_methods,
      default_currency,
      payment_deposit_policy,
      refund_policy,
      tax_policy,
      statement_descriptor,
      'booking',
      payment_settings_source_id
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO distribution.public_hotel_bookability_profiles
      (
        property_id,
        finance_payment_settings_property_id,
        public_id,
        canonical_slug,
        canonical_url,
        booking_base_url,
        custom_domain_url,
        timezone,
        default_locale,
        supported_locales,
        default_currency,
        supported_currencies,
        profile_status,
        public_identity,
        location,
        media,
        amenities,
        policies,
        capabilities,
        supported_quote_parameters,
        public_setup_completeness,
        source_freshness,
        freshness_status,
        data_sources,
        generated_at,
        projected_at,
        expires_at
      )
    SELECT
      property_id,
      property_id,
      property_public_id,
      canonical_slug,
      canonical_url,
      booking_base_url,
      custom_domain_url,
      timezone,
      default_locale,
      supported_locales,
      default_currency,
      supported_currencies,
      public_profile_status,
      jsonb_build_object(
        'propertyId', property_public_id,
        'slug', canonical_slug,
        'name', property_display_name,
        'summary', catalog_descriptions ->> 'summary'
      ),
      jsonb_build_object(
        'country', catalog_location ->> 'country',
        'city', catalog_location ->> 'city',
        'region', catalog_location ->> 'region',
        'latitude', catalog_location #> '{geo,latitude}',
        'longitude', catalog_location #> '{geo,longitude}'
      ),
      catalog_media,
      to_jsonb(amenity_keys),
      catalog_public_policy,
      jsonb_build_object(
        'instantBook', instant_book_enabled,
        'onlinePayment', online_payment_enabled,
        'payAtProperty', pay_at_property_enabled,
        'promoCodes', promo_codes_enabled,
        'referralCodes', referral_codes_enabled,
        'bookingDeepLinks', booking_deep_links_enabled
      ),
      jsonb_build_object(
        'minRooms', min_rooms,
        'maxRooms', max_rooms,
        'minAdults', min_adults,
        'maxAdults', max_adults,
        'childrenSupported', children_supported,
        'adultAgeThreshold', adult_age_threshold,
        'supportedCurrencies', supported_currencies,
        'supportedLocales', supported_locales
      ),
      jsonb_build_object('status', setup_status, 'missing', '[]'::jsonb),
      catalog_source_freshness || booking_source_freshness || pms_source_freshness || finance_source_freshness,
      public_freshness_status,
      ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']::text[],
      generated_at,
      generated_at,
      profile_expires_at
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO distribution.public_room_offer_snapshots
      (
        id,
        property_id,
        room_type_id,
        rate_plan_id,
        stay_date,
        public_offer_key,
        availability_status,
        sellable_publicly,
        available_rooms,
        base_price_amount,
        taxes_and_fees_amount,
        discounts_amount,
        currency,
        occupancy,
        room_summary,
        rate_summary,
        payment_options,
        public_policy,
        unavailable_reasons,
        source_freshness,
        freshness_status,
        data_sources,
        generated_at,
        expires_at
      )
    SELECT
      offer.id,
      source.property_id,
      source.room_type_id,
      source.rate_plan_id,
      offer."stayDate",
      offer."publicOfferKey",
      offer."availabilityStatus",
      offer."sellablePublicly",
      offer."availableRooms",
      offer."basePriceAmount",
      offer."taxesAndFeesAmount",
      offer."discountsAmount",
      source.currency,
      source.room_occupancy_limits,
      jsonb_strip_nulls(jsonb_build_object(
        'name', source.room_type_name,
        'category', source.room_type_category,
        'locationAddress', source.room_attributes ->> 'locationAddress',
        'latitude', source.room_attributes -> 'latitude',
        'longitude', source.room_attributes -> 'longitude',
        'amenities', source.room_amenities_snapshot
      )),
      jsonb_build_object(
        'name', source.rate_plan_name,
        'mealPlan', source.meal_plan,
        'cancellationSummary', source.catalog_public_policy ->> 'cancellationSummary'
      ),
      source.accepted_methods,
      jsonb_build_object(
        'depositSummary',
          CASE
            WHEN source.payment_deposit_policy ? 'depositPercent'
              THEN concat(source.payment_deposit_policy ->> 'depositPercent', '% deposit due at checkout.')
            ELSE COALESCE(source.payment_deposit_policy ->> 'summary', 'Deposit policy not specified.')
          END,
        'taxIncluded', (source.tax_policy ->> 'taxIncluded')::boolean
      ),
      ARRAY(SELECT jsonb_array_elements_text(offer."unavailableReasons")),
      source.pms_source_freshness || source.finance_source_freshness,
      source.public_freshness_status,
      ARRAY['booking', 'pms', 'finance', 'distribution']::text[],
      source.generated_at,
      source.profile_expires_at
    FROM migration_source_distribution.bookability_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.room_offer_source_rows) AS offer(
      id uuid,
      "stayDate" date,
      "publicOfferKey" text,
      "availabilityStatus" text,
      "sellablePublicly" boolean,
      "availableRooms" integer,
      "basePriceAmount" numeric,
      "taxesAndFeesAmount" numeric,
      "discountsAmount" numeric,
      "unavailableReasons" jsonb
    )
  `);

  await client.query(`
    INSERT INTO distribution.public_quote_read_models
      (
        quote_session_id,
        property_id,
        public_quote_reference,
        quote_hash,
        request_snapshot,
        quote_status,
        unavailable_reasons,
        offers,
        totals,
        deep_link_url,
        price_guarantee,
        currency,
        source_freshness,
        freshness_status,
        data_sources,
        generated_at,
        expires_at,
        projected_at
      )
    SELECT
      source.quote_session_id,
      source.property_id,
      source.public_quote_reference,
      source.quote_hash,
      jsonb_build_object(
        'hotelSlug', source.canonical_slug,
        'checkIn', source.requested_check_in,
        'checkOut', source.requested_check_out,
        'nights', source.requested_check_out - source.requested_check_in,
        'adults', source.adults,
        'children', source.children,
        'rooms', source.requested_room_count,
        'currency', source.currency,
        'locale', source.checkout_locale,
        'promoCode', source.promo_code,
        'referralCode', source.referral_code
      ),
      source.quote_read_model_status,
      '[]'::jsonb,
      jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'publicOfferKey', offer."publicOfferKey",
          'roomTypeName', source.room_type_name,
          'amenities', source.room_amenities_snapshot,
          'locationAddress', source.room_attributes ->> 'locationAddress',
          'latitude', source.room_attributes -> 'latitude',
          'longitude', source.room_attributes -> 'longitude',
          'ratePlanName', source.rate_plan_name,
          'nights', source.requested_check_out - source.requested_check_in,
          'availableRooms', offer."availableRooms",
          'amount', to_char(source.quote_room_total_amount, 'FM999999999990.00'),
          'currency', source.currency
        ))
      ),
      jsonb_build_object(
        'currency', source.currency,
        'roomTotal', to_char(source.quote_room_total_amount, 'FM999999999990.00'),
        'taxesAndFees', to_char(source.quote_taxes_and_fees_amount, 'FM999999999990.00'),
        'discounts', to_char(source.quote_discount_amount, 'FM999999999990.00'),
        'total', to_char(source.quote_total_amount, 'FM999999999990.00'),
        'depositDue', to_char(source.quote_deposit_due_amount, 'FM999999999990.00')
      ),
      source.deep_link_url,
      source.quote_price_guarantee,
      source.currency,
      source.booking_source_freshness || source.pms_source_freshness || source.finance_source_freshness,
      source.public_freshness_status,
      ARRAY['booking', 'pms', 'finance', 'distribution']::text[],
      source.generated_at,
      source.quote_expires_at,
      source.generated_at
    FROM migration_source_distribution.bookability_snapshot_inputs source
    CROSS JOIN LATERAL (
      SELECT *
      FROM jsonb_to_recordset(source.room_offer_source_rows) AS public_offer(
        "publicOfferKey" text,
        "availabilityStatus" text,
        "availableRooms" integer
      )
      WHERE public_offer."availabilityStatus" = 'available'
      LIMIT 1
    ) AS offer
  `);

  await client.query(`
    INSERT INTO distribution.booking_deep_link_contexts
      (
        id,
        property_id,
        quote_session_id,
        checkout_context_id,
        public_quote_reference,
        context_token_hash,
        deep_link_url,
        status,
        locale,
        currency,
        check_in,
        check_out,
        adults,
        children,
        rooms,
        promo_code,
        referral_code,
        preserves,
        request_context,
        source_freshness,
        expires_at,
        created_at,
        updated_at
      )
    SELECT
      deep_link_context_id,
      property_id,
      quote_session_id,
      checkout_context_id,
      public_quote_reference,
      context_token_hash,
      deep_link_url,
      deep_link_status,
      checkout_locale,
      currency,
      requested_check_in,
      requested_check_out,
      adults,
      children,
      requested_room_count,
      promo_code,
      referral_code,
      deep_link_preserves,
      jsonb_build_object(
        'hotelSlug', canonical_slug,
        'checkIn', requested_check_in,
        'checkOut', requested_check_out,
        'adults', adults,
        'children', children,
        'rooms', requested_room_count,
        'currency', currency,
        'locale', checkout_locale,
        'promoCode', promo_code,
        'referralCode', referral_code
      ),
      deep_link_source_freshness,
      quote_expires_at,
      generated_at,
      generated_at
    FROM migration_source_distribution.bookability_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO distribution.external_api_clients
      (
        id,
        public_client_id,
        client_name,
        contact_email,
        status,
        allowed_surfaces,
        rate_limit_tier,
        terms_version,
        credential_hash_ref,
        credential_rotated_at,
        created_by_user_id,
        revoked_by_user_id,
        revoked_at,
        revocation_reason,
        last_seen_at,
        client_metadata,
        created_at,
        updated_at
      )
    SELECT
      api_client.id,
      api_client."publicClientId",
      api_client."clientName",
      api_client."contactEmail",
      api_client.status,
      ARRAY(SELECT jsonb_array_elements_text(api_client."allowedSurfaces")),
      api_client."rateLimitTier",
      api_client."termsVersion",
      api_client."credentialHashRef",
      api_client."credentialRotatedAt",
      api_client."createdByUserId",
      api_client."revokedByUserId",
      api_client."revokedAt",
      api_client."revocationReason",
      api_client."lastSeenAt",
      api_client."clientMetadata",
      api_client."createdAt",
      api_client."updatedAt"
    FROM migration_source_distribution.bookability_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.external_api_client_source_rows) AS api_client(
      id uuid,
      "publicClientId" text,
      "clientName" text,
      "contactEmail" text,
      status text,
      "allowedSurfaces" jsonb,
      "rateLimitTier" text,
      "termsVersion" text,
      "credentialHashRef" text,
      "credentialRotatedAt" timestamptz,
      "createdByUserId" uuid,
      "revokedByUserId" uuid,
      "revokedAt" timestamptz,
      "revocationReason" text,
      "lastSeenAt" timestamptz,
      "clientMetadata" jsonb,
      "createdAt" timestamptz,
      "updatedAt" timestamptz
    )
  `);

  await client.query(`
    INSERT INTO distribution.external_api_usage_events
      (
        id,
        client_id,
        property_id,
        quote_session_id,
        deep_link_context_id,
        occurred_at,
        surface,
        request_method,
        route_template,
        response_status,
        rate_limit_policy,
        rate_limit_tier,
        rate_limit_key_hash,
        request_fingerprint_hash,
        ip_address_hash,
        user_agent_hash,
        cache_status,
        latency_ms,
        client_visible_error_code,
        abuse_flags,
        usage_metadata
      )
    SELECT
      usage_event.id,
      usage_event."clientId",
      usage_event."propertyId",
      usage_event."quoteSessionId",
      usage_event."deepLinkContextId",
      usage_event."occurredAt",
      usage_event.surface,
      usage_event."requestMethod",
      usage_event."routeTemplate",
      usage_event."responseStatus",
      usage_event."rateLimitPolicy",
      usage_event."rateLimitTier",
      usage_event."rateLimitKeyHash",
      usage_event."requestFingerprintHash",
      usage_event."ipAddressHash",
      usage_event."userAgentHash",
      usage_event."cacheStatus",
      usage_event."latencyMs",
      usage_event."clientVisibleErrorCode",
      ARRAY(SELECT jsonb_array_elements_text(usage_event."abuseFlags")),
      usage_event."usageMetadata"
    FROM migration_source_distribution.bookability_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.external_api_usage_event_source_rows) AS usage_event(
      id uuid,
      "clientId" uuid,
      "propertyId" uuid,
      "quoteSessionId" uuid,
      "deepLinkContextId" uuid,
      "occurredAt" timestamptz,
      surface text,
      "requestMethod" text,
      "routeTemplate" text,
      "responseStatus" integer,
      "rateLimitPolicy" text,
      "rateLimitTier" text,
      "rateLimitKeyHash" text,
      "requestFingerprintHash" text,
      "ipAddressHash" text,
      "userAgentHash" text,
      "cacheStatus" text,
      "latencyMs" integer,
      "clientVisibleErrorCode" text,
      "abuseFlags" jsonb,
      "usageMetadata" jsonb
    )
  `);
}
