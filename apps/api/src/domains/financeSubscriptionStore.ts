import { createHash } from "node:crypto";

import type {
  CreateFixedPlanCheckoutCommand,
  CreateFixedPlanCheckoutResult,
  FinanceSubscriptionCommandContext,
  OpenFinanceCustomerPortalResult,
  SelectCommissionPlanResult,
  StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export type FinanceSubscriptionEntitlementRow = {
  organizationId: string;
  propertyId: string;
  planKey: string | null;
  billingStatus: string;
  customerRef: string | null;
  subscriptionRef: string | null;
  checkoutSessionRef: string | null;
  providerSubscriptionStatus: string | null;
  periodStart: Date | string | null;
  periodEnd: Date | string | null;
  cancelAtPeriodEnd: boolean;
  amountMinor: number | null;
  currency: string | null;
  activeRoomCount: number | null;
  startsAt: Date | string | null;
  metadata: unknown;
  updatedAt: Date | string;
};

type SubscriptionStoreExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type FinanceSubscriptionStore = {
  withPlanMutationLock<T>(propertyId: string, action: () => Promise<T>): Promise<T>;
  getEntitlement(propertyId: string): Promise<FinanceSubscriptionEntitlementRow | null>;
  findReplay<T>(
    operation: string,
    command: FinanceSubscriptionCommandContext,
  ): Promise<{ result: T } | { conflict: true } | null>;
  recordCheckout(
    command: CreateFixedPlanCheckoutCommand,
    result: CreateFixedPlanCheckoutResult,
  ): Promise<{ status: "created" | "idempotent_replay"; result: CreateFixedPlanCheckoutResult }>;
  recordCommissionSelection(
    command: FinanceSubscriptionCommandContext,
    result: SelectCommissionPlanResult,
  ): Promise<{ status: "created" | "idempotent_replay"; result: SelectCommissionPlanResult }>;
  recordPortal(
    command: FinanceSubscriptionCommandContext,
    result: OpenFinanceCustomerPortalResult,
  ): Promise<{ status: "created" | "idempotent_replay"; result: OpenFinanceCustomerPortalResult }>;
  recordCancellation(
    command: FinanceSubscriptionCommandContext,
    snapshot: StripeSubscriptionSnapshot,
  ): Promise<void>;
  close(): Promise<void>;
};

export function createPgFinanceSubscriptionStore(config: {
  connectionString: string;
  max?: number;
  pool?: SubscriptionStoreExecutor & { connect?(): Promise<PoolClient>; end?(): Promise<void> };
}): FinanceSubscriptionStore {
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max ?? 5 });

  return {
    async withPlanMutationLock(propertyId, action) {
      if (!pool.connect) return action();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('finance-fixed-checkout:' || $1, 0))`,
          [propertyId],
        );
        const result = await action();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getEntitlement(propertyId) {
      const result = await pool.query<FinanceSubscriptionEntitlementRow>(
        `${ENTITLEMENT_SELECT}
         WHERE entitlement.property_id = $1::uuid
           AND entitlement.product = 'booking'
           AND entitlement.entitlement_key = 'direct-booking-finance'
         LIMIT 1`,
        [propertyId],
      );
      return result.rows[0] ?? null;
    },

    async findReplay<T>(operation: string, command: FinanceSubscriptionCommandContext) {
      return findReplay<T>(pool, operation, command);
    },

    async recordCheckout(command, result) {
      return withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(
          client,
          "fixed-plan-checkout",
          command,
          {
            result,
          },
        );
        if (!idempotency.inserted) {
          return {
            status: "idempotent_replay",
            result: idempotency.result as CreateFixedPlanCheckoutResult,
          };
        }
        await client.query(
          `INSERT INTO finance.billing_entitlements
             (
               organization_id, property_id, product, entitlement_key,
               billing_status, plan_key, billing_provider, checkout_session_ref,
               provider_subscription_status, billing_amount_minor, billing_currency,
               active_room_count, source_system, entitlement_metadata, updated_at
             )
           VALUES
             ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance',
              'active', 'commission', 'stripe', $3, 'incomplete', $4, 'EUR', $5,
              'finance', $6::jsonb, $7::timestamptz)
           ON CONFLICT (organization_id, product, entitlement_key, (COALESCE(property_id::text, '')))
           DO UPDATE SET
             checkout_session_ref = EXCLUDED.checkout_session_ref,
             provider_subscription_status = CASE
               WHEN finance.billing_entitlements.plan_key = 'fixed'
                 THEN finance.billing_entitlements.provider_subscription_status
               ELSE EXCLUDED.provider_subscription_status
             END,
             billing_amount_minor = EXCLUDED.billing_amount_minor,
             billing_currency = EXCLUDED.billing_currency,
             active_room_count = EXCLUDED.active_room_count,
             billing_provider = 'stripe',
             entitlement_metadata = finance.billing_entitlements.entitlement_metadata || EXCLUDED.entitlement_metadata,
             updated_at = EXCLUDED.updated_at`,
          [
            command.organizationId,
            command.propertyId,
            result.checkoutSessionId,
            result.amountMinor,
            result.activeRoomCount,
            JSON.stringify({
              fixedPlanPriceVersion: "vayada_fixed_eur_30d_v1",
              checkoutRequestedAt: command.audit.requestedAt,
              checkoutUrl: result.checkoutUrl,
            }),
            command.audit.requestedAt,
          ],
        );
        await ensureBookingCommissionRule(client, command.propertyId, command.audit.requestedAt);
        await insertAudit(client, "fixed-plan-checkout", command, idempotency.id, {
          checkoutSessionId: result.checkoutSessionId,
          amountMinor: result.amountMinor,
          currency: result.currency,
          activeRoomCount: result.activeRoomCount,
        });
        return { status: "created", result };
      });
    },

    async recordCommissionSelection(command, result) {
      return withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(client, "select-commission", command, {
          result,
        });
        if (!idempotency.inserted) {
          return {
            status: "idempotent_replay",
            result: idempotency.result as SelectCommissionPlanResult,
          };
        }
        await client.query(
          `INSERT INTO finance.billing_entitlements
             (
               organization_id, property_id, product, entitlement_key,
               billing_status, plan_key, billing_provider,
               source_system, entitlement_metadata, updated_at
             )
           VALUES
             ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance',
              'active', 'commission', 'none', 'finance', $3::jsonb, $4::timestamptz)
           ON CONFLICT (organization_id, product, entitlement_key, (COALESCE(property_id::text, '')))
           DO UPDATE SET
             plan_key = CASE
               WHEN finance.billing_entitlements.plan_key = 'fixed'
                 THEN finance.billing_entitlements.plan_key
               ELSE 'commission'
             END,
             billing_provider = CASE
               WHEN finance.billing_entitlements.plan_key = 'fixed'
                 THEN finance.billing_entitlements.billing_provider
               ELSE 'none'
             END,
             checkout_session_ref = CASE
               WHEN finance.billing_entitlements.plan_key = 'fixed'
                 THEN finance.billing_entitlements.checkout_session_ref
               ELSE NULL
             END,
             provider_subscription_status = CASE
               WHEN finance.billing_entitlements.plan_key = 'fixed'
                 THEN finance.billing_entitlements.provider_subscription_status
               ELSE NULL
             END,
             entitlement_metadata = finance.billing_entitlements.entitlement_metadata || EXCLUDED.entitlement_metadata,
             updated_at = EXCLUDED.updated_at`,
          [
            command.organizationId,
            command.propertyId,
            JSON.stringify({
              planSelectedAt: command.audit.requestedAt,
              planSelectedBy: "onboarding",
            }),
            command.audit.requestedAt,
          ],
        );
        await ensureBookingCommissionRule(client, command.propertyId, command.audit.requestedAt);
        await insertAudit(client, "select-commission", command, idempotency.id, {
          plan: "commission",
        });
        return { status: "created", result };
      });
    },

    async recordPortal(command, result) {
      return withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(client, "customer-portal", command, {
          result,
        });
        if (!idempotency.inserted) {
          return {
            status: "idempotent_replay",
            result: idempotency.result as OpenFinanceCustomerPortalResult,
          };
        }
        await insertAudit(client, "customer-portal", command, idempotency.id, {
          portalSessionCreated: true,
        });
        return { status: "created", result };
      });
    },

    async recordCancellation(command, snapshot) {
      await withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(
          client,
          "schedule-commission",
          command,
          {
            result: {
              subscriptionId: snapshot.subscriptionId,
              currentPeriodEnd: snapshot.currentPeriodEnd,
            },
          },
        );
        if (!idempotency.inserted) return;
        await client.query(
          `UPDATE finance.billing_entitlements
           SET cancel_at_period_end = TRUE,
               provider_subscription_status = $3,
               billing_period_start_at = $4::timestamptz,
               billing_period_end_at = $5::timestamptz,
               entitlement_metadata = entitlement_metadata || $6::jsonb,
               updated_at = $7::timestamptz
           WHERE property_id = $1::uuid
             AND organization_id = $2::uuid
             AND billing_subscription_ref = $8
             AND product = 'booking'
             AND entitlement_key = 'direct-booking-finance'`,
          [
            command.propertyId,
            command.organizationId,
            snapshot.status,
            snapshot.currentPeriodStart,
            snapshot.currentPeriodEnd,
            JSON.stringify({ subscriptionItemId: snapshot.subscriptionItemId }),
            command.audit.requestedAt,
            snapshot.subscriptionId,
          ],
        );
        await insertAudit(client, "schedule-commission", command, idempotency.id, {
          cancelAtPeriodEnd: true,
          paidThrough: snapshot.currentPeriodEnd,
        });
      });
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

async function ensureBookingCommissionRule(
  client: SubscriptionStoreExecutor,
  propertyId: string,
  requestedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO finance.commission_rules (
       property_id, rule_scope, product, commission_type, percentage_rate,
       status, starts_at, source_system, source_rule_id, rule_metadata,
       created_at, updated_at
     )
     SELECT
       $1::uuid, 'property', 'booking', 'percentage', 5,
       'active', $2::timestamptz, 'finance', $3,
       '{"source":"onboarding","bookingEngineFeePercent":5}'::jsonb,
       $2::timestamptz, $2::timestamptz
     ON CONFLICT (source_system, source_rule_id) DO UPDATE SET
       property_id = EXCLUDED.property_id,
       rule_scope = 'property',
       product = 'booking',
       commission_type = 'percentage',
       percentage_rate = 5,
       fixed_amount = NULL,
       currency = NULL,
       status = 'active',
       starts_at = LEAST(finance.commission_rules.starts_at, EXCLUDED.starts_at),
       ends_at = NULL,
       rule_metadata = finance.commission_rules.rule_metadata || EXCLUDED.rule_metadata,
       updated_at = EXCLUDED.updated_at`,
    [propertyId, requestedAt, `onboarding-booking:${propertyId}`],
  );
}

