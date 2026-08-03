import { createHash, randomUUID } from "node:crypto";

import {
  PMS_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  parsePmsRecurringPricingCommandResult,
  parseRecurringPricingMaterializationReceipt,
  parseRecurringPricingMaterializationResult,
  serializeDisableRecurringPricingSourceFingerprint,
  serializePmsPricingCurrencyDependencyLockKey,
  serializeRecurringPricingMaterializationFingerprint,
  serializeRecurringPricingUpsertFingerprint,
  type DisableRecurringPricingSourceCommand,
  type MaterializeRecurringPricingCommand,
  type PmsRecurringPricingCommandError,
  type PmsRecurringPricingCommandPort,
  type PmsRecurringPricingCommandResult,
  type PmsRecurringPricingInvalidReason,
  type PmsRecurringPricingMaterializedEvent,
  type PmsRecurringPricingSourceChangedEvent,
  type PmsRecurringPricingSourceKind,
  type PmsRecurringPricingSourceSnapshot,
  type RecurringPricingMaterializationResult,
  type RecurringPricingRoomCommandEvidence,
  type UpsertAdditionalGuestPricingCommand,
  type UpsertNonRefundablePricingCommand,
  type UpsertRecurringPricingSourceCommand,
  type UpsertRecurringSeasonCommand,
  type UpsertWeekendSurchargeCommand,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  loadPmsRecurringPricingSource,
  type PmsRecurringPricingSourceRow,
} from "./pmsRecurringPricingReadModel.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

export type PmsRecurringPricingCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsRecurringPricingCommandPool = {
  connect(): Promise<PmsRecurringPricingCommandClient>;
  end(): Promise<void>;
};

export type PmsRecurringPricingCommandRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: PmsRecurringPricingCommandPool;
  now?: () => Date;
  randomId?: () => string;
};

export type PmsRecurringPricingCommandRepository = PmsRecurringPricingCommandPort & {
  close(): Promise<void>;
};

type SourceCommand = UpsertRecurringPricingSourceCommand | DisableRecurringPricingSourceCommand;
type AnyCommand = SourceCommand | MaterializeRecurringPricingCommand;
type AnyResult = PmsRecurringPricingCommandResult | RecurringPricingMaterializationResult;
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};
type IdempotencyReservation = { id: string; attempt: number };
type CurrencyRow = {
  currency: string;
  pricingCurrencyRevision: number | string;
  optionalPricingAggregateRevision: number | string;
};
type LockedSourceRow = PmsRecurringPricingSourceRow;
type RoomRow = {
  roomTypeId: string;
  roomFactsRevision: number | string;
  maximumAdultGuests: number | string | null;
};
type PlanRow = {
  flexibleRatePlanId: string;
  roomTypeId: string;
  flexibleRatePlanRevision: number | string;
};
type ExistingSeasonRow = {
  sourceId: string;
  name: string;
  startMonth: number | string;
  startDay: number | string;
  endMonth: number | string;
  endDay: number | string;
};
type MaterializedRow = {
  sourceId: string;
  sourceKind: Exclude<PmsRecurringPricingSourceKind, "non_refundable">;
  roomTypeId: string;
  stayDate: string;
  seasonalAmount: string | null;
  weekendAmount: string | null;
  maximumAdultGuests: number | null;
  includedGuests: number | null;
  additionalGuestAmount: string | null;
};

type CommandSpec<C extends AnyCommand, R extends AnyResult> = {
  operation: string;
  fingerprint(command: C): string;
  parse(value: unknown): R | null;
  scopeFailure(): R;
  coordinationFailure(code: "idempotency_key_conflict" | "command_in_progress"): R;
};

type SourceChange = {
  kind: "source";
  event: PmsRecurringPricingSourceChangedEvent;
  sourceId: string;
};
type MaterializedChange = {
  kind: "materialized";
  event: PmsRecurringPricingMaterializedEvent;
  receiptId: string;
};
type AcceptedChange = SourceChange | MaterializedChange;
type WorkResult<R extends AnyResult> = { result: R; change?: AcceptedChange };

const MANAGE_PERMISSION = "pms.operations.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KIND_ORDER = [
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const;
const EMPTY_ROWS_SHA256 = sha256("[]");

const SOURCE_OPERATIONS = {
  season: "pms.recurring_pricing.season.upsert",
  weekend_surcharge: "pms.recurring_pricing.weekend_surcharge.upsert",
  additional_guest: "pms.recurring_pricing.additional_guest.upsert",
  non_refundable: "pms.recurring_pricing.non_refundable.upsert",
} as const;
const DISABLE_OPERATION = "pms.recurring_pricing.source.disable";
const MATERIALIZE_OPERATION = "pms.recurring_pricing.materialize";

function sourceSpec<C extends UpsertRecurringPricingSourceCommand>(
  operation: string,
): CommandSpec<C, PmsRecurringPricingCommandResult> {
  return {
    operation,
    fingerprint: serializeRecurringPricingUpsertFingerprint,
    parse: parsePmsRecurringPricingCommandResult,
    scopeFailure: () => sourceFailure({ code: "setup_scope_unavailable" }),
    coordinationFailure: (code) => sourceFailure({ code }),
  };
}

const DISABLE_SPEC: CommandSpec<
  DisableRecurringPricingSourceCommand,
  PmsRecurringPricingCommandResult
> = {
  operation: DISABLE_OPERATION,
  fingerprint: serializeDisableRecurringPricingSourceFingerprint,
  parse: parsePmsRecurringPricingCommandResult,
  scopeFailure: () => sourceFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => sourceFailure({ code }),
};

const MATERIALIZE_SPEC: CommandSpec<
  MaterializeRecurringPricingCommand,
  RecurringPricingMaterializationResult
> = {
  operation: MATERIALIZE_OPERATION,
  fingerprint: serializeRecurringPricingMaterializationFingerprint,
  parse: parseRecurringPricingMaterializationResult,
  scopeFailure: () => materializationFailure({ code: "setup_scope_unavailable" }),
  coordinationFailure: (code) => materializationFailure({ code }),
};

