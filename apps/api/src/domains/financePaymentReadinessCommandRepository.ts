import { createHash } from "node:crypto";

import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_METHODS,
  FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
  createFinancePaymentReadinessSnapshot,
  parseReplaceFinancePaymentMethodsCommand,
  parseReplaceFinancePaymentMethodsResult,
  resolveFinanceOnlineCardReadiness,
  serializeReplaceFinancePaymentMethodsFingerprint,
  type FinancePaymentReadinessChangedEvent,
  type FinancePaymentReadinessMethod,
  type FinanceOnlineCardReadinessDecision,
  type FinanceOnlineCardReadinessEvidence,
  type FinancePricingCurrencyEvidence,
  type ReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsError,
  type ReplaceFinancePaymentMethodsResult,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  applyFinanceOnlineCardReadinessLoss,
  loadFinanceOnlineCardReadinessState,
} from "./financeOnlineCardReadinessTransition.js";
import type { FinancePaymentMethodsRepositoryPort } from "./financePaymentReadinessService.js";

export type FinancePaymentReadinessCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type FinancePaymentReadinessCommandPool = {
  connect(): Promise<FinancePaymentReadinessCommandClient>;
  end(): Promise<void>;
};

export type FinancePaymentReadinessCommandRepository = FinancePaymentMethodsRepositoryPort & {
  close(): Promise<void>;
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

type IdempotencyReservation = { id: string; attempt: number };

type PaymentSettingsRow = {
  contractVersion: unknown;
  paymentMethodsRevision: unknown;
  sourcePricingCurrencyRevision: unknown;
  currency: unknown;
  acceptedMethods: unknown;
  onlineCardCurrencyEligible: unknown;
  providerAccountId: unknown;
  provider: unknown;
  providerAccountScope: unknown;
  providerBindingActive: unknown;
  providerStatus: unknown;
  providerOnboardingStatus: unknown;
  providerChargesEnabled: unknown;
  providerPayoutsEnabled: unknown;
  providerDetailsSubmitted: unknown;
  providerCardPaymentsStatus: unknown;
  providerCapabilities: unknown;
  providerCardCapabilityRevision: unknown;
  propertyReadinessRevision: unknown;
  executionEvidenceContractVersion: unknown;
  executionEvidenceProviderAccountId: unknown;
  executionEvidenceCapabilityRevision: unknown;
  executionEvidencePropertyReadinessRevision: unknown;
  executionEvidenceRevokedAt: unknown;
  updatedAt: unknown;
};

type AcceptedChange = {
  event: FinancePaymentReadinessChangedEvent;
  result: ReplaceFinancePaymentMethodsResult & { ok: true };
};

const OPERATION = "finance.payment_methods.replace";
const MANAGE_PERMISSION = "pms.finance.manage";
const MAX_REVISION = 2_147_483_647;

export function createPgFinancePaymentReadinessCommandRepository(config: {
  connectionString: string;
  max?: number;
  pool?: FinancePaymentReadinessCommandPool;
  now?: () => Date;
}): FinancePaymentReadinessCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Finance payment readiness repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: FinancePaymentReadinessCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async replacePaymentMethods(input) {
      const command = parseReplaceFinancePaymentMethodsCommand(input.command);
      if (!command) throw new Error("Finance payment readiness command failed contract validation");
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("Finance payment readiness clock is invalid");
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = sha256(serializeReplaceFinancePaymentMethodsFingerprint(command));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
          await rollbackQuietly(client);
          return failure({ code: "setup_scope_unavailable" });
        }

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

        const worked = await applyCommand(client, command, input.currentPricing, acceptedAt);
        const changed = "event" in worked;
        const result = parseReplaceFinancePaymentMethodsResult(
          "result" in worked ? worked.result : worked,
        );
        if (!result || result.ok !== changed) {
          throw new Error("Finance payment readiness repository produced an invalid result");
        }
        const eventId = changed
          ? await enqueueChange(client, command, reservation, keyHash, worked.event, acceptedAt)
          : null;
        await recordAudit(client, command, reservation, keyHash, result, eventId, acceptedAt);
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

    async close() {
      if (!ownsPool || closed) return;
      await pool.end();
      closed = true;
    },
  };
}

