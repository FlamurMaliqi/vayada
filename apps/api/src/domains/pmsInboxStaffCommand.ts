import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PmsInboxStaffCommandError, PmsInboxStaffCommandPort } from "./pmsInbox.js";

export type PmsInboxStaffCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxStaffCommandPool = {
  connect(): Promise<PmsInboxStaffCommandClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxStaffCommandPort = PmsInboxStaffCommandPort & { close(): Promise<void> };

type AssignInput = Parameters<PmsInboxStaffCommandPort["assign"]>[0];
type AssignResult = Awaited<ReturnType<PmsInboxStaffCommandPort["assign"]>>;
type NoteInput = Parameters<PmsInboxStaffCommandPort["addNote"]>[0];
type NoteResult = Awaited<ReturnType<PmsInboxStaffCommandPort["addNote"]>>;
type StaffResult = AssignResult | NoteResult;

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
type ActorRow = { displayName: string; propertyAccessMode: string };
type AssigneeRow = { membershipId: string; displayName: string; propertyAccessMode: string };
type ThreadRow = { version: string | number; assignedToMembershipId: string | null };
type InsertedIdRow = { id: string };
type VersionRow = { version: string | number };
type StoredNoteRow = {
  id: string;
  authorMembershipId: string;
  authorDisplayName: string;
  text: string;
  occurredAt: Date | string;
};

const ASSIGN_OPERATION = "pms.inbox.thread.assign";
const NOTE_OPERATION = "pms.inbox.thread.add_note";
const MAX_NOTE_LENGTH = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPmsInboxStaffCommandPort(config: {
  connectionString: string;
  pool?: PmsInboxStaffCommandPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxStaffCommandPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox staff-command connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxStaffCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async assign(rawInput) {
      const input = normalizeAssignment(rawInput);
      if (!input) return failure("validation_failed", "Inbox assignment payload is invalid.");
      const acceptedAt = acceptedInstant(now, "assignment");
      const keyHash = sha256(input.idempotencyKey);
      const fingerprint = sha256(assignmentFingerprint(input));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockActorScope(client, input, acceptedAt)))
          throw new Error("PMS Inbox assignment actor scope is unavailable");
        const replay = await findAssignmentReplay(client, input, keyHash, fingerprint);
        if (replay) {
          const result = await rollbackResult(client, replay);
          return result;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          input,
          ASSIGN_OPERATION,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrent = await findAssignmentReplay(client, input, keyHash, fingerprint);
          const result = await rollbackResult(
            client,
            concurrent ??
              failure("idempotency_conflict", "This Inbox assignment is already in progress."),
          );
          return result;
        }

        const assignee = input.assigneeMembershipId
          ? await lockEligibleAssignee(client, input.propertyId, input.assigneeMembershipId)
          : null;
        if (input.assigneeMembershipId && !assignee) {
          const result = await commitResult(
            client,
            idempotencyId,
            failure("validation_failed", "Assignee must have active access to this property."),
            acceptedAt,
          );
          return result;
        }
        const thread = await lockThread(client, input.propertyId, input.threadId);
        if (!thread) {
          const result = await commitResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );
          return result;
        }
        const currentVersion = safeVersion(thread.version);
        if (currentVersion !== input.expectedThreadVersion) {
          const result = await commitResult(
            client,
            idempotencyId,
            failure(
              "thread_version_conflict",
              "The conversation changed. Refresh and try again.",
              currentVersion,
            ),
            acceptedAt,
          );
          return result;
        }

        const threadVersion = await updateAssignment(client, input, acceptedAt);
        const domainEventId = await insertAssignmentEvent(
          client,
          input,
          keyHash,
          thread.assignedToMembershipId,
          threadVersion,
          acceptedAt,
        );
        await insertAssignmentAudit(
          client,
          input,
          idempotencyId,
          domainEventId,
          keyHash,
          thread.assignedToMembershipId,
          threadVersion,
          acceptedAt,
        );
        const result = await commitResult(
          client,
          idempotencyId,
          {
            ok: true,
            value: {
              propertyId: input.propertyId,
              threadId: input.threadId,
              assignedTo: assignee
                ? { membershipId: assignee.membershipId, displayName: assignee.displayName }
                : null,
              threadVersion,
            },
          },
          acceptedAt,
        );
        return result;
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox assignment command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async addNote(rawInput) {
      const input = normalizeNote(rawInput);
      if (!input) return failure("validation_failed", "Inbox internal-note payload is invalid.");
      const acceptedAt = acceptedInstant(now, "internal-note");
      const keyHash = sha256(input.idempotencyKey);
      const fingerprint = sha256(noteFingerprint(input));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const authorDisplayName = await lockActorScope(client, input, acceptedAt);
        if (!authorDisplayName)
          throw new Error("PMS Inbox internal-note actor scope is unavailable");
        const replay = await findNoteReplay(client, input, keyHash, fingerprint);
        if (replay) {
          const result = await rollbackResult(client, replay);
          return result;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          input,
          NOTE_OPERATION,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrent = await findNoteReplay(client, input, keyHash, fingerprint);
          const result = await rollbackResult(
            client,
            concurrent ??
              failure("idempotency_conflict", "This Inbox internal note is already in progress."),
          );
          return result;
        }

        const thread = await lockThread(client, input.propertyId, input.threadId);
        if (!thread) {
          const result = await commitNoteResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );
          return result;
        }
        const currentVersion = safeVersion(thread.version);
        if (currentVersion !== input.expectedThreadVersion) {
          const result = await commitNoteResult(
            client,
            idempotencyId,
            failure(
              "thread_version_conflict",
              "The conversation changed. Refresh and try again.",
              currentVersion,
            ),
            acceptedAt,
          );
          return result;
        }

        const noteId = await insertInternalNote(client, input, authorDisplayName, acceptedAt);
        const threadVersion = await advanceNoteActivity(client, input, acceptedAt);
        const domainEventId = await insertNoteEvent(
          client,
          input,
          noteId,
          keyHash,
          threadVersion,
          acceptedAt,
        );
        await insertNoteAudit(
          client,
          input,
          noteId,
          idempotencyId,
          domainEventId,
          keyHash,
          threadVersion,
          acceptedAt,
        );
        const result = await commitNoteResult(
          client,
          idempotencyId,
          {
            ok: true,
            value: {
              propertyId: input.propertyId,
              threadId: input.threadId,
              note: {
                id: noteId,
                author: { membershipId: input.actorMembershipId, displayName: authorDisplayName },
                text: input.text,
                occurredAt: acceptedAt.toISOString(),
              },
              threadVersion,
            },
          },
          acceptedAt,
        );
        return result;
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox internal-note command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox staff-command pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function normalizeAssignment(input: AssignInput): AssignInput | null {
  if (
    !validBaseInput(input) ||
    (input.assigneeMembershipId !== null && !UUID.test(input.assigneeMembershipId))
  )
    return null;
  return { ...input, idempotencyKey: input.idempotencyKey.trim() };
}

function normalizeNote(input: NoteInput): NoteInput | null {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!validBaseInput(input) || !text || text.length > MAX_NOTE_LENGTH) return null;
  return { ...input, idempotencyKey: input.idempotencyKey.trim(), text };
}

