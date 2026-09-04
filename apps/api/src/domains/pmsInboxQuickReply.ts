import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  parseStaffPermissionOverrides,
  validateStaffPermissionOverrides,
} from "@vayada/backend-auth";

import type {
  PmsInboxQuickReply,
  PmsInboxQuickReplyError,
  PmsInboxQuickReplyPort,
} from "./pmsInbox.js";

export type PmsInboxQuickReplyClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxQuickReplyPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsInboxQuickReplyClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxQuickReplyPort = PmsInboxQuickReplyPort & { close(): Promise<void> };

type CreateInput = Parameters<PmsInboxQuickReplyPort["create"]>[0];
type UpdateInput = Parameters<PmsInboxQuickReplyPort["update"]>[0];
type ArchiveInput = Parameters<PmsInboxQuickReplyPort["archive"]>[0];
type PreviewInput = Parameters<PmsInboxQuickReplyPort["preview"]>[0];
type MutationInput = CreateInput | UpdateInput | ArchiveInput | PreviewInput;
type CreateResult = Awaited<ReturnType<PmsInboxQuickReplyPort["create"]>>;
type UpdateResult = Awaited<ReturnType<PmsInboxQuickReplyPort["update"]>>;
type ArchiveResult = Awaited<ReturnType<PmsInboxQuickReplyPort["archive"]>>;
type PreviewResult = Awaited<ReturnType<PmsInboxQuickReplyPort["preview"]>>;
type MutationResult = CreateResult | UpdateResult | ArchiveResult | PreviewResult;

type QuickReplyRow = {
  propertyId: string;
  id: string;
  name: string;
  text: string;
  approvedVariables: string[];
  version: string | number;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt?: Date | string | null;
};
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
type InsertedIdRow = { id: string };
type ScopeRow = {
  propertyAccessMode: string;
  roleKey: string;
  permissionOverrides: unknown;
};
type PermissionRow = { permissionKey: string };
type ThreadContextRow = {
  propertyName: string;
  guestFirstName: string | null;
  guestFullName: string | null;
  bookingReference: string | null;
  sourceReference: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  nights: string | number | null;
};

const CREATE_OPERATION = "pms.inbox.quick_reply.create";
const UPDATE_OPERATION = "pms.inbox.quick_reply.update";
const ARCHIVE_OPERATION = "pms.inbox.quick_reply.archive";
const PREVIEW_OPERATION = "pms.inbox.quick_reply.preview";
const MAX_RENDERED_TEXT_LENGTH = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE = /^[a-z][a-z0-9_]{0,99}$/;
const PLACEHOLDER = /{{\s*([^{}]*?)\s*}}/g;

const QUICK_REPLY_COLUMNS = `property_id::text AS "propertyId", id::text AS id, name,
  body_template AS text, approved_variables AS "approvedVariables", version,
  created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt"`;

