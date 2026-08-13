import type pg from "pg";

export async function transformBookingCheckout(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT owner_user_id, owner_email, owner_name, owner_status
    FROM migration_source_booking.checkout_flow_inputs
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
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO identity.organization_memberships
      (id, organization_id, user_id, status, role_key, workos_membership_id, workos_role_slugs)
    SELECT
      membership_id,
      organization_id,
      owner_user_id,
      membership_status,
      role_key,
      workos_membership_id,
      workos_role_slugs
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (id, organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      resource_link_id,
      organization_id,
      'booking',
      'booking_hotel',
      booking_hotel_resource_id,
      'owner',
      'active'
    FROM migration_source_booking.checkout_flow_inputs
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
      product_entitlement_id,
      organization_id,
      'booking',
      entitlement_key,
      'active',
      'booking',
      'booking_hotel',
      booking_hotel_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_booking.checkout_flow_inputs
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
      profile_status,
      completeness_reasons
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT
      property_source_link_id,
      property_id,
      'booking',
      'booking_hotels',
      booking_hotel_resource_id,
      'canonical_input',
      jsonb_build_object('fixture', 'booking-checkout')
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status)
    SELECT
      property_slug_id,
      property_id,
      property_slug,
      NULL,
      'canonical',
      'active'
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO booking.booking_settings
      (
        property_id,
        show_addons_step,
        group_addons_by_category,
        special_requests_enabled,
        arrival_time_enabled,
        guest_count_enabled,
        phone_required,
        adult_age_threshold,
        children_enabled,
        benefits,
        default_currency,
        default_language,
        supported_currencies,
        supported_languages,
        booking_filters,
        custom_filters,
        filter_rooms,
        source_freshness,
        primary_color,
        font_pairing,
        acceptance_mode
      )
    SELECT
      property_id,
      COALESCE((booking_settings ->> 'showAddonsStep')::boolean, TRUE),
      COALESCE((booking_settings ->> 'groupAddonsByCategory')::boolean, TRUE),
      COALESCE((booking_settings ->> 'specialRequestsEnabled')::boolean, TRUE),
      COALESCE((booking_settings ->> 'arrivalTimeEnabled')::boolean, FALSE),
      COALESCE((booking_settings ->> 'guestCountEnabled')::boolean, FALSE),
      COALESCE((booking_settings ->> 'phoneRequired')::boolean, TRUE),
      COALESCE((booking_settings ->> 'adultAgeThreshold')::integer, 18),
      COALESCE((booking_settings ->> 'childrenEnabled')::boolean, TRUE),
      COALESCE(booking_settings -> 'benefits', '[]'::jsonb),
      COALESCE(booking_settings ->> 'defaultCurrency', 'EUR'),
      COALESCE(booking_settings ->> 'defaultLanguage', 'en'),
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(booking_settings -> 'supportedCurrencies')),
        ARRAY[]::TEXT[]
      ),
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(booking_settings -> 'supportedLanguages')),
        ARRAY['en']::TEXT[]
      ),
      COALESCE(booking_settings -> 'bookingFilters', '[]'::jsonb),
      COALESCE(booking_settings -> 'customFilters', '{}'::jsonb),
      COALESCE(booking_settings -> 'filterRooms', '{}'::jsonb),
      COALESCE(booking_settings -> 'sourceFreshness', '{}'::jsonb),
      CASE
        WHEN BTRIM(COALESCE(
          booking_settings ->> 'primaryColor',
          booking_settings ->> 'branding_primary_color',
          booking_settings #>> '{branding,primaryColor}',
          ''
        )) ~ '^#[0-9A-Fa-f]{6}$'
          THEN UPPER(BTRIM(COALESCE(
            booking_settings ->> 'primaryColor',
            booking_settings ->> 'branding_primary_color',
            booking_settings #>> '{branding,primaryColor}',
            ''
          )))
        ELSE '#4F46E5'
      END,
      CASE REGEXP_REPLACE(LOWER(BTRIM(COALESCE(
        booking_settings ->> 'fontPairing',
        booking_settings ->> 'branding_font_pairing',
        booking_settings #>> '{branding,fontPairing}',
        ''
      ))), '[^a-z0-9]+', '-', 'g')
        WHEN 'high-end-serif' THEN 'high-end-serif'
        WHEN 'playfair-display-source-sans-pro' THEN 'high-end-serif'
        WHEN 'modern-minimalist' THEN 'modern-minimalist'
        WHEN 'inter-inter' THEN 'modern-minimalist'
        WHEN 'inter-merriweather' THEN 'modern-minimalist'
        WHEN 'grand-classic' THEN 'grand-classic'
        WHEN 'cormorant-garamond-lato' THEN 'grand-classic'
        WHEN 'lora-source-sans-pro' THEN 'grand-classic'
        WHEN 'imperial-serif' THEN 'imperial-serif'
        WHEN 'cinzel-source-sans-pro' THEN 'imperial-serif'
        WHEN 'italiana-serif' THEN 'italiana-serif'
        WHEN 'italiana-source-sans-pro' THEN 'italiana-serif'
        ELSE 'high-end-serif'
      END,
      CASE
        WHEN COALESCE((booking_settings ->> 'instantBook')::boolean, TRUE) THEN 'instant'
        ELSE 'request'
      END
    FROM migration_source_booking.checkout_flow_inputs
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
      quote_status,
      selected_offer_snapshot,
      totals,
      policy_snapshot,
      source_freshness,
      promo_code,
      referral_code,
      quote_expires_at,
      quote_created_at,
      quote_updated_at
    FROM migration_source_booking.checkout_flow_inputs
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
      locale,
      currency,
      checkout_status,
      guest_input,
      selected_addons,
      payment_context,
      promo_context,
      checkout_expires_at,
      checkout_created_at,
      checkout_updated_at
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO booking.guest_bookings
      (
        id,
        property_id,
        quote_session_id,
        checkout_context_id,
        public_reference,
        source_system,
        source_booking_id,
        lifecycle_status,
        payment_status,
        check_in,
        check_out,
        adults,
        children,
        room_count,
        currency,
        total_amount,
        balance_amount,
        booking_metadata,
        created_at,
        updated_at
      )
    SELECT
      guest_booking_id,
      property_id,
      quote_session_id,
      checkout_context_id,
      public_booking_reference,
      'booking',
      source_booking_id,
      lifecycle_status,
      payment_status,
      requested_check_in,
      requested_check_out,
      adults,
      children,
      requested_room_count,
      currency,
      total_amount,
      balance_amount,
      booking_metadata,
      booking_created_at,
      booking_updated_at
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO booking.booking_guests
      (
        id,
        guest_booking_id,
        guest_role,
        first_name,
        last_name,
        email,
        phone,
        country_code,
        arrival_time,
        special_requests,
        pii_retention_until
      )
    SELECT
      guest.id,
      flow.guest_booking_id,
      guest.guest_role,
      guest.first_name,
      guest.last_name,
      guest.email,
      guest.phone,
      guest.country_code,
      guest.arrival_time,
      guest.special_requests,
      guest.pii_retention_until
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.guests)
      AS guest(
        id uuid,
        guest_role text,
        first_name text,
        last_name text,
        email text,
        phone text,
        country_code text,
        arrival_time text,
        special_requests text,
        pii_retention_until date
      )
  `);

  await client.query(`
    INSERT INTO booking.addon_definitions
      (
        id,
        property_id,
        source_system,
        source_addon_id,
        name,
        description,
        category,
        pricing_model,
        price_amount,
        currency,
        public_visible,
        status,
        metadata
      )
    SELECT
      addon.id,
      flow.property_id,
      'booking',
      addon.source_addon_id,
      addon.name,
      addon.description,
      addon.category,
      addon.pricing_model,
      addon.price_amount,
      flow.currency,
      addon.public_visible,
      addon.status,
      addon.metadata
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_record(flow.addon_definition)
      AS addon(
        id uuid,
        source_addon_id text,
        name text,
        description text,
        category text,
        pricing_model text,
        price_amount numeric,
        public_visible boolean,
        status text,
        metadata jsonb
      )
  `);

  await client.query(`
    INSERT INTO booking.booking_addon_selections
      (
        id,
        property_id,
        guest_booking_id,
        quote_session_id,
        addon_definition_id,
        addon_snapshot,
        quantity,
        service_date,
        total_amount,
        currency
      )
    SELECT
      addon.id,
      flow.property_id,
      flow.guest_booking_id,
      NULL,
      addon.addon_definition_id,
      addon.addon_snapshot,
      addon.quantity,
      addon.service_date,
      addon.total_amount,
      flow.currency
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.addon_selections)
      AS addon(
        id uuid,
        addon_definition_id uuid,
        addon_snapshot jsonb,
        quantity integer,
        service_date date,
        total_amount numeric
      )
  `);

  await client.query(`
    INSERT INTO booking.promo_applications
      (
        id,
        property_id,
        quote_session_id,
        guest_booking_id,
        promo_code,
        application_status,
        discount_amount,
        currency,
        metadata
      )
    SELECT
      promo.id,
      flow.property_id,
      NULL,
      flow.guest_booking_id,
      promo.promo_code,
      promo.application_status,
      promo.discount_amount,
      flow.currency,
      promo.metadata
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.promo_applications)
      AS promo(
        id uuid,
        promo_code text,
        application_status text,
        discount_amount numeric,
        metadata jsonb
      )
  `);

  await client.query(`
    INSERT INTO booking.booking_status_events
      (
        id,
        guest_booking_id,
        event_type,
        from_status,
        to_status,
        actor_type,
        actor_user_id,
        public_visible,
        public_message,
        event_payload,
        occurred_at
      )
    SELECT
      event.id,
      flow.guest_booking_id,
      event.event_type,
      event.from_status,
      event.to_status,
      event.actor_type,
      event.actor_user_id,
      event.public_visible,
      event.public_message,
      event.event_payload,
      event.occurred_at
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.status_events)
      AS event(
        id uuid,
        event_type text,
        from_status text,
        to_status text,
        actor_type text,
        actor_user_id uuid,
        public_visible boolean,
        public_message text,
        event_payload jsonb,
        occurred_at timestamptz
      )
  `);

  await client.query(`
    INSERT INTO booking.booking_change_requests
      (id, guest_booking_id, request_type, requested_by, status, requested_changes, created_at, updated_at)
    SELECT
      request.id,
      flow.guest_booking_id,
      request.request_type,
      request.requested_by,
      request.status,
      request.requested_changes,
      request.created_at,
      request.updated_at
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.change_requests)
      AS request(
        id uuid,
        request_type text,
        requested_by text,
        status text,
        requested_changes jsonb,
        created_at timestamptz,
        updated_at timestamptz
      )
  `);

  await client.query(`
    INSERT INTO booking.booking_notes_public
      (id, guest_booking_id, author_type, author_user_id, body, locale, created_at)
    SELECT
      note.id,
      flow.guest_booking_id,
      note.author_type,
      note.author_user_id,
      note.body,
      note.locale,
      note.created_at
    FROM migration_source_booking.checkout_flow_inputs flow
    CROSS JOIN LATERAL jsonb_to_recordset(flow.public_notes)
      AS note(
        id uuid,
        author_type text,
        author_user_id uuid,
        body text,
        locale text,
        created_at timestamptz
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
        account_metadata
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
      currency,
      provider_capabilities,
      provider_account_metadata
    FROM migration_source_booking.checkout_flow_inputs
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
      TRUE,
      accepted_methods,
      currency,
      deposit_policy,
      refund_policy,
      tax_policy,
      statement_descriptor,
      'booking',
      payment_settings_source_id
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO finance.payments
      (
        id,
        property_id,
        organization_id,
        guest_booking_id,
        provider_account_id,
        source_system,
        source_payment_id,
        idempotency_key,
        payment_kind,
        payment_method,
        status,
        amount,
        fee_amount,
        net_amount,
        refunded_amount,
        currency,
        provider_transaction_id,
        provider_payment_intent_id,
        visibility_class,
        authorized_at,
        paid_at,
        pii_retention_until,
        payment_metadata
      )
    SELECT
      payment_id,
      property_id,
      organization_id,
      guest_booking_id,
      provider_account_id,
      'booking',
      source_payment_id,
      idempotency_key,
      payment_kind,
      payment_method,
      payment_row_status,
      payment_amount,
      fee_amount,
      net_amount,
      refunded_amount,
      currency,
      provider_transaction_id,
      provider_payment_intent_id,
      visibility_class,
      authorized_at,
      paid_at,
      pii_retention_until,
      payment_metadata
    FROM migration_source_booking.checkout_flow_inputs
  `);

  await client.query(`
    INSERT INTO booking.direct_booking_summary_read_model
      (
        guest_booking_id,
        property_id,
        public_reference,
        lifecycle_status,
        payment_status,
        check_in,
        check_out,
        guest_counts,
        room_summary,
        amount_summary,
        public_policy,
        source_freshness,
        projected_at
      )
    SELECT
      guest_booking_id,
      property_id,
      public_booking_reference,
      lifecycle_status,
      payment_status,
      requested_check_in,
      requested_check_out,
      jsonb_build_object(
        'adults', adults,
        'children', children,
        'roomCount', requested_room_count
      ),
      jsonb_build_object(
        'roomType', public_room_type_name,
        'nights', requested_check_out - requested_check_in
      ),
      jsonb_build_object(
        'currency', currency,
        'total', to_char(total_amount, 'FM999999999999990.00'),
        'balance', to_char(balance_amount, 'FM999999999999990.00'),
        'paid', to_char(payment_amount, 'FM999999999999990.00')
      ),
      jsonb_build_object('cancellation', policy_snapshot ->> 'cancellation'),
      jsonb_build_object(
        'booking',
        jsonb_build_object('status', source_freshness #>> '{booking,status}'),
        'finance',
        jsonb_build_object('status', 'fresh')
      ),
      booking_updated_at
    FROM migration_source_booking.checkout_flow_inputs
  `);
}