function validBaseInput(input: AssignInput | NoteInput): boolean {
  return (
    UUID.test(input.propertyId) &&
    UUID.test(input.threadId) &&
    UUID.test(input.organizationId) &&
    UUID.test(input.actorUserId) &&
    UUID.test(input.actorMembershipId) &&
    Boolean(input.idempotencyKey.trim()) &&
    input.idempotencyKey.length <= 200 &&
    Number.isSafeInteger(input.expectedThreadVersion) &&
    input.expectedThreadVersion >= 1 &&
    Boolean(input.audit.requestId.trim()) &&
    Boolean(input.audit.correlationId.trim()) &&
    validInstant(input.audit.requestedAt)
  );
}

async function lockActorScope(
  client: PmsInboxStaffCommandClient,
  input: AssignInput | NoteInput,
  acceptedAt: Date,
): Promise<string | null> {
  const scope = await client.query<ActorRow>(
    `SELECT COALESCE(NULLIF(BTRIM(actor.name), ''), 'Property staff') AS "displayName",
            membership.property_access_mode AS "propertyAccessMode"
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
     JOIN identity.users actor
       ON actor.id = $3::uuid AND actor.status = 'active'
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
  if (
    !actor ||
    (actor.propertyAccessMode === "assigned" &&
      !(await lockPropertyAssignment(client, input.actorMembershipId, input.propertyId)))
  )
    return null;
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
  return !applicable.some((row) => row.status === "suspended") &&
    applicable.some((row) => row.status === "active")
    ? actor.displayName
    : null;
}

async function lockEligibleAssignee(
  client: PmsInboxStaffCommandClient,
  propertyId: string,
  membershipId: string,
): Promise<AssigneeRow | null> {
  const result = await client.query<AssigneeRow>(
    `SELECT membership.id::text AS "membershipId",
            COALESCE(NULLIF(BTRIM(staff.name), ''), 'Property staff') AS "displayName",
            membership.property_access_mode AS "propertyAccessMode"
     FROM identity.organization_memberships membership
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id AND organization.status = 'active'
     JOIN identity.users staff
       ON staff.id = membership.user_id AND staff.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = membership.organization_id
      AND resource.product = 'pms' AND resource.resource_type = 'pms_property'
      AND resource.resource_id = $1::uuid::text
      AND resource.relationship IN ('owner', 'operator', 'front_desk')
      AND resource.status = 'active'
     WHERE membership.id = $2::uuid AND membership.status = 'active'
       AND (membership.property_access_mode = 'all' OR EXISTS (
         SELECT 1 FROM identity.membership_property_assignments assignment
         WHERE assignment.membership_id = membership.id AND assignment.property_id = $1::uuid
       ))
     FOR SHARE OF membership, organization, staff, resource`,
    [propertyId, membershipId],
  );
  const assignee = result.rows[0];
  if (
    !assignee ||
    (assignee.propertyAccessMode === "assigned" &&
      !(await lockPropertyAssignment(client, membershipId, propertyId)))
  )
    return null;
  return assignee;
}

async function lockPropertyAssignment(
  client: PmsInboxStaffCommandClient,
  membershipId: string,
  propertyId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM identity.membership_property_assignments
     WHERE membership_id = $1::uuid AND property_id = $2::uuid
     FOR SHARE`,
    [membershipId, propertyId],
  );
  return Boolean(result.rows[0]);
}

