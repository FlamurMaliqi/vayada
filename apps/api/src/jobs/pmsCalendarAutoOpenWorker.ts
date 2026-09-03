import { createHash } from "node:crypto";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS,
  PMS_INVENTORY_HORIZON_MAX_DAYS,
  PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
  PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
  calculatePmsCalendarAutoOpenHorizon,
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
  isPmsCalendarAutoOpenConfiguration,
  isPmsCalendarAutoOpenFixedTargetWithinLimit,
  planPmsInventoryMaterialization,
  type PmsCalendarAutoOpenSource,
  type PmsCalendarAutoOpenSetting,
  type PmsCalendarAutoOpenWarning,
  type PmsInventoryCoverageEvidence,
  type PmsInventoryDaySnapshot,
  type PmsInventoryMaterializationCommand,
  type PmsInventoryProjectionRefreshIntent,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
} from "@vayada/domain-pms";
import pg, { type QueryResultRow } from "pg";

import {
  lockPmsInventoryDaysForMaterialization,
  persistPmsInventoryMaterializationCoverage,
  persistPmsInventoryMaterializationDays,
  type PmsInventoryMaterializationRepositoryClient,
} from "../domains/pmsInventoryMaterializationRepository.js";
import { lockPmsInventoryMutationScope } from "../domains/pmsInventoryMutationLock.js";
import { reconcilePmsLinkedInventory } from "../domains/pmsLinkedInventoryReconciler.js";
import { loadPmsOperatingCalendarConfigurationByRevision } from "../domains/pmsOperatingCalendarReadModel.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "../domains/pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "../domains/pmsRoomFactsMutationLock.js";
import { PMS_CALENDAR_AUTO_OPEN_QUEUE } from "./pmsChannexScheduler.js";

const LEASE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const RESULT_KEY = "calendarAutoOpenResult";

type Client = PmsInventoryMaterializationRepositoryClient;
type Pool = { connect(): Promise<Client>; end(): Promise<void> };
type PmsCalendarAutoOpenClaim =
  | PmsCalendarAutoOpenWorkerJob
  | Readonly<{ deadLetteredJobId: string }>;

export type PmsCalendarAutoOpenJobPayload = Readonly<{
  propertyId: string;
  organizationId: string;
  openFrom: string;
  openThrough: string;
  roomTypeIds: readonly string[];
  generatedCoverageThrough: string | null;
  source: PmsCalendarAutoOpenSource;
  sourceFingerprint: string;
}>;

export type PmsCalendarAutoOpenApplicationResult = Readonly<{
  outcome: "applied" | "partial" | "unchanged";
  changedDayCount: number;
  warnings: readonly PmsCalendarAutoOpenWarning[];
  materializedRevision: number;
  coverage: Readonly<{ from: string; through: string }>;
  projectionOutboxEventId: string | null;
  ariOutboxEventIds: readonly string[];
}>;

export type PmsCalendarAutoOpenWorkerJob = Readonly<{
  jobId: string;
  jobKey: string;
  propertyId: string;
  attemptNumber: number;
  maxAttempts: number;
  correlationId: string | null;
  payload: unknown;
}>;
type ValidJob = Omit<PmsCalendarAutoOpenWorkerJob, "payload"> & {
  payload: PmsCalendarAutoOpenJobPayload;
};

export type PmsCalendarAutoOpenWorkerResult =
  | Readonly<{ outcome: "idle" }>
  | Readonly<{
      outcome: "succeeded";
      jobId: string;
      applicationOutcome: PmsCalendarAutoOpenApplicationResult["outcome"];
    }>
  | Readonly<{ outcome: "retry_scheduled" | "dead_lettered"; jobId: string }>;

export type PmsCalendarAutoOpenWorkerStore = Readonly<{
  claim(input: { workerId: string; now: Date }): Promise<PmsCalendarAutoOpenClaim | null>;
  apply(
    job: PmsCalendarAutoOpenWorkerJob,
    input: { workerId: string; now: Date },
  ): Promise<PmsCalendarAutoOpenApplicationResult>;
  succeed(
    job: PmsCalendarAutoOpenWorkerJob,
    result: PmsCalendarAutoOpenApplicationResult,
    input: { workerId: string; now: Date },
  ): Promise<void>;
  fail(
    job: PmsCalendarAutoOpenWorkerJob,
    error: unknown,
    input: { workerId: string; now: Date },
  ): Promise<"retry_scheduled" | "dead_lettered">;
  close?(): Promise<void>;
}>;

export async function runPmsCalendarAutoOpenWorkerOnce(input: {
  store: PmsCalendarAutoOpenWorkerStore;
  workerId: string;
  now?: () => Date;
}): Promise<PmsCalendarAutoOpenWorkerResult> {
  const clock = input.now ?? (() => new Date());
  const claim = await input.store.claim({ workerId: input.workerId, now: clock() });
  if (!claim) return { outcome: "idle" };
  if ("deadLetteredJobId" in claim) {
    return { outcome: "dead_lettered", jobId: claim.deadLetteredJobId };
  }
  const job = claim;
  try {
    const result = await input.store.apply(job, { workerId: input.workerId, now: clock() });
    await input.store.succeed(job, result, { workerId: input.workerId, now: clock() });
    return { outcome: "succeeded", jobId: job.jobId, applicationOutcome: result.outcome };
  } catch (error) {
    return {
      outcome: await input.store.fail(job, error, { workerId: input.workerId, now: clock() }),
      jobId: job.jobId,
    };
  }
}