export function createPgPmsRecurringPricingCommandRepository(
  config: PmsRecurringPricingCommandRepositoryConfig,
): PmsRecurringPricingCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS recurring pricing command repository connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PmsRecurringPricingCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  const makeId = config.randomId ?? randomUUID;
  let closed = false;

  async function run<C extends AnyCommand, R extends AnyResult>(
    command: C,
    spec: CommandSpec<C, R>,
    work: (client: PmsRecurringPricingCommandClient, acceptedAt: Date) => Promise<WorkResult<R>>,
  ): Promise<R> {
    const acceptedAt = now();
    if (!validDate(acceptedAt)) throw new Error("PMS recurring pricing command clock is invalid");
    const keyHash = sha256(command.idempotencyKey);
    const fingerprint = sha256(spec.fingerprint(command));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockPropertyPricingScope(client, command.propertyId);
      await lockCommandSources(client, command);
      if (!(await lockAuthorizedScope(client, command, acceptedAt))) {
        await rollbackQuietly(client);
        return spec.scopeFailure();
      }
      const replay = await findReplay(client, command, spec, keyHash, fingerprint, acceptedAt);
      if (replay) {
        await rollbackQuietly(client);
        return replay;
      }
      const reservation = await reserveIdempotency(
        client,
        command,
        spec.operation,
        keyHash,
        fingerprint,
        acceptedAt,
      );
      if (!reservation) {
        const concurrent = await findReplay(
          client,
          command,
          spec,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        await rollbackQuietly(client);
        return concurrent ?? spec.coordinationFailure("command_in_progress");
      }
      const worked = await work(client, acceptedAt);
      const result = spec.parse(worked.result);
      if (!result) throw new Error("PMS recurring pricing command returned invalid contract data");
      if (result.ok !== Boolean(worked.change)) {
        throw new Error("PMS recurring pricing change notification invariant failed");
      }
      const eventId = worked.change
        ? await enqueueChange(
            client,
            command,
            spec.operation,
            reservation,
            keyHash,
            worked.change,
            acceptedAt,
          )
        : null;
      await recordAudit(
        client,
        command,
        spec.operation,
        reservation,
        keyHash,
        result,
        eventId,
        acceptedAt,
      );
      await completeIdempotency(client, reservation.id, result, acceptedAt);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async function runUpsert<C extends UpsertRecurringPricingSourceCommand>(
    command: C,
  ): Promise<PmsRecurringPricingCommandResult> {
    const spec = sourceSpec<C>(SOURCE_OPERATIONS[command.sourceKind]);
    return run(command, spec, (client, acceptedAt) => upsertSource(client, command, acceptedAt));
  }

  return {
    upsertRecurringSeason: (command) => runUpsert(command),
    upsertWeekendSurcharge: (command) => runUpsert(command),
    upsertAdditionalGuestPricing: (command) => runUpsert(command),
    upsertNonRefundablePricing: (command) => runUpsert(command),
    disableRecurringPricingSource: (command) =>
      run(command, DISABLE_SPEC, (client, acceptedAt) =>
        disableSource(client, command, acceptedAt),
      ),
    materializeRecurringPricing: (command) =>
      run(command, MATERIALIZE_SPEC, (client, acceptedAt) =>
        materializeSources(client, command, acceptedAt, makeId),
      ),
    async close() {
      if (!ownsPool || closed) return;
      await pool.end();
      closed = true;
    },
  };
}

async function upsertSource(
  client: PmsRecurringPricingCommandClient,
  command: UpsertRecurringPricingSourceCommand,
  at: Date,
): Promise<WorkResult<PmsRecurringPricingCommandResult>> {
  await lockPmsRoomFactsMutationScope(client, command.propertyId);
  const currency = await lockCurrency(client, command.propertyId);
  if (!currency) return { result: sourceFailure({ code: "pricing_currency_not_configured" }) };
  const pricingRevision = positiveInteger(currency.pricingCurrencyRevision);
  if (pricingRevision !== command.expectedPricingCurrencyRevision) {
    return {
      result: sourceFailure({
        code: "pricing_currency_revision_conflict",
        currentRevision: pricingRevision,
      }),
    };
  }
  const existing = await lockSourceById(client, command.sourceId);
  if (existing && existing.propertyId.toLowerCase() !== command.propertyId) {
    return { result: sourceFailure({ code: "source_not_found" }) };
  }
  if (existing && existing.sourceKind !== command.sourceKind) {
    return { result: sourceFailure({ code: "source_kind_conflict" }) };
  }
  if (!existing && command.expectedSourceRevision !== 0) {
    return { result: sourceFailure({ code: "source_not_found" }) };
  }
  if (existing && positiveInteger(existing.sourceRevision) !== command.expectedSourceRevision) {
    return {
      result: sourceFailure({
        code: "source_revision_conflict",
        currentRevision: positiveInteger(existing.sourceRevision),
      }),
    };
  }
  const dependencyError = await validateCommandDependencies(client, command);
  if (dependencyError) return { result: sourceFailure(dependencyError) };
  const uniquenessError = await validateSourceUniqueness(client, command);
  if (uniquenessError) return { result: sourceFailure(uniquenessError) };

  if (existing) {
    await deleteReplaceableMaterializedRows(client, command.propertyId, command.sourceId);
  }

  const sourceRevision = existing ? positiveInteger(existing.sourceRevision) + 1 : 1;
  const validationRevision = existing ? positiveInteger(existing.validationRevision) + 1 : 1;
  if (existing) {
    const updated = await client.query(
      `UPDATE pms.recurring_pricing_sources
       SET source_revision = $4,
           configured_state = 'active', validation_state = 'valid',
           validation_revision = $5, validated_at = $6::timestamptz,
           invalid_reasons = '[]'::jsonb, currency = $7,
           source_pricing_currency_revision = $8,
           season_name = $9, season_start_month = $10, season_start_day = $11,
           season_end_month = $12, season_end_day = $13, weekend_days = $14::text[],
           discount_percent = $15, cancellation_terms_type = $16,
           refund_policy = $17, no_show_penalty = $18, payment_timing = $19,
           updated_at = $6::timestamptz
       WHERE id = $1::uuid AND property_id = $2::uuid AND source_kind = $3
         AND source_revision = $20`,
      [
        command.sourceId,
        command.propertyId,
        command.sourceKind,
        sourceRevision,
        validationRevision,
        at.toISOString(),
        currency.currency,
        pricingRevision,
        command.sourceKind === "season" ? command.name : null,
        command.sourceKind === "season" ? Number(command.startMonthDay.slice(0, 2)) : null,
        command.sourceKind === "season" ? Number(command.startMonthDay.slice(3, 5)) : null,
        command.sourceKind === "season" ? Number(command.endMonthDay.slice(0, 2)) : null,
        command.sourceKind === "season" ? Number(command.endMonthDay.slice(3, 5)) : null,
        command.sourceKind === "weekend_surcharge" ? command.weekdays : null,
        command.sourceKind === "non_refundable" ? command.discountPercent : null,
        command.sourceKind === "non_refundable" ? "non_refundable" : null,
        command.sourceKind === "non_refundable" ? "no_refund" : null,
        command.sourceKind === "non_refundable" ? "full_booking_amount" : null,
        command.sourceKind === "non_refundable" ? "prepay_full" : null,
        command.expectedSourceRevision,
      ],
    );
    if (updated.rowCount !== 1) throw new Error("PMS recurring pricing source CAS failed");
  } else {
    await client.query(
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         materialization_revision, currency, source_pricing_currency_revision,
         season_name, season_start_month, season_start_day, season_end_month,
         season_end_day, weekend_days, discount_percent, cancellation_terms_type,
         refund_policy, no_show_penalty, payment_timing, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 1, 'active', 'valid', 1, $4::timestamptz,
         '[]'::jsonb, 0, $5, $6, $7, $8, $9, $10, $11, $12::text[],
         $13, $14, $15, $16, $17,
         $4::timestamptz, $4::timestamptz
       )`,
      [
        command.sourceId,
        command.propertyId,
        command.sourceKind,
        at.toISOString(),
        currency.currency,
        pricingRevision,
        command.sourceKind === "season" ? command.name : null,
        command.sourceKind === "season" ? Number(command.startMonthDay.slice(0, 2)) : null,
        command.sourceKind === "season" ? Number(command.startMonthDay.slice(3, 5)) : null,
        command.sourceKind === "season" ? Number(command.endMonthDay.slice(0, 2)) : null,
        command.sourceKind === "season" ? Number(command.endMonthDay.slice(3, 5)) : null,
        command.sourceKind === "weekend_surcharge" ? command.weekdays : null,
        command.sourceKind === "non_refundable" ? command.discountPercent : null,
        command.sourceKind === "non_refundable" ? "non_refundable" : null,
        command.sourceKind === "non_refundable" ? "no_refund" : null,
        command.sourceKind === "non_refundable" ? "full_booking_amount" : null,
        command.sourceKind === "non_refundable" ? "prepay_full" : null,
      ],
    );
  }
  await replaceSourceDetails(client, command, currency.currency, pricingRevision);
  const aggregateRevision = await advanceAggregate(
    client,
    command.propertyId,
    nonNegativeInteger(currency.optionalPricingAggregateRevision),
  );
  const source = await loadPmsRecurringPricingSource(client, command.propertyId, command.sourceId);
  if (!source) throw new Error("PMS recurring pricing accepted source disappeared");
  const outcome = !existing
    ? "created"
    : existing.configuredState === "disabled"
      ? "re_enabled"
      : "updated";
  const result = parsePmsRecurringPricingCommandResult({
    ok: true,
    response: {
      contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      outcome,
      source,
      optionalPricingAggregateRevision: aggregateRevision,
      acceptedAt: at.toISOString(),
    },
  });
  if (!result) throw new Error("PMS recurring pricing upsert response is invalid");
  return {
    result,
    change: {
      kind: "source",
      sourceId: command.sourceId,
      event: {
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        eventType: "pms.recurring_pricing_source.changed",
        propertyId: command.propertyId,
        sourceKind: command.sourceKind,
        sourceId: command.sourceId,
        sourceRevision,
        optionalPricingAggregateRevision: aggregateRevision,
        lifecycle: "active",
        outcome,
      },
    },
  };
}

async function disableSource(
  client: PmsRecurringPricingCommandClient,
  command: DisableRecurringPricingSourceCommand,
  at: Date,
): Promise<WorkResult<PmsRecurringPricingCommandResult>> {
  const currency = await lockCurrency(client, command.propertyId);
  if (!currency) return { result: sourceFailure({ code: "pricing_currency_not_configured" }) };
  const source = await lockSourceById(client, command.sourceId);
  if (!source || source.propertyId.toLowerCase() !== command.propertyId) {
    return { result: sourceFailure({ code: "source_not_found" }) };
  }
  if (source.sourceKind !== command.sourceKind) {
    return { result: sourceFailure({ code: "source_kind_conflict" }) };
  }
  const currentRevision = positiveInteger(source.sourceRevision);
  if (currentRevision !== command.expectedSourceRevision) {
    return {
      result: sourceFailure({ code: "source_revision_conflict", currentRevision }),
    };
  }
  await deleteReplaceableMaterializedRows(client, command.propertyId, command.sourceId);
  const sourceRevision = currentRevision + 1;
  const updated = await client.query(
    `UPDATE pms.recurring_pricing_sources
     SET source_revision = $4, configured_state = 'disabled', updated_at = $5::timestamptz
     WHERE id = $1::uuid AND property_id = $2::uuid AND source_kind = $3
       AND source_revision = $6`,
    [
      command.sourceId,
      command.propertyId,
      command.sourceKind,
      sourceRevision,
      at.toISOString(),
      command.expectedSourceRevision,
    ],
  );
  if (updated.rowCount !== 1) throw new Error("PMS recurring pricing disable CAS failed");
  const aggregateRevision = await advanceAggregate(
    client,
    command.propertyId,
    nonNegativeInteger(currency.optionalPricingAggregateRevision),
  );
  const snapshot = await loadPmsRecurringPricingSource(
    client,
    command.propertyId,
    command.sourceId,
  );
  if (!snapshot) throw new Error("PMS recurring pricing disabled source disappeared");
  const result = parsePmsRecurringPricingCommandResult({
    ok: true,
    response: {
      contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      outcome: "disabled",
      source: snapshot,
      optionalPricingAggregateRevision: aggregateRevision,
      acceptedAt: at.toISOString(),
    },
  });
  if (!result) throw new Error("PMS recurring pricing disable response is invalid");
  return {
    result,
    change: {
      kind: "source",
      sourceId: command.sourceId,
      event: {
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        eventType: "pms.recurring_pricing_source.changed",
        propertyId: command.propertyId,
        sourceKind: command.sourceKind,
        sourceId: command.sourceId,
        sourceRevision,
        optionalPricingAggregateRevision: aggregateRevision,
        lifecycle: "disabled",
        outcome: "disabled",
      },
    },
  };
}

async function validateCommandDependencies(
  client: PmsRecurringPricingCommandClient,
  command: UpsertRecurringPricingSourceCommand,
): Promise<PmsRecurringPricingCommandError | null> {
  const bindings = sourceBindings(command);
  const rooms = await client.query<RoomRow>(
    `SELECT id::text AS "roomTypeId", room_facts_revision AS "roomFactsRevision",
            occupancy_limits->>'adults' AS "maximumAdultGuests"
     FROM pms.room_types
     WHERE property_id = $1::uuid AND active
     ORDER BY id FOR UPDATE`,
    [command.propertyId],
  );
  const roomById = new Map(rooms.rows.map((row) => [row.roomTypeId.toLowerCase(), row]));
  const plans = await client.query<PlanRow>(
    `SELECT id::text AS "flexibleRatePlanId", room_type_id::text AS "roomTypeId",
            flexible_rate_plan_revision AS "flexibleRatePlanRevision"
     FROM pms.rate_plans
     WHERE property_id = $1::uuid
       AND pricing_contract_version = $2 AND active
     ORDER BY id FOR UPDATE`,
    [command.propertyId, PMS_PRICING_CONTRACT_VERSION],
  );
  const planById = new Map(plans.rows.map((row) => [row.flexibleRatePlanId.toLowerCase(), row]));
  if (command.sourceKind !== "additional_guest") {
    const suppliedRoomTypeIds = new Set(bindings.map(({ roomTypeId }) => roomTypeId));
    const missingRoomTypeIds = [...roomById.keys()]
      .filter((roomTypeId) => !suppliedRoomTypeIds.has(roomTypeId))
      .sort();
    if (missingRoomTypeIds.length > 0) {
      return {
        code: "recurring_pricing_room_plan_set_incomplete",
        sourceKind: command.sourceKind,
        missingRoomTypeIds,
      };
    }
  }
  for (const binding of bindings) {
    const room = roomById.get(binding.roomTypeId);
    if (!room) return { code: "room_type_not_found", roomTypeId: binding.roomTypeId };
    const roomRevision = positiveInteger(room.roomFactsRevision);
    if (roomRevision !== binding.expectedRoomFactsRevision) {
      return {
        code: "room_facts_revision_conflict",
        roomTypeId: binding.roomTypeId,
        currentRevision: roomRevision,
      };
    }
    const plan = planById.get(binding.flexibleRatePlanId);
    if (!plan || plan.roomTypeId.toLowerCase() !== binding.roomTypeId) {
      return { code: "flexible_rate_plan_not_found", roomTypeId: binding.roomTypeId };
    }
    const planRevision = positiveInteger(plan.flexibleRatePlanRevision);
    if (planRevision !== binding.expectedFlexibleRatePlanRevision) {
      return {
        code: "flexible_rate_plan_revision_conflict",
        roomTypeId: binding.roomTypeId,
        currentRevision: planRevision,
      };
    }
    if (command.sourceKind === "additional_guest") {
      const persistedMaximumAdultGuests = databaseInteger(room.maximumAdultGuests);
      const maximumAdultGuests =
        Number.isSafeInteger(persistedMaximumAdultGuests) && persistedMaximumAdultGuests >= 2
          ? persistedMaximumAdultGuests
          : 0;
      if (maximumAdultGuests < 2 || command.includedGuests >= maximumAdultGuests) {
        return {
          code: "additional_guest_capacity_inapplicable",
          roomTypeId: command.roomTypeId,
          maximumAdultGuests,
        };
      }
    }
  }
  return null;
}

async function validateSourceUniqueness(
  client: PmsRecurringPricingCommandClient,
  command: UpsertRecurringPricingSourceCommand,
): Promise<PmsRecurringPricingCommandError | null> {
  if (command.sourceKind === "season") {
    const sameName = await client.query<{ sourceId: string }>(
      `SELECT id::text AS "sourceId" FROM pms.recurring_pricing_sources
       WHERE property_id = $1::uuid AND source_kind = 'season'
         AND lower(season_name) = lower($2) AND id <> $3::uuid
       ORDER BY id LIMIT 1 FOR UPDATE`,
      [command.propertyId, command.name, command.sourceId],
    );
    if (sameName.rows[0]) {
      return {
        code: "season_name_conflict",
        conflictingSourceId: sameName.rows[0].sourceId.toLowerCase(),
      };
    }
    const seasons = await client.query<ExistingSeasonRow>(
      `SELECT id::text AS "sourceId", season_name AS name,
              season_start_month AS "startMonth", season_start_day AS "startDay",
              season_end_month AS "endMonth", season_end_day AS "endDay"
       FROM pms.recurring_pricing_sources
       WHERE property_id = $1::uuid AND source_kind = 'season'
         AND configured_state = 'active' AND id <> $2::uuid
       ORDER BY id FOR UPDATE`,
      [command.propertyId, command.sourceId],
    );
    const conflicts = seasons.rows
      .filter((season) =>
        annualRangesOverlap(
          command.startMonthDay,
          command.endMonthDay,
          monthDay(season.startMonth, season.startDay),
          monthDay(season.endMonth, season.endDay),
        ),
      )
      .map(({ sourceId }) => sourceId.toLowerCase())
      .sort();
    return conflicts.length > 0
      ? { code: "season_overlap", conflictingSourceIds: conflicts }
      : null;
  }
  if (command.sourceKind === "weekend_surcharge" || command.sourceKind === "non_refundable") {
    const duplicate = await client.query(
      `SELECT id FROM pms.recurring_pricing_sources
       WHERE property_id = $1::uuid AND source_kind = $3
         AND id <> $2::uuid FOR UPDATE`,
      [command.propertyId, command.sourceId, command.sourceKind],
    );
    return duplicate.rows[0] ? { code: "source_kind_conflict" } : null;
  }
  const duplicate = await client.query(
    `SELECT source_id FROM pms.recurring_pricing_source_room_values
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND source_id <> $3::uuid
       AND source_kind = 'additional_guest'
     FOR UPDATE`,
    [command.propertyId, command.roomTypeId, command.sourceId],
  );
  return duplicate.rows[0] ? { code: "source_kind_conflict" } : null;
}

async function replaceSourceDetails(
  client: PmsRecurringPricingCommandClient,
  command: UpsertRecurringPricingSourceCommand,
  currency: string,
  pricingRevision: number,
): Promise<void> {
  await client.query(
    `DELETE FROM pms.recurring_pricing_source_room_values WHERE source_id = $1::uuid`,
    [command.sourceId],
  );
  await client.query(
    `DELETE FROM pms.non_refundable_rate_plan_source_rooms WHERE source_id = $1::uuid`,
    [command.sourceId],
  );
  if (command.sourceKind === "non_refundable") {
    for (const roomPlan of command.roomPlans) {
      await client.query(
        `INSERT INTO pms.non_refundable_rate_plan_source_rooms (
           source_id, property_id, source_kind, room_type_id, flexible_rate_plan_id,
           flexible_pricing_contract_version, source_flexible_plan_revision,
           source_room_facts_revision, currency, source_pricing_currency_revision
         ) VALUES (
           $1::uuid, $2::uuid, 'non_refundable', $3::uuid, $4::uuid, $5, $6, $7,
           $8, $9
         )`,
        [
          command.sourceId,
          command.propertyId,
          roomPlan.roomTypeId,
          roomPlan.flexibleRatePlanId,
          PMS_PRICING_CONTRACT_VERSION,
          roomPlan.expectedFlexibleRatePlanRevision,
          roomPlan.expectedRoomFactsRevision,
          currency,
          pricingRevision,
        ],
      );
    }
    return;
  }
  const values =
    command.sourceKind === "season"
      ? command.roomPrices.map((row) => ({ ...row, seasonalAmount: row.amountDecimal }))
      : command.sourceKind === "weekend_surcharge"
        ? command.roomSurcharges.map((row) => ({ ...row, weekendAmount: row.amountDecimal }))
        : [
            {
              ...command,
              maximumAdultGuests: null as number | null,
              additionalGuestAmount: command.amountDecimal,
            },
          ];
  for (const value of values) {
    let maximumAdultGuests: number | null = null;
    if (command.sourceKind === "additional_guest") {
      const room = await client.query<{ maximumAdultGuests: number | string }>(
        `SELECT (occupancy_limits->>'adults')::integer AS "maximumAdultGuests"
         FROM pms.room_types WHERE property_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [command.propertyId, value.roomTypeId],
      );
      maximumAdultGuests = positiveInteger(room.rows[0]?.maximumAdultGuests ?? null);
    }
    await client.query(
      `INSERT INTO pms.recurring_pricing_source_room_values (
         source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
         flexible_rate_plan_id, flexible_pricing_contract_version,
         source_flexible_plan_revision, currency, source_pricing_currency_revision,
         seasonal_nightly_amount, weekend_surcharge_amount, maximum_adult_guests,
         included_guest_count, additional_guest_amount
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7, $8, $9, $10,
         $11::numeric(15,2), $12::numeric(15,2), $13, $14, $15::numeric(15,2)
       )`,
      [
        command.sourceId,
        command.propertyId,
        command.sourceKind,
        value.roomTypeId,
        value.expectedRoomFactsRevision,
        value.flexibleRatePlanId,
        PMS_PRICING_CONTRACT_VERSION,
        value.expectedFlexibleRatePlanRevision,
        currency,
        pricingRevision,
        "seasonalAmount" in value ? value.seasonalAmount : null,
        "weekendAmount" in value ? value.weekendAmount : null,
        maximumAdultGuests,
        command.sourceKind === "additional_guest" ? command.includedGuests : null,
        "additionalGuestAmount" in value ? value.additionalGuestAmount : null,
      ],
    );
  }
}

