import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { PmsManualBookingCreateError as CommandError } from "@vayada/domain-pms";

import type { ManualBookingPreviewResult } from "../routes/pmsManualBookingPreview.js";
import type {
  PmsManualBookingAcceptedWrite,
  PmsManualBookingBookingOwnerPort,
  PmsManualBookingOperationsOwnerPort,
  PmsManualBookingRoom,
  PmsManualBookingTransaction,
} from "./pmsManualBookingTransactionPorts.js";

type RoomRow = { roomId: string; roomTypeId: string };

export async function lockManualBookingRooms(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
): Promise<readonly PmsManualBookingRoom[]> {
  const roomIds = [...new Set(command.stays.map(({ roomId }) => roomId))].sort();
  const result = await transaction.query<RoomRow>(
    `SELECT id::text AS "roomId", room_type_id::text AS "roomTypeId"
     FROM pms.rooms
     WHERE property_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [command.propertyId, roomIds],
  );
  const found = new Set(result.rows.map(({ roomId }) => roomId));
  const missing = command.stays.find(({ roomId }) => !found.has(roomId));
  if (missing) throw new CommandError("room_not_found", "roomId", missing.position);
  return result.rows;
}

export function createPgPmsManualBookingBookingOwnerPort(): PmsManualBookingBookingOwnerPort {
  return {
    assertSourceCommandUnused: ({ transaction, commandId }) =>
      assertManualBookingSourceCommandUnused(transaction, commandId),
    persistBookingFacts: ({ transaction, ...input }) => persistBookingFacts(transaction, input),
    markPaid: ({ transaction, guestBookingId }) =>
      markManualBookingPaid(transaction, guestBookingId),
  };
}

export function createPgPmsManualBookingOperationsOwnerPort(): PmsManualBookingOperationsOwnerPort {
  return {
    lockRooms: ({ transaction, command }) => lockManualBookingRooms(transaction, command),
    persistOperationalFacts: ({ transaction, ...input }) =>
      persistOperationalFacts(transaction, input),
  };
}

async function assertManualBookingSourceCommandUnused(
  transaction: PmsManualBookingTransaction,
  commandId: string,
): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `pms.manual-booking.command-id:${commandId}`,
  ]);
  const found = await transaction.query(
    `SELECT id FROM booking.guest_bookings
     WHERE source_system = 'pms' AND source_booking_id = $1 FOR UPDATE`,
    [commandId],
  );
  if (found.rowCount) throw new CommandError("idempotency_conflict");
}

async function persistBookingFacts(
  transaction: PmsManualBookingTransaction,
  input: {
    command: PmsManualBookingCreateCommand;
    preview: ManualBookingPreviewResult;
    guestBookingId: string;
    bookingReference: string;
  },
): Promise<PmsManualBookingAcceptedWrite> {
  const { command, preview, guestBookingId, bookingReference } = input;
  const checkIn = command.stays.reduce(
    (earliest, stay) => (stay.checkIn < earliest ? stay.checkIn : earliest),
    command.stays[0]!.checkIn,
  );
  const checkOut = command.stays.reduce(
    (latest, stay) => (stay.checkOut > latest ? stay.checkOut : latest),
    command.stays[0]!.checkOut,
  );
  const adults = command.stays.reduce((sum, stay) => sum + stay.adults, 0);
  const children = command.stays.reduce((sum, stay) => sum + stay.children, 0);
  const total = preview.grandTotal;

  await transaction.query(
    `INSERT INTO booking.guest_bookings (
       id, property_id, public_reference, source_system, source_booking_id,
       lifecycle_status, payment_status, check_in, check_out, adults, children,
       room_count, currency, total_amount, balance_amount,
       expected_payment_method, booking_metadata
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'pms', $4, 'confirmed', 'unpaid',
       $5::date, $6::date, $7, $8, $9, $10, $11::numeric, $11::numeric, $12,
       jsonb_build_object('contractVersion', $13::text, 'commandId', $4::text)
     )`,
    [
      guestBookingId,
      command.propertyId,
      bookingReference,
      command.commandId,
      checkIn,
      checkOut,
      adults,
      children,
      command.stays.length,
      total.currency,
      total.amountDecimal,
      command.payment.expectedMethod,
      command.contractVersion,
    ],
  );
  await insertGuest(transaction, command, guestBookingId);
  await insertAddons(transaction, command, guestBookingId, preview);
  return { guestBookingId, bookingReference, total, checkIn, checkOut };
}

async function persistOperationalFacts(
  transaction: PmsManualBookingTransaction,
  input: {
    command: PmsManualBookingCreateCommand;
    rooms: readonly PmsManualBookingRoom[];
    guestBookingId: string;
  },
): Promise<void> {
  await insertAssignments(transaction, input.command, input.guestBookingId, input.rooms);
  if (input.command.privateNote)
    await insertPrivateNote(transaction, input.command, input.guestBookingId);
}

export async function markManualBookingPaid(
  transaction: PmsManualBookingTransaction,
  guestBookingId: string,
): Promise<void> {
  const updated = await transaction.query(
    `UPDATE booking.guest_bookings
     SET payment_status = 'paid', balance_amount = 0, updated_at = now()
     WHERE id = $1::uuid AND payment_status = 'unpaid' AND balance_amount = total_amount`,
    [guestBookingId],
  );
  if (updated.rowCount !== 1) throw new Error("Manual booking settlement state changed");
}

async function insertGuest(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  guestBookingId: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO booking.booking_guests (
       guest_booking_id, guest_role, first_name, last_name, email, phone,
       country_code, special_requests
     ) VALUES ($1::uuid, 'booker', $2, $3, $4, $5, $6, $7)`,
    [
      guestBookingId,
      command.guest.firstName,
      command.guest.lastName,
      command.guest.email,
      command.guest.phoneE164,
      command.guest.countryCode,
      command.guest.specialRequests,
    ],
  );
}

