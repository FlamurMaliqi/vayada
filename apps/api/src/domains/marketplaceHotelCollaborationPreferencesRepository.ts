import { createHash, randomUUID } from "node:crypto";

import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX,
  createMarketplaceHotelCollaborationPreferencesEvidence,
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  parseReplaceMarketplaceHotelCollaborationPreferencesResult,
  serializeMarketplaceHotelCollaborationPreferencesSourceRevision,
  serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint,
  type MarketplaceHotelCollaborationPreferences,
  type MarketplaceHotelCollaborationPreferencesChangedEvent,
  type MarketplaceHotelCollaborationPreferencesCommandPort,
  type MarketplaceHotelCollaborationPreferencesReadOutcome,
  type MarketplaceHotelCollaborationPreferencesReadPort,
  type MarketplaceHotelCollaborationPreferencesRevision,
  type ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  type ReplaceMarketplaceHotelCollaborationPreferencesResult,
} from "@vayada/domain-marketplace";
import pg, { type QueryResult, type QueryResultRow } from "pg";

const OPERATION = "marketplace.hotel_collaboration_preferences.replace";
const RESOURCE_TYPE = "hotel_collaboration_preferences";

export type MarketplaceHotelCollaborationPreferencesClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type MarketplaceHotelCollaborationPreferencesPool = {
  connect(): Promise<MarketplaceHotelCollaborationPreferencesClient>;
  end(): Promise<void>;
};

export type MarketplaceHotelCollaborationPreferencesRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: MarketplaceHotelCollaborationPreferencesPool;
  now?: () => Date;
  randomId?: () => string;
};

export type MarketplaceHotelCollaborationPreferencesRepository =
  MarketplaceHotelCollaborationPreferencesCommandPort &
    MarketplaceHotelCollaborationPreferencesReadPort & {
      close(): Promise<void>;
    };

type PreferenceRow = {
  propertyId: string;
  organizationId: string;
  contractVersion: string;
  revision: number | string;
  compensationTypes: string[];
  contentPlatforms: string[];
  contentTypes: string[];
  availabilityMode: string;
  selectedMonths: number[];
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
  expiresAt: Date | string;
};

type IdempotencyReservation = { id: string; attempt: number };

