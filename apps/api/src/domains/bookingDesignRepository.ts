import { createHash, randomUUID } from "node:crypto";

import {
  BOOKING_DESIGN_CHANGED_EVENT_TYPE,
  BOOKING_DESIGN_CONTRACT_VERSION,
  BOOKING_DESIGN_OUTBOX_DESTINATION,
  parseBookingDesignRevision,
  serializeBookingDesignCommandFingerprint,
  type BookingDesignChangedEvent,
  type BookingDesignCommandPort,
  type BookingDesignCommandResult,
  type BookingDesignReadPort,
  type BookingDesignRevision,
  type UpsertBookingDesignCommand,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";

const OPERATION = "booking.design.upsert";
const PERMISSION = "booking.settings.manage";

type RepositoryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingDesignRepositoryPool = {
  connect(): Promise<RepositoryClient>;
  end(): Promise<void>;
};

export type BookingDesignRepository = BookingDesignCommandPort &
  BookingDesignReadPort & { close(): Promise<void> };

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceProduct: string | null;
  responseResourceType: string | null;
  responseResourceId: string | null;
  idempotencyMetadata: unknown;
};

type CurrentRevisionRow = {
  revisionNumber: number;
};

type DesignRow = {
  propertyId: string;
  revisionNumber: number;
  contractVersion: string;
  primaryColor: string;
  fontPairing: string;
  createdAt: Date | string;
};