export function createPgPmsCalendarAutoOpenWorkerStore(config: {
  connectionString: string;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  pool?: Pool;
}): PmsCalendarAutoOpenWorkerStore {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({ connectionString: required(config.connectionString), max: 3 }) as Pool);
  return {
    claim: (input) => claim(pool, input),
    apply: (job, input) => apply(pool, config.propertyProfileEvidence, job, input),
    succeed: (job, result, input) => succeed(pool, job, result, input),
    fail: (job, error, input) => fail(pool, job, error, input),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

type JobRow = QueryResultRow & {
  jobId: string;
  jobKey: string;
  propertyId: string;
  attemptsCount: number | string;
  maxAttempts: number | string;
  correlationId: string | null;
  payload: unknown;
};

async function claim(
  pool: Pool,
  input: { workerId: string; now: Date },
): Promise<PmsCalendarAutoOpenClaim | null> {
  return transaction(pool, async (client) => {
    const row = (
      await client.query<JobRow>(
        `SELECT id::text AS "jobId", job_key AS "jobKey", property_id::text AS "propertyId",
                attempts_count AS "attemptsCount", max_attempts AS "maxAttempts",
                correlation_id AS "correlationId", payload
         FROM platform.jobs
         WHERE queue_name=$1 AND job_type='pms.calendar-auto-open'
           AND ((status='pending' AND attempts_count < max_attempts AND run_after <= $2::timestamptz)
             OR (status='running' AND locked_at <= $2::timestamptz - ($3::bigint * interval '1 millisecond')))
         ORDER BY priority DESC, run_after, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [PMS_CALENDAR_AUTO_OPEN_QUEUE, input.now.toISOString(), LEASE_MS],
      )
    ).rows[0];
    if (!row) return null;
    const previousAttempts = integer(row.attemptsCount);
    if (previousAttempts > 0) {
      await client.query(
        `UPDATE platform.job_attempts SET status='timed_out', finished_at=$3::timestamptz,
           error_type='worker_lease_expired', error_message='Calendar auto-open worker lease expired'
         WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'`,
        [row.jobId, previousAttempts, input.now.toISOString()],
      );
    }
    if (previousAttempts >= integer(row.maxAttempts)) {
      await client.query(
        `UPDATE platform.jobs SET status='dead_lettered',finished_at=$2::timestamptz,
           locked_at=NULL,locked_by=NULL,updated_at=$2::timestamptz,
           job_metadata=job_metadata||'{"lastError":"worker_lease_expired"}'::jsonb
         WHERE id=$1::uuid`,
        [row.jobId, input.now.toISOString()],
      );
      await client.query(
        `INSERT INTO platform.dead_letter_events(
           source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,
           resource_type,resource_id,correlation_id,idempotency_key_hash,reason_code,
           failure_summary,failure_payload)
         SELECT 'job',$1::uuid,attempt.id,'property',$2::uuid,'pms','property',$2,$3,$4,
           'max_attempts_exhausted','Calendar auto-open worker lease expired after the final attempt',
           jsonb_build_object('attemptCount',$5::integer,'replayEligible',true)
         FROM platform.job_attempts attempt
         WHERE attempt.job_id=$1::uuid AND attempt.attempt_number=$5 ON CONFLICT DO NOTHING`,
        [row.jobId, row.propertyId, row.correlationId, sha256(row.jobKey), previousAttempts],
      );
      return { deadLetteredJobId: row.jobId };
    }
    const attemptNumber = previousAttempts + 1;
    await client.query(
      `UPDATE platform.jobs SET status='running', attempts_count=$3, locked_by=$2,
         locked_at=$4::timestamptz, updated_at=$4::timestamptz WHERE id=$1::uuid`,
      [row.jobId, input.workerId, attemptNumber, input.now.toISOString()],
    );
    await client.query(
      `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,started_at,error_metadata)
       VALUES($1::uuid,$2,'running',$3,$4::timestamptz,'{"worker":"pms-calendar-auto-open"}'::jsonb)`,
      [row.jobId, attemptNumber, input.workerId, input.now.toISOString()],
    );
    return {
      jobId: row.jobId,
      jobKey: row.jobKey,
      propertyId: row.propertyId,
      attemptNumber,
      maxAttempts: integer(row.maxAttempts),
      correlationId: row.correlationId,
      payload: row.payload,
    };
  });
}

type SourceRow = QueryResultRow & {
  enabled: boolean;
  mode: "rolling" | "fixed";
  rollingMonths: number | string | null;
  fixedEndMonth: string | Date | null;
  settingRevision: number | string;
  propertyProfileRevision: number | string;
  organizationId: string | null;
  operatingCalendarRevision: number | string | null;
};
type LocationRow = QueryResultRow & { propertyTimeZone: string };
type PricingRow = QueryResultRow & {
  pricingCurrencyRevision: number | string | null;
  optionalPricingAggregateRevision: number | string | null;
};
type RoomRow = QueryResultRow & {
  roomTypeId: string;
  roomFactsRevision: number | string;
  roomUnitsRevision: number | string;
};
type PlanRow = QueryResultRow & {
  roomTypeId: string;
  flexibleRatePlanRevision: number | string;
};

async function apply(
  pool: Pool,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
  job: PmsCalendarAutoOpenWorkerJob,
  input: { workerId: string; now: Date },
): Promise<PmsCalendarAutoOpenApplicationResult> {
  let payload: PmsCalendarAutoOpenJobPayload;
  try {
    payload = parsePayload(job.payload);
  } catch {
    throw new PermanentAutoOpenError("Calendar auto-open payload is invalid");
  }
  if (payload.propertyId !== job.propertyId) {
    throw new PermanentAutoOpenError("Calendar auto-open job scope is invalid");
  }
  const validJob: ValidJob = { ...job, payload };
  return transaction(pool, async (client) => {
    await assertLease(client, validJob, input.workerId, input.now);
    const replay = await readAppliedResult(client, validJob);
    if (replay) return replay;
    await lockPmsInventoryMutationScope(client, validJob.payload.propertyId);
    await lockPmsRoomFactsMutationScope(client, validJob.payload.propertyId);
    for (const roomTypeId of await activeRoomTypeIds(client, validJob.payload.propertyId)) {
      await lockPmsPhysicalRoomUnitMutationScope(client, validJob.payload.propertyId, roomTypeId);
    }
    const confirmed = await loadCurrentSource(client, validJob.payload.propertyId);
    if (!confirmed || !sourceMatchesJob(confirmed, validJob.payload)) {
      return recordApplicationResult(client, validJob, unchangedResult(validJob), input.now);
    }
    const configuration = await loadPmsOperatingCalendarConfigurationByRevision(
      client,
      validJob.payload.propertyId,
      confirmed.source.operatingCalendarRevision,
      registry,
    );
    if (!configuration || !configurationMatchesSource(configuration, confirmed.source)) {
      throw new Error("Calendar auto-open operating configuration is not current");
    }

    const localToday = await propertyLocalDate(
      client,
      input.now,
      confirmed.source.propertyTimeZone,
    );
    const currentHorizon = calculatePmsCalendarAutoOpenHorizon(
      confirmed.setting,
      confirmed.source.propertyTimeZone,
      input.now,
    );
    if (
      currentHorizon.propertyLocalDate !== localToday ||
      !currentHorizon.targetOpenThrough ||
      !isPmsCalendarAutoOpenFixedTargetWithinLimit(
        confirmed.setting,
        confirmed.source.propertyTimeZone,
        input.now,
      ) ||
      validJob.payload.openFrom > localToday ||
      validJob.payload.openThrough > currentHorizon.targetOpenThrough
    ) {
      throw new PermanentAutoOpenError("Calendar auto-open job horizon is not current");
    }
    const from = maxDate(validJob.payload.openFrom, localToday);
    if (validJob.payload.openThrough < localToday) {
      return recordApplicationResult(client, validJob, unchangedResult(validJob), input.now);
    }
    const currentCoverageThrough = await lockCurrentCoverageThrough(
      client,
      validJob.payload.propertyId,
    );
    if (
      validJob.payload.generatedCoverageThrough &&
      (!currentCoverageThrough ||
        validJob.payload.generatedCoverageThrough > currentCoverageThrough)
    ) {
      throw new PermanentAutoOpenError("Calendar auto-open generated coverage is not current");
    }
    const through = maxDate(validJob.payload.openThrough, currentCoverageThrough);
    if (dayCount(from, through) > PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS) {
      throw new PermanentAutoOpenError("Calendar auto-open horizon exceeds the 24-month maximum");
    }
    const batches = dateBatches(from, through);
    const rateReadyRooms = new Set(
      confirmed.source.pricing.flexibleRatePlans.map(({ roomTypeId }) => roomTypeId),
    );
    const missingRateRooms = new Set(
      confirmed.source.rooms
        .filter(({ roomTypeId }) => !rateReadyRooms.has(roomTypeId))
        .map(({ roomTypeId }) => roomTypeId),
    );
    const changedRangesByBatch: ChangeRange[] = [];
    const missingRateRanges: ChangeRange[] = [];
    let changedDayCount = 0;
    let rematerialized = false;
    let hadCurrentDays = false;

    for (const horizon of batches) {
      const command = materializationCommand(validJob, configuration, horizon, input.now);
      const currentDays = await lockPmsInventoryDaysForMaterialization(
        client,
        command,
        configuration,
      );
      const currentGeneratedSources = await loadInventoryGeneratedSources(
        client,
        validJob.payload.propertyId,
        horizon,
      );
      hadCurrentDays ||= currentDays.length > 0;
      const dates = inclusiveDates(horizon.from, horizon.through);
      const plan = planPmsInventoryMaterialization({
        propertyId: validJob.payload.propertyId,
        configurationSource: configuration.source,
        configuration,
        horizon,
        currentDays,
        generatedSellableLimitOverrides: [...missingRateRooms].flatMap((roomTypeId) =>
          dates.map((stayDate) => ({ roomTypeId, stayDate, count: 0 })),
        ),
      });
      if (!plan.ok) throw new PermanentAutoOpenError(`Inventory plan failed: ${plan.error.code}`);
      const changedDays = new Map(plan.changedDays.map((day) => [dayKey(day), day]));
      let generatedSourceChanged = false;
      for (const day of plan.days) {
        const currentSource = currentGeneratedSources.get(dayKey(day));
        const desiredGate = rateReadyRooms.has(day.roomTypeId);
        if (
          currentSource === undefined ||
          (currentSource.rateGateOpen === desiredGate &&
            currentSource.fingerprint === validJob.payload.sourceFingerprint) ||
          changedDays.has(dayKey(day))
        ) {
          continue;
        }
        if (day.inventoryRevision === 2_147_483_647) {
          throw new PermanentAutoOpenError("Inventory rate gate revision is exhausted");
        }
        changedDays.set(dayKey(day), { ...day, inventoryRevision: day.inventoryRevision + 1 });
        generatedSourceChanged = true;
      }
      const persistedDays = [...changedDays.values()].sort((left, right) =>
        dayKey(left).localeCompare(dayKey(right)),
      );
      rematerialized ||= plan.outcome === "rematerialized" || generatedSourceChanged;
      await persistPmsInventoryMaterializationDays(client, persistedDays, input.now, {
        fingerprint: validJob.payload.sourceFingerprint,
        rateReadyRoomTypeIds: rateReadyRooms,
      });
      missingRateRanges.push(
        ...collapseChanges(
          plan.days.filter(
            (day) => missingRateRooms.has(day.roomTypeId) && day.operatingStatus === "open",
          ),
        ),
      );
      const linked = await reconcilePmsLinkedInventory(
        client,
        validJob.payload.propertyId,
        input.now.toISOString(),
        changedRanges(persistedDays),
      );
      const batchChanged = new Map([...persistedDays, ...linked].map((day) => [dayKey(day), day]));
      changedDayCount += batchChanged.size;
      changedRangesByBatch.push(...collapseChanges([...batchChanged.values()]));
    }

    const warnings = warningsFromRanges(missingRateRanges);
    if (changedDayCount === 0) {
      return recordApplicationResult(
        client,
        validJob,
        {
          ...unchangedResult(validJob),
          warnings,
          materializedRevision: configuration.calendarRevision,
        },
        input.now,
      );
    }

    const coverage: PmsInventoryCoverageEvidence = Object.freeze({
      configurationSource: configuration.source,
      materializedRevision: configuration.calendarRevision,
      coverageFrom: from,
      coverageThrough: through,
      roomTypeIds: Object.freeze(
        configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId).sort(),
      ),
      expectedDayCount: dayCount(from, through) * configuration.sourceInputs.roomBindings.length,
      materializedDayCount:
        dayCount(from, through) * configuration.sourceInputs.roomBindings.length,
      gaps: Object.freeze([]),
    });
    const reason = !hadCurrentDays
      ? "full_horizon_apply"
      : rematerialized
        ? "rematerialization"
        : "horizon_extension";
    const projection = await enqueueProjectionRefresh(
      client,
      validJob,
      coverage,
      reason,
      input.now,
    );
    const ariOutboxEventIds = await enqueueAriChanges(
      client,
      validJob,
      changedRangesByBatch,
      rateReadyRooms,
      input.now,
    );
    const idempotencyId = await schedulerIdempotencyId(client, validJob);
    await persistPmsInventoryMaterializationCoverage(
      client,
      materializationCommand(validJob, configuration, { from, through }, input.now),
      idempotencyId,
      projection.eventId,
      projection.outboxEventId,
      coverage,
      input.now,
      validJob.payload.sourceFingerprint,
    );
    return recordApplicationResult(
      client,
      validJob,
      {
        outcome: warnings.length > 0 ? "partial" : "applied",
        changedDayCount,
        warnings,
        materializedRevision: configuration.calendarRevision,
        coverage: { from, through },
        projectionOutboxEventId: projection.outboxEventId,
        ariOutboxEventIds,
      },
      input.now,
    );
  });
}

