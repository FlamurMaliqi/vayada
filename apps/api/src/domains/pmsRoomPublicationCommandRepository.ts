import { createHash, randomUUID } from "node:crypto";

import {
  createRoomMediaProjectionInput,
  type HotelMediaResolutionPort,
  type ResolvedRoomMediaBatch,
} from "@vayada/domain-hotels";
import {
  PMS_ASSIGN_ROOM_TYPE_MEDIA_OPERATION,
  PMS_CONFIRM_ROOM_TYPE_AMENITIES_OPERATION,
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
  parseAssignRoomTypeMediaResult,
  parseConfirmRoomTypeAmenitiesResult,
  serializeAssignRoomTypeMediaFingerprint,
  serializeConfirmRoomTypeAmenitiesFingerprint,
  type AssignRoomTypeMediaCommand,
  type AssignRoomTypeMediaError,
  type AssignRoomTypeMediaResult,
  type ConfirmRoomTypeAmenitiesCommand,
  type ConfirmRoomTypeAmenitiesError,
  type ConfirmRoomTypeAmenitiesResult,
  type PmsRoomAmenityKey,
  type RoomAmenitiesCommandPort,
  type RoomAmenityVocabularyValidationResult,
  type RoomAmenityVocabularyValidationPort,
  type RoomMediaAssignmentCommandPort,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { readPropertyPlan } from "./propertyPlanReadModel.js";

export type PmsRoomPublicationCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsRoomPublicationCommandPool = {
  connect(): Promise<PmsRoomPublicationCommandClient>;
  end(): Promise<void>;
};

export type PmsRoomPublicationCommandRepositoryConfig = {
  connectionString: string;
  mediaResolver: HotelMediaResolutionPort;
  amenityVocabulary: RoomAmenityVocabularyValidationPort;
  max?: number;
  pool?: PmsRoomPublicationCommandPool;
  now?: () => Date;
  randomId?: () => string;
};

export type PmsRoomPublicationCommandRepository = RoomMediaAssignmentCommandPort &
  RoomAmenitiesCommandPort & { close(): Promise<void> };

type AnyCommand = AssignRoomTypeMediaCommand | ConfirmRoomTypeAmenitiesCommand;
type AnyResult = AssignRoomTypeMediaResult | ConfirmRoomTypeAmenitiesResult;
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};
type IdempotencyReservation = { id: string; attempt: number };
type LockedMediaRoomRow = { roomMediaRevision: number | string };
type LockedAmenitiesRoomRow = {
  roomAmenitiesRevision: number | string;
  roomAmenitiesReviewedAt: Date | string | null;
};
type UpdatedRevisionRow = { revision: number | string };

type CommandSpec<C extends AnyCommand, R extends AnyResult> = {
  operation: string;
  eventType: string;
  action: string;
  serializeFingerprint(command: C): string;
  parseResult(value: unknown): R | null;
  scopeFailure(): R;
  coordinationFailure(code: "idempotency_key_conflict" | "command_in_progress"): R;
  status(result: R): number;
};

type SuccessfulWork<R extends AnyResult> = {
  result: R;
  eventPayload: Record<string, unknown>;
};
type FinalizedFailure<R extends AnyResult> = { result: R; eventPayload: null };
type WorkResult<R extends AnyResult> = SuccessfulWork<R> | FinalizedFailure<R>;

const MANAGE_PERMISSION = "pms.operations.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MEDIA_SPEC: CommandSpec<AssignRoomTypeMediaCommand, AssignRoomTypeMediaResult> = {
  operation: PMS_ASSIGN_ROOM_TYPE_MEDIA_OPERATION,
  eventType: "pms.room_media.assigned",
  action: "pms.room_media.assign",
  serializeFingerprint: serializeAssignRoomTypeMediaFingerprint,
  parseResult: parseAssignRoomTypeMediaResult,
  scopeFailure: () => mediaFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => mediaFailure({ code }),
  status: mediaResultStatus,
};

const AMENITIES_SPEC: CommandSpec<ConfirmRoomTypeAmenitiesCommand, ConfirmRoomTypeAmenitiesResult> =
  {
    operation: PMS_CONFIRM_ROOM_TYPE_AMENITIES_OPERATION,
    eventType: "pms.room_amenities.confirmed",
    action: "pms.room_amenities.confirm",
    serializeFingerprint: serializeConfirmRoomTypeAmenitiesFingerprint,
    parseResult: parseConfirmRoomTypeAmenitiesResult,
    scopeFailure: () => amenitiesFailure({ code: "setup_scope_unavailable" }),
    coordinationFailure: (code) => amenitiesFailure({ code }),
    status: amenitiesResultStatus,
  };

