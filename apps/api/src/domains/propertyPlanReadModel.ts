import {
  propertyFeatureLimitsFor,
  type FinanceBillingPlan,
  type PropertyPlanReadModel,
} from "@vayada/domain-finance";
import pg, { type QueryResultRow } from "pg";

export type PropertyPlanQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

type PropertyPlanRow = {
  plan: FinanceBillingPlan;
};

export function activeBookingPlanEntitlementSql(
  alias?: "contact_fixed_plan" | "contact_other_plan",
): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}product = 'booking'
       AND ${prefix}entitlement_key = 'direct-booking-finance'
       AND ${prefix}plan_key IN ('fixed', 'commission')
       AND ${prefix}billing_status IN ('trialing', 'active', 'past_due')
       AND (${prefix}starts_at IS NULL OR ${prefix}starts_at <= now())
       AND (${prefix}expires_at IS NULL OR ${prefix}expires_at > now())`;
}

export type PropertyPlanReadRepository = {
  getPropertyPlan(propertyId: string): Promise<PropertyPlanReadModel>;
  close?(): Promise<void>;
};

export function createPgPropertyPlanReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PropertyPlanQueryable & { end?(): Promise<void> };
}): PropertyPlanReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Property plan read repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PropertyPlanQueryable & { end(): Promise<void> });
  return {
    getPropertyPlan: (propertyId) => readPropertyPlan(pool, propertyId),
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

export async function readPropertyPlan(
  queryable: PropertyPlanQueryable,
  propertyId: string,
): Promise<PropertyPlanReadModel> {
  const result = await queryable.query<PropertyPlanRow>(
    `SELECT plan_key AS plan
     FROM finance.billing_entitlements
     WHERE property_id = $1::uuid
       AND ${activeBookingPlanEntitlementSql()}
     ORDER BY updated_at DESC
     LIMIT 2`,
    [propertyId],
  );
  if (result.rows.length > 1) {
    throw new Error(`Multiple active booking plan entitlements found for property ${propertyId}`);
  }
  const plan = result.rows[0]?.plan ?? "commission";
  return { propertyId, plan, limits: propertyFeatureLimitsFor(plan) };
}