async function activeRoomTypeIds(client: Client, propertyId: string): Promise<readonly string[]> {
  const result = await client.query<{ roomTypeId: string }>(
    `SELECT id::text AS "roomTypeId" FROM pms.room_types
     WHERE property_id=$1::uuid AND active IS TRUE ORDER BY id`,
    [propertyId],
  );
  return result.rows.map(({ roomTypeId }) => roomTypeId);
}

async function loadInventoryGeneratedSources(
  client: Client,
  propertyId: string,
  horizon: { from: string; through: string },
): Promise<ReadonlyMap<string, { rateGateOpen: boolean; fingerprint: string | null }>> {
  const rows = await client.query<{
    roomTypeId: string;
    stayDate: string | Date;
    rateGateOpen: boolean | null;
    fingerprint: string | null;
  }>(
    `SELECT room_type_id::text AS "roomTypeId", stay_date AS "stayDate",
            rate_gate_open AS "rateGateOpen",
            generated_pricing_source_fingerprint AS fingerprint
     FROM pms.inventory_days
     WHERE property_id=$1::uuid AND stay_date BETWEEN $2::date AND $3::date
     ORDER BY room_type_id, stay_date`,
    [propertyId, horizon.from, horizon.through],
  );
  return new Map(
    rows.rows.map((row) => [
      `${row.roomTypeId}:${databaseDate(row.stayDate)}`,
      { rateGateOpen: row.rateGateOpen !== false, fingerprint: row.fingerprint },
    ]),
  );
}