export function createPgPmsRoomPublicationCommandRepository(
  config: PmsRoomPublicationCommandRepositoryConfig,
): PmsRoomPublicationCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS room publication command repository connectionString must not be empty");
  }
  if (!config.mediaResolver || !config.amenityVocabulary) {
    throw new Error("PMS room publication command repository requires trusted dependencies");
  }
  const ownsPool = !config.pool;
  const pool: PmsRoomPublicationCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  const makeId = config.randomId ?? randomUUID;
  let closed = false;

  async function runCommand<C extends AnyCommand, R extends AnyResult>(
    command: C,
    spec: CommandSpec<C, R>,
    work: (client: PmsRoomPublicationCommandClient, acceptedAt: Date) => Promise<WorkResult<R>>,
  ): Promise<R> {
    const acceptedAt = now();
    if (!validDate(acceptedAt)) throw new Error("PMS room publication command clock is invalid");
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = sha256(spec.serializeFingerprint(command));
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
        await rollbackQuietly(client);
        return spec.scopeFailure();
      }
      await lockPropertyCommandScope(client, command.propertyId);

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
        const concurrent = await findReplay(
          client,
          command,
          spec,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        await rollbackQuietly(client);
        return concurrent ?? spec.coordinationFailure("command_in_progress");
      }

      const worked = await work(client, acceptedAt);
      const parsed = spec.parseResult(worked.result);
      if (!parsed) throw new Error("PMS room publication command produced an invalid result");

      let domainEventId: string | null = null;
      if (worked.eventPayload) {
        domainEventId = makeId().toLowerCase();
        if (!UUID_PATTERN.test(domainEventId)) {
          throw new Error("PMS room publication event ID generator returned an invalid UUID");
        }
        await insertDomainEvent(client, command, spec, reservation, {
          domainEventId,
          keyHash,
          acceptedAt,
          payload: worked.eventPayload,
        });
      }
      await recordAudit(client, command, spec, reservation, {
        domainEventId,
        keyHash,
        acceptedAt,
        result: parsed,
      });
      await completeIdempotency(client, reservation.id, spec, parsed, acceptedAt);
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
    async assignRoomTypeMedia(command) {
      return runCommand(command, MEDIA_SPEC, async (client, acceptedAt) => {
        const current = await lockMediaRoom(client, command.propertyId, command.roomTypeId);
        if (!current) return finalized(mediaFailure({ code: "room_type_not_found" }));
        const currentRevision = positiveDatabaseInteger(current.roomMediaRevision);
        if (currentRevision !== command.expectedRoomMediaRevision) {
          return finalized(mediaFailure({ code: "room_media_revision_conflict", currentRevision }));
        }
        const currentCount = await countRoomMedia(client, command.propertyId, command.roomTypeId);
        const currentMediaObjectIds = await readRoomMediaObjectIds(
          client,
          command.propertyId,
          command.roomTypeId,
        );
        const propertyPlan = await readPropertyPlan(client, command.propertyId);
        const addsMedia = command.assignments.some(
          ({ mediaObjectId }) => !currentMediaObjectIds.has(mediaObjectId),
        );
        if (
          (currentCount >= propertyPlan.limits.maxRoomPhotosPerType && addsMedia) ||
          (command.assignments.length > propertyPlan.limits.maxRoomPhotosPerType &&
            command.assignments.length > currentCount)
        ) {
          return finalized(
            mediaFailure({
              code: "room_media_plan_limit_reached",
              plan: propertyPlan.plan,
              currentCount,
              maxAllowed: propertyPlan.limits.maxRoomPhotosPerType,
            }),
          );
        }

        const resolved = await config.mediaResolver.resolvePublicMedia({
          ownerOrganizationId: command.organizationId,
          target: {
            kind: "room_type",
            propertyId: command.propertyId,
            roomTypeId: command.roomTypeId,
          },
          mediaObjectIds: command.assignments.map(({ mediaObjectId }) => mediaObjectId),
        });
        if (!resolved.ok) {
          const error = mediaResolutionFailure(resolved.error);
          if (!error) throw new Error("PMS room media resolver returned an unsupported error");
          return finalized(mediaFailure(error));
        }
        if (
          resolved.batch.ownerOrganizationId !== command.organizationId ||
          resolved.batch.target.kind !== "room_type" ||
          resolved.batch.target.propertyId !== command.propertyId ||
          resolved.batch.target.roomTypeId !== command.roomTypeId
        ) {
          throw new Error("PMS room media resolver returned the wrong command scope");
        }
        const nextRevision = command.expectedRoomMediaRevision + 1;
        const projection = createRoomMediaProjectionInput({
          resolvedMedia: resolved.batch as ResolvedRoomMediaBatch,
          roomMediaRevision: nextRevision,
          assignments: command.assignments,
        });
        if (
          !projection ||
          projection.ownerOrganizationId !== command.organizationId ||
          projection.propertyId !== command.propertyId ||
          projection.roomTypeId !== command.roomTypeId ||
          projection.roomMediaRevision !== nextRevision
        ) {
          throw new Error("PMS room media resolver proof did not match the assignment command");
        }

        await replaceRoomMedia(client, command, acceptedAt);
        const updatedRevision = await incrementRoomMediaRevision(client, command, acceptedAt);
        if (updatedRevision !== nextRevision) {
          throw new Error("PMS room media assignment lost its locked revision");
        }
        const result: AssignRoomTypeMediaResult = {
          ok: true,
          response: {
            contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
            outcome: "assigned",
            propertyId: command.propertyId,
            roomTypeId: command.roomTypeId,
            roomMediaRevision: nextRevision,
            assignments: command.assignments,
            acceptedAt: acceptedAt.toISOString(),
          },
        };
        return successful(result, {
          contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
          organizationId: command.organizationId,
          propertyId: command.propertyId,
          roomTypeId: command.roomTypeId,
          outcome: "assigned",
          roomMediaRevision: nextRevision,
          acceptedAt: acceptedAt.toISOString(),
        });
      });
    },

    async confirmRoomTypeAmenities(command) {
      return runCommand(command, AMENITIES_SPEC, async (client, acceptedAt) => {
        const current = await lockAmenitiesRoom(client, command.propertyId, command.roomTypeId);
        if (!current) return finalized(amenitiesFailure({ code: "room_type_not_found" }));
        const currentRevision = positiveDatabaseInteger(current.roomAmenitiesRevision);
        if (currentRevision !== command.expectedRoomAmenitiesRevision) {
          return finalized(
            amenitiesFailure({ code: "room_amenities_revision_conflict", currentRevision }),
          );
        }

        const vocabulary = parseAmenityVocabularyValidationResult(
          await config.amenityVocabulary.validateRoomAmenities(command.amenities),
          command.amenities,
        );
        if (!vocabulary) {
          throw new Error("PMS room amenity vocabulary returned an invalid result");
        }
        if (!vocabulary.ok) return finalized(amenitiesFailure(vocabulary.error));

        const nextRevision = command.expectedRoomAmenitiesRevision + 1;
        const updatedRevision = await updateRoomAmenities(client, command, acceptedAt);
        if (updatedRevision !== nextRevision) {
          throw new Error("PMS room amenities confirmation lost its locked revision");
        }
        const reviewedAt = acceptedAt.toISOString();
        const result: ConfirmRoomTypeAmenitiesResult = {
          ok: true,
          response: {
            contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
            outcome: "confirmed",
            roomAmenities: {
              contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
              propertyId: command.propertyId,
              roomTypeId: command.roomTypeId,
              roomAmenitiesRevision: nextRevision,
              reviewed: true,
              amenities: command.amenities,
              reviewedAt,
            },
            acceptedAt: reviewedAt,
          },
        };
        return successful(result, {
          contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
          organizationId: command.organizationId,
          propertyId: command.propertyId,
          roomTypeId: command.roomTypeId,
          outcome: "confirmed",
          roomAmenitiesRevision: nextRevision,
          reviewedAt,
          acceptedAt: reviewedAt,
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
  client: PmsRoomPublicationCommandClient,
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
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= at) &&
      (!row.expiresAt || new Date(row.expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function lockPropertyCommandScope(
  client: PmsRoomPublicationCommandClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('pms.room_publication'), hashtext($1::uuid::text))`,
    [propertyId],
  );
}

async function findReplay<C extends AnyCommand, R extends AnyResult>(
  client: PmsRoomPublicationCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<R | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id,
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
  if (existing.status !== "completed") return spec.coordinationFailure("command_in_progress");
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = spec.parseResult(stored);
  if (
    !parsed ||
    existing.responseStatusCode !== spec.status(parsed) ||
    existing.responseBodyHash !== sha256(stableJson(parsed))
  ) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsRoomPublicationCommandClient,
  command: AnyCommand,
  operation: string,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     )
     VALUES (
       'pms', $1, $2, $3,
       'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
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
     RETURNING id::text AS id,
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

async function lockMediaRoom(
  client: PmsRoomPublicationCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<LockedMediaRoomRow | null> {
  const result = await client.query<LockedMediaRoomRow>(
    `SELECT room_media_revision AS "roomMediaRevision"
     FROM pms.room_types
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND active
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
  if (result.rows.length > 1) throw new Error("PMS room media lock returned duplicate rows");
  return result.rows[0] ?? null;
}

async function countRoomMedia(
  client: PmsRoomPublicationCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<number> {
  const result = await client.query<{ currentMediaCount: number | string }>(
    `SELECT GREATEST(
       CASE
         WHEN jsonb_typeof(room_type.media_snapshot) = 'array'
           THEN jsonb_array_length(room_type.media_snapshot)
         ELSE 0
       END,
       (SELECT count(*)::integer
        FROM pms.room_type_media assignment
        WHERE assignment.property_id = room_type.property_id
          AND assignment.room_type_id = room_type.id)
     ) AS "currentMediaCount"
     FROM pms.room_types room_type
     WHERE room_type.property_id = $1::uuid
       AND room_type.id = $2::uuid`,
    [propertyId, roomTypeId],
  );
  if (result.rows.length !== 1) throw new Error("PMS room media count returned no row");
  return nonNegativeDatabaseInteger(result.rows[0]!.currentMediaCount);
}

async function readRoomMediaObjectIds(
  client: PmsRoomPublicationCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ mediaObjectId: string }>(
    `SELECT platform_media_object_id::text AS "mediaObjectId"
     FROM pms.room_type_media
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid`,
    [propertyId, roomTypeId],
  );
  return new Set(result.rows.map(({ mediaObjectId }) => mediaObjectId));
}

async function lockAmenitiesRoom(
  client: PmsRoomPublicationCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<LockedAmenitiesRoomRow | null> {
  const result = await client.query<LockedAmenitiesRoomRow>(
    `SELECT room_amenities_revision AS "roomAmenitiesRevision",
            room_amenities_reviewed_at AS "roomAmenitiesReviewedAt"
     FROM pms.room_types
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND active
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
  if (result.rows.length > 1) throw new Error("PMS room amenities lock returned duplicate rows");
  return result.rows[0] ?? null;
}

async function replaceRoomMedia(
  client: PmsRoomPublicationCommandClient,
  command: AssignRoomTypeMediaCommand,
  at: Date,
): Promise<void> {
  await client.query(
    `DELETE FROM pms.room_type_media
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid`,
    [command.propertyId, command.roomTypeId],
  );
  if (command.assignments.length === 0) return;
  await client.query(
    `INSERT INTO pms.room_type_media (
       property_id, room_type_id, platform_media_object_id,
       alt_text, sort_order, created_at, updated_at
     )
     SELECT $1::uuid,
            $2::uuid,
            assignment.media_object_id,
            assignment.alt_text,
            assignment.sort_order,
            $4::timestamptz,
            $4::timestamptz
     FROM jsonb_to_recordset($3::jsonb) AS assignment(
       media_object_id uuid,
       alt_text text,
       sort_order integer
     )`,
    [
      command.propertyId,
      command.roomTypeId,
      JSON.stringify(
        command.assignments.map((assignment) => ({
          media_object_id: assignment.mediaObjectId,
          alt_text: assignment.altText,
          sort_order: assignment.sortOrder,
        })),
      ),
      at.toISOString(),
    ],
  );
}

async function incrementRoomMediaRevision(
  client: PmsRoomPublicationCommandClient,
  command: AssignRoomTypeMediaCommand,
  at: Date,
): Promise<number> {
  const result = await client.query<UpdatedRevisionRow>(
    `UPDATE pms.room_types
     SET room_media_revision = room_media_revision + 1,
         updated_at = $4::timestamptz
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND active
       AND room_media_revision = $3
     RETURNING room_media_revision AS revision`,
    [command.propertyId, command.roomTypeId, command.expectedRoomMediaRevision, at.toISOString()],
  );
  if (result.rowCount !== 1) throw new Error("PMS room media revision update returned no row");
  return positiveDatabaseInteger(result.rows[0]?.revision ?? 0);
}

async function updateRoomAmenities(
  client: PmsRoomPublicationCommandClient,
  command: ConfirmRoomTypeAmenitiesCommand,
  at: Date,
): Promise<number> {
  const result = await client.query<UpdatedRevisionRow>(
    `UPDATE pms.room_types
     SET amenities_snapshot = $4::jsonb,
         room_amenities_revision = room_amenities_revision + 1,
         room_amenities_reviewed_at = $5::timestamptz,
         updated_at = $5::timestamptz
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND active
       AND room_amenities_revision = $3
     RETURNING room_amenities_revision AS revision`,
    [
      command.propertyId,
      command.roomTypeId,
      command.expectedRoomAmenitiesRevision,
      JSON.stringify(command.amenities),
      at.toISOString(),
    ],
  );
  if (result.rowCount !== 1) throw new Error("PMS room amenities update returned no row");
  return positiveDatabaseInteger(result.rows[0]?.revision ?? 0);
}

async function insertDomainEvent<C extends AnyCommand, R extends AnyResult>(
  client: PmsRoomPublicationCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  reservation: IdempotencyReservation,
  input: {
    domainEventId: string;
    keyHash: string;
    acceptedAt: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, causation_id,
       idempotency_key_hash, payload, event_metadata, ai_visible
     )
     VALUES (
       $1::uuid, 'pms', $2, $3, 1, $4::timestamptz,
       'property', NULL, $5::uuid,
       'pms', 'room_type', $6,
       'user', $7::uuid, $8, $9,
       $10, $11::jsonb,
       jsonb_build_object('contractVersion', $12::text, 'source', 'vay-1061'), FALSE
     )`,
    [
      input.domainEventId,
      eventKey(spec.operation, command.propertyId, command.roomTypeId, input.keyHash, reservation),
      spec.eventType,
      input.acceptedAt.toISOString(),
      command.propertyId,
      command.roomTypeId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      input.keyHash,
      JSON.stringify(input.payload),
      "contractVersion" in input.payload ? String(input.payload["contractVersion"]) : "unknown",
    ],
  );
}

async function recordAudit<C extends AnyCommand, R extends AnyResult>(
  client: PmsRoomPublicationCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  reservation: IdempotencyReservation,
  input: {
    domainEventId: string | null;
    keyHash: string;
    acceptedAt: Date;
    result: R;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at,
       tenant_scope, organization_id, property_id,
       actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata, ai_visible
     )
     VALUES (
       $1, 'pms', $2, $3::timestamptz,
       'property', NULL, $4::uuid,
       'user', $5::uuid,
       'pms', 'room_type', $6,
       $7::uuid, $8::uuid, $9, $10,
       $11::jsonb,
       jsonb_build_object('operation', $12::text, 'attempt', $13::integer), FALSE
     )`,
    [
      auditKey(spec.operation, command.propertyId, command.roomTypeId, input.keyHash, reservation),
      `${spec.action}.${input.result.ok ? "accepted" : "rejected"}`,
      input.acceptedAt.toISOString(),
      command.propertyId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.roomTypeId,
      input.domainEventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(auditPayload(input.result)),
      spec.operation,
      reservation.attempt,
    ],
  );
}

async function completeIdempotency<C extends AnyCommand, R extends AnyResult>(
  client: PmsRoomPublicationCommandClient,
  id: string,
  spec: CommandSpec<C, R>,
  result: R,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = $2,
         response_body_hash = $3,
         response_resource_product = $4,
         response_resource_type = $5,
         response_resource_id = $6,
         completed_at = $7::timestamptz,
         last_seen_at = $7::timestamptz,
         idempotency_metadata = jsonb_build_object(
           'attempt', COALESCE((idempotency_metadata ->> 'attempt')::integer, 1),
           'result', $8::jsonb
         )
     WHERE id = $1::uuid
       AND status = 'in_progress'`,
    [
      id,
      spec.status(result),
      sha256(stableJson(result)),
      result.ok ? "pms" : null,
      result.ok ? "room_type" : null,
      result.ok ? successfulRoomTypeId(result) : null,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("PMS room publication idempotency lost its lock");
}

function successfulRoomTypeId(result: Extract<AnyResult, { readonly ok: true }>): string {
  return "roomAmenities" in result.response
    ? result.response.roomAmenities.roomTypeId
    : result.response.roomTypeId;
}

function mediaResolutionFailure(error: {
  code: string;
  mediaObjectIds: readonly string[];
}): Extract<AssignRoomTypeMediaError, { readonly mediaObjectIds: readonly string[] }> | null {
  return ["media_not_found", "media_not_authorized", "media_not_ready"].includes(error.code)
    ? ({ code: error.code, mediaObjectIds: error.mediaObjectIds } as Extract<
        AssignRoomTypeMediaError,
        { readonly mediaObjectIds: readonly string[] }
      >)
    : null;
}

function mediaFailure(error: AssignRoomTypeMediaError): AssignRoomTypeMediaResult {
  return { ok: false, error };
}

function amenitiesFailure(error: ConfirmRoomTypeAmenitiesError): ConfirmRoomTypeAmenitiesResult {
  return { ok: false, error };
}

function finalized<R extends AnyResult>(result: R): FinalizedFailure<R> {
  return { result, eventPayload: null };
}

function successful<R extends AnyResult>(
  result: R,
  eventPayload: Record<string, unknown>,
): SuccessfulWork<R> {
  return { result, eventPayload };
}

function mediaResultStatus(result: AssignRoomTypeMediaResult): number {
  if (result.ok) return 200;
  if (result.error.code === "room_type_not_found" || result.error.code === "media_not_found") {
    return 404;
  }
  if (result.error.code === "media_not_authorized") {
    return 403;
  }
  if (result.error.code === "setup_scope_unavailable") return 404;
  if (result.error.code === "media_not_ready") return 422;
  return 409;
}

function amenitiesResultStatus(result: ConfirmRoomTypeAmenitiesResult): number {
  if (result.ok) return 200;
  if (result.error.code === "room_type_not_found") return 404;
  if (result.error.code === "setup_scope_unavailable") return 404;
  if (result.error.code === "unsupported_room_amenity_keys") return 422;
  return 409;
}

function auditPayload(result: AnyResult): Record<string, unknown> {
  if (!result.ok) return { outcome: "rejected", error: result.error };
  if ("roomAmenities" in result.response) {
    return {
      outcome: result.response.outcome,
      roomAmenitiesRevision: result.response.roomAmenities.roomAmenitiesRevision,
      reviewedAt: result.response.roomAmenities.reviewedAt,
    };
  }
  return {
    outcome: result.response.outcome,
    roomMediaRevision: result.response.roomMediaRevision,
  };
}

function eventKey(
  operation: string,
  propertyId: string,
  roomTypeId: string,
  keyHash: string,
  reservation: IdempotencyReservation,
): string {
  return `${operation}.property.${propertyId}.room_type.${roomTypeId}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
}

function auditKey(
  operation: string,
  propertyId: string,
  roomTypeId: string,
  keyHash: string,
  reservation: IdempotencyReservation,
): string {
  return `${operation}.property.${propertyId}.room_type.${roomTypeId}.key.${keyHash}.attempt.${reservation.attempt}.audit.v1`;
}

function positiveDatabaseInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("PMS room publication database revision is invalid");
  }
  return parsed;
}

function nonNegativeDatabaseInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 20) {
    throw new Error("PMS room publication media count is invalid");
  }
  return parsed;
}

function parseAmenityVocabularyValidationResult(
  value: unknown,
  requestedAmenities: readonly PmsRoomAmenityKey[],
): RoomAmenityVocabularyValidationResult | null {
  if (isExactDataRecord(value, ["ok"]) && value["ok"] === true) {
    return Object.freeze({ ok: true });
  }
  if (
    !isExactDataRecord(value, ["ok", "error"]) ||
    value["ok"] !== false ||
    !isExactDataRecord(value["error"], ["code", "unsupportedAmenityKeys"]) ||
    value["error"]["code"] !== "unsupported_room_amenity_keys"
  ) {
    return null;
  }
  const unsupported = value["error"]["unsupportedAmenityKeys"];
  if (!isDensePlainArray(unsupported) || unsupported.length === 0) return null;
  const requested = new Set<string>(requestedAmenities);
  const parsed: PmsRoomAmenityKey[] = [];
  for (const item of unsupported) {
    if (
      typeof item !== "string" ||
      !requested.has(item) ||
      (parsed.length > 0 && parsed[parsed.length - 1]! >= item)
    ) {
      return null;
    }
    parsed.push(item as PmsRoomAmenityKey);
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "unsupported_room_amenity_keys",
      unsupportedAmenityKeys: Object.freeze(parsed),
    }),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) return false;
  }
  return ownKeys.every(
    (key) =>
      key === "length" || (/^(?:0|[1-9]\d*)$/.test(String(key)) && Number(key) < value.length),
  );
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

async function rollbackQuietly(client: PmsRoomPublicationCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
