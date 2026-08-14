import type pg from "pg";

export async function transformFinance(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT owner_user_id, owner_email, owner_name, owner_status
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT owner_user_id, owner_email, owner_name, owner_status
    FROM migration_source_finance.affiliate_payout_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      organization_id,
      organization_kind,
      organization_name,
      organization_slug,
      organization_status,
      workos_org_id,
      workos_external_id
    FROM migration_source_finance.affiliate_payout_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      membership_id,
      organization_id,
      owner_user_id,
      membership_status,
      role_key,
      workos_membership_id,
      workos_role_slugs
    FROM migration_source_finance.affiliate_payout_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      pms_resource_link_id,
      organization_id,
      'pms',
      'pms_hotel',
      pms_hotel_resource_id,
      'operator',
      'active'
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      affiliate_resource_link_id,
      organization_id,
      'affiliate',
      'affiliate',
      affiliate_resource_id,
      'promotes',
      'active'
    FROM migration_source_finance.affiliate_payout_inputs
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
      pms_product_entitlement_id,
      organization_id,
      'pms',
      'pms-core',
      'active',
      'pms',
      'pms_hotel',
      pms_hotel_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      booking_product_entitlement_id,
      organization_id,
      'booking',
      'booking-engine',
      'active',
      'booking',
      'booking_hotel',
      booking_hotel_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      product_entitlement_id,
      organization_id,
      'affiliate',
      'affiliate-payouts',
      'active',
      'affiliate',
      'affiliate',
      affiliate_resource_id,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_finance.affiliate_payout_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
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
      jsonb_build_object('fixture', 'finance')
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      pms_property_source_link_id,
      property_id,
      'pms',
      'hotels',
      pms_hotel_resource_id,
      'operational_input',
      jsonb_build_object('fixture', 'finance')
    FROM migration_source_finance.property_finance_flow_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status)
    SELECT property_slug_id, property_id, property_slug, NULL, 'canonical', 'active'
    FROM migration_source_finance.property_finance_flow_inputs
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
      quote_expires_at,
      quote_created_at,
      quote_updated_at
    FROM migration_source_finance.property_finance_flow_inputs
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
        payment_context,
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
      payment_context,
      checkout_expires_at,
      checkout_created_at,
      checkout_updated_at
    FROM migration_source_finance.property_finance_flow_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
  `);

  await client.query(`
    INSERT INTO finance.payment_provider_accounts
      (
        id,
        property_id,
        organization_id,
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
      NULL,
      'property',
      provider,
      provider_account_ref,
      provider_account_status,
      provider_onboarding_status,
      charges_enabled,
      payouts_enabled,
      currency,
      provider_capabilities,
      provider_account_metadata,
      provider_sensitive_config_ref
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      provider_account_id,
      NULL,
      organization_id,
      'organization',
      provider,
      provider_account_ref,
      provider_account_status,
      provider_onboarding_status,
      charges_enabled,
      payouts_enabled,
      currency,
      provider_capabilities,
      provider_account_metadata,
      provider_sensitive_config_ref
    FROM migration_source_finance.affiliate_payout_inputs
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
    FROM migration_source_finance.property_finance_flow_inputs
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
        processor_fee_breakdown,
        risk_review,
        payment_metadata,
        visibility_class,
        authorized_at,
        paid_at,
        pii_retention_until
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
      processor_fee_breakdown,
      risk_review,
      payment_metadata,
      visibility_class,
      authorized_at,
      paid_at,
      pii_retention_until
    FROM migration_source_finance.property_finance_flow_inputs
  `);

  await client.query(`
    INSERT INTO finance.payout_settings
      (
        id,
        property_id,
        organization_id,
        property_provider_account_id,
        organization_provider_account_id,
        owner_scope,
        payout_method,
        destination_country_code,
        default_currency,
        status,
        schedule,
        payout_preferences,
        sensitive_destination_ref,
        source_system,
        source_settings_id
      )
    SELECT
      payout_settings_id,
      property_id,
      NULL,
      provider_account_id,
      NULL,
      'property',
      payout_method,
      payout_destination_country_code,
      currency,
      'active',
      payout_schedule,
      payout_preferences,
      payout_sensitive_destination_ref,
      'pms',
      payout_settings_source_id
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      payout_settings_id,
      NULL,
      organization_id,
      NULL,
      provider_account_id,
      'organization',
      payout_method,
      payout_destination_country_code,
      currency,
      'active',
      payout_schedule,
      payout_preferences,
      payout_sensitive_destination_ref,
      'marketplace',
      payout_settings_source_id
    FROM migration_source_finance.affiliate_payout_inputs
  `);

  await client.query(`
    INSERT INTO finance.payouts
      (
        id,
        payout_setting_id,
        payment_id,
        guest_booking_id,
        property_provider_account_id,
        organization_provider_account_id,
        owner_scope,
        property_id,
        organization_id,
        related_property_id,
        source_system,
        source_payout_id,
        payout_status,
        amount,
        fee_amount,
        net_amount,
        currency,
        period_start,
        period_end,
        provider_payout_id,
        scheduled_at,
        paid_at,
        payout_metadata
      )
    SELECT
      payout_id,
      payout_settings_id,
      payment_id,
      guest_booking_id,
      provider_account_id,
      NULL,
      'property',
      property_id,
      NULL,
      property_id,
      'pms',
      source_payout_id,
      payout_status,
      payout_amount,
      payout_fee_amount,
      payout_net_amount,
      currency,
      payout_period_start,
      payout_period_end,
      provider_payout_id,
      payout_scheduled_at,
      payout_paid_at,
      payout_metadata
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      payout_id,
      payout_settings_id,
      NULL,
      NULL,
      NULL,
      provider_account_id,
      'organization',
      NULL,
      organization_id,
      NULL,
      'marketplace',
      source_payout_id,
      payout_status,
      payout_amount,
      payout_fee_amount,
      payout_net_amount,
      currency,
      payout_period_start,
      payout_period_end,
      provider_payout_id,
      payout_scheduled_at,
      payout_paid_at,
      payout_metadata || jsonb_build_object('affiliateId', affiliate_resource_id)
    FROM migration_source_finance.affiliate_payout_inputs
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
      commission_rule_id,
      property_id,
      NULL,
      'property',
      commission_product,
      commission_type,
      commission_percentage_rate,
      currency,
      'active',
      commission_starts_at,
      'booking',
      commission_source_rule_id,
      commission_rule_metadata
    FROM migration_source_finance.property_finance_flow_inputs
  `);

  await client.query(`
    INSERT INTO finance.commission_rate_changes
      (
        id,
        commission_rule_id,
        changed_by_user_id,
        previous_percentage_rate,
        new_percentage_rate,
        currency,
        reason,
        effective_at,
        changed_at,
        change_metadata
      )
    SELECT
      commission_rate_change_id,
      commission_rule_id,
      owner_user_id,
      previous_percentage_rate,
      new_percentage_rate,
      currency,
      commission_change_reason,
      commission_effective_at,
      commission_changed_at,
      commission_change_metadata
    FROM migration_source_finance.property_finance_flow_inputs
  `);

  await client.query(`
    INSERT INTO finance.billing_entitlements
      (
        id,
        organization_id,
        property_id,
        identity_entitlement_id,
        product,
        entitlement_key,
        billing_status,
        plan_key,
        seat_count,
        billing_provider,
        billing_customer_ref,
        billing_subscription_ref,
        billing_period_start,
        billing_period_end,
        starts_at,
        source_system,
        source_entitlement_id,
        entitlement_metadata
      )
    SELECT
      billing_entitlement_id,
      organization_id,
      property_id,
      pms_product_entitlement_id,
      billing_product,
      billing_entitlement_key,
      billing_status,
      plan_key,
      seat_count,
      billing_provider,
      billing_customer_ref,
      billing_subscription_ref,
      billing_period_start,
      billing_period_end,
      entitlement_starts_at,
      'pms',
      source_entitlement_id,
      billing_entitlement_metadata
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      billing_entitlement_id,
      organization_id,
      NULL,
      product_entitlement_id,
      billing_product,
      billing_entitlement_key,
      billing_status,
      plan_key,
      seat_count,
      billing_provider,
      NULL,
      NULL,
      billing_period_start,
      billing_period_end,
      entitlement_starts_at,
      'marketplace',
      source_entitlement_id,
      billing_entitlement_metadata
    FROM migration_source_finance.affiliate_payout_inputs
  `);

  await client.query(`
    INSERT INTO finance.finance_visibility_read_model
      (
        id,
        organization_id,
        property_id,
        visibility_scope,
        resource_type,
        resource_id,
        required_permission_key,
        period_start,
        period_end,
        currency,
        gross_payment_amount,
        net_payment_amount,
        payout_amount,
        commission_amount,
        outstanding_balance_amount,
        payment_count,
        payout_count,
        failed_payment_count,
        entitlement_status,
        status_counts,
        entitlement_summary,
        source_freshness,
        projected_at
      )
    SELECT
      visibility_read_model_id,
      organization_id,
      property_id,
      visibility_scope,
      visibility_resource_type,
      property_id::text,
      required_permission_key,
      billing_period_start,
      billing_period_end,
      currency,
      visibility_gross_payment_amount,
      visibility_net_payment_amount,
      visibility_payout_amount,
      visibility_commission_amount,
      visibility_outstanding_balance_amount,
      visibility_payment_count,
      visibility_payout_count,
      visibility_failed_payment_count,
      visibility_entitlement_status,
      visibility_status_counts,
      visibility_entitlement_summary,
      visibility_source_freshness,
      visibility_projected_at
    FROM migration_source_finance.property_finance_flow_inputs
    UNION ALL
    SELECT
      visibility_read_model_id,
      organization_id,
      NULL,
      visibility_scope,
      visibility_resource_type,
      affiliate_resource_id,
      required_permission_key,
      billing_period_start,
      billing_period_end,
      currency,
      visibility_gross_payment_amount,
      visibility_net_payment_amount,
      visibility_payout_amount,
      visibility_commission_amount,
      visibility_outstanding_balance_amount,
      visibility_payment_count,
      visibility_payout_count,
      visibility_failed_payment_count,
      visibility_entitlement_status,
      visibility_status_counts,
      visibility_entitlement_summary,
      visibility_source_freshness,
      visibility_projected_at
    FROM migration_source_finance.affiliate_payout_inputs
  `);
}
