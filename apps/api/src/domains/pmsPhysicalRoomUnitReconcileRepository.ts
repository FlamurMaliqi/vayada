import { createHash } from "node:crypto";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseReconcilePhysicalRoomUnitsResult,
  serializeReconcilePhysicalRoomUnitsFingerprint,
  type PhysicalRoomUnitIdentity,
  type PhysicalRoomUnitReconcileBlocker,
  type PhysicalRoomUnitReconcilePort,
  type ReconcilePhysicalRoomUnitsCommand,
  type ReconcilePhysicalRoomUnitsResult,
  type RoomTypeCapacitySnapshot,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";

const OPERATION = "pms.physical_room_units.reconcile";

export type PmsPhysicalRoomUnitReconcileClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsPhysicalRoomUnitReconcilePool = {
  connect(): Promise<PmsPhysicalRoomUnitReconcileClient>;
  end(): Promise<void>;
};

type RoomTypeRow = { roomUnitsRevision: number };
type UnitRow = {
  roomUnitId: string;
  status: "available" | "maintenance" | "out_of_order";
  operationalLabel: string | null;
  operationalLabelStatus: "unverified" | "verified";
  hasReservationAssignment: boolean;
  hasRoomBlock: boolean;
};
type UnitProtectionRow = Pick<UnitRow, "roomUnitId" | "hasReservationAssignment" | "hasRoomBlock">;
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: unknown;
};

