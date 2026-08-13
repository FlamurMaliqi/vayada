import type pg from "pg";

import type { ExpectedTarget, ParityFinding, ParityHandlerContext } from "../../parityTypes.js";

type PmsOperationsPropertyCheck = NonNullable<
  ExpectedTarget["pmsOperationsChecks"]
>["properties"][number];

async function checkPmsOwnershipLink(
  client: pg.Client,
  check: PmsOperationsPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM identity.organization_resource_links link
       JOIN identity.product_entitlements entitlement
         ON entitlement.organization_id = link.organization_id
        AND entitlement.product = 'pms'
        AND entitlement.entitlement_key = 'pms-core'
        AND entitlement.status = 'active'
        AND entitlement.resource_product = 'pms'
        AND entitlement.resource_type = 'pms_property'
        AND entitlement.resource_id = link.resource_id
      JOIN hotel_catalog.property_source_links source
        ON source.source_system = 'pms'
        AND source.source_table = 'hotels'
        AND source.source_id = $2
        AND source.relationship = 'operational_input'
        AND source.property_id = $3
      WHERE link.organization_id = $1
         AND link.product = 'pms'
         AND link.resource_type = 'pms_property'
         AND link.resource_id = $3::text
         AND link.relationship = 'operator'
         AND link.status = 'active'
     ) AS exists`,
    [check.organizationId, check.pmsHotelResourceId, check.propertyId],
  );

  if (!result.rows[0].exists) {
    findings.push({
      severity: "fail",
      code: "PMS_OPERATIONS_OWNERSHIP_LINK_MISMATCH",
      owner: "PMS operations",
      targetObject: "identity.organization_resource_links",
      message: `Expected PMS property ${check.propertyId} to link organization ${check.organizationId} to source hotel ${check.pmsHotelResourceId}`,
      expected:
        "Active PMS operator resource link, active pms-core entitlement, and PMS operational property source link",
      actual: "relationship not found",
      suggestedAction:
        "Check tenant/resource ownership backfill before accepting PMS operational rows for the property.",
    });
  }
}

async function checkPmsOperationalSlice(
  client: pg.Client,
  check: PmsOperationsPropertyCheck,
  findings: ParityFinding[],
): Promise<void> {
  const result = await client.query<{
    room_type_source_system: string | null;
    room_source_system: string | null;
    source_room_type_id: string | null;
    source_room_id: string | null;
    room_number: string | null;
    rate_plan_code: string | null;
    rate_rule_id: string | null;
    inventory_total_count: string | null;
    inventory_assigned_count: string | null;
    inventory_blocked_count: string | null;
    inventory_available_count: string | null;
    inventory_status: string | null;
    room_block_id: string | null;
    room_block_status: string | null;
    public_reference: string | null;
    lifecycle_status: string | null;
    assignment_status: string | null;
    assignment_channel: string | null;
    assignment_external_reservation_id: string | null;
    checkin_record_id: string | null;
    checkin_step_count: string | null;
    checkout_charge_id: string | null;
    checkout_charge_count: string;
    checkout_record_id: string | null;
    private_note_id: string | null;
    private_note_count: string;
    message_thread_id: string | null;
    message_id: string | null;
    message_count: string;
    attachment_id: string | null;
    attachment_count: string;
    channel_connection_id: string | null;
    channel_room_type_mapping_id: string | null;
    external_room_type_id: string | null;
    channel_rate_plan_mapping_id: string | null;
    rate_mapping_channel: string | null;
    external_rate_plan_id: string | null;
    channel_booking_mapping_id: string | null;
    booking_mapping_channel: string | null;
    external_booking_id: string | null;
    booking_sync_status_id: string | null;
    sync_status_count: string;
    booker_country_code: string | null;
    booker_country_code_raw: string | null;
    booker_country_code_review_required: boolean | null;
  }>(
    `SELECT
       rt.source_system AS room_type_source_system,
       room.source_system AS room_source_system,
       rt.source_room_type_id,
       room.source_room_id,
       room.room_number,
       rate_plan.code AS rate_plan_code,
       rate_rule.id::text AS rate_rule_id,
       inventory.total_count::text AS inventory_total_count,
       inventory.assigned_count::text AS inventory_assigned_count,
       inventory.blocked_count::text AS inventory_blocked_count,
       inventory.available_count::text AS inventory_available_count,
       inventory.status AS inventory_status,
       room_block.id::text AS room_block_id,
       room_block.status AS room_block_status,
       booking.public_reference,
       booking.lifecycle_status,
       BTRIM(booker.country_code) AS booker_country_code,
       booker.country_code_raw AS booker_country_code_raw,
       booker.country_code_review_required AS booker_country_code_review_required,
       assignment.assignment_status,
       assignment.channel AS assignment_channel,
       assignment.external_reservation_id AS assignment_external_reservation_id,
       checkin.id::text AS checkin_record_id,
       jsonb_array_length(checkin.step_results)::text AS checkin_step_count,
       checkout_charge.id::text AS checkout_charge_id,
       (
         SELECT count(*)::text
         FROM pms.booking_checkout_charges charge_count
         WHERE charge_count.property_id = $1
           AND charge_count.guest_booking_id = $8
       ) AS checkout_charge_count,
       checkout_record.id::text AS checkout_record_id,
       private_note.id::text AS private_note_id,
       (
         SELECT count(*)::text
         FROM pms.booking_notes_private note_count
         WHERE note_count.property_id = $1
           AND note_count.guest_booking_id = $8
       ) AS private_note_count,
       thread.id::text AS message_thread_id,
       message.id::text AS message_id,
       (
         SELECT count(*)::text
         FROM pms.messages message_count
         WHERE message_count.property_id = $1
           AND message_count.thread_id = $14
       ) AS message_count,
       attachment.id::text AS attachment_id,
       (
         SELECT count(*)::text
         FROM pms.message_attachments attachment_count
         WHERE attachment_count.property_id = $1
           AND attachment_count.message_id = $15
       ) AS attachment_count,
       connection.id::text AS channel_connection_id,
       room_mapping.id::text AS channel_room_type_mapping_id,
       room_mapping.external_room_type_id,
       rate_mapping.id::text AS channel_rate_plan_mapping_id,
       rate_mapping.channel AS rate_mapping_channel,
       rate_mapping.external_rate_plan_id,
       booking_mapping.id::text AS channel_booking_mapping_id,
       booking_mapping.channel AS booking_mapping_channel,
       booking_mapping.external_booking_id,
       booking_sync.id::text AS booking_sync_status_id,
       (
         SELECT count(*)::text
         FROM pms.channel_sync_status sync_count
         WHERE sync_count.property_id = $1
           AND sync_count.connection_id = $17
       ) AS sync_status_count
     FROM pms.room_types rt
     LEFT JOIN pms.rooms room
       ON room.id = $3
      AND room.property_id = rt.property_id
      AND room.room_type_id = rt.id
     LEFT JOIN pms.rate_plans rate_plan
       ON rate_plan.id = $4
      AND rate_plan.property_id = rt.property_id
      AND rate_plan.room_type_id = rt.id
     LEFT JOIN pms.rate_rules rate_rule
       ON rate_rule.id = $5
      AND rate_rule.property_id = rt.property_id
      AND rate_rule.room_type_id = rt.id
      AND rate_rule.rate_plan_id = rate_plan.id
     LEFT JOIN pms.inventory_days inventory
       ON inventory.property_id = rt.property_id
      AND inventory.room_type_id = rt.id
      AND inventory.stay_date = $6::date
     LEFT JOIN pms.room_blocks room_block
       ON room_block.id = $7
      AND room_block.property_id = rt.property_id
      AND room_block.room_type_id = rt.id
     LEFT JOIN booking.guest_bookings booking
       ON booking.id = $8
      AND booking.property_id = rt.property_id
     LEFT JOIN pms.operational_booking_assignments assignment
       ON assignment.id = $9
      AND assignment.property_id = rt.property_id
      AND assignment.guest_booking_id = booking.id
      AND assignment.room_type_id = rt.id
      AND assignment.rate_plan_id = rate_plan.id
      AND assignment.room_id = room.id
     LEFT JOIN booking.booking_guests booker
       ON booker.guest_booking_id = booking.id
      AND booker.guest_role = 'booker'
     LEFT JOIN pms.booking_checkin_records checkin
       ON checkin.id = $10
      AND checkin.property_id = rt.property_id
      AND checkin.guest_booking_id = booking.id
      AND checkin.assignment_id = assignment.id
     LEFT JOIN pms.booking_checkout_charges checkout_charge
       ON checkout_charge.id = $11
      AND checkout_charge.property_id = rt.property_id
      AND checkout_charge.guest_booking_id = booking.id
      AND checkout_charge.assignment_id = assignment.id
     LEFT JOIN pms.booking_checkout_records checkout_record
       ON checkout_record.id = $12
      AND checkout_record.property_id = rt.property_id
      AND checkout_record.guest_booking_id = booking.id
      AND checkout_record.assignment_id = assignment.id
     LEFT JOIN pms.booking_notes_private private_note
       ON private_note.id = $13
      AND private_note.property_id = rt.property_id
      AND private_note.guest_booking_id = booking.id
     LEFT JOIN pms.message_threads thread
       ON thread.id = $14
      AND thread.property_id = rt.property_id
      AND thread.guest_booking_id = booking.id
     LEFT JOIN pms.messages message
       ON message.id = $15
      AND message.property_id = rt.property_id
      AND message.thread_id = thread.id
     LEFT JOIN pms.message_attachments attachment
       ON attachment.id = $16
      AND attachment.property_id = rt.property_id
      AND attachment.message_id = message.id
     LEFT JOIN pms.channel_connections connection
       ON connection.id = $17
      AND connection.property_id = rt.property_id
     LEFT JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.id = $18
      AND room_mapping.property_id = rt.property_id
      AND room_mapping.connection_id = connection.id
      AND room_mapping.room_type_id = rt.id
     LEFT JOIN pms.channel_rate_plan_mappings rate_mapping
       ON rate_mapping.id = $19
      AND rate_mapping.property_id = rt.property_id
      AND rate_mapping.connection_id = connection.id
      AND rate_mapping.room_type_id = rt.id
      AND rate_mapping.rate_plan_id = rate_plan.id
     LEFT JOIN pms.channel_booking_mappings booking_mapping
       ON booking_mapping.id = $20
      AND booking_mapping.property_id = rt.property_id
      AND booking_mapping.connection_id = connection.id
      AND booking_mapping.guest_booking_id = booking.id
      AND booking_mapping.assignment_id = assignment.id
     LEFT JOIN pms.channel_sync_status booking_sync
       ON booking_sync.id = $21
      AND booking_sync.property_id = rt.property_id
      AND booking_sync.connection_id = connection.id
      AND booking_sync.sync_domain = 'booking'
     WHERE rt.property_id = $1
       AND rt.id = $2`,
    [
      check.propertyId,
      check.roomTypeId,
      check.roomId,
      check.ratePlanId,
      check.rateRuleId,
      check.inventoryDate,
      check.roomBlockId,
      check.guestBookingId,
      check.assignmentId,
      check.checkinRecordId,
      check.checkoutChargeId,
      check.checkoutRecordId,
      check.privateNoteId,
      check.messageThreadId,
      check.messageId,
      check.messageAttachmentId,
      check.channelConnectionId,
      check.channelRoomTypeMappingId,
      check.channelRatePlanMappingId,
      check.channelBookingMappingId,
      check.bookingSyncStatusId,
    ],
  );

  const row = result.rows[0];
  const actual = row
    ? {
        roomTypeSourceSystem: row.room_type_source_system,
        roomSourceSystem: row.room_source_system,
        sourceRoomTypeId: row.source_room_type_id,
        sourceRoomId: row.source_room_id,
        roomNumber: row.room_number,
        ratePlanCode: row.rate_plan_code,
        rateRuleId: row.rate_rule_id,
        inventoryTotalCount: parseInt(row.inventory_total_count ?? "-1", 10),
        inventoryAssignedCount: parseInt(row.inventory_assigned_count ?? "-1", 10),
        inventoryBlockedCount: parseInt(row.inventory_blocked_count ?? "-1", 10),
        inventoryAvailableCount: parseInt(row.inventory_available_count ?? "-1", 10),
        inventoryStatus: row.inventory_status,
        roomBlockId: row.room_block_id,
        roomBlockStatus: row.room_block_status,
        publicBookingReference: row.public_reference,
        lifecycleStatus: row.lifecycle_status,
        bookerCountryCode: row.booker_country_code,
        bookerCountryCodeRaw: row.booker_country_code_raw,
        bookerCountryCodeReviewRequired: row.booker_country_code_review_required,
        assignmentStatus: row.assignment_status,
        channel: row.assignment_channel,
        externalBookingId: row.assignment_external_reservation_id,
        checkinRecordId: row.checkin_record_id,
        checkinStepCount: parseInt(row.checkin_step_count ?? "-1", 10),
        checkoutChargeId: row.checkout_charge_id,
        checkoutChargeCount: parseInt(row.checkout_charge_count, 10),
        checkoutRecordId: row.checkout_record_id,
        privateNoteId: row.private_note_id,
        privateNoteCount: parseInt(row.private_note_count, 10),
        messageThreadId: row.message_thread_id,
        messageId: row.message_id,
        messageCount: parseInt(row.message_count, 10),
        messageAttachmentId: row.attachment_id,
        attachmentCount: parseInt(row.attachment_count, 10),
        channelConnectionId: row.channel_connection_id,
        channelRoomTypeMappingId: row.channel_room_type_mapping_id,
        externalRoomTypeId: row.external_room_type_id,
        channelRatePlanMappingId: row.channel_rate_plan_mapping_id,
        rateMappingChannel: row.rate_mapping_channel,
        externalRatePlanId: row.external_rate_plan_id,
        channelBookingMappingId: row.channel_booking_mapping_id,
        bookingMappingChannel: row.booking_mapping_channel,
        channelBookingExternalId: row.external_booking_id,
        bookingSyncStatusId: row.booking_sync_status_id,
        syncStatusCount: parseInt(row.sync_status_count, 10),
      }
    : null;

  const matches =
    actual &&
    actual.roomTypeSourceSystem === check.roomTypeSourceSystem &&
    actual.roomSourceSystem === check.roomSourceSystem &&
    actual.sourceRoomTypeId === check.sourceRoomTypeId &&
    actual.sourceRoomId === check.sourceRoomId &&
    actual.roomNumber === check.roomNumber &&
    actual.ratePlanCode === check.ratePlanCode &&
    actual.rateRuleId === check.rateRuleId &&
    actual.inventoryTotalCount === check.inventoryTotalCount &&
    actual.inventoryAssignedCount === check.inventoryAssignedCount &&
    actual.inventoryBlockedCount === check.inventoryBlockedCount &&
    actual.inventoryAvailableCount === check.inventoryAvailableCount &&
    actual.inventoryStatus === check.inventoryStatus &&
    actual.roomBlockId === check.roomBlockId &&
    actual.roomBlockStatus === "active" &&
    actual.publicBookingReference === check.publicBookingReference &&
    actual.lifecycleStatus === "completed" &&
    actual.bookerCountryCode === check.bookerCountryCode &&
    actual.bookerCountryCodeRaw === check.bookerCountryCodeRaw &&
    actual.bookerCountryCodeReviewRequired === check.bookerCountryCodeReviewRequired &&
    actual.assignmentStatus === check.assignmentStatus &&
    actual.channel === check.channel &&
    actual.externalBookingId === check.externalBookingId &&
    actual.checkinRecordId === check.checkinRecordId &&
    actual.checkinStepCount > 0 &&
    actual.checkoutChargeId === check.checkoutChargeId &&
    actual.checkoutChargeCount === check.checkoutChargeCount &&
    actual.checkoutRecordId === check.checkoutRecordId &&
    actual.privateNoteId === check.privateNoteId &&
    actual.privateNoteCount === check.privateNoteCount &&
    actual.messageThreadId === check.messageThreadId &&
    actual.messageId === check.messageId &&
    actual.messageCount === check.messageCount &&
    actual.messageAttachmentId === check.messageAttachmentId &&
    actual.attachmentCount === check.attachmentCount &&
    actual.channelConnectionId === check.channelConnectionId &&
    actual.channelRoomTypeMappingId === check.channelRoomTypeMappingId &&
    actual.externalRoomTypeId === check.externalRoomTypeId &&
    actual.channelRatePlanMappingId === check.channelRatePlanMappingId &&
    actual.rateMappingChannel === check.channel &&
    actual.externalRatePlanId === check.externalRatePlanId &&
    actual.channelBookingMappingId === check.channelBookingMappingId &&
    actual.bookingMappingChannel === check.channel &&
    actual.channelBookingExternalId === check.externalBookingId &&
    actual.bookingSyncStatusId === check.bookingSyncStatusId &&
    actual.syncStatusCount === check.syncStatusCount;

  if (!matches) {
    findings.push({
      severity: "fail",
      code: "PMS_OPERATIONS_FIXTURE_MISMATCH",
      owner: "PMS operations",
      targetObject: "pms.operational_booking_assignments",
      message: `Expected PMS operational slice for booking ${check.guestBookingId} was not found`,
      expected:
        "Matching room/rate/inventory/block, operational assignment, check-in/out, private note, messaging, and channel mapping rows",
      actual: actual ? JSON.stringify(actual) : "row missing",
      suggestedAction:
        "Check PMS operations fixture rows and target relationship preservation across the PMS operational tables.",
    });
  }
}

async function checkOperationalSummarySafety(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const forbiddenKeys = expected.pmsOperationsChecks?.forbiddenOperationalSummaryKeys ?? [];
  if (forbiddenKeys.length === 0) return;

  const result = await client.query<{ guest_booking_id: string; summary: string }>(
    `SELECT guest_booking_id::text,
            concat_ws(
              ' ',
              public_reference,
              lifecycle_status,
              payment_status,
              guest_counts::text,
              room_summary::text,
              amount_summary::text,
              public_policy::text,
              source_freshness::text
            ) AS summary
     FROM booking.direct_booking_summary_read_model`,
  );

  for (const row of result.rows) {
    const matchedKey = forbiddenKeys.find((key) => row.summary.includes(key));
    if (!matchedKey) continue;

    findings.push({
      severity: "fail",
      code: "PMS_OPERATIONS_PRIVATE_KEY_LEAK",
      owner: "PMS operations",
      targetObject: "booking.direct_booking_summary_read_model",
      message: `Booking summary ${row.guest_booking_id} contains forbidden private PMS key ${matchedKey}`,
      expected:
        "No private PMS note, message, or operational charge detail in public booking summary",
      actual: matchedKey,
      suggestedAction:
        "Keep PMS operational private data in PMS tables and project only public-safe booking summary fields.",
    });
  }
}

async function checkPmsOperationsFixtures(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  const checks = expected.pmsOperationsChecks;
  if (!checks) return;

  for (const check of checks.properties) {
    await checkPmsOwnershipLink(client, check, findings);
    await checkPmsOperationalSlice(client, check, findings);
  }

  await checkOperationalSummarySafety(client, expected, findings);
}

export async function checkPmsOperationsParity({
  client,
  expected,
  findings,
}: ParityHandlerContext): Promise<void> {
  await checkPmsOperationsFixtures(client, expected, findings);
}
