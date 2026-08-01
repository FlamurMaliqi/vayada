import { createHash } from "node:crypto";

import type { RequestAuditMetadata } from "@vayada/backend-auth";
import {
  getActivePropertySetupStepIds,
  PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  SETUP_TRACKS,
  type PropertySetupBaseRevisionKey,
  type SavePropertySetupDraftError,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
  type SavePropertySetupDraftResult,
  type SetupTrack,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PropertySetupDraftSaveCommand = {
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  idempotencyKey: string;
  audit: RequestAuditMetadata;
  /** Must be the normalized output of parseSavePropertySetupDraftRequest. */
  request: SavePropertySetupDraftRequest;
};

export type PropertySetupDraftCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PropertySetupDraftCommandPool = {
  connect(): Promise<PropertySetupDraftCommandClient>;
  end(): Promise<void>;
};

export type PropertySetupBaseRevisionLock = (
  client: PropertySetupDraftCommandClient,
  input: {
    organizationId: string;
    propertyId: string;
    stepId: SavePropertySetupDraftRequest["stepId"];
    revisionKeys: readonly PropertySetupBaseRevisionKey[];
  },
) => Promise<Partial<Record<PropertySetupBaseRevisionKey, string>>>;

export type PropertySetupDraftCommandRepositoryConfig = {
  connectionString: string;
  /**
   * Reads owner-issued revision tokens on this transaction's client and locks
   * their sources strongly enough to serialize concurrent canonical writes.
   * Owner adapters implement this port; this repository never queries another
   * domain's tables directly.
   */
  lockCurrentBaseRevisions: PropertySetupBaseRevisionLock;
  max?: number;
  pool?: PropertySetupDraftCommandPool;
  now?: () => Date;
};

type TrackIntentRow = {
  selectedTracks: SetupTrack[];
  revision: number;
};

type SessionRow = {
  sessionId: string;
  revision: number;
  retentionExpiresAt: Date | string;
};

type DraftRow = {
  revision: number;
  retentionExpiresAt: Date | string;
};

type SaveRow = {
  sessionId: string;
  sessionRevision: number;
  draftRevision: number;
  retentionExpiresAt: Date | string;
  updatedAt: Date | string;
};

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

const OPERATION = "hotel_setup.property_draft.save";

/**
 * Draft writes require a route adapter to enforce the step permission and
 * product entitlement first. This repository then re-proves the active actor,
 * membership, role grant, and canonical property link before any replay.
 * Neither a setup session nor an idempotency row is authorization evidence.
 */
export function createPgPropertySetupDraftCommandRepository(
  config: PropertySetupDraftCommandRepositoryConfig,
) {
  if (!config.connectionString.trim()) {
    throw new Error("Property setup draft command repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PropertySetupDraftCommandPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());

  return {
    async saveStepDraft(
      command: PropertySetupDraftSaveCommand,
    ): Promise<SavePropertySetupDraftResult> {
      const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find(
        ({ stepId }) => stepId === command.request.stepId,
      );
      if (!definition) return failure({ code: "inactive_setup_step", currentTrackRevision: 0 });
      const savedAt = now();
      const keyHash = sha256(
        stableJson({
          organizationId: command.organizationId,
          propertyId: command.propertyId,
          idempotencyKey: command.idempotencyKey,
        }),
      );
      const fingerprint = sha256(
        stableJson({
          organizationId: command.organizationId,
          propertyId: command.propertyId,
          request: command.request,
        }),
      );
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockOrganization(client, command.organizationId))) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }
        if (!(await lockAuthorizedScope(client, command, definition.permission))) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }
        await lockDraftScope(client, command.organizationId, command.propertyId);

        const replay = await findReplay(client, command, keyHash, fingerprint, savedAt);
        if (replay) {
          await rollbackQuietly(client);
          return replay;
        }
        const idempotency = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          savedAt,
        );
        if (!idempotency) {
          const concurrentReplay = await findReplay(client, command, keyHash, fingerprint, savedAt);
          await rollbackQuietly(client);
          return concurrentReplay ?? failure({ code: "command_in_progress" });
        }

        const intent = await lockTrackIntent(client, command.organizationId);
        if (!intent) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }
        const trackConflict = validateTrack(command, intent);
        if (trackConflict) {
          await finalizeConflict(client, command, idempotency, keyHash, trackConflict, savedAt);
          return trackConflict;
        }
        const currentBaseRevisions = await config.lockCurrentBaseRevisions(client, {
          organizationId: command.organizationId,
          propertyId: command.propertyId,
          stepId: command.request.stepId,
          revisionKeys: definition.baseRevisionKeys,
        });
        const earlyConflict = validateBaseRevisions(command, currentBaseRevisions);
        if (
          earlyConflict &&
          !earlyConflict.ok &&
          earlyConflict.error.code === "base_revision_unavailable"
        ) {
          await rollbackQuietly(client);
          return earlyConflict;
        }
        if (earlyConflict) {
          await finalizeConflict(client, command, idempotency, keyHash, earlyConflict, savedAt);
          return earlyConflict;
        }

        let session = await lockSession(client, command);
        if (session && isExpired(session.retentionExpiresAt, savedAt)) {
          if (
            command.request.expectedSessionRevision !== 0 ||
            command.request.expectedDraftRevision !== 0
          ) {
            const result = failure({
              code: "setup_session_expired",
              currentSessionRevision: session.revision,
            });
            await finalizeConflict(client, command, idempotency, keyHash, result, savedAt);
            return result;
          }
          await deleteSession(client, session.sessionId);
          session = null;
        }
        const sessionConflict = revisionConflict(
          "session_revision_conflict",
          command.request.expectedSessionRevision,
          session?.revision ?? 0,
        );
        if (sessionConflict) {
          await finalizeConflict(client, command, idempotency, keyHash, sessionConflict, savedAt);
          return sessionConflict;
        }

        let draft = session
          ? await lockDraft(client, session.sessionId, command.request.stepId)
          : null;
        if (draft && isExpired(draft.retentionExpiresAt, savedAt)) {
          if (command.request.expectedDraftRevision !== 0) {
            const result = failure({
              code: "setup_draft_expired",
              currentDraftRevision: draft.revision,
            });
            await finalizeConflict(client, command, idempotency, keyHash, result, savedAt);
            return result;
          }
          await deleteDraft(client, session!.sessionId, command.request.stepId);
          draft = null;
        }
        const draftConflict = revisionConflict(
          "draft_revision_conflict",
          command.request.expectedDraftRevision,
          draft?.revision ?? 0,
        );
        if (draftConflict) {
          await finalizeConflict(client, command, idempotency, keyHash, draftConflict, savedAt);
          return draftConflict;
        }

        const saved = await persistDraft(client, command, intent, session, draft, savedAt);
        const result: SavePropertySetupDraftResult = {
          ok: true,
          receipt: {
            contractVersion: PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
            sessionId: saved.sessionId,
            stepId: command.request.stepId,
            selectedTracks: intent.selectedTracks,
            trackRevision: intent.revision,
            sessionRevision: saved.sessionRevision,
            draftRevision: saved.draftRevision,
            retentionExpiresAt: toIso(saved.retentionExpiresAt),
            updatedAt: toIso(saved.updatedAt),
            replayed: false,
          },
        };
        await recordAudit(client, command, idempotency, keyHash, result, savedAt);
        await completeIdempotency(client, idempotency.id, result, savedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
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

export type PropertySetupDraftCommandRepository = ReturnType<
  typeof createPgPropertySetupDraftCommandRepository
>;

async function lockOrganization(
  client: PropertySetupDraftCommandClient,
  organizationId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM identity.organizations
     WHERE id = $1::uuid
       AND kind = 'hotel_group'
       AND status = 'active'
     FOR SHARE`,
    [organizationId],
  );
  return result.rowCount === 1;
}

async function lockAuthorizedScope(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  permission: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organization_resource_links property_link
       ON property_link.organization_id = $1::uuid
      AND property_link.product = 'hotel_catalog'
      AND property_link.resource_type = 'property'
      AND property_link.resource_id = property.id::text
      AND property_link.relationship IN ('owner', 'operator')
      AND property_link.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid
      AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = $1::uuid
      AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants role_grant
       ON role_grant.organization_kind = 'hotel_group'
      AND role_grant.role_key = membership.role_key
      AND role_grant.permission_key = $4
     WHERE property.id = $2::uuid
     FOR SHARE OF property, property_link, actor, membership
     FOR KEY SHARE OF role_grant`,
    [command.organizationId, command.propertyId, command.actorUserId, permission],
  );
  return (result.rowCount ?? 0) > 0;
}

