import { createHash, randomUUID } from "node:crypto";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseCreateRoomTypeFactsResult,
  parseSafeDeleteRoomTypeResult,
  parseUpdateRoomTypeFactsResult,
  serializeCreateRoomTypeFactsFingerprint,
  serializeSafeDeleteRoomTypeFingerprint,
  serializeUpdateRoomTypeFactsFingerprint,
  type CreateRoomTypeFactsCommand,
  type CreateRoomTypeFactsError,
  type CreateRoomTypeFactsResult,
  type RoomFactsCommandPort,
  type RoomFactsVocabularyValidationPort,
  type RoomTypeDeleteBlocker,
  type RoomTypeFacts,
  type SafeDeleteRoomTypeCommand,
  type SafeDeleteRoomTypeError,
  type SafeDeleteRoomTypeResult,
  type UpdateRoomTypeFactsCommand,
  type UpdateRoomTypeFactsError,
  type UpdateRoomTypeFactsResult,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { pmsRoomFactsSnapshotFromRow, type PmsRoomFactsRow } from "./pmsRoomFactsReadModel.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

export type PmsRoomFactsCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsRoomFactsCommandPool = {
  connect(): Promise<PmsRoomFactsCommandClient>;
  end(): Promise<void>;
};

export type PmsRoomFactsCommandRepositoryConfig = {
  connectionString: string;
  vocabularyValidator: RoomFactsVocabularyValidationPort;
  max?: number;
  pool?: PmsRoomFactsCommandPool;
  now?: () => Date;
  randomId?: () => string;
};

export type PmsRoomFactsCommandRepository = RoomFactsCommandPort & {
  close(): Promise<void>;
};

type AnyCommand =
  | CreateRoomTypeFactsCommand
  | UpdateRoomTypeFactsCommand
  | SafeDeleteRoomTypeCommand;
type AnyResult = CreateRoomTypeFactsResult | UpdateRoomTypeFactsResult | SafeDeleteRoomTypeResult;

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

type IdempotencyReservation = {
  id: string;
  attempt: number;
};

type CommandSpec<C extends AnyCommand, R extends AnyResult> = {
  operation: string;
  serializeFingerprint(command: C): string;
  parseResult(value: unknown): R | null;
  scopeFailure(): R;
  coordinationFailure(code: "idempotency_key_conflict" | "command_in_progress"): R;
};

type CommandWorkResult<R extends AnyResult> = {
  result: R;
  /** False means the whole transaction, including the reservation, must be rolled back. */
  finalize: boolean;
};

type LockedRoomTypeRow = PmsRoomFactsRow;

type DraftBindingRow = {
  roomTypeId: string;
  currentRevision: number | string;
};

type DeleteReferenceCountsRow = {
  publishedReferenceCount: number | string;
  bookingReferenceCount: number | string;
  assignedPhysicalUnitCount: number | string;
  verifiedPhysicalUnitCount: number | string;
  rateReferenceCount: number | string;
  calendarReferenceCount: number | string;
  roomBlockReferenceCount: number | string;
  channelReferenceCount: number | string;
  otherOperationalReferenceCount: number | string;
};

type InboundForeignKeyRow = {
  sourceSchema: string;
  sourceTable: string;
  constraintName: string;
  referencedTable: string;
};

const CREATE_OPERATION = "pms.room_facts.create";
const UPDATE_OPERATION = "pms.room_facts.update";
const SAFE_DELETE_OPERATION = "pms.room_facts.safe_delete";
const MANAGE_PERMISSION = "pms.operations.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPECTED_INBOUND_FOREIGN_KEYS = new Set([
  "pms.rooms:fk_pms_rooms_room_type_property:pms.room_types",
  "pms.rate_plans:fk_pms_rate_plans_room_type_property:pms.room_types",
  "pms.rate_rules:fk_pms_rate_rules_room_type_property:pms.room_types",
  "pms.inventory_days:fk_pms_inventory_days_room_type_property:pms.room_types",
  "pms.room_blocks:fk_pms_room_blocks_room_type_property:pms.room_types",
  "pms.operational_booking_assignments:fk_pms_operational_assignments_room_type_property:pms.room_types",
  "pms.channel_room_type_mappings:fk_pms_channel_room_mappings_room_type_property:pms.room_types",
  "pms.channel_rate_plan_mappings:fk_pms_channel_rate_mappings_room_type_property:pms.room_types",
  "pms.room_type_media:fk_pms_room_type_media_room_property:pms.room_types",
  "pms.room_blocks:fk_pms_room_blocks_room_property:pms.rooms",
  "pms.operational_booking_assignments:fk_pms_operational_assignments_room_property:pms.rooms",
]);

