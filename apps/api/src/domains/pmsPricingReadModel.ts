import {
  PMS_PRICING_CONTRACT_VERSION,
  parseFlexibleRatePlanSnapshot,
  parsePmsPricingSourceSnapshot,
  parsePropertyPricingCurrencySnapshot,
  type FlexibleRatePlanSnapshot,
  type PmsPricingReadPort,
  type PropertyPricingCurrencySnapshot,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsPricingReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsPricingReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsPricingReadClient>;
  end?(): Promise<void>;
};

export type PmsPricingReadModel = PmsPricingReadPort & { close(): Promise<void> };

export type PmsPricingCurrencyRow = {
  propertyId: string;
  currency: string;
  pricingCurrencyRevision: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PmsFlexibleRatePlanRow = {
  propertyId: string;
  roomTypeId: string;
  flexibleRatePlanId: string;
  flexibleRatePlanRevision: number | string;
  sourceRoomFactsRevision: number | string;
  amountDecimal: string;
  currency: string;
  cancellationTerms: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type Queryable = Pick<PmsPricingReadClient, "query">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CURRENCY_SELECT = `SELECT
  settings.property_id::text AS "propertyId",
  settings.currency::text AS currency,
  settings.pricing_currency_revision AS "pricingCurrencyRevision",
  settings.created_at AS "createdAt",
  settings.updated_at AS "updatedAt"
FROM pms.property_pricing_settings settings`;

const PLAN_SELECT = `SELECT
  plan.property_id::text AS "propertyId",
  plan.room_type_id::text AS "roomTypeId",
  plan.id::text AS "flexibleRatePlanId",
  plan.flexible_rate_plan_revision AS "flexibleRatePlanRevision",
  plan.source_room_facts_revision AS "sourceRoomFactsRevision",
  plan.base_rate_amount::text AS "amountDecimal",
  plan.currency::text AS currency,
  plan.cancellation_policy_snapshot AS "cancellationTerms",
  plan.created_at AS "createdAt",
  plan.updated_at AS "updatedAt"
FROM pms.rate_plans plan`;

export function createPgPmsPricingReadModel(config: {
  connectionString: string;
  max?: number;
  pool?: PmsPricingReadPool;
  now?: () => Date;
}): PmsPricingReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS pricing read model connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsPricingReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async getPropertyPricingCurrency(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      return queryCurrency(pool, normalizedPropertyId);
    },

    async getFlexibleRatePlan(propertyId, roomTypeId) {
      const scope = roomTypeScope(propertyId, roomTypeId);
      const result = await pool.query<PmsFlexibleRatePlanRow>(
        `${PLAN_SELECT}
         WHERE plan.property_id = $1::uuid
           AND plan.room_type_id = $2::uuid
           AND plan.pricing_contract_version = $3`,
        [scope.propertyId, scope.roomTypeId, PMS_PRICING_CONTRACT_VERSION],
      );
      if (result.rows.length > 1) throw new Error("PMS flexible pricing plan is not unique");
      if (!result.rows[0]) return null;
      const snapshot = pmsFlexibleRatePlanSnapshotFromRow(result.rows[0]);
      assertPlanScope(snapshot, scope);
      return snapshot;
    },

    async listFlexibleRatePlans(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      return queryPlans(pool, normalizedPropertyId);
    },

    async getPricingSourceSnapshot(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const pricingCurrency = await queryCurrency(client, normalizedPropertyId);
        if (!pricingCurrency) {
          await client.query("COMMIT");
          return null;
        }
        const flexibleRatePlans = await queryPlans(client, normalizedPropertyId);
        const captured = now();
        const snapshot = parsePmsPricingSourceSnapshot({
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          propertyId: normalizedPropertyId,
          pricingCurrency,
          flexibleRatePlans,
          capturedAt: validDate(captured) ? captured.toISOString() : null,
        });
        if (!snapshot) throw new Error("PMS pricing source failed contract validation");
        await client.query("COMMIT");
        return snapshot;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS pricing read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

export function pmsPricingCurrencySnapshotFromRow(
  row: PmsPricingCurrencyRow,
): PropertyPricingCurrencySnapshot {
  const parsed = parsePropertyPricingCurrencySnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: row.propertyId,
    currency: row.currency,
    pricingCurrencyRevision: positiveInteger(row.pricingCurrencyRevision),
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  });
  if (!parsed) throw new Error("PMS pricing currency row failed contract validation");
  return parsed;
}

export function pmsFlexibleRatePlanSnapshotFromRow(
  row: PmsFlexibleRatePlanRow,
): FlexibleRatePlanSnapshot {
  const parsed = parseFlexibleRatePlanSnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    flexibleRatePlanId: row.flexibleRatePlanId,
    flexibleRatePlanRevision: positiveInteger(row.flexibleRatePlanRevision),
    sourceRoomFactsRevision: positiveInteger(row.sourceRoomFactsRevision),
    baseAmount: { amountDecimal: row.amountDecimal, currency: row.currency },
    cancellationTerms: row.cancellationTerms,
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  });
  if (!parsed) throw new Error("PMS flexible pricing plan row failed contract validation");
  return parsed;
}

async function queryCurrency(
  queryable: Queryable,
  propertyId: string,
): Promise<PropertyPricingCurrencySnapshot | null> {
  const result = await queryable.query<PmsPricingCurrencyRow>(
    `${CURRENCY_SELECT}
     WHERE settings.property_id = $1::uuid`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS property pricing currency is not unique");
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = pmsPricingCurrencySnapshotFromRow(row);
  if (snapshot.propertyId !== propertyId) {
    throw new Error("PMS pricing currency read escaped its property scope");
  }
  return snapshot;
}

async function queryPlans(
  queryable: Queryable,
  propertyId: string,
): Promise<readonly FlexibleRatePlanSnapshot[]> {
  const result = await queryable.query<PmsFlexibleRatePlanRow>(
    `${PLAN_SELECT}
     WHERE plan.property_id = $1::uuid
       AND plan.pricing_contract_version = $2
     ORDER BY plan.room_type_id ASC`,
    [propertyId, PMS_PRICING_CONTRACT_VERSION],
  );
  return Object.freeze(
    result.rows.map((row) => {
      const snapshot = pmsFlexibleRatePlanSnapshotFromRow(row);
      if (snapshot.propertyId !== propertyId) {
        throw new Error("PMS flexible pricing plan list escaped its property scope");
      }
      return snapshot;
    }),
  );
}

function roomTypeScope(propertyId: string, roomTypeId: string) {
  return Object.freeze({ propertyId: readUuid(propertyId), roomTypeId: readUuid(roomTypeId) });
}

function assertPlanScope(
  snapshot: FlexibleRatePlanSnapshot,
  scope: { propertyId: string; roomTypeId: string },
): void {
  if (snapshot.propertyId !== scope.propertyId || snapshot.roomTypeId !== scope.roomTypeId) {
    throw new Error("PMS flexible pricing plan read escaped its requested scope");
  }
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("PMS pricing read scope is malformed");
  return value.toLowerCase();
}

function positiveInteger(value: number | string): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function databaseInteger(value: number | string): number {
  if (typeof value === "number") return value;
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function isoDate(value: Date | string): string | null {
  return typeof value === "string" ? value : validDate(value) ? value.toISOString() : null;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function rollbackQuietly(client: PmsPricingReadClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original read error.
  }
}