const ENTITLEMENT_SELECT = `SELECT
  entitlement.organization_id::text AS "organizationId",
  entitlement.property_id::text AS "propertyId",
  entitlement.plan_key AS "planKey",
  entitlement.billing_status AS "billingStatus",
  entitlement.billing_customer_ref AS "customerRef",
  entitlement.billing_subscription_ref AS "subscriptionRef",
  entitlement.checkout_session_ref AS "checkoutSessionRef",
  entitlement.provider_subscription_status AS "providerSubscriptionStatus",
  entitlement.billing_period_start_at AS "periodStart",
  entitlement.billing_period_end_at AS "periodEnd",
  entitlement.cancel_at_period_end AS "cancelAtPeriodEnd",
  entitlement.billing_amount_minor AS "amountMinor",
  entitlement.billing_currency AS "currency",
  entitlement.active_room_count AS "activeRoomCount",
  entitlement.starts_at AS "startsAt",
  entitlement.entitlement_metadata AS metadata,
  entitlement.updated_at AS "updatedAt"
FROM finance.billing_entitlements entitlement`;

async function findReplay<T>(
  executor: SubscriptionStoreExecutor,
  operation: string,
  command: FinanceSubscriptionCommandContext,
): Promise<{ result: T } | { conflict: true } | null> {
  const result = await executor.query<{ fingerprint: string; metadata: unknown }>(
    `SELECT request_fingerprint_hash AS fingerprint, idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance'
       AND operation = $1
       AND property_id = $2::uuid
       AND key_hash = $3
       AND status = 'completed'
     LIMIT 1`,
    [operation, command.propertyId, keyHash(command)],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.fingerprint !== fingerprint(command)) return { conflict: true };
  const metadata = object(row.metadata);
  return metadata["result"] ? { result: metadata["result"] as T } : { conflict: true };
}

