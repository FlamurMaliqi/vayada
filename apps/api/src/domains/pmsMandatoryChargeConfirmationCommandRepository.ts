import { createHash } from "node:crypto";

import {
  PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_DESTINATION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_METADATA,
  PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
  PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
  parseConfirmMandatoryChargesIncludedCommand,
  parseConfirmMandatoryChargesIncludedResult,
  parsePmsMandatoryChargesConfirmedEvent,
  serializeConfirmMandatoryChargesIncludedFingerprint,
  type ConfirmMandatoryChargesIncludedCommand,
  type ConfirmMandatoryChargesIncludedResult,
  type PmsMandatoryChargeConfirmationCommandError,
  type PmsMandatoryChargeConfirmationCommandPort,
  type PmsMandatoryChargePricingSourceRevisionManifest,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";
import { loadPmsMandatoryChargePricingSourceSnapshot } from "./pmsMandatoryChargePricingSourceSnapshot.js";

export type PmsMandatoryChargeConfirmationCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsMandatoryChargeConfirmationCommandPool = {
  connect(): Promise<PmsMandatoryChargeConfirmationCommandClient>;
  end?(): Promise<void>;
};

export type PmsMandatoryChargeConfirmationCommandRepository =
  PmsMandatoryChargeConfirmationCommandPort & { close(): Promise<void> };

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};

type IdempotencyReservation = { id: string };
type CurrentConfirmationRow = { confirmationRevision: number | string };
type InsertedIdRow = { id: string };

const MANAGE_PERMISSION = "pms.operations.manage";

export function createPgPmsMandatoryChargeConfirmationCommandRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PmsMandatoryChargeConfirmationCommandPool;
  now?: () => Date;
}): PmsMandatoryChargeConfirmationCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS mandatory-charge confirmation repository connectionString is empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsMandatoryChargeConfirmationCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async confirmMandatoryChargesIncluded(input) {
      const command = parseConfirmMandatoryChargesIncludedCommand(input);
      if (!command) throw new Error("PMS mandatory-charge confirmation command is malformed");
      const acceptedAt = commandTime(now);
      if (!validDate(acceptedAt)) {
        throw new Error("PMS mandatory-charge confirmation repository clock is invalid");
      }
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprint = sha256(
        serializeConfirmMandatoryChargesIncludedFingerprint(command),
      );
      const client = await connect(pool);

      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }

        const replay = await findReplay(client, command, keyHash, requestFingerprint);
        if (replay) {
          await rollbackQuietly(client);
          return replay;
        }
        const reservation = await reserveIdempotency(
          client,
          command,
          keyHash,
          requestFingerprint,
          acceptedAt,
        );
        if (!reservation) {
          const concurrentReplay = await findReplay(client, command, keyHash, requestFingerprint);
          await rollbackQuietly(client);
          return concurrentReplay ?? failure({ code: "command_in_progress" });
        }

        await lockPropertyPricingScope(client, command.propertyId);
        await lockPmsRoomFactsMutationScope(client, command.propertyId);
        const source = await loadPmsMandatoryChargePricingSourceSnapshot(
          client,
          command.propertyId,
          acceptedAt,
        );
        if (!source) {
          return commitFailure(
            client,
            reservation.id,
            failure({ code: "pricing_source_not_configured" }),
            acceptedAt,
          );
        }
        if (
          sha256(source.serializedPayload) !== command.claimedPricingSourceFingerprint ||
          !sameManifest(source.sourceRevisions, command.expectedPricingSourceRevisions)
        ) {
          return commitFailure(
            client,
            reservation.id,
            failure({ code: "pricing_source_conflict" }),
            acceptedAt,
          );
        }

        const currentRevision = await lockCurrentConfirmationRevision(client, command.propertyId);
        if (currentRevision !== command.expectedConfirmationRevision) {
          return commitFailure(
            client,
            reservation.id,
            failure({ code: "confirmation_revision_conflict", currentRevision }),
            acceptedAt,
          );
        }
        const confirmationRevision = currentRevision + 1;
        if (confirmationRevision > 2_147_483_647) {
          throw new Error("PMS mandatory-charge confirmation revision is exhausted");
        }

        const result = await writeConfirmation(
          client,
          command,
          reservation,
          confirmationRevision,
          source.sourceRevisions,
          acceptedAt,
        );
        await completeIdempotency(client, reservation.id, result, acceptedAt);
        await client.query("COMMIT");
        return result;
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS mandatory-charge confirmation repository failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) {
        throw new Error("Owned PMS mandatory-charge confirmation pool cannot be closed");
      }
      await pool.end();
      closed = true;
    },
  };
}

