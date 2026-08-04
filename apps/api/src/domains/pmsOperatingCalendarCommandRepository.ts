import { createHash } from "node:crypto";

import {
  PMS_OPERATING_CALENDAR_AUTHORIZATION,
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_IDEMPOTENCY,
  PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
  PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarCommandResult,
  parsePmsOperatingCalendarConfigurationSnapshot,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  resolvePmsOperatingCalendarPropertyProfileConflict,
  serializePmsOperatingCalendarFingerprint,
  type PmsOperatingCalendarCommandError,
  type PmsOperatingCalendarCommandPort,
  type PmsOperatingCalendarCommandResult,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidence,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingCalendarRoomEvidencePorts,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFactsSnapshot,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { loadPmsOperatingCalendarConfigurationByRevision } from "./pmsOperatingCalendarReadModel.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

export type PmsOperatingCalendarCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsOperatingCalendarCommandPool = {
  connect(): Promise<PmsOperatingCalendarCommandClient>;
  end(): Promise<void>;
};

export type PmsOperatingCalendarCommandRepositoryConfig = {
  connectionString?: string;
  max?: number;
  pool?: PmsOperatingCalendarCommandPool;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts;
  now?: () => Date;
};

export type PmsOperatingCalendarCommandRepository = PmsOperatingCalendarCommandPort & {
  close(): Promise<void>;
};

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | string | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

type IdempotencyReservation = Readonly<{ id: string; attempt: number }>;
type AcceptedNotification = Readonly<{ domainEventId: string; outboxEventId: string }>;
type WorkResult = Readonly<{
  result: PmsOperatingCalendarCommandResult;
  notification?: AcceptedNotification;
}>;

const OPERATION = PMS_OPERATING_CALENDAR_IDEMPOTENCY.operation;

export function createPgPmsOperatingCalendarCommandRepository(
  config: PmsOperatingCalendarCommandRepositoryConfig,
): PmsOperatingCalendarCommandRepository {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS operating-calendar command repository connectionString must not be empty");
  }
  const pool: PmsOperatingCalendarCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async upsertOperatingCalendar(command) {
      const acceptedAt = now();
      if (!validDate(acceptedAt))
        throw new Error("PMS operating-calendar command clock is invalid");
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = sha256(serializePmsOperatingCalendarFingerprint(command));
      const preflight = await preflightCommand(
        pool,
        command,
        acceptedAt,
        keyHash,
        fingerprint,
        config.propertyProfileEvidence,
      );
      if (preflight) return preflight;
      return config.propertyProfileEvidence.runWithPropertyProfileEvidence(
        {
          propertyId: command.propertyId,
          expectedProfileRevision: command.expectedPropertyProfileRevision,
        },
        (profileEvidence) =>
          runGuardedCommand(
            pool,
            command,
            profileEvidence,
            config.propertyProfileEvidence,
            config.roomEvidence,
            acceptedAt,
            keyHash,
            fingerprint,
          ),
      );
    },

    async close() {
      if (!ownsPool || closed) return;
      await pool.end();
      closed = true;
    },
  };
}