export function createPgPmsInboxQuickReplyPort(config: {
  connectionString: string;
  pool?: PmsInboxQuickReplyPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxQuickReplyPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox quick-reply connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxQuickReplyPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async list(input) {
      if (!UUID.test(input.propertyId)) throw new Error("PMS Inbox quick-reply scope is invalid");
      const result = await pool.query<QuickReplyRow>(
        `SELECT ${QUICK_REPLY_COLUMNS}
         FROM pms.message_quick_replies
         WHERE property_id = $1::uuid AND archived_at IS NULL
         ORDER BY lower(name), id`,
        [input.propertyId],
      );
      return result.rows.map(toQuickReply);
    },

    async create(rawInput) {
      const input = normalizeCreate(rawInput);
      if (!input) return failure("validation_failed", "Inbox quick-reply payload is invalid.");
      return runMutation(
        pool,
        now,
        CREATE_OPERATION,
        input,
        createFingerprint(input),
        async (client, acceptedAt) => {
          await lockQuickReplyName(client, input.propertyId, input.name);
          if (await activeNameExists(client, input.propertyId, input.name))
            return failure(
              "quick_reply_name_conflict",
              "An active quick reply already uses this name.",
            );
          const row = await client.query<QuickReplyRow>(
            `INSERT INTO pms.message_quick_replies
             (property_id, name, body_template, approved_variables,
              created_by_membership_id, updated_by_membership_id, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4::text[], $5::uuid, $5::uuid,
                   $6::timestamptz, $6::timestamptz)
           RETURNING ${QUICK_REPLY_COLUMNS}`,
            [
              input.propertyId,
              input.name,
              input.text,
              input.approvedVariables,
              input.actorMembershipId,
              acceptedAt,
            ],
          );
          const quickReply = row.rows[0] ? toQuickReply(row.rows[0]) : null;
          if (!quickReply || quickReply.version !== 1)
            throw new Error("PMS Inbox quick reply was not created once");
          return { ok: true, value: { propertyId: input.propertyId, quickReply } };
        },
      );
    },

    async update(rawInput) {
      const input = normalizeUpdate(rawInput);
      if (!input) return failure("validation_failed", "Inbox quick-reply update is invalid.");
      return runMutation(
        pool,
        now,
        UPDATE_OPERATION,
        input,
        updateFingerprint(input),
        async (client, acceptedAt) => {
          const current = await lockQuickReply(client, input.propertyId, input.quickReplyId);
          if (!current) return failure("quick_reply_not_found", "Inbox quick reply was not found.");
          const currentVersion = safeVersion(current.version);
          if (currentVersion !== input.expectedVersion)
            return failure(
              "quick_reply_version_conflict",
              "The quick reply changed. Refresh and try again.",
              currentVersion,
            );
          await lockQuickReplyName(client, input.propertyId, input.name);
          if (await activeNameExists(client, input.propertyId, input.name, input.quickReplyId))
            return failure(
              "quick_reply_name_conflict",
              "An active quick reply already uses this name.",
            );
          const row = await client.query<QuickReplyRow>(
            `UPDATE pms.message_quick_replies
           SET name = $3, body_template = $4, approved_variables = $5::text[],
               version = version + 1, updated_by_membership_id = $6::uuid,
               updated_at = $7::timestamptz
           WHERE property_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
             AND version = $8
           RETURNING ${QUICK_REPLY_COLUMNS}`,
            [
              input.propertyId,
              input.quickReplyId,
              input.name,
              input.text,
              input.approvedVariables,
              input.actorMembershipId,
              acceptedAt,
              input.expectedVersion,
            ],
          );
          const quickReply = row.rows[0] ? toQuickReply(row.rows[0]) : null;
          if (!quickReply || quickReply.version !== input.expectedVersion + 1)
            throw new Error("PMS Inbox quick reply was not updated once");
          return { ok: true, value: { propertyId: input.propertyId, quickReply } };
        },
      );
    },

    async archive(rawInput) {
      const input = normalizeArchive(rawInput);
      if (!input) return failure("validation_failed", "Inbox quick-reply archive is invalid.");
      return runMutation(
        pool,
        now,
        ARCHIVE_OPERATION,
        input,
        archiveFingerprint(input),
        async (client, acceptedAt) => {
          const current = await lockQuickReply(client, input.propertyId, input.quickReplyId);
          if (!current) return failure("quick_reply_not_found", "Inbox quick reply was not found.");
          const currentVersion = safeVersion(current.version);
          if (currentVersion !== input.expectedVersion)
            return failure(
              "quick_reply_version_conflict",
              "The quick reply changed. Refresh and try again.",
              currentVersion,
            );
          const row = await client.query<{ version: string | number; archivedAt: Date | string }>(
            `UPDATE pms.message_quick_replies
           SET archived_at = $3::timestamptz, archived_by_membership_id = $4::uuid,
               version = version + 1, updated_by_membership_id = $4::uuid,
               updated_at = $3::timestamptz
           WHERE property_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
             AND version = $5
           RETURNING version, archived_at AS "archivedAt"`,
            [
              input.propertyId,
              input.quickReplyId,
              acceptedAt,
              input.actorMembershipId,
              input.expectedVersion,
            ],
          );
          const version = safeVersion(row.rows[0]?.version);
          if (version !== input.expectedVersion + 1 || !row.rows[0])
            throw new Error("PMS Inbox quick reply was not archived once");
          return {
            ok: true,
            value: {
              propertyId: input.propertyId,
              quickReplyId: input.quickReplyId,
              version,
              archivedAt: new Date(row.rows[0].archivedAt).toISOString(),
            },
          };
        },
      );
    },

    async preview(rawInput) {
      const input = normalizePreview(rawInput);
      if (!input) return failure("validation_failed", "Inbox quick-reply preview is invalid.");
      return runMutation(
        pool,
        now,
        PREVIEW_OPERATION,
        input,
        previewFingerprint(input),
        async (client) => {
          const quickReply = await client.query<QuickReplyRow>(
            `SELECT ${QUICK_REPLY_COLUMNS}
           FROM pms.message_quick_replies
           WHERE property_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL`,
            [input.propertyId, input.quickReplyId],
          );
          const row = quickReply.rows[0];
          if (!row) return failure("quick_reply_not_found", "Inbox quick reply was not found.");
          const context = await client.query<ThreadContextRow>(
            `SELECT property.display_name AS "propertyName",
                COALESCE(NULLIF(BTRIM(guest.first_name), ''),
                         split_part(NULLIF(BTRIM(thread.guest_display_name), ''), ' ', 1))
                  AS "guestFirstName",
                COALESCE(NULLIF(BTRIM(CONCAT_WS(' ', guest.first_name, guest.last_name)), ''),
                         NULLIF(BTRIM(thread.guest_display_name), '')) AS "guestFullName",
                booking.public_reference AS "bookingReference",
                COALESCE(NULLIF(BTRIM(thread.source_booking_id), ''),
                         NULLIF(BTRIM(thread.source_thread_id), '')) AS "sourceReference",
                COALESCE(booking.check_in, thread.inquiry_arrival_date)::text AS "arrivalDate",
                COALESCE(booking.check_out, thread.inquiry_departure_date)::text AS "departureDate",
                CASE
                  WHEN COALESCE(booking.check_in, thread.inquiry_arrival_date) IS NOT NULL
                   AND COALESCE(booking.check_out, thread.inquiry_departure_date) IS NOT NULL
                  THEN COALESCE(booking.check_out, thread.inquiry_departure_date)
                     - COALESCE(booking.check_in, thread.inquiry_arrival_date)
                END AS nights
         FROM pms.message_threads thread
         JOIN hotel_catalog.properties property ON property.id = thread.property_id
         LEFT JOIN booking.guest_bookings booking
           ON booking.id = thread.guest_booking_id AND booking.property_id = thread.property_id
         LEFT JOIN LATERAL (
           SELECT booking_guest.first_name, booking_guest.last_name
           FROM booking.booking_guests booking_guest
           WHERE booking_guest.guest_booking_id = booking.id
           ORDER BY CASE booking_guest.guest_role
             WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
             booking_guest.created_at, booking_guest.id
           LIMIT 1
         ) guest ON TRUE
           WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid`,
            [input.propertyId, input.threadId],
          );
          if (!context.rows[0]) return failure("thread_not_found", "Inbox thread was not found.");
          const rendered = renderQuickReply(
            row.text,
            new Set(row.approvedVariables),
            quickReplyVariables(context.rows[0]),
          );
          if (rendered.text.length > MAX_RENDERED_TEXT_LENGTH)
            return failure(
              "validation_failed",
              "Rendered Inbox quick reply exceeds the maximum length.",
            );
          return {
            ok: true,
            value: {
              propertyId: input.propertyId,
              quickReplyId: input.quickReplyId,
              threadId: input.threadId,
              renderedText: rendered.text,
              unresolvedVariables: rendered.unresolved,
              composerUseAllowed: rendered.unresolved.length === 0,
            },
          };
        },
      );
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox quick-reply pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

async function runMutation<T extends MutationResult>(
  pool: PmsInboxQuickReplyPool,
  now: () => Date,
  operation: string,
  input: MutationInput,
  fingerprint: string,
  mutate: (client: PmsInboxQuickReplyClient, acceptedAt: Date) => Promise<T>,
): Promise<T> {
  const acceptedAt = acceptedInstant(now);
  const keyHash = sha256(input.idempotencyKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockActorScope(client, input, acceptedAt)))
      throw new Error("PMS Inbox quick-reply actor scope is unavailable");
    const replay = await findReplay(client, operation, input, keyHash, fingerprint);
    if (replay) return await rollbackResult(client, replay as T);
    const idempotencyId = await reserveIdempotency(
      client,
      operation,
      input,
      keyHash,
      fingerprint,
      acceptedAt,
    );
    if (!idempotencyId) {
      const concurrent = await findReplay(client, operation, input, keyHash, fingerprint);
      return await rollbackResult(
        client,
        (concurrent ??
          failure("idempotency_conflict", "This quick-reply command is in progress.")) as T,
      );
    }
    const result = await mutate(client, acceptedAt);
    if (result.ok)
      await insertEvidence(client, operation, input, result, idempotencyId, keyHash, acceptedAt);
    await completeIdempotency(client, operation, idempotencyId, result, acceptedAt);
    await client.query("COMMIT");
    return result;
  } catch {
    await rollbackQuietly(client);
    throw new Error(
      operation === PREVIEW_OPERATION
        ? "PMS Inbox quick-reply preview failed"
        : "PMS Inbox quick-reply command failed",
    );
  } finally {
    releaseQuietly(client);
  }
}

function normalizeCreate(input: CreateInput): CreateInput | null {
  const fields = normalizeFields(input);
  return validMutationBase(input) && fields
    ? { ...input, ...fields, idempotencyKey: input.idempotencyKey.trim() }
    : null;
}

function normalizeUpdate(input: UpdateInput): UpdateInput | null {
  const fields = normalizeFields(input);
  return validMutationBase(input) &&
    UUID.test(input.quickReplyId) &&
    validVersion(input.expectedVersion) &&
    fields
    ? { ...input, ...fields, idempotencyKey: input.idempotencyKey.trim() }
    : null;
}

function normalizeArchive(input: ArchiveInput): ArchiveInput | null {
  return validMutationBase(input) &&
    UUID.test(input.quickReplyId) &&
    validVersion(input.expectedVersion)
    ? { ...input, idempotencyKey: input.idempotencyKey.trim() }
    : null;
}

function normalizePreview(input: PreviewInput): PreviewInput | null {
  return validMutationBase(input) && UUID.test(input.quickReplyId) && UUID.test(input.threadId)
    ? { ...input, idempotencyKey: input.idempotencyKey.trim() }
    : null;
}

function normalizeFields(input: {
  name: string;
  text: string;
  approvedVariables: readonly string[];
}): {
  name: string;
  text: string;
  approvedVariables: string[];
} | null {
  const name = input.name.trim();
  const text = input.text.trim();
  if (
    !name ||
    name.length > 200 ||
    !text ||
    text.length > 20_000 ||
    input.approvedVariables.length > 100 ||
    input.approvedVariables.some((variable) => !VARIABLE.test(variable)) ||
    new Set(input.approvedVariables).size !== input.approvedVariables.length
  )
    return null;
  return { name, text, approvedVariables: [...input.approvedVariables] };
}

function validMutationBase(input: MutationInput | PreviewInput): boolean {
  return (
    UUID.test(input.propertyId) &&
    UUID.test(input.organizationId) &&
    UUID.test(input.actorUserId) &&
    UUID.test(input.actorMembershipId) &&
    Boolean(input.idempotencyKey.trim()) &&
    input.idempotencyKey.length <= 200 &&
    Boolean(input.audit.requestId.trim()) &&
    Boolean(input.audit.correlationId.trim()) &&
    validInstant(input.audit.requestedAt)
  );
}

async function lockActorScope(
  client: PmsInboxQuickReplyClient,
  input: MutationInput | PreviewInput,
  acceptedAt: Date,
): Promise<boolean> {
  const scope = await client.query<ScopeRow>(
    `SELECT membership.property_access_mode AS "propertyAccessMode",
            membership.role_key AS "roleKey",
            membership.permission_overrides AS "permissionOverrides"
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'pms' AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator', 'front_desk')
      AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.id = $4::uuid AND membership.organization_id = organization.id
      AND membership.user_id = actor.id AND membership.status = 'active'
     WHERE property.id = $2::uuid
       AND (membership.property_access_mode = 'all' OR EXISTS (
         SELECT 1 FROM identity.membership_property_assignments assignment
         WHERE assignment.membership_id = membership.id AND assignment.property_id = property.id
       ))
     FOR SHARE OF property, organization, resource, actor, membership`,
    [input.organizationId, input.propertyId, input.actorUserId, input.actorMembershipId],
  );
  const actor = scope.rows[0];
  if (!actor) return false;
  if (actor.propertyAccessMode === "assigned") {
    const assignment = await client.query(
      `SELECT 1 FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid FOR SHARE`,
      [input.actorMembershipId, input.propertyId],
    );
    if (!assignment.rows[0]) return false;
  }
  const permissionRows = await client.query<PermissionRow>(
    `SELECT permission_key AS "permissionKey"
     FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1
     FOR SHARE`,
    [actor.roleKey],
  );
  const rolePermissions = permissionRows.rows.map((row) => row.permissionKey);
  const effectivePermissions = new Set(rolePermissions);
  if (actor.permissionOverrides !== null && actor.permissionOverrides !== undefined) {
    const overrides = parseStaffPermissionOverrides(actor.permissionOverrides);
    if (
      !overrides ||
      validateStaffPermissionOverrides({
        roleKey: actor.roleKey,
        rolePermissions,
        permissionOverrides: overrides,
      }).length > 0
    )
      return false;
    for (const permission of overrides.grant) effectivePermissions.add(permission);
    for (const permission of overrides.deny) effectivePermissions.delete(permission);
  }
  if (!effectivePermissions.has("pms.inbox.read") || !effectivePermissions.has("pms.inbox.reply"))
    return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = 'pms'
       AND entitlement_key = 'property-management'
       AND (resource_product IS NULL OR (
         resource_product = 'pms' AND resource_type = 'pms_property'
         AND resource_id = $2::uuid::text
       ))
     FOR SHARE`,
    [input.organizationId, input.propertyId],
  );
  const applicable = entitlements.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= acceptedAt) &&
      (!row.expiresAt || new Date(row.expiresAt) > acceptedAt),
  );
  return (
    !applicable.some((row) => row.status === "suspended") &&
    applicable.some((row) => row.status === "active")
  );
}

async function lockQuickReplyName(
  client: PmsInboxQuickReplyClient,
  propertyId: string,
  name: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':quick-reply-name:' || lower($2), 0))`,
    [propertyId, name],
  );
}

