import { createHash } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";

export type ExternalRevenueEvidenceClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type ExternalRevenueEvidenceLine = Readonly<{
  roomTypeId: string | null;
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
const MAX_EVIDENCE_LINES = 20 * 370;

/** Must receive the external booking writer's open transaction client. */
export async function appendExternalNightlyRevenueEvidence(
  client: ExternalRevenueEvidenceClient,
  command: AppendExternalRevenueEvidenceCommand,
) {
  const prefix = commandPrefix(command);
  const lines = normalizeLines(command, prefix);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${command.propertyId}:${prefix}`,
  ]);
  const booking = await client.query(
    `SELECT id FROM booking.guest_bookings
     WHERE id = $1::uuid AND property_id = $2::uuid AND source_system = 'pms'
       AND source_booking_id = $3
     FOR UPDATE`,
    [command.guestBookingId, command.propertyId, command.sourceBookingReference],
  );
  if ((booking.rowCount ?? 0) !== 1) {
    throw new ExternalRevenueEvidenceScopeError("External booking scope is unavailable");
  }

  const stored = await client.query<StoredLine>(
    `SELECT id::text AS id, guest_booking_id::text AS "guestBookingId",
       source_kind AS "sourceKind", source_revision::int AS "sourceRevision",
       command_key AS "commandKey"
     FROM booking.nightly_revenue_evidence
     WHERE property_id = $1::uuid AND command_key LIKE $2 || '%' ORDER BY command_key`,
    [command.propertyId, prefix],
  );
  if (stored.rows.length > 0) {
    return replay(stored.rows, lines, command.sourceKind, command.guestBookingId);
  }

  const revisionResult = await client.query<{ revision: number }>(
    `SELECT COALESCE(MAX(source_revision), 0)::int + 1 AS revision
     FROM booking.nightly_revenue_evidence WHERE guest_booking_id = $1::uuid`,
    [command.guestBookingId],
  );
  const sourceRevision = revisionResult.rows[0]?.revision ?? 1;
  if (sourceRevision > 2_147_483_647) throw new Error("External evidence revision is exhausted");

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO booking.nightly_revenue_evidence
       (property_id, guest_booking_id, room_type_id, stay_date, recognized_on, currency,
        gross_room_amount, occupied_room_nights, economic_event, lifecycle_state, source_kind,
        evidence_quality, source_revision, line_position, corrects_evidence_id, command_key)
     SELECT booking.property_id, booking.id, line."roomTypeId"::uuid, line."stayDate"::date,
       line."recognizedOn"::date, booking.currency, line."grossRoomAmount"::numeric,
       line."occupiedRoomNights", line."economicEvent", line."lifecycleState", $4,
       line."evidenceQuality", $5, line."linePosition", line."correctsEvidenceId"::uuid,
       line."commandKey"
     FROM booking.guest_bookings booking
     CROSS JOIN jsonb_to_recordset($6::jsonb) AS line(
       "roomTypeId" text, "stayDate" text, "recognizedOn" text, "grossRoomAmount" text,
       "occupiedRoomNights" smallint, "economicEvent" text, "lifecycleState" text,
       "evidenceQuality" text, "linePosition" int, "correctsEvidenceId" text, "commandKey" text)
     WHERE booking.id = $1::uuid AND booking.property_id = $2::uuid
       AND booking.source_booking_id = $3
     RETURNING id::text AS id`,
    [
      command.guestBookingId,
      command.propertyId,
      command.sourceBookingReference,
      command.sourceKind,
      sourceRevision,
      JSON.stringify(lines),
    ],
  );
  return { outcome: "appended", sourceRevision, evidenceIds: inserted.rows.map(({ id }) => id) };
}

function replay(
  stored: readonly StoredLine[],
  lines: readonly NormalizedLine[],
  sourceKind: string,
  guestBookingId: string,
) {
  const expected = new Map(lines.map((line) => [line.commandKey, line]));
  const matches =
    stored.length === lines.length &&
    stored.every(
      (row) =>
        expected.has(row.commandKey) &&
        row.guestBookingId === guestBookingId &&
        row.sourceKind === sourceKind,
    );
  const revisions = new Set(stored.map(({ sourceRevision }) => sourceRevision));
  if (!matches || revisions.size !== 1) {
    throw new ExternalRevenueEvidenceConflictError("External evidence idempotency key conflicts");
  }
  return {
    outcome: "replayed",
    sourceRevision: stored[0]!.sourceRevision,
    evidenceIds: stored.map(({ id }) => id),
  };
}

function normalizeLines(
  command: AppendExternalRevenueEvidenceCommand,
  prefix: string,
): NormalizedLine[] {
  if (
    !Array.isArray(command.lines) ||
    command.lines.length < 1 ||
    command.lines.length > MAX_EVIDENCE_LINES
  ) {
    throw new Error("External evidence lines are malformed");
  }
  const lines = command.lines.map((line) => {
    if (
      (line.roomTypeId !== null && !UUID.test(line.roomTypeId)) ||
      !DATE.test(line.stayDate) ||
      !DATE.test(line.recognizedOn) ||
      !Number.isInteger(line.linePosition) ||
      line.linePosition < 1 ||
      line.linePosition > 1000 ||
      (line.correctsEvidenceId != null && !UUID.test(line.correctsEvidenceId))
    ) {
      throw new Error("External evidence line is malformed");
    }
    const grossRoomAmount = normalizeMoney(line.grossRoomAmount);
    if (
      (line.evidenceQuality === "missing") !== (grossRoomAmount === null) ||
      (line.evidenceQuality !== "missing" && line.roomTypeId === null)
    ) {
      throw new Error("External evidence quality is malformed");
    }
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
  if (new Set(lines.map(({ commandKey }) => commandKey)).size !== lines.length) {
    throw new Error("External evidence lines contain duplicates");
  }
  return lines;
}

function commandPrefix(command: AppendExternalRevenueEvidenceCommand): string {
  if (
    !UUID.test(command.propertyId) ||
    !UUID.test(command.guestBookingId) ||
    !["ota", "manual"].includes(command.sourceKind) ||
    !trimmed(command.sourceBookingReference, 500) ||
    !trimmed(command.idempotencyKey, 500)
  ) {
    throw new Error("External evidence command is malformed");
  }
  return `external:${command.sourceKind}:${sha256(command.idempotencyKey)}:`;
}

function normalizeMoney(value: string | null): string | null {
  if (value === null) return null;
  if (!MONEY.test(value)) throw new Error("External evidence amount is malformed");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, "");
  const amount = `${normalizedWhole}.${fraction.padEnd(4, "0")}`;
  return negative && amount !== "0.0000" ? `-${amount}` : amount;
}

function trimmed(value: string, max: number): boolean {
  return typeof value === "string" && value === value.trim() && !!value && value.length <= max;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