export function createPgMarketplaceHotelCollaborationPreferencesRepository(
  config: MarketplaceHotelCollaborationPreferencesRepositoryConfig,
): MarketplaceHotelCollaborationPreferencesRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace preference repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: MarketplaceHotelCollaborationPreferencesPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  const makeId = config.randomId ?? randomUUID;

  return {
    async replaceHotelCollaborationPreferences(command) {
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("Marketplace preference clock is invalid");
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = sha256(
        serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint(command),
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedProfile(client, command, acceptedAt))) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }
        const current = await lockPreferenceAggregate(client, command);
        const replay = await findReplay(client, command, keyHash, fingerprint, acceptedAt);
        if (replay) {
          await rollbackQuietly(client);
          return replay;
        }
        const reservation = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!reservation) {
          const concurrent = await findReplay(client, command, keyHash, fingerprint, acceptedAt);
          await rollbackQuietly(client);
          return concurrent ?? failure({ code: "command_in_progress" });
        }

        const currentRevision = current ? asRevision(current.revision) : 0;
        if (currentRevision !== command.request.expectedRevision) {
          return finalizeConflict(
            client,
            command,
            reservation,
            keyHash,
            failure({ code: "preferences_revision_conflict", currentRevision }),
            acceptedAt,
          );
        }

        const saved = await persistPreferences(client, command, current, acceptedAt);
        const readModel = preferenceReadModel(saved);
        if (!readModel || readModel.preferences === null) {
          throw new Error("Marketplace preference write produced a malformed aggregate");
        }
        const result = requireResult({
          ok: true,
          response: { ...readModel, outcome: "updated", acceptedAt: acceptedAt.toISOString() },
        });
        const eventId = makeId();
        await insertChangedEvent(client, command, eventId, keyHash, readModel.revision, acceptedAt);
        await insertRequiredOutbox(
          client,
          command,
          makeId(),
          eventId,
          keyHash,
          readModel.revision,
          acceptedAt,
        );
        await recordAudit(client, command, reservation, keyHash, result, acceptedAt, eventId);
        await completeIdempotency(client, reservation.id, result, acceptedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async getHotelCollaborationPreferences(scope) {
      let client: MarketplaceHotelCollaborationPreferencesClient | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        const at = now();
        if (
          !validDate(at) ||
          !(await lockReadableProfile(client, scope.organizationId, scope.propertyId)) ||
          !(await hasActiveProfileEntitlement(client, scope.organizationId, scope.propertyId, at))
        ) {
          await rollbackQuietly(client);
          return unavailable();
        }
        const result = await client.query<PreferenceRow>(
          `SELECT ${PREFERENCE_COLUMNS}
           FROM marketplace.hotel_collaboration_preferences
           WHERE property_id = $1::uuid AND organization_id = $2::uuid
           FOR SHARE`,
          [scope.propertyId, scope.organizationId],
        );
        await client.query("COMMIT");
        if (result.rows.length > 1) return malformed();
        const readModel = result.rows[0]
          ? preferenceReadModel(result.rows[0])
          : missingReadModel(scope.propertyId);
        return readModel ? { outcome: "available", readModel } : malformed();
      } catch {
        if (client) await rollbackQuietly(client);
        return unavailable();
      } finally {
        client?.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function lockAuthorizedProfile(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  at: Date,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const policy = MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION;
  const scope = await client.query(
    `SELECT profile.property_id
     FROM marketplace.marketplace_hotel_profiles profile
     JOIN identity.organizations organization
       ON organization.id = profile.organization_id
      AND organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = $4
      AND resource.resource_type = $5
      AND resource.resource_id = profile.property_id::text
      AND resource.relationship = ANY($6::text[])
      AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $7
     WHERE profile.property_id = $2::uuid
     FOR UPDATE OF profile
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [
      command.organizationId,
      command.propertyId,
      command.audit.actor.userId,
      policy.resource.product,
      policy.resource.resourceType,
      [...policy.resource.allowedRelationships],
      policy.permission,
    ],
  );
  return (
    (scope.rowCount ?? 0) > 0 &&
    (await hasActiveProfileEntitlement(client, command.organizationId, command.propertyId, at))
  );
}

async function lockReadableProfile(
  client: MarketplaceHotelCollaborationPreferencesClient,
  organizationId: string,
  propertyId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT profile.property_id
     FROM marketplace.marketplace_hotel_profiles profile
     JOIN identity.organizations organization
       ON organization.id = profile.organization_id
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     WHERE profile.property_id = $1::uuid AND profile.organization_id = $2::uuid
     FOR SHARE OF profile, organization`,
    [propertyId, organizationId],
  );
  return result.rowCount === 1;
}

async function hasActiveProfileEntitlement(
  client: MarketplaceHotelCollaborationPreferencesClient,
  organizationId: string,
  propertyId: string,
  at: Date,
): Promise<boolean> {
  const policy = MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION.entitlement;
  const result = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid
       AND product = $3
       AND entitlement_key = $4
       AND (
         resource_product IS NULL
         OR (resource_product = $3 AND resource_type = $5 AND resource_id = $2::uuid::text)
       )
     FOR SHARE`,
    [organizationId, propertyId, policy.product, policy.key, policy.resourceType],
  );
  const applicable = result.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= at) &&
      (!row.expiresAt || new Date(row.expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function lockPreferenceAggregate(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
): Promise<PreferenceRow | null> {
  const result = await client.query<PreferenceRow>(
    `SELECT ${PREFERENCE_COLUMNS}
     FROM marketplace.hotel_collaboration_preferences
     WHERE property_id = $1::uuid AND organization_id = $2::uuid
     FOR UPDATE`,
    [command.propertyId, command.organizationId],
  );
  if (result.rows.length > 1) throw new Error("Marketplace preference aggregate is not unique");
  return result.rows[0] ?? null;
}

async function findReplay(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<ReplaceMarketplaceHotelCollaborationPreferencesResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata",
            expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return failure({ code: "idempotency_key_conflict" });
  }
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesResult(stored);
  if (!parsed) return failure({ code: "idempotency_key_conflict" });
  const successfulResource = parsed.ok
    ? existing.responseResourceProduct === "marketplace" &&
      existing.responseResourceType === RESOURCE_TYPE &&
      existing.responseResourceId === command.propertyId
    : existing.responseResourceProduct === null &&
      existing.responseResourceType === null &&
      existing.responseResourceId === null;
  return successfulResource &&
    existing.responseStatusCode === responseStatus(parsed) &&
    existing.responseBodyHash === sha256(JSON.stringify(responseBody(parsed)))
    ? parsed
    : failure({ code: "idempotency_key_conflict" });
}

async function reserveIdempotency(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
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
       'marketplace', $1, $2, $3, 'in_progress',
       'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '90 days',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       response_resource_product = NULL, response_resource_type = NULL,
       response_resource_id = NULL, correlation_id = EXCLUDED.correlation_id,
       first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
       completed_at = NULL, expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt', COALESCE((idempotency_keys.idempotency_metadata ->> 'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id,
       (idempotency_metadata ->> 'attempt')::integer AS attempt`,
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

async function persistPreferences(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  current: PreferenceRow | null,
  at: Date,
): Promise<PreferenceRow> {
  const values = [
    command.propertyId,
    command.organizationId,
    command.request.compensationTypes,
    command.request.contentPlatforms,
    command.request.contentTypes,
    command.request.availability.mode,
    command.request.availability.selectedMonths,
    command.audit.actor.userId,
    at.toISOString(),
  ];
  const result = current
    ? await client.query<PreferenceRow>(
        `UPDATE marketplace.hotel_collaboration_preferences
         SET revision = revision + 1, compensation_types = $3::text[],
             content_platforms = $4::text[], content_types = $5::text[],
             availability_mode = $6, selected_months = $7::smallint[],
             updated_by_user_id = $8::uuid, updated_at = $9::timestamptz
         WHERE property_id = $1::uuid AND organization_id = $2::uuid
           AND revision = $10
         RETURNING ${PREFERENCE_COLUMNS}`,
        [...values, command.request.expectedRevision],
      )
    : await client.query<PreferenceRow>(
        `INSERT INTO marketplace.hotel_collaboration_preferences (
           property_id, organization_id, contract_version, revision,
           compensation_types, content_platforms, content_types,
           availability_mode, selected_months, updated_by_user_id, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, '${MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION}', 1,
           $3::text[], $4::text[], $5::text[], $6, $7::smallint[], $8::uuid,
           $9::timestamptz, $9::timestamptz
         ) RETURNING ${PREFERENCE_COLUMNS}`,
        values,
      );
  const saved = result.rows[0];
  if (result.rowCount !== 1 || !saved) {
    throw new Error("Marketplace preference expected-revision write failed");
  }
  return saved;
}

async function insertChangedEvent(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  eventId: string,
  keyHash: string,
  revision: MarketplaceHotelCollaborationPreferencesRevision,
  at: Date,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, correlation_id,
       causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       $1::uuid, 'marketplace', $2, $3, 1, $4::timestamptz,
       'property', NULL, $5::uuid, 'marketplace', $6, $5::uuid::text,
       'user', $7::uuid, $8, $9, $10, $11::jsonb, $12::jsonb, 'confidential'
     )`,
    [
      eventId,
      `marketplace.hotel_collaboration_preferences.property.${command.propertyId}.revision.${revision}.changed.v1`,
      MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
      at.toISOString(),
      command.propertyId,
      RESOURCE_TYPE,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(changedPayload(eventId, command, revision)),
      JSON.stringify(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX.metadata),
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("Marketplace preference changed event insert failed");
  }
}

async function insertRequiredOutbox(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  outboxId: string,
  eventId: string,
  keyHash: string,
  revision: MarketplaceHotelCollaborationPreferencesRevision,
  at: Date,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, correlation_id, idempotency_key_hash,
       payload, outbox_metadata, available_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5,
       'property', NULL, $6::uuid, 'marketplace', $7, $6::uuid::text,
       $8, $9, $10::jsonb, $11::jsonb,
       $12::timestamptz, $12::timestamptz, $12::timestamptz
     )`,
    [
      outboxId,
      eventId,
      `marketplace.submission-source.hotel_collaboration_preferences.property.${command.propertyId}.revision.${revision}.v1`,
      MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX.destination,
      MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
      command.propertyId,
      RESOURCE_TYPE,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify(changedPayload(eventId, command, revision)),
      JSON.stringify(MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX.metadata),
      at.toISOString(),
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("Marketplace preference required outbox insert failed");
  }
}

async function finalizeConflict(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: ReplaceMarketplaceHotelCollaborationPreferencesResult,
  at: Date,
): Promise<ReplaceMarketplaceHotelCollaborationPreferencesResult> {
  await recordAudit(client, command, reservation, keyHash, result, at, null);
  await completeIdempotency(client, reservation.id, result, at);
  await client.query("COMMIT");
  return result;
}

async function recordAudit(
  client: MarketplaceHotelCollaborationPreferencesClient,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: ReplaceMarketplaceHotelCollaborationPreferencesResult,
  at: Date,
  eventId: string | null,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope,
       organization_id, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata, privacy_scope
     ) VALUES (
       $1, 'marketplace', $2, $3::timestamptz, 'property',
       NULL, $4::uuid, 'user', $5::uuid,
       'marketplace', $6, $4::uuid::text,
       $7::uuid, $8::uuid, $9, $10, $11::jsonb, $12::jsonb, 'confidential'
     )`,
    [
      `marketplace.hotel_collaboration_preferences.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      result.ok
        ? "marketplace.hotel_collaboration_preferences.updated"
        : "marketplace.hotel_collaboration_preferences.rejected",
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      RESOURCE_TYPE,
      eventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(
        result.ok
          ? changedPayload(eventId!, command, result.response.revision)
          : {
              organizationId: command.organizationId,
              propertyId: command.propertyId,
              ...result.error,
            },
      ),
      JSON.stringify({ sourceReadRequired: result.ok }),
    ],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("Marketplace preference audit insert failed");
  }
}

