import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_METHODS,
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessMethod,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  PMS_PRICING_CONTRACT_VERSION,
  parsePropertyPricingCurrencySnapshot,
  type PmsPricingReadPort,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type FinancePaymentReadinessReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export type FinancePaymentReadinessReadModel = FinancePaymentReadinessReadPort & {
  close(): Promise<void>;
};

type PaymentSettingsRow = {
  propertyId: unknown;
  contractVersion: unknown;
  paymentMethodsRevision: unknown;
  sourcePricingCurrencyRevision: unknown;
  currency: unknown;
  acceptedMethods: unknown;
  updatedAt: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const READINESS_SQL = `SELECT
  settings.property_id::text AS "propertyId",
  settings.payment_readiness_contract_version AS "contractVersion",
  settings.payment_methods_revision AS "paymentMethodsRevision",
  settings.source_pricing_currency_revision AS "sourcePricingCurrencyRevision",
  settings.default_currency::text AS currency,
  settings.accepted_methods AS "acceptedMethods",
  settings.updated_at AS "updatedAt"
FROM finance.payment_settings settings
WHERE settings.property_id = $2::uuid
  AND settings.payment_methods_revision IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM identity.organizations organization
    WHERE organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM identity.organization_resource_links resource
    WHERE resource.organization_id = $1::uuid
      AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = $2::uuid::text
      AND resource.relationship IN ('owner', 'finance_manager')
      AND resource.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'active'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM identity.product_entitlements entitlement
    WHERE entitlement.organization_id = $1::uuid
      AND entitlement.product = 'pms'
      AND entitlement.entitlement_key = 'property-management'
      AND entitlement.status = 'suspended'
      AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND (
        entitlement.resource_product IS NULL OR (
          entitlement.resource_product = 'pms'
          AND entitlement.resource_type = 'pms_property'
          AND entitlement.resource_id = $2::uuid::text
        )
      )
  )
/* finance_payment_readiness_scope */`;

export function createPgFinancePaymentReadinessReadModel(config: {
  connectionString: string;
  pricingReadPort: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  max?: number;
  pool?: FinancePaymentReadinessReadPool;
}): FinancePaymentReadinessReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("Finance payment readiness read model connectionString must not be empty");
  }
  if (!config.pricingReadPort) {
    throw new Error("Finance payment readiness read model requires the PMS pricing read port");
  }
  const ownsPool = !config.pool;
  const pool: FinancePaymentReadinessReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  let closed = false;

  return {
    async getPaymentReadiness(request) {
      const organizationId = readUuid(request.organizationId);
      const propertyId = readUuid(request.propertyId);
      const result = await pool.query<PaymentSettingsRow>(READINESS_SQL, [
        organizationId,
        propertyId,
      ]);
      if (result.rows.length > 1) throw new Error("Finance payment readiness row is not unique");
      const row = result.rows[0];
      if (!row) return null;
      const stored = storedConfiguration(row, propertyId);
      const currentValue = await config.pricingReadPort.getPropertyPricingCurrency(propertyId);
      const current =
        currentValue === null ? null : parsePropertyPricingCurrencySnapshot(currentValue);
      if (currentValue !== null && (!current || current.propertyId !== propertyId)) {
        throw new Error("PMS pricing currency read escaped the Finance property scope");
      }
      return createFinancePaymentReadinessSnapshot({
        propertyId,
        paymentMethodsRevision: stored.paymentMethodsRevision,
        selectedMethods: stored.selectedMethods,
        committedPricing: {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          currency: stored.currency,
          pricingCurrencyRevision: stored.sourcePricingCurrencyRevision,
        },
        currentPricing: current
          ? {
              contractVersion: current.contractVersion,
              currency: current.currency,
              pricingCurrencyRevision: current.pricingCurrencyRevision,
            }
          : null,
        updatedAt: stored.updatedAt,
      });
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned Finance payment readiness read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function storedConfiguration(row: PaymentSettingsRow, propertyId: string) {
  const paymentMethodsRevision = positiveInteger(row.paymentMethodsRevision);
  const sourcePricingCurrencyRevision = positiveInteger(row.sourcePricingCurrencyRevision);
  const selectedMethods = methods(row.acceptedMethods);
  const updatedAt = isoDate(row.updatedAt);
  if (
    typeof row.propertyId !== "string" ||
    row.propertyId.toLowerCase() !== propertyId ||
    row.contractVersion !== FINANCE_PAYMENT_READINESS_CONTRACT_VERSION ||
    !paymentMethodsRevision ||
    !sourcePricingCurrencyRevision ||
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !selectedMethods ||
    !updatedAt
  ) {
    throw new Error("Finance payment readiness row failed contract validation");
  }
  return {
    paymentMethodsRevision,
    sourcePricingCurrencyRevision,
    currency: row.currency,
    selectedMethods,
    updatedAt,
  };
}

function methods(value: unknown): readonly FinancePaymentReadinessMethod[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((method) =>
    FINANCE_PAYMENT_READINESS_METHODS.includes(method as FinancePaymentReadinessMethod),
  ) && new Set(value).size === value.length
    ? (value as readonly FinancePaymentReadinessMethod[])
    : null;
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value))
    throw new Error("Finance payment readiness read scope is malformed");
  return value.toLowerCase();
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647 ? parsed : null;
}

function isoDate(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
