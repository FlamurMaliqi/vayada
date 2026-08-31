import type pg from "pg";

export async function transformPlatformJobsEventsAudit(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT id, email, name, status
    FROM migration_source_platform.identity_users
  `);

  await client.query(`
    INSERT INTO identity.organizations
      (id, kind, name, slug, status, workos_org_id, workos_external_id)
    SELECT id, kind, name, slug, status, workos_org_id, workos_external_id
    FROM migration_source_platform.identity_organizations
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
    FROM migration_source_platform.identity_organization_memberships memberships
    LEFT JOIN migration_source_platform.identity_organizations organizations
      ON organizations.id = memberships.organization_id
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (id, organization_id, product, resource_type, resource_id, relationship, status)
    SELECT id, organization_id, product, resource_type, resource_id, relationship, status
    FROM migration_source_platform.identity_organization_resource_links
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
    FROM migration_source_platform.hotel_catalog_properties
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT id, property_id, source_system, source_table, source_id, relationship, metadata
    FROM migration_source_platform.hotel_catalog_property_source_links
  `);

  await client.query(`
    INSERT INTO platform.domain_events
      (
        id,
        source_system,
        event_key,
        event_type,
        event_version,
        occurred_at,
        recorded_at,
        event_status,
        tenant_scope,
        organization_id,
        property_id,
        resource_product,
        resource_type,
        resource_id,
        actor_type,
        actor_user_id,
        correlation_id,
        causation_id,
        idempotency_key_hash,
        payload,
        event_metadata,
        privacy_scope,
        ai_visible
      )
    SELECT
      id,
      source_system,
      event_key,
      event_type,
      event_version,
      occurred_at,
      recorded_at,
      event_status,
      tenant_scope,
      organization_id,
      property_id,
      resource_product,
      resource_type,
      resource_id,
      actor_type,
      actor_user_id,
      correlation_id,
      causation_id,
      idempotency_key_hash,
      payload,
      event_metadata,
      privacy_scope,
      ai_visible
    FROM migration_source_platform.domain_events
  `);

  await client.query(`
    INSERT INTO platform.external_webhook_events
      (
        id,
        provider,
        provider_event_id,
        webhook_key_hash,
        event_type,
        delivery_status,
        signature_verified,
        received_at,
        processed_at,
        tenant_scope,
        organization_id,
        property_id,
        normalized_domain_event_id,
        correlation_id,
        payload_hash,
        raw_headers,
        raw_payload,
        failure_reason,
        privacy_scope,
        ai_visible,
        payload_retention_until,
        payload_purged_at
      )
    SELECT
      id,
      provider,
      provider_event_id,
      webhook_key_hash,
      event_type,
      delivery_status,
      signature_verified,
      received_at,
      processed_at,
      tenant_scope,
      organization_id,
      property_id,
      normalized_domain_event_id,
      correlation_id,
      payload_hash,
      CASE WHEN provider = 'stripe' THEN '{}'::jsonb ELSE raw_headers END,
      CASE WHEN provider = 'stripe' THEN '{}'::jsonb ELSE raw_payload END,
      failure_reason,
      privacy_scope,
      ai_visible,
      CASE
        WHEN provider = 'stripe'
        THEN LEAST(received_at + INTERVAL '30 days', CURRENT_TIMESTAMP)
      END,
      CASE WHEN provider = 'stripe' THEN CURRENT_TIMESTAMP END
    FROM migration_source_platform.external_webhook_events
  `);

  await client.query(`
    INSERT INTO platform.outbox_events
      (
        id,
        domain_event_id,
        outbox_key,
        destination,
        event_type,
        tenant_scope,
        organization_id,
        property_id,
        resource_product,
        resource_type,
        resource_id,
        status,
        priority,
        attempts_count,
        max_attempts,
        available_at,
        leased_until,
        published_at,
        correlation_id,
        idempotency_key_hash,
        payload,
        outbox_metadata,
        created_at,
        updated_at,
        ai_visible
      )
    SELECT
      id,
      domain_event_id,
      outbox_key,
      destination,
      event_type,
      tenant_scope,
      organization_id,
      property_id,
      resource_product,
      resource_type,
      resource_id,
      status,
      priority,
      attempts_count,
      max_attempts,
      available_at,
      leased_until,
      published_at,
      correlation_id,
      idempotency_key_hash,
      payload,
      outbox_metadata,
      created_at,
      updated_at,
      ai_visible
    FROM migration_source_platform.outbox_events
  `);

  await client.query(`
    INSERT INTO platform.jobs
      (
        id,
        job_key,
        queue_name,
        job_type,
        source_domain_event_id,
        source_outbox_event_id,
        status,
        priority,
        attempts_count,
        max_attempts,
        run_after,
        locked_at,
        locked_by,
        finished_at,
        tenant_scope,
        organization_id,
        property_id,
        resource_product,
        resource_type,
        resource_id,
        correlation_id,
        idempotency_key_hash,
        payload,
        job_metadata,
        created_at,
        updated_at,
        ai_visible
      )
    SELECT
      id,
      job_key,
      queue_name,
      job_type,
      source_domain_event_id,
      source_outbox_event_id,
      status,
      priority,
      attempts_count,
      max_attempts,
      run_after,
      locked_at,
      locked_by,
      finished_at,
      tenant_scope,
      organization_id,
      property_id,
      resource_product,
      resource_type,
      resource_id,
      correlation_id,
      idempotency_key_hash,
      payload,
      job_metadata,
      created_at,
      updated_at,
      ai_visible
    FROM migration_source_platform.jobs
  `);

  await client.query(`
    INSERT INTO platform.job_attempts
      (
        id,
        job_id,
        attempt_number,
        status,
        worker_id,
        started_at,
        finished_at,
        duration_ms,
        error_type,
        error_message,
        error_metadata,
        retry_after,
        ai_visible
      )
    SELECT
      id,
      job_id,
      attempt_number,
      status,
      worker_id,
      started_at,
      finished_at,
      duration_ms,
      error_type,
      error_message,
      error_metadata,
      retry_after,
      ai_visible
    FROM migration_source_platform.job_attempts
  `);

  await client.query(`
    INSERT INTO platform.idempotency_keys
      (
        id,
        operation_scope,
        operation,
        key_hash,
        request_fingerprint_hash,
        status,
        tenant_scope,
        organization_id,
        property_id,
        response_status_code,
        response_body_hash,
        response_resource_product,
        response_resource_type,
        response_resource_id,
        correlation_id,
        first_seen_at,
        last_seen_at,
        locked_until,
        completed_at,
        expires_at,
        idempotency_metadata,
        ai_visible
      )
    SELECT
      id,
      operation_scope,
      operation,
      key_hash,
      request_fingerprint_hash,
      status,
      tenant_scope,
      organization_id,
      property_id,
      response_status_code,
      response_body_hash,
      response_resource_product,
      response_resource_type,
      response_resource_id,
      correlation_id,
      first_seen_at,
      last_seen_at,
      locked_until,
      completed_at,
      expires_at,
      idempotency_metadata,
      ai_visible
    FROM migration_source_platform.idempotency_keys
  `);

  await client.query(`
    INSERT INTO platform.dead_letter_events
      (
        id,
        source_kind,
        domain_event_id,
        outbox_event_id,
        job_id,
        job_attempt_id,
        webhook_event_id,
        requeued_job_id,
        tenant_scope,
        organization_id,
        property_id,
        resource_product,
        resource_type,
        resource_id,
        correlation_id,
        idempotency_key_hash,
        reason_code,
        failure_summary,
        failure_payload,
        recovery_status,
        created_at,
        acknowledged_at,
        resolved_at,
        ai_visible
      )
    SELECT
      id,
      source_kind,
      domain_event_id,
      outbox_event_id,
      job_id,
      job_attempt_id,
      webhook_event_id,
      requeued_job_id,
      tenant_scope,
      organization_id,
      property_id,
      resource_product,
      resource_type,
      resource_id,
      correlation_id,
      idempotency_key_hash,
      reason_code,
      failure_summary,
      failure_payload,
      recovery_status,
      created_at,
      acknowledged_at,
      resolved_at,
      ai_visible
    FROM migration_source_platform.dead_letter_events
  `);

  await client.query(`
    INSERT INTO platform.product_audit_events
      (
        id,
        audit_key,
        product,
        action,
        action_version,
        occurred_at,
        recorded_at,
        tenant_scope,
        organization_id,
        property_id,
        actor_type,
        actor_user_id,
        target_resource_product,
        target_resource_type,
        target_resource_id,
        secondary_resource_product,
        secondary_resource_type,
        secondary_resource_id,
        domain_event_id,
        external_webhook_event_id,
        job_id,
        idempotency_key_id,
        correlation_id,
        causation_id,
        redacted_payload,
        private_payload,
        audit_metadata,
        retention_class,
        privacy_scope,
        ai_visible
      )
    SELECT
      id,
      audit_key,
      product,
      action,
      action_version,
      occurred_at,
      recorded_at,
      tenant_scope,
      organization_id,
      property_id,
      actor_type,
      actor_user_id,
      target_resource_product,
      target_resource_type,
      target_resource_id,
      secondary_resource_product,
      secondary_resource_type,
      secondary_resource_id,
      domain_event_id,
      external_webhook_event_id,
      job_id,
      idempotency_key_id,
      correlation_id,
      causation_id,
      redacted_payload,
      CASE
        WHEN external_webhook_event_id IN (
          SELECT id
          FROM migration_source_platform.external_webhook_events
          WHERE provider = 'stripe'
        ) THEN '{}'::jsonb
        ELSE private_payload
      END,
      audit_metadata,
      retention_class,
      privacy_scope,
      ai_visible
    FROM migration_source_platform.product_audit_events
  `);
}