async function findAssignmentReplay(
  client: PmsInboxStaffCommandClient,
  input: AssignInput,
  keyHash: string,
  fingerprint: string,
): Promise<AssignResult | null> {
  const row = await findIdempotency(client, ASSIGN_OPERATION, input.propertyId, keyHash);
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint)
    return failure(
      "idempotency_conflict",
      "Idempotency key was already used for a different Inbox assignment.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This Inbox assignment is already in progress.");
  const replay = parseAssignmentResult(record(row.idempotencyMetadata)?.["result"]);
  if (
    !replay ||
    row.responseStatusCode !== responseStatus(replay) ||
    row.responseBodyHash !== sha256(stableJson(replay)) ||
    (replay.ok &&
      (row.responseResourceProduct !== "pms" ||
        row.responseResourceType !== "message_thread" ||
        row.responseResourceId !== replay.value.threadId))
  )
    throw new Error("PMS Inbox assignment replay evidence is invalid");
  return replay;
}

async function findNoteReplay(
  client: PmsInboxStaffCommandClient,
  input: NoteInput,
  keyHash: string,
  fingerprint: string,
): Promise<NoteResult | null> {
  const row = await findIdempotency(client, NOTE_OPERATION, input.propertyId, keyHash);
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint)
    return failure(
      "idempotency_conflict",
      "Idempotency key was already used for a different Inbox internal note.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This Inbox internal note is already in progress.");
  const storedFailure = parseFailure(record(row.idempotencyMetadata)?.["result"]);
  if (storedFailure) {
    verifyReplayEvidence(row, storedFailure);
    return storedFailure;
  }
  const reference = record(record(row.idempotencyMetadata)?.["resultReference"]);
  if (
    !reference ||
    typeof reference["noteId"] !== "string" ||
    !UUID.test(reference["noteId"]) ||
    !Number.isSafeInteger(reference["threadVersion"]) ||
    row.responseResourceProduct !== "pms" ||
    row.responseResourceType !== "message_internal_note" ||
    row.responseResourceId !== reference["noteId"]
  )
    throw new Error("PMS Inbox internal-note replay reference is invalid");
  const note = await client.query<StoredNoteRow>(
    `SELECT id::text AS id, author_membership_id::text AS "authorMembershipId",
            author_display_name AS "authorDisplayName", body AS text, created_at AS "occurredAt"
     FROM pms.message_internal_notes
     WHERE property_id = $1::uuid AND thread_id = $2::uuid AND id = $3::uuid`,
    [input.propertyId, input.threadId, reference["noteId"]],
  );
  const stored = note.rows[0];
  if (!stored) throw new Error("PMS Inbox internal-note replay resource is unavailable");
  const replay: NoteResult = {
    ok: true,
    value: {
      propertyId: input.propertyId,
      threadId: input.threadId,
      note: {
        id: stored.id,
        author: {
          membershipId: stored.authorMembershipId,
          displayName: stored.authorDisplayName,
        },
        text: stored.text,
        occurredAt: new Date(stored.occurredAt).toISOString(),
      },
      threadVersion: Number(reference["threadVersion"]),
    },
  };
  verifyReplayEvidence(row, replay);
  return replay;
}