async function lockAuthorizedScope(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
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
      AND resource.relationship IN ('owner', 'operator')
      AND resource.status = 'active'
     JOIN identity.users actor
       ON actor.id = $3::uuid AND actor.status = 'active'
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
         OR (resource_product = 'pms' AND resource_type = 'pms_property'
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

async function findReplay(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  keyHash: string,
  requestFingerprint: string,
): Promise<ConfirmMandatoryChargesIncludedResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprint) {
    return failure({ code: "idempotency_key_conflict" });
  }
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = parseConfirmMandatoryChargesIncludedResult(stored);
  if (
    !parsed ||
    existing.responseStatusCode !== responseStatus(parsed) ||
    existing.responseBodyHash !== sha256(stableJson(responseBody(parsed)))
  ) {
    return failure({ code: "idempotency_key_conflict" });
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  keyHash: string,
  requestFingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, NULL,
       $5::timestamptz, $5::timestamptz, 'infinity'::timestamptz,
       '{}'::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
      keyHash,
      requestFingerprint,
      command.propertyId,
      at.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function lockPropertyPricingScope(
  client: PmsMandatoryChargeConfirmationCommandClient,
  propertyId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(concat('pms-pricing-currency:', $1::uuid::text), 0)
     )`,
    [propertyId],
  );
}

async function lockCurrentConfirmationRevision(
  client: PmsMandatoryChargeConfirmationCommandClient,
  propertyId: string,
): Promise<number> {
  const result = await client.query<CurrentConfirmationRow>(
    `SELECT confirmation_revision AS "confirmationRevision"
     FROM pms.mandatory_charge_confirmation_revisions
     WHERE property_id = $1::uuid
     ORDER BY confirmation_revision DESC
     LIMIT 1
     FOR UPDATE`,
    [propertyId],
  );
  return result.rows[0] ? positiveInteger(result.rows[0].confirmationRevision) : 0;
}

async function writeConfirmation(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  reservation: IdempotencyReservation,
  confirmationRevision: number,
  sourceRevisions: PmsMandatoryChargePricingSourceRevisionManifest,
  acceptedAt: Date,
): Promise<ConfirmMandatoryChargesIncludedResult> {
  if (command.audit.actor.kind !== "user") {
    throw new Error("PMS mandatory-charge confirmation requires a user actor");
  }
  const event = parsePmsMandatoryChargesConfirmedEvent({
    contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
    eventType: PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    confirmationRevision,
    pricingCurrencyRevision: sourceRevisions.pricingCurrencyRevision,
    optionalPricingAggregateRevision: sourceRevisions.optionalPricingAggregateRevision,
    outcome: "confirmed",
  });
  if (!event) throw new Error("PMS mandatory-charge confirmation event is invalid");

  await client.query("SAVEPOINT pms_mandatory_charge_confirmation_write");
  const domainEventId = await insertDomainEvent(client, command, event, acceptedAt);
  const outboxEventId = await insertOutbox(client, command, event, domainEventId);
  const auditEventId = await insertAudit(
    client,
    command,
    event,
    reservation,
    domainEventId,
    acceptedAt,
  );
  const inserted = await client.query(
    `INSERT INTO pms.mandatory_charge_confirmation_revisions (
       organization_id, property_id, confirmation_revision, contract_version,
       pricing_source_fingerprint, pricing_currency_revision,
       optional_pricing_aggregate_revision, idempotency_key_id,
       domain_event_id, outbox_event_id, audit_event_id, confirmed_at
     )
     SELECT $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
            $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::timestamptz
     WHERE $13 = COALESCE((
       SELECT max(confirmation_revision)
       FROM pms.mandatory_charge_confirmation_revisions
       WHERE property_id = $2::uuid
     ), 0)`,
    [
      command.organizationId,
      command.propertyId,
      confirmationRevision,
      PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
      command.claimedPricingSourceFingerprint,
      sourceRevisions.pricingCurrencyRevision,
      sourceRevisions.optionalPricingAggregateRevision,
      reservation.id,
      domainEventId,
      outboxEventId,
      auditEventId,
      acceptedAt.toISOString(),
      command.expectedConfirmationRevision,
    ],
  );
  if (inserted.rowCount !== 1) {
    await client.query("ROLLBACK TO SAVEPOINT pms_mandatory_charge_confirmation_write");
    await client.query("RELEASE SAVEPOINT pms_mandatory_charge_confirmation_write");
    const currentRevision = await lockCurrentConfirmationRevision(client, command.propertyId);
    return failure({ code: "confirmation_revision_conflict", currentRevision });
  }
  await client.query("RELEASE SAVEPOINT pms_mandatory_charge_confirmation_write");

  return result({
    ok: true,
    response: {
      contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
      outcome: "confirmed",
      evidence: {
        organizationId: command.organizationId,
        propertyId: command.propertyId,
        pricingSourceFingerprint: command.claimedPricingSourceFingerprint,
        confirmationRevision,
        confirmedAt: acceptedAt.toISOString(),
      },
      acceptedAt: acceptedAt.toISOString(),
    },
  });
}

async function insertDomainEvent(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  event: NonNullable<ReturnType<typeof parsePmsMandatoryChargesConfirmedEvent>>,
  acceptedAt: Date,
): Promise<string> {
  const inserted = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, payload,
       event_metadata, privacy_scope
     ) VALUES (
       'pms', $1, $2, 1, $3::timestamptz, 'property', NULL, $4::uuid,
       'pms', $5, $4, 'user', $6::uuid, $7::jsonb, '{}'::jsonb, 'confidential'
     )
     RETURNING id::text AS id`,
    [
      `pms.mandatory_charges.confirmed.property.${command.propertyId}.revision.${event.confirmationRevision}.v1`,
      PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
      acceptedAt.toISOString(),
      command.propertyId,
      PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      JSON.stringify(event),
    ],
  );
  return insertedId(inserted.rows[0], "domain event");
}