async function lockDraftScope(
  client: PropertySetupDraftCommandClient,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('hotel_setup.property_draft:' || $1::uuid::text),
       hashtext($2::uuid::text)
     )`,
    [organizationId, propertyId],
  );
}

async function lockTrackIntent(
  client: PropertySetupDraftCommandClient,
  organizationId: string,
): Promise<TrackIntentRow | null> {
  const result = await client.query<TrackIntentRow>(
    `SELECT selected_tracks AS "selectedTracks", revision
     FROM hotel_catalog.organization_setup_track_intents
     WHERE organization_id = $1::uuid
     FOR SHARE`,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

function validateTrack(
  command: PropertySetupDraftSaveCommand,
  intent: TrackIntentRow,
): SavePropertySetupDraftResult | null {
  if (command.request.expectedTrackRevision !== intent.revision) {
    return failure({ code: "track_revision_conflict", currentTrackRevision: intent.revision });
  }
  if (!getActivePropertySetupStepIds(intent.selectedTracks).includes(command.request.stepId)) {
    return failure({ code: "inactive_setup_step", currentTrackRevision: intent.revision });
  }
  return null;
}

function validateBaseRevisions(
  command: PropertySetupDraftSaveCommand,
  currentBaseRevisions: Partial<Record<PropertySetupBaseRevisionKey, string>>,
): SavePropertySetupDraftResult | null {
  const expected = command.request.expectedBaseRevisions as Record<string, string>;
  const unavailable = Object.keys(expected).filter(
    (key) =>
      typeof currentBaseRevisions[key as PropertySetupBaseRevisionKey] !== "string" ||
      currentBaseRevisions[key as PropertySetupBaseRevisionKey]!.length === 0,
  ) as PropertySetupBaseRevisionKey[];
  if (unavailable.length > 0) {
    return failure({
      code: "base_revision_unavailable",
      unavailableBaseRevisionKeys: unavailable,
    });
  }
  const conflicting = Object.entries(expected)
    .filter(
      ([key, revision]) => currentBaseRevisions[key as PropertySetupBaseRevisionKey] !== revision,
    )
    .map(([key]) => key as PropertySetupBaseRevisionKey);
  return conflicting.length > 0
    ? failure({ code: "base_revision_conflict", conflictingBaseRevisionKeys: conflicting })
    : null;
}

async function lockSession(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT
       id::text AS "sessionId",
       revision,
       retention_expires_at AS "retentionExpiresAt"
     FROM hotel_catalog.property_setup_sessions
     WHERE organization_id = $1::uuid
       AND property_id = $2::uuid
       AND status = 'active'
     FOR UPDATE`,
    [command.organizationId, command.propertyId],
  );
  return result.rows[0] ?? null;
}

