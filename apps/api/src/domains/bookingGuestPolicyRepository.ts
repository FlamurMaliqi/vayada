import { createHash, randomUUID } from "node:crypto";

import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  BOOKING_GUEST_POLICY_OUTBOX_DESTINATION,
  BOOKING_GUEST_POLICY_OUTBOX_METADATA,
  BOOKING_GUEST_POLICY_RESOURCE_TYPE,
  BOOKING_GUEST_POLICY_UPSERT_OPERATION,
  createBookingGuestPolicyPublicProjection,
  parseBookingGuestPolicyBundle,
  parseBookingGuestPolicyRevision,
  serializeBookingGuestPolicyCommandFingerprint,
  type BookingGuestPolicyAuthorizedReplayPort,
  type BookingGuestPolicyAuthorizedReplayResult,
  type BookingGuestPolicyChangedEvent,
  type BookingGuestPolicyCommandResult,
  type BookingGuestPolicyPersistencePort,
  type BookingGuestPolicyProjectionReceipt,
  type BookingGuestPolicyProjectionReceiptPort,
  type BookingGuestPolicyReadPort,
  type BookingGuestPolicyRevision,
  type BookingGuestPolicyScopeAuthorizationPort,
  type PersistBookingGuestPolicyCommand,
  type RecordBookingGuestPolicyProjectionReceiptCommand,
  type UpsertBookingGuestPolicyCommand,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type RepositoryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingGuestPolicyReadClient = Pick<RepositoryClient, "query">;

export type BookingGuestPolicyRepositoryPool = {
  connect(): Promise<RepositoryClient>;
  end(): Promise<void>;
};

export type BookingGuestPolicyRepository = BookingGuestPolicyAuthorizedReplayPort &
  BookingGuestPolicyPersistencePort &
  BookingGuestPolicyReadPort &
  BookingGuestPolicyProjectionReceiptPort & { close(): Promise<void> };

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

type RevisionRow = {
  revisionId: string;
  organizationId: string;
  propertyId: string;
  guestPolicyRevision: number;
  contractVersion: string;
  defaultGuestLanguage: string;
  childrenEnabled: boolean;
  adultAgeThreshold: number | null;
  phoneRequired: boolean;
  arrivalTimeEnabled: boolean;
  specialRequestsEnabled: boolean;
  checkInTime: string;
  checkOutTime: string;
  pricingCurrency: string;
  propertyTimeZone: string;
  catalogProfileSourceRevision: string;
  pricingSourceFingerprint: string;
  mandatoryChargeConfirmationRevision: number;
  sourceBindings: unknown;
  sourceFingerprint: string;
  policyBundle: unknown;
  bundleHash: string;
  outboxEventId: string;
  acceptedAt: Date | string;
  confirmationId: string;
  confirmationRevision: number;
  confirmationBasis: string;
  basedOnConfirmationId: string | null;
  reviewedAt: Date | string;
  confirmationRecordedAt: Date | string;
  receiptOutcome: string | null;
  receiptId: string | null;
  receiptSourceOutboxEventId: string | null;
  projectedGuestPolicyRevision: number | null;
  projectedBundleHash: string | null;
  projectedSourceFingerprint: string | null;
  receiptCatalogProfileSourceRevision: string | null;
  catalogPolicyProjectionRevision: number | null;
  observedCatalogProfileRevision: string | null;
  receiptRecordedAt: Date | string | null;
};

type ProjectionReceiptRow = {
  organizationId: string;
  propertyId: string;
  revisionId: string;
  outcome: string;
  receiptId: string;
  sourceOutboxEventId: string;
  projectedGuestPolicyRevision: number;
  projectedBundleHash: string;
  projectedSourceFingerprint: string;
  catalogProfileSourceRevision: string;
  catalogPolicyProjectionRevision: number | null;
  observedCatalogProfileRevision: string | null;
  recordedAt: Date | string;
};

