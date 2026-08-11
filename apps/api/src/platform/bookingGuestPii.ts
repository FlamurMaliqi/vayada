import pg, { type QueryResult, type QueryResultRow } from "pg";
import type {
  BookingAdditionalGuestCreateCommand,
  BookingAdditionalGuestDeleteCommand,
  BookingAdditionalGuestInput,
  BookingAdditionalGuestUpdateCommand,
  BookingGuestPii,
  BookingGuestPiiCommandMeta,
  BookingGuestPiiCommandResult,
  BookingGuestPiiDeleteResult,
  BookingGuestPiiPort,
  BookingGuestPiiProjection,
  BookingGuestPiiRole,
} from "@vayada/domain-booking";

import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  guestContactForPropertyPlan,
  HIDDEN_GUEST_CONTACT,
} from "../domains/bookingGuestContactAccess.js";
import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";

export type BookingGuestPiiClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingGuestPiiPool = {
  connect(): Promise<BookingGuestPiiClient>;
  end(): Promise<void>;
};

export type TargetBookingGuestPiiPortConfig = {
  connectionString: string;
  max?: number;
  pool?: BookingGuestPiiPool;
  now?: () => Date;
};

type BookingGuestPiiRow = {
  guestId: string;
  guestBookingId: string;
  role: BookingGuestPiiRole;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  arrivalTime: string | null;
  specialRequests: string | null;
};

type BookingGuestPiiProjectionRow = BookingGuestPiiRow & {
  guestContactAccepted: boolean;
};

type BookingGuestPiiCommand =
  | BookingAdditionalGuestCreateCommand
  | BookingAdditionalGuestUpdateCommand
  | BookingAdditionalGuestDeleteCommand;