async function applyCommand(
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
  rawPricing: FinancePricingCurrencyEvidence | null,
  acceptedAt: Date,
): Promise<ReplaceFinancePaymentMethodsResult | AcceptedChange> {
  if (command.selectedMethods.includes("bank_transfer")) {
    return failure({ code: "payment_method_unavailable", method: "bank_transfer" });
  }
  const currentPricing = pricingEvidence(rawPricing);
  if (rawPricing !== null && !currentPricing) {
    throw new Error("Finance payment readiness pricing evidence failed contract validation");
  }
  if (!currentPricing) return failure({ code: "pricing_currency_unavailable" });
  if (currentPricing.pricingCurrencyRevision !== command.expectedPricingCurrencyRevision) {
    return failure({
      code: "pricing_currency_revision_conflict",
      currentRevision: currentPricing.pricingCurrencyRevision,
    });
  }

  const stored = await lockPaymentSettings(client, command.propertyId);
  const previousOnlineCardReadiness = await loadFinanceOnlineCardReadinessState(
    client,
    command.propertyId,
  );
  const currentOnlineCardReadiness = resolveFinanceOnlineCardReadiness(onlineCardEvidence(stored));
  const aggregate = storedAggregate(
    stored,
    command.propertyId,
    currentPricing,
    currentOnlineCardReadiness,
  );
  if (aggregate.revision !== command.expectedPaymentMethodsRevision) {
    return failure({
      code: "payment_methods_revision_conflict",
      currentRevision: aggregate.revision,
    });
  }
  if (aggregate.revision >= MAX_REVISION) {
    return failure({ code: "payment_methods_revision_conflict", currentRevision: MAX_REVISION });
  }

  const nextRevision = aggregate.revision + 1;
  const at = acceptedAt.toISOString();
  await client.query(
    `INSERT INTO finance.payment_settings (
       property_id, payments_enabled, accepted_methods, default_currency,
       payment_readiness_contract_version, payment_methods_revision,
       source_pricing_currency_revision, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3::text[], $4, $5, $6, $7, $8::timestamptz, $8::timestamptz
     )
     ON CONFLICT (property_id) DO UPDATE SET
       payments_enabled = EXCLUDED.payments_enabled,
       accepted_methods = EXCLUDED.accepted_methods,
       default_currency = EXCLUDED.default_currency,
       payment_readiness_contract_version = EXCLUDED.payment_readiness_contract_version,
       payment_methods_revision = EXCLUDED.payment_methods_revision,
       source_pricing_currency_revision = EXCLUDED.source_pricing_currency_revision,
       updated_at = EXCLUDED.updated_at`,
    [
      command.propertyId,
      command.selectedMethods.length > 0,
      command.selectedMethods,
      currentPricing.currency,
      FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
      nextRevision,
      currentPricing.pricingCurrencyRevision,
      at,
    ],
  );

  const nextStored = await lockPaymentSettings(client, command.propertyId);
  if (!nextStored) throw new Error("Finance payment readiness write was not visible");
  const nextOnlineCardReadiness = resolveFinanceOnlineCardReadiness(onlineCardEvidence(nextStored));
  await applyFinanceOnlineCardReadinessLoss(client, {
    propertyId: command.propertyId,
    previous: previousOnlineCardReadiness,
    context: {
      occurredAt: at,
      actorType: "user",
      actorUserId: command.audit.actor.userId,
      correlationId: command.audit.correlationId ?? command.audit.requestId,
      causationId: command.audit.requestId,
    },
  });

  const paymentReadiness = createFinancePaymentReadinessSnapshot({
    propertyId: command.propertyId,
    paymentMethodsRevision: nextRevision,
    selectedMethods: command.selectedMethods,
    committedPricing: currentPricing,
    currentPricing,
    onlineCardReadiness: nextOnlineCardReadiness,
    updatedAt: at,
  });
  const result = parseReplaceFinancePaymentMethodsResult({
    ok: true,
    response: {
      contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
      outcome: aggregate.revision === 0 ? "created" : "updated",
      paymentReadiness,
      acceptedAt: at,
    },
  });
  if (!result?.ok) throw new Error("Finance payment readiness success failed validation");
  return {
    result,
    event: {
      contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
      eventType: "finance.payment_readiness.changed",
      organizationId: command.organizationId,
      propertyId: command.propertyId,
      paymentMethodsRevision: nextRevision,
      sourcePricingCurrencyRevision: currentPricing.pricingCurrencyRevision,
      outcome:
        !aggregate.bookingReady && paymentReadiness.bookingPaymentReady
          ? "readiness_gained"
          : aggregate.bookingReady && !paymentReadiness.bookingPaymentReady
            ? "readiness_lost"
            : "selection_changed",
      sourceReadRequired: true,
    },
  };
}

