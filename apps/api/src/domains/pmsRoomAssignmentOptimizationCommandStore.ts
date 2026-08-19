import { createHash, randomUUID } from "node:crypto";

import type {
  PmsRoomAssignmentOptimizationMove,
  PmsRoomAssignmentOptimizationResult,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

export type PmsRoomAssignmentOptimizationStoredResult =
  | Exclude<PmsRoomAssignmentOptimizationResult, { outcome: "budget_exhausted" }>
  | { outcome: "disabled" | "single_room" | "invalid_snapshot" };
export type PmsRoomAssignmentOptimizationCommandIdentity = {
  propertyId: string;
  roomTypeId: string;
  reason: "create" | "cancel" | "modify";
  currentDate: string;
  commandId: string;
  correlationId: string;
  searchBudget?: number;
};
export type PmsRoomAssignmentOptimizationCommandReservation = {
  id: string;
  keyHash: string;
  propertyId: string;
  attemptId: string;
};
export type PmsRoomAssignmentOptimizationCommandStart =
  | { kind: "reserved"; reservation: PmsRoomAssignmentOptimizationCommandReservation }
  | { kind: "replay"; result: PmsRoomAssignmentOptimizationStoredResult }
  | { kind: "conflict"; outcome: "idempotency_conflict" | "command_in_progress" };
export type PmsRoomAssignmentOptimizationCommandStoreClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type IdempotencyRow = QueryResultRow & {
  status: string;
  requestFingerprintHash: string;
  responseBodyHash: string | null;
  responseStatusCode: number | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

const OPERATION = "pms.room_assignments.optimize";

export async function startPmsRoomAssignmentOptimizationCommand(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationCommandIdentity,
  at: Date,
): Promise<PmsRoomAssignmentOptimizationCommandStart> {
  const keyHash = sha256(command.commandId);
  const fingerprint = sha256(
    stableJson({
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      reason: command.reason,
      currentDate: command.currentDate,
      searchBudget: command.searchBudget,
    }),
  );
  const existing = await find(client, command.propertyId, keyHash);
  const replay =
    existing && new Date(existing.expiresAt) > at ? replayFrom(existing, fingerprint) : null;
  if (replay) return replay;
  const attemptId = randomUUID();
  const reserved = await reserve(client, command, keyHash, fingerprint, attemptId, at);
  if (reserved) {
    return {
      kind: "reserved",
      reservation: { id: reserved, keyHash, propertyId: command.propertyId, attemptId },
    };
  }
  const raced = await find(client, command.propertyId, keyHash);
  return raced
    ? replayFrom(raced, fingerprint)
    : { kind: "conflict", outcome: "command_in_progress" };
}

export async function completePmsRoomAssignmentOptimizationCommand(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  reservation: PmsRoomAssignmentOptimizationCommandReservation,
  result: PmsRoomAssignmentOptimizationStoredResult,
  at: Date,
): Promise<void> {
  if (!parseStoredResult(result)) throw new Error("PMS room optimization result is invalid");
  const bodyHash = sha256(stableJson(result));
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $4::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'
       AND operation_scope = 'pms' AND operation = $5 AND key_hash = $6
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $7::uuid
       AND idempotency_metadata ->> 'attemptId' = $8`,
    [
      reservation.id,
      bodyHash,
      at.toISOString(),
      JSON.stringify(result),
      OPERATION,
      reservation.keyHash,
      reservation.propertyId,
      reservation.attemptId,
    ],
  );
  if (completed.rowCount !== 1) throw new Error("PMS room optimization completion failed");
}

export async function releasePmsRoomAssignmentOptimizationCommand(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  reservation: PmsRoomAssignmentOptimizationCommandReservation,
): Promise<void> {
  const released = await client.query(
    `DELETE FROM platform.idempotency_keys
     WHERE id = $1::uuid AND status = 'in_progress'
       AND operation_scope = 'pms' AND operation = $2 AND key_hash = $3
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $4::uuid
       AND idempotency_metadata ->> 'attemptId' = $5`,
    [reservation.id, OPERATION, reservation.keyHash, reservation.propertyId, reservation.attemptId],
  );
  if (released.rowCount !== 1) throw new Error("PMS room optimization release failed");
}

async function find(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  propertyId: string,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const found = await client.query<IdempotencyRow>(
    `SELECT status, response_status_code AS "responseStatusCode",
            request_fingerprint_hash AS "requestFingerprintHash",
            response_body_hash AS "responseBodyHash", idempotency_metadata AS "idempotencyMetadata",
            expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, propertyId],
  );
  return found.rows[0] ?? null;
}

