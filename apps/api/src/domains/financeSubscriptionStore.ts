import { createHash } from "node:crypto";

import type {
  CreateFixedPlanCheckoutCommand,
  CreateFixedPlanCheckoutResult,
  FinanceBillingOverview,
  FinancePaymentCollectionMethod,
  FinanceSubscriptionCommandContext,
  OpenFinanceCustomerPortalResult,
  SelectCommissionPlanResult,
  StripeSubscriptionSnapshot,
  UpdateFinanceBillingDetailsCommand,
  UpdateFinancePaymentMethodCommand,
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

export type FinancePlanMutationStore = {
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
  recordImmediateCommission(
    command: FinanceSubscriptionCommandContext,
    snapshot: StripeSubscriptionSnapshot,
    result: FinanceBillingOverview,
  ): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }>;
  recordFixedActivation(
    command: FinanceSubscriptionCommandContext,
    snapshot: StripeSubscriptionSnapshot,
    result: FinanceBillingOverview,
    paymentMethod: FinancePaymentCollectionMethod,
  ): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }>;
};

export type FinanceSubscriptionStore = FinancePlanMutationStore & {
  withPlanMutationLock<T>(
    propertyId: string,
    action: (store: FinancePlanMutationStore) => Promise<T>,
  ): Promise<T>;
  recordPortal(
    command: FinanceSubscriptionCommandContext,
    result: OpenFinanceCustomerPortalResult,
  ): Promise<{ status: "created" | "idempotent_replay"; result: OpenFinanceCustomerPortalResult }>;
  recordCancellation(
    command: FinanceSubscriptionCommandContext,
    snapshot: StripeSubscriptionSnapshot,
  ): Promise<void>;
  recordBillingDetails(
    command: UpdateFinanceBillingDetailsCommand,
    customerRef: string | null,
    result: FinanceBillingOverview,
  ): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }>;
  recordPaymentMethod(
    command: UpdateFinancePaymentMethodCommand,
    result: FinanceBillingOverview,
  ): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }>;
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
      if (!pool.connect) {
        return action({
          getEntitlement: (lockedPropertyId) => getEntitlement(pool, lockedPropertyId),
          findReplay<T>(operation: string, command: FinanceSubscriptionCommandContext) {
            return findReplay<T>(pool, operation, command);
          },
          recordCheckout: (command, result) =>
            withTransaction(pool, (transaction) => recordCheckout(transaction, command, result)),
          recordCommissionSelection: (command, result) =>
            withTransaction(pool, (transaction) =>
              recordCommissionSelection(transaction, command, result),
            ),
          recordImmediateCommission: (command, snapshot, result) =>
            withTransaction(pool, (transaction) =>
              recordImmediateCommission(transaction, command, snapshot, result),
            ),
          recordFixedActivation: (command, snapshot, result, paymentMethod) =>
            withTransaction(pool, (transaction) =>
              recordFixedActivation(transaction, command, snapshot, result, paymentMethod),
            ),
        });
      }
      const client = await pool.connect();
      try {
        await client.query(
          `SELECT pg_advisory_lock(hashtextextended('finance-plan-mutation:' || $1, 0))`,
          [propertyId],
        );
        return await action({
          getEntitlement: (lockedPropertyId) => getEntitlement(client, lockedPropertyId),
          findReplay<T>(operation: string, command: FinanceSubscriptionCommandContext) {
            return findReplay<T>(client, operation, command);
          },
          recordCheckout: (command, result) =>
            withExistingTransaction(client, (transaction) =>
              recordCheckout(transaction, command, result),
            ),
          recordCommissionSelection: (command, result) =>
            withExistingTransaction(client, (transaction) =>
              recordCommissionSelection(transaction, command, result),
            ),
          recordImmediateCommission: (command, snapshot, result) =>
            withExistingTransaction(client, (transaction) =>
              recordImmediateCommission(transaction, command, snapshot, result),
            ),
          recordFixedActivation: (command, snapshot, result, paymentMethod) =>
            withExistingTransaction(client, (transaction) =>
              recordFixedActivation(transaction, command, snapshot, result, paymentMethod),
            ),
        });
      } finally {
        let unlocked = false;
        try {
          await client.query(
            `SELECT pg_advisory_unlock(hashtextextended('finance-plan-mutation:' || $1, 0))`,
            [propertyId],
          );
          unlocked = true;
        } finally {
          client.release(!unlocked);
        }
      }
    },

    async getEntitlement(propertyId) {
      return getEntitlement(pool, propertyId);
    },

    async findReplay<T>(operation: string, command: FinanceSubscriptionCommandContext) {
      return findReplay<T>(pool, operation, command);
    },

    async recordCheckout(command, result) {
      return withTransaction(pool, (client) => recordCheckout(client, command, result));
    },

    async recordCommissionSelection(command, result) {
      return withTransaction(pool, (client) => recordCommissionSelection(client, command, result));
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

    async recordImmediateCommission(command, snapshot, result) {
      return withTransaction(pool, (client) =>
        recordImmediateCommission(client, command, snapshot, result),
      );
    },

    async recordFixedActivation(command, snapshot, result, paymentMethod) {
      return withTransaction(pool, (client) =>
        recordFixedActivation(client, command, snapshot, result, paymentMethod),
      );
    },

    async recordBillingDetails(command, customerRef, result) {
      return withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(client, "billing-details", command, {
          result,
        });
        if (!idempotency.inserted) {
          return {
            status: "idempotent_replay",
            result: idempotency.result as FinanceBillingOverview,
          };
        }
        await upsertBillingMetadata(client, command, customerRef, {
          billingDetails: command.billingDetails,
        });
        await insertAudit(client, "billing-details", command, idempotency.id, {
          companyNameUpdated: true,
          billingEmailUpdated: true,
          taxIdPresent: Boolean(command.billingDetails.taxId),
        });
        return { status: "updated", result };
      });
    },

    async recordPaymentMethod(command, result) {
      return withTransaction(pool, async (client) => {
        const idempotency = await insertCompletedIdempotency(client, "payment-method", command, {
          result,
        });
        if (!idempotency.inserted) {
          return {
            status: "idempotent_replay",
            result: idempotency.result as FinanceBillingOverview,
          };
        }
        await upsertBillingMetadata(client, command, null, {
          paymentMethod: command.paymentMethod,
        });
        await insertAudit(client, "payment-method", command, idempotency.id, {
          paymentMethod: command.paymentMethod,
        });
        return { status: "updated", result };
      });
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

async function getEntitlement(
  executor: SubscriptionStoreExecutor,
  propertyId: string,
): Promise<FinanceSubscriptionEntitlementRow | null> {
  const result = await executor.query<FinanceSubscriptionEntitlementRow>(
    `${ENTITLEMENT_SELECT}
     WHERE entitlement.property_id = $1::uuid
       AND entitlement.product = 'booking'
       AND entitlement.entitlement_key = 'direct-booking-finance'
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function recordCheckout(
  client: SubscriptionStoreExecutor,
  command: CreateFixedPlanCheckoutCommand,
  result: CreateFixedPlanCheckoutResult,
): Promise<{ status: "created" | "idempotent_replay"; result: CreateFixedPlanCheckoutResult }> {
  const idempotency = await insertCompletedIdempotency(client, "fixed-plan-checkout", command, {
    result,
  });
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
              'active', 'commission', 'stripe', $3, 'incomplete', $4, $5, $6,
              'finance', $7::jsonb, $8::timestamptz)
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
      result.currency,
      result.activeRoomCount,
      JSON.stringify({
        fixedPlanPriceVersion: `vayada_fixed_${result.currency.toLowerCase()}_monthly_v2`,
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
}

async function recordImmediateCommission(
  client: SubscriptionStoreExecutor,
  command: FinanceSubscriptionCommandContext,
  snapshot: StripeSubscriptionSnapshot,
  result: FinanceBillingOverview,
): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }> {
  const idempotency = await insertCompletedIdempotency(client, "switch-commission-now", command, {
    result,
  });
  if (!idempotency.inserted) {
    return { status: "idempotent_replay", result: idempotency.result as FinanceBillingOverview };
  }
  const updated = await client.query(
    `UPDATE finance.billing_entitlements
     SET plan_key = 'commission', billing_status = 'active',
         checkout_session_ref = NULL,
         provider_subscription_status = $3, billing_period_start_at = NULL,
         billing_period_end_at = NULL, cancel_at_period_end = FALSE,
         billing_amount_minor = $4, billing_currency = $5,
         active_room_count = $6,
         entitlement_metadata = entitlement_metadata || $7::jsonb,
         updated_at = $8::timestamptz
     WHERE property_id = $1::uuid AND organization_id = $2::uuid
       AND billing_subscription_ref = $9
       AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
    [
      command.propertyId,
      command.organizationId,
      snapshot.status,
      result.planStatus.amountMinor,
      result.planStatus.currency,
      result.planStatus.activeRoomCount,
      JSON.stringify({ planSelectedAt: command.audit.requestedAt, planSelectedBy: "billing" }),
      command.audit.requestedAt,
      snapshot.subscriptionId,
    ],
  );
  if (updated.rowCount !== 1)
    throw new Error("The Fixed Plan entitlement changed before it could be updated.");
  await ensureBookingCommissionRule(client, command.propertyId, command.audit.requestedAt);
  await insertAudit(client, "switch-commission-now", command, idempotency.id, {
    plan: "commission",
    prorated: true,
    subscriptionId: snapshot.subscriptionId,
  });
  return { status: "updated", result };
}

async function recordFixedActivation(
  client: SubscriptionStoreExecutor,
  command: FinanceSubscriptionCommandContext,
  snapshot: StripeSubscriptionSnapshot,
  result: FinanceBillingOverview,
  paymentMethod: FinancePaymentCollectionMethod,
): Promise<{ status: "updated" | "idempotent_replay"; result: FinanceBillingOverview }> {
  const operation = paymentMethod === "card" ? "fixed-plan-card" : "fixed-plan-invoice";
  const idempotency = await insertCompletedIdempotency(client, operation, command, {
    result,
  });
  if (!idempotency.inserted) {
    return { status: "idempotent_replay", result: idempotency.result as FinanceBillingOverview };
  }
  const updated = await client.query(
    `UPDATE finance.billing_entitlements
     SET plan_key = 'fixed', billing_status = 'active', billing_provider = 'stripe',
         billing_customer_ref = $3, billing_subscription_ref = $4,
         checkout_session_ref = NULL, provider_subscription_status = $5,
         billing_period_start_at = $6::timestamptz,
         billing_period_end_at = $7::timestamptz, cancel_at_period_end = FALSE,
         billing_amount_minor = $8, billing_currency = $9, active_room_count = $10,
         starts_at = COALESCE(starts_at, $11::timestamptz),
         entitlement_metadata = entitlement_metadata || $12::jsonb,
         updated_at = $11::timestamptz
     WHERE property_id = $1::uuid AND organization_id = $2::uuid
       AND product = 'booking' AND entitlement_key = 'direct-booking-finance'
       AND plan_key <> 'fixed'`,
    [
      command.propertyId,
      command.organizationId,
      snapshot.customerId,
      snapshot.subscriptionId,
      snapshot.status,
      snapshot.currentPeriodStart,
      snapshot.currentPeriodEnd,
      result.planStatus.amountMinor,
      result.planStatus.currency,
      result.planStatus.activeRoomCount,
      command.audit.requestedAt,
      JSON.stringify({
        subscriptionItemId: snapshot.subscriptionItemId,
        planSelectedAt: command.audit.requestedAt,
        planSelectedBy: `billing-${paymentMethod}`,
      }),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("The billing entitlement changed before activation.");
  await insertAudit(client, operation, command, idempotency.id, {
    plan: "fixed",
    paymentMethod,
    subscriptionId: snapshot.subscriptionId,
  });
  return { status: "updated", result };
}

async function upsertBillingMetadata(
  client: SubscriptionStoreExecutor,
  command: FinanceSubscriptionCommandContext,
  customerRef: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO finance.billing_entitlements
       (organization_id, property_id, product, entitlement_key, billing_status,
        plan_key, billing_provider, billing_customer_ref, source_system,
        entitlement_metadata, updated_at)
     VALUES ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance', 'active',
       'commission', $3, $4, 'finance', $5::jsonb, $6::timestamptz)
     ON CONFLICT (organization_id, product, entitlement_key, (COALESCE(property_id::text, '')))
     DO UPDATE SET
       billing_provider = CASE WHEN $4::text IS NULL THEN finance.billing_entitlements.billing_provider ELSE 'stripe' END,
       billing_customer_ref = COALESCE($4, finance.billing_entitlements.billing_customer_ref),
       entitlement_metadata = finance.billing_entitlements.entitlement_metadata || EXCLUDED.entitlement_metadata,
       updated_at = EXCLUDED.updated_at`,
    [
      command.organizationId,
      command.propertyId,
      customerRef ? "stripe" : "none",
      customerRef,
      JSON.stringify(metadata),
      command.audit.requestedAt,
    ],
  );
}

async function recordCommissionSelection(
  client: SubscriptionStoreExecutor,
  command: FinanceSubscriptionCommandContext,
  result: SelectCommissionPlanResult,
): Promise<{ status: "created" | "idempotent_replay"; result: SelectCommissionPlanResult }> {
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
       AND tenant_scope = 'property'
       AND organization_id IS NULL
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
       ('finance', $1, $2, $3, 'completed', 'property', NULL, $4::uuid,
        200, $5, 'finance', 'billing_entitlement', $4, $6, now(), now() + interval '30 days', $7::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text`,
    [
      operation,
      keyHash(command),
      fingerprint(command),
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
       ($1, 'finance', $2, $3::timestamptz, 'property', NULL, $4::uuid,
        $5, $6::uuid, 'finance', 'billing_entitlement', $4, $7::uuid, $8,
        $9::jsonb, 'financial', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.subscription.${action}:${command.propertyId}:${command.commandId}`,
      `finance.subscription.${action}`,
      command.audit.requestedAt,
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

async function withExistingTransaction<T>(
  client: SubscriptionStoreExecutor,
  action: (client: SubscriptionStoreExecutor) => Promise<T>,
): Promise<T> {
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function fingerprint(command: FinanceSubscriptionCommandContext): string {
  return sha256(
    JSON.stringify({
      commandId: command.commandId,
      propertyId: command.propertyId,
      organizationId: command.organizationId,
      customerEmail: "customerEmail" in command ? command.customerEmail : undefined,
      returnSurface: "returnSurface" in command ? command.returnSurface : undefined,
      billingDetails: "billingDetails" in command ? command.billingDetails : undefined,
      paymentMethod: "paymentMethod" in command ? command.paymentMethod : undefined,
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
