import type {
  PmsRoomAssignmentOptimizationMove,
  PmsRoomAssignmentOptimizationResult,
} from "@vayada/domain-pms";

import type {
  PmsRoomAssignmentOptimizationCommandReservation,
  PmsRoomAssignmentOptimizationCommandStoreClient,
} from "./pmsRoomAssignmentOptimizationCommandStore.js";

export type PmsRoomAssignmentOptimizationEvidenceCommand = {
  propertyId: string;
  roomTypeId: string;
  reason: "create" | "cancel" | "modify";
  commandId: string;
  correlationId: string;
  causationId?: string;
  actor: { kind: "system" } | { kind: "user"; userId: string };
};

type OptimizedResult = Extract<PmsRoomAssignmentOptimizationResult, { outcome: "optimized" }>;

export async function appendPmsRoomAssignmentOptimizationEvidence(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationEvidenceCommand,
  result: OptimizedResult,
  reservation: PmsRoomAssignmentOptimizationCommandReservation,
): Promise<void> {
  if (result.moves.length === 0) throw new Error("PMS room optimization evidence requires moves");
  await assertReservation(client, command, reservation);
  const eventId = await appendEvent(client, command, result, reservation.keyHash);
  await appendAudits(client, command, result.moves, eventId, reservation.id);
  await enqueueCalendarRefresh(client, command, result, eventId, reservation.keyHash);
}

async function assertReservation(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationEvidenceCommand,
  reservation: PmsRoomAssignmentOptimizationCommandReservation,
): Promise<void> {
  if (
    reservation.propertyId !== command.propertyId ||
    reservation.keyHash !== createHash("sha256").update(command.commandId).digest("hex")
  ) {
    throw new Error("PMS room optimization reservation does not match command");
  }
  const current = await client.query(
    `SELECT id FROM platform.idempotency_keys
     WHERE id = $1::uuid AND operation_scope = 'pms' AND operation = $2
       AND key_hash = $3 AND status = 'in_progress' AND tenant_scope = 'property'
       AND organization_id IS NULL AND property_id = $4::uuid
       AND idempotency_metadata ->> 'attemptId' = $5
     FOR SHARE`,
    [
      reservation.id,
      "pms.room_assignments.optimize",
      reservation.keyHash,
      reservation.propertyId,
      reservation.attemptId,
    ],
  );
  if (current.rowCount !== 1) throw new Error("PMS room optimization reservation is stale");
}

async function appendEvent(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationEvidenceCommand,
  result: OptimizedResult,
  keyHash: string,
): Promise<string> {
  const event = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
       resource_product, resource_type, resource_id, actor_type, actor_user_id,
       correlation_id, causation_id, idempotency_key_hash, payload
     ) VALUES (
       'pms', $1, 'pms.room_assignments.optimized', now(), 'property', $2::uuid,
       'pms', 'room_type_assignments', $3, $4, $5::uuid, $6, $7, $8, $9::jsonb
     ) RETURNING id::text AS "eventId"`,
    [
      eventKey(command),
      command.propertyId,
      command.roomTypeId,
      command.actor.kind,
      command.actor.kind === "user" ? command.actor.userId : null,
      command.correlationId,
      command.causationId ?? null,
      keyHash,
      JSON.stringify({ reason: command.reason, result }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("PMS room optimization event insert failed");
  return eventId;
}

async function appendAudits(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationEvidenceCommand,
  moves: readonly PmsRoomAssignmentOptimizationMove[],
  eventId: string,
  idempotencyId: string,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id, redacted_payload
     ) SELECT $1 || '.' || move.assignment_id || '.v1', 'pms',
       'pms.assignment.auto_rearranged', now(), 'property', $2::uuid, $3, $4::uuid,
       'pms', 'operational_booking_assignment', move.assignment_id, $5::uuid, $6::uuid, $7, $8,
       jsonb_build_object('fromRoomId', move.from_room_id, 'toRoomId', move.to_room_id,
                          'reason', $9::text, 'roomTypeId', $10::text)
     FROM jsonb_to_recordset($11::jsonb) AS move(
       assignment_id text, from_room_id text, to_room_id text
     )`,
    [
      eventKey(command),
      command.propertyId,
      command.actor.kind,
      command.actor.kind === "user" ? command.actor.userId : null,
      eventId,
      idempotencyId,
      command.correlationId,
      command.causationId ?? null,
      command.reason,
      command.roomTypeId,
      JSON.stringify(movesToSql(moves)),
    ],
  );
  if (inserted.rowCount !== moves.length)
    throw new Error("PMS room optimization audit insert failed");
}

async function enqueueCalendarRefresh(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationEvidenceCommand,
  result: OptimizedResult,
  eventId: string,
  keyHash: string,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id, idempotency_key_hash, payload
     ) VALUES (
       $1::uuid, $2, 'pms.calendar-projection', 'pms.calendar.refresh_requested',
       'property', $3::uuid, 'pms', 'room_type_assignments', $4, $5, $6, $7::jsonb
     )`,
    [
      eventId,
      `${eventKey(command)}.calendar.v1`,
      command.propertyId,
      command.roomTypeId,
      command.correlationId,
      keyHash,
      JSON.stringify({
        propertyId: command.propertyId,
        roomTypeId: command.roomTypeId,
        movedBookings: result.moves.length,
      }),
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("PMS room optimization outbox insert failed");
}

function movesToSql(moves: readonly PmsRoomAssignmentOptimizationMove[]) {
  return moves.map((move) => ({
    assignment_id: move.occupancyId,
    from_room_id: move.fromRoomId,
    to_room_id: move.toRoomId,
  }));
}

function eventKey(command: PmsRoomAssignmentOptimizationEvidenceCommand): string {
  return `pms.room-assignments.optimized.${command.propertyId}.${command.roomTypeId}.${command.commandId}`;
}
import { createHash } from "node:crypto";