export function createPgPmsPhysicalRoomUnitReconcileRepository(config: {
  connectionString?: string;
  max?: number;
  now?: () => Date;
  pool?: PmsPhysicalRoomUnitReconcilePool;
}): PhysicalRoomUnitReconcilePort & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS physical-unit reconcile connectionString must not be empty");
  }
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PmsPhysicalRoomUnitReconcilePool);
  const now = config.now ?? (() => new Date());

  return {
    async reconcilePhysicalRoomUnits(command) {
      return executeReconcile(pool, command, now());
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function executeReconcile(
  pool: PmsPhysicalRoomUnitReconcilePool,
  command: ReconcilePhysicalRoomUnitsCommand,
  occurredAt: Date,
): Promise<ReconcilePhysicalRoomUnitsResult> {
  const client = await pool.connect();
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(serializeReconcilePhysicalRoomUnitsFingerprint(command));
  try {
    await client.query("BEGIN");
    if (!(await lockAuthorizedPmsPhysicalRoomScope(client, command, occurredAt))) {
      await client.query("ROLLBACK");
      return failure({ code: "setup_scope_unavailable" });
    }
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, command.roomTypeId);
    const roomType = await lockActiveRoomType(client, command);
    if (!roomType) {
      await client.query("ROLLBACK");
      return failure({ code: "room_type_not_found" });
    }

    const replay = await findReplay(client, command, keyHash, fingerprint);
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }
    const idempotencyId = await reserveIdempotency(
      client,
      command,
      keyHash,
      fingerprint,
      occurredAt,
    );
    if (!idempotencyId) {
      const concurrent = await findReplay(client, command, keyHash, fingerprint);
      await client.query("ROLLBACK");
      return concurrent ?? failure({ code: "command_in_progress" });
    }

    const result =
      command.expectedRevision === roomType.roomUnitsRevision
        ? await reconcileLockedRoomType(client, command, roomType, occurredAt)
        : failure({
            code: "room_units_revision_conflict",
            currentRevision: roomType.roomUnitsRevision,
          });
    await recordAudit(client, command, idempotencyId, keyHash, result, occurredAt);
    await completeIdempotency(client, idempotencyId, result, occurredAt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockAuthorizedPmsPhysicalRoomScope(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: Pick<ReconcilePhysicalRoomUnitsCommand, "organizationId" | "propertyId" | "audit">,
  occurredAt: Date,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const result = await client.query(
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
      AND permission_grant.permission_key = 'pms.operations.manage'
     WHERE property.id = $2::uuid
     FOR SHARE OF property, organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [command.organizationId, command.propertyId, command.audit.actor.userId],
  );
  if ((result.rowCount ?? 0) < 1) return false;

  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
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
    ({ startsAt, expiresAt }) =>
      (!startsAt || new Date(startsAt) <= occurredAt) &&
      (!expiresAt || new Date(expiresAt) > occurredAt),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function lockActiveRoomType(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
): Promise<RoomTypeRow | null> {
  const result = await client.query<RoomTypeRow>(
    `SELECT room_units_revision::integer AS "roomUnitsRevision"
     FROM pms.room_types
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND active
     FOR UPDATE`,
    [command.roomTypeId, command.propertyId],
  );
  return result.rows[0] ?? null;
}

async function reconcileLockedRoomType(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  roomType: RoomTypeRow,
  occurredAt: Date,
): Promise<ReconcilePhysicalRoomUnitsResult> {
  const units = await lockActiveUnits(client, command);
  const previousCount = units.length;
  if (previousCount > 500) {
    return failure({
      code: "physical_unit_capacity_invariant_violation",
      currentActiveUnitCount: previousCount,
    });
  }
  const delta = command.targetActiveUnitCount - previousCount;
  if (delta === 0) {
    return success(command, roomType.roomUnitsRevision, previousCount, [], [], occurredAt, false);
  }

  let addedUnits: PhysicalRoomUnitIdentity[] = [];
  let retiredUnitIds: string[] = [];
  if (delta > 0) {
    addedUnits = await insertUnits(client, command, delta);
  } else {
    const eligible = units
      .filter(isSafelyRetirable)
      .sort((left, right) => right.roomUnitId.localeCompare(left.roomUnitId));
    if (eligible.length < -delta) {
      return failure({
        code: "physical_unit_reconcile_blocked",
        currentRevision: roomType.roomUnitsRevision,
        currentActiveUnitCount: previousCount,
        targetActiveUnitCount: command.targetActiveUnitCount,
        safelyRemovableUnitCount: eligible.length,
        blockers: blockersFor(units),
      });
    }
    retiredUnitIds = eligible.slice(0, -delta).map(({ roomUnitId }) => roomUnitId);
    await retireUnits(client, command, retiredUnitIds);
  }

  const revision = await incrementUnitsRevision(client, command);
  const activeCount = await countActiveUnits(client, command);
  if (activeCount !== command.targetActiveUnitCount) {
    throw new Error("PMS physical-unit capacity invariant failed after reconciliation");
  }
  return success(command, revision, previousCount, addedUnits, retiredUnitIds, occurredAt, true);
}

async function lockActiveUnits(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
): Promise<UnitRow[]> {
  const result = await client.query<Omit<UnitRow, "hasReservationAssignment" | "hasRoomBlock">>(
    `SELECT
       room.id::text AS "roomUnitId",
       room.status,
       room.room_number AS "operationalLabel",
       room.operational_label_status AS "operationalLabelStatus"
     FROM pms.rooms room
     WHERE room.property_id = $1::uuid
       AND room.room_type_id = $2::uuid
       AND room.status <> 'retired'
     ORDER BY room.id
     FOR UPDATE OF room`,
    [command.propertyId, command.roomTypeId],
  );
  if (result.rows.length === 0) return [];

  // Run reference checks in a fresh READ COMMITTED statement after the room
  // locks. If assignment won the race, this statement observes its commit; if
  // reconcile won, assignment waits until reconciliation commits.
  const protection = await client.query<UnitProtectionRow>(
    `SELECT
       room.id::text AS "roomUnitId",
       EXISTS (
         SELECT 1
         FROM pms.operational_booking_assignments assignment
         WHERE assignment.property_id = room.property_id
           AND assignment.room_type_id = room.room_type_id
           AND assignment.room_id = room.id
       ) AS "hasReservationAssignment",
       EXISTS (
         SELECT 1
         FROM pms.room_blocks block
         WHERE block.property_id = room.property_id
           AND block.room_type_id = room.room_type_id
           AND block.room_id = room.id
       ) AS "hasRoomBlock"
     FROM pms.rooms room
     WHERE room.property_id = $1::uuid
       AND room.room_type_id = $2::uuid
       AND room.id = ANY($3::uuid[])`,
    [command.propertyId, command.roomTypeId, result.rows.map(({ roomUnitId }) => roomUnitId)],
  );
  const byId = new Map(protection.rows.map((row) => [row.roomUnitId, row]));
  return result.rows.map((row) => ({
    ...row,
    hasReservationAssignment: byId.get(row.roomUnitId)?.hasReservationAssignment ?? true,
    hasRoomBlock: byId.get(row.roomUnitId)?.hasRoomBlock ?? true,
  }));
}

function isSafelyRetirable(unit: UnitRow): boolean {
  return (
    unit.status === "available" &&
    unit.operationalLabelStatus === "unverified" &&
    !unit.hasReservationAssignment &&
    !unit.hasRoomBlock
  );
}

function blockersFor(units: UnitRow[]): readonly PhysicalRoomUnitReconcileBlocker[] {
  const counted: Array<readonly [PhysicalRoomUnitReconcileBlocker["code"], number]> = [
    [
      "verified_operational_label",
      units.filter(({ operationalLabelStatus }) => operationalLabelStatus === "verified").length,
    ],
    [
      "reservation_assignment",
      units.filter(({ hasReservationAssignment }) => hasReservationAssignment).length,
    ],
    ["room_block", units.filter(({ hasRoomBlock }) => hasRoomBlock).length],
    ["operational_status", units.filter(({ status }) => status !== "available").length],
  ];
  const blockers = counted
    .filter(
      (
        entry,
      ): entry is readonly [
        Exclude<PhysicalRoomUnitReconcileBlocker["code"], "reference_check_unavailable">,
        number,
      ] => entry[1] > 0,
    )
    .map(([code, affectedCount]) => Object.freeze({ code, affectedCount }));
  return blockers.length > 0
    ? Object.freeze(blockers)
    : Object.freeze([{ code: "reference_check_unavailable" as const }]);
}

async function insertUnits(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  count: number,
): Promise<PhysicalRoomUnitIdentity[]> {
  const result = await client.query<{ roomUnitId: string }>(
    `WITH room_order_seed AS (
       SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
       FROM pms.rooms
       WHERE property_id = $1::uuid AND status <> 'retired'
     ), inserted AS (
       INSERT INTO pms.rooms (
         property_id, room_type_id, source_system, room_number,
         operational_label_status, status, sort_order
       )
       SELECT $1::uuid, $2::uuid, 'pms', NULL, 'unverified', 'available',
              room_order_seed.max_sort_order + source.n
       FROM room_order_seed
       CROSS JOIN generate_series(1, $3::integer) AS source(n)
       RETURNING id
     )
     SELECT id::text AS "roomUnitId" FROM inserted ORDER BY id`,
    [command.propertyId, command.roomTypeId, count],
  );
  if (result.rows.length !== count) throw new Error("PMS physical-unit insert count mismatch");
  return result.rows.map(({ roomUnitId }) =>
    Object.freeze({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      roomUnitId,
      lifecycle: "active" as const,
      operationalLabel: null,
      operationalLabelStatus: "unverified" as const,
    }),
  );
}

async function retireUnits(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  roomUnitIds: string[],
): Promise<void> {
  const result = await client.query(
    `UPDATE pms.rooms
     SET status = 'retired', updated_at = now()
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
       AND id = ANY($3::uuid[])
       AND status = 'available'
       AND operational_label_status = 'unverified'
       AND NOT EXISTS (
         SELECT 1 FROM pms.operational_booking_assignments assignment
         WHERE assignment.property_id = pms.rooms.property_id
           AND assignment.room_type_id = pms.rooms.room_type_id
           AND assignment.room_id = pms.rooms.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM pms.room_blocks block
         WHERE block.property_id = pms.rooms.property_id
           AND block.room_type_id = pms.rooms.room_type_id
           AND block.room_id = pms.rooms.id
       )`,
    [command.propertyId, command.roomTypeId, roomUnitIds],
  );
  if (result.rowCount !== roomUnitIds.length) {
    throw new Error("PMS physical-unit retirement count mismatch");
  }
}

async function incrementUnitsRevision(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
): Promise<number> {
  const result = await client.query<{ roomUnitsRevision: number }>(
    `UPDATE pms.room_types
     SET room_units_revision = room_units_revision + 1
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND active
       AND room_units_revision = $3
     RETURNING room_units_revision::integer AS "roomUnitsRevision"`,
    [command.roomTypeId, command.propertyId, command.expectedRevision],
  );
  const revision = result.rows[0]?.roomUnitsRevision;
  if (revision !== command.expectedRevision + 1) {
    throw new Error("PMS room-unit revision compare-and-set failed under lock");
  }
  return revision;
}

async function countActiveUnits(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
): Promise<number> {
  const result = await client.query<{ activeUnitCount: number }>(
    `SELECT count(*)::integer AS "activeUnitCount"
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
       AND status <> 'retired'`,
    [command.propertyId, command.roomTypeId],
  );
  return result.rows[0]?.activeUnitCount ?? -1;
}

function success(
  command: ReconcilePhysicalRoomUnitsCommand,
  revision: number,
  previousActiveUnitCount: number,
  addedUnits: PhysicalRoomUnitIdentity[],
  retiredUnitIds: string[],
  occurredAt: Date,
  changed: boolean,
): ReconcilePhysicalRoomUnitsResult {
  const capacity: RoomTypeCapacitySnapshot = Object.freeze({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    roomUnitsRevision: revision,
    activeUnitCount: command.targetActiveUnitCount,
    capturedAt: occurredAt.toISOString(),
  });
  return validated({
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: changed ? "reconciled" : "unchanged",
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      previousActiveUnitCount,
      capacity,
      addedUnits,
      retiredUnitIds,
      acceptedAt: occurredAt.toISOString(),
    },
  });
}

function failure(
  error: Extract<ReconcilePhysicalRoomUnitsResult, { ok: false }>["error"],
): ReconcilePhysicalRoomUnitsResult {
  return validated({ ok: false, error });
}

function validated(value: ReconcilePhysicalRoomUnitsResult): ReconcilePhysicalRoomUnitsResult {
  const parsed = parseReconcilePhysicalRoomUnitsResult(value);
  if (!parsed) throw new Error("PMS physical-unit reconcile produced an invalid contract result");
  return parsed;
}

async function findReplay(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  keyHash: string,
  fingerprint: string,
): Promise<ReconcilePhysicalRoomUnitsResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT
       id::text,
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
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
  const replay = parseReconcilePhysicalRoomUnitsResult(metadata?.result);
  return replay && resultMatchesCommand(replay, command)
    ? replay
    : failure({ code: "idempotency_key_conflict" });
}

function resultMatchesCommand(
  result: ReconcilePhysicalRoomUnitsResult,
  command: ReconcilePhysicalRoomUnitsCommand,
): boolean {
  if (result.ok) {
    const expectedRevision =
      result.response.outcome === "reconciled"
        ? command.expectedRevision + 1
        : command.expectedRevision;
    return (
      result.response.propertyId === command.propertyId &&
      result.response.roomTypeId === command.roomTypeId &&
      result.response.capacity.activeUnitCount === command.targetActiveUnitCount &&
      result.response.capacity.roomUnitsRevision === expectedRevision
    );
  }
  if (result.error.code === "physical_unit_reconcile_blocked") {
    return (
      result.error.currentRevision === command.expectedRevision &&
      result.error.targetActiveUnitCount === command.targetActiveUnitCount
    );
  }
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

async function reserveIdempotency(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  keyHash: string,
  fingerprint: string,
  occurredAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       status, tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     )
     VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid,
       $5, $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours', $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id::text`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      occurredAt.toISOString(),
      JSON.stringify({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        authorizedOrganizationId: command.organizationId,
      }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function completeIdempotency(
  client: PmsPhysicalRoomUnitReconcileClient,
  idempotencyId: string,
  result: ReconcilePhysicalRoomUnitsResult,
  occurredAt: Date,
): Promise<void> {
  const status = result.ok ? 200 : result.error.code === "room_type_not_found" ? 404 : 409;
  const serialized = JSON.stringify(result);
  const updated = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3, completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz, idempotency_metadata = $5::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      status,
      sha256(serialized),
      occurredAt.toISOString(),
      serializedMetadata(result),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("PMS physical-unit idempotency completion failed");
}

async function recordAudit(
  client: PmsPhysicalRoomUnitReconcileClient,
  command: ReconcilePhysicalRoomUnitsCommand,
  idempotencyId: string,
  keyHash: string,
  result: ReconcilePhysicalRoomUnitsResult,
  occurredAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at,
       tenant_scope, organization_id, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       idempotency_key_id, correlation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     )
     VALUES (
       $1, 'pms', 'physical_room_units.reconcile', 1, $2::timestamptz,
       'property', NULL, $3::uuid, $4, $5::uuid,
       'pms', 'room_type', $6, $7::uuid, $8, $9::jsonb, $10::jsonb,
       $11::jsonb, 'standard', 'internal'
     )`,
    [
      `pms.physical_room_units.reconcile:${idempotencyId}`,
      occurredAt.toISOString(),
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.roomTypeId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify({
        expectedRevision: command.expectedRevision,
        targetActiveUnitCount: command.targetActiveUnitCount,
        outcome: result.ok ? result.response.outcome : result.error.code,
      }),
      JSON.stringify({ result }),
      JSON.stringify({
        requestId: command.audit.requestId,
        idempotencyKeyHash: keyHash,
        authorizedOrganizationId: command.organizationId,
      }),
    ],
  );
}

function serializedMetadata(result: ReconcilePhysicalRoomUnitsResult): string {
  return JSON.stringify({ result });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