async function insertOutbox(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  event: NonNullable<ReturnType<typeof parsePmsMandatoryChargesConfirmedEvent>>,
  domainEventId: string,
): Promise<string> {
  const inserted = await client.query<InsertedIdRow>(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, $4, 'property', NULL, $5::uuid, 'pms', $6,
       $5, $7::jsonb, $8::jsonb
     )
     RETURNING id::text AS id`,
    [
      domainEventId,
      `booking.pricing-source.mandatory_charge_confirmation.property.${command.propertyId}.revision.${event.confirmationRevision}.v1`,
      PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_DESTINATION,
      PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
      command.propertyId,
      PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
      JSON.stringify(event),
      JSON.stringify(PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_METADATA),
    ],
  );
  return insertedId(inserted.rows[0], "outbox event");
}

async function insertAudit(
  client: PmsMandatoryChargeConfirmationCommandClient,
  command: ConfirmMandatoryChargesIncludedCommand,
  event: NonNullable<ReturnType<typeof parsePmsMandatoryChargesConfirmedEvent>>,
  reservation: IdempotencyReservation,
  domainEventId: string,
  acceptedAt: Date,
): Promise<string> {
  const inserted = await client.query<InsertedIdRow>(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id,
       idempotency_key_id, redacted_payload, private_payload, audit_metadata,
       privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid,
       'user', $5::uuid, 'pms', $6, $4, $7::uuid, $8::uuid,
       $9::jsonb, '{}'::jsonb, '{}'::jsonb, 'confidential'
     )
     RETURNING id::text AS id`,
    [
      `pms.mandatory_charge_confirmation.property.${command.propertyId}.revision.${event.confirmationRevision}.v1`,
      PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
      acceptedAt.toISOString(),
      command.propertyId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
      domainEventId,
      reservation.id,
      JSON.stringify({
        contractVersion: event.contractVersion,
        organizationId: event.organizationId,
        propertyId: event.propertyId,
        confirmationRevision: event.confirmationRevision,
        pricingCurrencyRevision: event.pricingCurrencyRevision,
        optionalPricingAggregateRevision: event.optionalPricingAggregateRevision,
        outcome: event.outcome,
      }),
    ],
  );
  return insertedId(inserted.rows[0], "audit event");
}

