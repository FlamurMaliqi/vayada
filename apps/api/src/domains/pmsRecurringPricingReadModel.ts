import {
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  parsePmsRecurringPricingBookingEvidence,
  parsePmsRecurringPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingReadPort,
  type PmsRecurringPricingSourceSnapshot,
  type PmsRecurringPricingValidation,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsRecurringPricingReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsRecurringPricingReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsRecurringPricingReadClient>;
  end?(): Promise<void>;
};

export type PmsRecurringPricingReadModel = PmsRecurringPricingReadPort & {
  close(): Promise<void>;
};

export type PmsRecurringPricingSourceRow = {
  propertyId: string;
  sourceId: string;
  sourceKind: string;
  sourceRevision: number | string;
  pricingCurrencyRevision: number | string;
  currency: string;
  configuredState: string;
  validationState: string;
  validationRevision: number | string;
  validatedAt: Date | string;
  invalidReasons: unknown;
  lifecycle: string;
  materializationRevision: number | string;
  seasonName: string | null;
  seasonStartMonth: number | string | null;
  seasonStartDay: number | string | null;
  seasonEndMonth: number | string | null;
  seasonEndDay: number | string | null;
  weekendDays: unknown;
  discountPercent: number | string | null;
  cancellationTermsType: string | null;
  refundPolicy: string | null;
  noShowPenalty: string | null;
  paymentTiming: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PmsRecurringPricingRoomValueRow = {
  sourceId: string;
  sourceKind: string;
  roomTypeId: string;
  roomFactsRevision: number | string;
  flexibleRatePlanId: string;
  flexibleRatePlanRevision: number | string;
  seasonalAmount: string | null;
  weekendAmount: string | null;
  maximumAdultGuests: number | string | null;
  includedGuests: number | string | null;
  additionalGuestAmount: string | null;
};

export type PmsNonRefundablePricingRow = {
  sourceId: string;
  roomTypeId: string;
  roomFactsRevision: number | string;
  flexibleRatePlanId: string;
  flexibleRatePlanRevision: number | string;
};

type CurrencyAggregateRow = {
  currency: string;
  pricingCurrencyRevision: number | string;
  optionalPricingAggregateRevision: number | string;
};

export type PmsRecurringPricingQueryable = Pick<PmsRecurringPricingReadClient, "query">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SOURCE_SELECT = `SELECT
  source.property_id::text AS "propertyId",
  source.id::text AS "sourceId",
  source.source_kind AS "sourceKind",
  source.source_revision AS "sourceRevision",
  source.source_pricing_currency_revision AS "pricingCurrencyRevision",
  source.currency::text AS currency,
  source.configured_state AS "configuredState",
  source.validation_state AS "validationState",
  source.validation_revision AS "validationRevision",
  source.validated_at AS "validatedAt",
  source.invalid_reasons AS "invalidReasons",
  source.lifecycle AS lifecycle,
  source.materialization_revision AS "materializationRevision",
  source.season_name AS "seasonName",
  source.season_start_month AS "seasonStartMonth",
  source.season_start_day AS "seasonStartDay",
  source.season_end_month AS "seasonEndMonth",
  source.season_end_day AS "seasonEndDay",
  source.weekend_days AS "weekendDays",
  source.discount_percent AS "discountPercent",
  source.cancellation_terms_type AS "cancellationTermsType",
  source.refund_policy AS "refundPolicy",
  source.no_show_penalty AS "noShowPenalty",
  source.payment_timing AS "paymentTiming",
  source.created_at AS "createdAt",
  source.updated_at AS "updatedAt"
FROM pms.recurring_pricing_sources source`;

const ROOM_VALUE_SELECT = `SELECT
  value.source_id::text AS "sourceId",
  value.source_kind AS "sourceKind",
  value.room_type_id::text AS "roomTypeId",
  value.source_room_facts_revision AS "roomFactsRevision",
  value.flexible_rate_plan_id::text AS "flexibleRatePlanId",
  value.source_flexible_plan_revision AS "flexibleRatePlanRevision",
  value.seasonal_nightly_amount::text AS "seasonalAmount",
  value.weekend_surcharge_amount::text AS "weekendAmount",
  value.maximum_adult_guests AS "maximumAdultGuests",
  value.included_guest_count AS "includedGuests",
  value.additional_guest_amount::text AS "additionalGuestAmount"
FROM pms.recurring_pricing_source_room_values value`;

const NON_REFUNDABLE_SELECT = `SELECT
  source.source_id::text AS "sourceId",
  source.room_type_id::text AS "roomTypeId",
  source.source_room_facts_revision AS "roomFactsRevision",
  source.flexible_rate_plan_id::text AS "flexibleRatePlanId",
  source.source_flexible_plan_revision AS "flexibleRatePlanRevision"
FROM pms.non_refundable_rate_plan_source_rooms source`;

export function createPgPmsRecurringPricingReadModel(config: {
  connectionString: string;
  max?: number;
  pool?: PmsRecurringPricingReadPool;
  now?: () => Date;
}): PmsRecurringPricingReadModel {
  if (!config.connectionString.trim()) {
    throw new Error("PMS recurring pricing read model connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsRecurringPricingReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async getRecurringPricingSource(propertyId, sourceId) {
      const scope = {
        propertyId: readUuid(propertyId),
        sourceId: readUuid(sourceId),
      };
      const snapshot = await withRepeatableRead(pool, (client) =>
        loadPmsRecurringPricingSource(client, scope.propertyId, scope.sourceId),
      );
      if (!snapshot) return null;
      if (snapshot.propertyId !== scope.propertyId || snapshot.sourceId !== scope.sourceId) {
        throw new Error("PMS recurring pricing source read escaped its requested scope");
      }
      return snapshot;
    },

    async listRecurringPricingSources(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      return withRepeatableRead(pool, (client) => querySources(client, normalizedPropertyId));
    },

    async getRecurringPricingBookingEvidence(propertyId) {
      return withRepeatableRead(pool, (client) =>
        loadPmsRecurringPricingBookingEvidence(client, propertyId, now()),
      );
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS recurring pricing read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

/** Reads pricing evidence through an already-open caller transaction. */
export async function loadPmsRecurringPricingBookingEvidence(
  queryable: PmsRecurringPricingQueryable,
  propertyId: string,
  capturedAt: Date,
): Promise<PmsRecurringPricingBookingEvidence | null> {
  const normalizedPropertyId = readUuid(propertyId);
  const aggregate = await queryCurrencyAggregate(queryable, normalizedPropertyId);
  if (!aggregate) return null;
  const sources = await querySources(queryable, normalizedPropertyId);
  const evidence = parsePmsRecurringPricingBookingEvidence({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId: normalizedPropertyId,
    pricingCurrencyRevision: positiveInteger(aggregate.pricingCurrencyRevision),
    optionalPricingAggregateRevision: nonNegativeInteger(
      aggregate.optionalPricingAggregateRevision,
    ),
    currency: aggregate.currency,
    sources,
    capturedAt: validDate(capturedAt) ? capturedAt.toISOString() : null,
  });
  if (!evidence) throw new Error("PMS recurring pricing Booking evidence is invalid");
  return evidence;
}

export async function loadPmsRecurringPricingSource(
  queryable: Pick<PmsRecurringPricingReadClient, "query">,
  propertyId: string,
  sourceId: string,
): Promise<PmsRecurringPricingSourceSnapshot | null> {
  const roots = await queryable.query<PmsRecurringPricingSourceRow>(
    `${SOURCE_SELECT}
     WHERE source.property_id = $1::uuid AND source.id = $2::uuid`,
    [propertyId, sourceId],
  );
  if (roots.rows.length > 1) throw new Error("PMS recurring pricing source is not unique");
  const root = roots.rows[0];
  if (!root) return null;
  const details = await queryDetails(queryable, propertyId, [sourceId]);
  return pmsRecurringPricingSnapshotFromRows(root, details);
}

export function pmsRecurringPricingSnapshotFromRows(
  root: PmsRecurringPricingSourceRow,
  details: {
    roomValues: readonly PmsRecurringPricingRoomValueRow[];
    nonRefundable: readonly PmsNonRefundablePricingRow[];
  },
): PmsRecurringPricingSourceSnapshot {
  const base = {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId: root.propertyId,
    sourceId: root.sourceId,
    sourceRevision: positiveInteger(root.sourceRevision),
    pricingCurrencyRevision: positiveInteger(root.pricingCurrencyRevision),
    currency: root.currency,
    configuredState: root.configuredState,
    validation: validationFromRow(root),
    lifecycle: root.lifecycle,
    materializationRevision: nonNegativeInteger(root.materializationRevision),
    createdAt: isoDate(root.createdAt),
    updatedAt: isoDate(root.updatedAt),
  };
  const roomValues = details.roomValues.filter(({ sourceId }) => sourceId === root.sourceId);
  const nonRefundable = details.nonRefundable.filter(({ sourceId }) => sourceId === root.sourceId);
  let candidate: unknown;
  switch (root.sourceKind) {
    case "season":
      candidate = {
        ...base,
        sourceKind: "season",
        name: root.seasonName,
        startMonthDay: monthDay(root.seasonStartMonth, root.seasonStartDay),
        endMonthDay: monthDay(root.seasonEndMonth, root.seasonEndDay),
        roomPrices: roomValues.map((row) => ({
          ...roomEvidence(row),
          amountDecimal: row.seasonalAmount,
        })),
      };
      break;
    case "weekend_surcharge":
      candidate = {
        ...base,
        sourceKind: "weekend_surcharge",
        weekdays: root.weekendDays,
        roomSurcharges: roomValues.map((row) => ({
          ...roomEvidence(row),
          amountDecimal: row.weekendAmount,
        })),
      };
      break;
    case "additional_guest": {
      const row = roomValues[0];
      candidate = row
        ? {
            ...base,
            sourceKind: "additional_guest",
            ...roomEvidence(row),
            maximumAdultGuests: databaseInteger(row.maximumAdultGuests),
            includedGuests: databaseInteger(row.includedGuests),
            amountDecimal: row.additionalGuestAmount,
          }
        : null;
      break;
    }
    case "non_refundable": {
      candidate =
        nonRefundable.length > 0
          ? {
              ...base,
              sourceKind: "non_refundable",
              discountPercent: databaseInteger(root.discountPercent),
              roomPlans: nonRefundable.map(roomEvidence),
              paymentTiming: root.paymentTiming,
              cancellationTerms: {
                type: root.cancellationTermsType,
                refundPolicy: root.refundPolicy,
                noShowPenalty: root.noShowPenalty,
              },
            }
          : null;
      break;
    }
    default:
      candidate = null;
  }
  const detailShapeValid =
    (root.sourceKind === "season" && roomValues.length > 0 && nonRefundable.length === 0) ||
    (root.sourceKind === "weekend_surcharge" &&
      roomValues.length > 0 &&
      nonRefundable.length === 0) ||
    (root.sourceKind === "additional_guest" &&
      roomValues.length === 1 &&
      nonRefundable.length === 0) ||
    (root.sourceKind === "non_refundable" && roomValues.length === 0 && nonRefundable.length > 0);
  if (!detailShapeValid) {
    throw new Error("PMS recurring pricing source detail shape is ambiguous");
  }
  const parsed = parsePmsRecurringPricingSourceSnapshot(candidate);
  if (!parsed) throw new Error("PMS recurring pricing source row failed contract validation");
  return parsed;
}

async function querySources(
  queryable: PmsRecurringPricingQueryable,
  propertyId: string,
): Promise<readonly PmsRecurringPricingSourceSnapshot[]> {
  const roots = await queryable.query<PmsRecurringPricingSourceRow>(
    `${SOURCE_SELECT}
     WHERE source.property_id = $1::uuid
     ORDER BY CASE source.source_kind
       WHEN 'season' THEN 1 WHEN 'weekend_surcharge' THEN 2
       WHEN 'additional_guest' THEN 3 WHEN 'non_refundable' THEN 4
       ELSE 99 END, source.id`,
    [propertyId],
  );
  const sourceIds = roots.rows.map(({ sourceId }) => sourceId);
  const details = await queryDetails(queryable, propertyId, sourceIds);
  return Object.freeze(
    roots.rows.map((root) => {
      const snapshot = pmsRecurringPricingSnapshotFromRows(root, details);
      if (snapshot.propertyId !== propertyId) {
        throw new Error("PMS recurring pricing source list escaped its property scope");
      }
      return snapshot;
    }),
  );
}

async function queryDetails(
  queryable: PmsRecurringPricingQueryable,
  propertyId: string,
  sourceIds: readonly string[],
): Promise<{
  roomValues: readonly PmsRecurringPricingRoomValueRow[];
  nonRefundable: readonly PmsNonRefundablePricingRow[];
}> {
  if (sourceIds.length === 0) return { roomValues: [], nonRefundable: [] };
  const roomValues = await queryable.query<PmsRecurringPricingRoomValueRow>(
    `${ROOM_VALUE_SELECT}
     WHERE value.property_id = $1::uuid AND value.source_id = ANY($2::uuid[])
     ORDER BY value.source_id, value.room_type_id`,
    [propertyId, sourceIds],
  );
  const nonRefundable = await queryable.query<PmsNonRefundablePricingRow>(
    `${NON_REFUNDABLE_SELECT}
     WHERE source.property_id = $1::uuid AND source.source_id = ANY($2::uuid[])
     ORDER BY source.source_id, source.room_type_id`,
    [propertyId, sourceIds],
  );
  return {
    roomValues: Object.freeze(roomValues.rows),
    nonRefundable: Object.freeze(nonRefundable.rows),
  };
}

async function queryCurrencyAggregate(
  queryable: PmsRecurringPricingQueryable,
  propertyId: string,
): Promise<CurrencyAggregateRow | null> {
  const result = await queryable.query<CurrencyAggregateRow>(
    `SELECT currency::text AS currency,
            pricing_currency_revision AS "pricingCurrencyRevision",
            optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision"
     FROM pms.property_pricing_settings WHERE property_id = $1::uuid`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS recurring pricing aggregate is not unique");
  return result.rows[0] ?? null;
}

function validationFromRow(
  row: PmsRecurringPricingSourceRow,
): PmsRecurringPricingValidation | null {
  const common = {
    state: row.validationState,
    validationRevision: positiveInteger(row.validationRevision),
    validatedAt: isoDate(row.validatedAt),
  };
  return row.validationState === "valid"
    ? (common as PmsRecurringPricingValidation)
    : ({ ...common, reasons: row.invalidReasons } as PmsRecurringPricingValidation);
}

function roomEvidence(row: PmsRecurringPricingRoomValueRow | PmsNonRefundablePricingRow) {
  return {
    roomTypeId: row.roomTypeId,
    roomFactsRevision: positiveInteger(row.roomFactsRevision),
    flexibleRatePlanId: row.flexibleRatePlanId,
    flexibleRatePlanRevision: positiveInteger(row.flexibleRatePlanRevision),
  };
}

function monthDay(month: number | string | null, day: number | string | null): string | null {
  const parsedMonth = databaseInteger(month);
  const parsedDay = databaseInteger(day);
  return Number.isInteger(parsedMonth) && Number.isInteger(parsedDay)
    ? `${String(parsedMonth).padStart(2, "0")}-${String(parsedDay).padStart(2, "0")}`
    : null;
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("PMS recurring pricing read scope is malformed");
  return value.toLowerCase();
}

function positiveInteger(value: number | string | null): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function nonNegativeInteger(value: number | string | null): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function databaseInteger(value: number | string | null): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function isoDate(value: Date | string): string | null {
  return typeof value === "string" ? value : validDate(value) ? value.toISOString() : null;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function withRepeatableRead<T>(
  pool: PmsRecurringPricingReadPool,
  read: (client: PmsRecurringPricingReadClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await read(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackQuietly(client: PmsRecurringPricingReadClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original read error.
  }
}