export function createPgBookingGuestPolicyRepository(config: {
  connectionString: string;
  scopeAuthorization: BookingGuestPolicyScopeAuthorizationPort;
  max?: number;
  pool?: BookingGuestPolicyRepositoryPool;
  now?: () => Date;
  randomId?: () => string;
}): BookingGuestPolicyRepository {
  if (!config.connectionString.trim())
    throw new Error("Booking guest-policy repository connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      max: config.max,
    }) as BookingGuestPolicyRepositoryPool);
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;

  return {
    async findAuthorizedReplay(command) {
      const prepared = prepareExternalCommand(command);
      if (!(await authorize(config.scopeAuthorization, command, now().toISOString())))
        return rejectedReplay("setup_scope_unavailable");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setTimeouts(client);
        const replay = await findReplay(
          client,
          prepared.organizationId,
          prepared.propertyId,
          prepared.keyHash,
          prepared.fingerprint,
        );
        await rollback(client);
        if (!replay) return Object.freeze({ outcome: "not_found" });
        if (replay.ok) return Object.freeze({ outcome: "replay", revision: replay.revision });
        return Object.freeze({ outcome: "rejected", error: replay.error });
      } catch (error) {
        await rollback(client, error);
        throw error;
      } finally {
        client.release();
      }
    },

    async persistGuestPolicy(command) {
      const prepared = preparePersistenceCommand(command);
      const acceptedAt = now();
      if (!(await authorize(config.scopeAuthorization, command, acceptedAt.toISOString())))
        return failure({ code: "setup_scope_unavailable" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setTimeouts(client);
        const replay = await findReplay(
          client,
          prepared.organizationId,
          prepared.propertyId,
          prepared.keyHash,
          prepared.fingerprint,
        );
        if (replay) {
          await rollback(client);
          return replay;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          command,
          prepared.propertyId,
          prepared.keyHash,
          prepared.fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrent = await findReplay(
            client,
            prepared.organizationId,
            prepared.propertyId,
            prepared.keyHash,
            prepared.fingerprint,
          );
          await rollback(client);
          return concurrent ?? failure({ code: "command_in_progress" });
        }

        await lockProperty(client, prepared.propertyId);
        const current = await readCurrentBookingGuestPolicyRevision(client, prepared.propertyId);
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== command.expectedRevision)
          return finalizeFailure(
            client,
            command,
            prepared,
            idempotencyId,
            failure({ code: "guest_policy_revision_conflict", currentRevision }),
            acceptedAt,
            randomId(),
          );

        const unchangedPolicy =
          current?.organizationId === prepared.organizationId &&
          current.bundle.bundleHash === command.bundle.bundleHash &&
          current.bundle.sourceFingerprint === command.bundle.sourceFingerprint;
        if (!command.confirmPolicyBundle && !unchangedPolicy)
          return finalizeFailure(
            client,
            command,
            prepared,
            idempotencyId,
            failure({ code: "policy_confirmation_required" }),
            acceptedAt,
            randomId(),
          );

        const revisionId = randomId();
        const confirmationId = randomId();
        const domainEventId = randomId();
        const outboxEventId = randomId();
        const auditEventId = randomId();
        const guestPolicyRevision = currentRevision + 1;
        const confirmationRevision = (current?.confirmation.confirmationRevision ?? 0) + 1;
        const outcome = current ? ("updated" as const) : ("created" as const);
        const confirmation = Object.freeze({
          confirmationId,
          confirmationRevision,
          basis: command.confirmPolicyBundle
            ? ("explicit" as const)
            : ("unchanged_policy_bundle" as const),
          basedOnConfirmationId: command.confirmPolicyBundle
            ? null
            : current!.confirmation.confirmationId,
          reviewedAt: command.confirmPolicyBundle
            ? acceptedAt.toISOString()
            : current!.confirmation.reviewedAt,
          recordedAt: acceptedAt.toISOString(),
        });
        const event: BookingGuestPolicyChangedEvent = Object.freeze({
          contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
          eventType: BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
          revisionId,
          propertyId: prepared.propertyId,
          guestPolicyRevision,
          confirmationRevision,
          outcome,
        });
        const input = {
          revisionId,
          confirmationId,
          confirmationRevision,
          guestPolicyRevision,
          domainEventId,
          outboxEventId,
          auditEventId,
          idempotencyId,
          acceptedAt,
          outcome,
        } as const;
        await insertDomainEvent(client, command, prepared, input, event);
        await insertOutboxEvent(client, command, prepared, input, event);
        await insertAudit(client, command, prepared, input, {
          ok: true,
          outcome,
          revisionId,
          guestPolicyRevision,
          confirmationRevision,
        });
        await insertRevision(client, command, prepared, input);
        await insertConfirmation(client, command, prepared, input, confirmation, current);
        await advanceCurrent(client, prepared, input);
        const stored = await readRevision(client, revisionId, prepared.organizationId);
        if (!stored) throw new Error("Booking guest-policy revision could not be reloaded");
        const result: BookingGuestPolicyCommandResult = {
          ok: true,
          outcome,
          revision: stored,
        };
        await completeIdempotency(client, idempotencyId, revisionId, result, acceptedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client, error);
        if (lockUnavailable(error)) return failure({ code: "command_in_progress" });
        throw error;
      } finally {
        client.release();
      }
    },

    async getCurrentGuestPolicy(input) {
      if (!uuid(input.organizationId) || !uuid(input.propertyId))
        throw new TypeError("Booking guest-policy current read scope is malformed");
      const client = await pool.connect();
      try {
        return readCurrentBookingGuestPolicyRevision(
          client,
          input.propertyId.toLowerCase(),
          input.organizationId.toLowerCase(),
        );
      } finally {
        client.release();
      }
    },

    async getGuestPolicyPublicProjection(input) {
      if (
        !uuid(input.organizationId) ||
        !uuid(input.propertyId) ||
        !uuid(input.revisionId) ||
        !revision(input.guestPolicyRevision, false) ||
        !uuid(input.outboxEventId)
      )
        throw new TypeError("Booking guest-policy public projection read scope is malformed");
      const client = await pool.connect();
      try {
        const stored = await readRevision(
          client,
          input.revisionId.toLowerCase(),
          input.organizationId.toLowerCase(),
        );
        return stored?.propertyId === input.propertyId.toLowerCase() &&
          stored.revision === input.guestPolicyRevision &&
          stored.outboxEventId === input.outboxEventId.toLowerCase()
          ? createBookingGuestPolicyPublicProjection(stored)
          : null;
      } finally {
        client.release();
      }
    },

    async recordProjectionReceipt(command) {
      validateProjectionReceiptCommand(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setTimeouts(client);
        const existing = await readProjectionReceipt(client, command.sourceOutboxEventId, true);
        if (existing) {
          if (!receiptMatchesCommand(existing, command))
            throw new Error("Booking guest-policy projection receipt conflicts with stored result");
          await rollback(client);
          return existing.receipt;
        }
        const receiptId = randomId();
        const inserted = await insertProjectionReceipt(client, receiptId, command);
        const receipt = await readProjectionReceipt(client, command.sourceOutboxEventId, false);
        if (!receipt)
          throw new Error("Booking guest-policy projection receipt could not be reloaded");
        if (!inserted && !receiptMatchesCommand(receipt, command))
          throw new Error("Booking guest-policy projection receipt conflicts with stored result");
        await client.query("COMMIT");
        return receipt.receipt;
      } catch (error) {
        await rollback(client, error);
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

type PreparedCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  fingerprint: string;
  keyHash: string;
  catalogProfileSourceRevision: string;
}>;

type AcceptedInput = Readonly<{
  revisionId: string;
  confirmationId: string;
  confirmationRevision: number;
  guestPolicyRevision: number;
  domainEventId: string;
  outboxEventId: string;
  auditEventId: string;
  idempotencyId: string;
  acceptedAt: Date;
  outcome: "created" | "updated";
}>;

function prepareExternalCommand(command: UpsertBookingGuestPolicyCommand) {
  validateCommandEnvelope(command);
  const organizationId = command.organizationId.toLowerCase();
  const propertyId = command.propertyId.toLowerCase();
  return Object.freeze({
    organizationId,
    propertyId,
    fingerprint: sha256(serializeBookingGuestPolicyCommandFingerprint(command)),
    keyHash: sha256(JSON.stringify({ organizationId, idempotencyKey: command.idempotencyKey })),
  });
}

function preparePersistenceCommand(command: PersistBookingGuestPolicyCommand): PreparedCommand {
  const external = prepareExternalCommand(command);
  const bundle = parseBookingGuestPolicyBundle(command.bundle);
  const catalog = bundle?.sourceBindings.filter(
    (source) => source.ownerDomain === "hotel_catalog" && source.entityType === "property_profile",
  );
  if (
    !bundle ||
    bundle.organizationId !== external.organizationId ||
    bundle.propertyId !== external.propertyId ||
    stableJson(bundle.choices) !== stableJson(command.choices) ||
    bundle.sourceFingerprint !== command.expectedSourceFingerprint ||
    catalog?.length !== 1
  )
    throw new TypeError("Booking guest-policy persistence command is invalid");
  return Object.freeze({
    ...external,
    catalogProfileSourceRevision: catalog[0]!.revision,
  });
}

function validateCommandEnvelope(command: UpsertBookingGuestPolicyCommand): void {
  serializeBookingGuestPolicyCommandFingerprint(command);
  if (
    !command.idempotencyKey.trim() ||
    command.idempotencyKey.length > 255 ||
    !uuid(command.audit.actor.userId) ||
    !command.audit.requestId.trim() ||
    command.audit.requestId.length > 255 ||
    (command.audit.correlationId !== null &&
      (!command.audit.correlationId.trim() || command.audit.correlationId.length > 255)) ||
    !canonicalIso(command.audit.requestedAt)
  )
    throw new TypeError("Booking guest-policy command envelope is invalid");
}

async function authorize(
  port: BookingGuestPolicyScopeAuthorizationPort,
  command: UpsertBookingGuestPolicyCommand,
  checkedAt: string,
): Promise<boolean> {
  try {
    return await port.authorizeGuestPolicyScope({
      organizationId: command.organizationId.toLowerCase(),
      propertyId: command.propertyId.toLowerCase(),
      actorUserId: command.audit.actor.userId.toLowerCase(),
      permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
      entitlement: BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement,
      resource: BOOKING_GUEST_POLICY_AUTHORIZATION.resource,
      checkedAt,
    });
  } catch {
    return false;
  }
}

async function setTimeouts(client: RepositoryClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
}

async function lockProperty(client: RepositoryClient, propertyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('booking.guest_policy'), hashtext($1::uuid::text))`,
    [propertyId],
  );
}

async function reserveIdempotency(
  client: RepositoryClient,
  command: UpsertBookingGuestPolicyCommand,
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
      BOOKING_GUEST_POLICY_UPSERT_OPERATION,
      keyHash,
      fingerprint,
      propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function findReplay(
  client: RepositoryClient,
  organizationId: string,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
): Promise<BookingGuestPolicyCommandResult | null> {
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
    [BOOKING_GUEST_POLICY_UPSERT_OPERATION, keyHash, propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint)
    return failure({ code: "idempotency_key_conflict" });
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const stored = await parseStoredResult(client, existing.idempotencyMetadata, organizationId);
  if (!stored) return failure({ code: "idempotency_key_conflict" });
  const resourceMatches = stored.revisionId
    ? existing.responseResourceProduct === "booking" &&
      existing.responseResourceType === BOOKING_GUEST_POLICY_RESOURCE_TYPE &&
      existing.responseResourceId === stored.revisionId
    : existing.responseResourceProduct === null &&
      existing.responseResourceType === null &&
      existing.responseResourceId === null;
  if (
    !resourceMatches ||
    existing.responseStatusCode !== responseStatus(stored.result) ||
    existing.responseBodyHash !==
      sha256(stableJson(idempotencyResponseIdentity(stored.originalResult)))
  )
    return failure({ code: "idempotency_key_conflict" });
  return stored.result;
}

async function parseStoredResult(
  client: RepositoryClient,
  value: unknown,
  organizationId: string,
): Promise<{
  revisionId: string | null;
  originalResult: BookingGuestPolicyCommandResult;
  result: BookingGuestPolicyCommandResult;
} | null> {
  if (!exact(value, ["revisionId", "result"]) || !exact(value.result, ["ok", "outcome"])) {
    if (!exact(value, ["revisionId", "result"]) || !exact(value.result, ["ok", "error"]))
      return null;
  }
  if (value.result.ok === true) {
    if (
      !uuid(value.revisionId) ||
      (value.result.outcome !== "created" && value.result.outcome !== "updated")
    )
      return null;
    const revision = await readRevision(client, value.revisionId, organizationId);
    if (!revision) return null;
    const originalResult: BookingGuestPolicyCommandResult = {
      ok: true,
      outcome: value.result.outcome,
      revision,
    };
    return {
      revisionId: value.revisionId.toLowerCase(),
      originalResult,
      result: { ok: true, outcome: "idempotent_replay", revision },
    };
  }
  if (value.revisionId !== null || value.result.ok !== false) return null;
  const parsedFailure = parseStoredFailure(value.result.error);
  return parsedFailure
    ? { revisionId: null, originalResult: parsedFailure, result: parsedFailure }
    : null;
}

function parseStoredFailure(value: unknown): BookingGuestPolicyCommandResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  if (
    (code === "command_in_progress" ||
      code === "idempotency_key_conflict" ||
      code === "setup_scope_unavailable" ||
      code === "policy_confirmation_required") &&
    exact(value, ["code"])
  )
    return failure({ code });
  if (
    code === "guest_policy_revision_conflict" &&
    exact(value, ["code", "currentRevision"]) &&
    revision(value.currentRevision, true)
  )
    return failure({ code, currentRevision: value.currentRevision });
  return null;
}

const REVISION_SELECT = `
  SELECT revision.revision_id::text AS "revisionId",
         revision.organization_id::text AS "organizationId",
         revision.property_id::text AS "propertyId",
         revision.guest_policy_revision AS "guestPolicyRevision",
         revision.contract_version AS "contractVersion",
         revision.default_guest_language AS "defaultGuestLanguage",
         revision.children_enabled AS "childrenEnabled",
         revision.adult_age_threshold AS "adultAgeThreshold",
         revision.phone_required AS "phoneRequired",
         revision.arrival_time_enabled AS "arrivalTimeEnabled",
         revision.special_requests_enabled AS "specialRequestsEnabled",
         to_char(revision.check_in_time, 'HH24:MI') AS "checkInTime",
         to_char(revision.check_out_time, 'HH24:MI') AS "checkOutTime",
         revision.pricing_currency AS "pricingCurrency",
         revision.property_time_zone AS "propertyTimeZone",
         revision.catalog_profile_source_revision AS "catalogProfileSourceRevision",
         revision.pricing_source_fingerprint AS "pricingSourceFingerprint",
         revision.mandatory_charge_confirmation_revision AS "mandatoryChargeConfirmationRevision",
         revision.source_bindings AS "sourceBindings",
         revision.source_fingerprint AS "sourceFingerprint",
         revision.policy_bundle AS "policyBundle",
         revision.bundle_hash AS "bundleHash",
         revision.outbox_event_id::text AS "outboxEventId",
         revision.accepted_at AS "acceptedAt",
         confirmation.confirmation_id::text AS "confirmationId",
         confirmation.confirmation_revision AS "confirmationRevision",
         confirmation.confirmation_basis AS "confirmationBasis",
         confirmation.based_on_confirmation_id::text AS "basedOnConfirmationId",
         confirmation.reviewed_at AS "reviewedAt",
         confirmation.recorded_at AS "confirmationRecordedAt",
         receipt.outcome AS "receiptOutcome",
         receipt.receipt_id::text AS "receiptId",
         receipt.source_outbox_event_id::text AS "receiptSourceOutboxEventId",
         receipt.guest_policy_revision AS "projectedGuestPolicyRevision",
         receipt.bundle_hash AS "projectedBundleHash",
         receipt.source_fingerprint AS "projectedSourceFingerprint",
         receipt.catalog_profile_source_revision AS "receiptCatalogProfileSourceRevision",
         receipt.catalog_policy_projection_revision AS "catalogPolicyProjectionRevision",
         receipt.observed_catalog_profile_revision AS "observedCatalogProfileRevision",
         receipt.recorded_at AS "receiptRecordedAt"
  FROM booking.guest_policy_revisions revision
  JOIN booking.booking_policy_confirmations confirmation
    ON confirmation.guest_policy_revision_id = revision.revision_id
   AND confirmation.organization_id = revision.organization_id
   AND confirmation.property_id = revision.property_id
   AND confirmation.guest_policy_revision = revision.guest_policy_revision
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM booking.guest_policy_projection_receipts candidate
    WHERE candidate.property_id = revision.property_id
      AND candidate.bundle_hash = revision.bundle_hash
      AND candidate.source_fingerprint = revision.source_fingerprint
      AND candidate.catalog_profile_source_revision = revision.catalog_profile_source_revision
      AND (
        candidate.guest_policy_revision = revision.guest_policy_revision
        OR (
          candidate.outcome = 'applied'
          AND candidate.guest_policy_revision < revision.guest_policy_revision
        )
      )
    ORDER BY (candidate.guest_policy_revision = revision.guest_policy_revision) DESC,
             candidate.guest_policy_revision DESC
    LIMIT 1
  ) receipt ON TRUE`;

export async function readCurrentBookingGuestPolicyRevision(
  client: BookingGuestPolicyReadClient,
  propertyId: string,
  organizationId?: string,
): Promise<BookingGuestPolicyRevision | null> {
  const result = await client.query<RevisionRow>(
    `${REVISION_SELECT}
     JOIN booking.current_working_guest_policy_revisions current
       ON current.revision_id = revision.revision_id
      AND current.organization_id = revision.organization_id
      AND current.property_id = revision.property_id
      AND current.guest_policy_revision = revision.guest_policy_revision
      AND current.confirmation_id = confirmation.confirmation_id
      AND current.confirmation_revision = confirmation.confirmation_revision
     WHERE current.property_id = $1::uuid
       AND ($2::uuid IS NULL OR current.organization_id = $2::uuid)`,
    [propertyId, organizationId ?? null],
  );
  return result.rows[0] ? projectRevision(result.rows[0]) : null;
}

async function readRevision(
  client: RepositoryClient,
  revisionId: string,
  organizationId?: string,
): Promise<BookingGuestPolicyRevision | null> {
  const result = await client.query<RevisionRow>(
    `${REVISION_SELECT}
     WHERE revision.revision_id = $1::uuid
       AND ($2::uuid IS NULL OR revision.organization_id = $2::uuid)`,
    [revisionId, organizationId ?? null],
  );
  return result.rows[0] ? projectRevision(result.rows[0]) : null;
}

function projectRevision(row: RevisionRow): BookingGuestPolicyRevision {
  const bundle = parseBookingGuestPolicyBundle(row.policyBundle);
  if (
    !bundle ||
    bundle.contractVersion !== row.contractVersion ||
    bundle.organizationId !== row.organizationId ||
    bundle.propertyId !== row.propertyId ||
    bundle.choices.defaultGuestLanguage !== row.defaultGuestLanguage ||
    bundle.choices.childrenEnabled !== row.childrenEnabled ||
    bundle.choices.adultAgeThreshold !== row.adultAgeThreshold ||
    bundle.choices.phoneRequired !== row.phoneRequired ||
    bundle.choices.arrivalTimeEnabled !== row.arrivalTimeEnabled ||
    bundle.choices.specialRequestsEnabled !== row.specialRequestsEnabled ||
    bundle.choices.checkInTime !== row.checkInTime ||
    bundle.choices.checkOutTime !== row.checkOutTime ||
    bundle.pricingCurrency !== row.pricingCurrency ||
    bundle.propertyTimeZone !== row.propertyTimeZone ||
    bundle.pricingSourceFingerprint !== row.pricingSourceFingerprint ||
    bundle.mandatoryChargeConfirmationRevision !== row.mandatoryChargeConfirmationRevision ||
    stableJson(bundle.sourceBindings) !== stableJson(row.sourceBindings) ||
    bundle.sourceFingerprint !== row.sourceFingerprint ||
    bundle.bundleHash !== row.bundleHash
  )
    throw new Error("Stored Booking guest-policy bundle is invalid");
  const projectionReceipt = projectReceiptFromRevisionRow(row);
  const parsed = parseBookingGuestPolicyRevision({
    contractVersion: row.contractVersion,
    revisionId: row.revisionId,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    revision: row.guestPolicyRevision,
    catalogProfileSourceRevision: row.catalogProfileSourceRevision,
    bundle,
    confirmation: {
      confirmationId: row.confirmationId,
      confirmationRevision: row.confirmationRevision,
      basis: row.confirmationBasis,
      basedOnConfirmationId: row.basedOnConfirmationId,
      reviewedAt: iso(row.reviewedAt),
      recordedAt: iso(row.confirmationRecordedAt),
    },
    projectionReceipt,
    outboxEventId: row.outboxEventId,
    acceptedAt: iso(row.acceptedAt),
  });
  if (!parsed) throw new Error("Stored Booking guest-policy revision is invalid");
  return parsed;
}

function projectReceiptFromRevisionRow(
  row: RevisionRow,
): BookingGuestPolicyProjectionReceipt | null {
  if (row.receiptOutcome === null) return null;
  if (
    !row.receiptId ||
    !row.receiptSourceOutboxEventId ||
    row.projectedGuestPolicyRevision === null ||
    !row.projectedBundleHash ||
    !row.projectedSourceFingerprint ||
    !row.receiptCatalogProfileSourceRevision ||
    !row.receiptRecordedAt
  )
    throw new Error("Stored Booking guest-policy projection receipt is invalid");
  if (
    (row.receiptOutcome === "applied" &&
      (!revision(row.catalogPolicyProjectionRevision, false) ||
        row.observedCatalogProfileRevision !== null)) ||
    (row.receiptOutcome === "source_revision_conflict" &&
      (row.catalogPolicyProjectionRevision !== null ||
        !/^profile:[1-9][0-9]*$/.test(row.observedCatalogProfileRevision ?? "") ||
        row.observedCatalogProfileRevision === row.receiptCatalogProfileSourceRevision)) ||
    (row.receiptOutcome !== "applied" && row.receiptOutcome !== "source_revision_conflict")
  )
    throw new Error("Stored Booking guest-policy projection receipt is invalid");
  return row.receiptOutcome === "applied"
    ? {
        outcome: "applied",
        receiptId: row.receiptId,
        sourceOutboxEventId: row.receiptSourceOutboxEventId,
        projectedGuestPolicyRevision: row.projectedGuestPolicyRevision,
        projectedBundleHash: row.projectedBundleHash as `sha256:${string}`,
        projectedSourceFingerprint: row.projectedSourceFingerprint as `sha256:${string}`,
        catalogProfileSourceRevision: row.receiptCatalogProfileSourceRevision,
        catalogPolicyProjectionRevision: row.catalogPolicyProjectionRevision!,
        recordedAt: iso(row.receiptRecordedAt),
      }
    : {
        outcome: "source_revision_conflict",
        receiptId: row.receiptId,
        sourceOutboxEventId: row.receiptSourceOutboxEventId,
        projectedGuestPolicyRevision: row.projectedGuestPolicyRevision,
        projectedBundleHash: row.projectedBundleHash as `sha256:${string}`,
        projectedSourceFingerprint: row.projectedSourceFingerprint as `sha256:${string}`,
        catalogProfileSourceRevision: row.receiptCatalogProfileSourceRevision,
        observedCatalogProfileRevision: row.observedCatalogProfileRevision!,
        recordedAt: iso(row.receiptRecordedAt),
      };
}

async function insertDomainEvent(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  input: AcceptedInput,
  event: BookingGuestPolicyChangedEvent,
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
       'booking', $6, $7,
       'user', $8::uuid, $9, $10, $11::jsonb,
       jsonb_build_object('contractVersion', $12::text)
     )`,
    [
      input.domainEventId,
      `booking.guest-policy.property.${prepared.propertyId}.revision.${input.guestPolicyRevision}.changed.v1`,
      BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
      input.acceptedAt.toISOString(),
      prepared.propertyId,
      BOOKING_GUEST_POLICY_RESOURCE_TYPE,
      input.revisionId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      prepared.keyHash,
      JSON.stringify(event),
      BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    ],
  );
}