async function lockAuthorizedScope(
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
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
      AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'finance_manager')
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
     FOR UPDATE OF property
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [command.organizationId, command.propertyId, command.audit.actor.userId, MANAGE_PERMISSION],
  );
  if ((scope.rowCount ?? 0) === 0) return false;
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
         resource_product IS NULL OR (
           resource_product = 'pms' AND resource_type = 'pms_property'
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

async function lockPaymentSettings(
  client: FinancePaymentReadinessCommandClient,
  propertyId: string,
): Promise<PaymentSettingsRow | null> {
  const result = await client.query<PaymentSettingsRow>(
    `SELECT settings.payment_readiness_contract_version AS "contractVersion",
            settings.payment_methods_revision AS "paymentMethodsRevision",
            settings.source_pricing_currency_revision AS "sourcePricingCurrencyRevision",
            settings.default_currency::text AS currency,
            settings.accepted_methods AS "acceptedMethods",
            online_card.currency_eligible AS "onlineCardCurrencyEligible",
            online_card.provider_account_id::text AS "providerAccountId",
            online_card.provider,
            online_card.account_scope AS "providerAccountScope",
            online_card.provider_binding_active AS "providerBindingActive",
            online_card.provider_status AS "providerStatus",
            online_card.provider_onboarding_status AS "providerOnboardingStatus",
            online_card.charges_enabled AS "providerChargesEnabled",
            online_card.payouts_enabled AS "providerPayoutsEnabled",
            online_card.details_submitted AS "providerDetailsSubmitted",
            online_card.card_payments_status AS "providerCardPaymentsStatus",
            online_card.capabilities AS "providerCapabilities",
            online_card.card_capability_revision AS "providerCardCapabilityRevision",
            online_card.property_readiness_revision AS "propertyReadinessRevision",
            online_card.execution_evidence_contract_version
              AS "executionEvidenceContractVersion",
            online_card.execution_evidence_provider_account_id::text
              AS "executionEvidenceProviderAccountId",
            online_card.execution_evidence_capability_revision
              AS "executionEvidenceCapabilityRevision",
            online_card.execution_evidence_property_readiness_revision
              AS "executionEvidencePropertyReadinessRevision",
            online_card.execution_evidence_revoked_at AS "executionEvidenceRevokedAt",
            settings.updated_at AS "updatedAt"
     FROM finance.payment_settings settings
     LEFT JOIN finance.online_card_readiness online_card
       ON online_card.property_id = settings.property_id
     WHERE settings.property_id = $1::uuid
     FOR UPDATE OF settings`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("Finance payment readiness row is not unique");
  return result.rows[0] ?? null;
}

function storedAggregate(
  row: PaymentSettingsRow | null,
  propertyId: string,
  currentPricing: FinancePricingCurrencyEvidence,
  onlineCardReadiness: FinanceOnlineCardReadinessDecision,
): { revision: number; bookingReady: boolean } {
  if (!row) return { revision: 0, bookingReady: false };
  if (
    row.contractVersion === null &&
    row.paymentMethodsRevision === null &&
    row.sourcePricingCurrencyRevision === null
  ) {
    return { revision: 0, bookingReady: false };
  }
  const revision = positiveInteger(row.paymentMethodsRevision);
  const pricingRevision = positiveInteger(row.sourcePricingCurrencyRevision);
  const selectedMethods = methods(row.acceptedMethods);
  const updatedAt = isoDate(row.updatedAt);
  if (
    row.contractVersion !== FINANCE_PAYMENT_READINESS_CONTRACT_VERSION ||
    !revision ||
    !pricingRevision ||
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !selectedMethods ||
    !updatedAt
  ) {
    throw new Error("Finance payment readiness row failed contract validation");
  }
  const snapshot = createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: revision,
    selectedMethods,
    committedPricing: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      currency: row.currency,
      pricingCurrencyRevision: pricingRevision,
    },
    currentPricing,
    onlineCardReadiness,
    updatedAt,
  });
  return { revision, bookingReady: snapshot.bookingPaymentReady };
}

