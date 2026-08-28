import {
  FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
  type AcceptFinanceOnlineCardExecutionEvidenceCommand,
  type FinanceOnlineCardExecutionEvidenceResponse,
  type FinanceOnlineCardExecutionEvidenceResult,
  type FinancePlatformOnlineCardExecutionEvidenceRepository,
  type RevokeFinanceOnlineCardExecutionEvidenceCommand,
} from "@vayada/domain-finance";
import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

import { PROJECT_PUBLIC_BOOKABILITY_PROFILE } from "../platform/publicBookabilityPublication.js";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type FinanceOnlineCardEvidencePool = {
  connect(): Promise<Client>;
};

type ProviderRow = {
  providerAccountId: string;
  cardCapabilityRevision: number | string;
  propertyReadinessRevision: number | string;
  status: string;
  onboardingStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  cardPaymentsStatus: string | null;
  cardCapabilityActive: boolean;
};

type EvidenceRow = {
  evidenceId: string;
  providerCapabilityRevision: number | string;
  propertyReadinessRevision: number | string;
  acceptedAt: Date | string;
  revokedAt: Date | string | null;
};

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: unknown;
};

type UserActor = { kind: "user"; userId: string; organizationId: string };
type UserAcceptCommand = AcceptFinanceOnlineCardExecutionEvidenceCommand & {
  audit: { actor: UserActor };
};
type UserRevokeCommand = RevokeFinanceOnlineCardExecutionEvidenceCommand & {
  audit: { actor: UserActor };
};
type UserEvidenceCommand = UserAcceptCommand | UserRevokeCommand;

const OUTBOX_DESTINATION = "booking.payment-source";

export function createFinanceOnlineCardExecutionEvidenceRepository(
  pool: FinanceOnlineCardEvidencePool,
): FinancePlatformOnlineCardExecutionEvidenceRepository {
  return {
    async acceptOnlineCardExecutionEvidence(command) {
      if (!validAcceptCommand(command)) return invalidCommand();
      return transaction(pool, (client) => accept(client, command));
    },
    async revokeOnlineCardExecutionEvidence(command) {
      if (!validRevokeCommand(command)) return invalidCommand();
      return transaction(pool, (client) => revoke(client, command));
    },
  };
}

async function accept(
  client: Client,
  command: UserAcceptCommand,
): Promise<FinanceOnlineCardExecutionEvidenceResult> {
  const operation = "finance.online_card_execution_evidence.accept";
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = commandFingerprint(command);
  const replay = await replayResult(client, operation, command.propertyId, keyHash, fingerprint);
  if (replay) return replay;

  await lockPropertySettings(client, command.propertyId);
  const provider = await lockProvider(client, command.propertyId);
  if (!provider) return failure(404, "provider_account_not_found", "Stripe account was not found.");
  const revision = positiveInteger(provider.cardCapabilityRevision);
  if (!revision || revision !== command.payload.expectedCardCapabilityRevision) {
    return failure(
      409,
      "provider_capability_revision_conflict",
      "Stripe capability state changed. Run the ONB-25A test again.",
    );
  }
  const propertyRevision = positiveInteger(provider.propertyReadinessRevision);
  if (!propertyRevision || propertyRevision !== command.payload.expectedPropertyReadinessRevision) {
    return failure(
      409,
      "property_readiness_revision_conflict",
      "Payment settings changed. Run the ONB-25A test again.",
    );
  }
  if (!providerReady(provider)) {
    return failure(
      409,
      "provider_capability_unavailable",
      "Stripe capability readiness is unavailable.",
    );
  }
  if (!(await reserve(client, operation, command, keyHash, fingerprint))) {
    return (
      (await replayResult(client, operation, command.propertyId, keyHash, fingerprint)) ??
      failure(409, "idempotency_conflict", "Idempotency key is already in use.")
    );
  }

  const inserted = await client.query<EvidenceRow>(
    `INSERT INTO finance.online_card_execution_evidence (
       property_id, provider_account_id, contract_version, test_suite,
       provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
       executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'onb-25a', $4, $5, $6,
       $7::timestamptz, $8::timestamptz, $9::uuid, $10::uuid
     )
     ON CONFLICT DO NOTHING
     RETURNING id::text AS "evidenceId",
       provider_capability_revision AS "providerCapabilityRevision",
       property_readiness_revision AS "propertyReadinessRevision",
       accepted_at AS "acceptedAt", revoked_at AS "revokedAt"`,
    [
      command.propertyId,
      provider.providerAccountId,
      FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
      revision,
      propertyRevision,
      command.payload.evidenceFingerprintHash,
      command.payload.executedAt,
      command.audit.requestedAt,
      command.audit.actor.organizationId,
      command.audit.actor.userId,
    ],
  );
  const evidence = inserted.rows[0];
  if (!evidence) {
    return failure(
      409,
      "provider_capability_revision_conflict",
      "Current execution evidence already exists for this Stripe account.",
    );
  }
  const cardReady = await currentCardReady(client, command.propertyId);
  const response = responseFor(command, evidence, "accepted", null, cardReady, cardReady, keyHash);
  if (cardReady) await emitReadinessChange(client, command, evidence, "readiness_gained");
  await audit(client, command, evidence, response, keyHash);
  await complete(client, operation, command.propertyId, keyHash, response);
  return { ok: true, status: "accepted", response };
}