async function insertOutboxEvent(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  input: AcceptedInput,
  event: BookingGuestPolicyChangedEvent,
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
       'booking', $7, $8,
       $9, $10, $11::jsonb, $12::jsonb,
       $13::timestamptz, $13::timestamptz, $13::timestamptz
     )`,
    [
      input.outboxEventId,
      input.domainEventId,
      `booking.guest-policy.property.${prepared.propertyId}.revision.${input.guestPolicyRevision}.catalog.v1`,
      BOOKING_GUEST_POLICY_OUTBOX_DESTINATION,
      BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
      prepared.propertyId,
      BOOKING_GUEST_POLICY_RESOURCE_TYPE,
      input.revisionId,
      command.audit.correlationId ?? command.audit.requestId,
      prepared.keyHash,
      JSON.stringify(event),
      JSON.stringify({
        contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
        ...BOOKING_GUEST_POLICY_OUTBOX_METADATA,
      }),
      input.acceptedAt.toISOString(),
    ],
  );
}

async function insertAudit(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  input: Pick<AcceptedInput, "auditEventId" | "idempotencyId" | "acceptedAt"> &
    Partial<Pick<AcceptedInput, "domainEventId">>,
  result:
    | Readonly<{
        ok: true;
        outcome: "created" | "updated";
        revisionId: string;
        guestPolicyRevision: number;
        confirmationRevision: number;
      }>
    | Readonly<{ ok: false; errorCode: string }>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       id, audit_key, product, action, occurred_at,
       tenant_scope, organization_id, property_id,
       actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1::uuid, $2, 'booking', $3, $4::timestamptz,
       'property', NULL, $5::uuid,
       'user', $6::uuid,
       'booking', $7, $8,
       $9::uuid, $10::uuid, $11, $12,
       $13::jsonb, jsonb_build_object('contractVersion', $14::text)
     )`,
    [
      input.auditEventId,
      `booking.guest-policy.property.${prepared.propertyId}.key.${prepared.keyHash}.v1`,
      result.ok ? `booking.guest_policy.${result.outcome}` : "booking.guest_policy.upsert.rejected",
      input.acceptedAt.toISOString(),
      prepared.propertyId,
      command.audit.actor.userId,
      BOOKING_GUEST_POLICY_RESOURCE_TYPE,
      result.ok ? result.revisionId : prepared.propertyId,
      input.domainEventId ?? null,
      input.idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(
        result.ok
          ? {
              outcome: result.outcome,
              guestPolicyRevision: result.guestPolicyRevision,
              confirmationRevision: result.confirmationRevision,
            }
          : { outcome: "rejected", errorCode: result.errorCode },
      ),
      BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    ],
  );
}

