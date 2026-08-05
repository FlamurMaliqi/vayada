import {
  PMS_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  type PmsMandatoryChargePricingSourceSnapshot,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

import {
  pmsFlexibleRatePlanSnapshotFromRow,
  pmsPricingCurrencySnapshotFromRow,
  type PmsFlexibleRatePlanRow,
  type PmsPricingCurrencyRow,
} from "./pmsPricingReadModel.js";
import {
  pmsRecurringPricingSnapshotFromRows,
  type PmsNonRefundablePricingRow,
  type PmsRecurringPricingRoomValueRow,
  type PmsRecurringPricingSourceRow,
} from "./pmsRecurringPricingReadModel.js";

export type PmsMandatoryChargePricingSourceQueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type PricingAggregateRow = PmsPricingCurrencyRow & {
  optionalPricingAggregateRevision: number | string;
};

type ActiveRoomRow = {
  propertyId: unknown;
  roomTypeId: unknown;
  roomFactsRevision: unknown;
  occupancyLimits: unknown;
};

/**
 * Loads canonical owner state through one caller-supplied transaction client.
 * The confirmation repository calls this only after the shared pricing guard
 * and then the room-facts property lock have been acquired on that client.
 */
export async function loadPmsMandatoryChargePricingSourceSnapshot(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyIdValue: string,
  capturedAt: Date,
): Promise<PmsMandatoryChargePricingSourceSnapshot | null> {
  const propertyId = readUuid(propertyIdValue);
  if (!validDate(capturedAt)) {
    throw new Error("PMS mandatory-charge pricing source capture time is invalid");
  }
  const aggregate = await queryPricingAggregate(client, propertyId);
  if (!aggregate) return null;
  const pricingCurrency = pmsPricingCurrencySnapshotFromRow(aggregate);
  if (pricingCurrency.propertyId !== propertyId) {
    throw new Error("PMS mandatory-charge pricing currency escaped its property scope");
  }
  const capturedAtIso = capturedAt.toISOString();
  const rooms = await queryActiveRooms(client, propertyId);
  const flexibleRatePlans = await queryFlexiblePlans(client, propertyId);
  const pricing = parsePmsPricingSourceSnapshot({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrency,
    flexibleRatePlans,
    capturedAt: capturedAtIso,
  });
  if (!pricing) throw new Error("PMS mandatory-charge pricing source failed validation");
  const sources = await queryRecurringSources(client, propertyId);
  const recurringPricing = parsePmsRecurringPricingBookingEvidence({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrencyRevision: positiveInteger(aggregate.pricingCurrencyRevision),
    optionalPricingAggregateRevision: nonNegativeInteger(
      aggregate.optionalPricingAggregateRevision,
    ),
    currency: aggregate.currency,
    sources,
    capturedAt: capturedAtIso,
  });
  if (!recurringPricing) {
    throw new Error("PMS mandatory-charge recurring pricing source failed validation");
  }
  return createPmsMandatoryChargePricingSourceSnapshot({ rooms, pricing, recurringPricing });
}

async function queryPricingAggregate(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyId: string,
): Promise<PricingAggregateRow | null> {
  const result = await client.query<PricingAggregateRow>(
    `SELECT settings.property_id::text AS "propertyId",
            settings.currency::text AS currency,
            settings.pricing_currency_revision AS "pricingCurrencyRevision",
            settings.optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision",
            settings.created_at AS "createdAt", settings.updated_at AS "updatedAt"
     FROM pms.property_pricing_settings settings
     WHERE settings.property_id = $1::uuid`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS mandatory-charge pricing row is not unique");
  return result.rows[0] ?? null;
}

async function queryActiveRooms(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyId: string,
) {
  const result = await client.query<ActiveRoomRow>(
    `SELECT room_type.property_id::text AS "propertyId",
            room_type.id::text AS "roomTypeId",
            room_type.room_facts_revision AS "roomFactsRevision",
            room_type.occupancy_limits AS "occupancyLimits"
     FROM pms.room_types room_type
     WHERE room_type.property_id = $1::uuid AND room_type.active IS TRUE
     ORDER BY room_type.id ASC`,
    [propertyId],
  );
  return Object.freeze(result.rows.map((row) => activeRoom(row, propertyId)));
}

async function queryFlexiblePlans(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyId: string,
) {
  const result = await client.query<PmsFlexibleRatePlanRow>(
    `SELECT plan.property_id::text AS "propertyId",
            plan.room_type_id::text AS "roomTypeId",
            plan.id::text AS "flexibleRatePlanId",
            plan.flexible_rate_plan_revision AS "flexibleRatePlanRevision",
            plan.source_room_facts_revision AS "sourceRoomFactsRevision",
            plan.base_rate_amount::text AS "amountDecimal",
            plan.currency::text AS currency,
            plan.cancellation_policy_snapshot AS "cancellationTerms",
            plan.created_at AS "createdAt", plan.updated_at AS "updatedAt"
     FROM pms.rate_plans plan
     WHERE plan.property_id = $1::uuid AND plan.pricing_contract_version = $2
     ORDER BY plan.room_type_id ASC`,
    [propertyId, PMS_PRICING_CONTRACT_VERSION],
  );
  return Object.freeze(
    result.rows.map((row) => {
      const plan = pmsFlexibleRatePlanSnapshotFromRow(row);
      if (plan.propertyId !== propertyId) {
        throw new Error("PMS mandatory-charge flexible plan escaped its property scope");
      }
      return plan;
    }),
  );
}

async function queryRecurringSources(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyId: string,
) {
  const roots = await client.query<PmsRecurringPricingSourceRow>(
    `SELECT source.property_id::text AS "propertyId", source.id::text AS "sourceId",
            source.source_kind AS "sourceKind", source.source_revision AS "sourceRevision",
            source.source_pricing_currency_revision AS "pricingCurrencyRevision",
            source.currency::text AS currency, source.configured_state AS "configuredState",
            source.validation_state AS "validationState",
            source.validation_revision AS "validationRevision",
            source.validated_at AS "validatedAt", source.invalid_reasons AS "invalidReasons",
            source.lifecycle, source.materialization_revision AS "materializationRevision",
            source.season_name AS "seasonName", source.season_start_month AS "seasonStartMonth",
            source.season_start_day AS "seasonStartDay", source.season_end_month AS "seasonEndMonth",
            source.season_end_day AS "seasonEndDay", source.weekend_days AS "weekendDays",
            source.discount_percent AS "discountPercent",
            source.cancellation_terms_type AS "cancellationTermsType",
            source.refund_policy AS "refundPolicy", source.no_show_penalty AS "noShowPenalty",
            source.payment_timing AS "paymentTiming", source.created_at AS "createdAt",
            source.updated_at AS "updatedAt"
     FROM pms.recurring_pricing_sources source
     WHERE source.property_id = $1::uuid
     ORDER BY CASE source.source_kind
       WHEN 'season' THEN 1 WHEN 'weekend_surcharge' THEN 2
       WHEN 'additional_guest' THEN 3 WHEN 'non_refundable' THEN 4 ELSE 99 END,
       source.id ASC`,
    [propertyId],
  );
  const sourceIds = roots.rows.map(({ sourceId }) => sourceId);
  const details = await queryRecurringDetails(client, propertyId, sourceIds);
  return Object.freeze(
    roots.rows.map((root) => {
      const source = pmsRecurringPricingSnapshotFromRows(root, details);
      if (source.propertyId !== propertyId) {
        throw new Error("PMS mandatory-charge recurring source escaped its property scope");
      }
      return source;
    }),
  );
}

async function queryRecurringDetails(
  client: PmsMandatoryChargePricingSourceQueryClient,
  propertyId: string,
  sourceIds: readonly string[],
) {
  if (sourceIds.length === 0) return { roomValues: [], nonRefundable: [] };
  const roomValues = await client.query<PmsRecurringPricingRoomValueRow>(
    `SELECT value.source_id::text AS "sourceId", value.source_kind AS "sourceKind",
            value.room_type_id::text AS "roomTypeId",
            value.source_room_facts_revision AS "roomFactsRevision",
            value.flexible_rate_plan_id::text AS "flexibleRatePlanId",
            value.source_flexible_plan_revision AS "flexibleRatePlanRevision",
            value.seasonal_nightly_amount::text AS "seasonalAmount",
            value.weekend_surcharge_amount::text AS "weekendAmount",
            value.maximum_adult_guests AS "maximumAdultGuests",
            value.included_guest_count AS "includedGuests",
            value.additional_guest_amount::text AS "additionalGuestAmount"
     FROM pms.recurring_pricing_source_room_values value
     WHERE value.property_id = $1::uuid AND value.source_id = ANY($2::uuid[])
     ORDER BY value.source_id ASC, value.room_type_id ASC`,
    [propertyId, sourceIds],
  );
  const nonRefundable = await client.query<PmsNonRefundablePricingRow>(
    `SELECT source.source_id::text AS "sourceId", source.room_type_id::text AS "roomTypeId",
            source.source_room_facts_revision AS "roomFactsRevision",
            source.flexible_rate_plan_id::text AS "flexibleRatePlanId",
            source.source_flexible_plan_revision AS "flexibleRatePlanRevision"
     FROM pms.non_refundable_rate_plan_source_rooms source
     WHERE source.property_id = $1::uuid AND source.source_id = ANY($2::uuid[])
     ORDER BY source.source_id ASC, source.room_type_id ASC`,
    [propertyId, sourceIds],
  );
  return {
    roomValues: Object.freeze(roomValues.rows),
    nonRefundable: Object.freeze(nonRefundable.rows),
  };
}

function activeRoom(row: ActiveRoomRow, propertyId: string) {
  if (row.propertyId !== propertyId || typeof row.roomTypeId !== "string") {
    throw new Error("PMS mandatory-charge active room escaped its property scope");
  }
  const occupancy = dataRecord(row.occupancyLimits);
  const roomFactsRevision = positiveInteger(row.roomFactsRevision);
  const maxGuests = boundedInteger(occupancy?.["total"], 1, 100);
  const maxAdults = boundedInteger(occupancy?.["adults"], 1, 100);
  const maxChildren = boundedInteger(occupancy?.["children"], 0, 100);
  if (!roomFactsRevision || maxGuests === null || maxAdults === null || maxChildren === null) {
    throw new Error("PMS mandatory-charge active room failed contract validation");
  }
  return {
    roomTypeId: readUuid(row.roomTypeId),
    roomFactsRevision,
    occupancy: { maxGuests, maxAdults, maxChildren },
  };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("PMS mandatory-charge pricing source scope is malformed");
  }
  return value.toLowerCase();
}

function positiveInteger(value: unknown): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_647 ? parsed : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function databaseInteger(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