function onlineCardEvidence(row: PaymentSettingsRow | null): FinanceOnlineCardReadinessEvidence {
  if (!row) {
    return {
      currencyEligible: false,
      propertyReadinessRevision: 1,
      providerAccount: null,
      executionEvidence: null,
    };
  }
  const providerAccount =
    typeof row.providerAccountId === "string"
      ? {
          id: row.providerAccountId,
          provider: row.provider,
          accountScope: row.providerAccountScope,
          providerBindingActive: row.providerBindingActive,
          status: row.providerStatus,
          onboardingStatus: row.providerOnboardingStatus,
          chargesEnabled: row.providerChargesEnabled,
          payoutsEnabled: row.providerPayoutsEnabled,
          detailsSubmitted: row.providerDetailsSubmitted,
          cardPaymentsStatus: row.providerCardPaymentsStatus,
          capabilities: row.providerCapabilities,
          cardCapabilityRevision: integer(row.providerCardCapabilityRevision),
        }
      : null;
  const executionEvidence =
    typeof row.executionEvidenceProviderAccountId === "string"
      ? {
          contractVersion: row.executionEvidenceContractVersion,
          providerAccountId: row.executionEvidenceProviderAccountId,
          providerCapabilityRevision: integer(row.executionEvidenceCapabilityRevision),
          propertyReadinessRevision: integer(row.executionEvidencePropertyReadinessRevision),
          revokedAt: storedDate(row.executionEvidenceRevokedAt),
        }
      : null;
  return {
    currencyEligible: row.onlineCardCurrencyEligible,
    propertyReadinessRevision: integer(row.propertyReadinessRevision),
    providerAccount,
    executionEvidence,
  } as FinanceOnlineCardReadinessEvidence;
}

async function findReplay(
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<ReplaceFinancePaymentMethodsResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata",
            expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
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
  const parsed = parseReplaceFinancePaymentMethodsResult(stored);
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
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
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
       'finance', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
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

async function completeIdempotency(
  client: FinancePaymentReadinessCommandClient,
  id: string,
  result: ReplaceFinancePaymentMethodsResult,
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
      responseStatus(result),
      sha256(stableJson(responseBody(result))),
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Finance payment readiness idempotency completion failed");
  }
}

async function enqueueChange(
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  event: FinancePaymentReadinessChangedEvent,
  at: Date,
): Promise<string> {
  const eventKey = `finance.payment_readiness.changed.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
  const inserted = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system, event_key, event_type, event_version, occurred_at,
         tenant_scope, organization_id, property_id, resource_product,
         resource_type, resource_id, actor_type, actor_user_id, correlation_id,
         causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
       ) VALUES (
         'finance', $1, 'finance.payment_readiness.changed', 1, $2::timestamptz,
         'property', NULL, $3::uuid, 'finance', 'payment_methods', $3::uuid::text,
         'user', $4::uuid, $5, $6, $7, $8::jsonb, $9::jsonb, 'confidential'
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId" FROM platform.domain_events
     WHERE source_system = 'finance' AND event_key = $1
     LIMIT 1`,
    [
      eventKey,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(event),
      JSON.stringify({
        contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const eventId = inserted.rows[0]?.eventId;
  if (!eventId) throw new Error("Finance payment readiness domain event insert failed");
  const outbox = await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, 'finance.payment_readiness.changed', 'property', NULL,
       $4::uuid, 'finance', 'payment_methods', $4::uuid::text,
       $5, $6, $7::jsonb, $8::jsonb
     )
     ON CONFLICT (destination, outbox_key) DO NOTHING`,
    [
      eventId,
      `${FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION}.payment_methods.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify(event),
      JSON.stringify({
        contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  if (outbox.rowCount !== 1) throw new Error("Finance payment readiness outbox insert failed");
  return eventId;
}

async function recordAudit(
  client: FinancePaymentReadinessCommandClient,
  command: ReplaceFinancePaymentMethodsCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: ReplaceFinancePaymentMethodsResult,
  eventId: string | null,
  at: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id,
       idempotency_key_id, correlation_id, causation_id, redacted_payload,
       private_payload, audit_metadata, privacy_scope
     ) VALUES (
       $1, 'finance', $2, $3::timestamptz, 'property', NULL, $4::uuid,
       'user', $5::uuid, 'finance', 'payment_methods', $4::uuid::text,
       $6::uuid, $7::uuid,
       $8, $9, $10::jsonb, '{}'::jsonb, $11::jsonb, 'confidential'
     )`,
    [
      `finance.payment_methods.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      OPERATION,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      eventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(redactedAuditPayload(command, result)),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
        contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
      }),
    ],
  );
}

