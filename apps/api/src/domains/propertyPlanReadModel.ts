import {
  propertyFeatureLimitsFor,
  type FinanceBillingPlan,
  type PropertyPlanReadModel,
} from "@vayada/domain-finance";
import type { QueryResultRow } from "pg";

export type PropertyPlanQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

type PropertyPlanRow = {
  plan: FinanceBillingPlan;
};

export async function readPropertyPlan(
  queryable: PropertyPlanQueryable,
  propertyId: string,
): Promise<PropertyPlanReadModel> {
  const result = await queryable.query<PropertyPlanRow>(
    `SELECT plan_key AS plan
     FROM finance.billing_entitlements
     WHERE property_id = $1::uuid
       AND product = 'booking'
       AND entitlement_key = 'direct-booking-finance'
       AND plan_key IN ('fixed', 'commission')
       AND billing_status IN ('trialing', 'active', 'past_due')
       AND (starts_at IS NULL OR starts_at <= now())
       AND (expires_at IS NULL OR expires_at > now())
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