async function propertyLocalDate(client: Client, now: Date, timeZone: string): Promise<string> {
  const row = (
    await client.query<{ localDate: string | Date }>(
      `SELECT ($1::timestamptz AT TIME ZONE $2)::date AS "localDate"`,
      [now.toISOString(), timeZone],
    )
  ).rows[0];
  const localDate = databaseDate(row?.localDate);
  if (!localDate) throw new Error("Calendar auto-open local date could not be resolved");
  return localDate;
}

async function lockCurrentCoverageThrough(
  client: Client,
  propertyId: string,
): Promise<string | null> {
  const row = (
    await client.query<{ coverageThrough: string | Date }>(
      `SELECT coverage_through AS "coverageThrough"
       FROM pms.inventory_materialization_coverage
       WHERE property_id=$1::uuid FOR UPDATE`,
      [propertyId],
    )
  ).rows[0];
  return row ? databaseDate(row.coverageThrough) : null;
}

async function loadCurrentSource(
  client: Client,
  propertyId: string,
): Promise<{
  source: PmsCalendarAutoOpenSource;
  setting: PmsCalendarAutoOpenSetting;
  organizationId: string;
} | null> {
  await client.query(`SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR SHARE`, [
    propertyId,
  ]);
  const root = (
    await client.query<SourceRow>(
      `SELECT setting.enabled, setting.mode, setting.rolling_months AS "rollingMonths",
              setting.fixed_end_month AS "fixedEndMonth",
              setting.revision AS "settingRevision",
              property.profile_revision AS "propertyProfileRevision",
              calendar.organization_id::text AS "organizationId",
              calendar.calendar_revision AS "operatingCalendarRevision"
       FROM hotel_catalog.properties property
       JOIN pms.calendar_auto_open_settings setting ON setting.property_id=property.id
       LEFT JOIN LATERAL (
         SELECT organization_id, calendar_revision FROM pms.operating_calendar_revisions
         WHERE property_id=property.id ORDER BY calendar_revision DESC LIMIT 1
       ) calendar ON TRUE
       WHERE property.id=$1::uuid
       FOR SHARE OF property, setting`,
      [propertyId],
    )
  ).rows[0];
  const location = (
    await client.query<LocationRow>(
      `SELECT timezone AS "propertyTimeZone" FROM hotel_catalog.property_locations
       WHERE property_id=$1::uuid FOR SHARE`,
      [propertyId],
    )
  ).rows[0];
  const pricing = (
    await client.query<PricingRow>(
      `SELECT pricing_currency_revision AS "pricingCurrencyRevision",
              optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision"
       FROM pms.property_pricing_settings WHERE property_id=$1::uuid FOR SHARE`,
      [propertyId],
    )
  ).rows[0];
  if (
    !root?.enabled ||
    !location?.propertyTimeZone ||
    !root.organizationId ||
    root.operatingCalendarRevision === null ||
    !pricing ||
    pricing.pricingCurrencyRevision === null ||
    pricing.optionalPricingAggregateRevision === null
  ) {
    return null;
  }
  const rooms = await client.query<RoomRow>(
    `SELECT id::text AS "roomTypeId", room_facts_revision AS "roomFactsRevision",
            room_units_revision AS "roomUnitsRevision"
     FROM pms.room_types WHERE property_id=$1::uuid AND active IS TRUE ORDER BY id FOR SHARE`,
    [propertyId],
  );
  const plans = await client.query<PlanRow>(
    `SELECT room_type_id::text AS "roomTypeId",
            flexible_rate_plan_revision AS "flexibleRatePlanRevision"
     FROM pms.rate_plans plan
     JOIN pms.room_types room ON room.id=plan.room_type_id AND room.property_id=plan.property_id
     WHERE plan.property_id=$1::uuid AND room.active IS TRUE
       AND plan.pricing_contract_version='pms-pricing.v1'
     ORDER BY plan.room_type_id FOR SHARE OF plan`,
    [propertyId],
  );
  if (rooms.rows.length === 0) return null;
  const settingRevision = positive(root.settingRevision);
  const setting = Object.freeze({
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId,
    revision: settingRevision,
    enabled: true,
    mode: root.mode,
    rollingMonths:
      root.rollingMonths === null ? null : (positive(root.rollingMonths) as 12 | 18 | 24),
    fixedEndMonth:
      root.fixedEndMonth === null ? null : databaseDate(root.fixedEndMonth).slice(0, 7),
    updatedAt: null,
  });
  if (!isPmsCalendarAutoOpenConfiguration(setting)) {
    throw new PermanentAutoOpenError("Calendar auto-open setting source is invalid");
  }
  return {
    organizationId: root.organizationId,
    setting,
    source: createPmsCalendarAutoOpenSource({
      settingRevision,
      propertyProfileRevision: positive(root.propertyProfileRevision),
      propertyTimeZone: location.propertyTimeZone,
      operatingCalendarRevision: positive(root.operatingCalendarRevision),
      rooms: rooms.rows.map((room) => ({
        roomTypeId: room.roomTypeId,
        roomFactsRevision: positive(room.roomFactsRevision),
        roomUnitsRevision: positive(room.roomUnitsRevision),
      })),
      pricing: {
        pricingCurrencyRevision: positive(pricing.pricingCurrencyRevision),
        flexibleRatePlans: plans.rows.map((plan) => ({
          roomTypeId: plan.roomTypeId,
          flexibleRatePlanRevision: positive(plan.flexibleRatePlanRevision),
        })),
        optionalPricingAggregateRevision: nonNegative(pricing.optionalPricingAggregateRevision),
      },
    }),
  };
}