async function deleteReplaceableMaterializedRows(
  client: PmsRecurringPricingCommandClient,
  propertyId: string,
  sourceId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM pms.recurring_pricing_materialized_rows
     WHERE property_id = $1::uuid AND source_id = $2::uuid`,
    [propertyId, sourceId],
  );
}

async function materializeSources(
  client: PmsRecurringPricingCommandClient,
  command: MaterializeRecurringPricingCommand,
  at: Date,
  makeId: () => string,
): Promise<WorkResult<RecurringPricingMaterializationResult>> {
  await lockPmsRoomFactsMutationScope(client, command.propertyId);
  const currency = await lockCurrency(client, command.propertyId);
  if (!currency)
    return { result: materializationFailure({ code: "pricing_currency_not_configured" }) };
  const aggregateRevision = nonNegativeInteger(currency.optionalPricingAggregateRevision);
  if (aggregateRevision !== command.expectedOptionalPricingAggregateRevision) {
    return {
      result: materializationFailure({
        code: "optional_pricing_aggregate_revision_conflict",
        currentRevision: aggregateRevision,
      }),
    };
  }
  const receiptId = normalizedGeneratedId(makeId(), "materialization receipt");
  const snapshots: PmsRecurringPricingSourceSnapshot[] = [];
  const lockedSources = await lockAllPropertySources(client, command.propertyId);
  for (const source of lockedSources) {
    const snapshot = await revalidateSource(client, source, currency, at);
    snapshots.push(snapshot);
  }
  await client.query(
    `INSERT INTO pms.recurring_pricing_materialization_receipts
       (id, property_id, horizon_start, horizon_end,
        optional_pricing_aggregate_revision, accepted_at)
     VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5, $6::timestamptz)`,
    [
      receiptId,
      command.propertyId,
      command.fromDate,
      command.throughDate,
      aggregateRevision,
      at.toISOString(),
    ],
  );
  const sourceReceipts = [];
  for (const snapshot of snapshots) {
    const materializationRevision = snapshot.materializationRevision + 1;
    const rows = snapshot.lifecycle === "active" ? deriveRows(snapshot, command) : [];
    const rowsHash = rows.length === 0 ? EMPTY_ROWS_SHA256 : sha256(stableJson(rows));
    const result =
      snapshot.lifecycle === "active"
        ? "materialized"
        : snapshot.lifecycle === "disabled"
          ? "skipped_disabled"
          : "skipped_invalid";
    const updated = await client.query(
      `UPDATE pms.recurring_pricing_sources
       SET materialization_revision = $3, updated_at = $4::timestamptz
       WHERE id = $1::uuid AND property_id = $2::uuid
         AND source_revision = $5 AND materialization_revision = $6`,
      [
        snapshot.sourceId,
        command.propertyId,
        materializationRevision,
        at.toISOString(),
        snapshot.sourceRevision,
        snapshot.materializationRevision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("PMS recurring pricing materialization CAS failed");
    }
    if (snapshot.lifecycle === "active") {
      await client.query(
        `DELETE FROM pms.recurring_pricing_materialized_rows
         WHERE property_id = $1::uuid AND source_id = $2::uuid
           AND stay_date BETWEEN $3::date AND $4::date`,
        [command.propertyId, snapshot.sourceId, command.fromDate, command.throughDate],
      );
    } else {
      await deleteReplaceableMaterializedRows(client, command.propertyId, snapshot.sourceId);
    }
    await client.query(
      `INSERT INTO pms.recurring_pricing_materialization_source_receipts (
       receipt_id, property_id, horizon_start, horizon_end, source_id, source_kind,
         optional_pricing_aggregate_revision,
         source_revision, configured_state, validation_state, validation_revision,
         validated_at, invalid_reasons, source_lifecycle, materialization_revision,
         currency, source_pricing_currency_revision, result, materialized_row_count,
         materialized_rows_sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::date, $4::date, $5::uuid, $6, $7, $8, $9, $10,
         $11, $12::timestamptz, $13::jsonb, $14, $15, $16, $17, $18, $19, $20
       )`,
      [
        receiptId,
        command.propertyId,
        command.fromDate,
        command.throughDate,
        snapshot.sourceId,
        snapshot.sourceKind,
        aggregateRevision,
        snapshot.sourceRevision,
        snapshot.configuredState,
        snapshot.validation.state,
        snapshot.validation.validationRevision,
        snapshot.validation.validatedAt,
        JSON.stringify(snapshot.validation.state === "invalid" ? snapshot.validation.reasons : []),
        snapshot.lifecycle,
        materializationRevision,
        snapshot.currency,
        snapshot.pricingCurrencyRevision,
        result,
        rows.length,
        rowsHash,
      ],
    );
    for (const row of rows) {
      await insertMaterializedRow(
        client,
        receiptId,
        command,
        snapshot,
        materializationRevision,
        row,
      );
    }
    sourceReceipts.push({
      sourceKind: snapshot.sourceKind,
      sourceId: snapshot.sourceId,
      sourceRevision: snapshot.sourceRevision,
      configuredState: snapshot.configuredState,
      validation: snapshot.validation,
      lifecycle: snapshot.lifecycle,
      materializationRevision,
      currency: snapshot.currency,
      pricingCurrencyRevision: snapshot.pricingCurrencyRevision,
      result,
      materializedRowCount: rows.length,
      materializedRowsSha256: rowsHash,
    });
  }
  const receipt = parseRecurringPricingMaterializationReceipt({
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    receiptId,
    propertyId: command.propertyId,
    optionalPricingAggregateRevision: aggregateRevision,
    fromDate: command.fromDate,
    throughDate: command.throughDate,
    sources: sourceReceipts,
    acceptedAt: at.toISOString(),
  });
  if (!receipt) throw new Error("PMS recurring pricing materialization receipt is invalid");
  const event: PmsRecurringPricingMaterializedEvent = {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    eventType: "pms.recurring_pricing.materialized",
    receiptId,
    propertyId: command.propertyId,
    optionalPricingAggregateRevision: aggregateRevision,
    fromDate: command.fromDate,
    throughDate: command.throughDate,
    sources: receipt.sources.map((source) => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      materializationRevision: source.materializationRevision,
      lifecycle: source.lifecycle,
      result: source.result,
      materializedRowCount: source.materializedRowCount,
      materializedRowsSha256: source.materializedRowsSha256,
    })),
  };
  return { result: { ok: true, receipt }, change: { kind: "materialized", event, receiptId } };
}

async function revalidateSource(
  client: PmsRecurringPricingCommandClient,
  row: LockedSourceRow,
  currency: CurrencyRow,
  at: Date,
): Promise<PmsRecurringPricingSourceSnapshot> {
  const current = await loadPmsRecurringPricingSource(client, row.propertyId, row.sourceId);
  if (!current) throw new Error("PMS recurring pricing source vanished during revalidation");
  const reasons: PmsRecurringPricingInvalidReason[] = [];
  const pricingRevision = positiveInteger(currency.pricingCurrencyRevision);
  if (current.currency !== currency.currency) reasons.push({ code: "pricing_currency_mismatch" });
  if (current.pricingCurrencyRevision !== pricingRevision) {
    reasons.push({ code: "pricing_currency_revision_stale" });
  }
  const bindings = snapshotBindings(current);
  if (current.sourceKind !== "additional_guest") {
    const activeRooms = await client.query<{ roomTypeId: string }>(
      `SELECT id::text AS "roomTypeId" FROM pms.room_types
       WHERE property_id = $1::uuid AND active ORDER BY id FOR UPDATE`,
      [current.propertyId],
    );
    const boundRoomTypeIds = new Set(bindings.map(({ roomTypeId }) => roomTypeId));
    for (const { roomTypeId } of activeRooms.rows) {
      const normalizedRoomTypeId = roomTypeId.toLowerCase();
      if (!boundRoomTypeIds.has(normalizedRoomTypeId)) {
        reasons.push({
          code: "recurring_pricing_room_plan_missing",
          roomTypeId: normalizedRoomTypeId,
        });
      }
    }
  }
  for (const binding of bindings) {
    const room = await client.query<RoomRow>(
      `SELECT id::text AS "roomTypeId", room_facts_revision AS "roomFactsRevision",
              occupancy_limits->>'adults' AS "maximumAdultGuests"
       FROM pms.room_types WHERE property_id = $1::uuid AND id = $2::uuid AND active FOR UPDATE`,
      [current.propertyId, binding.roomTypeId],
    );
    const roomRow = room.rows[0];
    if (!roomRow) reasons.push({ code: "room_type_missing", roomTypeId: binding.roomTypeId });
    else {
      if (positiveInteger(roomRow.roomFactsRevision) !== binding.roomFactsRevision) {
        reasons.push({ code: "room_facts_revision_stale", roomTypeId: binding.roomTypeId });
      }
      if (
        current.sourceKind === "additional_guest" &&
        databaseInteger(roomRow.maximumAdultGuests) !== current.maximumAdultGuests
      ) {
        reasons.push({
          code: "additional_guest_capacity_inapplicable",
          roomTypeId: binding.roomTypeId,
        });
      }
    }
    const plan = await client.query<PlanRow>(
      `SELECT id::text AS "flexibleRatePlanId", room_type_id::text AS "roomTypeId",
              flexible_rate_plan_revision AS "flexibleRatePlanRevision"
       FROM pms.rate_plans WHERE property_id = $1::uuid AND id = $2::uuid
         AND pricing_contract_version = $3 AND active FOR UPDATE`,
      [current.propertyId, binding.flexibleRatePlanId, PMS_PRICING_CONTRACT_VERSION],
    );
    const planRow = plan.rows[0];
    if (!planRow || planRow.roomTypeId.toLowerCase() !== binding.roomTypeId) {
      reasons.push({ code: "flexible_rate_plan_missing", roomTypeId: binding.roomTypeId });
    } else if (
      positiveInteger(planRow.flexibleRatePlanRevision) !== binding.flexibleRatePlanRevision
    ) {
      reasons.push({ code: "flexible_rate_plan_revision_stale", roomTypeId: binding.roomTypeId });
    }
  }
  if (current.sourceKind === "season" && current.configuredState === "active") {
    const seasons = await client.query<ExistingSeasonRow>(
      `SELECT id::text AS "sourceId", season_name AS name,
              season_start_month AS "startMonth", season_start_day AS "startDay",
              season_end_month AS "endMonth", season_end_day AS "endDay"
       FROM pms.recurring_pricing_sources
       WHERE property_id = $1::uuid AND source_kind = 'season'
         AND configured_state = 'active' AND id <> $2::uuid ORDER BY id FOR UPDATE`,
      [current.propertyId, current.sourceId],
    );
    for (const season of seasons.rows) {
      if (
        annualRangesOverlap(
          current.startMonthDay,
          current.endMonthDay,
          monthDay(season.startMonth, season.startDay),
          monthDay(season.endMonth, season.endDay),
        )
      ) {
        reasons.push({
          code: "season_overlap",
          conflictingSourceId: season.sourceId.toLowerCase(),
        });
      }
    }
  }
  reasons.sort((left, right) => invalidReasonKey(left).localeCompare(invalidReasonKey(right)));
  const validationRevision = current.validation.validationRevision + 1;
  const revalidated = await client.query(
    `UPDATE pms.recurring_pricing_sources
     SET validation_state = $3, validation_revision = $4, validated_at = $5::timestamptz,
         invalid_reasons = $6::jsonb, updated_at = $5::timestamptz
     WHERE id = $1::uuid AND property_id = $2::uuid AND source_revision = $7`,
    [
      current.sourceId,
      current.propertyId,
      reasons.length === 0 ? "valid" : "invalid",
      validationRevision,
      at.toISOString(),
      JSON.stringify(reasons),
      current.sourceRevision,
    ],
  );
  if (revalidated.rowCount !== 1) {
    throw new Error("PMS recurring pricing revalidation CAS failed");
  }
  const validated = await loadPmsRecurringPricingSource(
    client,
    current.propertyId,
    current.sourceId,
  );
  if (!validated) throw new Error("PMS recurring pricing revalidated source disappeared");
  return validated;
}

function deriveRows(
  source: PmsRecurringPricingSourceSnapshot,
  command: MaterializeRecurringPricingCommand,
): MaterializedRow[] {
  if (source.sourceKind === "non_refundable") return [];
  const dates = inclusiveDates(command.fromDate, command.throughDate);
  const rows: MaterializedRow[] = [];
  if (source.sourceKind === "season") {
    for (const date of dates.filter((value) =>
      annualDateMatches(value, source.startMonthDay, source.endMonthDay),
    )) {
      for (const room of source.roomPrices) {
        rows.push(
          materializedRow(source, room.roomTypeId, date, {
            seasonalAmount: room.amountDecimal,
          }),
        );
      }
    }
  } else if (source.sourceKind === "weekend_surcharge") {
    for (const date of dates.filter((value) => source.weekdays.includes(weekday(value)))) {
      for (const room of source.roomSurcharges) {
        rows.push(
          materializedRow(source, room.roomTypeId, date, {
            weekendAmount: room.amountDecimal,
          }),
        );
      }
    }
  } else {
    for (const date of dates) {
      rows.push(
        materializedRow(source, source.roomTypeId, date, {
          maximumAdultGuests: source.maximumAdultGuests,
          includedGuests: source.includedGuests,
          additionalGuestAmount: source.amountDecimal,
        }),
      );
    }
  }
  return rows.sort((left, right) =>
    `${left.sourceKind}:${left.sourceId}:${left.roomTypeId}:${left.stayDate}`.localeCompare(
      `${right.sourceKind}:${right.sourceId}:${right.roomTypeId}:${right.stayDate}`,
    ),
  );
}

function materializedRow(
  source: Exclude<PmsRecurringPricingSourceSnapshot, { sourceKind: "non_refundable" }>,
  roomTypeId: string,
  stayDate: string,
  values: Partial<MaterializedRow>,
): MaterializedRow {
  return {
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    roomTypeId,
    stayDate,
    seasonalAmount: null,
    weekendAmount: null,
    maximumAdultGuests: null,
    includedGuests: null,
    additionalGuestAmount: null,
    ...values,
  };
}

async function insertMaterializedRow(
  client: PmsRecurringPricingCommandClient,
  receiptId: string,
  command: MaterializeRecurringPricingCommand,
  source: PmsRecurringPricingSourceSnapshot,
  materializationRevision: number,
  row: MaterializedRow,
): Promise<void> {
  await client.query(
    `INSERT INTO pms.recurring_pricing_materialized_rows (
       receipt_id, property_id, horizon_start, horizon_end, source_id, source_kind,
       optional_pricing_aggregate_revision,
       source_revision, source_lifecycle, materialization_revision, currency,
       source_pricing_currency_revision, room_type_id, stay_date,
       seasonal_nightly_amount, weekend_surcharge_amount, maximum_adult_guests,
       included_guest_count, additional_guest_amount
     ) VALUES (
       $1::uuid, $2::uuid, $3::date, $4::date, $5::uuid, $6, $7, $8, $9, $10,
       $11, $12, $13::uuid, $14::date, $15::numeric(15,2), $16::numeric(15,2),
       $17, $18, $19::numeric(15,2)
     )`,
    [
      receiptId,
      command.propertyId,
      command.fromDate,
      command.throughDate,
      source.sourceId,
      source.sourceKind,
      command.expectedOptionalPricingAggregateRevision,
      source.sourceRevision,
      source.lifecycle,
      materializationRevision,
      source.currency,
      source.pricingCurrencyRevision,
      row.roomTypeId,
      row.stayDate,
      row.seasonalAmount,
      row.weekendAmount,
      row.maximumAdultGuests,
      row.includedGuests,
      row.additionalGuestAmount,
    ],
  );
}

async function lockAuthorizedScope(
  client: PmsRecurringPricingCommandClient,
  command: AnyCommand,
  at: Date,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const scope = await client.query(
    `SELECT property.id
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id AND resource.product = 'pms'
      AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator') AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $4
     WHERE property.id = $2::uuid
     FOR SHARE OF property, organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [command.organizationId, command.propertyId, command.audit.actor.userId, MANAGE_PERMISSION],
  );
  if ((scope.rowCount ?? 0) < 1) return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = 'pms'
       AND entitlement_key = 'property-management'
       AND (resource_product IS NULL OR
            (resource_product = 'pms' AND resource_type = 'pms_property'
             AND resource_id = $2::uuid::text))
     FOR SHARE`,
    [command.organizationId, command.propertyId],
  );
  const applicable = entitlements.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= at) &&
      (!row.expiresAt || new Date(row.expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

async function lockPropertyPricingScope(
  client: PmsRecurringPricingCommandClient,
  propertyId: string,
): Promise<void> {
  const lockKey = serializePmsPricingCurrencyDependencyLockKey(propertyId);
  if (!lockKey) throw new Error("PMS recurring pricing property lock scope is malformed");
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 0)
     )`,
    [lockKey],
  );
}