function replayFrom(
  row: IdempotencyRow,
  fingerprint: string,
): PmsRoomAssignmentOptimizationCommandStart {
  if (row.requestFingerprintHash !== fingerprint) {
    return { kind: "conflict", outcome: "idempotency_conflict" };
  }
  if (row.status !== "completed") return { kind: "conflict", outcome: "command_in_progress" };
  if (row.responseStatusCode !== 200) return { kind: "conflict", outcome: "idempotency_conflict" };
  const metadata = isRecord(row.idempotencyMetadata) ? row.idempotencyMetadata : null;
  const result = parseStoredResult(metadata?.["result"]);
  if (!result || row.responseBodyHash !== sha256(stableJson(result))) {
    return { kind: "conflict", outcome: "idempotency_conflict" };
  }
  return { kind: "replay", result };
}

async function reserve(
  client: PmsRoomAssignmentOptimizationCommandStoreClient,
  command: PmsRoomAssignmentOptimizationCommandIdentity,
  keyHash: string,
  fingerprint: string,
  attemptId: string,
  at: Date,
): Promise<string | null> {
  const reserved = await client.query<{ id: string } & QueryResultRow>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('commandId', $7::text, 'attemptId', $8::text)
     ) ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash, status = 'in_progress',
       response_status_code = NULL, response_body_hash = NULL, completed_at = NULL,
       correlation_id = EXCLUDED.correlation_id, first_seen_at = EXCLUDED.first_seen_at,
       last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at,
       idempotency_metadata = EXCLUDED.idempotency_metadata
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.correlationId,
      at.toISOString(),
      command.commandId,
      attemptId,
    ],
  );
  return reserved.rows[0]?.id ?? null;
}

function parseStoredResult(value: unknown): PmsRoomAssignmentOptimizationStoredResult | null {
  if (!isRecord(value) || typeof value["outcome"] !== "string") return null;
  if (["disabled", "single_room", "invalid_snapshot"].includes(value["outcome"])) {
    return Object.keys(value).length === 1
      ? { outcome: value["outcome"] as "disabled" | "single_room" | "invalid_snapshot" }
      : null;
  }
  if (value["outcome"] === "infeasible") {
    const ids = stringArray(value["unassignedOccupancyIds"]);
    return ids && hasKeys(value, ["outcome", "unassignedOccupancyIds"])
      ? { outcome: "infeasible", unassignedOccupancyIds: ids }
      : null;
  }
  if (
    value["outcome"] !== "optimized" ||
    !Array.isArray(value["moves"]) ||
    !hasKeys(value, [
      "outcome",
      "moves",
      "gapNightsBefore",
      "gapNightsAfter",
      "usedRoomsBefore",
      "usedRoomsAfter",
    ])
  )
    return null;
  const moves = value["moves"].map(parseMove);
  const metrics = ["gapNightsBefore", "gapNightsAfter", "usedRoomsBefore", "usedRoomsAfter"];
  if (
    moves.some((move) => !move) ||
    new Set(moves.map((move) => move?.occupancyId)).size !== moves.length ||
    metrics.some((key) => !nonnegativeInteger(value[key]))
  ) {
    return null;
  }
  return {
    outcome: "optimized",
    moves: moves as PmsRoomAssignmentOptimizationMove[],
    gapNightsBefore: value["gapNightsBefore"] as number,
    gapNightsAfter: value["gapNightsAfter"] as number,
    usedRoomsBefore: value["usedRoomsBefore"] as number,
    usedRoomsAfter: value["usedRoomsAfter"] as number,
  };
}

function parseMove(value: unknown): PmsRoomAssignmentOptimizationMove | null {
  if (!isRecord(value) || !hasKeys(value, ["occupancyId", "fromRoomId", "toRoomId"])) return null;
  const from = value["fromRoomId"];
  return nonempty(value["occupancyId"]) &&
    (from === null || nonempty(from)) &&
    nonempty(value["toRoomId"]) &&
    from !== value["toRoomId"]
    ? { occupancyId: value["occupancyId"], fromRoomId: from, toRoomId: value["toRoomId"] }
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(nonempty) &&
    new Set(value).size === value.length
    ? value
    : null;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort()
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