function sourceMatchesJob(
  current: { source: PmsCalendarAutoOpenSource; organizationId: string },
  payload: PmsCalendarAutoOpenJobPayload,
): boolean {
  return (
    current.organizationId === payload.organizationId &&
    fingerprintPmsCalendarAutoOpenSource(current.source) === payload.sourceFingerprint &&
    JSON.stringify(current.source) === JSON.stringify(payload.source) &&
    JSON.stringify(current.source.rooms.map(({ roomTypeId }) => roomTypeId)) ===
      JSON.stringify(payload.roomTypeIds)
  );
}

function configurationMatchesSource(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  source: PmsCalendarAutoOpenSource,
): boolean {
  return (
    configuration.calendarRevision === source.operatingCalendarRevision &&
    configuration.sourceInputs.propertyTimeZone === source.propertyTimeZone &&
    configuration.sourceInputs.propertyProfile.revision ===
      `profile:${source.propertyProfileRevision}` &&
    JSON.stringify(
      configuration.sourceInputs.roomBindings.map((room) => ({
        roomTypeId: room.roomTypeId,
        roomFactsRevision: room.sourceRoomFactsRevision,
        roomUnitsRevision: room.sourceRoomUnitsRevision,
      })),
    ) === JSON.stringify(source.rooms)
  );
}

function materializationCommand(
  job: ValidJob,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  horizon: { from: string; through: string },
  now: Date,
): PmsInventoryMaterializationCommand {
  return {
    organizationId: job.payload.organizationId,
    propertyId: job.payload.propertyId,
    configurationSource: configuration.source,
    expectedMaterializedRevision: configuration.calendarRevision,
    horizon,
    idempotencyKey: `${job.jobKey}:${horizon.from}:${horizon.through}`,
    audit: {
      actor: { kind: "system", service: "pms-calendar-auto-open-worker" },
      requestId: job.jobId,
      correlationId: job.correlationId,
      requestedAt: now.toISOString(),
    },
  };
}

