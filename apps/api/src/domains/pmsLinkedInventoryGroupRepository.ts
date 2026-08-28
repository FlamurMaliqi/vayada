import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

import type { PmsLinkedInventoryGroup } from "./pmsOperationsReadModel.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  PmsLinkedInventoryNotCanonicalError,
  reconcilePmsLinkedInventory,
} from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import {
  deletePmsLinkedInventoryGroup,
  linkedInventoryConflict,
  putPmsLinkedInventoryGroup,
  type PmsLinkedInventoryGroupClient,
  type PmsLinkedInventoryGroupCommandResult,
  type PmsLinkedInventoryGroupDeleteCommand,
  type PmsLinkedInventoryGroupPutCommand,
} from "./pmsLinkedInventoryGroupMutations.js";

export type {
  PmsLinkedInventoryGroupAudit,
  PmsLinkedInventoryGroupCommandErrorCode,
  PmsLinkedInventoryGroupCommandResult,
  PmsLinkedInventoryGroupDeleteCommand,
  PmsLinkedInventoryGroupPutCommand,
} from "./pmsLinkedInventoryGroupMutations.js";

export type PmsLinkedInventoryGroupCommandRepository = {
  create(command: PmsLinkedInventoryGroupPutCommand): Promise<PmsLinkedInventoryGroupCommandResult>;
  replace(
    command: PmsLinkedInventoryGroupPutCommand,
  ): Promise<PmsLinkedInventoryGroupCommandResult>;
  delete(
    command: PmsLinkedInventoryGroupDeleteCommand,
  ): Promise<PmsLinkedInventoryGroupCommandResult>;
  close(): Promise<void>;
};
type Pool = { connect(): Promise<PmsLinkedInventoryGroupClient>; end(): Promise<void> };
type Config = { connectionString?: string; pool?: Pool; now?: () => Date; createId?: () => string };
type Operation = "create" | "replace" | "delete";
type Command = PmsLinkedInventoryGroupPutCommand | PmsLinkedInventoryGroupDeleteCommand;
type ReplayRow = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceId: string | null;
  idempotencyMetadata: { result?: unknown } | null;
  expiresAt: Date | string;
};
type IdempotencyReservation = { id: string; attempt: number };

export function createPgPmsLinkedInventoryGroupCommandRepository(
  config: Config,
): PmsLinkedInventoryGroupCommandRepository {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim())
    throw new Error("Linked inventory connectionString must not be empty");
  const pool = config.pool ?? (new pg.Pool({ connectionString: config.connectionString }) as Pool);
  const now = config.now ?? (() => new Date());
  const createId = config.createId ?? randomUUID;
  return {
    create: (command) => execute(pool, now, createId, "create", command),
    replace: (command) => execute(pool, now, createId, "replace", command),
    delete: (command) => execute(pool, now, createId, "delete", command),
    close: () => (ownsPool ? pool.end() : Promise.resolve()),
  };
}