async function lockDraft(
  client: PropertySetupDraftCommandClient,
  sessionId: string,
  stepId: string,
): Promise<DraftRow | null> {
  const result = await client.query<DraftRow>(
    `SELECT revision, retention_expires_at AS "retentionExpiresAt"
     FROM hotel_catalog.property_setup_step_drafts
     WHERE session_id = $1::uuid
       AND step_id = $2
     FOR UPDATE`,
    [sessionId, stepId],
  );
  return result.rows[0] ?? null;
}

async function deleteSession(
  client: PropertySetupDraftCommandClient,
  sessionId: string,
): Promise<void> {
  await client.query(`DELETE FROM hotel_catalog.property_setup_sessions WHERE id = $1::uuid`, [
    sessionId,
  ]);
}

async function deleteDraft(
  client: PropertySetupDraftCommandClient,
  sessionId: string,
  stepId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM hotel_catalog.property_setup_step_drafts
     WHERE session_id = $1::uuid AND step_id = $2`,
    [sessionId, stepId],
  );
}

async function persistDraft(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  intent: TrackIntentRow,
  session: SessionRow | null,
  draft: DraftRow | null,
  savedAt: Date,
): Promise<SaveRow> {
  const sessionResult = session
    ? await client.query<{ sessionId: string; sessionRevision: number }>(
        `UPDATE hotel_catalog.property_setup_sessions
         SET selected_tracks = $2::text[],
             track_revision = $3,
             revision = revision + 1,
             resume_step_id = $4,
             retention_expires_at =
               $5::timestamptz + make_interval(days => $6::integer),
             updated_at = $5::timestamptz
         WHERE id = $1::uuid
           AND revision = $7
         RETURNING id::text AS "sessionId", revision AS "sessionRevision"`,
        [
          session.sessionId,
          intent.selectedTracks,
          intent.revision,
          command.request.stepId,
          savedAt.toISOString(),
          PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
          session.revision,
        ],
      )
    : await client.query<{ sessionId: string; sessionRevision: number }>(
        `INSERT INTO hotel_catalog.property_setup_sessions (
           organization_id,
           property_id,
           selected_tracks,
           track_revision,
           revision,
           resume_step_id,
           retention_expires_at,
           created_at,
           updated_at
         )
         VALUES (
           $1::uuid,
           $2::uuid,
           $3::text[],
           $4,
           1,
           $5,
           $6::timestamptz + make_interval(days => $7::integer),
           $6::timestamptz,
           $6::timestamptz
         )
         RETURNING id::text AS "sessionId", revision AS "sessionRevision"`,
        [
          command.organizationId,
          command.propertyId,
          intent.selectedTracks,
          intent.revision,
          command.request.stepId,
          savedAt.toISOString(),
          PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
        ],
      );
  const savedSession = sessionResult.rows[0];
  if (!savedSession) throw new Error("Property setup session save failed");

  const draftResult = draft
    ? await client.query<SaveRow>(
        `UPDATE hotel_catalog.property_setup_step_drafts
         SET revision = revision + 1,
             payload = $3::jsonb,
             dirty_fields = $4::text[],
             base_revisions = $5::jsonb,
             retention_expires_at =
               $6::timestamptz + make_interval(days => $7::integer),
             updated_at = $6::timestamptz
         WHERE session_id = $1::uuid
           AND step_id = $2
           AND revision = $9
         RETURNING
           session_id::text AS "sessionId",
           $8::integer AS "sessionRevision",
           revision AS "draftRevision",
           retention_expires_at AS "retentionExpiresAt",
           updated_at AS "updatedAt"`,
        [
          savedSession.sessionId,
          command.request.stepId,
          JSON.stringify(command.request.payload),
          command.request.dirtyFields,
          JSON.stringify(command.request.expectedBaseRevisions),
          savedAt.toISOString(),
          PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
          savedSession.sessionRevision,
          draft.revision,
        ],
      )
    : await client.query<SaveRow>(
        `INSERT INTO hotel_catalog.property_setup_step_drafts (
           session_id,
           step_id,
           revision,
           payload,
           dirty_fields,
           base_revisions,
           pii_classification,
           retention_expires_at,
           created_at,
           updated_at
         )
         VALUES (
           $1::uuid,
           $2,
           1,
           $3::jsonb,
           $4::text[],
           $5::jsonb,
           $6,
           $7::timestamptz + make_interval(days => $8::integer),
           $7::timestamptz,
           $7::timestamptz
         )
         RETURNING
           session_id::text AS "sessionId",
           $9::integer AS "sessionRevision",
           revision AS "draftRevision",
           retention_expires_at AS "retentionExpiresAt",
           updated_at AS "updatedAt"`,
        [
          savedSession.sessionId,
          command.request.stepId,
          JSON.stringify(command.request.payload),
          command.request.dirtyFields,
          JSON.stringify(command.request.expectedBaseRevisions),
          PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
          savedAt.toISOString(),
          PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
          savedSession.sessionRevision,
        ],
      );
  const savedDraft = draftResult.rows[0];
  if (!savedDraft) throw new Error("Property setup step draft save failed");
  return savedDraft;
}

async function findReplay(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  keyHash: string,
  fingerprint: string,
  savedAt: Date,
): Promise<SavePropertySetupDraftResult | null> {
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
     WHERE operation_scope = 'hotel_catalog'
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
  if (isExpired(existing.expiresAt, savedAt)) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return failure({ code: "idempotency_key_conflict" });
  }
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  if (!isSaveResult(stored)) return failure({ code: "idempotency_key_conflict" });
  if (
    existing.responseStatusCode !== idempotencyResponseStatus(stored) ||
    existing.responseBodyHash !== sha256(stableJson(idempotencyResponseBody(stored)))
  ) {
    return failure({ code: "idempotency_key_conflict" });
  }
  return stored.ok ? { ok: true, receipt: { ...stored.receipt, replayed: true } } : stored;
}

async function reserveIdempotency(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  keyHash: string,
  fingerprint: string,
  savedAt: Date,
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
       'hotel_catalog',
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
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      savedAt.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PropertySetupDraftCommandClient,
  id: string,
  result: SavePropertySetupDraftResult,
  savedAt: Date,
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
      idempotencyResponseStatus(result),
      sha256(stableJson(idempotencyResponseBody(result))),
      savedAt.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Property setup draft idempotency completion failed");
  }
}

function idempotencyResponseBody(
  result: SavePropertySetupDraftResult,
): SavePropertySetupDraftReceipt | SavePropertySetupDraftError {
  return result.ok ? result.receipt : result.error;
}

function idempotencyResponseStatus(result: SavePropertySetupDraftResult): 200 | 409 {
  return result.ok ? 200 : 409;
}

async function recordAudit(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  idempotency: IdempotencyReservation,
  keyHash: string,
  result: SavePropertySetupDraftResult,
  savedAt: Date,
): Promise<void> {
  const outcome = result.ok
    ? {
        ok: true,
        sessionRevision: result.receipt.sessionRevision,
        draftRevision: result.receipt.draftRevision,
      }
    : { ok: false, error: result.error };
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
       'hotel_catalog',
       'hotel_setup.property_draft.save',
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       'user',
       $4::uuid,
       'hotel_catalog',
       'property_setup_step_draft',
       $5,
       $6::uuid,
       $7,
       $8,
       $9::jsonb,
       '{}'::jsonb,
       $10::jsonb,
       'confidential'
     )`,
    [
      `hotel_setup.property_draft.property.${command.propertyId}.key.${keyHash}.attempt.${idempotency.attempt}.v1`,
      savedAt.toISOString(),
      command.propertyId,
      command.actorUserId,
      result.ok
        ? `${result.receipt.sessionId}:${command.request.stepId}`
        : `${command.propertyId}:${command.request.stepId}`,
      idempotency.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({
        stepId: command.request.stepId,
        payloadFieldIds: Object.keys(command.request.payload),
        dirtyFields: command.request.dirtyFields,
        baseRevisionKeys: Object.keys(command.request.expectedBaseRevisions),
        expectedTrackRevision: command.request.expectedTrackRevision,
        expectedSessionRevision: command.request.expectedSessionRevision,
        expectedDraftRevision: command.request.expectedDraftRevision,
        outcome,
      }),
      JSON.stringify({
        source: command.audit.source,
        requestId: command.audit.requestId,
        actorOrganizationId: command.organizationId,
      }),
    ],
  );
}