async function enqueueProjectionRefresh(
  client: Client,
  job: ValidJob,
  coverage: PmsInventoryCoverageEvidence,
  reason: PmsInventoryProjectionRefreshIntent["reason"],
  now: Date,
): Promise<{ eventId: string; outboxEventId: string }> {
  const intent: PmsInventoryProjectionRefreshIntent = {
    contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
    destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
    eventType: "pms.inventory.projection_refresh_requested",
    organizationId: job.payload.organizationId,
    propertyId: job.payload.propertyId,
    configurationSource: coverage.configurationSource,
    materializedRevision: coverage.materializedRevision,
    coverageFrom: coverage.coverageFrom,
    coverageThrough: coverage.coverageThrough,
    roomTypeIds: coverage.roomTypeIds,
    reason,
  };
  const eventKey = `${job.jobKey}:projection:v1`;
  const event = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events(
         source_system,event_key,event_type,event_version,occurred_at,tenant_scope,
         property_id,resource_product,resource_type,resource_id,actor_type,
         correlation_id,causation_id,idempotency_key_hash,payload,event_metadata,privacy_scope)
       VALUES('pms',$1,$2,1,$3::timestamptz,'property',$4::uuid,'pms','property',$4,
         'system',$5,$6::uuid,$7,$8::jsonb,$9::jsonb,'confidential')
       ON CONFLICT(source_system,event_key) DO NOTHING RETURNING id::text AS "eventId"
     ) SELECT "eventId" FROM inserted UNION ALL
       SELECT id::text FROM platform.domain_events WHERE source_system='pms' AND event_key=$1 LIMIT 1`,
    [
      eventKey,
      intent.eventType,
      now.toISOString(),
      job.payload.propertyId,
      job.correlationId ?? job.jobId,
      job.jobId,
      sha256(job.jobKey),
      JSON.stringify(intent),
      JSON.stringify({ contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("Calendar auto-open projection event was not persisted");
  const outbox = await client.query<{ outboxEventId: string }>(
    `INSERT INTO platform.outbox_events(
       domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
       resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,
       payload,outbox_metadata)
     VALUES($1::uuid,$2,$3,$4,'property',$5::uuid,'pms','property',$5,$6,$7,$8::jsonb,$9::jsonb)
     ON CONFLICT(destination,outbox_key) DO UPDATE SET outbox_key=EXCLUDED.outbox_key
     RETURNING id::text AS "outboxEventId"`,
    [
      eventId,
      `${eventKey}:outbox`,
      PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
      intent.eventType,
      job.payload.propertyId,
      job.correlationId ?? job.jobId,
      sha256(job.jobKey),
      JSON.stringify(intent),
      JSON.stringify({ contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION }),
    ],
  );
  const outboxEventId = outbox.rows[0]?.outboxEventId;
  if (!outboxEventId) throw new Error("Calendar auto-open projection outbox was not persisted");
  return { eventId, outboxEventId };
}

async function enqueueAriChanges(
  client: Client,
  job: ValidJob,
  changes: readonly ChangeRange[],
  rateReadyRoomTypeIds: ReadonlySet<string>,
  now: Date,
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const range of mergeRanges(changes)) {
    const eventKey = `${job.jobKey}:room:${range.roomTypeId}:${range.from}:${range.through}:v1`;
    const payload = JSON.stringify({
      propertyId: job.payload.propertyId,
      roomTypeId: range.roomTypeId,
      dateRange: { from: range.from, to: range.through },
      inventoryVersion: job.payload.sourceFingerprint,
      rateGateOpen: rateReadyRoomTypeIds.has(range.roomTypeId),
      triggerRefId: job.jobId,
    });
    const event = await client.query<{ eventId: string }>(
      `WITH inserted AS (
         INSERT INTO platform.domain_events(
           source_system,event_key,event_type,event_version,occurred_at,tenant_scope,
           property_id,resource_product,resource_type,resource_id,actor_type,
           correlation_id,causation_id,idempotency_key_hash,payload,event_metadata)
         VALUES('pms',$1,'pms.inventory.changed',1,$2::timestamptz,'property',$3::uuid,
           'pms','room_type',$4::uuid,'system',$5,$6::uuid,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(source_system,event_key) DO NOTHING RETURNING id::text AS "eventId"
       ) SELECT "eventId" FROM inserted UNION ALL
         SELECT id::text FROM platform.domain_events WHERE source_system='pms' AND event_key=$1 LIMIT 1`,
      [
        eventKey,
        now.toISOString(),
        job.payload.propertyId,
        range.roomTypeId,
        job.correlationId ?? job.jobId,
        job.jobId,
        sha256(job.jobKey),
        payload,
        JSON.stringify({ contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION }),
      ],
    );
    const eventId = event.rows[0]?.eventId;
    if (!eventId) throw new Error("Calendar auto-open inventory event was not persisted");
    const outbox = await client.query<{ outboxEventId: string }>(
      `INSERT INTO platform.outbox_events(
         domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,
         payload,outbox_metadata)
       VALUES($1::uuid,$2,'pms.channel-manager','pms.inventory.ari_changed','property',$3::uuid,
         'pms','room_type',$4::uuid,$5,$6,$7::jsonb,$8::jsonb)
       ON CONFLICT(destination,outbox_key) DO UPDATE SET outbox_key=EXCLUDED.outbox_key
       RETURNING id::text AS "outboxEventId"`,
      [
        eventId,
        `${eventKey}:ari`,
        job.payload.propertyId,
        range.roomTypeId,
        job.correlationId ?? job.jobId,
        sha256(job.jobKey),
        payload,
        JSON.stringify({ contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION }),
      ],
    );
    if (!outbox.rows[0]) throw new Error("Calendar auto-open ARI outbox was not persisted");
    ids.push(outbox.rows[0].outboxEventId);
  }
  return Object.freeze(ids);
}

async function recordApplicationResult(
  client: Client,
  job: ValidJob,
  result: PmsCalendarAutoOpenApplicationResult,
  now: Date,
): Promise<PmsCalendarAutoOpenApplicationResult> {
  const saved = await client.query(
    `UPDATE platform.jobs SET job_metadata=jsonb_set(job_metadata,$2::text[],$3::jsonb,true),
       updated_at=$4::timestamptz
     WHERE id=$1::uuid AND status='running' RETURNING id`,
    [job.jobId, [RESULT_KEY], JSON.stringify(result), now.toISOString()],
  );
  if (saved.rowCount !== 1) throw new Error("Calendar auto-open result could not be recorded");
  await client.query(
    `INSERT INTO platform.product_audit_events(
       audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
       target_resource_product,target_resource_type,target_resource_id,job_id,
       correlation_id,redacted_payload,audit_metadata,privacy_scope)
     VALUES($1,'pms','pms.calendar_auto_open.applied',$2::timestamptz,'property',$3::uuid,
       'system','pms','property',$3,$4::uuid,$5,$6::jsonb,$7::jsonb,'confidential')
     ON CONFLICT(product,audit_key) DO NOTHING`,
    [
      `${job.jobKey}:application-audit:v1`,
      now.toISOString(),
      job.payload.propertyId,
      job.jobId,
      job.correlationId ?? job.jobId,
      JSON.stringify({
        sourceFingerprint: job.payload.sourceFingerprint,
        horizon: result.coverage,
        outcome: result.outcome,
        changedDayCount: result.changedDayCount,
        warningCount: result.warnings.length,
        materializedRevision: result.materializedRevision,
        projectionOutboxEventId: result.projectionOutboxEventId,
        ariOutboxEventIds: result.ariOutboxEventIds,
      }),
      JSON.stringify({ contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION }),
    ],
  );
  return Object.freeze(result);
}

async function readAppliedResult(
  client: Client,
  job: ValidJob,
): Promise<PmsCalendarAutoOpenApplicationResult | null> {
  const row = (
    await client.query<{ result: unknown }>(
      `SELECT job_metadata->$2 AS result FROM platform.jobs WHERE id=$1::uuid FOR UPDATE`,
      [job.jobId, RESULT_KEY],
    )
  ).rows[0];
  return parseApplicationResult(row?.result);
}

async function succeed(
  pool: Pool,
  job: PmsCalendarAutoOpenWorkerJob,
  result: PmsCalendarAutoOpenApplicationResult,
  input: { workerId: string; now: Date },
): Promise<void> {
  await transaction(pool, async (client) => {
    await assertLease(client, job, input.workerId, input.now);
    const attempt = await client.query(
      `UPDATE platform.job_attempts SET status='succeeded',finished_at=$4::timestamptz,
         error_metadata=error_metadata||jsonb_build_object('applicationOutcome',$5::text)
       WHERE job_id=$1::uuid AND attempt_number=$2 AND worker_id=$3 AND status='running'`,
      [job.jobId, job.attemptNumber, input.workerId, input.now.toISOString(), result.outcome],
    );
    const saved = await client.query(
      `UPDATE platform.jobs SET status='succeeded',finished_at=$4::timestamptz,
         locked_at=NULL,locked_by=NULL,updated_at=$4::timestamptz
       WHERE id=$1::uuid AND locked_by=$2 AND attempts_count=$3 AND status='running'`,
      [job.jobId, input.workerId, job.attemptNumber, input.now.toISOString()],
    );
    if (attempt.rowCount !== 1 || saved.rowCount !== 1)
      throw new Error("Calendar auto-open lease was lost");
    await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',completed_at=$3::timestamptz,
         response_status_code=200,response_resource_product='pms',response_resource_type='property',
         response_resource_id=$2,last_seen_at=$3::timestamptz,
         idempotency_metadata=idempotency_metadata||jsonb_build_object('result',$4::jsonb)
       WHERE operation_scope='pms' AND operation='calendar_auto_open'
         AND key_hash=$1 AND property_id=$2::uuid`,
      [sha256(job.jobKey), job.propertyId, input.now.toISOString(), JSON.stringify(result)],
    );
  });
}