async function preflightCommand(
  pool: PmsOperatingCalendarCommandPool,
  command: UpsertPmsOperatingCalendarCommand,
  acceptedAt: Date,
  keyHash: string,
  fingerprint: string,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
): Promise<PmsOperatingCalendarCommandResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
      await rollbackQuietly(client);
      return failure({ code: "setup_scope_unavailable" });
    }
    const replay = await findReplay(client, command, keyHash, fingerprint, acceptedAt, registry);
    await rollbackQuietly(client);
    return replay;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function runGuardedCommand(
  pool: PmsOperatingCalendarCommandPool,
  command: UpsertPmsOperatingCalendarCommand,
  profileEvidence: PmsOperatingCalendarPropertyProfileEvidenceResult,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts,
  acceptedAt: Date,
  keyHash: string,
  fingerprint: string,
): Promise<PmsOperatingCalendarCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
      await rollbackQuietly(client);
      return failure({ code: "setup_scope_unavailable" });
    }
    const replay = await findReplay(client, command, keyHash, fingerprint, acceptedAt, registry);
    if (replay) {
      await rollbackQuietly(client);
      return replay;
    }
    const reservation = await reserveIdempotency(client, command, keyHash, fingerprint, acceptedAt);
    if (!reservation) {
      const concurrent = await findReplay(
        client,
        command,
        keyHash,
        fingerprint,
        acceptedAt,
        registry,
      );
      await rollbackQuietly(client);
      return concurrent ?? failure({ code: "command_in_progress" });
    }
    const worked = await applyCommand(
      client,
      command,
      profileEvidence,
      registry,
      roomEvidence,
      reservation,
      keyHash,
      acceptedAt,
    );
    const result = parsePmsOperatingCalendarCommandResult(worked.result, registry);
    if (!result) throw new Error("PMS operating-calendar command result is invalid");
    if (result.ok !== Boolean(worked.notification)) {
      throw new Error("PMS operating-calendar change notification invariant failed");
    }
    await recordAudit(
      client,
      command,
      reservation,
      keyHash,
      result,
      worked.notification?.domainEventId ?? null,
      acceptedAt,
    );
    await completeIdempotency(client, reservation.id, result, acceptedAt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function applyCommand(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  profileResult: PmsOperatingCalendarPropertyProfileEvidenceResult,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts,
  reservation: IdempotencyReservation,
  keyHash: string,
  acceptedAt: Date,
): Promise<WorkResult> {
  const profileSource =
    profileResult.status === "available" ? profileResult.evidence.source : profileResult.source;
  if (profileSource.entityId !== command.propertyId) {
    throw new Error("PMS operating-calendar profile evidence escaped its property scope");
  }
  const profileConflict = resolvePmsOperatingCalendarPropertyProfileConflict(
    profileResult,
    command.expectedPropertyProfileRevision,
    registry,
  );
  if (profileConflict) return { result: failure(profileConflict) };
  if (profileResult.status !== "available") {
    throw new Error("PMS operating-calendar profile evidence conflict resolution is invalid");
  }

  await lockPmsRoomFactsMutationScope(client, command.propertyId);
  const currentRevision = await latestRevision(client, command.propertyId);
  if (currentRevision !== command.expectedCalendarRevision) {
    return {
      result: failure({ code: "calendar_revision_conflict", currentRevision }),
    };
  }
  const factsBeforeUnitLocks = await readRoomFacts(roomEvidence, command.propertyId);
  const activeIdsBeforeUnitLocks = factsBeforeUnitLocks
    .filter(({ lifecycle }) => lifecycle === "active")
    .map(({ roomTypeId }) => roomTypeId);
  if (activeIdsBeforeUnitLocks.length === 0) {
    return { result: failure({ code: "active_room_type_set_empty" }) };
  }
  const commandIds = command.roomTypeLimits.map(({ roomTypeId }) => roomTypeId);
  for (const roomTypeId of sortedUnique([...activeIdsBeforeUnitLocks, ...commandIds])) {
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, roomTypeId);
  }
  const facts = await readRoomFacts(roomEvidence, command.propertyId);
  const activeFacts = facts.filter(({ lifecycle }) => lifecycle === "active");
  if (activeFacts.length === 0) return { result: failure({ code: "active_room_type_set_empty" }) };
  const activeIds = activeFacts.map(({ roomTypeId }) => roomTypeId);
  if (!sameStrings(activeIds, commandIds)) {
    return {
      result: failure({ code: "room_type_set_conflict", currentRoomTypeIds: activeIds }),
    };
  }
  const bindings = await validateRoomBindings(roomEvidence, command, activeFacts);
  if ("code" in bindings) return { result: failure(bindings) };

  const configuration = buildConfiguration(
    command,
    profileResult.evidence,
    bindings,
    currentRevision + 1,
    acceptedAt,
    registry,
  );
  if (currentRevision > 0) {
    const current = await loadPmsOperatingCalendarConfigurationByRevision(
      client,
      command.propertyId,
      currentRevision,
      registry,
    );
    if (!current) throw new Error("PMS operating-calendar current revision disappeared");
    if (sameConfiguration(current, configuration)) {
      return { result: failure({ code: "operating_calendar_unchanged" }) };
    }
  }
  const notification = await enqueueChangedSource(
    client,
    command,
    configuration,
    reservation,
    keyHash,
    acceptedAt,
  );
  await insertConfiguration(client, command, configuration, reservation.id, notification);
  const result = parsePmsOperatingCalendarCommandResult(
    {
      ok: true,
      response: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: currentRevision === 0 ? "created" : "updated",
        configuration,
        acceptedAt: acceptedAt.toISOString(),
      },
    },
    registry,
  );
  if (!result) throw new Error("PMS operating-calendar accepted response is invalid");
  return { result, notification };
}