async function execute(
  pool: Pool,
  now: () => Date,
  createId: () => string,
  operation: Operation,
  command: Command,
): Promise<PmsLinkedInventoryGroupCommandResult> {
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(JSON.stringify(normalizedFingerprint(operation, command)));
  try {
    await client.query("BEGIN");
    await lockPmsInventoryMutationScope(client, command.propertyId);
    const replay = await findReplay(client, operation, command, keyHash, fingerprint, acceptedAt);
    if (replay) {
      await client.query("COMMIT");
      return replay;
    }
    const reservation = await reserveIdempotency(
      client,
      operation,
      command,
      keyHash,
      fingerprint,
      acceptedAt,
    );
    if (!reservation) {
      await client.query("ROLLBACK");
      return linkedInventoryConflict(
        "idempotency_conflict",
        "Linked inventory command is already in progress.",
      );
    }
    const mutation =
      operation === "delete"
        ? await deletePmsLinkedInventoryGroup(
            client,
            command as PmsLinkedInventoryGroupDeleteCommand,
          )
        : await putPmsLinkedInventoryGroup(
            client,
            operation,
            command as PmsLinkedInventoryGroupPutCommand,
            createId,
          );
    if (!mutation.ok) {
      await client.query("ROLLBACK");
      return mutation;
    }
    const changes = await reconcilePmsLinkedInventory(client, command.propertyId, acceptedAt);
    await enqueuePmsLinkedInventorySideEffects(
      client,
      {
        propertyId: command.propertyId,
        operation: `group_${operation}`,
        commandId: command.commandId,
        keyHash,
        acceptedAt,
        audit: command.audit,
      },
      changes,
    );
    await writeAudit(client, operation, command, mutation.group, reservation, keyHash, acceptedAt);
    await completeIdempotency(
      client,
      operation,
      command,
      reservation.id,
      mutation.group,
      acceptedAt,
    );
    await client.query("COMMIT");
    return mutation;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PmsLinkedInventoryNotCanonicalError) {
      return linkedInventoryConflict(
        "linked_inventory_not_canonical",
        "Linked inventory requires canonical inventory materialization.",
      );
    }
    if (isUniqueViolation(error, "uq_pms_linked_inventory_group_property_name")) {
      return linkedInventoryConflict(
        "linked_inventory_name_conflict",
        "A linked inventory group already uses this name.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function findReplay(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  keyHash: string,
  fingerprint: string,
  acceptedAt: string,
): Promise<PmsLinkedInventoryGroupCommandResult | null> {
  const result = await client.query<ReplayRow>(
    `SELECT status,request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata",expires_at AS "expiresAt"
     FROM platform.idempotency_keys WHERE operation_scope='pms' AND operation=$1 AND key_hash=$2
      AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
    [`linked_inventory_group_${operation}`, keyHash, command.propertyId],
  );
  const replay = result.rows[0];
  if (!replay || new Date(replay.expiresAt).getTime() <= new Date(acceptedAt).getTime())
    return null;
  const replayedGroup = replay.idempotencyMetadata?.result;
  const validResult =
    operation === "delete" ? replayedGroup === null : isLinkedInventoryGroup(replayedGroup);
  const expectedResourceId =
    replayedGroup && isLinkedInventoryGroup(replayedGroup)
      ? replayedGroup.groupId
      : "groupId" in command && command.groupId
        ? command.groupId
        : null;
  if (
    replay.requestFingerprintHash !== fingerprint ||
    replay.status !== "completed" ||
    !validResult ||
    replay.responseStatusCode !== idempotencyResponseStatus(operation) ||
    replay.responseBodyHash !== sha256(stableJson(idempotencyResponseBody(replayedGroup))) ||
    replay.responseResourceId !== expectedResourceId
  ) {
    return linkedInventoryConflict(
      "idempotency_conflict",
      "Idempotency key was used for another linked inventory command.",
    );
  }
  return {
    ok: true,
    group: operation === "delete" ? null : (replayedGroup as PmsLinkedInventoryGroup),
    replayed: true,
  };
}

async function reserveIdempotency(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  keyHash: string,
  fingerprint: string,
  acceptedAt: string,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
       property_id,correlation_id,first_seen_at,last_seen_at,expires_at,idempotency_metadata)
     VALUES ('pms',$1,$2,$3,'in_progress','property',$4::uuid,$5,
             $6::timestamptz,$6::timestamptz,$6::timestamptz+interval '24 hours',
             jsonb_build_object('commandId',$7,'attempt',1))
     ON CONFLICT (operation_scope,operation,key_hash,scope_key)
     DO UPDATE SET request_fingerprint_hash=EXCLUDED.request_fingerprint_hash,
       status='in_progress',response_status_code=NULL,response_body_hash=NULL,
       response_resource_product=NULL,response_resource_type=NULL,response_resource_id=NULL,
       correlation_id=EXCLUDED.correlation_id,first_seen_at=EXCLUDED.first_seen_at,
       last_seen_at=EXCLUDED.last_seen_at,completed_at=NULL,expires_at=EXCLUDED.expires_at,
       idempotency_metadata=jsonb_build_object(
         'commandId',$7,
         'attempt',COALESCE((idempotency_keys.idempotency_metadata->>'attempt')::integer,1)+1)
     WHERE idempotency_keys.expires_at<=EXCLUDED.first_seen_at
     RETURNING id::text AS id,(idempotency_metadata->>'attempt')::integer AS attempt`,
    [
      `linked_inventory_group_${operation}`,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      command.commandId,
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  reservationId: string,
  group: PmsLinkedInventoryGroup | null,
  acceptedAt: string,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',response_status_code=$2,
       response_resource_product='pms',response_resource_type='linked_inventory_group',
       response_resource_id=$3,idempotency_metadata=idempotency_metadata||jsonb_build_object('result',$4::jsonb),
       response_body_hash=$5,completed_at=$6::timestamptz,last_seen_at=$6::timestamptz
     WHERE id=$1::uuid AND status='in_progress'`,
    [
      reservationId,
      idempotencyResponseStatus(operation),
      group?.groupId ?? ("groupId" in command ? command.groupId : command.propertyId),
      JSON.stringify(group),
      sha256(stableJson(idempotencyResponseBody(group))),
      acceptedAt,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Linked inventory idempotency completion failed");
  }
}

async function writeAudit(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  group: PmsLinkedInventoryGroup | null,
  reservation: IdempotencyReservation,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
       actor_user_id,target_resource_product,target_resource_type,target_resource_id,
       idempotency_key_id,correlation_id,causation_id,redacted_payload,audit_metadata)
     VALUES ($1,'pms',$2,$3::timestamptz,'property',$4::uuid,$5,$6::uuid,
             'pms','linked_inventory_group',$7,$8::uuid,$9,$10,$11::jsonb,$12::jsonb)`,
    [
      `pms.linked_inventory_group.${operation}.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      `pms.linked_inventory_group.${operation}`,
      acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      group?.groupId ?? (command as PmsLinkedInventoryGroupDeleteCommand).groupId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({ group }),
      JSON.stringify({
        reason: command.audit.reason,
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId:
          command.audit.actor.kind === "user" ? command.audit.actor.organizationId : undefined,
        actorService:
          command.audit.actor.kind === "system" ? command.audit.actor.service : undefined,
      }),
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Linked inventory audit insert failed");
}

function normalizedFingerprint(operation: Operation, command: Command): unknown {
  return "memberRoomTypeIds" in command
    ? {
        operation,
        propertyId: command.propertyId,
        groupId: command.groupId,
        name: command.name.trim(),
        memberRoomTypeIds: [...command.memberRoomTypeIds].sort(),
        expectedRevision: command.expectedRevision,
      }
    : {
        operation,
        propertyId: command.propertyId,
        groupId: command.groupId,
        expectedRevision: command.expectedRevision,
      };
}

function isLinkedInventoryGroup(value: unknown): value is PmsLinkedInventoryGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<PmsLinkedInventoryGroup>;
  return (
    typeof group.groupId === "string" &&
    typeof group.name === "string" &&
    Number.isInteger(group.revision) &&
    Array.isArray(group.memberRoomTypeIds) &&
    group.memberRoomTypeIds.every((member) => typeof member === "string")
  );
}

const idempotencyResponseStatus = (operation: Operation): 200 | 201 =>
  operation === "create" ? 201 : 200;
const idempotencyResponseBody = (group: unknown): { ok: true; group: unknown } => ({
  ok: true,
  group,
});
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isUniqueViolation = (error: unknown, constraint: string): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint,
  );