async function insertRevision(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  input: AcceptedInput,
): Promise<void> {
  const bundle = command.bundle;
  await client.query(
    `INSERT INTO booking.guest_policy_revisions (
       revision_id, organization_id, property_id, guest_policy_revision,
       contract_version, default_guest_language, children_enabled, adult_age_threshold,
       phone_required, arrival_time_enabled, special_requests_enabled, guest_count_enabled,
       check_in_time, check_out_time, pricing_currency, property_time_zone,
       catalog_profile_source_revision, pricing_source_fingerprint,
       mandatory_charge_confirmation_revision, source_bindings, source_fingerprint,
       policy_bundle, bundle_hash, idempotency_key_id, domain_event_id,
       outbox_event_id, audit_event_id, accepted_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5, $6, $7, $8,
       $9, $10, $11, FALSE,
       $12::time, $13::time, $14, $15,
       $16, $17, $18, $19::jsonb, $20,
       $21::jsonb, $22, $23::uuid, $24::uuid,
       $25::uuid, $26::uuid, $27::timestamptz
     )`,
    [
      input.revisionId,
      prepared.organizationId,
      prepared.propertyId,
      input.guestPolicyRevision,
      BOOKING_GUEST_POLICY_CONTRACT_VERSION,
      bundle.choices.defaultGuestLanguage,
      bundle.choices.childrenEnabled,
      bundle.choices.adultAgeThreshold,
      bundle.choices.phoneRequired,
      bundle.choices.arrivalTimeEnabled,
      bundle.choices.specialRequestsEnabled,
      bundle.choices.checkInTime,
      bundle.choices.checkOutTime,
      bundle.pricingCurrency,
      bundle.propertyTimeZone,
      prepared.catalogProfileSourceRevision,
      bundle.pricingSourceFingerprint,
      bundle.mandatoryChargeConfirmationRevision,
      JSON.stringify(bundle.sourceBindings),
      bundle.sourceFingerprint,
      JSON.stringify(bundle),
      bundle.bundleHash,
      input.idempotencyId,
      input.domainEventId,
      input.outboxEventId,
      input.auditEventId,
      input.acceptedAt.toISOString(),
    ],
  );
}