function redactedAuditPayload(
  command: ReplaceFinancePaymentMethodsCommand,
  result: ReplaceFinancePaymentMethodsResult,
): Record<string, unknown> {
  const base = {
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    expectedPaymentMethodsRevision: command.expectedPaymentMethodsRevision,
    expectedPricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    selectedMethods: command.selectedMethods,
  };
  if (result.ok) {
    return {
      ...base,
      outcome: result.response.outcome,
      paymentMethodsRevision: result.response.paymentReadiness.paymentMethodsRevision,
      sourcePricingCurrencyRevision:
        result.response.paymentReadiness.pricingCurrency.committed?.pricingCurrencyRevision,
    };
  }
  return {
    ...base,
    outcome: result.error.code,
    ...(result.error.code === "payment_method_unavailable" ? { method: result.error.method } : {}),
    ...(result.error.code === "payment_methods_revision_conflict" ||
    result.error.code === "pricing_currency_revision_conflict"
      ? { currentRevision: result.error.currentRevision }
      : {}),
  };
}

function pricingEvidence(value: unknown): FinancePricingCurrencyEvidence | null {
  return isExactRecord(value, ["contractVersion", "currency", "pricingCurrencyRevision"]) &&
    value["contractVersion"] === PMS_PRICING_CONTRACT_VERSION &&
    typeof value["currency"] === "string" &&
    /^[A-Z]{3}$/.test(value["currency"]) &&
    typeof value["pricingCurrencyRevision"] === "number" &&
    positiveInteger(value["pricingCurrencyRevision"])
    ? {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        currency: value["currency"],
        pricingCurrencyRevision: value["pricingCurrencyRevision"] as number,
      }
    : null;
}

function methods(value: unknown): readonly FinancePaymentReadinessMethod[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.filter((method): method is FinancePaymentReadinessMethod =>
    FINANCE_PAYMENT_READINESS_METHODS.includes(method as FinancePaymentReadinessMethod),
  );
  return parsed.length === value.length && new Set(parsed).size === parsed.length
    ? FINANCE_PAYMENT_READINESS_METHODS.filter((method) => parsed.includes(method))
    : null;
}

function failure(error: ReplaceFinancePaymentMethodsError): ReplaceFinancePaymentMethodsResult {
  return { ok: false, error };
}

function responseBody(result: ReplaceFinancePaymentMethodsResult): unknown {
  return result.ok ? result.response : result.error;
}

function responseStatus(result: ReplaceFinancePaymentMethodsResult): number {
  if (result.ok) return result.response.outcome === "created" ? 201 : 200;
  if (
    result.error.code === "setup_scope_unavailable" ||
    result.error.code === "pricing_currency_unavailable"
  )
    return 404;
  if (result.error.code === "payment_method_unavailable") return 422;
  return 409;
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_REVISION ? parsed : null;
}

function integer(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_REVISION ? parsed : -1;
}

function storedDate(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid" : value.toISOString();
  return typeof value === "string" ? value : "invalid";
}

function isoDate(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function rollbackQuietly(client: FinancePaymentReadinessCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
