import { createHash } from "node:crypto";
import type { FinanceStripeConnectProvider } from "@vayada/domain-finance";
import pg from "pg";

import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "../domains/stripeBookingPayments.js";
import {
  reconcileStripeBookingPaymentProviderDetails,
  settleStripeBookingPayment,
} from "../domains/stripeBookingSettlement.js";
import { applyStripeProviderAccountSnapshot } from "../domains/stripeProviderAccountReconciliation.js";
import type {
  ProviderWebhookPromotionInput,
  ProviderWebhookPromotionResult,
  ProviderWebhookReceiptInput,
  ProviderWebhookReceiptResult,
  ProviderWebhookStore,
} from "../routes/providerWebhooks.js";

type PgProviderWebhookStoreConfig = {
  connectionString: string;
  max?: number;
  stripeConnectProvider?: Pick<FinanceStripeConnectProvider, "retrieveAccount">;
  stripePaymentProvider?: Pick<StripeBookingPaymentProvider, "retrievePaymentIntent">;
};

export function createPgProviderWebhookStore(
  config: PgProviderWebhookStoreConfig,
): ProviderWebhookStore {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async resolveChannexPropertyId(externalPropertyId) {
      const result = await pool.query<{ propertyId: string }>(
        `SELECT property_id::text AS "propertyId" FROM pms.channel_connections
         WHERE provider = 'channex' AND external_property_id = $1
           AND connection_status = 'connected' ORDER BY property_id LIMIT 2`,
        [externalPropertyId],
      );
      if (result.rows.length > 1) throw new Error("Ambiguous Channex property ownership");
      return result.rows[0]?.propertyId ?? null;
    },
    async recordReceipt(input) {
      return recordReceipt(pool, input);
    },
    async promoteReceipt(input) {
      return promoteReceipt(
        pool,
        input,
        config.stripeConnectProvider,
        config.stripePaymentProvider,
      );
    },
    async close() {
      await pool.end();
    },
  };
}