async function fail(
  pool: Pool,
  job: PmsCalendarAutoOpenWorkerJob,
  error: unknown,
  input: { workerId: string; now: Date },
): Promise<"retry_scheduled" | "dead_lettered"> {
  return transaction(pool, async (client) => {
    await assertLease(client, job, input.workerId, input.now);
    const retryable = !(error instanceof PermanentAutoOpenError);
    const retry = retryable && job.attemptNumber < job.maxAttempts;
    const message = errorMessage(error);
    const retryAt = new Date(
      input.now.getTime() + Math.min(60_000, 1_000 * 2 ** (job.attemptNumber - 1)),
    );
    const attempt = await client.query(
      `UPDATE platform.job_attempts SET status='failed',finished_at=$4::timestamptz,
         error_type=$5,error_message=$6,retry_after=$7::timestamptz,
         error_metadata=error_metadata||jsonb_build_object('retryable',$8::boolean)
       WHERE job_id=$1::uuid AND attempt_number=$2 AND worker_id=$3 AND status='running'`,
      [
        job.jobId,
        job.attemptNumber,
        input.workerId,
        input.now.toISOString(),
        retryable ? "application_failed" : "invalid_application",
        message,
        retry ? retryAt.toISOString() : null,
        retry,
      ],
    );
    if (attempt.rowCount !== 1) throw new Error("Calendar auto-open attempt lease was lost");
    if (retry) {
      const saved = await client.query(
        `UPDATE platform.jobs SET status='pending',run_after=$4::timestamptz,
           locked_at=NULL,locked_by=NULL,updated_at=$5::timestamptz,
           job_metadata=job_metadata||jsonb_build_object('lastError',$6::text)
         WHERE id=$1::uuid AND locked_by=$2 AND attempts_count=$3 AND status='running'`,
        [
          job.jobId,
          input.workerId,
          job.attemptNumber,
          retryAt.toISOString(),
          input.now.toISOString(),
          message,
        ],
      );
      if (saved.rowCount !== 1) throw new Error("Calendar auto-open job lease was lost");
      return "retry_scheduled";
    }
    const saved = await client.query(
      `UPDATE platform.jobs SET status='dead_lettered',finished_at=$4::timestamptz,
         locked_at=NULL,locked_by=NULL,updated_at=$4::timestamptz,
         job_metadata=job_metadata||jsonb_build_object('lastError',$5::text)
       WHERE id=$1::uuid AND locked_by=$2 AND attempts_count=$3 AND status='running'`,
      [job.jobId, input.workerId, job.attemptNumber, input.now.toISOString(), message],
    );
    if (saved.rowCount !== 1) throw new Error("Calendar auto-open job lease was lost");
    await client.query(
      `INSERT INTO platform.dead_letter_events(
         source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,
         resource_type,resource_id,correlation_id,idempotency_key_hash,reason_code,
         failure_summary,failure_payload)
       SELECT 'job',$1::uuid,attempt.id,'property',$2::uuid,'pms','property',$2,$3,$4,
         $5,$6,jsonb_build_object('attemptCount',$7::integer,'replayEligible',$8::boolean)
       FROM platform.job_attempts attempt
       WHERE attempt.job_id=$1::uuid AND attempt.attempt_number=$7 ON CONFLICT DO NOTHING`,
      [
        job.jobId,
        job.propertyId,
        job.correlationId,
        sha256(job.jobKey),
        retryable ? "max_attempts_exhausted" : "non_retryable_error",
        message,
        job.attemptNumber,
        retryable,
      ],
    );
    return "dead_lettered";
  });
}