async function activeNameExists(
  client: PmsInboxQuickReplyClient,
  propertyId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pms.message_quick_replies
     WHERE property_id = $1::uuid AND lower(name) = lower($2) AND archived_at IS NULL
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [propertyId, name, exceptId ?? null],
  );
  return Boolean(result.rows[0]);
}

async function lockQuickReply(
  client: PmsInboxQuickReplyClient,
  propertyId: string,
  quickReplyId: string,
): Promise<QuickReplyRow | null> {
  const result = await client.query<QuickReplyRow>(
    `SELECT ${QUICK_REPLY_COLUMNS}
     FROM pms.message_quick_replies
     WHERE property_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL
     FOR UPDATE`,
    [propertyId, quickReplyId],
  );
  return result.rows[0] ?? null;
}

async function findReplay(
  client: PmsInboxQuickReplyClient,
  operation: string,
  input: MutationInput,
  keyHash: string,
  fingerprint: string,
): Promise<MutationResult | null> {
  const query = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode", response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, input.propertyId],
  );
  const row = query.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint)
    return failure(
      "idempotency_conflict",
      "Idempotency key was used for a different quick-reply command.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This quick-reply command is already in progress.");
  const replay = parseStoredResult(record(row.idempotencyMetadata)?.["result"], operation, input);
  if (
    !replay ||
    row.responseStatusCode !== responseStatus(operation, replay) ||
    row.responseBodyHash !== sha256(stableJson(replay)) ||
    (replay.ok &&
      (row.responseResourceProduct !== "pms" ||
        row.responseResourceType !== "message_quick_reply" ||
        row.responseResourceId !== resultIdentity(replay)))
  )
    throw new Error("PMS Inbox quick-reply replay evidence is invalid");
  return replay;
}