async function insertAssignments(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  guestBookingId: string,
  rooms: readonly PmsManualBookingRoom[],
): Promise<void> {
  const roomTypes = new Map(rooms.map((room) => [room.roomId, room.roomTypeId]));
  const assignments = command.stays.map((stay) => ({
    ...stay,
    roomTypeId: roomTypes.get(stay.roomId),
  }));
  await transaction.query(
    `INSERT INTO pms.operational_booking_assignments (
       property_id, guest_booking_id, room_type_id, rate_plan_id, room_id,
       position, assignment_status, channel, source, assignment_payload,
       assigned_at, stay_evidence_kind, check_in, check_out, adults, children
     )
     SELECT $1::uuid, $2::uuid, item."roomTypeId"::uuid,
       item."ratePlanId"::uuid, item."roomId"::uuid, item.position,
       'assigned', 'direct', 'manual', jsonb_build_object('contractVersion', $4::text),
       $5::timestamptz, 'exact', item."checkIn"::date, item."checkOut"::date,
       item.adults, item.children
     FROM jsonb_to_recordset($3::jsonb) AS item(
       position int, "roomId" text, "roomTypeId" text, "ratePlanId" text,
       "checkIn" text, "checkOut" text, adults int, children int
     )`,
    [
      command.propertyId,
      guestBookingId,
      JSON.stringify(assignments),
      command.contractVersion,
      command.audit.requestedAt,
    ],
  );
}

async function insertAddons(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  guestBookingId: string,
  preview: ManualBookingPreviewResult,
): Promise<void> {
  const snapshots = command.addOns.map((selection) => {
    const resolved = preview.addOns.find(({ addonId }) => addonId === selection.addonId)!;
    return {
      addonId: selection.addonId,
      packageCount: selection.packageCount,
      totalAmount: resolved.total.amountDecimal,
      currency: resolved.total.currency,
      snapshot: {
        contractVersion: command.contractVersion,
        pricingModel: resolved.pricingModel,
        unitPrice: resolved.unitPrice,
        packageCount: selection.packageCount,
        serviceUnits: selection.serviceUnits,
      },
    };
  });
  if (snapshots.length === 0) return;
  await transaction.query(
    `INSERT INTO booking.booking_addon_selections (
       property_id, guest_booking_id, addon_definition_id, addon_snapshot,
       quantity, total_amount, currency
     )
     SELECT $1::uuid, $2::uuid, item."addonId"::uuid, item.snapshot,
       item."packageCount", item."totalAmount"::numeric, item.currency
     FROM jsonb_to_recordset($3::jsonb) AS item(
       "addonId" text, "packageCount" int, "totalAmount" text,
       currency text, snapshot jsonb
     )`,
    [command.propertyId, guestBookingId, JSON.stringify(snapshots)],
  );
}

async function insertPrivateNote(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  guestBookingId: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO pms.booking_notes_private (
       property_id, guest_booking_id, author_user_id, body, source
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pms')`,
    [command.propertyId, guestBookingId, command.audit.actor.userId, command.privateNote],
  );
}