async function revoke(
  client: Client,
  command: UserRevokeCommand,
): Promise<FinanceOnlineCardExecutionEvidenceResult> {
  const operation = "finance.online_card_execution_evidence.revoke";
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = commandFingerprint(command);
  const replay = await replayResult(client, operation, command.propertyId, keyHash, fingerprint);
  if (replay) return replay;

  await lockPropertySettings(client, command.propertyId);

  const evidenceResult = await client.query<EvidenceRow>(
    `SELECT id::text AS "evidenceId",
            provider_capability_revision AS "providerCapabilityRevision",
            property_readiness_revision AS "propertyReadinessRevision",
            accepted_at AS "acceptedAt", revoked_at AS "revokedAt"
     FROM finance.online_card_execution_evidence
     WHERE id = $1::uuid AND property_id = $2::uuid
     FOR UPDATE`,
    [command.payload.evidenceId, command.propertyId],
  );
  const evidence = evidenceResult.rows[0];
  if (!evidence) return failure(404, "evidence_not_found", "Execution evidence was not found.");
  if (evidence.revokedAt) {
    return failure(409, "evidence_not_found", "Execution evidence was already revoked.");
  }
  if (!(await reserve(client, operation, command, keyHash, fingerprint))) {
    return (
      (await replayResult(client, operation, command.propertyId, keyHash, fingerprint)) ??
      failure(409, "idempotency_conflict", "Idempotency key is already in use.")
    );
  }

  const wasReady = await currentCardReady(client, command.propertyId);
  const revokedAt = command.audit.requestedAt;
  await client.query(
    `UPDATE finance.online_card_execution_evidence
     SET revoked_at = $2::timestamptz, updated_at = $2::timestamptz
     WHERE id = $1::uuid AND revoked_at IS NULL`,
    [evidence.evidenceId, revokedAt],
  );
  const response = responseFor(command, evidence, "revoked", revokedAt, false, wasReady, keyHash);
  if (wasReady) {
    await emitReadinessChange(client, command, evidence, "readiness_lost");
  }
  // Repair a stale public projection even when the source was already unready.
  await suppressPublishedCard(client, command.propertyId);
  await audit(client, command, evidence, response, keyHash);
  await complete(client, operation, command.propertyId, keyHash, response);
  return { ok: true, status: "revoked", response };
}

async function lockPropertySettings(client: Client, propertyId: string): Promise<void> {
  await client.query(`SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`, [
    propertyId,
  ]);
  await client.query(
    `SELECT property_id FROM finance.payment_settings
     WHERE property_id = $1::uuid FOR UPDATE`,
    [propertyId],
  );
}

