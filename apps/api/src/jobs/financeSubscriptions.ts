import { createHash } from "node:crypto";

import {
  fixedPlanAmountMinor,
  type StripeFinanceSubscriptionProvider,
  type StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";
import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import pg from "pg";

const QUEUE = "finance.subscriptions";
const JOB_TYPE = "finance.subscription-webhook";
const NOTIFICATION_QUEUE = "finance.notifications";
const NOTIFICATION_JOB_TYPE = "finance.subscription-payment-failed.notify-internal";

export type FinanceSubscriptionWebhookPayload = {
  provider: "stripe";
  eventType: string;
  rawEventId: string;
  eventCreated: number;
  objectId: string;
  subscriptionId: string | null;
  checkoutSessionId: string | null;
  propertyId: string | null;
  organizationId: string | null;
  customerId: string | null;
};

export type FinanceSubscriptionWebhookEntitlement = {
  organizationId: string;
  propertyId: string;
  planKey: string | null;
  subscriptionRef: string | null;
  checkoutSessionRef: string | null;
  activeRoomCount: number;
  lastProviderEventCreatedAt: string | null;
};

export type FinanceSubscriptionWebhookStore = {
  findEntitlement(
    payload: FinanceSubscriptionWebhookPayload,
  ): Promise<FinanceSubscriptionWebhookEntitlement | null>;
  recordCheckoutCompleted(input: {
    payload: FinanceSubscriptionWebhookPayload;
    snapshot: StripeSubscriptionSnapshot;
    activeRoomCount: number;
  }): Promise<FinanceSubscriptionWebhookEntitlement | null>;
  applySubscriptionSnapshot(input: {
    payload: FinanceSubscriptionWebhookPayload;
    snapshot: StripeSubscriptionSnapshot;
    transition: "paid" | "payment_failed" | "sync" | "deleted";
    activeRoomCount: number;
  }): Promise<FinanceSubscriptionWebhookEntitlement | null>;
  enqueuePaymentFailureNotification(input: {
    payload: FinanceSubscriptionWebhookPayload;
    entitlement: FinanceSubscriptionWebhookEntitlement;
    snapshot: StripeSubscriptionSnapshot;
  }): Promise<boolean>;
};

export type FinanceSubscriptionPaymentFailureNotification = {
  propertyId: string;
  organizationId: string;
  subscriptionId: string;
  eventId: string;
};

export async function processFinanceSubscriptionWebhook(
  payload: FinanceSubscriptionWebhookPayload,
  dependencies: {
    store: FinanceSubscriptionWebhookStore;
    stripe: StripeFinanceSubscriptionProvider;
    roomInventory: RoomInventoryReadPort;
    refreshPublicBookability?: (propertyId: string) => Promise<void>;
  },
): Promise<"applied" | "ignored_stale"> {
  validatePayload(payload);
  const existing = await dependencies.store.findEntitlement(payload);
  if (!existing) {
    if (payload.eventType === "checkout.session.completed") return "ignored_stale";
    throw new Error("Stripe subscription webhook does not map to a Finance entitlement.");
  }
  const subscriptionId = payload.subscriptionId ?? existing.subscriptionRef;
  if (!subscriptionId) throw new Error("Stripe subscription webhook omitted the subscription ID.");

  if (payload.eventType === "checkout.session.completed") {
    if (!existing.checkoutSessionRef || payload.checkoutSessionId !== existing.checkoutSessionRef) {
      return "ignored_stale";
    }
  }

  let snapshot = await dependencies.stripe.retrieveSubscription(subscriptionId);
  if (payload.eventType === "checkout.session.completed") {
    assertVerifiedFixedPlan(snapshot, existing, payload);
    const updated = await dependencies.store.recordCheckoutCompleted({
      payload,
      snapshot,
      activeRoomCount: existing.activeRoomCount,
    });
    if (!updated) return "ignored_stale";
    await dependencies.refreshPublicBookability?.(updated.propertyId);
    return "applied";
  }

  if (existing.subscriptionRef !== null && existing.subscriptionRef !== subscriptionId) {
    throw new Error("Stripe subscription webhook is not linked to this Finance entitlement.");
  }
  assertVerifiedFixedPlan(snapshot, existing, payload);

  let activeRoomCount = existing.activeRoomCount;
  if (payload.eventType === "invoice.upcoming") {
    if (isStaleEvent(payload, existing.lastProviderEventCreatedAt)) {
      return "ignored_stale";
    }
    const inventory = await dependencies.roomInventory.getRoomInventorySnapshot(
      existing.propertyId,
    );
    if (!inventory) throw new Error("Finance entitlement room inventory was not found.");
    activeRoomCount = inventory.activeRoomCount;
    if (!snapshot.subscriptionItemId) {
      throw new Error("Stripe subscription omitted its subscription item ID.");
    }
    snapshot = await dependencies.stripe.updateRoomQuantity({
      subscriptionId,
      subscriptionItemId: snapshot.subscriptionItemId,
      activeRoomCount,
      idempotencyKey: `room-quantity:${payload.rawEventId}`,
    });
  }

  const transition = transitionFor(payload.eventType);
  const updated = await dependencies.store.applySubscriptionSnapshot({
    payload,
    snapshot,
    transition,
    activeRoomCount,
  });
  if (!updated) return "ignored_stale";

  if (transition === "payment_failed" && updated.planKey === "fixed") {
    await dependencies.store.enqueuePaymentFailureNotification({
      payload,
      entitlement: updated,
      snapshot,
    });
  }
  await dependencies.refreshPublicBookability?.(updated.propertyId);
  return "applied";
}

export async function runFinanceSubscriptionWebhookJobs(
  connectionString: string,
  stripe: StripeFinanceSubscriptionProvider,
  roomInventory: RoomInventoryReadPort,
  options: {
    workerId?: string;
    limit?: number;
    refreshPublicBookability?: (propertyId: string) => Promise<void>;
  } = {},
): Promise<{ processed: number; failed: number }> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  attachPoolErrorLogger(pool, "finance-subscriptions");
  const store = createPgFinanceSubscriptionWebhookStore(pool);
  let processed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const job = await claimJob(
        pool,
        options.workerId ?? `finance-subscriptions:${process.pid}`,
        QUEUE,
        JOB_TYPE,
      );
      if (!job) break;
      try {
        await processFinanceSubscriptionWebhook(parsePayload(job.payload), {
          store,
          stripe,
          roomInventory,
          refreshPublicBookability: options.refreshPublicBookability,
        });
        await finishJob(pool, job.id);
        processed += 1;
      } catch (error) {
        await failJob(pool, job.id, error);
        failed += 1;
      }
    }
    return { processed, failed };
  } finally {
    await pool.end();
  }
}