export function createPgBookingDesignRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingDesignRepositoryPool;
  now?: () => Date;
  randomId?: () => string;
}): BookingDesignRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking design repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      max: config.max,
    }) as BookingDesignRepositoryPool);
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;

  return {
    async upsertDesign(command) {
      const fingerprint = sha256(serializeBookingDesignCommandFingerprint(command));
      const scope = Object.freeze({
        organizationId: command.organizationId.toLowerCase(),
        propertyId: command.propertyId.toLowerCase(),
      });
      const keyHash = sha256(
        JSON.stringify({
          organizationId: scope.organizationId,
          idempotencyKey: command.idempotencyKey,
        }),
      );
      const acceptedAt = now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
          await rollback(client);
          return failure("setup_scope_unavailable");
        }
        const replay = await findReplay(client, scope.propertyId, keyHash, fingerprint);
        if (replay) {
          await rollback(client);
          return replay;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          command,
          scope.propertyId,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrentReplay = await findReplay(client, scope.propertyId, keyHash, fingerprint);
          await rollback(client);
          return concurrentReplay ?? failure("command_in_progress");
        }

        await lockDesignScope(client, scope.propertyId);
        const current = await currentRevision(client, scope.propertyId);
        const currentRevisionNumber = current?.revisionNumber ?? 0;
        if (currentRevisionNumber !== command.expectedRevision) {
          return finalizeConflict(
            client,
            command,
            scope.propertyId,
            idempotencyId,
            keyHash,
            failure("design_revision_conflict", currentRevisionNumber),
            acceptedAt,
          );
        }

        const revisionId = randomId();
        const domainEventId = randomId();
        const outboxEventId = randomId();
        const revisionNumber = currentRevisionNumber + 1;
        const outcome = current ? "updated" : "created";
        const design = projectDesign({
          propertyId: scope.propertyId,
          revisionNumber,
          contractVersion: BOOKING_DESIGN_CONTRACT_VERSION,
          primaryColor: command.choices.primaryColor,
          fontPairing: command.choices.fontPairing,
          createdAt: acceptedAt,
        });
        const event: BookingDesignChangedEvent = Object.freeze({
          contractVersion: BOOKING_DESIGN_CONTRACT_VERSION,
          eventType: BOOKING_DESIGN_CHANGED_EVENT_TYPE,
          propertyId: scope.propertyId,
          designRevision: revisionNumber,
          outcome,
        });
        await insertDomainEvent(client, command, {
          propertyId: scope.propertyId,
          revisionId,
          domainEventId,
          keyHash,
          event,
          acceptedAt,
        });
        await insertOutbox(client, command, {
          propertyId: scope.propertyId,
          revisionId,
          revisionNumber,
          domainEventId,
          outboxEventId,
          keyHash,
          event,
          acceptedAt,
        });
        await insertRevision(client, command, {
          propertyId: scope.propertyId,
          revisionId,
          revisionNumber,
          domainEventId,
          outboxEventId,
          idempotencyId,
          fingerprint,
          acceptedAt,
        });
        await advanceCurrent(client, command, {
          propertyId: scope.propertyId,
          revisionId,
          revisionNumber,
          acceptedAt,
        });
        const result: BookingDesignCommandResult = { ok: true, outcome, design };
        await recordAudit(client, command, {
          propertyId: scope.propertyId,
          revisionId,
          idempotencyId,
          keyHash,
          domainEventId,
          result,
          acceptedAt,
        });
        await completeIdempotency(client, {
          idempotencyId,
          revisionId,
          result,
          acceptedAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        if (isPgLockTimeout(error)) return failure("command_in_progress");
        throw error;
      } finally {
        client.release();
      }
    },

    async getCurrentDesign(input) {
      const client = await pool.connect();
      try {
        const result = await client.query<DesignRow>(
          `SELECT revision.property_id::text AS "propertyId",
                  revision.revision_number AS "revisionNumber",
                  revision.contract_version AS "contractVersion",
                  revision.primary_color AS "primaryColor",
                  revision.font_pairing AS "fontPairing",
                  revision.created_at AS "createdAt"
           FROM booking.current_working_design_revisions current
           JOIN booking.booking_design_revisions revision
             ON revision.id = current.revision_id
            AND revision.organization_id = current.organization_id
            AND revision.property_id = current.property_id
            AND revision.revision_number = current.revision_number
           WHERE current.property_id = $1::uuid
             AND current.organization_id = $2::uuid`,
          [input.propertyId, input.organizationId],
        );
        return result.rows[0] ? projectDesign(result.rows[0]) : null;
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
  client: RepositoryClient,
  command: Pick<UpsertBookingDesignCommand, "organizationId" | "propertyId" | "actorUserId">,
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
  if ((scope.rowCount ?? 0) < 1) return false;
  const entitlements = await client.query<{
    status: "active" | "suspended" | "expired";
    resourceProduct: string | null;
    resourceType: string | null;
    resourceId: string | null;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, resource_product AS "resourceProduct",
            resource_type AS "resourceType", resource_id AS "resourceId",
            starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = 'booking'
       AND entitlement_key = 'booking-engine'
       AND (resource_product IS NULL OR (
         resource_product = 'booking'
         AND resource_type = 'booking_hotel'
         AND resource_id = $2::uuid::text
       ))
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

async function findReplay(
  client: RepositoryClient,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
): Promise<BookingDesignCommandResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
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
    [OPERATION, keyHash, propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) return failure("idempotency_key_conflict");
  if (existing.status !== "completed") return failure("command_in_progress");
  const stored = parseStoredResult(existing.idempotencyMetadata, propertyId);
  if (!stored) return failure("idempotency_key_conflict");
  const resourceMatches = stored.result.ok
    ? existing.responseResourceProduct === "booking" &&
      existing.responseResourceType === "booking_design_revision" &&
      existing.responseResourceId === stored.revisionId
    : existing.responseResourceProduct === null &&
      existing.responseResourceType === null &&
      existing.responseResourceId === null &&
      stored.revisionId === null;
  if (
    !resourceMatches ||
    existing.responseStatusCode !== responseStatus(stored.result) ||
    existing.responseBodyHash !== sha256(stableJson(stored.result))
  ) {
    return failure("idempotency_key_conflict");
  }
  return stored.result.ok ? { ...stored.result, outcome: "idempotent_replay" } : stored.result;
}

async function reserveIdempotency(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at
     ) VALUES (
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
      propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function lockDesignScope(client: RepositoryClient, propertyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('booking.design'), hashtext($1::uuid::text))`,
    [propertyId],
  );
}

async function currentRevision(
  client: RepositoryClient,
  propertyId: string,
): Promise<CurrentRevisionRow | null> {
  const result = await client.query<CurrentRevisionRow>(
    `SELECT current.revision_number AS "revisionNumber"
     FROM booking.current_working_design_revisions current
     WHERE current.property_id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

type AcceptedInput = {
  propertyId: string;
  revisionId: string;
  revisionNumber: number;
  domainEventId: string;
  outboxEventId: string;
  idempotencyId: string;
  fingerprint: string;
  acceptedAt: Date;
};

async function insertRevision(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  input: AcceptedInput,
): Promise<void> {
  await client.query(
    `INSERT INTO booking.booking_design_revisions (
       id, organization_id, property_id, revision_number, contract_version,
       primary_color, font_pairing, request_fingerprint_hash,
       idempotency_key_id, domain_event_id, outbox_event_id,
       created_by_user_id, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $7, $8, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::timestamptz
     )`,
    [
      input.revisionId,
      command.organizationId,
      input.propertyId,
      input.revisionNumber,
      BOOKING_DESIGN_CONTRACT_VERSION,
      command.choices.primaryColor,
      command.choices.fontPairing,
      input.fingerprint,
      input.idempotencyId,
      input.domainEventId,
      input.outboxEventId,
      command.actorUserId,
      input.acceptedAt.toISOString(),
    ],
  );
}

async function advanceCurrent(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  input: Pick<AcceptedInput, "propertyId" | "revisionId" | "revisionNumber" | "acceptedAt">,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO booking.current_working_design_revisions (
       property_id, organization_id, revision_id, revision_number,
       updated_by_user_id, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       revision_id = EXCLUDED.revision_id,
       revision_number = EXCLUDED.revision_number,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = EXCLUDED.updated_at
     WHERE booking.current_working_design_revisions.revision_number = $4 - 1`,
    [
      input.propertyId,
      command.organizationId,
      input.revisionId,
      input.revisionNumber,
      command.actorUserId,
      input.acceptedAt.toISOString(),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Booking design current revision advance failed");
}

async function insertDomainEvent(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  input: Pick<AcceptedInput, "propertyId" | "revisionId" | "domainEventId" | "acceptedAt"> & {
    keyHash: string;
    event: BookingDesignChangedEvent;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, occurred_at,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, idempotency_key_hash,
       payload, event_metadata
     ) VALUES (
       $1::uuid, 'booking', $2, $3, $4::timestamptz,
       'property', NULL, $5::uuid,
       'booking', 'booking_design_revision', $6,
       'user', $7::uuid, $8, $9, $10::jsonb,
       jsonb_build_object('contractVersion', $11::text)
     )`,
    [
      input.domainEventId,
      `booking.design.property.${input.propertyId}.revision.${input.event.designRevision}.changed.v1`,
      BOOKING_DESIGN_CHANGED_EVENT_TYPE,
      input.acceptedAt.toISOString(),
      input.propertyId,
      input.revisionId,
      command.actorUserId,
      command.audit.correlationId ?? command.audit.requestId,
      input.keyHash,
      JSON.stringify(input.event),
      BOOKING_DESIGN_CONTRACT_VERSION,
    ],
  );
}

async function insertOutbox(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  input: Pick<
    AcceptedInput,
    | "propertyId"
    | "revisionId"
    | "revisionNumber"
    | "domainEventId"
    | "outboxEventId"
    | "acceptedAt"
  > & { keyHash: string; event: BookingDesignChangedEvent },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, payload, outbox_metadata,
       available_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5,
       'property', NULL, $6::uuid,
       'booking', 'booking_design_revision', $7,
       $8, $9, $10::jsonb, jsonb_build_object('contractVersion', $11::text),
       $12::timestamptz, $12::timestamptz, $12::timestamptz
     )`,
    [
      input.outboxEventId,
      input.domainEventId,
      `booking.design.property.${input.propertyId}.revision.${input.revisionNumber}.launch-readiness.v1`,
      BOOKING_DESIGN_OUTBOX_DESTINATION,
      BOOKING_DESIGN_CHANGED_EVENT_TYPE,
      input.propertyId,
      input.revisionId,
      command.audit.correlationId ?? command.audit.requestId,
      input.keyHash,
      JSON.stringify(input.event),
      BOOKING_DESIGN_CONTRACT_VERSION,
      input.acceptedAt.toISOString(),
    ],
  );
}

async function finalizeConflict(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  propertyId: string,
  idempotencyId: string,
  keyHash: string,
  result: BookingDesignCommandResult,
  acceptedAt: Date,
): Promise<BookingDesignCommandResult> {
  await recordAudit(client, command, {
    propertyId,
    revisionId: null,
    idempotencyId,
    keyHash,
    domainEventId: null,
    result,
    acceptedAt,
  });
  await completeIdempotency(client, {
    idempotencyId,
    revisionId: null,
    result,
    acceptedAt,
  });
  await client.query("COMMIT");
  return result;
}

async function recordAudit(
  client: RepositoryClient,
  command: UpsertBookingDesignCommand,
  input: {
    propertyId: string;
    revisionId: string | null;
    idempotencyId: string;
    keyHash: string;
    domainEventId: string | null;
    result: BookingDesignCommandResult;
    acceptedAt: Date;
  },
): Promise<void> {
  const action = input.result.ok
    ? `booking.design.${input.result.outcome}`
    : "booking.design.upsert.rejected";
  const payload = input.result.ok
    ? {
        outcome: input.result.outcome,
        designRevision: input.result.design.revision,
        expectedRevision: command.expectedRevision,
      }
    : { error: input.result.error, expectedRevision: command.expectedRevision };
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at,
       tenant_scope, organization_id, property_id,
       actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1, 'booking', $2, $3::timestamptz,
       'property', NULL, $4::uuid,
       'user', $5::uuid,
       'booking', $6, $7,
       $8::uuid, $9::uuid, $10, $11,
       $12::jsonb, jsonb_build_object('source', $13::text)
     )`,
    [
      `booking.design.property.${input.propertyId}.key.${input.keyHash}.v1`,
      action,
      input.acceptedAt.toISOString(),
      input.propertyId,
      command.actorUserId,
      input.result.ok ? "booking_design_revision" : "booking_property",
      input.revisionId ?? input.propertyId,
      input.domainEventId,
      input.idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(payload),
      command.audit.source,
    ],
  );
}

async function completeIdempotency(
  client: RepositoryClient,
  input: {
    idempotencyId: string;
    revisionId: string | null;
    result: BookingDesignCommandResult;
    acceptedAt: Date;
  },
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3,
         response_resource_product = $4,
         response_resource_type = $5,
         response_resource_id = $6,
         completed_at = $7::timestamptz,
         last_seen_at = $7::timestamptz,
         idempotency_metadata = jsonb_build_object(
           'revisionId', to_jsonb($6::text), 'result', $8::jsonb
         )
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      input.idempotencyId,
      responseStatus(input.result),
      sha256(stableJson(input.result)),
      input.result.ok ? "booking" : null,
      input.result.ok ? "booking_design_revision" : null,
      input.revisionId,
      input.acceptedAt.toISOString(),
      JSON.stringify(input.result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Booking design idempotency completion failed");
}

function parseStoredResult(
  value: unknown,
  propertyId: string,
): { revisionId: string | null; result: BookingDesignCommandResult } | null {
  if (!exact(value, ["revisionId", "result"])) return null;
  const result = value["result"];
  if (
    (!exact(result, ["ok", "outcome", "design"]) && !exact(result, ["ok", "error"])) ||
    typeof result["ok"] !== "boolean"
  ) {
    return null;
  }
  if (result["ok"] === true) {
    if (
      !uuid(value["revisionId"]) ||
      (result["outcome"] !== "created" && result["outcome"] !== "updated")
    ) {
      return null;
    }
    const design = parseBookingDesignRevision(result["design"]);
    return design?.propertyId === propertyId
      ? {
          revisionId: value["revisionId"].toLowerCase(),
          result: { ok: true, outcome: result["outcome"], design },
        }
      : null;
  }
  const error = result["error"];
  if (
    value["revisionId"] !== null ||
    !exact(error, ["code", "currentRevision"]) ||
    error["code"] !== "design_revision_conflict" ||
    !revision(error["currentRevision"], true)
  ) {
    return null;
  }
  return {
    revisionId: null,
    result: {
      ok: false,
      error: { code: "design_revision_conflict", currentRevision: error["currentRevision"] },
    },
  };
}

function projectDesign(row: DesignRow): BookingDesignRevision {
  const design = parseBookingDesignRevision({
    contractVersion: row.contractVersion,
    propertyId: row.propertyId,
    revision: row.revisionNumber,
    choices: { primaryColor: row.primaryColor, fontPairing: row.fontPairing },
    createdAt: iso(row.createdAt),
  });
  if (!design) throw new Error("Stored Booking design revision is invalid");
  return design;
}

function failure(
  code: "command_in_progress" | "idempotency_key_conflict" | "setup_scope_unavailable",
): BookingDesignCommandResult;
function failure(
  code: "design_revision_conflict",
  currentRevision: number,
): BookingDesignCommandResult;
function failure(code: string, currentRevision?: number): BookingDesignCommandResult {
  return code === "design_revision_conflict"
    ? { ok: false, error: { code, currentRevision: currentRevision! } }
    : {
        ok: false,
        error: {
          code: code as
            | "command_in_progress"
            | "idempotency_key_conflict"
            | "setup_scope_unavailable",
        },
      };
}

function responseStatus(result: BookingDesignCommandResult): 200 | 409 {
  return result.ok ? 200 : 409;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Stored Booking design date is invalid");
  return date.toISOString();
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function revision(value: unknown, zero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= (zero ? 0 : 1) &&
    (value as number) <= 2_147_483_647
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isPgLockTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55P03";
}

async function rollback(client: RepositoryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