async function reserveIdempotency(
  client: PmsInboxQuickReplyClient,
  operation: string,
  input: MutationInput,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<string | null> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope, operation, key_hash, request_fingerprint_hash, status,
        tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
        locked_until, expires_at, idempotency_metadata)
     VALUES ('pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
             $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '5 minutes',
             'infinity'::timestamptz, $7::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      operation,
      keyHash,
      fingerprint,
      input.propertyId,
      input.audit.correlationId,
      acceptedAt,
      JSON.stringify({ operation, requestId: input.audit.requestId }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function insertEvidence(
  client: PmsInboxQuickReplyClient,
  operation: string,
  input: MutationInput,
  result: Extract<MutationResult, { ok: true }>,
  idempotencyId: string,
  keyHash: string,
  acceptedAt: Date,
): Promise<void> {
  const quickReplyId = resultIdentity(result);
  const version = resultVersion(result);
  const eventType = operation === PREVIEW_OPERATION ? `${operation}ed` : `${operation}d`;
  const eventKey = `${operation}:quick-reply:${quickReplyId}:key:${keyHash}:v1`;
  const redactedPayload = {
    propertyId: input.propertyId,
    quickReplyId,
    ...(version === null ? {} : { version }),
    ...("threadId" in input ? { threadId: input.threadId } : {}),
  };
  const event = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, actor_user_id, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES ('pms', $1, $2, 1, $3::timestamptz, 'recorded', 'property', $4::uuid,
             'pms', 'message_quick_reply', $5::text, 'user', $6::uuid, $7, $8, $9,
             $10::jsonb, $11::jsonb, 'internal')
     RETURNING id::text AS id`,
    [
      eventKey,
      eventType,
      acceptedAt,
      input.propertyId,
      quickReplyId,
      input.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      keyHash,
      JSON.stringify(redactedPayload),
      JSON.stringify({ contractVersion: "native-guest-inbox.v2" }),
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox quick-reply event was not recorded");
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
             'pms', 'message_quick_reply', $6::text, $7::uuid, $8::uuid, $9, $10,
             $11::jsonb, $12::jsonb, 'standard', 'internal')`,
    [
      eventKey,
      operation,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      quickReplyId,
      eventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({
        quickReplyId,
        ...(version === null ? {} : { version }),
        ...("threadId" in input ? { threadId: input.threadId } : {}),
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        actorMembershipId: input.actorMembershipId,
      }),
    ],
  );
}

async function completeIdempotency(
  client: PmsInboxQuickReplyClient,
  operation: string,
  idempotencyId: string,
  result: MutationResult,
  acceptedAt: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         idempotency_metadata = idempotency_metadata || $8::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(operation, result),
      sha256(stableJson(result)),
      result.ok ? "pms" : null,
      result.ok ? "message_quick_reply" : null,
      result.ok ? resultIdentity(result) : null,
      acceptedAt,
      JSON.stringify({ result }),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox quick-reply idempotency was not completed once");
}

function parseStoredResult(
  value: unknown,
  operation: string,
  input: MutationInput,
): MutationResult | null {
  const root = record(value);
  const error = record(root?.["error"]);
  if (root?.["ok"] === false && error) {
    const code = String(error["code"]);
    if (
      ![
        "validation_failed",
        "quick_reply_not_found",
        "thread_not_found",
        "quick_reply_version_conflict",
        "quick_reply_name_conflict",
        "idempotency_conflict",
      ].includes(code) ||
      typeof error["message"] !== "string" ||
      (error["currentVersion"] !== undefined && !validVersion(error["currentVersion"]))
    )
      return null;
    return { ok: false, error: error as PmsInboxQuickReplyError };
  }
  const stored = record(root?.["value"]);
  if (root?.["ok"] !== true || !stored || stored["propertyId"] !== input.propertyId) return null;
  if (operation === PREVIEW_OPERATION) {
    if (
      !("threadId" in input) ||
      stored["quickReplyId"] !== input.quickReplyId ||
      stored["threadId"] !== input.threadId ||
      typeof stored["renderedText"] !== "string" ||
      stored["renderedText"].length > MAX_RENDERED_TEXT_LENGTH ||
      !Array.isArray(stored["unresolvedVariables"]) ||
      !stored["unresolvedVariables"].every(
        (variable) => typeof variable === "string" && VARIABLE.test(variable),
      ) ||
      new Set(stored["unresolvedVariables"]).size !== stored["unresolvedVariables"].length ||
      stored["composerUseAllowed"] !== (stored["unresolvedVariables"].length === 0)
    )
      return null;
    return { ok: true, value: stored as Extract<PreviewResult, { ok: true }>["value"] };
  }
  if (operation === ARCHIVE_OPERATION) {
    if (
      !("quickReplyId" in input) ||
      stored["quickReplyId"] !== input.quickReplyId ||
      !validVersion(stored["version"]) ||
      typeof stored["archivedAt"] !== "string" ||
      !validInstant(stored["archivedAt"])
    )
      return null;
    return { ok: true, value: stored as Extract<ArchiveResult, { ok: true }>["value"] };
  }
  const quickReply = parseQuickReply(stored["quickReply"]);
  if (!quickReply || quickReply.propertyId !== input.propertyId) return null;
  if ("quickReplyId" in input && quickReply.id !== input.quickReplyId) return null;
  return { ok: true, value: { propertyId: input.propertyId, quickReply } };
}

function toQuickReply(row: QuickReplyRow): PmsInboxQuickReply {
  const quickReply = parseQuickReply({
    ...row,
    version: safeVersion(row.version),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
  if (!quickReply) throw new Error("PMS Inbox quick-reply row is invalid");
  return quickReply;
}

function parseQuickReply(value: unknown): PmsInboxQuickReply | null {
  const row = record(value);
  if (
    !row ||
    typeof row["propertyId"] !== "string" ||
    !UUID.test(row["propertyId"]) ||
    typeof row["id"] !== "string" ||
    !UUID.test(row["id"]) ||
    typeof row["name"] !== "string" ||
    !row["name"].trim() ||
    typeof row["text"] !== "string" ||
    !row["text"].trim() ||
    !Array.isArray(row["approvedVariables"]) ||
    !row["approvedVariables"].every(
      (variable) => typeof variable === "string" && VARIABLE.test(variable),
    ) ||
    !validVersion(row["version"]) ||
    typeof row["createdAt"] !== "string" ||
    !validInstant(row["createdAt"]) ||
    typeof row["updatedAt"] !== "string" ||
    !validInstant(row["updatedAt"])
  )
    return null;
  return row as PmsInboxQuickReply;
}

function quickReplyVariables(context: ThreadContextRow): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const add = (names: readonly string[], value: string | number | null) => {
    const normalized = value === null ? "" : String(value).trim();
    if (normalized) for (const name of names) values.set(name, normalized);
  };
  add(["property", "property_name"], context.propertyName);
  add(["guest", "guest_first_name"], context.guestFirstName);
  add(["guest_full", "guest_full_name"], context.guestFullName);
  add(["booking_reference"], context.bookingReference);
  add(["source_reference"], context.sourceReference);
  add(["arrival_date", "checkin_date"], context.arrivalDate);
  add(["departure_date", "checkout_date"], context.departureDate);
  add(["nights"], context.nights);
  return values;
}

function renderQuickReply(
  template: string,
  approved: ReadonlySet<string>,
  variables: ReadonlyMap<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const text = template.replace(PLACEHOLDER, (placeholder, raw: string) => {
    const name = raw.trim();
    const validName = VARIABLE.test(name);
    const value = validName && approved.has(name) ? variables.get(name) : undefined;
    if (value) return value;
    unresolved.add(validName ? name : "invalid_variable");
    return placeholder;
  });
  return { text, unresolved: [...unresolved] };
}

function createFingerprint(input: CreateInput): string {
  return stableJson({
    operation: CREATE_OPERATION,
    propertyId: input.propertyId,
    body: { name: input.name, text: input.text, approvedVariables: input.approvedVariables },
  });
}

function updateFingerprint(input: UpdateInput): string {
  return stableJson({
    operation: UPDATE_OPERATION,
    propertyId: input.propertyId,
    quickReplyId: input.quickReplyId,
    body: {
      expectedVersion: input.expectedVersion,
      name: input.name,
      text: input.text,
      approvedVariables: input.approvedVariables,
    },
  });
}

function archiveFingerprint(input: ArchiveInput): string {
  return stableJson({
    operation: ARCHIVE_OPERATION,
    propertyId: input.propertyId,
    quickReplyId: input.quickReplyId,
    body: { expectedVersion: input.expectedVersion },
  });
}

function previewFingerprint(input: PreviewInput): string {
  return stableJson({
    operation: PREVIEW_OPERATION,
    propertyId: input.propertyId,
    quickReplyId: input.quickReplyId,
    threadId: input.threadId,
  });
}

function resultIdentity(result: Extract<MutationResult, { ok: true }>): string {
  return "quickReply" in result.value ? result.value.quickReply.id : result.value.quickReplyId;
}

function resultVersion(result: Extract<MutationResult, { ok: true }>): number | null {
  if ("quickReply" in result.value) return result.value.quickReply.version;
  return "version" in result.value ? result.value.version : null;
}

function responseStatus(operation: string, result: MutationResult): number {
  if (!result.ok) {
    if (result.error.code === "quick_reply_not_found" || result.error.code === "thread_not_found")
      return 404;
    if (
      result.error.code === "quick_reply_version_conflict" ||
      result.error.code === "quick_reply_name_conflict" ||
      result.error.code === "idempotency_conflict"
    )
      return 409;
    return 400;
  }
  return operation === CREATE_OPERATION ? 201 : 200;
}

function failure(
  code: PmsInboxQuickReplyError["code"],
  message: string,
  currentVersion?: number,
): Extract<MutationResult, { ok: false }> {
  return {
    ok: false,
    error: { code, message, ...(currentVersion === undefined ? {} : { currentVersion }) },
  };
}

function acceptedInstant(now: () => Date): Date {
  const acceptedAt = now();
  if (!Number.isFinite(acceptedAt.getTime()))
    throw new Error("PMS Inbox quick-reply clock is invalid");
  return acceptedAt;
}

function safeVersion(value: unknown): number {
  const version = typeof value === "number" ? value : Number(value);
  if (!validVersion(version)) throw new Error("PMS Inbox quick-reply version is invalid");
  return version;
}

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function rollbackResult<T extends MutationResult>(
  client: PmsInboxQuickReplyClient,
  result: T,
): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

async function rollbackQuietly(client: PmsInboxQuickReplyClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxQuickReplyClient): void {
  try {
    client.release();
  } catch {
    // The command result is already determined.
  }
}
