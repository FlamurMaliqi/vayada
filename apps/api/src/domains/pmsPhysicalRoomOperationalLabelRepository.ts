import { createHash } from "node:crypto";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseSetPhysicalRoomOperationalLabelResult,
  serializeSetPhysicalRoomOperationalLabelFingerprint,
  type PhysicalRoomOperationalLabelPort,
  type SetPhysicalRoomOperationalLabelCommand,
  type SetPhysicalRoomOperationalLabelResult,
} from "@vayada/domain-pms";
import pg from "pg";

import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import {
  lockAuthorizedPmsPhysicalRoomScope,
  type PmsPhysicalRoomUnitReconcileClient as Client,
  type PmsPhysicalRoomUnitReconcilePool as Pool,
} from "./pmsPhysicalRoomUnitReconcileRepository.js";

const OPERATION = "pms.physical_room_unit.operational_label.set";
const LABEL_INDEXES = new Set([
  "uq_pms_rooms_property_number",
  "uq_pms_rooms_property_verified_label_ci",
]);

type RoomTypeRow = { roomUnitsRevision: number };
type UnitRow = { operationalLabel: string | null; operationalLabelStatus: string };
type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: unknown;
};

export function createPgPmsPhysicalRoomOperationalLabelRepository(config: {
  connectionString?: string;
  max?: number;
  now?: () => Date;
  pool?: Pool;
}): PhysicalRoomOperationalLabelPort & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS physical-room label connectionString must not be empty");
  }
  const pool =
    config.pool ??
    (new pg.Pool({ connectionString: config.connectionString, max: config.max }) as Pool);
  const now = config.now ?? (() => new Date());
  return {
    setPhysicalRoomOperationalLabel: (command) => execute(pool, command, now()),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function execute(
  pool: Pool,
  command: SetPhysicalRoomOperationalLabelCommand,
  occurredAt: Date,
): Promise<SetPhysicalRoomOperationalLabelResult> {
  const client = await pool.connect();
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(serializeSetPhysicalRoomOperationalLabelFingerprint(command));
  try {
    await client.query("BEGIN");
    if (!(await lockAuthorizedPmsPhysicalRoomScope(client, command, occurredAt))) {
      await client.query("ROLLBACK");
      return failure({ code: "setup_scope_unavailable" });
    }
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, command.roomTypeId);
    const roomType = await lockRoomType(client, command);
    if (!roomType) {
      await client.query("ROLLBACK");
      return failure({ code: "room_type_not_found" });
    }
    const replay = await findReplay(client, command, keyHash, fingerprint);
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }
    const idempotencyId = await reserve(client, command, keyHash, fingerprint, occurredAt);
    if (!idempotencyId) {
      const concurrent = await findReplay(client, command, keyHash, fingerprint);
      await client.query("ROLLBACK");
      return concurrent ?? failure({ code: "command_in_progress" });
    }
    const result = await setLockedLabel(client, command, roomType, occurredAt);
    await audit(client, command, idempotencyId, keyHash, result, occurredAt);
    await complete(client, idempotencyId, result, occurredAt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockRoomType(
  client: Client,
  command: SetPhysicalRoomOperationalLabelCommand,
): Promise<RoomTypeRow | null> {
  const result = await client.query<RoomTypeRow>(
    `SELECT room_units_revision::integer AS "roomUnitsRevision"
     FROM pms.room_types
     WHERE id = $1::uuid AND property_id = $2::uuid AND active
     FOR UPDATE`,
    [command.roomTypeId, command.propertyId],
  );
  return result.rows[0] ?? null;
}

async function setLockedLabel(
  client: Client,
  command: SetPhysicalRoomOperationalLabelCommand,
  roomType: RoomTypeRow,
  occurredAt: Date,
): Promise<SetPhysicalRoomOperationalLabelResult> {
  if (command.expectedRevision !== roomType.roomUnitsRevision) {
    return failure({
      code: "room_units_revision_conflict",
      currentRevision: roomType.roomUnitsRevision,
    });
  }
  const unit = await client.query<UnitRow>(
    `SELECT room_number AS "operationalLabel",
            operational_label_status AS "operationalLabelStatus"
     FROM pms.rooms
     WHERE id = $1::uuid AND property_id = $2::uuid
       AND room_type_id = $3::uuid AND status <> 'retired'
     FOR UPDATE`,
    [command.roomUnitId, command.propertyId, command.roomTypeId],
  );
  const current = unit.rows[0];
  if (!current) return failure({ code: "room_unit_not_found" });
  if (
    current.operationalLabel === command.operationalLabel &&
    current.operationalLabelStatus === "verified"
  ) {
    return success(command, roomType.roomUnitsRevision, occurredAt, false);
  }
  await client.query("SAVEPOINT set_operational_label");
  try {
    const updated = await client.query(
      `UPDATE pms.rooms
       SET room_number = $4, operational_label_status = 'verified', updated_at = now()
       WHERE id = $1::uuid AND property_id = $2::uuid
         AND room_type_id = $3::uuid AND status <> 'retired'`,
      [command.roomUnitId, command.propertyId, command.roomTypeId, command.operationalLabel],
    );
    if (updated.rowCount !== 1) throw new Error("PMS physical-room label update lost its lock");
    await client.query("RELEASE SAVEPOINT set_operational_label");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT set_operational_label");
    await client.query("RELEASE SAVEPOINT set_operational_label");
    if (isLabelConflict(error)) return failure({ code: "operational_label_conflict" });
    throw error;
  }
  const revision = await client.query<RoomTypeRow>(
    `UPDATE pms.room_types
     SET room_units_revision = room_units_revision + 1
     WHERE id = $1::uuid AND property_id = $2::uuid AND active
       AND room_units_revision = $3
     RETURNING room_units_revision::integer AS "roomUnitsRevision"`,
    [command.roomTypeId, command.propertyId, command.expectedRevision],
  );
  if (revision.rows[0]?.roomUnitsRevision !== command.expectedRevision + 1) {
    throw new Error("PMS physical-room label revision compare-and-set failed");
  }
  return success(command, command.expectedRevision + 1, occurredAt, true);
}

function success(
  command: SetPhysicalRoomOperationalLabelCommand,
  revision: number,
  occurredAt: Date,
  changed: boolean,
): SetPhysicalRoomOperationalLabelResult {
  return validated({
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: changed ? "updated" : "unchanged",
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      roomUnitId: command.roomUnitId,
      roomUnitsRevision: revision,
      operationalLabel: command.operationalLabel,
      operationalLabelStatus: "verified",
      acceptedAt: occurredAt.toISOString(),
    },
  });
}

async function findReplay(
  client: Client,
  command: SetPhysicalRoomOperationalLabelCommand,
  keyHash: string,
  fingerprint: string,
): Promise<SetPhysicalRoomOperationalLabelResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
     LIMIT 1`,
    [OPERATION, keyHash, command.propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint) {
    return failure({ code: "idempotency_key_conflict" });
  }
  if (row.status !== "completed") return failure({ code: "command_in_progress" });
  const metadata = isRecord(row.idempotencyMetadata) ? row.idempotencyMetadata : null;
  const replay = parseSetPhysicalRoomOperationalLabelResult(metadata?.result);
  return replay && matches(replay, command)
    ? replay
    : failure({ code: "idempotency_key_conflict" });
}

function matches(
  result: SetPhysicalRoomOperationalLabelResult,
  command: SetPhysicalRoomOperationalLabelCommand,
): boolean {
  if (!result.ok) {
    if (
      result.error.code === "setup_scope_unavailable" ||
      result.error.code === "room_type_not_found" ||
      result.error.code === "idempotency_key_conflict" ||
      result.error.code === "command_in_progress"
    ) {
      return false;
    }
    return !(
      result.error.code === "room_units_revision_conflict" &&
      result.error.currentRevision === command.expectedRevision
    );
  }
  const response = result.response;
  return (
    response.propertyId === command.propertyId &&
    response.roomTypeId === command.roomTypeId &&
    response.roomUnitId === command.roomUnitId &&
    response.operationalLabel === command.operationalLabel &&
    response.roomUnitsRevision ===
      command.expectedRevision + (response.outcome === "updated" ? 1 : 0)
  );
}

async function reserve(
  client: Client,
  command: SetPhysicalRoomOperationalLabelCommand,
  keyHash: string,
  fingerprint: string,
  occurredAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid,
       $5, $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours', $7::jsonb
     ) ON CONFLICT DO NOTHING RETURNING id::text`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      occurredAt.toISOString(),
      JSON.stringify({ authorizedOrganizationId: command.organizationId }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function audit(
  client: Client,
  command: SetPhysicalRoomOperationalLabelCommand,
  idempotencyId: string,
  keyHash: string,
  result: SetPhysicalRoomOperationalLabelResult,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at, tenant_scope,
       organization_id, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       idempotency_key_id, correlation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     ) VALUES (
       $1, 'pms', 'physical_room_unit.operational_label.set', 1, $2::timestamptz,
       'property', NULL, $3::uuid, 'user', $4::uuid,
       'pms', 'physical_room_unit', $5, $6::uuid, $7, $8::jsonb, $9::jsonb,
       $10::jsonb, 'standard', 'internal'
     )`,
    [
      `pms.physical_room_unit.operational_label.set:${idempotencyId}`,
      occurredAt.toISOString(),
      command.propertyId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.roomUnitId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify({ outcome: result.ok ? result.response.outcome : result.error.code }),
      JSON.stringify({ result }),
      JSON.stringify({
        requestId: command.audit.requestId,
        idempotencyKeyHash: keyHash,
        authorizedOrganizationId: command.organizationId,
      }),
    ],
  );
}

async function complete(
  client: Client,
  idempotencyId: string,
  result: SetPhysicalRoomOperationalLabelResult,
  occurredAt: Date,
): Promise<void> {
  const status = result.ok
    ? 200
    : result.error.code === "room_type_not_found" || result.error.code === "room_unit_not_found"
      ? 404
      : 409;
  const serialized = JSON.stringify(result);
  const updated = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = $5::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      status,
      sha256(serialized),
      occurredAt.toISOString(),
      JSON.stringify({ result }),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("PMS physical-room label completion failed");
}

function failure(
  error: Extract<SetPhysicalRoomOperationalLabelResult, { ok: false }>["error"],
): SetPhysicalRoomOperationalLabelResult {
  return validated({ ok: false, error });
}

function validated(value: SetPhysicalRoomOperationalLabelResult) {
  const parsed = parseSetPhysicalRoomOperationalLabelResult(value);
  if (!parsed) throw new Error("PMS physical-room label repository produced an invalid result");
  return parsed;
}

function isLabelConflict(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "23505" &&
    typeof error.constraint === "string" &&
    LABEL_INDEXES.has(error.constraint)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