async function lockProvider(client: Client, propertyId: string): Promise<ProviderRow | null> {
  const result = await client.query<ProviderRow>(
    `SELECT account.id::text AS "providerAccountId",
            account.card_capability_revision AS "cardCapabilityRevision",
            settings.online_card_readiness_revision AS "propertyReadinessRevision",
            account.status,
            account.onboarding_status AS "onboardingStatus",
            account.charges_enabled AS "chargesEnabled",
            account.payouts_enabled AS "payoutsEnabled",
            COALESCE(account.account_metadata ->> 'detailsSubmitted' = 'true', FALSE)
              AS "detailsSubmitted",
            account.account_metadata ->> 'cardPaymentsStatus' AS "cardPaymentsStatus",
            account.capabilities @> ARRAY['card_payments']::text[] AS "cardCapabilityActive"
     FROM finance.payment_settings settings
     JOIN finance.payment_provider_accounts account
       ON account.id = settings.provider_account_id
      AND account.property_id = settings.property_id
     WHERE settings.property_id = $1::uuid
       AND account.account_scope = 'property'
       AND account.provider = 'stripe'
       AND account.provider_account_id NOT LIKE 'settings-choice:%'
     FOR UPDATE OF settings, account`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function providerReady(row: ProviderRow): boolean {
  return (
    row.status === "active" &&
    row.onboardingStatus === "completed" &&
    row.chargesEnabled &&
    row.payoutsEnabled &&
    row.detailsSubmitted &&
    row.cardPaymentsStatus === "active" &&
    row.cardCapabilityActive
  );
}

async function currentCardReady(client: Client, propertyId: string): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT online_card_ready AS ready
     FROM finance.online_card_readiness WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0]?.ready === true;
}

async function suppressPublishedCard(client: Client, propertyId: string): Promise<void> {
  const profile = await client.query<{ canonicalUrl: string; bookingBaseUrl: string }>(
    `SELECT canonical_url AS "canonicalUrl", booking_base_url AS "bookingBaseUrl"
     FROM distribution.public_hotel_bookability_profiles
     WHERE property_id = $1::uuid
       AND capabilities -> 'paymentMethods' ? 'card'`,
    [propertyId],
  );
  const urls = profile.rows[0];
  if (urls) {
    await client.query(PROJECT_PUBLIC_BOOKABILITY_PROFILE, [
      propertyId,
      urls.canonicalUrl,
      urls.bookingBaseUrl,
    ]);
  }
}

async function reserve(
  client: Client,
  operation: string,
  command: UserEvidenceCommand,
  keyHash: string,
  fingerprint: string,
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
       expires_at, idempotency_metadata
     ) VALUES (
       'finance', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('commandId', $7::text)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestedAt,
      command.commandId,
    ],
  );
  return inserted.rowCount === 1;
}

async function replayResult(
  client: Client,
  operation: string,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
): Promise<FinanceOnlineCardExecutionEvidenceResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint || row.status !== "completed") {
    return failure(409, "idempotency_conflict", "Idempotency key is already in use.");
  }
  const stored = record(row.idempotencyMetadata)?.["response"];
  return validResponse(stored)
    ? { ok: true, status: "idempotent_replay", response: stored }
    : failure(409, "idempotency_conflict", "Stored idempotency evidence is invalid.");
}

