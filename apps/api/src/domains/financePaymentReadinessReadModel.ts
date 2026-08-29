import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_METHODS,
  createFinancePaymentReadinessSnapshot,
  resolveFinanceOnlineCardReadiness,
  type FinanceOnlineCardReadinessEvidence,
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const READINESS_SQL = `SELECT
  settings.property_id::text AS "propertyId",
  settings.payment_readiness_contract_version AS "contractVersion",
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
  online_card.execution_evidence_contract_version AS "executionEvidenceContractVersion",
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
      -- The aggregate setup route is also readable by PMS operators. This
      -- snapshot contains only public-safe progress facts; Finance mutations
      -- remain restricted by their route and command authorization boundary.
      AND resource.relationship IN ('owner', 'operator', 'finance_manager')
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
        onlineCardReadiness: resolveFinanceOnlineCardReadiness(onlineCardEvidence(row)),
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

function onlineCardEvidence(row: PaymentSettingsRow): FinanceOnlineCardReadinessEvidence {
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

function integer(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : -1;
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