async function insertConfirmation(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  input: AcceptedInput,
  confirmation: BookingGuestPolicyRevision["confirmation"],
  current: BookingGuestPolicyRevision | null,
): Promise<void> {
  await client.query(
    `INSERT INTO booking.booking_policy_confirmations (
       confirmation_id, organization_id, property_id, confirmation_revision,
       guest_policy_revision_id, guest_policy_revision, bundle_hash,
       source_fingerprint, confirmation_basis, based_on_confirmation_id,
       based_on_confirmation_revision, reviewed_at, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5::uuid, $6, $7,
       $8, $9, $10::uuid,
       $11, $12::timestamptz, $13::timestamptz
     )`,
    [
      input.confirmationId,
      prepared.organizationId,
      prepared.propertyId,
      input.confirmationRevision,
      input.revisionId,
      input.guestPolicyRevision,
      command.bundle.bundleHash,
      command.bundle.sourceFingerprint,
      confirmation.basis,
      confirmation.basedOnConfirmationId,
      confirmation.basis === "unchanged_policy_bundle"
        ? current!.confirmation.confirmationRevision
        : null,
      confirmation.reviewedAt,
      confirmation.recordedAt,
    ],
  );
}

async function advanceCurrent(
  client: RepositoryClient,
  prepared: PreparedCommand,
  input: AcceptedInput,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO booking.current_working_guest_policy_revisions (
       property_id, organization_id, revision_id, guest_policy_revision,
       confirmation_id, confirmation_revision, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       revision_id = EXCLUDED.revision_id,
       guest_policy_revision = EXCLUDED.guest_policy_revision,
       confirmation_id = EXCLUDED.confirmation_id,
       confirmation_revision = EXCLUDED.confirmation_revision,
       updated_at = EXCLUDED.updated_at
     WHERE booking.current_working_guest_policy_revisions.guest_policy_revision = $4 - 1`,
    [
      prepared.propertyId,
      prepared.organizationId,
      input.revisionId,
      input.guestPolicyRevision,
      input.confirmationId,
      input.confirmationRevision,
      input.acceptedAt.toISOString(),
    ],
  );
  if (result.rowCount !== 1)
    throw new Error("Booking guest-policy current revision advance failed");
}

async function finalizeFailure(
  client: RepositoryClient,
  command: PersistBookingGuestPolicyCommand,
  prepared: PreparedCommand,
  idempotencyId: string,
  result: BookingGuestPolicyCommandResult,
  acceptedAt: Date,
  auditEventId: string,
): Promise<BookingGuestPolicyCommandResult> {
  if (result.ok) throw new Error("Booking guest-policy failure finalization received success");
  await insertAudit(
    client,
    command,
    prepared,
    { auditEventId, idempotencyId, acceptedAt },
    { ok: false, errorCode: result.error.code },
  );
  await completeIdempotency(client, idempotencyId, null, result, acceptedAt);
  await client.query("COMMIT");
  return result;
}

async function completeIdempotency(
  client: RepositoryClient,
  idempotencyId: string,
  revisionId: string | null,
  result: BookingGuestPolicyCommandResult,
  acceptedAt: Date,
): Promise<void> {
  const metadataResult = result.ok
    ? { ok: true, outcome: result.outcome === "idempotent_replay" ? "updated" : result.outcome }
    : result;
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
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(idempotencyResponseIdentity(result))),
      result.ok ? "booking" : null,
      result.ok ? BOOKING_GUEST_POLICY_RESOURCE_TYPE : null,
      revisionId,
      acceptedAt.toISOString(),
      JSON.stringify(metadataResult),
    ],
  );
  if (completed.rowCount !== 1)
    throw new Error("Booking guest-policy idempotency completion failed");
}

function validateProjectionReceiptCommand(
  command: RecordBookingGuestPolicyProjectionReceiptCommand,
): void {
  if (
    !uuid(command.organizationId) ||
    !uuid(command.propertyId) ||
    !uuid(command.revisionId) ||
    !revision(command.guestPolicyRevision, false) ||
    !uuid(command.sourceOutboxEventId) ||
    !/^sha256:[0-9a-f]{64}$/.test(command.bundleHash) ||
    !/^sha256:[0-9a-f]{64}$/.test(command.sourceFingerprint) ||
    !/^profile:[1-9][0-9]*$/.test(command.catalogProfileSourceRevision) ||
    !canonicalIso(command.recordedAt) ||
    (command.result.outcome === "applied"
      ? !revision(command.result.catalogPolicyProjectionRevision, false)
      : !/^profile:[1-9][0-9]*$/.test(command.result.observedCatalogProfileRevision) ||
        command.result.observedCatalogProfileRevision === command.catalogProfileSourceRevision)
  )
    throw new TypeError("Booking guest-policy projection receipt command is invalid");
}

async function insertProjectionReceipt(
  client: RepositoryClient,
  receiptId: string,
  command: RecordBookingGuestPolicyProjectionReceiptCommand,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO booking.guest_policy_projection_receipts (
       receipt_id, organization_id, property_id, guest_policy_revision_id,
       guest_policy_revision, source_outbox_event_id, bundle_hash,
       source_fingerprint, catalog_profile_source_revision, outcome,
       catalog_policy_projection_revision, observed_catalog_profile_revision, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, $6::uuid, $7,
       $8, $9, $10,
       $11, $12, $13::timestamptz
     )
     ON CONFLICT (source_outbox_event_id) DO NOTHING
     RETURNING receipt_id`,
    [
      receiptId,
      command.organizationId,
      command.propertyId,
      command.revisionId,
      command.guestPolicyRevision,
      command.sourceOutboxEventId,
      command.bundleHash,
      command.sourceFingerprint,
      command.catalogProfileSourceRevision,
      command.result.outcome,
      command.result.outcome === "applied" ? command.result.catalogPolicyProjectionRevision : null,
      command.result.outcome === "source_revision_conflict"
        ? command.result.observedCatalogProfileRevision
        : null,
      command.recordedAt,
    ],
  );
  return result.rowCount === 1;
}

