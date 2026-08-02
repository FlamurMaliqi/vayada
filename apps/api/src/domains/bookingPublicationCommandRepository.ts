import { randomUUID } from "node:crypto";

import type {
  BookingPublicationCommandPort,
  BookingPublicationRequestResult,
  RequestBookingPublicationCommand,
} from "@vayada/domain-booking";
import type { BookingContentLifecyclePort } from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  bookingPublicationFailure,
  bookingPublicationRequestFingerprint,
  bookingPublicationResponseBody,
  bookingPublicationResponseStatus,
  hasValidBookingReadinessEvidence,
  operationProjection,
  parseBookingPublicationIdempotencyMetadata,
  sha256,
  type BookingPublicationOperationRow,
} from "./bookingPublicationCommandEnvelope.js";

const OPERATION = "booking.publication.request";
const PERMISSION = "booking.settings.manage";

type CommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingPublicationCommandPool = {
  connect(): Promise<CommandClient>;
  end(): Promise<void>;
};

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceProduct: string | null;
  responseResourceType: string | null;
  responseResourceId: string | null;
  idempotencyMetadata: unknown;
};

type AuthorizedScopeInput = Pick<
  RequestBookingPublicationCommand,
  "organizationId" | "propertyId" | "actorUserId"
>;

export function createPgBookingPublicationCommandRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingPublicationCommandPool;
  now?: () => Date;
  randomId?: () => string;
  activeContent: Pick<BookingContentLifecyclePort, "getActive">;
}): BookingPublicationCommandPort {
  if (!config.connectionString.trim()) {
    throw new Error("Booking publication command repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: BookingPublicationCommandPool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as BookingPublicationCommandPool);
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;

  return {
    async requestPublication(command) {
      if (!(await hasValidBookingReadinessEvidence(command))) {
        return bookingPublicationFailure({ code: "invalid_readiness_evidence" });
      }
      const requestedAt = now();
      const keyHash = sha256(
        JSON.stringify({
          organizationId: command.organizationId,
          idempotencyKey: command.idempotencyKey,
        }),
      );
      const fingerprint = bookingPublicationRequestFingerprint(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedScope(client, command, requestedAt))) {
          await rollback(client);
          return bookingPublicationFailure({ code: "setup_scope_unavailable" });
        }
        const replay = await findReplay(client, command, keyHash, fingerprint);
        if (replay) {
          await rollback(client);
          return replay;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          requestedAt,
        );
        if (!idempotencyId) {
          const concurrentReplay = await findReplay(client, command, keyHash, fingerprint);
          await rollback(client);
          return concurrentReplay ?? bookingPublicationFailure({ code: "command_in_progress" });
        }

        await lockPublicationScope(client, command.propertyId);
        const activeRevisionId =
          (await config.activeContent.getActive(command.propertyId))?.revisionId ?? null;
        if (activeRevisionId !== command.expectedActiveContentRevisionId) {
          return finalizeConflict(
            client,
            command,
            idempotencyId,
            keyHash,
            bookingPublicationFailure({
              code: "active_content_revision_conflict",
              currentActiveContentRevisionId: activeRevisionId,
            }),
            requestedAt,
          );
        }
        if (await hasOpenAttempt(client, command.propertyId)) {
          return finalizeConflict(
            client,
            command,
            idempotencyId,
            keyHash,
            bookingPublicationFailure({ code: "publication_in_progress" }),
            requestedAt,
          );
        }

        const operationId = randomId();
        const domainEventId = randomId();
        const outboxEventId = randomId();
        const operation = operationProjection({
          operationId,
          propertyId: command.propertyId,
          status: "pending",
          expectedActiveContentRevisionId: command.expectedActiveContentRevisionId,
          resultContentRevisionId: null,
          failureCode: null,
          requestedAt,
          updatedAt: requestedAt,
          completedAt: null,
        });
        await insertDomainEvent(client, command, {
          operationId,
          domainEventId,
          keyHash,
          requestedAt,
        });
        await insertOutbox(client, command, {
          operationId,
          domainEventId,
          outboxEventId,
          keyHash,
          requestedAt,
        });
        await insertAttempt(client, command, {
          operationId,
          domainEventId,
          outboxEventId,
          idempotencyId,
          fingerprint,
          requestedAt,
        });
        const result: BookingPublicationRequestResult = { ok: true, operation };
        await recordAudit(
          client,
          command,
          idempotencyId,
          keyHash,
          result,
          requestedAt,
          domainEventId,
        );
        await completeIdempotency(client, idempotencyId, result, requestedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async getPublicationStatus(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedScope(client, input, now()))) {
          await rollback(client);
          return null;
        }
        const result = await client.query<BookingPublicationOperationRow>(
          `${OPERATION_SELECT}
           WHERE attempt.id = $1::uuid
             AND attempt.organization_id = $2::uuid
             AND attempt.property_id = $3::uuid`,
          [input.operationId, input.organizationId, input.propertyId],
        );
        await client.query("COMMIT");
        return result.rows[0] ? operationProjection(result.rows[0]) : null;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function lockAuthorizedScope(
  client: CommandClient,
  command: AuthorizedScopeInput,
  at: Date,
): Promise<boolean> {
  const scope = await client.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'booking'
      AND resource.resource_type = 'booking_hotel'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator')
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
    [command.organizationId, command.propertyId, command.actorUserId, PERMISSION],
  );
  if (scope.rowCount !== 1) return false;

  const entitlements = await client.query<{
    status: "active" | "suspended" | "expired";
    resourceProduct: string | null;
    resourceType: string | null;
    resourceId: string | null;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status,
            resource_product AS "resourceProduct",
            resource_type AS "resourceType",
            resource_id AS "resourceId",
            starts_at AS "startsAt",
            expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = 'booking'
       AND entitlement_key = 'booking-engine'
       AND (
         resource_product IS NULL
         OR (resource_product = 'booking'
           AND resource_type = 'booking_hotel'
           AND resource_id = $2::uuid::text)
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

async function lockPublicationScope(client: CommandClient, propertyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('booking.publication'),
       hashtext($1::uuid::text)
     )`,
    [propertyId],
  );
}

async function hasOpenAttempt(client: CommandClient, propertyId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM booking.booking_publication_attempts
     WHERE property_id = $1::uuid
       AND status IN ('pending', 'unknown')
     FOR UPDATE`,
    [propertyId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function findReplay(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  keyHash: string,
  fingerprint: string,
): Promise<BookingPublicationRequestResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id,
            status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'booking'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return bookingPublicationFailure({ code: "idempotency_key_conflict" });
  }
  if (existing.status !== "completed") {
    return bookingPublicationFailure({ code: "command_in_progress" });
  }
  const parsed = parseBookingPublicationIdempotencyMetadata(existing.idempotencyMetadata, {
    propertyId: command.propertyId,
    operationId: existing.responseResourceId,
  });
  if (!parsed) return bookingPublicationFailure({ code: "idempotency_key_conflict" });
  const responseResourceMatches = parsed.ok
    ? existing.responseResourceProduct === "booking" &&
      existing.responseResourceType === "booking_publication_attempt" &&
      existing.responseResourceId === parsed.operation.operationId
    : existing.responseResourceProduct === null &&
      existing.responseResourceType === null &&
      existing.responseResourceId === null;
  if (
    !responseResourceMatches ||
    existing.responseStatusCode !== bookingPublicationResponseStatus(parsed) ||
    existing.responseBodyHash !== sha256(JSON.stringify(bookingPublicationResponseBody(parsed)))
  ) {
    return bookingPublicationFailure({ code: "idempotency_key_conflict" });
  }
  return parsed;
}

async function reserveIdempotency(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  keyHash: string,
  fingerprint: string,
  requestedAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at
     )
     VALUES (
       'booking', $1, $2, $3,
       'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '90 days'
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      requestedAt.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function insertDomainEvent(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  input: { operationId: string; domainEventId: string; keyHash: string; requestedAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, occurred_at,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, idempotency_key_hash,
       payload, event_metadata
     )
     VALUES (
       $1::uuid, 'booking', $2, 'booking.publication.requested', $3::timestamptz,
       'property', NULL, $4::uuid,
       'booking', 'booking_publication_attempt', $5,
       'user', $6::uuid, $7, $8,
       $9::jsonb, jsonb_build_object('contractVersion', 'booking-publication.v1')
     )`,
    [
      input.domainEventId,
      `booking.publication.attempt.${input.operationId}.requested.v1`,
      input.requestedAt.toISOString(),
      command.propertyId,
      input.operationId,
      command.actorUserId,
      command.audit.correlationId ?? command.audit.requestId,
      input.keyHash,
      JSON.stringify(publicationEventPayload(command, input.operationId)),
    ],
  );
}

async function insertOutbox(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  input: {
    operationId: string;
    domainEventId: string;
    outboxEventId: string;
    keyHash: string;
    requestedAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, payload, outbox_metadata,
       available_at, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3, 'distribution.booking-publication-projector',
       'booking.publication.requested',
       'property', NULL, $4::uuid,
       'booking', 'booking_publication_attempt', $5,
       $6, $7, $8::jsonb,
       jsonb_build_object('contractVersion', 'booking-publication.v1'),
       $9::timestamptz, $9::timestamptz, $9::timestamptz
     )`,
    [
      input.outboxEventId,
      input.domainEventId,
      `booking.publication.attempt.${input.operationId}.project.v1`,
      command.propertyId,
      input.operationId,
      command.audit.correlationId ?? command.audit.requestId,
      input.keyHash,
      JSON.stringify(publicationEventPayload(command, input.operationId)),
      input.requestedAt.toISOString(),
    ],
  );
}

function publicationEventPayload(command: RequestBookingPublicationCommand, operationId: string) {
  return {
    operationId,
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    requestedByUserId: command.actorUserId,
    expectedActiveContentRevisionId: command.expectedActiveContentRevisionId,
    readiness: {
      contractVersion: command.readiness.contractVersion,
      product: command.readiness.product,
      status: command.readiness.status,
      sourceManifest: command.readiness.sourceManifest,
      sourceManifestHash: command.readiness.sourceManifestHash,
      readinessHash: command.readiness.readinessHash,
    },
  };
}

async function insertAttempt(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  input: {
    operationId: string;
    domainEventId: string;
    outboxEventId: string;
    idempotencyId: string;
    fingerprint: string;
    requestedAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO booking.booking_publication_attempts (
       id, organization_id, property_id, idempotency_key_id,
       domain_event_id, outbox_event_id, request_fingerprint_hash,
       expected_active_content_revision_id, source_manifest,
       source_manifest_hash, readiness_hash, readiness_product, readiness_status,
       requested_by_user_id, requested_at, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6::uuid, $7,
       $8::uuid, $9::jsonb,
       $10, $11, 'booking', 'ready',
       $12::uuid, $13::timestamptz, $13::timestamptz
     )`,
    [
      input.operationId,
      command.organizationId,
      command.propertyId,
      input.idempotencyId,
      input.domainEventId,
      input.outboxEventId,
      input.fingerprint,
      command.expectedActiveContentRevisionId,
      JSON.stringify(command.readiness.sourceManifest),
      command.readiness.sourceManifestHash,
      command.readiness.readinessHash,
      command.actorUserId,
      input.requestedAt.toISOString(),
    ],
  );
}

async function finalizeConflict(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  idempotencyId: string,
  keyHash: string,
  result: BookingPublicationRequestResult,
  requestedAt: Date,
): Promise<BookingPublicationRequestResult> {
  await recordAudit(client, command, idempotencyId, keyHash, result, requestedAt, null);
  await completeIdempotency(client, idempotencyId, result, requestedAt);
  await client.query("COMMIT");
  return result;
}

async function recordAudit(
  client: CommandClient,
  command: RequestBookingPublicationCommand,
  idempotencyId: string,
  keyHash: string,
  result: BookingPublicationRequestResult,
  occurredAt: Date,
  domainEventId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at,
       tenant_scope, organization_id, property_id,
       actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     )
     VALUES (
       $1, 'booking', $2, $3::timestamptz,
       'property', NULL, $4::uuid,
       'user', $5::uuid,
       'booking', $12, $13,
       $6::uuid, $7::uuid, $8, $9,
       $10::jsonb, jsonb_build_object('source', $11::text)
     )`,
    [
      `booking.publication.property.${command.propertyId}.key.${keyHash}.v1`,
      result.ok ? "booking.publication.request.accepted" : "booking.publication.request.rejected",
      occurredAt.toISOString(),
      command.propertyId,
      command.actorUserId,
      domainEventId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(
        result.ok
          ? {
              operationId: result.operation.operationId,
              status: result.operation.status,
              expectedActiveContentRevisionId: command.expectedActiveContentRevisionId,
              sourceManifestHash: command.readiness.sourceManifestHash,
              readinessHash: command.readiness.readinessHash,
            }
          : { error: result.error },
      ),
      command.audit.source,
      result.ok ? "booking_publication_attempt" : "booking_property",
      result.ok ? result.operation.operationId : command.propertyId,
    ],
  );
}

async function completeIdempotency(
  client: CommandClient,
  id: string,
  result: BookingPublicationRequestResult,
  at: Date,
): Promise<void> {
  const body = bookingPublicationResponseBody(result);
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
         idempotency_metadata = jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid
       AND status = 'in_progress'`,
    [
      id,
      bookingPublicationResponseStatus(result),
      sha256(JSON.stringify(body)),
      result.ok ? "booking" : null,
      result.ok ? "booking_publication_attempt" : null,
      result.ok ? result.operation.operationId : null,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Booking publication idempotency completion failed");
  }
}

const OPERATION_SELECT = `SELECT
  attempt.id::text AS "operationId",
  attempt.property_id::text AS "propertyId",
  attempt.status,
  attempt.expected_active_content_revision_id::text AS "expectedActiveContentRevisionId",
  attempt.result_content_revision_id::text AS "resultContentRevisionId",
  attempt.failure_code AS "failureCode",
  attempt.requested_at AS "requestedAt",
  attempt.updated_at AS "updatedAt",
  attempt.completed_at AS "completedAt"
FROM booking.booking_publication_attempts attempt`;

async function rollback(client: CommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