const ROOM_FACTS_RETURNING = `
  property_id::text AS "propertyId",
  id::text AS "roomTypeId",
  room_facts_revision AS "roomFactsRevision",
  active,
  name,
  description,
  category,
  occupancy_limits AS "occupancyLimits",
  room_attributes AS "roomAttributes",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const CREATE_SPEC: CommandSpec<CreateRoomTypeFactsCommand, CreateRoomTypeFactsResult> = {
  operation: CREATE_OPERATION,
  serializeFingerprint: serializeCreateRoomTypeFactsFingerprint,
  parseResult: parseCreateRoomTypeFactsResult,
  scopeFailure: () => createFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => createFailure({ code }),
};

const UPDATE_SPEC: CommandSpec<UpdateRoomTypeFactsCommand, UpdateRoomTypeFactsResult> = {
  operation: UPDATE_OPERATION,
  serializeFingerprint: serializeUpdateRoomTypeFactsFingerprint,
  parseResult: parseUpdateRoomTypeFactsResult,
  scopeFailure: () => updateFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => updateFailure({ code }),
};

const SAFE_DELETE_SPEC: CommandSpec<SafeDeleteRoomTypeCommand, SafeDeleteRoomTypeResult> = {
  operation: SAFE_DELETE_OPERATION,
  serializeFingerprint: serializeSafeDeleteRoomTypeFingerprint,
  parseResult: parseSafeDeleteRoomTypeResult,
  scopeFailure: () => safeDeleteFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => safeDeleteFailure({ code }),
};

export function createPgPmsRoomFactsCommandRepository(
  config: PmsRoomFactsCommandRepositoryConfig,
): PmsRoomFactsCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS room facts command repository connectionString must not be empty");
  }
  if (!config.vocabularyValidator) {
    throw new Error("PMS room facts command repository requires a vocabulary validator");
  }
  const ownsPool = !config.pool;
  const pool: PmsRoomFactsCommandPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());
  const makeId = config.randomId ?? randomUUID;
  let closed = false;

  async function runCommand<C extends AnyCommand, R extends AnyResult>(
    command: C,
    spec: CommandSpec<C, R>,
    work: (client: PmsRoomFactsCommandClient, acceptedAt: Date) => Promise<CommandWorkResult<R>>,
  ): Promise<R> {
    const acceptedAt = now();
    if (!validDate(acceptedAt)) throw new Error("PMS room facts command clock is invalid");
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = sha256(spec.serializeFingerprint(command));
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
        await rollbackQuietly(client);
        return spec.scopeFailure();
      }
      await lockPmsRoomFactsMutationScope(client, command.propertyId);

      const replay = await findReplay(client, command, spec, keyHash, fingerprint, acceptedAt);
      if (replay) {
        await rollbackQuietly(client);
        return replay;
      }
      const reservation = await reserveIdempotency(
        client,
        command,
        spec.operation,
        keyHash,
        fingerprint,
        acceptedAt,
      );
      if (!reservation) {
        const concurrentReplay = await findReplay(
          client,
          command,
          spec,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        await rollbackQuietly(client);
        return concurrentReplay ?? spec.coordinationFailure("command_in_progress");
      }

      const worked = await work(client, acceptedAt);
      const parsed = spec.parseResult(worked.result);
      if (!parsed) throw new Error("PMS room facts command produced an invalid contract result");
      if (!worked.finalize) {
        await rollbackQuietly(client);
        return parsed;
      }

      await recordAudit(client, command, spec.operation, reservation, keyHash, parsed, acceptedAt);
      await completeIdempotency(client, reservation.id, spec.operation, parsed, acceptedAt);
      await client.query("COMMIT");
      return parsed;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async createRoomTypeFacts(command) {
      return runCommand(command, CREATE_SPEC, async (client, acceptedAt) => {
        const binding = await lockDraftBinding(client, command.propertyId, command.draftRoomId);
        if (binding) {
          return finalized(
            createFailure({
              code: "draft_room_binding_conflict",
              roomTypeId: binding.roomTypeId,
              currentRevision: positiveDatabaseInteger(binding.currentRevision),
            }),
          );
        }

        const vocabulary = await config.vocabularyValidator.validateRoomFactsVocabulary({
          category: command.facts.category,
          bedTypeKeys: command.facts.beds.map(({ type }) => type),
        });
        if (!vocabulary.ok) return finalized(createFailure(vocabulary.error));

        if (await activeNameExists(client, command.propertyId, command.facts.name)) {
          return finalized(createFailure({ code: "room_type_name_conflict" }));
        }

        const roomTypeId = makeId().toLowerCase();
        if (!UUID_PATTERN.test(roomTypeId)) {
          throw new Error("PMS room facts command ID generator returned an invalid UUID");
        }
        const inserted = await insertRoomType(
          client,
          command.propertyId,
          roomTypeId,
          command.draftRoomId,
          command.facts,
          acceptedAt,
        );
        if (inserted.conflict === "name") {
          return finalized(createFailure({ code: "room_type_name_conflict" }));
        }
        if (inserted.conflict === "binding") {
          const concurrentBinding = await lockDraftBinding(
            client,
            command.propertyId,
            command.draftRoomId,
          );
          if (!concurrentBinding) {
            throw new Error("PMS room facts binding conflict could not be recovered");
          }
          return finalized(
            createFailure({
              code: "draft_room_binding_conflict",
              roomTypeId: concurrentBinding.roomTypeId,
              currentRevision: positiveDatabaseInteger(concurrentBinding.currentRevision),
            }),
          );
        }
        if (!inserted.row) throw new Error("PMS room facts create returned no canonical row");

        const snapshot = pmsRoomFactsSnapshotFromRow(inserted.row);
        if (
          snapshot.propertyId !== command.propertyId ||
          snapshot.roomTypeId !== roomTypeId ||
          snapshot.roomFactsRevision !== 1 ||
          snapshot.lifecycle !== "active"
        ) {
          throw new Error("PMS room facts create violated canonical snapshot invariants");
        }
        return finalized({
          ok: true,
          response: {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            outcome: "created",
            roomType: snapshot,
            draftRoomBinding: {
              propertyId: command.propertyId,
              draftRoomId: command.draftRoomId,
              roomTypeId,
            },
            acceptedAt: acceptedAt.toISOString(),
          },
        });
      });
    },

    async updateRoomTypeFacts(command) {
      return runCommand(command, UPDATE_SPEC, async (client, acceptedAt) => {
        const current = await lockActiveRoomType(client, command.propertyId, command.roomTypeId);
        if (!current) return finalized(updateFailure({ code: "room_type_not_found" }));
        const currentRevision = positiveDatabaseInteger(current.roomFactsRevision);
        if (currentRevision !== command.expectedRevision) {
          return finalized(
            updateFailure({ code: "room_facts_revision_conflict", currentRevision }),
          );
        }

        const vocabulary = await config.vocabularyValidator.validateRoomFactsVocabulary({
          category: command.facts.category,
          bedTypeKeys: command.facts.beds.map(({ type }) => type),
        });
        if (!vocabulary.ok) return finalized(updateFailure(vocabulary.error));

        if (
          await activeNameExists(client, command.propertyId, command.facts.name, command.roomTypeId)
        ) {
          return finalized(updateFailure({ code: "room_type_name_conflict" }));
        }
        const updated = await updateRoomType(
          client,
          command.propertyId,
          command.roomTypeId,
          command.expectedRevision,
          command.facts,
          acceptedAt,
        );
        if (updated.conflict === "name") {
          return finalized(updateFailure({ code: "room_type_name_conflict" }));
        }
        if (!updated.row) throw new Error("PMS room facts update returned no canonical row");
        const snapshot = pmsRoomFactsSnapshotFromRow(updated.row);
        if (
          snapshot.propertyId !== command.propertyId ||
          snapshot.roomTypeId !== command.roomTypeId ||
          snapshot.roomFactsRevision !== command.expectedRevision + 1 ||
          snapshot.lifecycle !== "active"
        ) {
          throw new Error("PMS room facts update violated canonical snapshot invariants");
        }
        return finalized({
          ok: true,
          response: {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            outcome: "updated",
            roomType: snapshot,
            acceptedAt: acceptedAt.toISOString(),
          },
        });
      });
    },

    async safeDeleteRoomType(command) {
      return runCommand(command, SAFE_DELETE_SPEC, async (client, acceptedAt) => {
        const current = await lockActiveRoomType(client, command.propertyId, command.roomTypeId);
        if (!current) return finalized(safeDeleteFailure({ code: "room_type_not_found" }));
        const currentRevision = positiveDatabaseInteger(current.roomFactsRevision);
        if (currentRevision !== command.expectedRevision) {
          return finalized(
            safeDeleteFailure({ code: "room_facts_revision_conflict", currentRevision }),
          );
        }

        let blockers: readonly RoomTypeDeleteBlocker[];
        try {
          blockers = await inspectDeleteReferences(
            client,
            command.propertyId,
            command.roomTypeId,
            acceptedAt,
          );
        } catch (error) {
          if (!isDatabaseOperationalError(error)) throw error;
          return rolledBack(
            safeDeleteFailure({
              code: "room_type_delete_blocked",
              currentRevision,
              blockers: [{ code: "reference_check_unavailable" }],
            }),
          );
        }
        if (blockers.some(({ code }) => code === "reference_check_unavailable")) {
          return rolledBack(
            safeDeleteFailure({
              code: "room_type_delete_blocked",
              currentRevision,
              blockers,
            }),
          );
        }
        if (blockers.length > 0) {
          return finalized(
            safeDeleteFailure({
              code: "room_type_delete_blocked",
              currentRevision,
              blockers,
            }),
          );
        }

        const media = await client.query(
          `DELETE FROM pms.room_type_media
           WHERE property_id = $1::uuid
             AND room_type_id = $2::uuid`,
          [command.propertyId, command.roomTypeId],
        );
        const retired = await client.query(
          `UPDATE pms.rooms room
           SET status = 'retired',
               updated_at = $3::timestamptz
           WHERE room.property_id = $1::uuid
             AND room.room_type_id = $2::uuid
             AND room.status <> 'retired'
             AND room.operational_label_status = 'unverified'
             AND NOT EXISTS (
               SELECT 1
               FROM pms.operational_booking_assignments assignment
               WHERE assignment.property_id = room.property_id
                 AND assignment.room_type_id = room.room_type_id
                 AND assignment.room_id = room.id
             )`,
          [command.propertyId, command.roomTypeId, acceptedAt.toISOString()],
        );
        const deactivated = await client.query<{ deletedRevision: number | string }>(
          `UPDATE pms.room_types
           SET active = FALSE,
               room_facts_revision = room_facts_revision + 1,
               room_media_revision = room_media_revision + $4::integer,
               room_units_revision = room_units_revision + $5::integer,
               updated_at = $3::timestamptz
           WHERE property_id = $1::uuid
             AND id = $2::uuid
             AND active
             AND room_facts_revision = $6
           RETURNING room_facts_revision AS "deletedRevision"`,
          [
            command.propertyId,
            command.roomTypeId,
            acceptedAt.toISOString(),
            (media.rowCount ?? 0) > 0 ? 1 : 0,
            (retired.rowCount ?? 0) > 0 ? 1 : 0,
            command.expectedRevision,
          ],
        );
        const deletedRevision = positiveDatabaseInteger(deactivated.rows[0]?.deletedRevision ?? 0);
        if (deactivated.rowCount !== 1 || deletedRevision !== command.expectedRevision + 1) {
          throw new Error("PMS room facts safe delete lost its locked revision");
        }
        return finalized({
          ok: true,
          response: {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            outcome: "deleted",
            propertyId: command.propertyId,
            roomTypeId: command.roomTypeId,
            lifecycle: "inactive",
            deletedRevision,
            acceptedAt: acceptedAt.toISOString(),
          },
        });
      });
    },

    async close() {
      if (!ownsPool || closed) return;
      await pool.end();
      closed = true;
    },
  };
}

async function lockAuthorizedScope(
  client: PmsRoomFactsCommandClient,
  command: AnyCommand,
  at: Date,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const scope = await client.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator', 'front_desk')
      AND resource.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid
      AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $4
     WHERE property.id = $2::uuid
     FOR SHARE OF property, organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [command.organizationId, command.propertyId, command.audit.actor.userId, MANAGE_PERMISSION],
  );
  if ((scope.rowCount ?? 0) < 1) return false;

  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT
       status,
       starts_at AS "startsAt",
       expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = 'pms'
       AND entitlement_key = 'property-management'
       AND (
         resource_product IS NULL
         OR (
           resource_product = 'pms'
           AND resource_type = 'pms_property'
           AND resource_id = $2::uuid::text
         )
       )
     FOR SHARE`,
    [command.organizationId, command.propertyId],
  );
  const applicable = entitlements.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= at) &&
      (!row.expiresAt || new Date(row.expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function findReplay<C extends AnyCommand, R extends AnyResult>(
  client: PmsRoomFactsCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<R | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT
       id::text AS id,
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       response_status_code AS "responseStatusCode",
       response_body_hash AS "responseBodyHash",
       idempotency_metadata AS "idempotencyMetadata",
       expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [spec.operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") {
    return spec.coordinationFailure("command_in_progress");
  }
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = spec.parseResult(stored);
  if (!parsed) return spec.coordinationFailure("idempotency_key_conflict");
  if (
    existing.responseStatusCode !== idempotencyResponseStatus(spec.operation, parsed) ||
    existing.responseBodyHash !== sha256(stableJson(idempotencyResponseBody(parsed)))
  ) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsRoomFactsCommandClient,
  command: AnyCommand,
  operation: string,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       tenant_scope,
       organization_id,
       property_id,
       correlation_id,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'property',
       NULL,
       $4::uuid,
       $5,
       $6::timestamptz,
       $6::timestamptz,
       $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress',
       response_status_code = NULL,
       response_body_hash = NULL,
       response_resource_product = NULL,
       response_resource_type = NULL,
       response_resource_id = NULL,
       correlation_id = EXCLUDED.correlation_id,
       first_seen_at = EXCLUDED.first_seen_at,
       last_seen_at = EXCLUDED.last_seen_at,
       locked_until = NULL,
       completed_at = NULL,
       expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt',
         COALESCE((idempotency_keys.idempotency_metadata ->> 'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING
       id::text AS id,
       (idempotency_metadata ->> 'attempt')::integer AS attempt`,
    [
      operation,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsRoomFactsCommandClient,
  id: string,
  operation: string,
  result: AnyResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = $2,
         response_body_hash = $3,
         completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz,
         idempotency_metadata =
           idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid
       AND status = 'in_progress'`,
    [
      id,
      idempotencyResponseStatus(operation, result),
      sha256(stableJson(idempotencyResponseBody(result))),
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("PMS room facts idempotency completion failed");
  }
}

async function lockDraftBinding(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  draftRoomId: string,
): Promise<DraftBindingRow | null> {
  const result = await client.query<DraftBindingRow>(
    `SELECT
       id::text AS "roomTypeId",
       room_facts_revision AS "currentRevision"
     FROM pms.room_types
     WHERE property_id = $1::uuid
       AND setup_draft_room_id = $2
     FOR UPDATE`,
    [propertyId, draftRoomId],
  );
  if (result.rows.length > 1) throw new Error("PMS draft-room binding is not unique");
  return result.rows[0] ?? null;
}

async function lockActiveRoomType(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<LockedRoomTypeRow | null> {
  const result = await client.query<LockedRoomTypeRow>(
    `SELECT ${ROOM_FACTS_RETURNING}
     FROM pms.room_types
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND active
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
  if (result.rows.length > 1) throw new Error("PMS room facts lock returned duplicate rows");
  return result.rows[0] ?? null;
}

async function activeNameExists(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  name: string,
  excludingRoomTypeId?: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM pms.room_types
     WHERE property_id = $1::uuid
       AND active
       AND lower(name) = lower($2)
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     FOR KEY SHARE`,
    [propertyId, name, excludingRoomTypeId ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertRoomType(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  roomTypeId: string,
  draftRoomId: string,
  facts: RoomTypeFacts,
  at: Date,
): Promise<{ row?: PmsRoomFactsRow; conflict?: "name" | "binding" }> {
  await client.query("SAVEPOINT pms_room_facts_write");
  try {
    const result = await client.query<PmsRoomFactsRow>(
      `INSERT INTO pms.room_types (
         id,
         property_id,
         source_system,
         source_room_type_id,
         name,
         description,
         category,
         occupancy_limits,
         room_attributes,
         base_rate_amount,
         currency,
         active,
         setup_draft_room_id,
         room_facts_revision,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'pms',
         NULL,
         $3,
         $4,
         $5,
         $6::jsonb,
         $7::jsonb,
         NULL,
         NULL,
         TRUE,
         $8,
         1,
         $9::timestamptz,
         $9::timestamptz
       )
       RETURNING ${ROOM_FACTS_RETURNING}`,
      [
        roomTypeId,
        propertyId,
        facts.name,
        facts.description,
        facts.category,
        JSON.stringify(occupancyPayload(facts)),
        JSON.stringify(roomAttributesPayload(facts)),
        draftRoomId,
        at.toISOString(),
      ],
    );
    await client.query("RELEASE SAVEPOINT pms_room_facts_write");
    return { row: result.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT pms_room_facts_write");
    await client.query("RELEASE SAVEPOINT pms_room_facts_write");
    if (isPgConstraint(error, "23505", "uq_pms_room_types_property_name_ci")) {
      return { conflict: "name" };
    }
    if (isPgConstraint(error, "23505", "uq_pms_room_types_property_setup_draft_room")) {
      return { conflict: "binding" };
    }
    throw error;
  }
}

async function updateRoomType(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  roomTypeId: string,
  expectedRevision: number,
  facts: RoomTypeFacts,
  at: Date,
): Promise<{ row?: PmsRoomFactsRow; conflict?: "name" }> {
  await client.query("SAVEPOINT pms_room_facts_write");
  try {
    const result = await client.query<PmsRoomFactsRow>(
      `UPDATE pms.room_types
       SET name = $4,
           description = $5,
           category = $6,
           occupancy_limits = occupancy_limits || $7::jsonb,
           room_attributes = room_attributes || $8::jsonb,
           room_facts_revision = room_facts_revision + 1,
           updated_at = $9::timestamptz
       WHERE property_id = $1::uuid
         AND id = $2::uuid
         AND active
         AND room_facts_revision = $3
       RETURNING ${ROOM_FACTS_RETURNING}`,
      [
        propertyId,
        roomTypeId,
        expectedRevision,
        facts.name,
        facts.description,
        facts.category,
        JSON.stringify(occupancyPayload(facts)),
        JSON.stringify(roomAttributesPayload(facts)),
        at.toISOString(),
      ],
    );
    await client.query("RELEASE SAVEPOINT pms_room_facts_write");
    return { row: result.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT pms_room_facts_write");
    await client.query("RELEASE SAVEPOINT pms_room_facts_write");
    if (isPgConstraint(error, "23505", "uq_pms_room_types_property_name_ci")) {
      return { conflict: "name" };
    }
    throw error;
  }
}

function occupancyPayload(facts: RoomTypeFacts): Record<string, number> {
  return {
    total: facts.occupancy.maxGuests,
    adults: facts.occupancy.maxAdults,
    children: facts.occupancy.maxChildren,
  };
}

function roomAttributesPayload(facts: RoomTypeFacts): Record<string, unknown> {
  return {
    beds: facts.beds,
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    bathroomType: facts.bathroomType,
    size: facts.size,
  };
}

async function inspectDeleteReferences(
  client: PmsRoomFactsCommandClient,
  propertyId: string,
  roomTypeId: string,
  acceptedAt: Date,
): Promise<readonly RoomTypeDeleteBlocker[]> {
  if (!(await hasExpectedInboundForeignKeys(client))) {
    return [{ code: "reference_check_unavailable" }];
  }

  // Safe delete is rare and correctness-sensitive. Locking all known reference
  // tables prevents a JSON-only or indirect reference from appearing between
  // the scan and the tombstone transition. Bound both lock acquisition and the
  // reference scan so contention fails closed instead of stalling shared
  // Booking, Distribution, PMS, or platform writers.
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query(
    `LOCK TABLE
       booking.booking_publication_attempts,
       booking.guest_bookings,
       booking.quote_sessions,
       distribution.active_public_booking_revision,
       distribution.public_booking_content_revisions,
       distribution.public_room_offer_snapshots,
       pms.channel_rate_plan_mappings,
       pms.channel_room_type_mappings,
       pms.inventory_days,
       pms.operational_booking_assignments,
       pms.rate_plans,
       pms.rate_rules,
       pms.room_blocks,
       pms.room_type_media,
       pms.rooms,
       platform.jobs,
       platform.outbox_events
     IN SHARE ROW EXCLUSIVE MODE`,
  );

  const result = await client.query<DeleteReferenceCountsRow>(
    `SELECT
       (
         (SELECT count(*)
          FROM distribution.public_room_offer_snapshots offer
          WHERE offer.property_id = $1::uuid
            AND offer.room_type_id = $2::uuid)
         +
         (SELECT count(*)
          FROM distribution.public_booking_content_revisions revision
          WHERE revision.property_id = $1::uuid
            AND (
              EXISTS (
                SELECT 1
                FROM distribution.active_public_booking_revision active
                WHERE active.property_id = revision.property_id
                  AND active.content_revision_id = revision.id
              )
              OR EXISTS (
                SELECT 1
                FROM booking.booking_publication_attempts publication
                WHERE publication.property_id = revision.property_id
                  AND publication.result_content_revision_id = revision.id
                  AND publication.status = 'succeeded'
              )
            )
            AND (
              jsonb_path_exists(
                revision.source_manifest,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
              OR jsonb_path_exists(
                revision.public_content,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
            ))
       )::bigint AS "publishedReferenceCount",
       (
         (SELECT count(*)
          FROM pms.operational_booking_assignments assignment
          WHERE assignment.property_id = $1::uuid
            AND assignment.room_type_id = $2::uuid)
         +
         (SELECT count(*)
          FROM booking.quote_sessions quote
          WHERE quote.property_id = $1::uuid
            AND (
              (quote.status = 'active' AND quote.expires_at > $3::timestamptz)
              OR quote.status = 'converted'
            )
            AND jsonb_path_exists(
              quote.selected_offer_snapshot,
              'strict $.** ? (@ == $roomTypeId)',
              jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
            ))
         +
         (SELECT count(*)
          FROM booking.guest_bookings booking
          WHERE booking.property_id = $1::uuid
            AND jsonb_path_exists(
              booking.booking_metadata,
              'strict $.** ? (@ == $roomTypeId)',
              jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
            ))
         +
         (SELECT count(*)
          FROM booking.booking_publication_attempts publication
          WHERE publication.property_id = $1::uuid
            AND publication.status IN ('pending', 'unknown')
            AND jsonb_path_exists(
              publication.source_manifest,
              'strict $.** ? (@ == $roomTypeId)',
              jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
            ))
       )::bigint AS "bookingReferenceCount",
       (SELECT count(DISTINCT room.id)
        FROM pms.rooms room
        JOIN pms.operational_booking_assignments assignment
          ON assignment.property_id = room.property_id
         AND assignment.room_type_id = room.room_type_id
         AND assignment.room_id = room.id
        WHERE room.property_id = $1::uuid
          AND room.room_type_id = $2::uuid)::bigint AS "assignedPhysicalUnitCount",
       (SELECT count(*)
        FROM pms.rooms room
        WHERE room.property_id = $1::uuid
          AND room.room_type_id = $2::uuid
          AND room.operational_label_status = 'verified')::bigint
         AS "verifiedPhysicalUnitCount",
       (
         (SELECT count(*) FROM pms.rate_plans rate_plan
          WHERE rate_plan.property_id = $1::uuid AND rate_plan.room_type_id = $2::uuid)
         +
         (SELECT count(*) FROM pms.rate_rules rate_rule
          WHERE rate_rule.property_id = $1::uuid AND rate_rule.room_type_id = $2::uuid)
       )::bigint AS "rateReferenceCount",
       (SELECT count(*) FROM pms.inventory_days inventory
        WHERE inventory.property_id = $1::uuid AND inventory.room_type_id = $2::uuid)::bigint
         AS "calendarReferenceCount",
       (SELECT count(*) FROM pms.room_blocks block
        WHERE block.property_id = $1::uuid AND block.room_type_id = $2::uuid)::bigint
         AS "roomBlockReferenceCount",
       (
         (SELECT count(*) FROM pms.channel_room_type_mappings mapping
          WHERE mapping.property_id = $1::uuid AND mapping.room_type_id = $2::uuid)
         +
         (SELECT count(*) FROM pms.channel_rate_plan_mappings mapping
          WHERE mapping.property_id = $1::uuid AND mapping.room_type_id = $2::uuid)
       )::bigint AS "channelReferenceCount",
       (
         (SELECT count(*)
          FROM platform.outbox_events outbox
          WHERE outbox.property_id = $1::uuid
            AND (
              outbox.status IN ('pending', 'leased')
              OR (outbox.status = 'failed' AND outbox.attempts_count < outbox.max_attempts)
            )
            AND (
              (
                outbox.resource_product = 'pms'
                AND outbox.resource_type = 'room_type'
                AND outbox.resource_id = $2::uuid::text
              )
              OR jsonb_path_exists(
                outbox.payload,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
              OR jsonb_path_exists(
                outbox.outbox_metadata,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
            ))
         +
         (SELECT count(*)
          FROM platform.jobs job
          WHERE job.property_id = $1::uuid
            AND (
              job.status IN ('pending', 'running')
              OR (job.status = 'failed' AND job.attempts_count < job.max_attempts)
            )
            AND (
              (
                job.resource_product = 'pms'
                AND job.resource_type = 'room_type'
                AND job.resource_id = $2::uuid::text
              )
              OR jsonb_path_exists(
                job.payload,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
              OR jsonb_path_exists(
                job.job_metadata,
                'strict $.** ? (@ == $roomTypeId)',
                jsonb_build_object('roomTypeId', to_jsonb($2::uuid::text))
              )
            ))
       )::bigint AS "otherOperationalReferenceCount"`,
    [propertyId, roomTypeId, acceptedAt.toISOString()],
  );
  if (result.rows.length !== 1) {
    throw new Error("PMS room facts delete reference scan returned an invalid row count");
  }
  return deleteBlockersFromCounts(result.rows[0]!);
}

async function hasExpectedInboundForeignKeys(client: PmsRoomFactsCommandClient): Promise<boolean> {
  const result = await client.query<InboundForeignKeyRow>(
    `SELECT
       source_namespace.nspname AS "sourceSchema",
       source_table.relname AS "sourceTable",
       constraint_row.conname AS "constraintName",
       referenced_namespace.nspname || '.' || referenced_table.relname AS "referencedTable"
     FROM pg_catalog.pg_constraint constraint_row
     JOIN pg_catalog.pg_class source_table
       ON source_table.oid = constraint_row.conrelid
     JOIN pg_catalog.pg_namespace source_namespace
       ON source_namespace.oid = source_table.relnamespace
     JOIN pg_catalog.pg_class referenced_table
       ON referenced_table.oid = constraint_row.confrelid
     JOIN pg_catalog.pg_namespace referenced_namespace
       ON referenced_namespace.oid = referenced_table.relnamespace
     WHERE constraint_row.contype = 'f'
       AND constraint_row.confrelid IN ('pms.room_types'::regclass, 'pms.rooms'::regclass)
     ORDER BY source_namespace.nspname, source_table.relname, constraint_row.conname`,
  );
  const actual = new Set(
    result.rows.map(
      (row) =>
        `${row.sourceSchema}.${row.sourceTable}:${row.constraintName}:${row.referencedTable}`,
    ),
  );
  return setsEqual(actual, EXPECTED_INBOUND_FOREIGN_KEYS);
}

function deleteBlockersFromCounts(row: DeleteReferenceCountsRow): readonly RoomTypeDeleteBlocker[] {
  const values: readonly [
    Exclude<RoomTypeDeleteBlocker["code"], "reference_check_unavailable">,
    number | string,
  ][] = [
    ["published_reference", row.publishedReferenceCount],
    ["booking_reference", row.bookingReferenceCount],
    ["assigned_physical_unit", row.assignedPhysicalUnitCount],
    ["verified_physical_unit", row.verifiedPhysicalUnitCount],
    ["rate_plan_or_rule", row.rateReferenceCount],
    ["calendar_or_inventory", row.calendarReferenceCount],
    ["room_block", row.roomBlockReferenceCount],
    ["channel_mapping", row.channelReferenceCount],
    ["other_operational_reference", row.otherOperationalReferenceCount],
  ];
  return Object.freeze(
    values.flatMap(([code, rawCount]) => {
      const affectedCount = nonNegativeDatabaseInteger(rawCount);
      return affectedCount > 0 ? [{ code, affectedCount } as const] : [];
    }),
  );
}

async function recordAudit(
  client: PmsRoomFactsCommandClient,
  command: AnyCommand,
  operation: string,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: AnyResult,
  at: Date,
): Promise<void> {
  if (command.audit.actor.kind !== "user") {
    throw new Error("PMS room facts audit requires a user actor");
  }
  const targetId = commandTargetId(command, result);
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       idempotency_key_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       $3::timestamptz,
       'property',
       NULL,
       $4::uuid,
       'user',
       $5::uuid,
       'pms',
       'room_type',
       $6,
       $7::uuid,
       $8,
       $9,
       $10::jsonb,
       '{}'::jsonb,
       $11::jsonb,
       'confidential'
     )`,
    [
      `pms.room_facts.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      operation,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      targetId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(redactedAuditPayload(command, result)),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
      }),
    ],
  );
}

function redactedAuditPayload(command: AnyCommand, result: AnyResult): Record<string, unknown> {
  const target =
    "roomTypeId" in command
      ? { roomTypeId: command.roomTypeId }
      : { draftRoomId: command.draftRoomId, roomTypeId: commandTargetId(command, result) };
  if (result.ok) {
    const revision =
      result.response.outcome === "deleted"
        ? result.response.deletedRevision
        : result.response.roomType.roomFactsRevision;
    return {
      ...target,
      expectedRevision: command.expectedRevision,
      outcome: result.response.outcome,
      resultingRevision: revision,
    };
  }
  const error = result.error;
  const payload: Record<string, unknown> = {
    ...target,
    expectedRevision: command.expectedRevision,
    outcome: error.code,
  };
  if ("currentRevision" in error) payload["currentRevision"] = error.currentRevision;
  if (error.code === "room_type_delete_blocked") {
    payload["blockers"] = error.blockers.map((blocker) =>
      "affectedCount" in blocker
        ? { code: blocker.code, affectedCount: blocker.affectedCount }
        : { code: blocker.code },
    );
  }
  return payload;
}

function commandTargetId(command: AnyCommand, result: AnyResult): string {
  if (result.ok) {
    return result.response.outcome === "deleted"
      ? result.response.roomTypeId
      : result.response.roomType.roomTypeId;
  }
  if ("roomTypeId" in result.error) return result.error.roomTypeId;
  if ("roomTypeId" in command) return command.roomTypeId;
  return `${command.propertyId}:${command.draftRoomId}`;
}

function idempotencyResponseBody(result: AnyResult): unknown {
  return result.ok ? result.response : result.error;
}

function idempotencyResponseStatus(operation: string, result: AnyResult): number {
  if (result.ok) return operation === CREATE_OPERATION ? 201 : 200;
  if (
    result.error.code === "setup_scope_unavailable" ||
    result.error.code === "room_type_not_found"
  ) {
    return 404;
  }
  if (result.error.code === "unsupported_room_fact_keys") return 422;
  return 409;
}

function createFailure(error: CreateRoomTypeFactsError): CreateRoomTypeFactsResult {
  return { ok: false, error };
}

function updateFailure(error: UpdateRoomTypeFactsError): UpdateRoomTypeFactsResult {
  return { ok: false, error };
}

function safeDeleteFailure(error: SafeDeleteRoomTypeError): SafeDeleteRoomTypeResult {
  return { ok: false, error };
}

function finalized<R extends AnyResult>(result: R): CommandWorkResult<R> {
  return { result, finalize: true };
}

function rolledBack<R extends AnyResult>(result: R): CommandWorkResult<R> {
  return { result, finalize: false };
}

function positiveDatabaseInteger(value: number | string): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("PMS room facts database revision is invalid");
  }
  return parsed;
}

function nonNegativeDatabaseInteger(value: number | string): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PMS room facts database reference count is invalid");
  }
  return parsed;
}

function databaseInteger(value: number | string): number {
  if (typeof value === "number") return value;
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function isPgConstraint(error: unknown, code: string, constraint: string): boolean {
  return isRecord(error) && error["code"] === code && error["constraint"] === constraint;
}

function isDatabaseOperationalError(error: unknown): boolean {
  if (!isRecord(error) || typeof error["code"] !== "string") return false;
  return (
    /^[0-9A-Z]{5}$/.test(error["code"]) ||
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT"].includes(
      error["code"],
    )
  );
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function rollbackQuietly(client: PmsRoomFactsCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
