import {
  parsePmsMandatoryChargeConfirmationReadRequest,
  parsePmsMandatoryChargeConfirmationReadResult,
  type PmsMandatoryChargeConfirmationReadPort,
  type PmsMandatoryChargeConfirmationReadResult,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsMandatoryChargeConfirmationReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export type PmsMandatoryChargeConfirmationReadModel = PmsMandatoryChargeConfirmationReadPort & {
  close(): Promise<void>;
};

type ConfirmationRow = {
  organizationId: unknown;
  propertyId: unknown;
  pricingSourceFingerprint: unknown;
  confirmationRevision: unknown;
  confirmedAt: unknown;
};

const CONFIRMATION_SQL = `SELECT
  confirmation.organization_id::text AS "organizationId",
  confirmation.property_id::text AS "propertyId",
  confirmation.pricing_source_fingerprint AS "pricingSourceFingerprint",
  confirmation.confirmation_revision AS "confirmationRevision",
  confirmation.confirmed_at AS "confirmedAt"
FROM pms.mandatory_charge_confirmation_revisions confirmation
WHERE confirmation.organization_id = $1::uuid
  AND confirmation.property_id = $2::uuid
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
      AND resource.relationship IN ('owner', 'operator')
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
ORDER BY confirmation.confirmation_revision DESC
LIMIT 1
/* pms_mandatory_charge_confirmation_scope */`;

export function createPgPmsMandatoryChargeConfirmationReadModel(config: {
  connectionString: string;
  max?: number;
  pool?: PmsMandatoryChargeConfirmationReadPool;
}): PmsMandatoryChargeConfirmationReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS mandatory-charge confirmation read model connectionString is empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsMandatoryChargeConfirmationReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  let closed = false;

  return {
    async getMandatoryChargeConfirmation(input) {
      const request = parsePmsMandatoryChargeConfirmationReadRequest(input);
      if (!request) throw new Error("PMS mandatory-charge confirmation read scope is malformed");

      try {
        const result = await pool.query<ConfirmationRow>(CONFIRMATION_SQL, [
          request.organizationId,
          request.propertyId,
        ]);
        const row = result.rows[0];
        if (!row) return readResult({ ...request, outcome: "missing" });
        const confirmationRevision = positiveInteger(row.confirmationRevision);
        const confirmedAt = isoDate(row.confirmedAt);
        const available = parsePmsMandatoryChargeConfirmationReadResult({
          ...request,
          outcome: "available",
          evidence: {
            organizationId: row.organizationId,
            propertyId: row.propertyId,
            pricingSourceFingerprint: row.pricingSourceFingerprint,
            confirmationRevision,
            confirmedAt,
          },
        });
        return available ?? readResult({ ...request, outcome: "malformed" });
      } catch {
        return readResult({ ...request, outcome: "unavailable", errorSource: "system" });
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) {
        throw new Error("Owned PMS mandatory-charge confirmation read pool cannot be closed");
      }
      await pool.end();
      closed = true;
    },
  };
}

function readResult(value: unknown): PmsMandatoryChargeConfirmationReadResult {
  const parsed = parsePmsMandatoryChargeConfirmationReadResult(value);
  if (!parsed) throw new Error("PMS mandatory-charge confirmation read result is invalid");
  return parsed;
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
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
