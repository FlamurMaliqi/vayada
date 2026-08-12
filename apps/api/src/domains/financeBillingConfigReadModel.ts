import type { BillingConfigReadModel, BillingConfigReadPort } from "@vayada/domain-finance";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type FinanceBillingQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type BillingConfigRow = QueryResultRow & {
  activePlan: string | null;
  percentageRate: string | number | null;
  ruleMetadata: unknown;
  updatedAt: Date | string;
};

export function createTargetFinanceBillingConfigReadPort(config: {
  connectionString: string;
  max?: number;
  pool?: FinanceBillingQueryExecutor & { end?(): Promise<void> };
}): BillingConfigReadPort & { close?(): Promise<void> } {
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max ?? 3 });

  return {
    async getBillingConfig(propertyId) {
      const result = await pool.query<BillingConfigRow>(
        `SELECT
           COALESCE(entitlement.plan_key, 'commission') AS "activePlan",
           commission.percentage_rate AS "percentageRate",
           commission.rule_metadata AS "ruleMetadata",
           GREATEST(
             COALESCE(entitlement.updated_at, '-infinity'::timestamptz),
             commission.updated_at
           ) AS "updatedAt"
         FROM hotel_catalog.properties property
         LEFT JOIN LATERAL (
           SELECT plan_key, updated_at
           FROM finance.billing_entitlements
           WHERE property_id = property.id
             AND product = 'booking'
             AND entitlement_key = 'direct-booking-finance'
           LIMIT 1
           FOR SHARE
         ) entitlement ON TRUE
         JOIN LATERAL (
           SELECT percentage_rate, rule_metadata, updated_at
           FROM finance.commission_rules
           WHERE property_id = property.id
             AND product = 'booking'
             AND status = 'active'
             AND starts_at <= now()
             AND (ends_at IS NULL OR ends_at > now())
           ORDER BY starts_at DESC, id DESC
           LIMIT 1
           FOR SHARE
         ) commission ON TRUE
         WHERE property.id = $1::uuid`,
        [propertyId],
      );
      return result.rows[0] ? toBillingConfig(propertyId, result.rows[0]) : null;
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

function toBillingConfig(propertyId: string, row: BillingConfigRow): BillingConfigReadModel {
  const metadata = jsonObject(row.ruleMetadata);
  const bookingEngineFeePercent = numberValue(row.percentageRate);
  return {
    propertyId,
    activePlan: row.activePlan === "fixed" ? "fixed" : "commission",
    bookingEngineFeePercent,
    channelManagerFeePercent: numberValue(
      metadata["channelManagerFeePercent"],
      bookingEngineFeePercent,
    ),
    affiliatePlatformFeePercent: numberValue(metadata["affiliatePlatformFeePercent"], 0),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
