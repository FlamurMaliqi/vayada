import { createHash } from "node:crypto";

import { getTimezone } from "countries-and-timezones";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceClient,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

type RetainedCharge = {
  linePosition: number;
  stayDate: string;
  amount: { amountDecimal: string; currency: string };
};
type BookingScope = {
  sourceBookingReference: string;
  currency: string;
  timezone: string | null;
  lifecycleStatus: string;
};
type CurrentNight = {
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  grossRoomAmount: string;
  linePosition: number;
  correctsEvidenceId: string;
  manualExact: boolean;
};

export class ManualCancellationEvidenceError extends Error {}
export class ManualCancellationStateError extends Error {
  constructor(
    message: string,
    readonly currentStatus: string,
  ) {
    super(message);
  }
}

export async function cancelPmsManualBooking(
  transaction: ExternalRevenueEvidenceClient,
  command: {
    propertyId: string;
    guestBookingId: string;
    idempotencyKey: string;
    commandId: string;
    reason?: string;
    accountingDate: string | null;
    retainedCharges: readonly RetainedCharge[];
    audit: { actor: { kind: string; userId?: string }; requestId: string; correlationId?: string };
  },
  acceptedAt: string,
): Promise<void> {
  const booking = await transaction.query<BookingScope>(
    `SELECT source_booking_id AS "sourceBookingReference",currency,
       lifecycle_status AS "lifecycleStatus",
       (SELECT timezone FROM hotel_catalog.property_locations
        WHERE property_id=booking.property_id) AS timezone
     FROM booking.guest_bookings booking WHERE id=$1::uuid AND property_id=$2::uuid
       AND source_system='pms' AND booking_metadata->>'contractVersion'='pms-manual-booking.v1'
     FOR UPDATE`,
    [command.guestBookingId, command.propertyId],
  );
  const scope = booking.rows[0];
  if (!scope || scope.lifecycleStatus !== "confirmed")
    throw new ManualCancellationStateError(
      "Manual booking cannot be canceled",
      scope?.lifecycleStatus ?? "missing",
    );
  const zone = scope.timezone && getTimezone(scope.timezone);
  if (!zone || zone.name !== scope.timezone || zone.aliasOf !== null)
    throw new ManualCancellationEvidenceError(
      "Manual cancellation requires a canonical property timezone",
    );
  const localDate = propertyDate(acceptedAt, scope.timezone!);
  if (
    (command.retainedCharges.length === 0 && command.accountingDate !== null) ||
    (command.retainedCharges.length > 0 &&
      (!command.accountingDate || command.accountingDate < localDate))
  )
    throw new ManualCancellationEvidenceError("Retained-charge accounting date is invalid");

  const current = await transaction.query<CurrentNight>(
    `SELECT (array_agg(room_type_id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "roomTypeId",
       stay_date::text AS "stayDate",GREATEST($2::date,MAX(recognized_on))::text AS "recognizedOn",
       (-SUM(gross_room_amount))::text AS "grossRoomAmount",line_position AS "linePosition",
       (array_agg(id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "correctsEvidenceId",
       bool_and(source_kind='manual' AND evidence_quality='exact') AS "manualExact"
     FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid
       AND economic_event<>'retained_charge' GROUP BY stay_date,line_position
     HAVING SUM(occupied_room_nights)=1 ORDER BY stay_date,line_position`,
    [command.guestBookingId, localDate],
  );
  if (current.rows.length === 0 || current.rows.some(({ manualExact }) => !manualExact))
    throw new ManualCancellationEvidenceError(
      "Manual cancellation nightly revenue evidence is unavailable",
    );

  await transaction.query(
    `WITH updated AS (
       UPDATE booking.guest_bookings SET lifecycle_status='canceled',
         cancellation_reason='property_cancellation',updated_at=$3::timestamptz
       WHERE id=$1::uuid AND property_id=$2::uuid AND lifecycle_status='confirmed' RETURNING id
     ) INSERT INTO booking.booking_status_events
       (guest_booking_id,event_type,from_status,to_status,actor_type,public_visible,
        public_message,event_payload,occurred_at)
     SELECT id,'guest_booking.canceled','confirmed','canceled','property_user',true,
       'Booking canceled.','{}'::jsonb,$3::timestamptz FROM updated`,
    [command.guestBookingId, command.propertyId, acceptedAt],
  );

  const nights = new Map(current.rows.map((night) => [key(night), night]));
  const retainedKeys = new Set<string>();
  const retained: ExternalRevenueEvidenceLine[] = command.retainedCharges.map((charge) => {
    const chargeKey = key(charge);
    const night = nights.get(chargeKey);
    if (
      !night ||
      retainedKeys.has(chargeKey) ||
      charge.amount.currency !== scope.currency ||
      night.recognizedOn > command.accountingDate!
    )
      throw new ManualCancellationEvidenceError("Retained charge does not match booking evidence");
    retainedKeys.add(chargeKey);
    return {
      roomTypeId: night.roomTypeId,
      stayDate: night.stayDate,
      recognizedOn: command.accountingDate!,
      grossRoomAmount: charge.amount.amountDecimal,
      occupiedRoomNights: 0,
      economicEvent: "retained_charge",
      lifecycleState: "canceled",
      evidenceQuality: "exact",
      linePosition: night.linePosition,
    };
  });
  await appendExternalNightlyRevenueEvidence(transaction, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    sourceKind: "manual",
    sourceBookingReference: scope.sourceBookingReference,
    idempotencyKey: `pms-cancel:${command.idempotencyKey}:occupancy:v1`,
    lines: current.rows.map((night) => ({
      ...night,
      occupiedRoomNights: -1 as const,
      economicEvent: "occupancy_adjustment" as const,
      lifecycleState: "canceled" as const,
      evidenceQuality: "exact" as const,
    })),
  });
  if (retained.length)
    await appendExternalNightlyRevenueEvidence(transaction, {
      propertyId: command.propertyId,
      guestBookingId: command.guestBookingId,
      sourceKind: "manual",
      sourceBookingReference: scope.sourceBookingReference,
      idempotencyKey: `pms-cancel:${command.idempotencyKey}:retained:v1`,
      lines: retained,
    });
  const hash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  const event = await transaction.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,
        resource_product,resource_type,resource_id,actor_type,actor_user_id,correlation_id,
        idempotency_key_hash,payload,privacy_scope)
     VALUES ('booking',$1,'booking.manual_booking.canceled.v1',$2::timestamptz,'property',$3::uuid,
       'booking','guest_booking',$4,$5,$6::uuid,$7,$8,$9::jsonb,'confidential') RETURNING id::text AS id`,
    [
      `booking.manual-cancellation.${command.guestBookingId}.${hash}.v1`,
      acceptedAt,
      command.propertyId,
      command.guestBookingId,
      command.audit.actor.kind,
      command.audit.actor.userId ?? null,
      command.audit.correlationId ?? command.audit.requestId,
      hash,
      JSON.stringify({ guestBookingId: command.guestBookingId, outcome: "canceled" }),
    ],
  );
  await transaction.query(
    `INSERT INTO platform.outbox_events
       (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
        resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload)
     SELECT $1::uuid,'booking.manual-cancellation.'||$2||'.'||item.destination||'.v1',
       item.destination,item."eventType",'property',$3::uuid,'booking','guest_booking',$2,$4,$5,
       jsonb_build_object('guestBookingId',$2::text)
     FROM jsonb_to_recordset($6::jsonb) item(destination text,"eventType" text)`,
    [
      event.rows[0]!.id,
      command.guestBookingId,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      hash,
      JSON.stringify([
        { destination: "pms.calendar", eventType: "pms.calendar.refresh.requested.v1" },
        { destination: "pms.ari", eventType: "pms.ari.changed.v1" },
      ]),
    ],
  );
}

function key(value: { stayDate: string; linePosition: number }): string {
  return `${value.stayDate}:${value.linePosition}`;
}

function propertyDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value["year"]}-${value["month"]}-${value["day"]}`;
}
