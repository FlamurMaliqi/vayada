import { createHash } from "node:crypto";

import { getTimezone } from "countries-and-timezones";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceClient,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

export type ManualStayCorrectionNight = {
  stayDate: string;
  amount: { amountDecimal: string; currency: string } | null;
  evidenceQuality: "exact" | "inferred" | "missing";
};
export type VerifiedManualStayCorrection = {
  assignmentId: string;
  position: number;
  roomId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  nightly: readonly ManualStayCorrectionNight[];
};
type Command = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  accountingDate: string;
  audit: { actor: { kind: string; userId?: string }; requestId: string; correlationId?: string };
};
type BookingScope = {
  sourceBookingReference: string;
  currency: string;
  lifecycleStatus: string;
  timezone: string | null;
};
type CurrentNight = {
  id: string;
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  amount: string | null;
  occupied: number;
  evidenceQuality: "exact" | "inferred" | "missing";
  linePosition: number;
  manual: boolean;
};
type RequestedNight = CurrentNight & { amount: string | null };

export class ManualStayCorrectionEvidenceError extends Error {}
export class ManualStayCorrectionStateError extends Error {
  constructor(
    message: string,
    readonly currentStatus: string,
  ) {
    super(message);
  }
}

export async function correctBookingPmsManualStays(
  transaction: ExternalRevenueEvidenceClient,
  command: Command,
  stays: readonly VerifiedManualStayCorrection[],
  acceptedAt: string,
): Promise<void> {
  const booking = await transaction.query<BookingScope>(
    `SELECT source_booking_id AS "sourceBookingReference",trim(currency) AS currency,
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
    throw new ManualStayCorrectionStateError(
      "Manual booking stays cannot be corrected",
      scope?.lifecycleStatus ?? "missing",
    );
  const zone = scope.timezone && getTimezone(scope.timezone);
  if (!zone || zone.name !== scope.timezone || zone.aliasOf !== null)
    throw new ManualStayCorrectionEvidenceError(
      "Manual stay correction requires a canonical property timezone",
    );
  if (command.accountingDate < propertyDate(acceptedAt, scope.timezone!))
    throw new ManualStayCorrectionEvidenceError(
      "Manual stay correction accounting date is invalid",
    );

  const requested = requestedNights(stays, scope.currency);
  const before = await loadCurrentNights(transaction, command);
  const active = before.filter(({ occupied }) => occupied === 1);
  if (
    active.length === 0 ||
    before.some(({ occupied, manual }) => !manual || ![0, 1].includes(occupied)) ||
    !sameKnownTotal(active, requested)
  )
    throw new ManualStayCorrectionEvidenceError(
      "Manual stay correction nightly revenue evidence is unavailable",
    );

  const requestedByKey = new Map(requested.map((night) => [key(night), night]));
  const unchanged = new Set<string>();
  const removals: ExternalRevenueEvidenceLine[] = [];
  for (const current of active) {
    const next = requestedByKey.get(key(current));
    if (next?.roomTypeId === current.roomTypeId) {
      if (next.amount !== current.amount || next.evidenceQuality !== current.evidenceQuality)
        throw new ManualStayCorrectionEvidenceError(
          "Price-only changes require the manual price-correction command",
        );
      unchanged.add(key(current));
      continue;
    }
    removals.push({
      roomTypeId: current.roomTypeId,
      stayDate: current.stayDate,
      recognizedOn: latest(command.accountingDate, current.recognizedOn, current.stayDate),
      grossRoomAmount: current.amount === null ? null : negate(current.amount),
      occupiedRoomNights: -1,
      economicEvent: "occupancy_adjustment",
      lifecycleState: "corrected",
      evidenceQuality: current.evidenceQuality,
      linePosition: current.linePosition,
      correctsEvidenceId: current.id,
    });
  }

  const checkIn = stays.reduce(
    (value, stay) => (stay.checkIn < value ? stay.checkIn : value),
    stays[0]!.checkIn,
  );
  const checkOut = stays.reduce(
    (value, stay) => (stay.checkOut > value ? stay.checkOut : value),
    stays[0]!.checkOut,
  );
  const updated = await transaction.query(
    `UPDATE booking.guest_bookings SET check_in=$3::date,check_out=$4::date,updated_at=$5::timestamptz
     WHERE id=$1::uuid AND property_id=$2::uuid AND lifecycle_status='confirmed'`,
    [command.guestBookingId, command.propertyId, checkIn, checkOut, acceptedAt],
  );
  if (updated.rowCount !== 1)
    throw new ManualStayCorrectionStateError("Manual booking stay state changed", "changed");
  await transaction.query(
    `INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id)
     SELECT $1::uuid,room_type_id::uuid FROM unnest($2::text[]) room_type_id
     ON CONFLICT DO NOTHING`,
    [command.propertyId, [...new Set(stays.map(({ roomTypeId }) => roomTypeId))]],
  );
  if (removals.length)
    await appendExternalNightlyRevenueEvidence(transaction, {
      propertyId: command.propertyId,
      guestBookingId: command.guestBookingId,
      sourceKind: "manual",
      sourceBookingReference: scope.sourceBookingReference,
      idempotencyKey: `pms-stay-correction:${command.idempotencyKey}:remove:v1`,
      lines: removals,
    });

  const afterRemoval = new Map(
    (await loadCurrentNights(transaction, command)).map((night) => [key(night), night]),
  );
  const additions: ExternalRevenueEvidenceLine[] = requested
    .filter((night) => !unchanged.has(key(night)))
    .map((night) => {
      const current = afterRemoval.get(key(night));
      if (current && current.occupied !== 0)
        throw new ManualStayCorrectionEvidenceError("Manual stay correction target is occupied");
      return {
        roomTypeId: night.roomTypeId,
        stayDate: night.stayDate,
        recognizedOn: latest(command.accountingDate, current?.recognizedOn, night.stayDate),
        grossRoomAmount: night.amount,
        occupiedRoomNights: 1 as const,
        economicEvent: "occupancy_adjustment" as const,
        lifecycleState: "corrected" as const,
        evidenceQuality: night.evidenceQuality,
        linePosition: night.linePosition,
        correctsEvidenceId: current?.id ?? null,
      };
    });
  if (additions.length)
    await appendExternalNightlyRevenueEvidence(transaction, {
      propertyId: command.propertyId,
      guestBookingId: command.guestBookingId,
      sourceKind: "manual",
      sourceBookingReference: scope.sourceBookingReference,
      idempotencyKey: `pms-stay-correction:${command.idempotencyKey}:add:v1`,
      lines: additions,
    });
  await enqueueCorrection(transaction, command, acceptedAt, removals.length, additions.length);
}

async function loadCurrentNights(
  transaction: ExternalRevenueEvidenceClient,
  command: Pick<Command, "propertyId" | "guestBookingId">,
): Promise<CurrentNight[]> {
  const result = await transaction.query<CurrentNight>(
    `WITH state AS (SELECT id,room_type_id,stay_date,recognized_on,line_position,
       evidence_quality,source_kind,source_revision,created_at,
       (SUM(occupied_room_nights) OVER scope)::int AS occupied,
       SUM(gross_room_amount) OVER scope AS amount,
       row_number() OVER (scope ORDER BY source_revision DESC,created_at DESC,id DESC) AS tip
     FROM booking.nightly_revenue_evidence WHERE property_id=$1::uuid
       AND guest_booking_id=$2::uuid AND economic_event<>'retained_charge'
     WINDOW scope AS (PARTITION BY stay_date,line_position))
     SELECT id::text,room_type_id::text AS "roomTypeId",stay_date::text AS "stayDate",
       recognized_on::text AS "recognizedOn",
       CASE WHEN evidence_quality='missing' THEN NULL ELSE amount::text END AS amount,
       occupied,evidence_quality AS "evidenceQuality",line_position AS "linePosition",
       source_kind='manual' AS manual FROM state WHERE tip=1 ORDER BY stay_date,line_position`,
    [command.propertyId, command.guestBookingId],
  );
  return result.rows.map((night) => ({ ...night, amount: normalizeStoredMoney(night.amount) }));
}

function requestedNights(
  stays: readonly VerifiedManualStayCorrection[],
  currency: string,
): RequestedNight[] {
  const requested = stays.flatMap((stay) => {
    const dates = stayDates(stay.checkIn, stay.checkOut);
    if (dates.length !== stay.nightly.length)
      throw new ManualStayCorrectionEvidenceError("Manual stay correction nights are incomplete");
    return stay.nightly.map((night, index) => {
      if (night.stayDate !== dates[index])
        throw new ManualStayCorrectionEvidenceError("Manual stay correction dates are incomplete");
      const amount = night.amount && normalizeInputMoney(night.amount.amountDecimal);
      if (
        (night.evidenceQuality === "missing") !== (night.amount === null) ||
        (night.amount && (night.amount.currency !== currency || amount === null))
      )
        throw new ManualStayCorrectionEvidenceError("Manual stay correction amount is invalid");
      return {
        id: "",
        roomTypeId: stay.roomTypeId,
        stayDate: night.stayDate,
        recognizedOn: night.stayDate,
        amount,
        occupied: 1,
        evidenceQuality: night.evidenceQuality,
        linePosition: stay.position,
        manual: true,
      };
    });
  });
  if (!requested.length || new Set(requested.map(key)).size !== requested.length)
    throw new ManualStayCorrectionEvidenceError("Manual stay correction nights are invalid");
  return requested;
}

async function enqueueCorrection(
  transaction: ExternalRevenueEvidenceClient,
  command: Command,
  acceptedAt: string,
  removed: number,
  added: number,
) {
  const hash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  const event = await transaction.query<{ id: string }>(
    `INSERT INTO platform.domain_events(source_system,event_key,event_type,occurred_at,tenant_scope,
       property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,correlation_id,
       idempotency_key_hash,payload,privacy_scope)
     VALUES('booking',$1,'booking.manual_booking.stays_corrected.v1',$2::timestamptz,'property',
       $3::uuid,'booking','guest_booking',$4,$5,$6::uuid,$7,$8,$9::jsonb,'confidential') RETURNING id::text`,
    [
      `booking.manual-stay-correction.${command.guestBookingId}.${hash}.v1`,
      acceptedAt,
      command.propertyId,
      command.guestBookingId,
      command.audit.actor.kind,
      command.audit.actor.userId ?? null,
      command.audit.correlationId ?? command.audit.requestId,
      hash,
      JSON.stringify({ removed, added }),
    ],
  );
  await transaction.query(
    `INSERT INTO platform.outbox_events(domain_event_id,outbox_key,destination,event_type,tenant_scope,
       property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload)
     SELECT $1::uuid,'booking.manual-stay-correction.'||$2||'.'||item.destination||'.v1',
       item.destination,item.event_type,'property',$3::uuid,'booking','guest_booking',$2,$4,$5,
       jsonb_build_object('guestBookingId',$2::text) FROM jsonb_to_recordset($6::jsonb)
       item(destination text,event_type text)`,
    [
      event.rows[0]!.id,
      command.guestBookingId,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      hash,
      JSON.stringify([
        { destination: "pms.calendar", event_type: "pms.calendar.refresh.requested.v1" },
        { destination: "pms.ari", event_type: "pms.ari.changed.v1" },
      ]),
    ],
  );
}

function sameKnownTotal(
  current: readonly CurrentNight[],
  requested: readonly RequestedNight[],
): boolean {
  const left = current.map(({ amount }) => amount),
    right = requested.map(({ amount }) => amount);
  if (left.every((amount) => amount === null) && right.every((amount) => amount === null))
    return true;
  if (left.some((amount) => amount === null) || right.some((amount) => amount === null))
    return false;
  return (
    left.reduce((sum, amount) => sum + units(amount!), 0n) ===
    right.reduce((sum, amount) => sum + units(amount!), 0n)
  );
}
const key = (value: { stayDate: string; linePosition: number }) =>
  `${value.stayDate}:${value.linePosition}`;
const latest = (...values: Array<string | undefined>) => values.filter(Boolean).sort().at(-1)!;
const negate = (value: string) => (value === "0.0000" ? value : `-${value}`);
const units = (value: string) => BigInt(value.replace(".", ""));
function normalizeInputMoney(value: string): string | null {
  if (!/^(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}
const normalizeStoredMoney = (value: string | null) =>
  value === null ? null : normalizeInputMoney(value);
function stayDates(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [],
    cursor = new Date(`${checkIn}T00:00:00Z`),
    end = new Date(`${checkOut}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
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
