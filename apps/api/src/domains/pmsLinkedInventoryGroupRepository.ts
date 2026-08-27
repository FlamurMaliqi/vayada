import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

import type { PmsLinkedInventoryGroup } from "./pmsOperationsReadModel.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
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
  idempotencyMetadata: { result?: unknown } | null;
};

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
    const replay = await findReplay(client, operation, command, keyHash, fingerprint);
    if (replay) {
      await client.query("COMMIT");
      return replay;
    }
    if (!(await reserveIdempotency(client, operation, command, keyHash, fingerprint, acceptedAt))) {
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
    await writeAudit(client, operation, command, mutation.group, keyHash, acceptedAt);
    await completeIdempotency(
      client,
      operation,
      command,
      keyHash,
      fingerprint,
      mutation.group,
      acceptedAt,
    );
    await client.query("COMMIT");
    return mutation;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
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
): Promise<PmsLinkedInventoryGroupCommandResult | null> {
  const result = await client.query<ReplayRow>(
    `SELECT status,request_fingerprint_hash AS "requestFingerprintHash",idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys WHERE operation_scope='pms' AND operation=$1 AND key_hash=$2
      AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
    [`linked_inventory_group_${operation}`, keyHash, command.propertyId],
  );
  const replay = result.rows[0];
  if (!replay) return null;
  const replayedGroup = replay.idempotencyMetadata?.result;
  if (
    replay.requestFingerprintHash !== fingerprint ||
    replay.status !== "completed" ||
    !(replayedGroup === null || isLinkedInventoryGroup(replayedGroup))
  ) {
    return linkedInventoryConflict(
      "idempotency_conflict",
      "Idempotency key was used for another linked inventory command.",
    );
  }
  return { ok: true, group: replayedGroup, replayed: true };
}

async function reserveIdempotency(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  keyHash: string,
  fingerprint: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,correlation_id,expires_at,idempotency_metadata)
     VALUES ('pms',$1,$2,$3,'in_progress','property',$4::uuid,$5,$6::timestamptz+interval '24 hours',$7::jsonb)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      `linked_inventory_group_${operation}`,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeIdempotency(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  keyHash: string,
  fingerprint: string,
  group: PmsLinkedInventoryGroup | null,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,response_resource_product='pms',response_resource_type='linked_inventory_group',
       response_resource_id=$1,idempotency_metadata=$2::jsonb,response_body_hash=$3,completed_at=$4::timestamptz,last_seen_at=$4::timestamptz
     WHERE operation_scope='pms' AND operation=$5 AND key_hash=$6 AND tenant_scope='property' AND property_id=$7::uuid`,
    [
      group?.groupId ?? command.propertyId,
      JSON.stringify({ result: group }),
      fingerprint,
      acceptedAt,
      `linked_inventory_group_${operation}`,
      keyHash,
      command.propertyId,
    ],
  );
}

async function writeAudit(
  client: PmsLinkedInventoryGroupClient,
  operation: Operation,
  command: Command,
  group: PmsLinkedInventoryGroup | null,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,correlation_id,causation_id,redacted_payload,audit_metadata)
     VALUES ($1,'pms',$2,$3::timestamptz,'property',$4::uuid,$5,$6::uuid,'pms','linked_inventory_group',$7,$8,$9,$10::jsonb,$11::jsonb)
     ON CONFLICT (product,audit_key) DO NOTHING`,
    [
      `pms.linked_inventory_group.${operation}.property.${command.propertyId}.key.${keyHash}.v1`,
      `pms.linked_inventory_group.${operation}`,
      acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      group?.groupId ?? (command as PmsLinkedInventoryGroupDeleteCommand).groupId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({ group }),
      JSON.stringify({ reason: command.audit.reason, requestId: command.audit.requestId }),
    ],
  );
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isUniqueViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