async function recordReceipt(
  pool: pg.Pool,
  input: ProviderWebhookReceiptInput,
): Promise<ProviderWebhookReceiptResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string; delivery_status: string }>(
      `INSERT INTO platform.external_webhook_events
         (
           provider,
           provider_event_id,
           webhook_key_hash,
           event_type,
           delivery_status,
           signature_verified,
           payload_hash,
           raw_headers,
           raw_payload,
           payload_retention_until
         )
       VALUES (
         $1, $2, $3, $4, 'observed', TRUE, $5, $6, $7,
         CASE WHEN $1 = 'stripe' THEN now() + INTERVAL '30 days' END
       )
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id, delivery_status`,
      [
        input.provider,
        input.providerEventId,
        input.receiptKeyHash,
        input.eventType,
        input.payloadHash,
        JSON.stringify(input.rawHeaders),
        JSON.stringify(input.rawPayload),
      ],
    );

    const row = inserted.rows[0];
    if (row) {
      await insertOrTouchIdempotencyKey(client, {
        operation: "external_webhook_receipt",
        keyHash: input.receiptKeyHash,
        requestFingerprintHash: input.payloadHash,
        responseResourceProduct: "platform",
        responseResourceType: "external_webhook_event",
        responseResourceId: row.id,
        metadata: {
          provider: input.provider,
          receiptKey: input.receiptKey,
          mode: input.mode,
          eventType: input.eventType,
          normalizedDomainEventKey: input.normalizedPreview.domainEventKey,
        },
      });
      await client.query("COMMIT");
      return { status: "inserted", receiptId: row.id, lifecycleStatus: "observed" };
    }

    const existing = await selectExistingReceipt(client, input.provider, input.providerEventId);
    if (!existing) {
      throw new Error(`Unable to resolve provider webhook receipt ${input.providerEventId}`);
    }
    if (existing.payload_hash !== input.payloadHash) {
      await client.query("COMMIT");
      return {
        status: "conflict",
        receiptId: existing.id,
        lifecycleStatus:
          existing.delivery_status as ProviderWebhookReceiptResult["lifecycleStatus"],
      };
    }
    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_receipt",
      keyHash: input.receiptKeyHash,
      requestFingerprintHash: input.payloadHash,
      responseResourceProduct: "platform",
      responseResourceType: "external_webhook_event",
      responseResourceId: existing.id,
      metadata: {
        provider: input.provider,
        receiptKey: input.receiptKey,
        mode: input.mode,
        eventType: input.eventType,
        duplicate: true,
      },
    });
    await client.query("COMMIT");
    return {
      status: "duplicate",
      receiptId: existing.id,
      lifecycleStatus: existing.delivery_status as ProviderWebhookReceiptResult["lifecycleStatus"],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function promoteReceipt(
  pool: pg.Pool,
  input: ProviderWebhookPromotionInput,
  stripeConnectProvider?: Pick<FinanceStripeConnectProvider, "retrieveAccount">,
  stripePaymentProvider?: Pick<StripeBookingPaymentProvider, "retrievePaymentIntent">,
): Promise<ProviderWebhookPromotionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receiptStatus = await lockReceiptForPromotion(client, input);
    if (!receiptStatus) {
      throw new Error(`Unable to resolve provider webhook receipt ${input.receiptId}`);
    }
    if (!["received", "validated", "observed"].includes(receiptStatus)) {
      await client.query("COMMIT");
      return {
        status: promotionStatusForReceipt(receiptStatus),
        receiptId: input.receiptId,
        jobIds: [],
        auditEventIds: [],
      };
    }
    const stripePaymentIntent = await resolveStripePaymentIntent(input, stripePaymentProvider);
    const promotionInput = await resolveProviderAccountResourceId(client, input);
    if (!promotionInput) {
      await client.query(
        `UPDATE platform.external_webhook_events
         SET delivery_status = 'ignored',
             processed_at = now(),
             failure_reason = 'stripe_provider_account_owner_unresolved',
             correlation_id = $2
         WHERE id = $1::uuid
           AND delivery_status IN ('received', 'validated', 'observed')`,
        [input.receiptId, input.receiptKey],
      );
      await client.query("COMMIT");
      return {
        status: "ignored",
        receiptId: input.receiptId,
        jobIds: [],
        auditEventIds: [],
      };
    }
    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_domain_event",
      keyHash: hashForKey(promotionInput.normalizedPreview.domainEventKey),
      requestFingerprintHash: promotionInput.payloadHash,
      responseResourceProduct: promotionInput.normalizedPreview.resourceProduct,
      responseResourceType: promotionInput.normalizedPreview.resourceType,
      responseResourceId: promotionInput.normalizedPreview.resourceId,
      metadata: {
        provider: promotionInput.provider,
        receiptKey: promotionInput.receiptKey,
        domainEventKey: promotionInput.normalizedPreview.domainEventKey,
      },
    });

    const eventId = await insertOrFindDomainEvent(client, promotionInput);
    const jobId = await insertOrFindJob(client, promotionInput, eventId);
    await settleCapturedStripeBooking(client, promotionInput, eventId);
    if (stripePaymentIntent) {
      await reconcileStripeBookingPaymentProviderDetails(client, stripePaymentIntent, new Date());
    }
    await reconcileStripeProviderAccount(client, input, stripeConnectProvider);

    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_job",
      keyHash: hashForKey(promotionInput.normalizedPreview.jobKey),
      requestFingerprintHash: promotionInput.payloadHash,
      responseResourceProduct: promotionInput.normalizedPreview.resourceProduct,
      responseResourceType: promotionInput.normalizedPreview.resourceType,
      responseResourceId: promotionInput.normalizedPreview.resourceId,
      metadata: {
        provider: promotionInput.provider,
        receiptKey: promotionInput.receiptKey,
        jobKey: promotionInput.normalizedPreview.jobKey,
        jobId,
      },
    });

    const updated = await client.query<{ id: string }>(
      `UPDATE platform.external_webhook_events
       SET delivery_status = 'promoted',
           normalized_domain_event_id = $2,
           processed_at = now(),
           correlation_id = $3
       WHERE id = $1
         AND delivery_status IN ('received', 'validated', 'observed')
       RETURNING id`,
      [input.receiptId, eventId, input.receiptKey],
    );

    const promotionStatus = updated.rows[0]
      ? "promoted"
      : promotionStatusForReceipt(await selectReceiptStatusById(client, input.receiptId));

    const auditEventId = await insertOrFindFinanceAuditEvent(
      client,
      promotionInput,
      eventId,
      jobId,
    );

    await client.query("COMMIT");
    return {
      status: promotionStatus,
      receiptId: input.receiptId,
      domainEventId: eventId,
      jobIds: [jobId],
      auditEventIds: auditEventId ? [auditEventId] : [],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockReceiptForPromotion(
  client: Pick<pg.PoolClient, "query">,
  input: Pick<ProviderWebhookPromotionInput, "provider" | "receiptId">,
): Promise<string | null> {
  const receipt = await client.query<{ delivery_status: string }>(
    `SELECT delivery_status
     FROM platform.external_webhook_events
     WHERE id = $1::uuid AND provider = $2
     FOR UPDATE`,
    [input.receiptId, input.provider],
  );
  return receipt.rows[0]?.delivery_status ?? null;
}

export async function resolveProviderAccountResourceId(
  client: Pick<pg.PoolClient, "query">,
  input: ProviderWebhookPromotionInput,
): Promise<ProviderWebhookPromotionInput | null> {
  if (
    input.provider !== "stripe" ||
    input.normalizedPreview.domainEventType !== "finance.provider-account.updated"
  ) {
    return input;
  }
  const providerAccountRef = stripeAccountUpdatedProviderRef(input.rawPayload);
  if (
    !providerAccountRef ||
    input.normalizedPreview.resourceId !== hashForKey(providerAccountRef)
  ) {
    throw new Error("Stripe account webhook identity is invalid.");
  }
  const account = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM finance.payment_provider_accounts
     WHERE provider = 'stripe' AND provider_account_id = $1
     LIMIT 2`,
    [providerAccountRef],
  );
  if (account.rows.length !== 1 || !account.rows[0]?.id) {
    return null;
  }
  return {
    ...input,
    normalizedPreview: {
      ...input.normalizedPreview,
      resourceId: account.rows[0].id,
    },
  };
}

export async function settleCapturedStripeBooking(
  client: Pick<pg.PoolClient, "query">,
  input: ProviderWebhookPromotionInput,
  sourceDomainEventId: string,
): Promise<void> {
  if (
    input.provider !== "stripe" ||
    input.normalizedPreview.domainEventType !== "payment.captured"
  ) {
    return;
  }
  const amountMinor = Number(input.normalizedPreview.payload["amount"]);
  if (!Number.isInteger(amountMinor) || amountMinor < 0) return;
  await settleStripeBookingPayment(client, {
    paymentIntentId: input.normalizedPreview.resourceId,
    providerAccountRef: stripeConnectedAccountRef(input.rawPayload),
    amountMinor,
    currency:
      typeof input.normalizedPreview.payload["currency"] === "string"
        ? input.normalizedPreview.payload["currency"]
        : null,
    occurredAt: new Date(),
    correlationId: input.receiptKey,
    sourceDomainEventId,
  });
}

async function resolveStripePaymentIntent(
  input: ProviderWebhookPromotionInput,
  provider?: Pick<StripeBookingPaymentProvider, "retrievePaymentIntent">,
): Promise<StripeBookingPaymentIntent | null> {
  if (
    input.provider !== "stripe" ||
    !["payment.captured", "payment.fee_updated"].includes(
      input.normalizedPreview.domainEventType,
    ) ||
    !provider
  ) {
    return null;
  }
  const providerAccountRef = stripeConnectedAccountRef(input.rawPayload);
  const expectedProviderAccountHash = providerAccountRef
    ? hashForKey(providerAccountRef)
    : "platform";
  if (input.normalizedPreview.payload["providerAccountHash"] !== expectedProviderAccountHash) {
    throw new Error("Stripe payment webhook account identity is invalid.");
  }
  try {
    const intent = await provider.retrievePaymentIntent(
      input.normalizedPreview.resourceId,
      providerAccountRef,
    );
    if (input.normalizedPreview.domainEventType === "payment.fee_updated" && !intent.feeBreakdown) {
      throw new Error("Stripe fee breakdown is not available yet.");
    }
    return intent;
  } catch (error) {
    if (input.normalizedPreview.domainEventType === "payment.fee_updated") throw error;
    return null;
  }
}

export async function reconcileStripeProviderAccount(
  client: Pick<pg.PoolClient, "query">,
  input: ProviderWebhookPromotionInput,
  stripeConnectProvider?: Pick<FinanceStripeConnectProvider, "retrieveAccount">,
): Promise<void> {
  if (
    input.provider !== "stripe" ||
    input.normalizedPreview.domainEventType !== "finance.provider-account.updated"
  ) {
    return;
  }
  const providerAccountRef = stripeAccountUpdatedProviderRef(input.rawPayload);
  if (
    !providerAccountRef ||
    input.normalizedPreview.resourceId !== hashForKey(providerAccountRef)
  ) {
    throw new Error("Stripe account webhook identity is invalid.");
  }
  const resolved = await client.query<{ propertyId: string }>(
    `SELECT property_id::text AS "propertyId"
     FROM finance.payment_provider_accounts
     WHERE provider = 'stripe' AND provider_account_id = $1
     LIMIT 2`,
    [providerAccountRef],
  );
  if (resolved.rows.length !== 1) return;
  const propertyId = resolved.rows[0]!.propertyId;
  const property = await client.query(
    `SELECT id
     FROM hotel_catalog.properties
     WHERE id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  if (!property.rows[0]) return;
  const locked = await client.query<{ id: string }>(
    `SELECT account.id::text AS id
     FROM finance.payment_provider_accounts account
     JOIN finance.payment_settings settings
       ON settings.provider_account_id = account.id
      AND settings.property_id = account.property_id
     WHERE account.provider = 'stripe'
       AND account.provider_account_id = $1
       AND account.property_id = $2::uuid
     LIMIT 1
     FOR UPDATE OF account, settings`,
    [providerAccountRef, propertyId],
  );
  if (!locked.rows[0]) return;

  const payload = input.normalizedPreview.payload;
  const canonical = stripeConnectProvider
    ? await stripeConnectProvider.retrieveAccount({
        providerAccountRef,
      })
    : {
        providerAccountRef,
        chargesEnabled: payload["chargesEnabled"] === true,
        payoutsEnabled: payload["payoutsEnabled"] === true,
        detailsSubmitted: payload["detailsSubmitted"] === true,
        cardPaymentsStatus:
          typeof payload["cardPaymentsStatus"] === "string" ? payload["cardPaymentsStatus"] : null,
        defaultCurrency:
          typeof payload["defaultCurrency"] === "string" ? payload["defaultCurrency"] : null,
      };
  if (canonical.providerAccountRef !== providerAccountRef) {
    throw new Error("Stripe account reconciliation returned an unexpected account reference.");
  }
  await applyStripeProviderAccountSnapshot(client, {
    snapshot: canonical,
    propertyId,
    providerAccountId: locked.rows[0].id,
    metadata: { lastStripeEventId: payload["rawEventId"] ?? null },
    readinessChange: {
      occurredAt: new Date().toISOString(),
      actorType: "provider",
      actorUserId: null,
      correlationId: input.receiptKey,
      causationId: input.receiptId,
    },
  });
}

function stripeAccountUpdatedProviderRef(payload: Record<string, unknown>): string | null {
  const data = plainRecord(payload["data"]);
  const object = plainRecord(data?.["object"]);
  const providerAccountRef = object?.["id"];
  return typeof providerAccountRef === "string" && providerAccountRef.trim()
    ? providerAccountRef.trim()
    : null;
}

function stripeConnectedAccountRef(payload: Record<string, unknown>): string | null {
  const providerAccountRef = payload["account"];
  return typeof providerAccountRef === "string" && providerAccountRef.trim()
    ? providerAccountRef.trim()
    : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function selectExistingReceipt(
  client: pg.PoolClient,
  provider: string,
  providerEventId: string,
): Promise<{ id: string; delivery_status: string; payload_hash: string } | null> {
  const existing = await client.query<{
    id: string;
    delivery_status: string;
    payload_hash: string;
  }>(
    `SELECT id, delivery_status, payload_hash
     FROM platform.external_webhook_events
     WHERE provider = $1 AND provider_event_id = $2
     LIMIT 1`,
    [provider, providerEventId],
  );
  return existing.rows[0] ?? null;
}

async function selectReceiptStatusById(
  client: pg.PoolClient,
  receiptId: string,
): Promise<string | null> {
  const existing = await client.query<{ delivery_status: string }>(
    `SELECT delivery_status
     FROM platform.external_webhook_events
     WHERE id = $1
     LIMIT 1`,
    [receiptId],
  );
  return existing.rows[0]?.delivery_status ?? null;
}

function promotionStatusForReceipt(
  status: string | null,
): ProviderWebhookPromotionResult["status"] {
  switch (status) {
    case "promoted":
      return "already_promoted";
    case "normalized":
      return "already_normalized";
    case "ignored":
      return "ignored";
    case "failed":
      return "failed";
    case "dead_lettered":
      return "dead_lettered";
    default:
      return "incompatible_terminal_state";
  }
}

async function insertOrFindDomainEvent(
  client: pg.PoolClient,
  input: ProviderWebhookPromotionInput,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         occurred_at,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES (
       'external',
       $1,
       $2,
       now(),
       'external',
       $3,
       $4,
       $5,
       'provider',
       $6,
       $7,
       $8,
       $9,
       $10,
       'restricted'
     )
     ON CONFLICT (source_system, event_key) DO NOTHING
     RETURNING id`,
    [
      input.normalizedPreview.domainEventKey,
      input.normalizedPreview.domainEventType,
      input.normalizedPreview.resourceProduct,
      input.normalizedPreview.resourceType,
      input.normalizedPreview.resourceId,
      input.receiptKey,
      input.receiptId,
      hashForKey(input.normalizedPreview.domainEventKey),
      JSON.stringify(input.normalizedPreview.payload),
      JSON.stringify({
        provider: input.provider,
        receiptId: input.receiptId,
        receiptKey: input.receiptKey,
      }),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.domain_events
     WHERE source_system = 'external' AND event_key = $1
     LIMIT 1`,
    [input.normalizedPreview.domainEventKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve domain event ${input.normalizedPreview.domainEventKey}`);
  }
  return existingId;
}

async function insertOrFindJob(
  client: pg.PoolClient,
  input: ProviderWebhookPromotionInput,
  domainEventId: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         source_domain_event_id,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES ($1, $2, $3, $4, 'external', $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (queue_name, job_key) DO NOTHING
     RETURNING id`,
    [
      input.normalizedPreview.jobKey,
      input.normalizedPreview.queueName,
      input.normalizedPreview.jobType,
      domainEventId,
      input.normalizedPreview.resourceProduct,
      input.normalizedPreview.resourceType,
      input.normalizedPreview.resourceId,
      input.receiptKey,
      hashForKey(input.normalizedPreview.jobKey),
      JSON.stringify({
        ...input.normalizedPreview.payload,
        receiptId: input.receiptId,
        receiptKey: input.receiptKey,
      }),
      JSON.stringify({
        provider: input.provider,
        source: "target_provider_webhook_intake",
      }),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.jobs
     WHERE queue_name = $1 AND job_key = $2
     LIMIT 1`,
    [input.normalizedPreview.queueName, input.normalizedPreview.jobKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve webhook job ${input.normalizedPreview.jobKey}`);
  }
  return existingId;
}

async function insertOrFindFinanceAuditEvent(
  client: pg.PoolClient,
  input: ProviderWebhookPromotionInput,
  domainEventId: string,
  jobId: string,
): Promise<string | null> {
  if (input.normalizedPreview.resourceProduct !== "finance") {
    return null;
  }

  const auditKey = input.normalizedPreview.domainEventKey;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         domain_event_id,
         external_webhook_event_id,
         job_id,
         correlation_id,
         causation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       (
         $1,
         'finance',
         $2,
         now(),
         'external',
         'provider',
         'finance',
         $3,
         $4,
         $5,
         $6::uuid,
         $7,
         $8,
         $6::text,
         $9,
         '{}'::jsonb,
         $10,
         'financial',
         'confidential'
       )
     ON CONFLICT (product, audit_key) DO NOTHING
     RETURNING id`,
    [
      auditKey,
      input.normalizedPreview.domainEventType,
      input.normalizedPreview.resourceType,
      input.normalizedPreview.resourceId,
      domainEventId,
      input.receiptId,
      jobId,
      input.receiptKey,
      JSON.stringify({
        provider: input.provider,
        domainEventType: input.normalizedPreview.domainEventType,
        resourceType: input.normalizedPreview.resourceType,
        resourceId: input.normalizedPreview.resourceId,
        jobType: input.normalizedPreview.jobType,
        queueName: input.normalizedPreview.queueName,
      }),
      JSON.stringify({
        source: "target_provider_webhook_intake",
        receiptKey: input.receiptKey,
        domainEventKey: input.normalizedPreview.domainEventKey,
        jobKey: input.normalizedPreview.jobKey,
        receiptKeyHash: input.receiptKeyHash,
        payloadHash: input.payloadHash,
      }),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.product_audit_events
     WHERE product = 'finance' AND audit_key = $1
     LIMIT 1`,
    [auditKey],
  );
  return existing.rows[0]?.id ?? null;
}

async function insertOrTouchIdempotencyKey(
  client: pg.PoolClient,
  input: {
    operation: string;
    keyHash: string;
    requestFingerprintHash: string;
    responseResourceProduct: string;
    responseResourceType: string;
    responseResourceId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         response_status_code,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         response_body_hash,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES (
       'platform',
       $1,
       $2,
       $3,
       'completed',
       'external',
       200,
       $4,
       $5,
       $6,
       $7,
       now(),
       now() + interval '180 days',
       $8
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       idempotency_metadata = platform.idempotency_keys.idempotency_metadata || EXCLUDED.idempotency_metadata`,
    [
      input.operation,
      input.keyHash,
      input.requestFingerprintHash,
      input.responseResourceProduct,
      input.responseResourceType,
      input.responseResourceId,
      input.requestFingerprintHash,
      JSON.stringify(input.metadata),
    ],
  );
}

function hashForKey(key: string): string {
  return key.startsWith("sha256:")
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}