async function lockCommandSources(
  client: PmsRecurringPricingCommandClient,
  command: AnyCommand,
): Promise<void> {
  const sourceIds = "sourceId" in command ? [command.sourceId] : [];
  for (const sourceId of [...sourceIds].sort()) {
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(concat('pms-recurring-pricing-source:', $1::uuid::text), 0)
       )`,
      [sourceId],
    );
  }
}

async function lockCurrency(
  client: PmsRecurringPricingCommandClient,
  propertyId: string,
): Promise<CurrencyRow | null> {
  const result = await client.query<CurrencyRow>(
    `SELECT currency::text AS currency,
            pricing_currency_revision AS "pricingCurrencyRevision",
            optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision"
     FROM pms.property_pricing_settings WHERE property_id = $1::uuid FOR UPDATE`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS recurring pricing currency is not unique");
  return result.rows[0] ?? null;
}

async function lockSourceById(
  client: PmsRecurringPricingCommandClient,
  sourceId: string,
): Promise<LockedSourceRow | null> {
  const result = await client.query<LockedSourceRow>(
    `SELECT property_id::text AS "propertyId", id::text AS "sourceId",
            source_kind AS "sourceKind", source_revision AS "sourceRevision",
            source_pricing_currency_revision AS "pricingCurrencyRevision",
            currency::text AS currency, configured_state AS "configuredState",
            validation_state AS "validationState", validation_revision AS "validationRevision",
            validated_at AS "validatedAt", invalid_reasons AS "invalidReasons",
            lifecycle, materialization_revision AS "materializationRevision",
            season_name AS "seasonName", season_start_month AS "seasonStartMonth",
            season_start_day AS "seasonStartDay", season_end_month AS "seasonEndMonth",
            season_end_day AS "seasonEndDay", weekend_days AS "weekendDays",
            discount_percent AS "discountPercent",
            cancellation_terms_type AS "cancellationTermsType",
            refund_policy AS "refundPolicy", no_show_penalty AS "noShowPenalty",
            payment_timing AS "paymentTiming",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM pms.recurring_pricing_sources WHERE id = $1::uuid FOR UPDATE`,
    [sourceId],
  );
  if (result.rows.length > 1) throw new Error("PMS recurring pricing source ID is not unique");
  return result.rows[0] ?? null;
}

async function lockAllPropertySources(
  client: PmsRecurringPricingCommandClient,
  propertyId: string,
): Promise<readonly LockedSourceRow[]> {
  const result = await client.query<LockedSourceRow>(
    `SELECT property_id::text AS "propertyId", id::text AS "sourceId",
            source_kind AS "sourceKind", source_revision AS "sourceRevision",
            source_pricing_currency_revision AS "pricingCurrencyRevision",
            currency::text AS currency, configured_state AS "configuredState",
            validation_state AS "validationState", validation_revision AS "validationRevision",
            validated_at AS "validatedAt", invalid_reasons AS "invalidReasons",
            lifecycle, materialization_revision AS "materializationRevision",
            season_name AS "seasonName", season_start_month AS "seasonStartMonth",
            season_start_day AS "seasonStartDay", season_end_month AS "seasonEndMonth",
            season_end_day AS "seasonEndDay", weekend_days AS "weekendDays",
            discount_percent AS "discountPercent",
            cancellation_terms_type AS "cancellationTermsType",
            refund_policy AS "refundPolicy", no_show_penalty AS "noShowPenalty",
            payment_timing AS "paymentTiming",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM pms.recurring_pricing_sources
     WHERE property_id = $1::uuid
     ORDER BY CASE source_kind
       WHEN 'season' THEN 1 WHEN 'weekend_surcharge' THEN 2
       WHEN 'additional_guest' THEN 3 WHEN 'non_refundable' THEN 4
       ELSE 99 END, id
     FOR UPDATE`,
    [propertyId],
  );
  return result.rows;
}

async function advanceAggregate(
  client: PmsRecurringPricingCommandClient,
  propertyId: string,
  expected: number,
): Promise<number> {
  const result = await client.query<{ revision: number | string }>(
    `UPDATE pms.property_pricing_settings
     SET optional_pricing_aggregate_revision = optional_pricing_aggregate_revision + 1,
         updated_at = updated_at
     WHERE property_id = $1::uuid AND optional_pricing_aggregate_revision = $2
     RETURNING optional_pricing_aggregate_revision AS revision`,
    [propertyId, expected],
  );
  if (!result.rows[0]) throw new Error("PMS optional pricing aggregate CAS failed");
  return positiveInteger(result.rows[0].revision);
}

async function findReplay<C extends AnyCommand, R extends AnyResult>(
  client: PmsRecurringPricingCommandClient,
  command: C,
  spec: CommandSpec<C, R>,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<R | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata", expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid FOR UPDATE`,
    [spec.operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return spec.coordinationFailure("command_in_progress");
  const stored = isRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = spec.parse(stored);
  if (
    !parsed ||
    existing.responseStatusCode !== resultStatus(parsed) ||
    existing.responseBodyHash !== sha256(stableJson(parsed))
  ) {
    return spec.coordinationFailure("idempotency_key_conflict");
  }
  return parsed;
}

async function reserveIdempotency(
  client: PmsRecurringPricingCommandClient,
  command: AnyCommand,
  operation: string,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       correlation_id = EXCLUDED.correlation_id, first_seen_at = EXCLUDED.first_seen_at,
       last_seen_at = EXCLUDED.last_seen_at, completed_at = NULL,
       expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt', COALESCE((idempotency_keys.idempotency_metadata->>'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id,
       (idempotency_metadata->>'attempt')::integer AS attempt`,
    [
      operation,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsRecurringPricingCommandClient,
  id: string,
  result: AnyResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      resultStatus(result),
      sha256(stableJson(result)),
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1)
    throw new Error("PMS recurring pricing idempotency completion failed");
}

async function enqueueChange(
  client: PmsRecurringPricingCommandClient,
  command: AnyCommand,
  operation: string,
  reservation: IdempotencyReservation,
  keyHash: string,
  change: AcceptedChange,
  at: Date,
): Promise<string> {
  if (command.audit.actor.kind !== "user")
    throw new Error("PMS recurring pricing event requires user actor");
  const eventType =
    change.kind === "source"
      ? "pms.recurring_pricing_source.changed"
      : "pms.recurring_pricing.materialized";
  const resourceType =
    change.kind === "source" ? "recurring_pricing_source" : "pricing_materialization";
  const resourceId = change.kind === "source" ? change.sourceId : change.receiptId;
  const eventKey = `${eventType}.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
  const inserted = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, correlation_id,
       causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       'pms', $1, $2, 1, $3::timestamptz, 'property', NULL, $4::uuid,
       'pms', $5, $6, 'user', $7::uuid, $8, $9, $10,
       $11::jsonb, $12::jsonb, 'confidential'
     ) RETURNING id::text AS "eventId"`,
    [
      eventKey,
      eventType,
      at.toISOString(),
      command.propertyId,
      resourceType,
      resourceId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(change.event),
      JSON.stringify({
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const eventId = inserted.rows[0]?.eventId;
  if (!eventId) throw new Error("PMS recurring pricing event insert failed");
  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, 'booking.pricing-source', $3, 'property', NULL,
       $4::uuid, 'pms', $5, $6, $7, $8, $9::jsonb, $10::jsonb
     )`,
    [
      eventId,
      `booking.pricing-source.${eventType}.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      eventType,
      command.propertyId,
      resourceType,
      resourceId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify(change.event),
      JSON.stringify({
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  return eventId;
}

async function recordAudit(
  client: PmsRecurringPricingCommandClient,
  command: AnyCommand,
  operation: string,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: AnyResult,
  eventId: string | null,
  at: Date,
): Promise<void> {
  if (command.audit.actor.kind !== "user")
    throw new Error("PMS recurring pricing audit requires user actor");
  const targetId = "sourceId" in command ? command.sourceId : command.propertyId;
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id, idempotency_key_id,
       correlation_id, causation_id, redacted_payload, private_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid, 'user',
       $5::uuid, 'pms', $6, $7, $8::uuid, $9::uuid, $10, $11,
       $12::jsonb, '{}'::jsonb, $13::jsonb, 'confidential'
     )`,
    [
      `pms.recurring-pricing.property.${command.propertyId}.operation.${operation}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      operation,
      at.toISOString(),
      command.propertyId,
      command.audit.actor.userId,
      "sourceId" in command ? "recurring_pricing_source" : "pricing_materialization",
      targetId,
      eventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(redactedAudit(command, result)),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      }),
    ],
  );
}

function redactedAudit(command: AnyCommand, result: AnyResult): Record<string, unknown> {
  return {
    propertyId: command.propertyId,
    ...(result.ok
      ? "response" in result
        ? {
            outcome: result.response.outcome,
            sourceId: result.response.source.sourceId,
            sourceRevision: result.response.source.sourceRevision,
            optionalPricingAggregateRevision: result.response.optionalPricingAggregateRevision,
          }
        : {
            outcome: "materialized",
            receiptId: result.receipt.receiptId,
            sources: result.receipt.sources.map(
              ({ sourceId, sourceRevision, materializationRevision }) => ({
                sourceId,
                sourceRevision,
                materializationRevision,
              }),
            ),
          }
      : {
          outcome: result.error.code,
          ...("currentRevision" in result.error
            ? { currentRevision: result.error.currentRevision }
            : {}),
        }),
  };
}

function sourceBindings(
  command: UpsertRecurringPricingSourceCommand,
): readonly RecurringPricingRoomCommandEvidence[] {
  return command.sourceKind === "season"
    ? command.roomPrices
    : command.sourceKind === "weekend_surcharge"
      ? command.roomSurcharges
      : command.sourceKind === "non_refundable"
        ? command.roomPlans
        : [command];
}

function snapshotBindings(source: PmsRecurringPricingSourceSnapshot) {
  return source.sourceKind === "season"
    ? source.roomPrices
    : source.sourceKind === "weekend_surcharge"
      ? source.roomSurcharges
      : source.sourceKind === "non_refundable"
        ? source.roomPlans
        : [source];
}

function sourceFailure(error: PmsRecurringPricingCommandError): PmsRecurringPricingCommandResult {
  return { ok: false, error };
}

function materializationFailure(
  error: PmsRecurringPricingCommandError,
): RecurringPricingMaterializationResult {
  return { ok: false, error };
}

function normalizedGeneratedId(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`PMS recurring pricing ${label} generator returned an invalid UUID`);
  }
  return normalized;
}

function monthDay(month: number | string, day: number | string): string {
  return `${String(databaseInteger(month)).padStart(2, "0")}-${String(databaseInteger(day)).padStart(2, "0")}`;
}

function annualRangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  const first = annualIntervals(firstStart, firstEnd);
  const second = annualIntervals(secondStart, secondEnd);
  return first.some(([start, end]) =>
    second.some(([otherStart, otherEnd]) => start <= otherEnd && otherStart <= end),
  );
}

function annualIntervals(start: string, end: string): readonly [number, number][] {
  const startDay = annualOrdinal(start);
  const endDay = annualOrdinal(end);
  return startDay <= endDay
    ? [[startDay, endDay]]
    : [
        [startDay, 366],
        [1, endDay],
      ];
}

function annualOrdinal(value: string): number {
  const [month, day] = value.split("-").map(Number) as [number, number];
  return Math.floor((Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86_400_000) + 1;
}

function annualDateMatches(date: string, start: string, end: string): boolean {
  const monthDayValue = date.slice(5);
  const ordinal = annualOrdinal(monthDayValue);
  return annualIntervals(start, end).some(
    ([from, through]) => ordinal >= from && ordinal <= through,
  );
}

function inclusiveDates(fromDate: string, throughDate: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${throughDate}T00:00:00.000Z`);
  for (
    let current = Date.parse(`${fromDate}T00:00:00.000Z`);
    current <= end;
    current += 86_400_000
  ) {
    dates.push(new Date(current).toISOString().slice(0, 10));
  }
  return dates;
}

function weekday(date: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]!;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function invalidReasonKey(reason: PmsRecurringPricingInvalidReason): string {
  const order = [
    "pricing_currency_mismatch",
    "pricing_currency_revision_stale",
    "room_type_missing",
    "room_facts_revision_stale",
    "flexible_rate_plan_missing",
    "flexible_rate_plan_revision_stale",
    "recurring_pricing_room_plan_missing",
    "season_overlap",
    "additional_guest_capacity_inapplicable",
    "non_refundable_payment_timing_invalid",
    "dependency_unavailable",
  ].indexOf(reason.code);
  return `${String(order).padStart(2, "0")}:${"roomTypeId" in reason ? reason.roomTypeId : "conflictingSourceId" in reason ? reason.conflictingSourceId : ""}`;
}

function positiveInteger(value: number | string | null): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("PMS recurring pricing database revision is invalid");
  }
  return parsed;
}

function nonNegativeInteger(value: number | string | null): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error("PMS recurring pricing database counter is invalid");
  }
  return parsed;
}

function databaseInteger(value: number | string | null): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function resultStatus(result: AnyResult): number {
  return result.ok ? 200 : result.error.code === "setup_scope_unavailable" ? 403 : 409;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rollbackQuietly(client: PmsRecurringPricingCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