async function complete(
  client: Client,
  operation: string,
  propertyId: string,
  keyHash: string,
  response: FinanceOnlineCardExecutionEvidenceResponse,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200,
         response_resource_product = 'finance',
         response_resource_type = 'online_card_execution_evidence',
         response_resource_id = $1, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('response', $4::jsonb)
     WHERE operation_scope = 'finance' AND operation = $5 AND key_hash = $6
       AND tenant_scope = 'property' AND property_id = $7::uuid AND status = 'in_progress'`,
    [
      response.evidenceId,
      sha256(JSON.stringify(response)),
      response.status === "accepted" ? response.acceptedAt : response.revokedAt,
      JSON.stringify(response),
      operation,
      keyHash,
      propertyId,
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Online-card evidence idempotency failed");
}

async function emitReadinessChange(
  client: Client,
  command: UserEvidenceCommand,
  evidence: EvidenceRow,
  outcome: "readiness_gained" | "readiness_lost",
): Promise<void> {
  const eventKey = `finance.online-card-readiness.property.${command.propertyId}.evidence.${evidence.evidenceId}.${outcome}.v1`;
  const payload = {
    contractVersion: FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
    eventType: "finance.online_card_readiness.changed",
    propertyId: command.propertyId,
    providerCapabilityRevision: positiveInteger(evidence.providerCapabilityRevision),
    propertyReadinessRevision: positiveInteger(evidence.propertyReadinessRevision),
    outcome,
    sourceReadRequired: true,
  };
  const event = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, property_id, resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, causation_id, payload,
       event_metadata, privacy_scope
     ) VALUES (
       'finance', $1, 'finance.online_card_readiness.changed', 1, $2::timestamptz,
       'property', $3::uuid, 'finance', 'online_card_execution_evidence', $4,
       'user', $5::uuid, $6, $7, $8::jsonb,
       '{"sourceReadRequired":true}'::jsonb, 'confidential'
     )
     RETURNING id::text AS "eventId"`,
    [
      eventKey,
      command.audit.requestedAt,
      command.propertyId,
      evidence.evidenceId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify(payload),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("Online-card readiness event insert failed");
  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       property_id, resource_product, resource_type, resource_id,
       correlation_id, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, 'finance.online_card_readiness.changed', 'property',
       $4::uuid, 'finance', 'online_card_execution_evidence', $5, $6,
       $7::jsonb, '{"sourceReadRequired":true}'::jsonb
     )`,
    [
      eventId,
      `${OUTBOX_DESTINATION}.online-card-readiness.property.${command.propertyId}.evidence.${evidence.evidenceId}.${outcome}.v1`,
      OUTBOX_DESTINATION,
      command.propertyId,
      evidence.evidenceId,
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify(payload),
    ],
  );
}

async function audit(
  client: Client,
  command: UserEvidenceCommand,
  evidence: EvidenceRow,
  response: FinanceOnlineCardExecutionEvidenceResponse,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, privacy_scope
     ) VALUES (
       $1, 'finance', $2, $3::timestamptz, 'property', NULL,
       $4::uuid, 'user', $5::uuid, 'finance', 'online_card_execution_evidence',
       $6, $7, $8, $9::jsonb, '{}'::jsonb, $10::jsonb, 'confidential'
     )`,
    [
      `finance.online-card-evidence.${command.commandType}.property.${command.propertyId}.key.${keyHash}.v1`,
      command.commandType,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.userId,
      evidence.evidenceId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        evidenceId: evidence.evidenceId,
        providerCapabilityRevision: response.providerCapabilityRevision,
        propertyReadinessRevision: response.propertyReadinessRevision,
        status: response.status,
        cardReady: response.cardReady,
      }),
      JSON.stringify({
        contractVersion: FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
        actorOrganizationId: command.audit.actor.organizationId,
        idempotencyKeyHash: keyHash,
      }),
    ],
  );
}

function responseFor(
  command: UserEvidenceCommand,
  evidence: EvidenceRow,
  status: "accepted" | "revoked",
  revokedAt: string | null,
  cardReady: boolean,
  readinessChanged: boolean,
  keyHash: string,
): FinanceOnlineCardExecutionEvidenceResponse {
  return {
    contractVersion: FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
    propertyId: command.propertyId,
    evidenceId: evidence.evidenceId,
    providerCapabilityRevision: positiveInteger(evidence.providerCapabilityRevision)!,
    propertyReadinessRevision: positiveInteger(evidence.propertyReadinessRevision)!,
    status,
    acceptedAt: isoDate(evidence.acceptedAt),
    revokedAt,
    cardReady,
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: keyHash,
      sideEffects: ["audit_event"],
      outboxEvents: readinessChanged ? ["finance.online_card_readiness.changed"] : [],
      jobs: [],
    },
  };
}

async function transaction(
  pool: FinanceOnlineCardEvidencePool,
  work: (client: Client) => Promise<FinanceOnlineCardExecutionEvidenceResult>,
): Promise<FinanceOnlineCardExecutionEvidenceResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch {
    await client.query("ROLLBACK");
    return failure(500, "write_unavailable", "Online-card execution evidence could not be saved.");
  } finally {
    client.release();
  }
}