async function completeIdempotency(
  client: MarketplaceHotelCollaborationPreferencesClient,
  id: string,
  result: ReplaceMarketplaceHotelCollaborationPreferencesResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, completed_at = $7::timestamptz,
         last_seen_at = $7::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      responseStatus(result),
      sha256(JSON.stringify(responseBody(result))),
      result.ok ? "marketplace" : null,
      result.ok ? RESOURCE_TYPE : null,
      result.ok ? result.response.propertyId : null,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Marketplace preference idempotency completion failed");
  }
}

function preferenceReadModel(row: PreferenceRow) {
  try {
    const revision = asRevision(row.revision);
    const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
      expectedRevision: 0,
      compensationTypes: row.compensationTypes,
      contentPlatforms: row.contentPlatforms,
      contentTypes: row.contentTypes,
      availability: { mode: row.availabilityMode, selectedMonths: row.selectedMonths },
    });
    if (
      !parsed ||
      !sameArray(row.compensationTypes, parsed.compensationTypes) ||
      !sameArray(row.contentPlatforms, parsed.contentPlatforms) ||
      !sameArray(row.contentTypes, parsed.contentTypes) ||
      row.availabilityMode !== parsed.availability.mode ||
      !sameArray(row.selectedMonths, parsed.availability.selectedMonths)
    )
      return null;
    const preferences: MarketplaceHotelCollaborationPreferences = {
      compensationTypes: parsed.compensationTypes,
      contentPlatforms: parsed.contentPlatforms,
      contentTypes: parsed.contentTypes,
      availability: parsed.availability,
    };
    return parseMarketplaceHotelCollaborationPreferencesReadModel({
      contractVersion: row.contractVersion,
      propertyId: row.propertyId,
      revision,
      sourceRevision: serializeMarketplaceHotelCollaborationPreferencesSourceRevision(revision),
      preferences,
      readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
        row.propertyId,
        revision,
        preferences,
      ),
    });
  } catch {
    return null;
  }
}

