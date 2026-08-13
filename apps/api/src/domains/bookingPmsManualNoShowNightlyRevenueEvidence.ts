import { getTimezone } from "countries-and-timezones";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceClient,
} from "./bookingExternalNightlyRevenueEvidence.js";

type ManualBookingScope = { sourceBookingReference: string; timezone: string | null };
type CurrentNight = {
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  grossRoomAmount: string;
  linePosition: number;
  correctsEvidenceId: string;
  manualExact: boolean;
};

export async function appendPmsManualNoShowNightlyRevenueEvidence(
  transaction: ExternalRevenueEvidenceClient,
  command: {
    propertyId: string;
    guestBookingId: string;
    idempotencyKey: string;
  },
  acceptedAt: string,
): Promise<void> {
  const booking = await transaction.query<ManualBookingScope>(
    `SELECT source_booking_id AS "sourceBookingReference",
       (SELECT timezone FROM hotel_catalog.property_locations
        WHERE property_id = booking.property_id) AS timezone
     FROM booking.guest_bookings booking
     WHERE id = $1::uuid AND property_id = $2::uuid AND source_system = 'pms'
       AND booking_metadata->>'contractVersion' = 'pms-manual-booking.v1'
     FOR UPDATE`,
    [command.guestBookingId, command.propertyId],
  );
  const scope = booking.rows[0];
  if (!scope) return;
  const zone = scope.timezone && getTimezone(scope.timezone);
  if (!zone || zone.name !== scope.timezone || zone.aliasOf !== null) {
    throw new Error("Manual no-show requires a canonical property timezone");
  }
  const localDate = propertyDate(acceptedAt, scope.timezone!);
  const current = await transaction.query<CurrentNight>(
    `SELECT (array_agg(room_type_id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "roomTypeId",
       stay_date::text AS "stayDate", GREATEST($2::date,MAX(recognized_on))::text AS "recognizedOn",
       (-SUM(gross_room_amount))::text AS "grossRoomAmount", line_position AS "linePosition",
       (array_agg(id::text ORDER BY source_revision DESC,created_at DESC,id DESC))[1] AS "correctsEvidenceId",
       bool_and(source_kind='manual' AND evidence_quality='exact') AS "manualExact"
     FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1::uuid
       AND economic_event<>'retained_charge' GROUP BY stay_date,line_position
     HAVING SUM(occupied_room_nights)=1 ORDER BY stay_date,line_position`,
    [command.guestBookingId, localDate],
  );
  if (current.rows.length === 0 || current.rows.some(({ manualExact }) => !manualExact)) {
    throw new Error("Manual no-show nightly revenue evidence is unavailable");
  }
  await appendExternalNightlyRevenueEvidence(transaction, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    sourceKind: "manual",
    sourceBookingReference: scope.sourceBookingReference,
    idempotencyKey: `pms-no-show:${command.idempotencyKey}:nightly-revenue:v1`,
    lines: current.rows.map((night) => ({
      ...night,
      occupiedRoomNights: -1,
      economicEvent: "occupancy_adjustment",
      lifecycleState: "no_show",
      evidenceQuality: "exact",
    })),
  });
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