async function assertLease(
  client: Client,
  job: PmsCalendarAutoOpenWorkerJob,
  workerId: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE platform.jobs SET locked_at=$4::timestamptz,updated_at=$4::timestamptz
     WHERE id=$1::uuid AND locked_by=$2 AND attempts_count=$3 AND status='running' RETURNING id`,
    [job.jobId, workerId, job.attemptNumber, now.toISOString()],
  );
  if (result.rowCount !== 1) throw new Error("Calendar auto-open job lease was lost");
}

async function schedulerIdempotencyId(client: Client, job: ValidJob): Promise<string> {
  const row = (
    await client.query<{ id: string }>(
      `SELECT id::text FROM platform.idempotency_keys
       WHERE operation_scope='pms' AND operation='calendar_auto_open'
         AND key_hash=$1 AND property_id=$2::uuid FOR UPDATE`,
      [sha256(job.jobKey), job.payload.propertyId],
    )
  ).rows[0];
  if (!row) throw new Error("Calendar auto-open scheduler idempotency evidence is missing");
  return row.id;
}

function parsePayload(value: unknown): PmsCalendarAutoOpenJobPayload {
  if (!record(value)) throw new PermanentAutoOpenError("Calendar auto-open payload is invalid");
  const source = parseSource(value["source"]);
  const propertyId = uuid(value["propertyId"]);
  const organizationId = uuid(value["organizationId"]);
  const openFrom = date(value["openFrom"]);
  const openThrough = date(value["openThrough"]);
  const generatedCoverageThrough =
    value["generatedCoverageThrough"] === null ? null : date(value["generatedCoverageThrough"]);
  const sourceFingerprint = text(value["sourceFingerprint"]);
  const roomTypeIds = Array.isArray(value["roomTypeIds"])
    ? value["roomTypeIds"].map(uuid).sort()
    : [];
  if (
    !source ||
    !propertyId ||
    !organizationId ||
    !openFrom ||
    !openThrough ||
    openThrough < openFrom ||
    dayCount(openFrom, maxDate(openThrough, generatedCoverageThrough)) >
      PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS ||
    !sourceFingerprint ||
    sourceFingerprint !== fingerprintPmsCalendarAutoOpenSource(source) ||
    roomTypeIds.length !== source.rooms.length ||
    JSON.stringify(roomTypeIds) !== JSON.stringify(source.rooms.map(({ roomTypeId }) => roomTypeId))
  ) {
    throw new PermanentAutoOpenError("Calendar auto-open payload is invalid");
  }
  return Object.freeze({
    propertyId,
    organizationId,
    openFrom,
    openThrough,
    roomTypeIds: Object.freeze(roomTypeIds),
    generatedCoverageThrough,
    source,
    sourceFingerprint,
  });
}

function parseSource(value: unknown): PmsCalendarAutoOpenSource | null {
  if (!record(value) || !Array.isArray(value["rooms"]) || !record(value["pricing"])) return null;
  try {
    const pricing = value["pricing"];
    if (!Array.isArray(pricing["flexibleRatePlans"])) return null;
    return createPmsCalendarAutoOpenSource({
      settingRevision: positive(value["settingRevision"]),
      propertyProfileRevision: positive(value["propertyProfileRevision"]),
      propertyTimeZone: text(value["propertyTimeZone"]),
      operatingCalendarRevision: positive(value["operatingCalendarRevision"]),
      rooms: value["rooms"].map((room) => {
        if (!record(room)) throw new Error("invalid room");
        return {
          roomTypeId: uuid(room["roomTypeId"]),
          roomFactsRevision: positive(room["roomFactsRevision"]),
          roomUnitsRevision: positive(room["roomUnitsRevision"]),
        };
      }),
      pricing: {
        pricingCurrencyRevision: positive(pricing["pricingCurrencyRevision"]),
        flexibleRatePlans: pricing["flexibleRatePlans"].map((plan) => {
          if (!record(plan)) throw new Error("invalid plan");
          return {
            roomTypeId: uuid(plan["roomTypeId"]),
            flexibleRatePlanRevision: positive(plan["flexibleRatePlanRevision"]),
          };
        }),
        optionalPricingAggregateRevision: nonNegative(pricing["optionalPricingAggregateRevision"]),
      },
    });
  } catch {
    return null;
  }
}

function parseApplicationResult(value: unknown): PmsCalendarAutoOpenApplicationResult | null {
  if (!record(value) || !record(value["coverage"])) return null;
  const outcome = value["outcome"];
  const from = date(value["coverage"]["from"]);
  const through = date(value["coverage"]["through"]);
  if (
    (outcome !== "applied" && outcome !== "partial" && outcome !== "unchanged") ||
    !from ||
    !through ||
    !Number.isSafeInteger(value["changedDayCount"]) ||
    !Number.isSafeInteger(value["materializedRevision"]) ||
    !Array.isArray(value["warnings"]) ||
    !Array.isArray(value["ariOutboxEventIds"])
  ) {
    return null;
  }
  return value as PmsCalendarAutoOpenApplicationResult;
}

function unchangedResult(job: ValidJob): PmsCalendarAutoOpenApplicationResult {
  return {
    outcome: "unchanged",
    changedDayCount: 0,
    warnings: Object.freeze([]),
    materializedRevision: job.payload.source.operatingCalendarRevision,
    coverage: {
      from: job.payload.openFrom,
      through: maxDate(job.payload.openThrough, job.payload.generatedCoverageThrough),
    },
    projectionOutboxEventId: null,
    ariOutboxEventIds: Object.freeze([]),
  };
}

function dateBatches(from: string, through: string): readonly { from: string; through: string }[] {
  const start = dateTimestamp(from);
  const end = dateTimestamp(through);
  if (start === null || end === null || end < start) {
    throw new PermanentAutoOpenError("Calendar auto-open horizon is invalid");
  }
  const result: { from: string; through: string }[] = [];
  for (let cursor = start; cursor <= end; cursor += PMS_INVENTORY_HORIZON_MAX_DAYS * DAY_MS) {
    result.push({
      from: timestampDate(cursor),
      through: timestampDate(Math.min(end, cursor + (PMS_INVENTORY_HORIZON_MAX_DAYS - 1) * DAY_MS)),
    });
  }
  return result;
}

function inclusiveDates(from: string, through: string): string[] {
  const start = dateTimestamp(from);
  const end = dateTimestamp(through);
  if (start === null || end === null || end < start) {
    throw new PermanentAutoOpenError("Calendar auto-open horizon is invalid");
  }
  const count = (end - start) / DAY_MS + 1;
  if (!Number.isSafeInteger(count))
    throw new PermanentAutoOpenError("Calendar auto-open horizon is invalid");
  return Array.from({ length: count }, (_, index) => timestampDate(start + index * DAY_MS));
}

function dayCount(from: string, through: string): number {
  const start = dateTimestamp(from);
  const end = dateTimestamp(through);
  const count = start === null || end === null ? 0 : (end - start) / DAY_MS + 1;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new PermanentAutoOpenError("Calendar auto-open horizon is invalid");
  }
  return count;
}

function warningsFromRanges(ranges: readonly ChangeRange[]): readonly PmsCalendarAutoOpenWarning[] {
  return Object.freeze(
    mergeRanges(ranges).map(({ roomTypeId, from, through }) => ({
      code: "missing_rate" as const,
      roomTypeId,
      from,
      through,
    })),
  );
}

function changedRanges(days: readonly PmsInventoryDaySnapshot[]) {
  return collapseChanges(days).map((range) => ({
    roomTypeId: range.roomTypeId,
    startsOn: range.from,
    endsOn: range.through,
  }));
}

function collapseChanges(changes: readonly { roomTypeId: string; stayDate: string }[]) {
  const grouped = new Map<string, string[]>();
  for (const change of changes) {
    const values = grouped.get(change.roomTypeId) ?? [];
    values.push(change.stayDate);
    grouped.set(change.roomTypeId, values);
  }
  return [...grouped.entries()].flatMap(([roomTypeId, values]) =>
    collapseDates(values).map((range) => ({ roomTypeId, ...range })),
  );
}

type ChangeRange = { roomTypeId: string; from: string; through: string };

function mergeRanges(ranges: readonly ChangeRange[]): ChangeRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.roomTypeId.localeCompare(right.roomTypeId) || left.from.localeCompare(right.from),
  );
  const merged: ChangeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous?.roomTypeId === range.roomTypeId &&
      (range.from <= previous.through || nextDate(previous.through) === range.from)
    ) {
      if (range.through > previous.through) previous.through = range.through;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function collapseDates(values: readonly string[]) {
  const sorted = [...new Set(values)].sort();
  const ranges: { from: string; through: string }[] = [];
  for (const value of sorted) {
    const previous = ranges.at(-1);
    if (previous && nextDate(previous.through) === value) previous.through = value;
    else ranges.push({ from: value, through: value });
  }
  return ranges;
}

function dayKey(day: { roomTypeId: string; stayDate: string }) {
  return `${day.roomTypeId}:${day.stayDate}`;
}
function nextDate(value: string) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}
function dateTimestamp(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && timestampDate(parsed) === value ? parsed : null;
}
function timestampDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}
function databaseDate(value: unknown): string {
  return value instanceof Date
    ? date(
        `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
          value.getDate(),
        ).padStart(2, "0")}`,
      )
    : date(value);
}
function maxDate(left: string, right: string | null) {
  return right && right > left ? right : left;
}
function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function required(value: string) {
  if (!value.trim()) throw new Error("Calendar auto-open connectionString must not be empty");
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected text");
  return value;
}
function uuid(value: unknown): string {
  const parsed = text(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed))
    throw new Error("Expected UUID");
  return parsed;
}
function date(value: unknown): string {
  const parsed = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed) ||
    new Date(`${parsed}T00:00:00Z`).toISOString().slice(0, 10) !== parsed
  )
    throw new Error("Expected date");
  return parsed;
}
function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Expected integer");
  return parsed;
}
function positive(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 1) throw new Error("Expected positive integer");
  return parsed;
}
function nonNegative(value: unknown): number {
  return integer(value);
}
function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Calendar auto-open failed").slice(0, 500);
}

class PermanentAutoOpenError extends Error {}

async function transaction<T>(pool: Pool, callback: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