async function findIdempotency(
  client: PmsInboxStaffCommandClient,
  operation: string,
  propertyId: string,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, propertyId],
  );
  return result.rows[0] ?? null;
}

async function reserveIdempotency(
  client: PmsInboxStaffCommandClient,
  input: AssignInput | NoteInput,
  operation: string,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<string | null> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope, operation, key_hash, request_fingerprint_hash, status,
        tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
        locked_until, expires_at, idempotency_metadata)
     VALUES
       ('pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
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

async function lockThread(
  client: PmsInboxStaffCommandClient,
  propertyId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  const result = await client.query<ThreadRow>(
    `SELECT version, assigned_to_membership_id::text AS "assignedToMembershipId"
     FROM pms.message_threads
     WHERE property_id = $1::uuid AND id = $2::uuid
     FOR UPDATE`,
    [propertyId, threadId],
  );
  return result.rows[0] ?? null;
}

async function updateAssignment(
  client: PmsInboxStaffCommandClient,
  input: AssignInput,
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query<VersionRow>(
    `UPDATE pms.message_threads
     SET assigned_to_membership_id = $3::uuid, version = version + 1,
         updated_at = $4::timestamptz
     WHERE property_id = $1::uuid AND id = $2::uuid AND version = $5
     RETURNING version`,
    [
      input.propertyId,
      input.threadId,
      input.assigneeMembershipId,
      acceptedAt,
      input.expectedThreadVersion,
    ],
  );
  return changedVersion(result.rows[0]?.version, input.expectedThreadVersion, "assignment");
}

async function insertInternalNote(
  client: PmsInboxStaffCommandClient,
  input: NoteInput,
  authorDisplayName: string,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO pms.message_internal_notes
       (property_id, thread_id, author_membership_id, author_display_name, body, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)
     RETURNING id::text AS id`,
    [
      input.propertyId,
      input.threadId,
      input.actorMembershipId,
      authorDisplayName,
      input.text,
      acceptedAt,
    ],
  );
  const noteId = result.rows[0]?.id;
  if (!noteId) throw new Error("PMS Inbox internal note was not inserted");
  return noteId;
}

async function advanceNoteActivity(
  client: PmsInboxStaffCommandClient,
  input: NoteInput,
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query<VersionRow>(
    `UPDATE pms.message_threads
     SET last_internal_note_at = GREATEST(COALESCE(last_internal_note_at, $3::timestamptz),
                                          $3::timestamptz),
         version = version + 1, updated_at = $3::timestamptz
     WHERE property_id = $1::uuid AND id = $2::uuid AND version = $4
     RETURNING version`,
    [input.propertyId, input.threadId, acceptedAt, input.expectedThreadVersion],
  );
  return changedVersion(result.rows[0]?.version, input.expectedThreadVersion, "internal-note");
}

async function insertAssignmentEvent(
  client: PmsInboxStaffCommandClient,
  input: AssignInput,
  keyHash: string,
  previousAssigneeMembershipId: string | null,
  threadVersion: number,
  acceptedAt: Date,
): Promise<string> {
  return insertEvent(client, {
    input,
    keyHash,
    eventType: "pms.inbox.thread.assigned",
    payload: {
      propertyId: input.propertyId,
      threadId: input.threadId,
      assigneeMembershipId: input.assigneeMembershipId,
      threadVersion,
    },
    metadata: {
      contractVersion: "native-guest-inbox.v2",
      previousAssigneeMembershipId,
    },
    acceptedAt,
  });
}

async function insertNoteEvent(
  client: PmsInboxStaffCommandClient,
  input: NoteInput,
  noteId: string,
  keyHash: string,
  threadVersion: number,
  acceptedAt: Date,
): Promise<string> {
  return insertEvent(client, {
    input,
    keyHash,
    eventType: "pms.inbox.thread.note_added",
    payload: {
      propertyId: input.propertyId,
      threadId: input.threadId,
      noteId,
      occurredAt: acceptedAt.toISOString(),
      threadVersion,
    },
    metadata: { contractVersion: "native-guest-inbox.v2" },
    acceptedAt,
  });
}

async function insertEvent(
  client: PmsInboxStaffCommandClient,
  event: {
    input: AssignInput | NoteInput;
    keyHash: string;
    eventType: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
    acceptedAt: Date;
  },
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, actor_user_id, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES
       ('pms', $1, $2, 1, $3::timestamptz, 'recorded',
        'property', $4::uuid, 'pms', 'message_thread', $5::text,
        'user', $6::uuid, $7, $8, $9, $10::jsonb, $11::jsonb, 'confidential')
     RETURNING id::text AS id`,
    [
      eventKey(event.eventType, event.input.threadId, event.keyHash),
      event.eventType,
      event.acceptedAt,
      event.input.propertyId,
      event.input.threadId,
      event.input.actorUserId,
      event.input.audit.correlationId,
      event.input.audit.requestId,
      event.keyHash,
      JSON.stringify(event.payload),
      JSON.stringify(event.metadata),
    ],
  );
  const eventId = result.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox staff-command event was not recorded");
  return eventId;
}