async function finalizeConflict(
  client: PropertySetupDraftCommandClient,
  command: PropertySetupDraftSaveCommand,
  idempotency: IdempotencyReservation,
  keyHash: string,
  result: SavePropertySetupDraftResult,
  savedAt: Date,
): Promise<void> {
  await recordAudit(client, command, idempotency, keyHash, result, savedAt);
  await completeIdempotency(client, idempotency.id, result, savedAt);
  await client.query("COMMIT");
}

function revisionConflict(
  code: "session_revision_conflict" | "draft_revision_conflict",
  expected: number,
  current: number,
): SavePropertySetupDraftResult | null {
  if (expected === current) return null;
  return code === "session_revision_conflict"
    ? failure({ code, currentSessionRevision: current })
    : failure({ code, currentDraftRevision: current });
}

function failure(error: SavePropertySetupDraftError): SavePropertySetupDraftResult {
  return { ok: false, error };
}

function isExpired(value: Date | string, now: Date): boolean {
  return new Date(value) <= now;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isSaveResult(value: unknown): value is SavePropertySetupDraftResult {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return false;
  if (value["ok"] === false) {
    return hasExactKeys(value, ["ok", "error"]) && isSaveError(value["error"]);
  }
  const receipt = value["receipt"];
  return (
    hasExactKeys(value, ["ok", "receipt"]) &&
    isRecord(receipt) &&
    hasExactKeys(receipt, [
      "contractVersion",
      "sessionId",
      "stepId",
      "selectedTracks",
      "trackRevision",
      "sessionRevision",
      "draftRevision",
      "retentionExpiresAt",
      "updatedAt",
      "replayed",
    ]) &&
    receipt["contractVersion"] === PROPERTY_SETUP_DRAFT_CONTRACT_VERSION &&
    typeof receipt["sessionId"] === "string" &&
    PROPERTY_SETUP_STEP_DEFINITIONS.some(({ stepId }) => stepId === receipt["stepId"]) &&
    Array.isArray(receipt["selectedTracks"]) &&
    isSelectedTracks(receipt["selectedTracks"]) &&
    isPositiveRevision(receipt["trackRevision"]) &&
    isPositiveRevision(receipt["sessionRevision"]) &&
    isPositiveRevision(receipt["draftRevision"]) &&
    isIsoDate(receipt["retentionExpiresAt"]) &&
    isIsoDate(receipt["updatedAt"]) &&
    typeof receipt["replayed"] === "boolean"
  );
}

function isSaveError(value: unknown): value is SavePropertySetupDraftError {
  if (!isRecord(value) || typeof value["code"] !== "string") return false;
  switch (value["code"]) {
    case "inactive_setup_step":
    case "track_revision_conflict":
      return (
        hasExactKeys(value, ["code", "currentTrackRevision"]) &&
        isRevision(value["currentTrackRevision"])
      );
    case "session_revision_conflict":
    case "setup_session_expired":
      return (
        hasExactKeys(value, ["code", "currentSessionRevision"]) &&
        isRevision(value["currentSessionRevision"])
      );
    case "draft_revision_conflict":
    case "setup_draft_expired":
      return (
        hasExactKeys(value, ["code", "currentDraftRevision"]) &&
        isRevision(value["currentDraftRevision"])
      );
    case "base_revision_conflict":
      return (
        hasExactKeys(value, ["code", "conflictingBaseRevisionKeys"]) &&
        isBaseRevisionKeyList(value["conflictingBaseRevisionKeys"])
      );
    case "base_revision_unavailable":
    case "setup_scope_unavailable":
    case "idempotency_key_conflict":
    case "command_in_progress":
      // These results are deliberately never completed into idempotency storage.
      return false;
    default:
      return false;
  }
}

function isSelectedTracks(value: unknown[]): value is SetupTrack[] {
  return (
    value.length >= 1 &&
    value.length <= SETUP_TRACKS.length &&
    value.every(
      (track) => typeof track === "string" && SETUP_TRACKS.includes(track as SetupTrack),
    ) &&
    new Set(value).size === value.length
  );
}

function isBaseRevisionKeyList(value: unknown): value is PropertySetupBaseRevisionKey[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    return false;
  }
  const allowed = new Set<string>(
    PROPERTY_SETUP_STEP_DEFINITIONS.flatMap(({ baseRevisionKeys }) => [...baseRevisionKeys]),
  );
  return value.every((key) => typeof key === "string" && allowed.has(key));
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function rollbackQuietly(client: PropertySetupDraftCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