async function validateRoomBindings(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  command: UpsertPmsOperatingCalendarCommand,
  facts: readonly RoomTypeFactsSnapshot[],
): Promise<readonly PmsOperatingCalendarRoomBinding[] | PmsOperatingCalendarCommandError> {
  const limits = new Map(command.roomTypeLimits.map((limit) => [limit.roomTypeId, limit]));
  const bindings: PmsOperatingCalendarRoomBinding[] = [];
  for (const fact of facts) {
    const limit = limits.get(fact.roomTypeId);
    if (!limit) throw new Error("PMS operating-calendar command room set became incomplete");
    if (fact.roomFactsRevision !== limit.expectedRoomFactsRevision) {
      return {
        code: "room_facts_revision_conflict",
        roomTypeId: fact.roomTypeId,
        currentRevision: fact.roomFactsRevision,
      };
    }
    const capacity = await readCapacity(ports, command.propertyId, fact.roomTypeId);
    if (!capacity || capacity.activeUnitCount === 0) {
      return { code: "room_capacity_unavailable", roomTypeId: fact.roomTypeId };
    }
    if (capacity.roomUnitsRevision !== limit.expectedRoomUnitsRevision) {
      return {
        code: "room_units_revision_conflict",
        roomTypeId: fact.roomTypeId,
        currentRevision: capacity.roomUnitsRevision,
      };
    }
    if (limit.startingSellableLimitCount > capacity.activeUnitCount) {
      return {
        code: "starting_sellable_limit_exceeds_capacity",
        roomTypeId: fact.roomTypeId,
        physicalCapacityCount: capacity.activeUnitCount,
      };
    }
    bindings.push(
      Object.freeze({
        roomTypeId: fact.roomTypeId,
        sourceRoomFactsRevision: fact.roomFactsRevision,
        sourceRoomUnitsRevision: capacity.roomUnitsRevision,
        physicalCapacityCount: capacity.activeUnitCount,
        startingSellableLimitCount: limit.startingSellableLimitCount,
      }),
    );
  }
  return Object.freeze(bindings);
}

function buildConfiguration(
  command: UpsertPmsOperatingCalendarCommand,
  profile: PmsOperatingCalendarPropertyProfileEvidence,
  roomBindings: readonly PmsOperatingCalendarRoomBinding[],
  calendarRevision: number,
  acceptedAt: Date,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
): PmsOperatingCalendarConfigurationSnapshot {
  const at = acceptedAt.toISOString();
  const configuration = parsePmsOperatingCalendarConfigurationSnapshot(
    {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      propertyId: command.propertyId,
      calendarRevision,
      source: createPmsOperatingCalendarSourceRevision(command.propertyId, calendarRevision),
      sourceInputs: {
        propertyProfile: profile.source,
        propertyTimeZone: profile.timeZone,
        roomBindings,
      },
      schedule: command.schedule,
      defaultMinimumStayNights: command.defaultMinimumStayNights,
      createdAt: at,
      updatedAt: at,
    },
    registry,
  );
  if (!configuration) throw new Error("PMS operating-calendar configuration is invalid");
  return configuration;
}

async function insertConfiguration(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  idempotencyId: string,
  notification: AcceptedNotification,
): Promise<void> {
  await client.query(
    `INSERT INTO pms.operating_calendar_revisions (
       organization_id, property_id, calendar_revision, contract_version,
       property_profile_revision, property_time_zone, schedule_mode,
       recurring_period_count, room_binding_count, default_minimum_stay_nights,
       idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
       $11::uuid, $12::uuid, $13::uuid, $14::uuid,
       $15::timestamptz, $15::timestamptz
     )`,
    [
      command.organizationId,
      command.propertyId,
      configuration.calendarRevision,
      PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      profileRevision(configuration.sourceInputs.propertyProfile.revision),
      configuration.sourceInputs.propertyTimeZone,
      configuration.schedule.mode,
      configuration.schedule.periods.length,
      configuration.sourceInputs.roomBindings.length,
      configuration.defaultMinimumStayNights,
      idempotencyId,
      notification.domainEventId,
      notification.outboxEventId,
      command.audit.actor.userId,
      configuration.createdAt,
    ],
  );
  for (const [index, period] of configuration.schedule.periods.entries()) {
    await client.query(
      `INSERT INTO pms.operating_calendar_recurring_periods (
         property_id, calendar_revision, period_index,
         start_month, start_day, end_month, end_day
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [
        command.propertyId,
        configuration.calendarRevision,
        index,
        Number(period.startsOn.slice(0, 2)),
        Number(period.startsOn.slice(3, 5)),
        Number(period.endsOn.slice(0, 2)),
        Number(period.endsOn.slice(3, 5)),
      ],
    );
  }
  for (const room of configuration.sourceInputs.roomBindings) {
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings (
         property_id, calendar_revision, room_type_id,
         source_room_facts_revision, source_room_units_revision,
         physical_capacity_count, starting_sellable_limit_count
       ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)`,
      [
        command.propertyId,
        configuration.calendarRevision,
        room.roomTypeId,
        room.sourceRoomFactsRevision,
        room.sourceRoomUnitsRevision,
        room.physicalCapacityCount,
        room.startingSellableLimitCount,
      ],
    );
  }
}

