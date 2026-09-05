import { createHash } from "node:crypto";
import type {
  ManagePhysicalRoomCommand,
  ManagePhysicalRoomResult,
  PhysicalRoomManagementPort,
} from "@vayada/domain-pms";
import pg from "pg";
import {
  lockAuthorizedPmsPhysicalRoomScope,
  type PmsPhysicalRoomUnitReconcileClient as Client,
  type PmsPhysicalRoomUnitReconcilePool as Pool,
} from "./pmsPhysicalRoomUnitReconcileRepository.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";
import { lockPmsRoomOrder } from "./pmsRoomOrder.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { refreshPhysicalRoomInventory } from "./pmsPhysicalRoomInventory.js";

const operation = "pms.physical_room.manage";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type ErrorCode = Extract<ManagePhysicalRoomResult, { ok: false }>["error"]["code"];
const failure = (code: ErrorCode, message: string, details = {}): ManagePhysicalRoomResult => ({
  ok: false,
  error: { code, message, ...details },
});

export function createPgPmsPhysicalRoomManagementRepository(config: {
  connectionString?: string;
  pool?: Pool;
  now?: () => Date;
}): PhysicalRoomManagementPort & { close(): Promise<void> } {
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  return {
    managePhysicalRoom: (command) =>
      execute(pool, command, (config.now?.() ?? new Date()).toISOString()),
    async close() {
      if (!config.pool) await pool.end();
    },
  };
}