export function createTargetBookingGuestPiiPort(
  config: TargetBookingGuestPiiPortConfig,
): BookingGuestPiiPort {
  if (!config.connectionString.trim()) {
    throw new Error("Booking guest PII port connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: BookingGuestPiiPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());

  return {
    async listGuestPiiForPmsOperations(input) {
      const client = await pool.connect();
      try {
        if (!(await reservationExists(client, input.propertyId, input.guestBookingId))) {
          return null;
        }
        return listGuestPiiProjection(client, input.propertyId, input.guestBookingId);
      } finally {
        client.release();
      }
    },

    async createAdditionalGuestForPmsOperations(command) {
      const validation = validateAdditionalGuestInput(command.guest, true);
      if (validation) return validation;

      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const commandMeta = guestPiiCommandMeta(command, acceptedAt);
      try {
        await client.query("BEGIN");
        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return reservationNotFound(command.guestBookingId);
        }
        const result = await client.query<BookingGuestPiiRow>(
          `INSERT INTO booking.booking_guests (
             guest_booking_id,
             guest_role,
             first_name,
             last_name,
             email,
             phone,
             country_code,
             arrival_time,
             special_requests,
             updated_at
           )
           VALUES (
             $1::uuid,
             'additional_guest',
             $2,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             $9::timestamptz
           )
           RETURNING
             id::text AS "guestId",
             guest_booking_id::text AS "guestBookingId",
             guest_role AS "role",
             first_name AS "firstName",
             last_name AS "lastName",
             email,
             phone,
             country_code AS "countryCode",
             arrival_time AS "arrivalTime",
             special_requests AS "specialRequests"`,
          [
            command.guestBookingId,
            command.guest.firstName.trim(),
            command.guest.lastName.trim(),
            nullableTrimmed(command.guest.email),
            nullableTrimmed(command.guest.phone),
            nullableCountryCode(command.guest.countryCode),
            nullableTrimmed(command.guest.arrivalTime),
            nullableTrimmed(command.guest.specialRequests),
            acceptedAt,
          ],
        );
        const additionalGuest = toBookingGuestPii(result.rows[0]!);
        await insertGuestPiiAuditEvent(client, command, {
          action: "booking.guest_pii.additional_guest.created",
          guestId: additionalGuest.guestId,
          acceptedAt,
          privatePayload: { guest: additionalGuest },
        });
        const projection = await listGuestPiiProjection(
          client,
          command.propertyId,
          command.guestBookingId,
        );
        const visibleAdditionalGuest = projection.additionalGuests.find(
          (guest) => guest.guestId === additionalGuest.guestId,
        );
        if (!visibleAdditionalGuest) throw new Error("Created additional guest was not projected");
        await client.query("COMMIT");
        return {
          ok: true,
          additionalGuest: visibleAdditionalGuest,
          projection,
          commandMeta,
        };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return idempotencyConflict(
            "Booking guest PII command conflicts with current guest state.",
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async updateAdditionalGuestForPmsOperations(command) {
      const validation = validateAdditionalGuestInput(command.guest, false);
      if (validation) return validation;

      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const commandMeta = guestPiiCommandMeta(command, acceptedAt);
      try {
        await client.query("BEGIN");
        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return reservationNotFound(command.guestBookingId);
        }
        const existing = await findAdditionalGuest(client, command);
        if (!existing) {
          await client.query("ROLLBACK");
          return additionalGuestNotFound(command.guestId);
        }
        const merged = { ...existing, ...definedGuestFields(command.guest) };
        const result = await client.query<BookingGuestPiiRow>(
          `UPDATE booking.booking_guests
           SET first_name = $1,
               last_name = $2,
               email = $3,
               phone = $4,
               country_code = $5,
               arrival_time = $6,
               special_requests = $7,
               updated_at = $8::timestamptz
           WHERE id = $9::uuid
             AND guest_booking_id = $10::uuid
             AND guest_role = 'additional_guest'
           RETURNING
             id::text AS "guestId",
             guest_booking_id::text AS "guestBookingId",
             guest_role AS "role",
             first_name AS "firstName",
             last_name AS "lastName",
             email,
             phone,
             country_code AS "countryCode",
             arrival_time AS "arrivalTime",
             special_requests AS "specialRequests"`,
          [
            merged.firstName,
            merged.lastName,
            merged.email,
            merged.phone,
            merged.countryCode,
            merged.arrivalTime,
            merged.specialRequests,
            acceptedAt,
            command.guestId,
            command.guestBookingId,
          ],
        );
        const additionalGuest = toBookingGuestPii(result.rows[0]!);
        await insertGuestPiiAuditEvent(client, command, {
          action: "booking.guest_pii.additional_guest.updated",
          guestId: additionalGuest.guestId,
          acceptedAt,
          privatePayload: { guest: additionalGuest },
        });
        const projection = await listGuestPiiProjection(
          client,
          command.propertyId,
          command.guestBookingId,
        );
        const visibleAdditionalGuest = projection.additionalGuests.find(
          (guest) => guest.guestId === additionalGuest.guestId,
        );
        if (!visibleAdditionalGuest) throw new Error("Updated additional guest was not projected");
        await client.query("COMMIT");
        return {
          ok: true,
          additionalGuest: visibleAdditionalGuest,
          projection,
          commandMeta,
        };
      } finally {
        client.release();
      }
    },

    async deleteAdditionalGuestForPmsOperations(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const commandMeta = guestPiiCommandMeta(command, acceptedAt);
      try {
        await client.query("BEGIN");
        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return reservationNotFound(command.guestBookingId);
        }
        const result = await client.query<{ guestId: string }>(
          `DELETE FROM booking.booking_guests
           WHERE id = $1::uuid
             AND guest_booking_id = $2::uuid
             AND guest_role = 'additional_guest'
           RETURNING id::text AS "guestId"`,
          [command.guestId, command.guestBookingId],
        );
        const guestId = result.rows[0]?.guestId;
        if (!guestId) {
          await client.query("ROLLBACK");
          return additionalGuestNotFound(command.guestId);
        }
        await insertGuestPiiAuditEvent(client, command, {
          action: "booking.guest_pii.additional_guest.deleted",
          guestId,
          acceptedAt,
          privatePayload: { deleted: true },
        });
        const projection = await listGuestPiiProjection(
          client,
          command.propertyId,
          command.guestBookingId,
        );
        await client.query("COMMIT");
        return { ok: true, guestId, projection, commandMeta };
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function reservationExists(
  client: BookingGuestPiiClient,
  propertyId: string,
  guestBookingId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM booking.guest_bookings
     WHERE property_id = $1::uuid
       AND id = $2::uuid
     LIMIT 1`,
    [propertyId, guestBookingId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function listGuestPiiProjection(
  client: BookingGuestPiiClient,
  propertyId: string,
  guestBookingId: string,
): Promise<BookingGuestPiiProjection> {
  const propertyPlan = await readPropertyPlan(client, propertyId);
  const result = await client.query<BookingGuestPiiProjectionRow>(
    `SELECT
       guest.id::text AS "guestId",
       guest.guest_booking_id::text AS "guestBookingId",
       guest.guest_role AS "role",
       guest.first_name AS "firstName",
       guest.last_name AS "lastName",
       guest.email,
       guest.phone,
       ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL} AS "guestContactAccepted",
       guest.country_code AS "countryCode",
       guest.arrival_time AS "arrivalTime",
       guest.special_requests AS "specialRequests"
     FROM booking.booking_guests guest
     JOIN booking.guest_bookings booking
       ON booking.id = guest.guest_booking_id
      AND booking.property_id = $1::uuid
     WHERE guest.guest_booking_id = $2::uuid
     ORDER BY
       CASE guest.guest_role
         WHEN 'booker' THEN 0
         WHEN 'primary_guest' THEN 1
         ELSE 2
       END,
       guest.created_at,
       guest.id`,
    [propertyId, guestBookingId],
  );
  const guests = result.rows.map((row) => {
    const guest = toBookingGuestPii(row);
    const contact = guestContactForPropertyPlan(propertyPlan, row.guestContactAccepted, guest);
    return { ...guest, ...contact };
  });
  return {
    propertyId,
    guestBookingId,
    primaryGuest: guests.find((guest) => guest.role !== "additional_guest") ?? null,
    additionalGuests: guests.filter((guest) => guest.role === "additional_guest"),
  };
}

async function findAdditionalGuest(
  client: BookingGuestPiiClient,
  command: BookingAdditionalGuestUpdateCommand,
): Promise<BookingGuestPii | null> {
  const result = await client.query<BookingGuestPiiRow>(
    `SELECT
       id::text AS "guestId",
       guest_booking_id::text AS "guestBookingId",
       guest_role AS "role",
       first_name AS "firstName",
       last_name AS "lastName",
       email,
       phone,
       country_code AS "countryCode",
       arrival_time AS "arrivalTime",
       special_requests AS "specialRequests"
     FROM booking.booking_guests
     WHERE id = $1::uuid
       AND guest_booking_id = $2::uuid
       AND guest_role = 'additional_guest'
     LIMIT 1
     FOR UPDATE`,
    [command.guestId, command.guestBookingId],
  );
  return result.rows[0] ? toBookingGuestPii(result.rows[0]) : null;
}

async function insertGuestPiiAuditEvent(
  client: BookingGuestPiiClient,
  command: BookingGuestPiiCommand,
  input: {
    action: string;
    guestId: string;
    acceptedAt: string;
    privatePayload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
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
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'booking',
       $2,
       1,
       $3::timestamptz,
       'property',
       $4::uuid,
       $5::uuid,
       'user',
       $6::uuid,
       'booking',
       'booking_guest',
       $7,
       'booking',
       'guest_booking',
       $8,
       $9,
       $10,
       $11::jsonb,
       $12::jsonb,
       $13::jsonb,
       'guest_pii',
       'restricted'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `booking.guest_pii.${command.commandId}.${input.guestId}.v1`,
      input.action,
      input.acceptedAt,
      command.audit.actorOrganizationId,
      command.propertyId,
      command.audit.actorUserId,
      input.guestId,
      command.guestBookingId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        guestId: input.guestId,
        piiRedacted: true,
      }),
      JSON.stringify(input.privatePayload),
      JSON.stringify({
        source: command.audit.source,
        reason: command.audit.reason,
        requestId: command.audit.requestId,
        idempotencyKey: command.idempotencyKey,
      }),
    ],
  );
}

function toBookingGuestPii(row: BookingGuestPiiRow): BookingGuestPii {
  const displayName = `${row.firstName} ${row.lastName}`.trim();
  return {
    guestId: row.guestId,
    guestBookingId: row.guestBookingId,
    role: row.role,
    displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    countryCode: row.countryCode,
    arrivalTime: row.arrivalTime,
    specialRequests: row.specialRequests,
  };
}

function guestPiiCommandMeta(
  command: BookingGuestPiiCommand,
  acceptedAt: string,
): BookingGuestPiiCommandMeta {
  return {
    contractVersion: "booking-guest-pii.v1",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["audit_event"],
  };
}

function validateAdditionalGuestInput(
  guest: Partial<BookingAdditionalGuestInput>,
  requireNames: boolean,
): Exclude<BookingGuestPiiCommandResult, { ok: true }> | null {
  if (requireNames && (!guest.firstName?.trim() || !guest.lastName?.trim())) {
    return invalidGuestPii("Additional guest firstName and lastName are required.");
  }
  if (!requireNames) {
    if (guest.firstName !== undefined && !guest.firstName?.trim()) {
      return invalidGuestPii("Additional guest firstName cannot be blank.");
    }
    if (guest.lastName !== undefined && !guest.lastName?.trim()) {
      return invalidGuestPii("Additional guest lastName cannot be blank.");
    }
  }
  if (guest.countryCode !== undefined && guest.countryCode !== null) {
    const countryCode = guest.countryCode.trim();
    if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) {
      return invalidGuestPii("Additional guest countryCode must be an ISO-3166 alpha-2 code.");
    }
  }
  return null;
}

function definedGuestFields(
  guest: Partial<BookingAdditionalGuestInput>,
): BookingAdditionalGuestInput {
  return Object.fromEntries(
    Object.entries(guest)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          !((key === "email" || key === "phone") && value === HIDDEN_GUEST_CONTACT),
      )
      .map(([key, value]) => [
        key,
        key === "countryCode"
          ? nullableCountryCode(value as string | null)
          : nullableTrimmed(value),
      ]),
  ) as BookingAdditionalGuestInput;
}

function nullableTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableCountryCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function invalidGuestPii(message: string): Exclude<BookingGuestPiiCommandResult, { ok: true }> {
  return { ok: false, statusCode: 400, code: "invalid_guest_pii", message };
}

function reservationNotFound(
  guestBookingId: string,
): Exclude<BookingGuestPiiCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `Booking reservation ${guestBookingId} was not found.`,
  };
}

function additionalGuestNotFound(
  guestId: string,
): Exclude<BookingGuestPiiCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "additional_guest_not_found",
    message: `Additional guest ${guestId} was not found.`,
  };
}

function idempotencyConflict(message: string): Exclude<BookingGuestPiiCommandResult, { ok: true }> {
  return { ok: false, statusCode: 409, code: "idempotency_conflict", message };
}

async function rollbackQuietly(client: BookingGuestPiiClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23505";
}
