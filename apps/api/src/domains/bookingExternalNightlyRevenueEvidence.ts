import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
export type ExternalRevenueEvidenceLine = Readonly<{
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  grossRoomAmount: string | null;
  occupiedRoomNights: -1 | 0 | 1;
  economicEvent:
    | "room_night"
    | "room_night_reversal"
    | "occupancy_adjustment"
    | "retained_charge"
    | "refund"
    | "correction";
  lifecycleState: "confirmed" | "completed" | "canceled" | "no_show" | "refunded" | "corrected";
  evidenceQuality: "exact" | "inferred" | "missing";
  linePosition: number;
  correctsEvidenceId?: string | null;
}>;
export type AppendExternalRevenueEvidenceCommand = Readonly<{
  propertyId: string;
  guestBookingId: string;
  sourceKind: "ota" | "manual";
  sourceBookingReference: string;
  idempotencyKey: string;
  lines: readonly ExternalRevenueEvidenceLine[];
}>;
export class ExternalRevenueEvidenceScopeError extends Error {
  readonly code = "external_booking_scope_unavailable";
}
export class ExternalRevenueEvidenceConflictError extends Error {
  readonly code = "external_evidence_idempotency_conflict";
}
type NormalizedLine = Omit<ExternalRevenueEvidenceLine, "correctsEvidenceId"> & {
  correctsEvidenceId: string | null;
  commandKey: string;
};
type StoredLine = {
  id: string;
  guestBookingId: string;
  sourceKind: string;
  sourceRevision: number;
  commandKey: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/,
  MONEY = /^-?\d{1,15}(?:\.\d{1,4})?$/;
const MAX_EXTERNAL_EVIDENCE_LINES = 1_000;
const MAX_MANUAL_EVIDENCE_LINES = 20 * 366;
const EVENTS =
  "room_night room_night_reversal occupancy_adjustment retained_charge refund correction";
const STATES = "confirmed completed canceled no_show refunded corrected";
export async function appendExternalNightlyRevenueEvidence(
  client: Pick<PoolClient, "query">,
  command: AppendExternalRevenueEvidenceCommand,
) {
  const prefix = commandPrefix(command);
  const lines = normalizeLines(command, prefix);
  const transaction = await client.query<{ id: string }>(
    "SELECT txid_current()::text id, pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${command.propertyId}:${prefix}`],
  );
  const roomTypes = [...new Set(lines.map(({ roomTypeId }) => roomTypeId))];
  const booking = await client.query<{
    roomCount: number;
    roomTypeCount: number;
    transactionId: string;
  }>(
    `SELECT room_count AS "roomCount", txid_current()::text AS "transactionId",
       (SELECT count(*)::int FROM booking.nightly_revenue_room_scopes
        WHERE property_id=$2::uuid AND room_type_id=ANY($4::uuid[])) AS "roomTypeCount"
     FROM booking.guest_bookings WHERE id=$1::uuid AND property_id=$2::uuid
       AND source_system='pms' AND source_booking_id=$3 FOR UPDATE`,
    [command.guestBookingId, command.propertyId, command.sourceBookingReference, roomTypes],
  );
  const scope = booking.rows[0];
  if (!scope) throw new ExternalRevenueEvidenceScopeError("External booking scope is unavailable");
  if (scope.transactionId !== transaction.rows[0]?.id)
    throw new Error("External evidence requires an open transaction");
  if (
    scope.roomTypeCount !== roomTypes.length ||
    lines.some((line) => line.linePosition > scope.roomCount)
  )
    throw new ExternalRevenueEvidenceScopeError("External room scope is unavailable");
  const stored = await client.query<StoredLine>(
    `SELECT id::text AS id, guest_booking_id::text AS "guestBookingId",
       source_kind AS "sourceKind", source_revision::int AS "sourceRevision", command_key AS "commandKey"
     FROM booking.nightly_revenue_evidence WHERE property_id=$1::uuid
       AND command_key LIKE $2 || '%' ORDER BY command_key`,
    [command.propertyId, prefix],
  );
  if (stored.rows.length > 0) return replay(stored.rows, lines, command);
  const revision = await client.query<{ value: number }>(
    "SELECT COALESCE(MAX(source_revision),0)::int+1 value FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
    [command.guestBookingId],
  );
  const sourceRevision = revision.rows[0]!.value;
  const inserted = await client.query<{ id: string; commandKey: string }>(
    `INSERT INTO booking.nightly_revenue_evidence
       (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,
        occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,
        source_revision,line_position,corrects_evidence_id,command_key)
     SELECT booking.property_id, booking.id, line."roomTypeId"::uuid, line."stayDate"::date,
       line."recognizedOn"::date, booking.currency, line."grossRoomAmount"::numeric, line."occupiedRoomNights",
       line."economicEvent", line."lifecycleState", $4, line."evidenceQuality", $5,
       line."linePosition", line."correctsEvidenceId"::uuid, line."commandKey"
     FROM booking.guest_bookings booking
     CROSS JOIN jsonb_to_recordset($6::jsonb) AS line(
       "roomTypeId" text, "stayDate" text, "recognizedOn" text, "grossRoomAmount" text,
       "occupiedRoomNights" smallint, "economicEvent" text, "lifecycleState" text,
       "evidenceQuality" text, "linePosition" int, "correctsEvidenceId" text, "commandKey" text)
     WHERE booking.id=$1::uuid AND booking.property_id=$2::uuid AND booking.source_booking_id=$3
     RETURNING id::text id, command_key AS "commandKey"`,
    [
      command.guestBookingId,
      command.propertyId,
      command.sourceBookingReference,
      command.sourceKind,
      sourceRevision,
      JSON.stringify(lines),
    ],
  );
  inserted.rows.sort((a, b) => a.commandKey.localeCompare(b.commandKey));
  return { outcome: "appended", sourceRevision, evidenceIds: inserted.rows.map(({ id }) => id) };
}
function replay(
  stored: readonly StoredLine[],
  lines: readonly NormalizedLine[],
  command: AppendExternalRevenueEvidenceCommand,
) {
  const expected = new Set(lines.map(({ commandKey }) => commandKey));
  if (
    stored.length !== lines.length ||
    new Set(stored.map(({ sourceRevision }) => sourceRevision)).size !== 1 ||
    stored.some(
      (row) =>
        !expected.has(row.commandKey) ||
        row.guestBookingId !== command.guestBookingId ||
        row.sourceKind !== command.sourceKind,
    )
  )
    throw new ExternalRevenueEvidenceConflictError("External evidence idempotency key conflicts");
  const evidenceIds = stored.map(({ id }) => id);
  return { outcome: "replayed", sourceRevision: stored[0]!.sourceRevision, evidenceIds };
}
function normalizeLines(
  command: AppendExternalRevenueEvidenceCommand,
  prefix: string,
): NormalizedLine[] {
  const maxLines =
    command.sourceKind === "manual" ? MAX_MANUAL_EVIDENCE_LINES : MAX_EXTERNAL_EVIDENCE_LINES;
  if (
    !Array.isArray(command.lines) ||
    command.lines.length < 1 ||
    command.lines.length > maxLines
  ) {
    throw new Error("External evidence lines are malformed");
  }
  const lines = command.lines.map((line) => {
    if (typeof line !== "object" || line === null)
      throw new Error("External evidence line is malformed");
    if (
      !UUID.test(line.roomTypeId) ||
      !validDate(line.stayDate) ||
      !validDate(line.recognizedOn) ||
      !EVENTS.split(" ").includes(line.economicEvent) ||
      !STATES.split(" ").includes(line.lifecycleState) ||
      !["exact", "inferred", "missing"].includes(line.evidenceQuality) ||
      !Number.isInteger(line.linePosition) ||
      line.linePosition < 1 ||
      line.linePosition > 1000 ||
      (line.correctsEvidenceId != null && !UUID.test(line.correctsEvidenceId)) ||
      ![-1, 0, 1].includes(line.occupiedRoomNights)
    )
      throw new Error("External evidence line is malformed");
    const grossRoomAmount = normalizeMoney(line.grossRoomAmount);
    if ((line.evidenceQuality === "missing") !== (grossRoomAmount === null))
      throw new Error("External evidence quality is malformed");
    const normalized = {
      roomTypeId: line.roomTypeId,
      stayDate: line.stayDate,
      recognizedOn: line.recognizedOn,
      grossRoomAmount,
      occupiedRoomNights: line.occupiedRoomNights,
      economicEvent: line.economicEvent,
      lifecycleState: line.lifecycleState,
      evidenceQuality: line.evidenceQuality,
      linePosition: line.linePosition,
      correctsEvidenceId: line.correctsEvidenceId ?? null,
    };
    return { ...normalized, commandKey: `${prefix}${sha256(JSON.stringify(normalized))}` };
  });
  if (new Set(lines.map(({ commandKey }) => commandKey)).size !== lines.length)
    throw new Error("External evidence lines contain duplicates");
  return lines.sort((left, right) => left.commandKey.localeCompare(right.commandKey));
}
function commandPrefix(command: AppendExternalRevenueEvidenceCommand): string {
  if (
    !UUID.test(command.propertyId) ||
    !UUID.test(command.guestBookingId) ||
    !["ota", "manual"].includes(command.sourceKind) ||
    !trimmed(command.sourceBookingReference, 500) ||
    !trimmed(command.idempotencyKey, 500)
  )
    throw new Error("External evidence command is malformed");
  return `external:${sha256(command.idempotencyKey)}:`;
}
function normalizeMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !MONEY.test(value))
    throw new Error("External evidence amount is malformed");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, "");
  const amount = `${normalizedWhole}.${fraction.padEnd(4, "0")}`;
  return negative && amount !== "0.0000" ? `-${amount}` : amount;
}

function trimmed(value: string, max: number): boolean {
  return typeof value === "string" && value === value.trim() && !!value && value.length <= max;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validDate = (value: unknown) =>
  typeof value === "string" &&
  !value.startsWith("0000-") &&
  DATE.test(value) &&
  new Date(value).toJSON() === `${value}T00:00:00.000Z`;