async function execute(
  pool: Pool,
  command: ManagePhysicalRoomCommand,
  acceptedAt: string,
): Promise<ManagePhysicalRoomResult> {
  const client = await pool.connect();
  const keyHash = hash(command.idempotencyKey);
  const changes =
    command.action === "retire"
      ? null
      : {
          operationalLabel: command.changes.operationalLabel,
          floor: command.changes.floor,
          status: command.changes.status,
        };
  const fingerprint = hash(
    JSON.stringify({
      organizationId: command.organizationId,
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      expectedRevision: command.expectedRevision,
      action: command.action,
      roomUnitId: command.action === "create" ? null : command.roomUnitId,
      changes,
    }),
  );
  try {
    await client.query("BEGIN");
    await lockPmsInventoryMutationScope(client, command.propertyId);
    if (!(await lockAuthorizedPmsPhysicalRoomScope(client, command, new Date(acceptedAt)))) {
      await client.query("ROLLBACK");
      return failure("setup_scope_unavailable", "Room management access is no longer available.");
    }
    await lockPmsRoomFactsMutationScope(client, command.propertyId);
    await lockPmsRoomOrder(client, command.propertyId);
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, command.roomTypeId);
    const previous = await client.query<{ fingerprint: string; result: ManagePhysicalRoomResult }>(
      `SELECT request_fingerprint_hash AS fingerprint, idempotency_metadata->'result' AS result
       FROM platform.idempotency_keys WHERE operation_scope='pms' AND operation=$1
       AND tenant_scope='property' AND property_id=$2::uuid AND key_hash=$3`,
      [operation, command.propertyId, keyHash],
    );
    if (previous.rows[0]) {
      await client.query("ROLLBACK");
      return previous.rows[0].fingerprint === fingerprint && previous.rows[0].result
        ? previous.rows[0].result
        : failure(
            "idempotency_key_conflict",
            "This command key was already used for a different room change.",
          );
    }
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys (operation_scope, operation, key_hash, request_fingerprint_hash,
        status, tenant_scope, property_id, expires_at)
       VALUES ('pms',$1,$2,$3,'in_progress','property',$4::uuid,$5::timestamptz + interval '24 hours')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [operation, keyHash, fingerprint, command.propertyId, acceptedAt],
    );
    if (!reservation.rows[0])
      throw new Error("Physical-room idempotency reservation failed under property lock");
    await client.query("SAVEPOINT physical_room_change");
    let result: ManagePhysicalRoomResult;
    try {
      result = await mutate(client, command, acceptedAt, reservation.rows[0].id);
    } catch (error) {
      if (
        !(error instanceof pg.DatabaseError) ||
        error.code !== "23505" ||
        !["uq_pms_rooms_property_number", "uq_pms_rooms_property_verified_label_ci"].includes(
          error.constraint ?? "",
        )
      )
        throw error;
      result = failure(
        "operational_label_conflict",
        "Another room already uses that label. Choose a different label.",
      );
    }
    if (!result.ok) await client.query("ROLLBACK TO SAVEPOINT physical_room_change");
    await client.query("RELEASE SAVEPOINT physical_room_change");
    await client.query(
      `INSERT INTO platform.product_audit_events (audit_key, product, action, action_version, occurred_at,
       tenant_scope, property_id, actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, redacted_payload, private_payload, audit_metadata,
       retention_class, privacy_scope)
       VALUES ($1,'pms',$2,1,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,'pms','physical_room_unit',
       $6,$7::uuid,$8,$9::jsonb,$10::jsonb,$11::jsonb,'standard','internal')`,
      [
        `${operation}:${reservation.rows[0].id}`,
        `${operation}.${command.action}`,
        acceptedAt,
        command.propertyId,
        command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
        result.ok
          ? result.response.roomUnitId
          : command.action === "create"
            ? command.roomTypeId
            : command.roomUnitId,
        reservation.rows[0].id,
        command.audit.correlationId ?? command.audit.requestId,
        JSON.stringify({ outcome: result.ok ? result.response.outcome : result.error.code }),
        JSON.stringify({ result }),
        JSON.stringify({
          authorizedOrganizationId: command.organizationId,
          requestId: command.audit.requestId,
        }),
      ],
    );
    await client.query(
      `UPDATE platform.idempotency_keys SET status='completed', response_status_code=$2,
       response_body_hash=$3, completed_at=$4::timestamptz, idempotency_metadata=$5::jsonb WHERE id=$1::uuid`,
      [
        reservation.rows[0].id,
        result.ok ? 200 : 409,
        hash(JSON.stringify(result)),
        acceptedAt,
        JSON.stringify({ result }),
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mutate(
  client: Client,
  command: ManagePhysicalRoomCommand,
  acceptedAt: string,
  idempotencyId: string,
): Promise<ManagePhysicalRoomResult> {
  const scope = [command.propertyId, command.roomTypeId];
  const roomType = await client.query<{ revision: number }>(
    `SELECT room_units_revision::integer AS revision
    FROM pms.room_types WHERE property_id=$1::uuid AND id=$2::uuid AND active FOR UPDATE`,
    scope,
  );
  if (!roomType.rows[0]) return failure("room_type_not_found", "Room type is no longer active.");
  if (roomType.rows[0].revision !== command.expectedRevision)
    return failure(
      "room_units_revision_conflict",
      "Rooms changed since this view was opened. Reload and reapply your change.",
      { currentRevision: roomType.rows[0].revision },
    );
  const units = await client.query<{ id: string; status: string }>(
    `SELECT id::text, status FROM pms.rooms
    WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status<>'retired' ORDER BY id FOR UPDATE`,
    scope,
  );
  const unit =
    command.action === "create" ? null : units.rows.find((room) => room.id === command.roomUnitId);
  if (command.action !== "create" && !unit)
    return failure("room_unit_not_found", "The selected room is no longer active.");
  if (command.action === "create" && units.rows.length >= 500)
    return failure("room_capacity_limit", "A room type can contain at most 500 physical rooms.");
  if (
    command.action === "retire" ||
    (command.action === "update" &&
      command.changes.status &&
      command.changes.status !== unit?.status)
  ) {
    const protection = await client.query<{ assignment: boolean; block: boolean }>(
      `SELECT
      EXISTS(SELECT 1 FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND room_id=$3::uuid) AS assignment,
      EXISTS(SELECT 1 FROM pms.room_blocks WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND room_id=$3::uuid) AS block`,
      [...scope, command.roomUnitId],
    );
    const blockers = Object.entries(protection.rows[0] ?? { assignment: true, block: true })
      .filter(([, protectedValue]) => protectedValue)
      .map(([key]) => key);
    if (command.action === "retire" && unit?.status !== "available")
      blockers.push("operational_status");
    if (blockers.length)
      return failure(
        "physical_room_protected",
        "Resolve this room's assignments, blocks or operational status before retiring it or changing its status.",
        { blockers },
      );
  }
  let roomUnitId: string;
  if (command.action === "create") {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pms.rooms
      (property_id, room_type_id, source_system, room_number, operational_label_status, floor, status, sort_order)
      SELECT $1::uuid,$2::uuid,'pms',$3,'verified',$4,$5,COALESCE(MAX(sort_order),0)+1 FROM pms.rooms WHERE property_id=$1::uuid
      RETURNING id::text`,
      [
        ...scope,
        command.changes.operationalLabel,
        command.changes.floor ?? null,
        command.changes.status ?? "available",
      ],
    );
    roomUnitId = inserted.rows[0]!.id;
  } else {
    roomUnitId = command.roomUnitId;
    const changes = command.action === "retire" ? {} : command.changes;
    await client.query(
      `UPDATE pms.rooms SET
      room_number=CASE WHEN $4::boolean THEN $5 ELSE room_number END,
      operational_label_status=CASE WHEN $4::boolean THEN 'verified' ELSE operational_label_status END,
      floor=CASE WHEN $6::boolean THEN $7 ELSE floor END,
      status=COALESCE($8,status),updated_at=$9::timestamptz
      WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND id=$3::uuid`,
      [
        ...scope,
        roomUnitId,
        changes.operationalLabel !== undefined,
        changes.operationalLabel ?? null,
        Object.hasOwn(changes, "floor"),
        changes.floor ?? null,
        command.action === "retire" ? "retired" : (changes.status ?? null),
        acceptedAt,
      ],
    );
  }
  const activeCount =
    units.rows.length + (command.action === "create" ? 1 : command.action === "retire" ? -1 : 0);
  await client.query(
    `UPDATE pms.room_types SET room_units_revision=room_units_revision+1 WHERE property_id=$1::uuid AND id=$2::uuid`,
    scope,
  );
  const refreshError = await refreshPhysicalRoomInventory(client, command, {
    activeCount,
    previousCount: units.rows.length,
    idempotencyId,
    acceptedAt,
  });
  if (refreshError) return refreshError;
  const linkedChanges = await reconcilePmsLinkedInventory(client, command.propertyId, acceptedAt);
  await enqueuePmsLinkedInventorySideEffects(
    client,
    {
      propertyId: command.propertyId,
      operation: "physical_room_management",
      commandId: idempotencyId,
      keyHash: hash(command.idempotencyKey),
      acceptedAt,
      audit: command.audit,
    },
    linkedChanges,
  );
  return {
    ok: true,
    response: {
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      roomUnitId,
      roomUnitsRevision: command.expectedRevision + 1,
      outcome:
        command.action === "create"
          ? "created"
          : command.action === "retire"
            ? "retired"
            : "updated",
    },
  };
}
