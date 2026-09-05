import type { ManagePhysicalRoomCommand, ManagePhysicalRoomResult } from "@vayada/domain-pms";
import type { PmsPhysicalRoomUnitReconcileClient as Client } from "./pmsPhysicalRoomUnitReconcileRepository.js";

/** Runs inside the room command's inventory lock and savepoint. */
export async function refreshPhysicalRoomInventory(
  client: Client,
  command: ManagePhysicalRoomCommand,
  input: { activeCount: number; previousCount: number; idempotencyId: string; acceptedAt: string },
): Promise<ManagePhysicalRoomResult | null> {
  const { activeCount, previousCount, idempotencyId, acceptedAt } = input;
  const scope = [command.propertyId, command.roomTypeId];
  const blocked = (message: string, blockers: string[]): ManagePhysicalRoomResult => ({
    ok: false,
    error: { code: "physical_room_protected", message, blockers },
  });
  const dates = await client.query<{ today: string; through: string | null }>(
    `SELECT ($2::timestamptz AT TIME ZONE COALESCE((SELECT property_time_zone
      FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid ORDER BY calendar_revision DESC LIMIT 1),'UTC'))::date::text AS today,
      (SELECT max(stay_date)::text FROM pms.inventory_days WHERE property_id=$1::uuid) AS through`,
    [command.propertyId, acceptedAt],
  );
  const today = dates.rows[0]!.today;
  const through = dates.rows[0]!.through;
  if (activeCount < previousCount) {
    const protectedCapacity = await client.query<{ protected: boolean }>(
      `SELECT
      EXISTS(SELECT 1 FROM pms.inventory_days WHERE property_id=$1::uuid AND room_type_id=$2::uuid
        AND stay_date>=$4::date AND (assigned_count+blocked_count>$3 OR
          COALESCE(channel_sellable_limit_count,0)>$3 OR COALESCE(manual_sellable_limit_count,0)>$3))
      OR EXISTS(SELECT 1 FROM pms.operational_booking_assignments assignment
        JOIN booking.guest_bookings booking ON booking.id=assignment.guest_booking_id AND booking.property_id=assignment.property_id
        WHERE assignment.property_id=$1::uuid AND assignment.room_type_id=$2::uuid
        AND assignment.assignment_status NOT IN ('canceled','released') AND booking.lifecycle_status IN ('draft','pending_payment','confirmed'))
      OR EXISTS(SELECT 1 FROM pms.inventory_reservation_receipts receipt JOIN pms.inventory_reservation_statuses status USING(receipt_id)
        WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=$2::uuid AND status.lifecycle_state IN ('reserved','handed_off') AND receipt.check_out>$4::date) AS protected`,
      [...scope, activeCount, today],
    );
    if (protectedCapacity.rows[0]?.protected)
      return blocked("Reservations or inventory overrides protect this room type's capacity.", [
        "reservations_or_inventory",
      ]);
  }
  const current = await client.query<{
    revision: number;
    bound: boolean;
    count: number;
    limit: number;
  }>(
    `SELECT
    calendar.calendar_revision AS revision, binding.room_type_id IS NOT NULL AS bound,
    binding.physical_capacity_count AS count, binding.starting_sellable_limit_count AS limit
    FROM pms.operating_calendar_revisions calendar LEFT JOIN pms.operating_calendar_room_bindings binding
      ON binding.property_id=calendar.property_id AND binding.calendar_revision=calendar.calendar_revision AND binding.room_type_id=$2::uuid
    WHERE calendar.property_id=$1::uuid ORDER BY calendar.calendar_revision DESC LIMIT 1`,
    scope,
  );
  const calendar = current.rows[0];
  if (calendar?.bound && activeCount === 0)
    return blocked(
      "The active operating calendar requires at least one physical room for this room type.",
      ["operating_calendar"],
    );
  if (
    command.action !== "retire" &&
    command.changes.status &&
    command.changes.status !== "available"
  ) {
    const inventory = await client.query(
      `SELECT 1 FROM pms.inventory_days WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date>=$3::date LIMIT 1`,
      [...scope, today],
    );
    if (inventory.rowCount)
      return blocked(
        "Use a dated room block for rooms with published inventory before changing their operational status.",
        ["published_inventory"],
      );
  }
  if (calendar?.bound) {
    const expired = await client.query(
      `SELECT 1 FROM pms.inventory_materialization_coverage
      WHERE property_id=$1::uuid AND coverage_through<$2::date LIMIT 1`,
      [command.propertyId, today],
    );
    if (expired.rowCount)
      return blocked("Extend the operating calendar before changing room capacity.", [
        "expired_inventory_coverage",
      ]);
    const stale = await client.query(
      `SELECT 1 FROM pms.operating_calendar_room_bindings binding
      JOIN pms.room_types room ON room.id=binding.room_type_id AND room.property_id=binding.property_id
      WHERE binding.property_id=$1::uuid AND binding.calendar_revision=$3 AND
      (NOT room.active OR room.room_facts_revision<>binding.source_room_facts_revision OR
       binding.source_room_units_revision<>CASE WHEN room.id=$2::uuid THEN $4 ELSE room.room_units_revision END)
      LIMIT 1`,
      [...scope, calendar.revision, command.expectedRevision],
    );
    if (stale.rowCount || calendar.count !== previousCount)
      return blocked("Refresh the operating calendar's room configuration before changing rooms.", [
        "stale_calendar",
      ]);
  }
  if (!calendar?.bound && activeCount !== previousCount) {
    const inventory = await client.query(
      `SELECT 1 FROM pms.inventory_days
      WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date>=$3::date LIMIT 1`,
      [...scope, today],
    );
    if (inventory.rowCount)
      return blocked(
        "Refresh the target operating calendar before changing capacity for rooms with existing inventory.",
        ["unconfigured_inventory"],
      );
  }
  if (calendar?.bound) {
    const incomplete = await client.query(
      `SELECT 1 FROM pms.inventory_materialization_coverage coverage
      WHERE coverage.property_id=$1::uuid AND (coverage.calendar_revision<>$2 OR coverage.materialized_day_count<>(
        SELECT count(*) FROM pms.inventory_days day WHERE day.property_id=coverage.property_id
        AND day.calendar_revision=coverage.calendar_revision AND day.stay_date BETWEEN coverage.coverage_from AND coverage.coverage_through
      ))
      UNION ALL SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM pms.inventory_materialization_coverage WHERE property_id=$1::uuid)
      AND EXISTS(SELECT 1 FROM pms.inventory_days WHERE property_id=$1::uuid AND calendar_revision IS NOT NULL)`,
      [command.propertyId, calendar.revision],
    );
    if (incomplete.rowCount)
      return blocked("Refresh incomplete or stale inventory coverage before changing rooms.", [
        "inventory_coverage",
      ]);
  }
  const event = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
    (source_system,event_key,event_type,event_version,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
    VALUES ('pms',$1,'pms.inventory.changed',1,$2::timestamptz,'property',$3::uuid,'pms','room_type',$4,$5::jsonb) RETURNING id::text`,
    [
      `physical-room:${idempotencyId}`,
      acceptedAt,
      ...scope,
      JSON.stringify({
        propertyId: command.propertyId,
        roomTypeId: command.roomTypeId,
        inventoryVersion: idempotencyId,
        dateRange: {
          from: today,
          to: through && through > today ? through : today,
        },
      }),
    ],
  );
  const eventId = event.rows[0]!.id;
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO platform.outbox_events
    (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
    SELECT id,$2,'pms.calendar-projection','pms.calendar.refresh_requested','property',property_id,'pms','room_type',resource_id,payload
    FROM platform.domain_events WHERE id=$1::uuid RETURNING id::text`,
    [eventId, `physical-room:${idempotencyId}:calendar`],
  );
  for (const [destination, eventType] of [
    ["pms.channel-manager", "pms.inventory.ari_changed"],
    ["distribution.public-bookability", "pms.inventory.changed"],
  ]) {
    await client.query(
      `INSERT INTO platform.outbox_events
      (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      SELECT id,$2,$3,$4,'property',property_id,'pms','room_type',resource_id,payload FROM platform.domain_events WHERE id=$1::uuid`,
      [eventId, `physical-room:${idempotencyId}:${destination}`, destination, eventType],
    );
  }
  if (!calendar?.bound) return null;
  const nextRevision = calendar.revision + 1;
  const nextLimit =
    calendar.limit === previousCount ? activeCount : Math.min(calendar.limit, activeCount);
  const args = [
    command.propertyId,
    calendar.revision,
    nextRevision,
    idempotencyId,
    eventId,
    outbox.rows[0]!.id,
    command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
    acceptedAt,
  ];
  await client.query(
    `INSERT INTO pms.operating_calendar_revisions
    (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,
    recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
    SELECT organization_id,property_id,$3,contract_version,property_profile_revision,property_time_zone,schedule_mode,
    recurring_period_count,room_binding_count,default_minimum_stay_nights,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::timestamptz,$8::timestamptz
    FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid AND calendar_revision=$2`,
    args,
  );
  await client.query(
    `INSERT INTO pms.operating_calendar_recurring_periods
    (property_id,calendar_revision,period_index,start_month,start_day,end_month,end_day)
    SELECT property_id,$3,period_index,start_month,start_day,end_month,end_day FROM pms.operating_calendar_recurring_periods
    WHERE property_id=$1::uuid AND calendar_revision=$2`,
    args.slice(0, 3),
  );
  await client.query(
    `INSERT INTO pms.operating_calendar_room_bindings
    (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
    SELECT property_id,$3,room_type_id,source_room_facts_revision,CASE WHEN room_type_id=$4::uuid THEN $5 ELSE source_room_units_revision END,
    CASE WHEN room_type_id=$4::uuid THEN $6 ELSE physical_capacity_count END,
    CASE WHEN room_type_id=$4::uuid THEN $7 ELSE starting_sellable_limit_count END
    FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid AND calendar_revision=$2`,
    [
      command.propertyId,
      calendar.revision,
      nextRevision,
      command.roomTypeId,
      command.expectedRevision + 1,
      activeCount,
      nextLimit,
    ],
  );
  await client.query(
    `UPDATE pms.inventory_days day SET calendar_revision=$3,generated_source_revision=$3,
    inventory_revision=inventory_revision+1,total_count=binding.physical_capacity_count,
    generated_sellable_limit_count=CASE WHEN day.generated_sellable_limit_count=0 THEN 0 ELSE binding.starting_sellable_limit_count END,
    effective_sellable_limit_count=COALESCE(day.manual_sellable_limit_count,day.channel_sellable_limit_count,
      CASE WHEN day.generated_sellable_limit_count=0 THEN 0 ELSE binding.starting_sellable_limit_count END),
    available_count=CASE WHEN day.status<>'open' OR day.linked_stop_sell OR day.rate_gate_open=FALSE THEN 0 ELSE GREATEST(0,
      COALESCE(day.manual_sellable_limit_count,day.channel_sellable_limit_count,
      CASE WHEN day.generated_sellable_limit_count=0 THEN 0 ELSE binding.starting_sellable_limit_count END)-day.assigned_count-day.blocked_count) END,
    updated_at=$4::timestamptz
    FROM pms.operating_calendar_room_bindings binding
    WHERE day.property_id=$1::uuid AND day.calendar_revision=$2 AND day.stay_date>=$5::date AND binding.property_id=day.property_id
      AND binding.calendar_revision=$3 AND binding.room_type_id=day.room_type_id`,
    [command.propertyId, calendar.revision, nextRevision, acceptedAt, today],
  );
  await client.query(
    `UPDATE pms.inventory_materialization_coverage SET calendar_revision=$3,materialized_revision=$3,
    coverage_from=GREATEST(coverage_from,$8::date),
    expected_day_count=room_type_count*(coverage_through-GREATEST(coverage_from,$8::date)+1),
    materialized_day_count=room_type_count*(coverage_through-GREATEST(coverage_from,$8::date)+1),
    last_changed_materialization_idempotency_key_id=$4::uuid,last_changed_materialization_domain_event_id=$5::uuid,
    last_changed_materialization_outbox_event_id=$6::uuid,updated_at=GREATEST($7::timestamptz,updated_at+interval '1 microsecond')
    WHERE property_id=$1::uuid AND calendar_revision=$2`,
    [...args.slice(0, 6), acceptedAt, today],
  );
  return null;
}