async function insertCompletedIdempotency(
  client: SubscriptionStoreExecutor,
  operation: string,
  command: FinanceSubscriptionCommandContext,
  metadata: Record<string, unknown>,
): Promise<{ inserted: true; id: string } | { inserted: false; result: unknown }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope, operation, key_hash, request_fingerprint_hash,
         status, tenant_scope, organization_id, property_id,
         response_status_code, response_body_hash, response_resource_product,
         response_resource_type, response_resource_id, correlation_id,
         completed_at, expires_at, idempotency_metadata
       )
     VALUES
       ('finance', $1, $2, $3, 'completed', 'property', $4::uuid, $5::uuid,
        200, $6, 'finance', 'billing_entitlement', $5, $7, now(), now() + interval '30 days', $8::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text`,
    [
      operation,
      keyHash(command),
      fingerprint(command),
      command.organizationId,
      command.propertyId,
      sha256(JSON.stringify(metadata)),
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify(metadata),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id) return { inserted: true, id };
  const replay = await findReplay<unknown>(client, operation, command);
  if (replay && "result" in replay) return { inserted: false, result: replay.result };
  throw Object.assign(new Error("Finance subscription idempotency conflict."), {
    code: "idempotency_conflict",
  });
}

async function insertAudit(
  client: SubscriptionStoreExecutor,
  action: string,
  command: FinanceSubscriptionCommandContext,
  idempotencyId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const actor = command.audit.actor;
  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key, product, action, occurred_at, tenant_scope,
         organization_id, property_id, actor_type, actor_user_id,
         target_resource_product, target_resource_type, target_resource_id,
         idempotency_key_id, correlation_id, redacted_payload,
         retention_class, privacy_scope
       )
     VALUES
       ($1, 'finance', $2, $3::timestamptz, 'property', $4::uuid, $5::uuid,
        $6, $7::uuid, 'finance', 'billing_entitlement', $5, $8::uuid, $9,
        $10::jsonb, 'financial', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.subscription.${action}:${command.propertyId}:${command.commandId}`,
      `finance.subscription.${action}`,
      command.audit.requestedAt,
      command.organizationId,
      command.propertyId,
      actor.kind === "user" ? "user" : "system",
      actor.kind === "user" ? actor.userId : null,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify(payload),
    ],
  );
}

async function withTransaction<T>(
  pool: SubscriptionStoreExecutor & { connect?(): Promise<PoolClient> },
  action: (client: SubscriptionStoreExecutor) => Promise<T>,
): Promise<T> {
  const connected = pool.connect ? await pool.connect() : pool;
  const client: SubscriptionStoreExecutor = connected;
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if ("release" in connected && typeof connected.release === "function") connected.release();
  }
}

function fingerprint(command: FinanceSubscriptionCommandContext): string {
  return sha256(
    JSON.stringify({
      commandId: command.commandId,
      propertyId: command.propertyId,
      organizationId: command.organizationId,
      customerEmail: "customerEmail" in command ? command.customerEmail : undefined,
    }),
  );
}

function keyHash(command: FinanceSubscriptionCommandContext): string {
  return sha256(`${command.organizationId}:${command.propertyId}:${command.idempotencyKey}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