async function readProjectionReceipt(
  client: RepositoryClient,
  sourceOutboxEventId: string,
  lock: boolean,
): Promise<StoredProjectionReceipt | null> {
  const result = await client.query<ProjectionReceiptRow>(
    `SELECT organization_id::text AS "organizationId",
            property_id::text AS "propertyId",
            guest_policy_revision_id::text AS "revisionId",
            outcome, receipt_id::text AS "receiptId",
            source_outbox_event_id::text AS "sourceOutboxEventId",
            guest_policy_revision AS "projectedGuestPolicyRevision",
            bundle_hash AS "projectedBundleHash",
            source_fingerprint AS "projectedSourceFingerprint",
            catalog_profile_source_revision AS "catalogProfileSourceRevision",
            catalog_policy_projection_revision AS "catalogPolicyProjectionRevision",
            observed_catalog_profile_revision AS "observedCatalogProfileRevision",
            recorded_at AS "recordedAt"
     FROM booking.guest_policy_projection_receipts
     WHERE source_outbox_event_id = $1::uuid
     ${lock ? "FOR UPDATE" : ""}`,
    [sourceOutboxEventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    !uuid(row.organizationId) ||
    !uuid(row.propertyId) ||
    !uuid(row.revisionId) ||
    !uuid(row.receiptId) ||
    !uuid(row.sourceOutboxEventId) ||
    !revision(row.projectedGuestPolicyRevision, false) ||
    !/^sha256:[0-9a-f]{64}$/.test(row.projectedBundleHash) ||
    !/^sha256:[0-9a-f]{64}$/.test(row.projectedSourceFingerprint) ||
    !/^profile:[1-9][0-9]*$/.test(row.catalogProfileSourceRevision) ||
    (row.outcome === "applied" &&
      (!revision(row.catalogPolicyProjectionRevision, false) ||
        row.observedCatalogProfileRevision !== null)) ||
    (row.outcome === "source_revision_conflict" &&
      (row.catalogPolicyProjectionRevision !== null ||
        !/^profile:[1-9][0-9]*$/.test(row.observedCatalogProfileRevision ?? "") ||
        row.observedCatalogProfileRevision === row.catalogProfileSourceRevision)) ||
    (row.outcome !== "applied" && row.outcome !== "source_revision_conflict")
  )
    throw new Error("Stored Booking guest-policy projection receipt is invalid");
  const receipt =
    row.outcome === "applied"
      ? {
          outcome: "applied" as const,
          receiptId: row.receiptId,
          sourceOutboxEventId: row.sourceOutboxEventId,
          projectedGuestPolicyRevision: row.projectedGuestPolicyRevision,
          projectedBundleHash: row.projectedBundleHash as `sha256:${string}`,
          projectedSourceFingerprint: row.projectedSourceFingerprint as `sha256:${string}`,
          catalogProfileSourceRevision: row.catalogProfileSourceRevision,
          catalogPolicyProjectionRevision: row.catalogPolicyProjectionRevision!,
          recordedAt: iso(row.recordedAt),
        }
      : {
          outcome: "source_revision_conflict" as const,
          receiptId: row.receiptId,
          sourceOutboxEventId: row.sourceOutboxEventId,
          projectedGuestPolicyRevision: row.projectedGuestPolicyRevision,
          projectedBundleHash: row.projectedBundleHash as `sha256:${string}`,
          projectedSourceFingerprint: row.projectedSourceFingerprint as `sha256:${string}`,
          catalogProfileSourceRevision: row.catalogProfileSourceRevision,
          observedCatalogProfileRevision: row.observedCatalogProfileRevision!,
          recordedAt: iso(row.recordedAt),
        };
  return {
    organizationId: row.organizationId.toLowerCase(),
    propertyId: row.propertyId.toLowerCase(),
    revisionId: row.revisionId.toLowerCase(),
    receipt,
  };
}

type StoredProjectionReceipt = Readonly<{
  organizationId: string;
  propertyId: string;
  revisionId: string;
  receipt: BookingGuestPolicyProjectionReceipt;
}>;

function receiptMatchesCommand(
  stored: StoredProjectionReceipt,
  command: RecordBookingGuestPolicyProjectionReceiptCommand,
): boolean {
  const { receipt } = stored;
  return (
    stored.organizationId === command.organizationId.toLowerCase() &&
    stored.propertyId === command.propertyId.toLowerCase() &&
    stored.revisionId === command.revisionId.toLowerCase() &&
    receipt.sourceOutboxEventId === command.sourceOutboxEventId.toLowerCase() &&
    receipt.projectedGuestPolicyRevision === command.guestPolicyRevision &&
    receipt.projectedBundleHash === command.bundleHash &&
    receipt.projectedSourceFingerprint === command.sourceFingerprint &&
    receipt.catalogProfileSourceRevision === command.catalogProfileSourceRevision &&
    (receipt.outcome === "applied"
      ? command.result.outcome === "applied" &&
        receipt.catalogPolicyProjectionRevision === command.result.catalogPolicyProjectionRevision
      : command.result.outcome === "source_revision_conflict" &&
        receipt.observedCatalogProfileRevision === command.result.observedCatalogProfileRevision)
  );
}

async function rollback(client: RepositoryClient, prior?: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    if (prior && typeof prior === "object")
      Object.defineProperty(prior, "rollbackError", { value: rollbackError });
    else if (!prior) throw rollbackError;
  }
}

