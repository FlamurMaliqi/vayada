import type pg from "pg";

import { importedNationalityMap } from "../../importedNationality.js";

export async function transformPmsOperations(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO identity.users (id, email, name, status)
    SELECT owner_user_id, owner_email, owner_name, owner_status
    FROM migration_source_pms.operations_snapshot_inputs
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
    FROM migration_source_pms.operations_snapshot_inputs
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
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO identity.organization_resource_links
      (id, organization_id, product, resource_type, resource_id, relationship, status)
    SELECT
      resource_link_id,
      organization_id,
      'pms',
      'pms_property',
      property_id::text,
      'operator',
      'active'
    FROM migration_source_pms.operations_snapshot_inputs
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
      'pms',
      entitlement_key,
      'active',
      'pms',
      'pms_property',
      property_id::text,
      entitlement_starts_at,
      entitlement_metadata
    FROM migration_source_pms.operations_snapshot_inputs
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
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_source_links
      (id, property_id, source_system, source_table, source_id, relationship, metadata)
    SELECT
      property_source_link_id,
      property_id,
      'pms',
      'hotels',
      pms_hotel_resource_id,
      'operational_input',
      jsonb_build_object('fixture', 'pms-operations')
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO hotel_catalog.property_slugs
      (id, property_id, slug, locale, purpose, status)
    SELECT property_slug_id, property_id, property_slug, NULL, 'canonical', 'active'
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO booking.guest_bookings
      (
        id,
        property_id,
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
      public_reference,
      'pms',
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
      booking_created_at,
      booking_updated_at
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  const nationalityValues = await client.query<{ value: string | null }>(`
    SELECT DISTINCT guest_country_code AS value
    FROM migration_source_pms.operations_snapshot_inputs
  `);
  const nationality = importedNationalityMap(nationalityValues.rows.map((row) => row.value));

  await client.query(
    `
    INSERT INTO booking.booking_guests
      (id, guest_booking_id, guest_role, first_name, last_name, email, phone,
       country_code, country_code_raw, country_code_review_required, pii_retention_until)
    SELECT
      booking_guest_id,
      guest_booking_id,
      guest_role,
      guest_first_name,
      guest_last_name,
      guest_email,
      guest_phone,
      nationality.country_code,
      nationality.country_code_raw,
      COALESCE(nationality.review_required, FALSE),
      pii_retention_until
    FROM migration_source_pms.operations_snapshot_inputs source
    LEFT JOIN unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
      AS nationality(source_value, country_code, country_code_raw, review_required)
      ON nationality.source_value = source.guest_country_code
  `,
    [
      nationality.sourceValues,
      nationality.countryCodes,
      nationality.rawValues,
      nationality.reviewRequired,
    ],
  );

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
      public_reference,
      lifecycle_status,
      payment_status,
      check_in,
      check_out,
      summary_guest_counts,
      summary_room,
      summary_amount,
      summary_public_policy,
      summary_source_freshness,
      summary_projected_at
    FROM migration_source_pms.operations_snapshot_inputs
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
      room_type.id,
      source.property_id,
      'pms',
      room_type."sourceRoomTypeId",
      room_type.name,
      room_type.description,
      room_type.category,
      room_type."occupancyLimits",
      room_type."roomAttributes",
      room_type."amenitiesSnapshot",
      room_type."baseRateAmount"::numeric,
      room_type.currency,
      room_type.active,
      room_type."sortOrder",
      room_type."locationSummary"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.room_types) AS room_type(
      id uuid,
      "sourceRoomTypeId" text,
      name text,
      description text,
      category text,
      "occupancyLimits" jsonb,
      "roomAttributes" jsonb,
      "amenitiesSnapshot" jsonb,
      "baseRateAmount" text,
      currency char(3),
      active boolean,
      "sortOrder" integer,
      "locationSummary" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.rooms
      (id, property_id, room_type_id, source_system, source_room_id, room_number, floor, status, sort_order, room_metadata)
    SELECT
      room.id,
      source.property_id,
      room."roomTypeId",
      'pms',
      room."sourceRoomId",
      room."roomNumber",
      room.floor,
      room.status,
      room."sortOrder",
      room."roomMetadata"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.rooms) AS room(
      id uuid,
      "roomTypeId" uuid,
      "sourceRoomId" text,
      "roomNumber" text,
      floor text,
      status text,
      "sortOrder" integer,
      "roomMetadata" jsonb
    )
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
      rate_plan.id,
      source.property_id,
      rate_plan."roomTypeId",
      rate_plan.code,
      rate_plan.name,
      rate_plan."rateType",
      rate_plan."mealPlan",
      rate_plan."paymentPolicy",
      rate_plan."depositPolicy",
      rate_plan."cancellationPolicySnapshot",
      rate_plan."baseRateAmount"::numeric,
      rate_plan.currency,
      rate_plan.active
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.rate_plans) AS rate_plan(
      id uuid,
      "roomTypeId" uuid,
      code text,
      name text,
      "rateType" text,
      "mealPlan" text,
      "paymentPolicy" jsonb,
      "depositPolicy" jsonb,
      "cancellationPolicySnapshot" jsonb,
      "baseRateAmount" text,
      currency char(3),
      active boolean
    )
  `);

  await client.query(`
    INSERT INTO pms.rate_rules
      (
        id,
        property_id,
        room_type_id,
        rate_plan_id,
        rule_type,
        starts_on,
        ends_on,
        days_of_week,
        min_stay_nights,
        max_stay_nights,
        price_delta_amount,
        rule_payload
      )
    SELECT
      rate_rule.id,
      source.property_id,
      rate_rule."roomTypeId",
      rate_rule."ratePlanId",
      rate_rule."ruleType",
      rate_rule."startsOn",
      rate_rule."endsOn",
      ARRAY(
        SELECT jsonb_array_elements_text(rate_rule."daysOfWeek")::integer
      ),
      rate_rule."minStayNights",
      rate_rule."maxStayNights",
      rate_rule."priceDeltaAmount"::numeric,
      rate_rule."rulePayload"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.rate_rules) AS rate_rule(
      id uuid,
      "roomTypeId" uuid,
      "ratePlanId" uuid,
      "ruleType" text,
      "startsOn" date,
      "endsOn" date,
      "daysOfWeek" jsonb,
      "minStayNights" integer,
      "maxStayNights" integer,
      "priceDeltaAmount" text,
      "rulePayload" jsonb
    )
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
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.inventory_days) AS inventory(
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
    INSERT INTO pms.room_blocks
      (id, property_id, room_type_id, room_id, starts_on, ends_on, blocked_count, reason, status, created_by_user_id, created_at, released_at)
    SELECT
      room_block.id,
      source.property_id,
      room_block."roomTypeId",
      room_block."roomId",
      room_block."startsOn",
      room_block."endsOn",
      room_block."blockedCount",
      room_block.reason,
      room_block.status,
      source.owner_user_id,
      room_block."createdAt",
      room_block."releasedAt"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.room_blocks) AS room_block(
      id uuid,
      "roomTypeId" uuid,
      "roomId" uuid,
      "startsOn" date,
      "endsOn" date,
      "blockedCount" integer,
      reason text,
      status text,
      "createdAt" timestamptz,
      "releasedAt" timestamptz
    )
  `);

  await client.query(`
    INSERT INTO pms.operational_booking_assignments
      (
        id,
        property_id,
        guest_booking_id,
        room_type_id,
        rate_plan_id,
        room_id,
        position,
        assignment_status,
        pms_reservation_ref,
        external_reservation_id,
        channel,
        source,
        assignment_payload,
        assigned_at
      )
    SELECT
      assignment.id,
      source.property_id,
      source.guest_booking_id,
      assignment."roomTypeId",
      assignment."ratePlanId",
      assignment."roomId",
      assignment.position,
      assignment."assignmentStatus",
      assignment."pmsReservationRef",
      assignment."externalReservationId",
      assignment.channel,
      assignment.source,
      assignment."assignmentPayload",
      assignment."assignedAt"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.assignments) AS assignment(
      id uuid,
      "roomTypeId" uuid,
      "ratePlanId" uuid,
      "roomId" uuid,
      position integer,
      "assignmentStatus" text,
      "pmsReservationRef" text,
      "externalReservationId" text,
      channel text,
      source text,
      "assignmentPayload" jsonb,
      "assignedAt" timestamptz
    )
  `);

  await client.query(`
    INSERT INTO pms.checkin_checklist_templates
      (property_id, steps, updated_by_user_id, updated_at)
    SELECT
      property_id,
      checkin_template->'steps',
      owner_user_id,
      (checkin_template->>'updatedAt')::timestamptz
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO pms.checkout_inspection_templates
      (property_id, steps, updated_by_user_id, updated_at)
    SELECT
      property_id,
      checkout_template->'steps',
      owner_user_id,
      (checkout_template->>'updatedAt')::timestamptz
    FROM migration_source_pms.operations_snapshot_inputs
  `);

  await client.query(`
    INSERT INTO pms.booking_checkin_records
      (id, property_id, guest_booking_id, assignment_id, completed_by_user_id, completed_at, step_results, pending_flags)
    SELECT
      checkin_record.id,
      source.property_id,
      source.guest_booking_id,
      checkin_record."assignmentId",
      source.owner_user_id,
      checkin_record."completedAt",
      checkin_record."stepResults",
      checkin_record."pendingFlags"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.checkin_records) AS checkin_record(
      id uuid,
      "assignmentId" uuid,
      "completedAt" timestamptz,
      "stepResults" jsonb,
      "pendingFlags" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.booking_checkout_charges
      (id, property_id, guest_booking_id, assignment_id, label, amount, original_amount, currency, status, created_by_user_id, created_at, settled_at)
    SELECT
      checkout_charge.id,
      source.property_id,
      source.guest_booking_id,
      checkout_charge."assignmentId",
      checkout_charge.label,
      checkout_charge.amount::numeric,
      checkout_charge."originalAmount"::numeric,
      checkout_charge.currency,
      checkout_charge.status,
      source.owner_user_id,
      checkout_charge."createdAt",
      checkout_charge."settledAt"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.checkout_charges) AS checkout_charge(
      id uuid,
      "assignmentId" uuid,
      label text,
      amount text,
      "originalAmount" text,
      currency char(3),
      status text,
      "createdAt" timestamptz,
      "settledAt" timestamptz
    )
  `);

  await client.query(`
    INSERT INTO pms.booking_checkout_records
      (id, property_id, guest_booking_id, assignment_id, completed_by_user_id, completed_at, inspection_results, charges_settled, pending_flags, checkout_notes)
    SELECT
      checkout_record.id,
      source.property_id,
      source.guest_booking_id,
      checkout_record."assignmentId",
      source.owner_user_id,
      checkout_record."completedAt",
      checkout_record."inspectionResults",
      checkout_record."chargesSettled",
      checkout_record."pendingFlags",
      checkout_record."checkoutNotes"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.checkout_records) AS checkout_record(
      id uuid,
      "assignmentId" uuid,
      "completedAt" timestamptz,
      "inspectionResults" jsonb,
      "chargesSettled" jsonb,
      "pendingFlags" jsonb,
      "checkoutNotes" text
    )
  `);

  await client.query(`
    INSERT INTO pms.booking_notes_private
      (id, property_id, guest_booking_id, author_user_id, author_display_name, body, source, created_at)
    SELECT
      private_note.id,
      source.property_id,
      source.guest_booking_id,
      source.owner_user_id,
      private_note."authorDisplayName",
      private_note.body,
      private_note.source,
      private_note."createdAt"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.private_notes) AS private_note(
      id uuid,
      "authorDisplayName" text,
      body text,
      source text,
      "createdAt" timestamptz
    )
  `);

  await client.query(`
    INSERT INTO pms.message_threads
      (
        id,
        property_id,
        guest_booking_id,
        source,
        source_thread_id,
        source_booking_id,
        provider_channel,
        delivery_channel,
        guest_display_name,
        guest_email,
        attention_state,
        done_at,
        done_reason,
        conversation_context_state,
        last_message_at,
        last_message_preview,
        last_message_direction,
        unread_count
      )
    SELECT
      message_thread.id,
      source.property_id,
      source.guest_booking_id,
      message_thread.source,
      message_thread."sourceThreadId",
      message_thread."sourceBookingId",
      message_thread.channel,
      CASE WHEN message_thread.source = 'manual' THEN 'email' ELSE 'ota' END,
      message_thread."guestDisplayName",
      message_thread."guestEmail",
      CASE WHEN message_thread.status = 'open' THEN 'needs_attention' ELSE 'done' END,
      CASE WHEN message_thread.status = 'open' THEN NULL ELSE now() END,
      CASE message_thread.status
        WHEN 'no_reply_needed' THEN 'legacy_no_reply_needed'
        WHEN 'closed' THEN 'legacy_closed'
      END,
      CASE WHEN source.guest_booking_id IS NOT NULL THEN 'linked' ELSE 'unlinked' END,
      message_thread."lastMessageAt",
      message_thread."lastMessagePreview",
      message_thread."lastMessageDirection",
      message_thread."unreadCount"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.message_threads) AS message_thread(
      id uuid,
      source text,
      "sourceThreadId" text,
      "sourceBookingId" text,
      channel text,
      "guestDisplayName" text,
      "guestEmail" text,
      status text,
      "lastMessageAt" timestamptz,
      "lastMessagePreview" text,
      "lastMessageDirection" text,
      "unreadCount" integer
    )
  `);

  await client.query(`
    INSERT INTO pms.messages
      (id, property_id, thread_id, source_message_id, direction, sender_type, sender_user_id, sender_display_name, body, sent_at, received_at, read_at, raw_payload, pii_retention_until)
    SELECT
      message.id,
      source.property_id,
      message."threadId",
      message."sourceMessageId",
      message.direction,
      message."senderType",
      message."senderUserId",
      message."senderDisplayName",
      message.body,
      message."sentAt",
      message."receivedAt",
      message."readAt",
      message."rawPayload",
      message."piiRetentionUntil"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.messages) AS message(
      id uuid,
      "threadId" uuid,
      "sourceMessageId" text,
      direction text,
      "senderType" text,
      "senderUserId" uuid,
      "senderDisplayName" text,
      body text,
      "sentAt" timestamptz,
      "receivedAt" timestamptz,
      "readAt" timestamptz,
      "rawPayload" jsonb,
      "piiRetentionUntil" date
    )
  `);

  await client.query(`
    INSERT INTO pms.message_attachments
      (id, property_id, message_id, s3_key, filename, content_type, size_bytes, source_attachment_id)
    SELECT
      attachment.id,
      source.property_id,
      attachment."messageId",
      attachment."s3Key",
      attachment.filename,
      attachment."contentType",
      attachment."sizeBytes",
      attachment."sourceAttachmentId"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.message_attachments) AS attachment(
      id uuid,
      "messageId" uuid,
      "s3Key" text,
      filename text,
      "contentType" text,
      "sizeBytes" integer,
      "sourceAttachmentId" text
    )
  `);

  await client.query(`
    INSERT INTO pms.channel_connections
      (
        id,
        property_id,
        provider,
        connection_status,
        external_property_id,
        capabilities,
        messaging_app_installed,
        last_booking_sync_at,
        last_ari_sync_at,
        last_message_sync_at,
        connection_metadata
      )
    SELECT
      connection.id,
      source.property_id,
      connection.provider,
      connection."connectionStatus",
      connection."externalPropertyId",
      ARRAY(
        SELECT jsonb_array_elements_text(connection.capabilities)
      ),
      connection."messagingAppInstalled",
      connection."lastBookingSyncAt",
      connection."lastAriSyncAt",
      connection."lastMessageSyncAt",
      connection."connectionMetadata"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.channel_connections) AS connection(
      id uuid,
      provider text,
      "connectionStatus" text,
      "externalPropertyId" text,
      capabilities jsonb,
      "messagingAppInstalled" boolean,
      "lastBookingSyncAt" timestamptz,
      "lastAriSyncAt" timestamptz,
      "lastMessageSyncAt" timestamptz,
      "connectionMetadata" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.channel_room_type_mappings
      (id, property_id, connection_id, room_type_id, external_room_type_id, status, mapping_metadata)
    SELECT
      room_mapping.id,
      source.property_id,
      room_mapping."connectionId",
      room_mapping."roomTypeId",
      room_mapping."externalRoomTypeId",
      room_mapping.status,
      room_mapping."mappingMetadata"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.channel_room_type_mappings) AS room_mapping(
      id uuid,
      "connectionId" uuid,
      "roomTypeId" uuid,
      "externalRoomTypeId" text,
      status text,
      "mappingMetadata" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.channel_rate_plan_mappings
      (
        id,
        property_id,
        connection_id,
        room_type_id,
        rate_plan_id,
        channel,
        external_room_type_id,
        external_rate_plan_id,
        sell_mode,
        markup_percent,
        status,
        mapping_metadata
      )
    SELECT
      rate_mapping.id,
      source.property_id,
      rate_mapping."connectionId",
      rate_mapping."roomTypeId",
      rate_mapping."ratePlanId",
      rate_mapping.channel,
      rate_mapping."externalRoomTypeId",
      rate_mapping."externalRatePlanId",
      rate_mapping."sellMode",
      rate_mapping."markupPercent"::numeric,
      rate_mapping.status,
      rate_mapping."mappingMetadata"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.channel_rate_plan_mappings) AS rate_mapping(
      id uuid,
      "connectionId" uuid,
      "roomTypeId" uuid,
      "ratePlanId" uuid,
      channel text,
      "externalRoomTypeId" text,
      "externalRatePlanId" text,
      "sellMode" text,
      "markupPercent" text,
      status text,
      "mappingMetadata" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.channel_booking_mappings
      (id, property_id, connection_id, guest_booking_id, assignment_id, external_booking_id, external_revision_id, channel, channel_room_index, sync_status, last_synced_at, mapping_metadata)
    SELECT
      booking_mapping.id,
      source.property_id,
      booking_mapping."connectionId",
      source.guest_booking_id,
      booking_mapping."assignmentId",
      booking_mapping."externalBookingId",
      booking_mapping."externalRevisionId",
      booking_mapping.channel,
      booking_mapping."channelRoomIndex",
      booking_mapping."syncStatus",
      booking_mapping."lastSyncedAt",
      booking_mapping."mappingMetadata"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.channel_booking_mappings) AS booking_mapping(
      id uuid,
      "connectionId" uuid,
      "assignmentId" uuid,
      "externalBookingId" text,
      "externalRevisionId" text,
      channel text,
      "channelRoomIndex" integer,
      "syncStatus" text,
      "lastSyncedAt" timestamptz,
      "mappingMetadata" jsonb
    )
  `);

  await client.query(`
    INSERT INTO pms.channel_sync_status
      (id, property_id, connection_id, sync_domain, status, last_attempt_at, last_success_at, sync_payload)
    SELECT
      sync_status.id,
      source.property_id,
      sync_status."connectionId",
      sync_status."syncDomain",
      sync_status.status,
      sync_status."lastAttemptAt",
      sync_status."lastSuccessAt",
      sync_status."syncPayload"
    FROM migration_source_pms.operations_snapshot_inputs source
    CROSS JOIN LATERAL jsonb_to_recordset(source.channel_sync_statuses) AS sync_status(
      id uuid,
      "connectionId" uuid,
      "syncDomain" text,
      status text,
      "lastAttemptAt" timestamptz,
      "lastSuccessAt" timestamptz,
      "syncPayload" jsonb
    )
  `);
}