export async function runFinanceSubscriptionNotificationJobs(
  connectionString: string,
  notifyInternal: (
    notification: FinanceSubscriptionPaymentFailureNotification,
  ) => void | Promise<void>,
  options: { workerId?: string; limit?: number; pool?: pg.Pool } = {},
): Promise<{ processed: number; failed: number }> {
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 2 });
  if (ownsPool) attachPoolErrorLogger(pool, "finance-notifications");
  let processed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const job = await claimJob(
        pool,
        options.workerId ?? `finance-notifications:${process.pid}`,
        NOTIFICATION_QUEUE,
        NOTIFICATION_JOB_TYPE,
      );
      if (!job) break;
      try {
        await notifyInternal(parseNotificationPayload(job.payload));
        await finishJob(pool, job.id);
        processed += 1;
      } catch (error) {
        await failJob(pool, job.id, error);
        failed += 1;
      }
    }
    return { processed, failed };
  } finally {
    if (ownsPool) await pool.end();
  }
}

export function createPgFinanceSubscriptionWebhookStore(
  pool: Pick<pg.Pool, "query">,
): FinanceSubscriptionWebhookStore {
  return {
    async findEntitlement(payload) {
      const result = await pool.query<FinanceSubscriptionWebhookEntitlement>(
        `${ENTITLEMENT_SELECT}
         WHERE entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND (($1::text IS NOT NULL AND entitlement.billing_subscription_ref = $1)
             OR ($2::text IS NOT NULL AND entitlement.checkout_session_ref = $2)
             OR ($1::text IS NOT NULL AND $4 <> 'checkout.session.completed'
               AND entitlement.billing_subscription_ref IS NULL AND $3::text IS NOT NULL
               AND $5::text IS NOT NULL AND entitlement.property_id::text = $3
               AND entitlement.organization_id::text = $5)
             OR ($4 = 'checkout.session.completed' AND $3::text IS NOT NULL
               AND $5::text IS NOT NULL AND entitlement.property_id::text = $3
               AND entitlement.organization_id::text = $5))
         ORDER BY CASE WHEN entitlement.billing_subscription_ref = $1 THEN 0 ELSE 1 END
         LIMIT 1`,
        [
          payload.subscriptionId,
          payload.checkoutSessionId,
          payload.propertyId,
          payload.eventType,
          payload.organizationId,
        ],
      );
      return result.rows[0] ?? null;
    },

    async recordCheckoutCompleted({ payload, snapshot, activeRoomCount }) {
      const result = await pool.query<FinanceSubscriptionWebhookEntitlement>(
        `UPDATE finance.billing_entitlements entitlement
         SET billing_customer_ref = $2,
             billing_subscription_ref = $3,
             provider_subscription_status = $4,
             billing_period_start_at = $5::timestamptz,
             billing_period_end_at = $6::timestamptz,
             cancel_at_period_end = $7,
             billing_amount_minor = $8,
             billing_currency = $9,
             active_room_count = $10,
             entitlement_metadata = entitlement.entitlement_metadata || $11::jsonb,
             last_provider_event_created_at = $12::timestamptz,
             last_provider_event_id = $13,
             updated_at = now()
         WHERE $1::text IS NOT NULL
           AND entitlement.checkout_session_ref = $1
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND (entitlement.last_provider_event_created_at IS NULL
             OR entitlement.last_provider_event_created_at <= $12::timestamptz)
         RETURNING entitlement.organization_id::text AS "organizationId",
           entitlement.property_id::text AS "propertyId", entitlement.plan_key AS "planKey",
           entitlement.billing_subscription_ref AS "subscriptionRef",
           entitlement.checkout_session_ref AS "checkoutSessionRef",
           entitlement.active_room_count AS "activeRoomCount",
           entitlement.last_provider_event_created_at::text AS "lastProviderEventCreatedAt"`,
        [
          payload.checkoutSessionId,
          snapshot.customerId,
          snapshot.subscriptionId,
          snapshot.status,
          snapshot.currentPeriodStart,
          snapshot.currentPeriodEnd,
          snapshot.cancelAtPeriodEnd,
          fixedPlanAmountMinor(activeRoomCount, snapshot.currency),
          snapshot.currency,
          activeRoomCount,
          JSON.stringify({ subscriptionItemId: snapshot.subscriptionItemId }),
          eventCreatedAt(payload),
          payload.rawEventId,
        ],
      );
      return result.rows[0] ?? null;
    },

    async applySubscriptionSnapshot({ payload, snapshot, transition, activeRoomCount }) {
      const activatesFixed = transition === "paid" && snapshot.status === "active";
      const endsFixed =
        transition === "deleted" && ["canceled", "incomplete_expired"].includes(snapshot.status);
      const result = await pool.query<FinanceSubscriptionWebhookEntitlement>(
        `UPDATE finance.billing_entitlements entitlement
         SET plan_key = CASE WHEN $2::boolean THEN 'fixed'
                             WHEN $3::boolean THEN 'commission'
                             ELSE entitlement.plan_key END,
             billing_status = CASE
               WHEN $3::boolean THEN 'active'
               WHEN $4 = 'payment_failed' AND entitlement.plan_key = 'fixed' THEN 'past_due'
               WHEN $2::boolean OR (entitlement.plan_key = 'fixed' AND $5 = 'active') THEN 'active'
               ELSE entitlement.billing_status END,
             billing_provider = 'stripe',
             billing_customer_ref = $6,
             billing_subscription_ref = $7,
             provider_subscription_status = $5,
             billing_period_start_at = $8::timestamptz,
             billing_period_end_at = $9::timestamptz,
             billing_period_start = $8::timestamptz::date,
             billing_period_end = $9::timestamptz::date,
             cancel_at_period_end = $10,
             billing_amount_minor = $11,
             billing_currency = $12,
             active_room_count = $13,
             starts_at = CASE WHEN $2::boolean THEN COALESCE(entitlement.starts_at, now())
                              ELSE entitlement.starts_at END,
             entitlement_metadata = entitlement.entitlement_metadata || $14::jsonb,
             last_provider_event_created_at = GREATEST(
               COALESCE(entitlement.last_provider_event_created_at, '-infinity'::timestamptz),
               $15::timestamptz
             ),
             last_provider_event_id = CASE
               WHEN entitlement.last_provider_event_created_at IS NULL
                 OR entitlement.last_provider_event_created_at <= $15::timestamptz
                 THEN $16
               ELSE entitlement.last_provider_event_id
             END,
             updated_at = now()
         WHERE (entitlement.billing_subscription_ref = $1
                OR (entitlement.billing_subscription_ref IS NULL
                  AND entitlement.property_id::text = $17
                  AND entitlement.organization_id::text = $18))
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
           AND (entitlement.last_provider_event_created_at IS NULL
             OR entitlement.last_provider_event_created_at <= $15::timestamptz
             OR ($2::boolean AND entitlement.plan_key <> 'fixed'))
         RETURNING entitlement.organization_id::text AS "organizationId",
           entitlement.property_id::text AS "propertyId", entitlement.plan_key AS "planKey",
           entitlement.billing_subscription_ref AS "subscriptionRef",
           entitlement.checkout_session_ref AS "checkoutSessionRef",
           entitlement.active_room_count AS "activeRoomCount",
           entitlement.last_provider_event_created_at::text AS "lastProviderEventCreatedAt"`,
        [
          snapshot.subscriptionId,
          activatesFixed,
          endsFixed,
          transition,
          snapshot.status,
          snapshot.customerId,
          snapshot.subscriptionId,
          snapshot.currentPeriodStart,
          snapshot.currentPeriodEnd,
          snapshot.cancelAtPeriodEnd,
          fixedPlanAmountMinor(activeRoomCount, snapshot.currency),
          snapshot.currency,
          activeRoomCount,
          JSON.stringify({
            subscriptionItemId: snapshot.subscriptionItemId,
            ...(endsFixed
              ? {
                  planSelectedAt: eventCreatedAt(payload),
                  planSelectedBy: "fixed-subscription-ended",
                }
              : {}),
          }),
          eventCreatedAt(payload),
          payload.rawEventId,
          payload.propertyId,
          payload.organizationId,
        ],
      );
      return result.rows[0] ?? null;
    },

    async enqueuePaymentFailureNotification({ payload, entitlement, snapshot }) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO platform.jobs
           (job_key, queue_name, job_type, tenant_scope, organization_id, property_id,
            resource_product, resource_type, resource_id, correlation_id,
            idempotency_key_hash, payload, job_metadata)
         VALUES ($1, 'finance.notifications',
           'finance.subscription-payment-failed.notify-internal', 'property', $2::uuid, $3::uuid,
           'finance', 'billing_subscription', $4, $5, $6, $7::jsonb,
           '{"audience":"vayada-internal","reason":"recurring-payment-failed"}'::jsonb)
         ON CONFLICT (queue_name, job_key) DO NOTHING
         RETURNING id::text`,
        [
          `finance.subscription-payment-failed:${payload.rawEventId}:v1`,
          entitlement.organizationId,
          entitlement.propertyId,
          snapshot.subscriptionId,
          `webhook:stripe:${payload.rawEventId}`,
          `sha256:${createHash("sha256").update(payload.rawEventId).digest("hex")}`,
          JSON.stringify({
            eventId: payload.rawEventId,
            propertyId: entitlement.propertyId,
            organizationId: entitlement.organizationId,
            subscriptionId: snapshot.subscriptionId,
            providerStatus: snapshot.status,
          }),
        ],
      );
      return Boolean(result.rows[0]);
    },
  };
}

const ENTITLEMENT_SELECT = `SELECT entitlement.organization_id::text AS "organizationId",
  entitlement.property_id::text AS "propertyId", entitlement.plan_key AS "planKey",
  entitlement.billing_subscription_ref AS "subscriptionRef",
  entitlement.checkout_session_ref AS "checkoutSessionRef",
  COALESCE(entitlement.active_room_count, 0)::int AS "activeRoomCount",
  entitlement.last_provider_event_created_at::text AS "lastProviderEventCreatedAt"
  FROM finance.billing_entitlements entitlement`;

async function claimJob(pool: pg.Pool, workerId: string, queue: string, jobType: string) {
  const result = await pool.query<{ id: string; payload: Record<string, unknown> }>(
    `UPDATE platform.jobs job SET status = 'running', attempts_count = attempts_count + 1,
       locked_at = now(), locked_by = $3
     FROM (SELECT id FROM platform.jobs
       WHERE queue_name = $1 AND job_type = $2
         AND (status = 'pending' OR (status = 'running'
           AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')))
         AND run_after <= now() AND attempts_count < max_attempts
       ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text, job.payload`,
    [queue, jobType, workerId],
  );
  return result.rows[0] ?? null;
}

async function finishJob(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE platform.jobs SET status = 'succeeded', finished_at = now(),
       locked_at = NULL, locked_by = NULL WHERE id = $1::uuid`,
    [jobId],
  );
}

async function failJob(pool: pg.Pool, jobId: string, error: unknown): Promise<void> {
  await pool.query(
    `UPDATE platform.jobs SET status = CASE WHEN attempts_count >= max_attempts
         THEN 'dead_lettered' ELSE 'pending' END,
       run_after = now() + interval '30 seconds', locked_at = NULL, locked_by = NULL,
       finished_at = CASE WHEN attempts_count >= max_attempts THEN now() ELSE NULL END,
       job_metadata = COALESCE(job_metadata, '{}'::jsonb)
         || jsonb_build_object('lastError', $2::text)
     WHERE id = $1::uuid`,
    [jobId, error instanceof Error ? error.message : "Finance subscription webhook failed"],
  );
}

function attachPoolErrorLogger(pool: pg.Pool, workerName: string): void {
  pool.on("error", (error) => {
    process.stderr.write(`[${workerName}] PostgreSQL pool error: ${error.message}\n`);
  });
}

function parsePayload(value: Record<string, unknown>): FinanceSubscriptionWebhookPayload {
  return {
    provider: "stripe",
    eventType: text(value.eventType),
    rawEventId: text(value.rawEventId),
    eventCreated: number(value.eventCreated),
    objectId: text(value.objectId),
    subscriptionId: optionalText(value.subscriptionId),
    checkoutSessionId: optionalText(value.checkoutSessionId),
    propertyId: optionalText(value.propertyId),
    organizationId: optionalText(value.organizationId),
    customerId: optionalText(value.customerId),
  };
}

function validatePayload(payload: FinanceSubscriptionWebhookPayload): void {
  if (
    payload.provider !== "stripe" ||
    !payload.eventType ||
    !payload.rawEventId ||
    !payload.objectId
  ) {
    throw new Error("Invalid Finance subscription webhook payload.");
  }
  if (!Number.isFinite(payload.eventCreated) || payload.eventCreated <= 0) {
    throw new Error("Stripe subscription webhook omitted its event creation time.");
  }
}

function assertVerifiedFixedPlan(
  snapshot: StripeSubscriptionSnapshot,
  entitlement: FinanceSubscriptionWebhookEntitlement,
  payload: FinanceSubscriptionWebhookPayload,
): void {
  if (!snapshot.fixedPlanVerified) {
    throw new Error("Stripe subscription does not match the configured Vayada Fixed Plan.");
  }
  if (snapshot.propertyId !== entitlement.propertyId) {
    throw new Error(
      "Stripe subscription property metadata does not match the Finance entitlement.",
    );
  }
  if (snapshot.organizationId !== entitlement.organizationId) {
    throw new Error(
      "Stripe subscription organization metadata does not match the Finance entitlement.",
    );
  }
  if (payload.propertyId && payload.propertyId !== entitlement.propertyId) {
    throw new Error("Stripe webhook property metadata does not match the Finance entitlement.");
  }
  if (payload.organizationId && payload.organizationId !== entitlement.organizationId) {
    throw new Error("Stripe webhook organization metadata does not match the Finance entitlement.");
  }
}

function parseNotificationPayload(
  value: Record<string, unknown>,
): FinanceSubscriptionPaymentFailureNotification {
  return {
    eventId: text(value.eventId),
    propertyId: text(value.propertyId),
    organizationId: text(value.organizationId),
    subscriptionId: text(value.subscriptionId),
  };
}

function transitionFor(eventType: string): "paid" | "payment_failed" | "sync" | "deleted" {
  if (eventType === "invoice.paid") return "paid";
  if (eventType === "invoice.payment_failed") return "payment_failed";
  if (eventType === "customer.subscription.deleted") return "deleted";
  if (eventType === "invoice.upcoming" || eventType === "customer.subscription.updated")
    return "sync";
  throw new Error(`Unsupported Finance subscription event: ${eventType}`);
}

function eventCreatedAt(payload: FinanceSubscriptionWebhookPayload): string {
  return new Date(payload.eventCreated * 1_000).toISOString();
}

function isStaleEvent(
  payload: FinanceSubscriptionWebhookPayload,
  lastProviderEventCreatedAt: string | null,
): boolean {
  if (!lastProviderEventCreatedAt) return false;
  return payload.eventCreated * 1_000 < Date.parse(lastProviderEventCreatedAt);
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Invalid Finance subscription webhook payload.");
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}