async function completeIdempotency(
  client: PmsMandatoryChargeConfirmationCommandClient,
  id: string,
  completedResult: ConfirmMandatoryChargesIncludedResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      responseStatus(completedResult),
      sha256(stableJson(responseBody(completedResult))),
      at.toISOString(),
      JSON.stringify(completedResult),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("PMS mandatory-charge confirmation idempotency completion failed");
  }
}

async function commitFailure(
  client: PmsMandatoryChargeConfirmationCommandClient,
  id: string,
  failedResult: ConfirmMandatoryChargesIncludedResult,
  at: Date,
): Promise<ConfirmMandatoryChargesIncludedResult> {
  await completeIdempotency(client, id, failedResult, at);
  await client.query("COMMIT");
  return failedResult;
}

function sameManifest(
  left: PmsMandatoryChargePricingSourceRevisionManifest,
  right: PmsMandatoryChargePricingSourceRevisionManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failure(
  error: PmsMandatoryChargeConfirmationCommandError,
): ConfirmMandatoryChargesIncludedResult {
  return result({ ok: false, error });
}

function result(value: unknown): ConfirmMandatoryChargesIncludedResult {
  const parsed = parseConfirmMandatoryChargesIncludedResult(value);
  if (!parsed) throw new Error("PMS mandatory-charge confirmation result is invalid");
  return parsed;
}

function responseBody(value: ConfirmMandatoryChargesIncludedResult): unknown {
  return value.ok ? value.response : value.error;
}

function responseStatus(value: ConfirmMandatoryChargesIncludedResult): number {
  if (value.ok) return 200;
  return value.error.code === "setup_scope_unavailable" ? 404 : 409;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function insertedId(row: InsertedIdRow | undefined, resource: string): string {
  if (!row?.id) throw new Error(`PMS mandatory-charge confirmation ${resource} insert failed`);
  return row.id;
}

function positiveInteger(value: number | string): number {
  const parsed =
    typeof value === "number" ? value : /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("PMS mandatory-charge confirmation database revision is invalid");
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function commandTime(now: () => Date): Date {
  try {
    return now();
  } catch {
    throw new Error("PMS mandatory-charge confirmation repository clock is unavailable");
  }
}

async function connect(
  pool: PmsMandatoryChargeConfirmationCommandPool,
): Promise<PmsMandatoryChargeConfirmationCommandClient> {
  try {
    return await pool.connect();
  } catch {
    throw new Error("PMS mandatory-charge confirmation repository is unavailable");
  }
}

function releaseQuietly(client: PmsMandatoryChargeConfirmationCommandClient): void {
  try {
    client.release();
  } catch {
    // The transaction outcome is already known and connection details stay private.
  }
}

async function rollbackQuietly(client: PmsMandatoryChargeConfirmationCommandClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the secret-safe repository error.
  }
}