function missingReadModel(propertyId: string) {
  return parseMarketplaceHotelCollaborationPreferencesReadModel({
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
    propertyId,
    revision: 0,
    sourceRevision: serializeMarketplaceHotelCollaborationPreferencesSourceRevision(0),
    preferences: null,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(propertyId, 0, null),
  });
}

function changedPayload(
  eventId: string,
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  revision: MarketplaceHotelCollaborationPreferencesRevision,
): MarketplaceHotelCollaborationPreferencesChangedEvent {
  return {
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
    eventType: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE,
    eventId,
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    preferenceRevision: revision,
    outcome: "updated",
  } as const;
}

function requireResult(value: unknown): ReplaceMarketplaceHotelCollaborationPreferencesResult {
  const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesResult(value);
  if (!parsed) throw new Error("Marketplace preference repository produced an invalid result");
  return parsed;
}

function failure(
  error: Extract<ReplaceMarketplaceHotelCollaborationPreferencesResult, { ok: false }>["error"],
): ReplaceMarketplaceHotelCollaborationPreferencesResult {
  return requireResult({ ok: false, error });
}

function responseStatus(result: ReplaceMarketplaceHotelCollaborationPreferencesResult): number {
  return result.ok ? 200 : 409;
}

function responseBody(result: ReplaceMarketplaceHotelCollaborationPreferencesResult) {
  return result.ok ? result.response : result.error;
}

function unavailable(): MarketplaceHotelCollaborationPreferencesReadOutcome {
  return {
    outcome: "unavailable",
    error: { code: "preference_source_unavailable", errorSource: "system", retryable: true },
  };
}

function malformed(): MarketplaceHotelCollaborationPreferencesReadOutcome {
  return {
    outcome: "malformed",
    error: { code: "preference_source_malformed", errorSource: "system", retryable: false },
  };
}

function asRevision(value: number | string): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw new Error("Marketplace preference revision is malformed");
  }
  return revision;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function rollbackQuietly(
  client: MarketplaceHotelCollaborationPreferencesClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

const PREFERENCE_COLUMNS = `
  property_id::text AS "propertyId",
  organization_id::text AS "organizationId",
  contract_version AS "contractVersion",
  revision,
  compensation_types AS "compensationTypes",
  content_platforms AS "contentPlatforms",
  content_types AS "contentTypes",
  availability_mode AS "availabilityMode",
  selected_months AS "selectedMonths"`;