async function lockAuthorizedScope(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  at: Date,
): Promise<boolean> {
  const scope = await client.query(
    `SELECT resource.id
     FROM identity.organizations organization
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = $4 AND resource.resource_type = $5
      AND resource.resource_id = $2::uuid::text
      AND resource.relationship = ANY($6::text[]) AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $7
     WHERE organization.id = $1::uuid AND organization.kind = 'hotel_group'
       AND organization.status = 'active'
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [
      command.organizationId,
      command.propertyId,
      command.audit.actor.userId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.allowedRelationships,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.permission,
    ],
  );
  if ((scope.rowCount ?? 0) < 1) return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = $3
       AND entitlement_key = $4
       AND (resource_product IS NULL OR
            (resource_product = $5 AND resource_type = $6
             AND resource_id = $2::uuid::text))
     FOR SHARE`,
    [
      command.organizationId,
      command.propertyId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.key,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
    ],
  );
  const applicable = entitlements.rows.filter(
    ({ startsAt, expiresAt }) =>
      (!startsAt || new Date(startsAt) <= at) && (!expiresAt || new Date(expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function latestRevision(
  client: PmsOperatingCalendarCommandClient,
  propertyId: string,
): Promise<number> {
  const result = await client.query<{ calendarRevision: number | string }>(
    `SELECT calendar_revision AS "calendarRevision"
     FROM pms.operating_calendar_revisions
     WHERE property_id = $1::uuid
     ORDER BY calendar_revision DESC LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ? positiveInteger(result.rows[0].calendarRevision) : 0;
}

async function findReplay(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
): Promise<PmsOperatingCalendarCommandResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata", expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid FOR UPDATE`,
    [OPERATION, keyHash, command.propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS operating-calendar replay is not unique");
  const existing = result.rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return failure({ code: "idempotency_key_conflict" });
  }
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const resultJson = record(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["resultJson"]
    : undefined;
  const stored = typeof resultJson === "string" ? parseJson(resultJson) : undefined;
  const parsed = parsePmsOperatingCalendarCommandResult(stored, registry);
  if (
    !parsed ||
    databaseInteger(existing.responseStatusCode) !== resultStatus(parsed) ||
    existing.responseBodyHash !== sha256(stableJson(parsed))
  ) {
    return failure({ code: "idempotency_key_conflict" });
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       correlation_id = EXCLUDED.correlation_id, first_seen_at = EXCLUDED.first_seen_at,
       last_seen_at = EXCLUDED.last_seen_at, completed_at = NULL,
       expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt', COALESCE((idempotency_keys.idempotency_metadata->>'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id,
       (idempotency_metadata->>'attempt')::integer AS attempt`,
    [
      OPERATION,
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
  client: PmsOperatingCalendarCommandClient,
  id: string,
  result: PmsOperatingCalendarCommandResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('resultJson', $5::text)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      resultStatus(result),
      sha256(stableJson(result)),
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("PMS operating-calendar idempotency completion failed");
  }
}

async function enqueueChangedSource(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  reservation: IdempotencyReservation,
  keyHash: string,
  at: Date,
): Promise<AcceptedNotification> {
  const event = {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    eventType: "pms.operating_calendar.changed" as const,
    destination: PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
    metadata: PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
    propertyId: command.propertyId,
    calendarRevision: configuration.calendarRevision,
    sourceRevision: configuration.source.revision,
  };
  const eventKey = `pms.operating-calendar.changed.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
  const inserted = await client.query<{ domainEventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, correlation_id,
       causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       'pms', $1, 'pms.operating_calendar.changed', 1, $2::timestamptz,
       'property', NULL, $3::uuid, 'pms', 'operating_calendar', $3,
       'user', $4::uuid, $5, $6, $7, $8::jsonb, $9::jsonb, 'confidential'
     ) RETURNING id::text AS "domainEventId"`,
    [
      eventKey,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(event),
      JSON.stringify({
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        ...PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
      }),
    ],
  );
  const domainEventId = inserted.rows[0]?.domainEventId;
  if (!domainEventId) throw new Error("PMS operating-calendar domain event insert failed");
  const outbox = await client.query<{ outboxEventId: string }>(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, 'pms.operating_calendar.changed', 'property', NULL,
       $4::uuid, 'pms', 'operating_calendar', $4, $5, $6, $7::jsonb, $8::jsonb
     ) RETURNING id::text AS "outboxEventId"`,
    [
      domainEventId,
      `${PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION}.pms.operating-calendar.changed.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify(event),
      JSON.stringify({
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        ...PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
      }),
    ],
  );
  const outboxEventId = outbox.rows[0]?.outboxEventId;
  if (!outboxEventId) throw new Error("PMS operating-calendar outbox insert failed");
  return { domainEventId, outboxEventId };
}

async function recordAudit(
  client: PmsOperatingCalendarCommandClient,
  command: UpsertPmsOperatingCalendarCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: PmsOperatingCalendarCommandResult,
  domainEventId: string | null,
  at: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id, idempotency_key_id,
       correlation_id, causation_id, redacted_payload, private_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid, 'user',
       $5::uuid, 'pms', 'operating_calendar', $4, $6::uuid, $7::uuid,
       $8, $9, $10::jsonb, '{}'::jsonb, $11::jsonb, 'confidential'
     )`,
    [
      `pms.operating-calendar.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      OPERATION,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      domainEventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(
        result.ok
          ? {
              propertyId: command.propertyId,
              outcome: result.response.outcome,
              calendarRevision: result.response.configuration.calendarRevision,
              sourceRevision: result.response.configuration.source.revision,
            }
          : { propertyId: command.propertyId, error: result.error },
      ),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      }),
    ],
  );
}

async function readRoomFacts(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
): Promise<readonly RoomTypeFactsSnapshot[]> {
  const raw = await ports.roomFacts.listRoomTypeFacts(propertyId);
  const facts = raw.map(parseRoomTypeFactsSnapshot);
  if (facts.some((item) => !item)) throw new Error("PMS operating-calendar room facts are invalid");
  const parsed = facts as RoomTypeFactsSnapshot[];
  if (parsed.some((item) => item.propertyId !== propertyId)) {
    throw new Error("PMS operating-calendar room facts escaped their property scope");
  }
  parsed.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  if (new Set(parsed.map(({ roomTypeId }) => roomTypeId)).size !== parsed.length) {
    throw new Error("PMS operating-calendar room facts contain duplicates");
  }
  return Object.freeze(parsed);
}

async function readCapacity(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
  roomTypeId: string,
): Promise<RoomTypeCapacitySnapshot | null> {
  const raw = await ports.roomCapacity.getRoomTypeCapacity(propertyId, roomTypeId);
  if (!raw) return null;
  const capacity = parseRoomTypeCapacitySnapshot(raw);
  if (!capacity) throw new Error("PMS operating-calendar room capacity is invalid");
  if (capacity.propertyId !== propertyId || capacity.roomTypeId !== roomTypeId) {
    throw new Error("PMS operating-calendar room capacity escaped its room scope");
  }
  return capacity;
}

function sameConfiguration(
  current: PmsOperatingCalendarConfigurationSnapshot,
  candidate: PmsOperatingCalendarConfigurationSnapshot,
): boolean {
  return (
    current.propertyId === candidate.propertyId &&
    current.defaultMinimumStayNights === candidate.defaultMinimumStayNights &&
    stableJson(current.schedule) === stableJson(candidate.schedule) &&
    stableJson(current.sourceInputs) === stableJson(candidate.sourceInputs)
  );
}

function failure(error: PmsOperatingCalendarCommandError): PmsOperatingCalendarCommandResult {
  return { ok: false, error };
}

function profileRevision(value: string): number {
  const parsed = /^profile:([1-9][0-9]*)$/.exec(value)?.[1];
  return positiveInteger(parsed ?? null);
}

function positiveInteger(value: number | string | null): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("PMS operating-calendar database revision is invalid");
  }
  return parsed;
}

function databaseInteger(value: number | string | null): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : Number.NaN;
}

function resultStatus(result: PmsOperatingCalendarCommandResult): number {
  return result.ok ? 200 : result.error.code === "setup_scope_unavailable" ? 403 : 409;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function rollbackQuietly(client: PmsOperatingCalendarCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command or owner-evidence error.
  }
}