function validAcceptCommand(
  command: AcceptFinanceOnlineCardExecutionEvidenceCommand,
): command is UserAcceptCommand {
  return (
    command.commandType === "finance.online_card_execution_evidence.accept" &&
    commonCommand(command) &&
    positiveInteger(command.payload.expectedCardCapabilityRevision) !== null &&
    positiveInteger(command.payload.expectedPropertyReadinessRevision) !== null &&
    /^[0-9a-f]{64}$/.test(command.payload.evidenceFingerprintHash) &&
    validIsoDate(command.payload.executedAt) &&
    Date.parse(command.payload.executedAt) <= Date.parse(command.audit.requestedAt)
  );
}

function validRevokeCommand(
  command: RevokeFinanceOnlineCardExecutionEvidenceCommand,
): command is UserRevokeCommand {
  return (
    command.commandType === "finance.online_card_execution_evidence.revoke" &&
    commonCommand(command) &&
    uuid(command.payload.evidenceId)
  );
}

function commonCommand(
  command:
    | AcceptFinanceOnlineCardExecutionEvidenceCommand
    | RevokeFinanceOnlineCardExecutionEvidenceCommand,
): command is UserEvidenceCommand {
  return (
    uuid(command.propertyId) &&
    uuid(command.commandId) &&
    uuid(command.idempotencyKey) &&
    command.audit.actor.kind === "user" &&
    uuid(command.audit.actor.userId) &&
    uuid(command.audit.actor.organizationId) &&
    trimmed(command.audit.requestId) &&
    (command.audit.correlationId === undefined || trimmed(command.audit.correlationId)) &&
    trimmed(command.audit.reason) &&
    validIsoDate(command.audit.requestedAt)
  );
}

function commandFingerprint(command: UserEvidenceCommand): string {
  return sha256(
    JSON.stringify({
      commandType: command.commandType,
      propertyId: command.propertyId,
      actorOrganizationId: command.audit.actor.organizationId,
      payload: command.payload,
    }),
  );
}

function validResponse(value: unknown): value is FinanceOnlineCardExecutionEvidenceResponse {
  const response = record(value);
  const commandMeta = record(response?.["commandMeta"]);
  return Boolean(
    response &&
    exactKeys(response, [
      "contractVersion",
      "propertyId",
      "evidenceId",
      "providerCapabilityRevision",
      "propertyReadinessRevision",
      "status",
      "acceptedAt",
      "revokedAt",
      "cardReady",
      "commandMeta",
    ]) &&
    response["contractVersion"] === FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION &&
    uuid(response["propertyId"]) &&
    uuid(response["evidenceId"]) &&
    positiveInteger(response["providerCapabilityRevision"]) &&
    positiveInteger(response["propertyReadinessRevision"]) &&
    ["accepted", "revoked"].includes(String(response["status"])) &&
    validIsoDate(response["acceptedAt"]) &&
    (response["revokedAt"] === null || validIsoDate(response["revokedAt"])) &&
    typeof response["cardReady"] === "boolean" &&
    commandMeta &&
    exactKeys(commandMeta, [
      "commandId",
      "idempotencyKey",
      "sideEffects",
      "outboxEvents",
      "jobs",
    ]) &&
    trimmed(commandMeta["commandId"]) &&
    typeof commandMeta["idempotencyKey"] === "string" &&
    /^[0-9a-f]{64}$/.test(commandMeta["idempotencyKey"]) &&
    Array.isArray(commandMeta["sideEffects"]) &&
    commandMeta["sideEffects"].every((entry) => entry === "audit_event") &&
    Array.isArray(commandMeta["outboxEvents"]) &&
    commandMeta["outboxEvents"].every(
      (entry) => entry === "finance.online_card_readiness.changed",
    ) &&
    Array.isArray(commandMeta["jobs"]) &&
    commandMeta["jobs"].length === 0,
  );
}

function invalidCommand(): FinanceOnlineCardExecutionEvidenceResult {
  return failure(400, "invalid_command", "Online-card execution evidence is invalid.");
}

function failure(
  statusCode: 400 | 404 | 409 | 500,
  code: Extract<FinanceOnlineCardExecutionEvidenceResult, { ok: false }>["code"],
  message: string,
): FinanceOnlineCardExecutionEvidenceResult {
  return { ok: false, statusCode, code, message };
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647 ? parsed : null;
}

function isoDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Stored evidence timestamp is invalid");
  return parsed.toISOString();
}

function validIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function trimmed(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
