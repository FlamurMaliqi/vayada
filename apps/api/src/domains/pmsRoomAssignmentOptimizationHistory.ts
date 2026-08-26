import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsRoomAssignmentOptimizationHistoryItem = Readonly<{
  shuffleId: string;
  assignmentId: string;
  guestBookingId: string | null;
  bookingReference: string | null;
  roomTypeId: string;
  fromRoom: Readonly<{ roomId: string; label: string | null }> | null;
  toRoom: Readonly<{ roomId: string; label: string | null }>;
  reason: "create" | "cancel" | "modify";
  actor: Readonly<{ kind: "system" }> | Readonly<{ kind: "user"; userId: string }>;
  correlationId: string;
  occurredAt: string;
}>;

export type PmsRoomAssignmentOptimizationHistoryPort = Readonly<{
  list(
    propertyId: string,
    page?: Readonly<{
      limit?: number;
      before?: Readonly<{ occurredAt: string; shuffleId: string }>;
    }>,
  ): Promise<
    Readonly<{
      items: readonly PmsRoomAssignmentOptimizationHistoryItem[];
      nextCursor: Readonly<{ occurredAt: string; shuffleId: string }> | null;
    }>
  >;
  close?(): Promise<void>;
}>;

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type Row = QueryResultRow & {
  shuffleId: string;
  assignmentId: string;
  guestBookingId: string | null;
  bookingReference: string | null;
  roomTypeId: string;
  fromRoomId: string | null;
  fromRoomLabel: string | null;
  toRoomId: string;
  toRoomLabel: string | null;
  reason: string;
  actorType: string;
  actorUserId: string | null;
  correlationId: string;
  occurredAt: Date | string;
  cursorOccurredAt: string;
};

export function createPgPmsRoomAssignmentOptimizationHistoryPort(config: {
  connectionString?: string;
  max?: number;
  pool?: Pool;
}): PmsRoomAssignmentOptimizationHistoryPort {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS room-assignment history connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async list(propertyId, page = {}) {
      const limit = page.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("PMS room-assignment history limit is invalid");
      }
      if (
        page.before &&
        (!uuid(page.before.shuffleId) || !canonicalCursorInstant(page.before.occurredAt))
      ) {
        throw new TypeError("PMS room-assignment history cursor is invalid");
      }
      const result = await pool.query<Row>(
        `SELECT audit.id::text AS "shuffleId",
                audit.target_resource_id AS "assignmentId",
                assignment.guest_booking_id::text AS "guestBookingId",
                booking.public_reference AS "bookingReference",
                audit.redacted_payload ->> 'roomTypeId' AS "roomTypeId",
                audit.redacted_payload ->> 'fromRoomId' AS "fromRoomId",
                from_room.room_number AS "fromRoomLabel",
                audit.redacted_payload ->> 'toRoomId' AS "toRoomId",
                to_room.room_number AS "toRoomLabel",
                audit.redacted_payload ->> 'reason' AS reason,
                audit.actor_type AS "actorType", audit.actor_user_id::text AS "actorUserId",
                audit.correlation_id AS "correlationId", audit.occurred_at AS "occurredAt",
                to_char(audit.occurred_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorOccurredAt"
         FROM platform.product_audit_events audit
         LEFT JOIN pms.operational_booking_assignments assignment
           ON assignment.property_id = audit.property_id
          AND assignment.id::text = audit.target_resource_id
         LEFT JOIN booking.guest_bookings booking
           ON booking.property_id = audit.property_id
          AND booking.id = assignment.guest_booking_id
         LEFT JOIN pms.rooms from_room
           ON from_room.property_id = audit.property_id
          AND from_room.id::text = audit.redacted_payload ->> 'fromRoomId'
         LEFT JOIN pms.rooms to_room
           ON to_room.property_id = audit.property_id
          AND to_room.id::text = audit.redacted_payload ->> 'toRoomId'
         WHERE audit.product = 'pms' AND audit.action = 'pms.assignment.auto_rearranged'
           AND audit.tenant_scope = 'property' AND audit.organization_id IS NULL
           AND audit.property_id = $1::uuid
           AND ($3::timestamptz IS NULL OR
                (audit.occurred_at, audit.id) < ($3::timestamptz, $4::uuid))
         ORDER BY audit.occurred_at DESC, audit.id DESC
         LIMIT $2`,
        [propertyId, limit + 1, page.before?.occurredAt ?? null, page.before?.shuffleId ?? null],
      );
      const selectedRows = result.rows.slice(0, limit);
      const items = selectedRows.map(toItem);
      const last = selectedRows.at(-1);
      return {
        items,
        nextCursor:
          result.rows.length > limit && last
            ? { occurredAt: last.cursorOccurredAt, shuffleId: last.shuffleId }
            : null,
      };
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function toItem(row: Row): PmsRoomAssignmentOptimizationHistoryItem {
  if (
    !uuid(row.shuffleId) ||
    !uuid(row.assignmentId) ||
    !uuid(row.roomTypeId) ||
    !uuid(row.toRoomId) ||
    (row.fromRoomId !== null && !uuid(row.fromRoomId)) ||
    (row.guestBookingId !== null && !uuid(row.guestBookingId)) ||
    !["create", "cancel", "modify"].includes(row.reason) ||
    !row.correlationId ||
    !canonicalCursorInstant(row.cursorOccurredAt) ||
    (row.actorType === "user" ? !uuid(row.actorUserId) : row.actorType !== "system")
  ) {
    throw new TypeError("PMS room-assignment history row is invalid");
  }
  return {
    shuffleId: row.shuffleId,
    assignmentId: row.assignmentId,
    guestBookingId: row.guestBookingId,
    bookingReference: row.bookingReference,
    roomTypeId: row.roomTypeId,
    fromRoom: row.fromRoomId === null ? null : { roomId: row.fromRoomId, label: row.fromRoomLabel },
    toRoom: { roomId: row.toRoomId, label: row.toRoomLabel },
    reason: row.reason as "create" | "cancel" | "modify",
    actor:
      row.actorType === "user" ? { kind: "user", userId: row.actorUserId! } : { kind: "system" },
    correlationId: row.correlationId,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
  };
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function canonicalCursorInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === `${value.slice(0, 23)}Z`;
}