function rejectedReplay(
  code: "command_in_progress" | "idempotency_key_conflict" | "setup_scope_unavailable",
): BookingGuestPolicyAuthorizedReplayResult {
  return Object.freeze({ outcome: "rejected", error: Object.freeze({ code }) });
}

function failure(
  error: Extract<BookingGuestPolicyCommandResult, { ok: false }>["error"],
): BookingGuestPolicyCommandResult {
  return { ok: false, error };
}

function responseStatus(result: BookingGuestPolicyCommandResult): 200 | 409 | 422 {
  if (result.ok) return 200;
  return result.error.code === "policy_confirmation_required" ||
    result.error.code === "guest_policy_not_ready"
    ? 422
    : 409;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function idempotencyResponseIdentity(
  result: BookingGuestPolicyCommandResult,
): BookingGuestPolicyCommandResult {
  if (!result.ok) return result;
  return {
    ...result,
    revision: { ...result.revision, projectionReceipt: null },
  };
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
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Stored Booking guest-policy date is invalid");
  return parsed.toISOString();
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function revision(value: unknown, zero: boolean): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1) && Number(value) <= 2_147_483_647
  );
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function lockUnavailable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    ((value as { code?: unknown }).code === "55P03" ||
      (value as { code?: unknown }).code === "57014")
  );
}