async function insertAssignmentAudit(
  client: PmsInboxStaffCommandClient,
  input: AssignInput,
  idempotencyId: string,
  domainEventId: string,
  keyHash: string,
  previousAssigneeMembershipId: string | null,
  threadVersion: number,
  acceptedAt: Date,
): Promise<void> {
  await insertAudit(client, {
    input,
    action: ASSIGN_OPERATION,
    idempotencyId,
    domainEventId,
    keyHash,
    secondary: null,
    redactedPayload: {
      previousAssigneeMembershipId,
      assigneeMembershipId: input.assigneeMembershipId,
      threadVersion,
    },
    acceptedAt,
  });
}

async function insertNoteAudit(
  client: PmsInboxStaffCommandClient,
  input: NoteInput,
  noteId: string,
  idempotencyId: string,
  domainEventId: string,
  keyHash: string,
  threadVersion: number,
  acceptedAt: Date,
): Promise<void> {
  await insertAudit(client, {
    input,
    action: NOTE_OPERATION,
    idempotencyId,
    domainEventId,
    keyHash,
    secondary: { type: "message_internal_note", id: noteId },
    redactedPayload: { noteId, occurredAt: acceptedAt.toISOString(), threadVersion },
    acceptedAt,
  });
}

async function insertAudit(
  client: PmsInboxStaffCommandClient,
  audit: {
    input: AssignInput | NoteInput;
    action: string;
    idempotencyId: string;
    domainEventId: string;
    keyHash: string;
    secondary: null | { type: string; id: string };
    redactedPayload: Record<string, unknown>;
    acceptedAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        secondary_resource_product, secondary_resource_type, secondary_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user',
        $5::uuid, 'pms', 'message_thread', $6::text,
        $7, $8, $9, $10::uuid, $11::uuid, $12, $13,
        $14::jsonb, $15::jsonb, 'guest_pii', 'confidential')`,
    [
      eventKey(audit.action, audit.input.threadId, audit.keyHash),
      audit.action,
      audit.acceptedAt,
      audit.input.propertyId,
      audit.input.actorUserId,
      audit.input.threadId,
      audit.secondary ? "pms" : null,
      audit.secondary?.type ?? null,
      audit.secondary?.id ?? null,
      audit.domainEventId,
      audit.idempotencyId,
      audit.input.audit.correlationId,
      audit.input.audit.requestId,
      JSON.stringify(audit.redactedPayload),
      JSON.stringify({ actorMembershipId: audit.input.actorMembershipId }),
    ],
  );
}

async function commitResult(
  client: PmsInboxStaffCommandClient,
  idempotencyId: string,
  result: AssignResult,
  acceptedAt: Date,
): Promise<AssignResult> {
  await completeIdempotency(
    client,
    idempotencyId,
    result,
    acceptedAt,
    result.ok ? "message_thread" : null,
    result.ok ? result.value.threadId : null,
    { result },
  );
  await client.query("COMMIT");
  return result;
}

async function commitNoteResult(
  client: PmsInboxStaffCommandClient,
  idempotencyId: string,
  result: NoteResult,
  acceptedAt: Date,
): Promise<NoteResult> {
  await completeIdempotency(
    client,
    idempotencyId,
    result,
    acceptedAt,
    result.ok ? "message_internal_note" : null,
    result.ok ? result.value.note.id : null,
    result.ok
      ? {
          resultReference: {
            noteId: result.value.note.id,
            threadVersion: result.value.threadVersion,
          },
        }
      : { result },
  );
  await client.query("COMMIT");
  return result;
}

async function completeIdempotency(
  client: PmsInboxStaffCommandClient,
  idempotencyId: string,
  result: StaffResult,
  acceptedAt: Date,
  resourceType: string | null,
  resourceId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         idempotency_metadata = idempotency_metadata || $8::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(result)),
      resourceType ? "pms" : null,
      resourceType,
      resourceId,
      acceptedAt,
      JSON.stringify(metadata),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox staff-command idempotency record was not completed once");
}

function parseAssignmentResult(value: unknown): AssignResult | null {
  const failed = parseFailure(value);
  if (failed) return failed;
  const root = record(value);
  const stored = record(root?.["value"]);
  const assignedTo = stored?.["assignedTo"];
  const assignee = assignedTo === null ? null : record(assignedTo);
  if (
    root?.["ok"] !== true ||
    !stored ||
    typeof stored["propertyId"] !== "string" ||
    typeof stored["threadId"] !== "string" ||
    !Number.isSafeInteger(stored["threadVersion"]) ||
    Number(stored["threadVersion"]) < 1 ||
    (assignedTo !== null &&
      (!assignee ||
        typeof assignee["membershipId"] !== "string" ||
        typeof assignee["displayName"] !== "string"))
  )
    return null;
  return { ok: true, value: stored as Extract<AssignResult, { ok: true }>["value"] };
}

function parseFailure(value: unknown): Extract<StaffResult, { ok: false }> | null {
  const root = record(value);
  const error = record(root?.["error"]);
  if (
    root?.["ok"] !== false ||
    !error ||
    ![
      "validation_failed",
      "thread_not_found",
      "thread_version_conflict",
      "idempotency_conflict",
    ].includes(String(error["code"])) ||
    typeof error["message"] !== "string" ||
    (error["currentVersion"] !== undefined &&
      (!Number.isSafeInteger(error["currentVersion"]) || Number(error["currentVersion"]) < 1))
  )
    return null;
  return { ok: false, error: error as PmsInboxStaffCommandError };
}

function verifyReplayEvidence(row: IdempotencyRow, replay: StaffResult): void {
  if (
    row.responseStatusCode !== responseStatus(replay) ||
    row.responseBodyHash !== sha256(stableJson(replay))
  )
    throw new Error("PMS Inbox staff-command replay evidence is invalid");
}

async function rollbackResult<T extends StaffResult>(
  client: PmsInboxStaffCommandClient,
  result: T,
): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

function assignmentFingerprint(input: AssignInput): string {
  return stableJson({
    operation: ASSIGN_OPERATION,
    propertyId: input.propertyId,
    threadId: input.threadId,
    body: {
      expectedThreadVersion: input.expectedThreadVersion,
      assigneeMembershipId: input.assigneeMembershipId,
    },
  });
}

function noteFingerprint(input: NoteInput): string {
  return stableJson({
    operation: NOTE_OPERATION,
    propertyId: input.propertyId,
    threadId: input.threadId,
    body: { expectedThreadVersion: input.expectedThreadVersion, text: input.text },
  });
}

function eventKey(operation: string, threadId: string, keyHash: string): string {
  return `${operation}:thread:${threadId}:key:${keyHash}:v1`;
}

function changedVersion(value: unknown, previous: number, command: string): number {
  const version = safeVersion(value);
  if (version !== previous + 1) throw new Error(`PMS Inbox ${command} thread was not updated once`);
  return version;
}

function safeVersion(value: unknown): number {
  const version = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("PMS Inbox staff-command thread version is invalid");
  return version;
}

function responseStatus(result: StaffResult): number {
  if (result.ok) return result.value && "note" in result.value ? 201 : 200;
  if (result.error.code === "thread_not_found") return 404;
  if (
    result.error.code === "thread_version_conflict" ||
    result.error.code === "idempotency_conflict"
  )
    return 409;
  return 400;
}

function failure(
  code: PmsInboxStaffCommandError["code"],
  message: string,
  currentVersion?: number,
): Extract<StaffResult, { ok: false }> {
  return {
    ok: false,
    error: { code, message, ...(currentVersion === undefined ? {} : { currentVersion }) },
  };
}

function acceptedInstant(now: () => Date, command: string): Date {
  const acceptedAt = now();
  if (!Number.isFinite(acceptedAt.getTime()))
    throw new Error(`PMS Inbox ${command} clock is invalid`);
  return acceptedAt;
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

async function rollbackQuietly(client: PmsInboxStaffCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxStaffCommandClient): void {
  try {
    client.release();
  } catch {
    // The command result is already determined.
  }
}
