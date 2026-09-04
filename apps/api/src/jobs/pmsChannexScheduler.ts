import { createHash } from "node:crypto";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  calculatePmsCalendarAutoOpenHorizon,
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
  isPmsCalendarAutoOpenFixedTargetWithinLimit,
  type PmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";
import pg from "pg";

export const PMS_CHANNEX_SCHEDULER_QUEUE = "pms.channex.scheduler";
export const PMS_CALENDAR_AUTO_OPEN_QUEUE = "pms.inventory.scheduler";
export const DEFAULT_PMS_CHANNEX_LIMIT = 100;
export const DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS = 5;
export const DEFAULT_FULL_ARI_DAYS_AHEAD = 548;

export type PmsChannexSchedulerRunName = "incrementalAriPush" | "fullAriPush" | "calendarAutoOpen";

export type PmsChannexAriPushSource = "incremental" | "full";

export type PmsChannexAriPushCandidate = {
  source: PmsChannexAriPushSource;
  propertyId: string;
  organizationId: string;
  connectionId: string;
  channexPropertyId: string;
  roomTypeId: string;
  channexRoomTypeId: string;
  dateRange: {
    from: string;
    to: string;
  };
  inventoryVersion: string;
  rateGateOpen: boolean;
  triggerRefId: string;
  sourceOutboxEventId?: string;
  outboxKey?: string;
  correlationId?: string;
};

export type PmsCalendarAutoOpenCandidate = {
  propertyId: string;
  organizationId: string;
  openFrom: string;
  openThrough: string;
  roomTypeIds: string[];
  generatedCoverageThrough: string | null;
  source: PmsCalendarAutoOpenSource;
  sourceFingerprint: string;
  correlationId?: string;
};

export type PmsChannexSchedulerContext = {
  now: Date;
  workerId: string;
  correlationId: string;
};

export type PmsChannexAriPushJob = {
  jobId: string;
  jobKey: string;
  domainEventKey: string;
  status: "queued" | "running" | "succeeded" | "retry_scheduled" | "dead_lettered";
  attemptsMade: number;
  maxAttempts: number;
  payload: PmsChannexAriPushCandidate;
};

export type PmsChannexJobEnqueueResult = {
  createdNewJob: boolean;
  job: PmsChannexAriPushJob;
};

export type PmsCalendarAutoOpenResult = {
  candidate: PmsCalendarAutoOpenCandidate;
  createdNewJob: boolean;
  eventKey: string;
  jobKey: string;
};

export type PmsCalendarAutoOpenFailure = {
  propertyId: string;
  stage: "selection" | "enqueue";
  message: string;
};

export type PmsCalendarAutoOpenSelection = {
  candidates: PmsCalendarAutoOpenCandidate[];
  failures: PmsCalendarAutoOpenFailure[];
};

export type ChannexProviderAttemptRecord = {
  jobId: string;
  jobKey: string;
  idempotencyKey: string;
  attemptNumber: number;
  provider: "channex";
  providerRequestId?: string;
  requestPayloadHash: string;
  status: "succeeded" | "failed";
  statusCode?: number;
  errorCategory?: PmsChannexProviderFailureCategory;
  errorMessage?: string;
  retryable: boolean;
  recordedAt: string;
  workerId: string;
};

export type PmsChannexProviderFailureCategory =
  | "provider_429"
  | "provider_5xx"
  | "network_timeout"
  | "mapping_missing"
  | "provider_rejected"
  | "validation_failed";

export type ChannexAriProviderSuccess = {
  ok: true;
  providerRequestId: string;
  statusCode: number;
};

export type ChannexAriProviderFailure = {
  ok: false;
  providerRequestId?: string;
  statusCode?: number;
  retryable: boolean;
  errorCategory: PmsChannexProviderFailureCategory;
  message: string;
};

export type ChannexAriProviderResult = ChannexAriProviderSuccess | ChannexAriProviderFailure;

export type ChannexAriProvider = {
  pushAri(
    job: PmsChannexAriPushJob,
    context: PmsChannexSchedulerContext,
  ): Promise<ChannexAriProviderResult>;
};

export type PmsChannexDeadLetterRecord = {
  jobId: string;
  jobKey: string;
  idempotencyKey: string;
  reasonCode: "max_attempts_exhausted" | "non_retryable_error";
  errorCategory: PmsChannexProviderFailureCategory;
  failureSummary: string;
  attemptCount: number;
  replayEligible: boolean;
  ownerPackage: "backend-events";
  createdAt: string;
};

export type PmsChannexSchedulerStore = {
  findIncrementalAriPushCandidates(now: Date, limit: number): Promise<PmsChannexAriPushCandidate[]>;
  findFullAriPushCandidates(now: Date, limit: number): Promise<PmsChannexAriPushCandidate[]>;
  findCalendarAutoOpenCandidates(now: Date, limit: number): Promise<PmsCalendarAutoOpenSelection>;
  enqueueAriPushJob(
    candidate: PmsChannexAriPushCandidate,
    context: PmsChannexSchedulerContext,
  ): Promise<PmsChannexJobEnqueueResult>;
  recordChannexProviderAttempt(attempt: ChannexProviderAttemptRecord): Promise<void>;
  markAriPushSucceeded(
    job: PmsChannexAriPushJob,
    attempt: ChannexProviderAttemptRecord,
    context: PmsChannexSchedulerContext,
  ): Promise<void>;
  scheduleAriPushRetry(
    job: PmsChannexAriPushJob,
    attempt: ChannexProviderAttemptRecord,
    failure: ChannexAriProviderFailure,
    retryAt: Date,
    context: PmsChannexSchedulerContext,
  ): Promise<void>;
  deadLetterAriPush(
    job: PmsChannexAriPushJob,
    attempt: ChannexProviderAttemptRecord,
    failure: ChannexAriProviderFailure,
    context: PmsChannexSchedulerContext,
  ): Promise<PmsChannexDeadLetterRecord>;
  enqueueCalendarAutoOpenJob(
    candidate: PmsCalendarAutoOpenCandidate,
    context: PmsChannexSchedulerContext,
  ): Promise<PmsCalendarAutoOpenResult>;
};

export type PmsChannexSchedulerOptions = {
  now?: Date;
  workerId?: string;
  limit?: number;
  run?: readonly PmsChannexSchedulerRunName[];
};

export type PgPmsChannexSchedulerStoreConfig = {
  connectionString: string;
  max?: number;
  fullAriDaysAhead?: number;
};

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type AriCandidateRow = {
  source: PmsChannexAriPushSource;
  propertyId: string;
  organizationId: string;
  connectionId: string;
  channexPropertyId: string;
  roomTypeId: string;
  channexRoomTypeId: string;
  dateFrom: string | Date;
  dateTo: string | Date;
  inventoryVersion: string;
  rateGateOpen: boolean;
  triggerRefId: string;
  sourceOutboxEventId?: string | null;
  outboxKey?: string | null;
  correlationId?: string | null;
};

type CalendarSourceRow = {
  propertyId: string;
  organizationId: string | null;
  settingRevision: number | string;
  mode: "rolling" | "fixed";
  rollingMonths: number | string | null;
  fixedEndMonth: string | Date | null;
  propertyProfileRevision: number | string;
  propertyTimeZone: string | null;
  operatingCalendarRevision: number | string | null;
  rooms: Array<{
    roomTypeId: string;
    roomFactsRevision: number | string;
    roomUnitsRevision: number | string;
  }>;
  pricingCurrencyRevision: number | string | null;
  flexibleRatePlans: Array<{
    roomTypeId: string;
    flexibleRatePlanRevision: number | string;
  }>;
  optionalPricingAggregateRevision: number | string | null;
  generatedCoverageFrom: string | Date | null;
  generatedCoverageThrough: string | Date | null;
  successfulApplications: Array<{
    sourceFingerprint: string;
    openThrough: string;
  }>;
};

export type PmsChannexSchedulerRunResult = {
  name: PmsChannexSchedulerRunName;
  scanned: number;
  enqueued: number;
  reused: number;
  providerAttempts: number;
  succeeded: number;
  retryScheduled: number;
  deadLettered: number;
  autoOpenEnqueued: number;
  autoOpenFailures: PmsCalendarAutoOpenFailure[];
};

export type PmsChannexSchedulerResult = {
  runs: PmsChannexSchedulerRunResult[];
  scanned: number;
  enqueued: number;
  reused: number;
  providerAttempts: number;
  succeeded: number;
  retryScheduled: number;
  deadLettered: number;
  autoOpenEnqueued: number;
  autoOpenFailures: PmsCalendarAutoOpenFailure[];
};

const SCHEDULER_RUNS: readonly PmsChannexSchedulerRunName[] = [
  "incrementalAriPush",
  "fullAriPush",
  "calendarAutoOpen",
];

export function createPgPmsChannexSchedulerStore(
  config: PgPmsChannexSchedulerStoreConfig,
): PmsChannexSchedulerStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
  const fullAriDaysAhead = config.fullAriDaysAhead ?? DEFAULT_FULL_ARI_DAYS_AHEAD;

  return {
    async findIncrementalAriPushCandidates(now, limit) {
      return selectIncrementalAriPushCandidates(pool, now, limit);
    },
    async findFullAriPushCandidates(now, limit) {
      return selectFullAriPushCandidates(pool, now, fullAriDaysAhead, limit);
    },
    async findCalendarAutoOpenCandidates(now, limit) {
      return selectCalendarAutoOpenCandidates(pool, now, limit);
    },
    async enqueueAriPushJob(candidate, context) {
      return enqueuePgAriPushJob(pool, candidate, context);
    },
    async recordChannexProviderAttempt(attempt) {
      await insertPgProviderAttempt(pool, attempt);
    },
    async markAriPushSucceeded(job, _attempt, context) {
      await pool.query(
        `UPDATE platform.jobs
         SET status = 'succeeded',
             attempts_count = GREATEST(attempts_count, $2),
             finished_at = $3::timestamptz,
             updated_at = now()
         WHERE id = $1::uuid`,
        [job.jobId, job.attemptsMade + 1, context.now.toISOString()],
      );
      job.status = "succeeded";
      job.attemptsMade += 1;
    },
    async scheduleAriPushRetry(job, _attempt, failure, retryAt, context) {
      await pool.query(
        `UPDATE platform.jobs
         SET status = 'pending',
             attempts_count = GREATEST(attempts_count, $2),
             run_after = $3::timestamptz,
             updated_at = now(),
             job_metadata = job_metadata || $4::jsonb
         WHERE id = $1::uuid`,
        [
          job.jobId,
          job.attemptsMade + 1,
          retryAt.toISOString(),
          JSON.stringify({
            retryScheduledAt: context.now.toISOString(),
            retryAfter: retryAt.toISOString(),
            lastErrorCategory: failure.errorCategory,
          }),
        ],
      );
      job.status = "retry_scheduled";
      job.attemptsMade += 1;
    },
    async deadLetterAriPush(job, attempt, failure, context) {
      return deadLetterPgAriPush(pool, job, attempt, failure, context);
    },
    async enqueueCalendarAutoOpenJob(candidate, context) {
      return enqueuePgCalendarAutoOpenJob(pool, candidate, context);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function runPmsChannexSchedulerJobs(
  store: PmsChannexSchedulerStore,
  provider: ChannexAriProvider,
  options: PmsChannexSchedulerOptions = {},
): Promise<PmsChannexSchedulerResult> {
  const now = options.now ?? new Date();
  const context: PmsChannexSchedulerContext = {
    now,
    workerId: options.workerId ?? "pms-channex-scheduler",
    correlationId: `pms.channex.scheduler:${now.toISOString()}`,
  };
  const input = {
    now,
    context,
    limit: options.limit ?? DEFAULT_PMS_CHANNEX_LIMIT,
  };
  const selectedRuns = options.run ?? SCHEDULER_RUNS;
  const runs: PmsChannexSchedulerRunResult[] = [];

  for (const runName of selectedRuns) {
    if (runName === "calendarAutoOpen") {
      runs.push(await runCalendarAutoOpen(store, input));
    } else {
      runs.push(await runAriPush(store, provider, runName, input));
    }
  }

  return {
    runs,
    scanned: sumBy(runs, "scanned"),
    enqueued: sumBy(runs, "enqueued"),
    reused: sumBy(runs, "reused"),
    providerAttempts: sumBy(runs, "providerAttempts"),
    succeeded: sumBy(runs, "succeeded"),
    retryScheduled: sumBy(runs, "retryScheduled"),
    deadLettered: sumBy(runs, "deadLettered"),
    autoOpenEnqueued: sumBy(runs, "autoOpenEnqueued"),
    autoOpenFailures: runs.flatMap(({ autoOpenFailures }) => autoOpenFailures),
  };
}

export function buildAriPushDomainEventKey(input: {
  propertyId: string;
  roomTypeId: string;
  dateRange: { from: string; to: string };
  inventoryVersion: string;
}): string {
  return `channex.push-ari:${input.propertyId}:${input.roomTypeId}:${input.dateRange.from}_${input.dateRange.to}:${input.inventoryVersion}:v1`;
}

export function buildAriPushJobKey(input: {
  roomTypeId: string;
  dateRange: { from: string; to: string };
  inventoryVersion: string;
}): string {
  return `channex.push-ari:room_type:${input.roomTypeId}:${input.dateRange.from}_${input.dateRange.to}:${input.inventoryVersion}:v1`;
}

export function buildCalendarAutoOpenEventKey(input: {
  propertyId: string;
  openThrough: string;
  sourceFingerprint: string;
}): string {
  return `pms.calendar-auto-open:${input.propertyId}:${input.openThrough}:source-${input.sourceFingerprint}:v2`;
}

export function buildCalendarAutoOpenJobKey(input: {
  propertyId: string;
  openThrough: string;
  sourceFingerprint: string;
}): string {
  return `pms.calendar-auto-open:property:${input.propertyId}:open-through-${input.openThrough}:source-${input.sourceFingerprint}:v2`;
}

export function buildPmsChannexAriPushJob(
  candidate: PmsChannexAriPushCandidate,
  jobId: string,
): PmsChannexAriPushJob {
  return {
    jobId,
    jobKey: buildAriPushJobKey(candidate),
    domainEventKey: buildAriPushDomainEventKey(candidate),
    status: "queued",
    attemptsMade: 0,
    maxAttempts: DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
    payload: candidate,
  };
}

export function channexProviderAttemptFromResult(input: {
  job: PmsChannexAriPushJob;
  result: ChannexAriProviderResult;
  context: PmsChannexSchedulerContext;
}): ChannexProviderAttemptRecord {
  const attemptNumber = input.job.attemptsMade + 1;
  const base = {
    jobId: input.job.jobId,
    jobKey: input.job.jobKey,
    idempotencyKey: input.job.jobKey,
    attemptNumber,
    provider: "channex" as const,
    requestPayloadHash: sha256Key(stableJson(input.job.payload)),
    recordedAt: input.context.now.toISOString(),
    workerId: input.context.workerId,
  };

  if (input.result.ok) {
    return {
      ...base,
      providerRequestId: input.result.providerRequestId,
      status: "succeeded",
      statusCode: input.result.statusCode,
      retryable: false,
    };
  }

  return {
    ...base,
    providerRequestId: input.result.providerRequestId,
    status: "failed",
    statusCode: input.result.statusCode,
    errorCategory: input.result.errorCategory,
    errorMessage: input.result.message,
    retryable: input.result.retryable,
  };
}

export function nextAriRetryAt(now: Date, attemptNumber: number): Date {
  const delaySeconds = Math.min(5 * 60, 2 ** Math.max(attemptNumber - 1, 0) * 30);
  return new Date(now.getTime() + delaySeconds * 1000);
}

async function runAriPush(
  store: PmsChannexSchedulerStore,
  provider: ChannexAriProvider,
  runName: Extract<PmsChannexSchedulerRunName, "incrementalAriPush" | "fullAriPush">,
  input: {
    now: Date;
    context: PmsChannexSchedulerContext;
    limit: number;
  },
): Promise<PmsChannexSchedulerRunResult> {
  const candidates =
    runName === "incrementalAriPush"
      ? await store.findIncrementalAriPushCandidates(input.now, input.limit)
      : await store.findFullAriPushCandidates(input.now, input.limit);
  const run = emptyRun(runName, candidates.length);

  for (const candidate of candidates) {
    const enqueued = await store.enqueueAriPushJob(candidate, input.context);
    if (enqueued.createdNewJob) run.enqueued += 1;
    else run.reused += 1;

    if (enqueued.job.status === "succeeded" || enqueued.job.status === "dead_lettered") {
      continue;
    }

    const providerResult = await provider.pushAri(enqueued.job, input.context);
    const attempt = channexProviderAttemptFromResult({
      job: enqueued.job,
      result: providerResult,
      context: input.context,
    });
    await store.recordChannexProviderAttempt(attempt);
    run.providerAttempts += 1;

    if (providerResult.ok) {
      await store.markAriPushSucceeded(enqueued.job, attempt, input.context);
      run.succeeded += 1;
      continue;
    }

    const attemptsExhausted = attempt.attemptNumber >= enqueued.job.maxAttempts;
    if (providerResult.retryable && !attemptsExhausted) {
      await store.scheduleAriPushRetry(
        enqueued.job,
        attempt,
        providerResult,
        nextAriRetryAt(input.now, attempt.attemptNumber),
        input.context,
      );
      run.retryScheduled += 1;
      continue;
    }

    await store.deadLetterAriPush(enqueued.job, attempt, providerResult, input.context);
    run.deadLettered += 1;
  }

  return run;
}

async function selectIncrementalAriPushCandidates(
  queryable: Queryable,
  _now: Date,
  limit: number,
): Promise<PmsChannexAriPushCandidate[]> {
  const result = await queryable.query<AriCandidateRow>(
    `SELECT
       'incremental'::text AS source,
       COALESCE(outbox.payload ->> 'propertyId', outbox.property_id::text) AS "propertyId",
       COALESCE(outbox.payload ->> 'organizationId', connection.connection_metadata ->> 'organizationId') AS "organizationId",
       connection.id::text AS "connectionId",
       connection.external_property_id AS "channexPropertyId",
       COALESCE(outbox.payload ->> 'roomTypeId', room_mapping.room_type_id::text) AS "roomTypeId",
       room_mapping.external_room_type_id AS "channexRoomTypeId",
       COALESCE(outbox.payload #>> '{dateRange,from}', outbox.payload ->> 'dateFrom') AS "dateFrom",
       COALESCE(outbox.payload #>> '{dateRange,to}', outbox.payload ->> 'dateTo') AS "dateTo",
       COALESCE(outbox.payload ->> 'inventoryVersion', outbox.id::text) AS "inventoryVersion",
       CASE
         WHEN outbox.payload ->> 'rateGateOpen' IN ('true', 'false')
           THEN (outbox.payload ->> 'rateGateOpen')::boolean
         ELSE EXISTS (
           SELECT 1 FROM pms.rate_plans canonical_rate
           WHERE canonical_rate.property_id=outbox.property_id
             AND canonical_rate.room_type_id=room_mapping.room_type_id
             AND canonical_rate.pricing_contract_version='pms-pricing.v1'
         )
       END AS "rateGateOpen",
       COALESCE(outbox.payload ->> 'triggerRefId', outbox.outbox_key) AS "triggerRefId",
       outbox.id::text AS "sourceOutboxEventId",
       outbox.outbox_key AS "outboxKey",
       outbox.correlation_id AS "correlationId"
     FROM platform.outbox_events outbox
     JOIN pms.channel_connections connection
       ON connection.property_id = outbox.property_id
      AND connection.provider = 'channex'
      AND connection.connection_status = 'connected'
     JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.connection_id = connection.id
      AND room_mapping.property_id = connection.property_id
      AND room_mapping.status = 'active'
      AND room_mapping.room_type_id::text = outbox.payload ->> 'roomTypeId'
     WHERE outbox.event_type = 'pms.inventory.ari_changed'
       AND outbox.status IN ('pending', 'failed')
       AND EXISTS (SELECT 1 FROM pms.room_types room WHERE room.id = room_mapping.room_type_id AND room.active)
       AND connection.external_property_id IS NOT NULL
       AND outbox.payload ->> 'roomTypeId' IS NOT NULL
       AND COALESCE(outbox.payload ->> 'organizationId', connection.connection_metadata ->> 'organizationId') IS NOT NULL
       AND COALESCE(outbox.payload #>> '{dateRange,from}', outbox.payload ->> 'dateFrom') IS NOT NULL
       AND COALESCE(outbox.payload #>> '{dateRange,to}', outbox.payload ->> 'dateTo') IS NOT NULL
     ORDER BY outbox.available_at ASC, outbox.created_at ASC
     LIMIT $1`,
    [limit],
  );
  void _now;
  return result.rows.map(ariCandidateFromRow);
}

async function selectFullAriPushCandidates(
  queryable: Queryable,
  now: Date,
  daysAhead: number,
  limit: number,
): Promise<PmsChannexAriPushCandidate[]> {
  const from = toDateOnly(now);
  const to = toDateOnly(new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000));
  const result = await queryable.query<AriCandidateRow>(
    `SELECT
       'full'::text AS source,
       connection.property_id::text AS "propertyId",
       connection.connection_metadata ->> 'organizationId' AS "organizationId",
       connection.id::text AS "connectionId",
       connection.external_property_id AS "channexPropertyId",
       room_mapping.room_type_id::text AS "roomTypeId",
       room_mapping.external_room_type_id AS "channexRoomTypeId",
       $1::date AS "dateFrom",
       GREATEST($2::date, COALESCE(coverage.coverage_through, $2::date)) AS "dateTo",
       $3::text AS "inventoryVersion",
       EXISTS (
         SELECT 1 FROM pms.rate_plans canonical_rate
         WHERE canonical_rate.property_id=connection.property_id
           AND canonical_rate.room_type_id=room_mapping.room_type_id
           AND canonical_rate.pricing_contract_version='pms-pricing.v1'
       ) AS "rateGateOpen",
       $3::text AS "triggerRefId",
       NULL::text AS "sourceOutboxEventId",
       NULL::text AS "outboxKey",
       $4::text AS "correlationId"
     FROM pms.channel_connections connection
     LEFT JOIN pms.inventory_materialization_coverage coverage
       ON coverage.property_id = connection.property_id
     JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.connection_id = connection.id
      AND room_mapping.property_id = connection.property_id
      AND room_mapping.status = 'active'
     WHERE connection.provider = 'channex'
       AND connection.connection_status = 'connected'
       AND EXISTS (SELECT 1 FROM pms.room_types room WHERE room.id = room_mapping.room_type_id AND room.active)
       AND connection.external_property_id IS NOT NULL
       AND connection.connection_metadata ->> 'organizationId' IS NOT NULL
     ORDER BY connection.property_id, room_mapping.room_type_id
     LIMIT $5`,
    [from, to, `full-${from}`, `pms.channex.full-ari:${from}`, limit],
  );
  return result.rows.map(ariCandidateFromRow);
}

async function selectCalendarAutoOpenCandidates(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PmsCalendarAutoOpenSelection> {
  if (!Number.isSafeInteger(limit) || limit < 1) return { candidates: [], failures: [] };
  const selected: PmsCalendarAutoOpenCandidate[] = [];
  const failures: PmsCalendarAutoOpenFailure[] = [];
  let afterPropertyId: string | null = null;

  while (selected.length < limit) {
    const page: { rows: CalendarSourceRow[] } = await queryable.query<CalendarSourceRow>(
      `WITH candidate_properties AS (
         SELECT setting.property_id
         FROM pms.calendar_auto_open_settings setting
         WHERE setting.enabled IS TRUE
           AND NOT EXISTS (
             SELECT 1
             FROM pms.rooms physical_room
             JOIN pms.room_types room_type
               ON room_type.property_id=physical_room.property_id
              AND room_type.id=physical_room.room_type_id
              AND room_type.active IS TRUE
             WHERE physical_room.property_id=setting.property_id
               AND physical_room.status<>'retired'
               AND (
                 physical_room.operational_label_status<>'verified'
                 OR physical_room.room_number IS NULL
               )
           )
           AND ($1::uuid IS NULL OR setting.property_id > $1::uuid)
         ORDER BY setting.property_id
         LIMIT $2
       )
       SELECT
         setting.property_id::text AS "propertyId",
         calendar.organization_id::text AS "organizationId",
         setting.revision AS "settingRevision",
         setting.mode,
         setting.rolling_months AS "rollingMonths",
         setting.fixed_end_month AS "fixedEndMonth",
         property.profile_revision AS "propertyProfileRevision",
         location.timezone AS "propertyTimeZone",
         calendar.calendar_revision AS "operatingCalendarRevision",
         room_source.rooms,
         pricing.pricing_currency_revision AS "pricingCurrencyRevision",
         plan_source.plans AS "flexibleRatePlans",
         pricing.optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision",
         coverage.coverage_from AS "generatedCoverageFrom",
         coverage.coverage_through AS "generatedCoverageThrough",
         successful_application.applications AS "successfulApplications"
       FROM candidate_properties candidate
       JOIN pms.calendar_auto_open_settings setting
         ON setting.property_id = candidate.property_id
       JOIN hotel_catalog.properties property ON property.id = setting.property_id
       LEFT JOIN hotel_catalog.property_locations location
         ON location.property_id = setting.property_id
       LEFT JOIN pms.property_pricing_settings pricing
         ON pricing.property_id = setting.property_id
       LEFT JOIN LATERAL (
         SELECT revision.organization_id, revision.calendar_revision
         FROM pms.operating_calendar_revisions revision
         WHERE revision.property_id = setting.property_id
         ORDER BY revision.calendar_revision DESC
         LIMIT 1
       ) calendar ON TRUE
       JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'roomTypeId', room_type.id::text,
             'roomFactsRevision', room_type.room_facts_revision,
             'roomUnitsRevision', room_type.room_units_revision
           ) ORDER BY room_type.id),
           '[]'::json
         ) AS rooms
         FROM pms.room_types room_type
         WHERE room_type.property_id = setting.property_id AND room_type.active IS TRUE
       ) room_source ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'roomTypeId', plan.room_type_id::text,
             'flexibleRatePlanRevision', plan.flexible_rate_plan_revision
           ) ORDER BY plan.room_type_id),
           '[]'::json
         ) AS plans
         FROM pms.rate_plans plan
         JOIN pms.room_types room_type
           ON room_type.id = plan.room_type_id
          AND room_type.property_id = plan.property_id
          AND room_type.active IS TRUE
         WHERE plan.property_id = setting.property_id
           AND plan.pricing_contract_version = 'pms-pricing.v1'
       ) plan_source ON TRUE
       LEFT JOIN pms.inventory_materialization_coverage coverage
         ON coverage.property_id = setting.property_id
        AND coverage.calendar_revision = calendar.calendar_revision
       JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'sourceFingerprint', job.payload ->> 'sourceFingerprint',
             'openThrough', job.payload ->> 'openThrough'
           )),
           '[]'::json
         ) AS applications
         FROM platform.jobs job
         WHERE job.property_id = setting.property_id
           AND job.queue_name = 'pms.inventory.scheduler'
           AND job.job_type = 'pms.calendar-auto-open'
           AND job.status = 'succeeded'
           AND job.resource_product = 'pms'
           AND job.resource_type = 'property'
           AND job.resource_id = setting.property_id::text
       ) successful_application ON TRUE
       ORDER BY setting.property_id`,
      [afterPropertyId, limit],
    );
    if (page.rows.length === 0) break;
    afterPropertyId = page.rows.at(-1)!.propertyId;

    const candidates = page.rows.flatMap((row) => {
      try {
        const candidate = calendarCandidateFromSourceRow(row, now);
        return candidate ? [candidate] : [];
      } catch (error) {
        failures.push({
          propertyId: row.propertyId,
          stage: "selection",
          message: errorMessage(error),
        });
        return [];
      }
    });
    const existing = await existingCalendarAutoOpenJobKeys(
      queryable,
      candidates.map(buildCalendarAutoOpenJobKey),
    );
    for (const candidate of candidates) {
      if (!existing.has(buildCalendarAutoOpenJobKey(candidate))) selected.push(candidate);
      if (selected.length === limit) break;
    }
    if (page.rows.length < limit) break;
  }

  return { candidates: selected, failures };
}

async function existingCalendarAutoOpenJobKeys(
  queryable: Queryable,
  jobKeys: readonly string[],
): Promise<Set<string>> {
  if (jobKeys.length === 0) return new Set();
  const result = await queryable.query<{ jobKey: string }>(
    `SELECT job_key AS "jobKey"
     FROM platform.jobs
     WHERE queue_name = $1 AND job_key = ANY($2::text[])`,
    [PMS_CALENDAR_AUTO_OPEN_QUEUE, jobKeys],
  );
  return new Set(result.rows.map(({ jobKey }) => jobKey));
}

async function enqueuePgAriPushJob(
  pool: pg.Pool,
  candidate: PmsChannexAriPushCandidate,
  context: PmsChannexSchedulerContext,
): Promise<PmsChannexJobEnqueueResult> {
  const client = await pool.connect();
  const jobKey = buildAriPushJobKey(candidate);
  const domainEventKey = buildAriPushDomainEventKey(candidate);
  const keyHash = sha256Key(jobKey);
  const payload = ariJobPayload(candidate);

  try {
    await client.query("BEGIN");
    await insertOrTouchIdempotencyKey(client, {
      operation: "channex_ari_push",
      keyHash,
      requestFingerprintHash: sha256Key(stableJson(payload)),
      responseResourceType: "room_type",
      responseResourceId: candidate.roomTypeId,
      candidate,
      context,
      metadata: { jobKey, domainEventKey, source: candidate.source },
    });
    const domainEventId = await insertOrFindPmsDomainEvent(client, {
      eventKey: domainEventKey,
      eventType: "channex.push-ari",
      propertyId: candidate.propertyId,
      resourceType: "room_type",
      resourceId: candidate.roomTypeId,
      keyHash,
      payload,
      context,
      metadata: { source: candidate.source, sourceOutboxEventId: candidate.sourceOutboxEventId },
    });
    const inserted = await client.query<{
      id: string;
      status: string;
      attemptsMade: number;
      maxAttempts: number;
    }>(
      `INSERT INTO platform.jobs
         (
           job_key,
           queue_name,
           job_type,
           source_domain_event_id,
           status,
           max_attempts,
           run_after,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           correlation_id,
           idempotency_key_hash,
           payload,
           job_metadata
         )
       VALUES (
         $1,
         $2,
         'channex.push-ari',
         $3::uuid,
         'pending',
         $4,
         $5::timestamptz,
         'property',
         $6::uuid,
         'pms',
         'room_type',
         $7,
         $8,
         $9,
         $10::jsonb,
         $11::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id, status, attempts_count AS "attemptsMade", max_attempts AS "maxAttempts"`,
      [
        jobKey,
        PMS_CHANNEX_SCHEDULER_QUEUE,
        domainEventId,
        DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
        context.now.toISOString(),
        candidate.propertyId,
        candidate.roomTypeId,
        candidate.correlationId ?? context.correlationId,
        keyHash,
        JSON.stringify(payload),
        JSON.stringify({ source: "pms-channex-scheduler", ariSource: candidate.source }),
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      await client.query("COMMIT");
      return {
        createdNewJob: true,
        job: {
          jobId: insertedRow.id,
          jobKey,
          domainEventKey,
          status: rowJobStatus(insertedRow.status),
          attemptsMade: insertedRow.attemptsMade,
          maxAttempts: insertedRow.maxAttempts,
          payload: candidate,
        },
      };
    }

    const existing = await selectExistingAriJob(client, jobKey);
    if (!existing) throw new Error(`Unable to resolve ARI job ${jobKey}`);
    await client.query("COMMIT");
    return {
      createdNewJob: false,
      job: {
        jobId: existing.id,
        jobKey,
        domainEventKey,
        status: rowJobStatus(existing.status),
        attemptsMade: existing.attemptsMade,
        maxAttempts: existing.maxAttempts,
        payload: candidate,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertPgProviderAttempt(
  queryable: Queryable,
  attempt: ChannexProviderAttemptRecord,
): Promise<void> {
  await queryable.query(
    `INSERT INTO platform.job_attempts
       (
         job_id,
         attempt_number,
         status,
         worker_id,
         started_at,
         finished_at,
         error_type,
         error_message,
         error_metadata
       )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5::timestamptz,
       $5::timestamptz,
       $6,
       $7,
       $8::jsonb
     )
     ON CONFLICT (job_id, attempt_number) DO UPDATE SET
       status = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       error_type = EXCLUDED.error_type,
       error_message = EXCLUDED.error_message,
       error_metadata = platform.job_attempts.error_metadata || EXCLUDED.error_metadata`,
    [
      attempt.jobId,
      attempt.attemptNumber,
      attempt.status,
      attempt.workerId,
      attempt.recordedAt,
      attempt.errorCategory ?? null,
      attempt.errorMessage ?? null,
      JSON.stringify({
        provider: attempt.provider,
        providerRequestId: attempt.providerRequestId ?? null,
        requestPayloadHash: attempt.requestPayloadHash,
        statusCode: attempt.statusCode ?? null,
        retryable: attempt.retryable,
        idempotencyKey: attempt.idempotencyKey,
      }),
    ],
  );
}

async function deadLetterPgAriPush(
  pool: pg.Pool,
  job: PmsChannexAriPushJob,
  attempt: ChannexProviderAttemptRecord,
  failure: ChannexAriProviderFailure,
  context: PmsChannexSchedulerContext,
): Promise<PmsChannexDeadLetterRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE platform.jobs
       SET status = 'dead_lettered',
           attempts_count = GREATEST(attempts_count, $2),
           finished_at = $3::timestamptz,
           updated_at = now(),
           job_metadata = job_metadata || $4::jsonb
       WHERE id = $1::uuid`,
      [
        job.jobId,
        attempt.attemptNumber,
        context.now.toISOString(),
        JSON.stringify({
          deadLetteredAt: context.now.toISOString(),
          lastErrorCategory: failure.errorCategory,
        }),
      ],
    );
    const attemptRow = await client.query<{ id: string }>(
      `SELECT id
       FROM platform.job_attempts
       WHERE job_id = $1::uuid AND attempt_number = $2
       LIMIT 1`,
      [job.jobId, attempt.attemptNumber],
    );
    const deadLetter: PmsChannexDeadLetterRecord = {
      jobId: job.jobId,
      jobKey: job.jobKey,
      idempotencyKey: job.jobKey,
      reasonCode: failure.retryable ? "max_attempts_exhausted" : "non_retryable_error",
      errorCategory: failure.errorCategory,
      failureSummary: failure.message,
      attemptCount: attempt.attemptNumber,
      replayEligible: failure.retryable,
      ownerPackage: "backend-events",
      createdAt: context.now.toISOString(),
    };
    await client.query(
      `INSERT INTO platform.dead_letter_events
         (
           source_kind,
           job_id,
           job_attempt_id,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           correlation_id,
           idempotency_key_hash,
           reason_code,
           failure_summary,
           failure_payload
         )
       VALUES (
         'job',
         $1::uuid,
         $2::uuid,
         'property',
         $3::uuid,
         'pms',
         'room_type',
         $4,
         $5,
         $6,
         $7,
         $8,
         $9::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [
        job.jobId,
        attemptRow.rows[0]?.id ?? null,
        job.payload.propertyId,
        job.payload.roomTypeId,
        job.payload.correlationId ?? context.correlationId,
        sha256Key(job.jobKey),
        deadLetter.reasonCode,
        deadLetter.failureSummary,
        JSON.stringify({
          ...deadLetter,
          providerRequestId: attempt.providerRequestId ?? null,
          statusCode: attempt.statusCode ?? null,
        }),
      ],
    );
    await client.query("COMMIT");
    job.status = "dead_lettered";
    job.attemptsMade = attempt.attemptNumber;
    return deadLetter;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function enqueuePgCalendarAutoOpenJob(
  pool: pg.Pool,
  candidate: PmsCalendarAutoOpenCandidate,
  context: PmsChannexSchedulerContext,
): Promise<PmsCalendarAutoOpenResult> {
  const client = await pool.connect();
  const eventKey = buildCalendarAutoOpenEventKey(candidate);
  const jobKey = buildCalendarAutoOpenJobKey(candidate);
  const keyHash = sha256Key(jobKey);
  const payload = {
    propertyId: candidate.propertyId,
    organizationId: candidate.organizationId,
    openFrom: candidate.openFrom,
    openThrough: candidate.openThrough,
    roomTypeIds: candidate.roomTypeIds,
    generatedCoverageThrough: candidate.generatedCoverageThrough,
    source: candidate.source,
    sourceFingerprint: candidate.sourceFingerprint,
  };

  try {
    await client.query("BEGIN");
    await insertOrTouchIdempotencyKey(client, {
      operation: "calendar_auto_open",
      keyHash,
      requestFingerprintHash: sha256Key(stableJson(payload)),
      responseResourceType: "property",
      responseResourceId: candidate.propertyId,
      candidate,
      context,
      metadata: { eventKey, jobKey, source: "pms-calendar-auto-open-scheduler" },
    });
    const domainEventId = await insertOrFindPmsDomainEvent(client, {
      eventKey,
      eventType: "pms.calendar-auto-open",
      propertyId: candidate.propertyId,
      resourceType: "property",
      resourceId: candidate.propertyId,
      keyHash,
      payload,
      context,
      metadata: { source: "pms-calendar-auto-open-scheduler" },
    });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform.jobs
         (
           job_key,
           queue_name,
           job_type,
           source_domain_event_id,
           status,
           attempts_count,
           max_attempts,
           run_after,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           correlation_id,
           idempotency_key_hash,
           payload,
           job_metadata
         )
       VALUES (
         $1,
         $2,
         'pms.calendar-auto-open',
         $3::uuid,
         'pending',
         0,
         $4,
         $5::timestamptz,
         'property',
         $6::uuid,
         'pms',
         'property',
         $6,
         $7,
         $8,
         $9::jsonb,
         $10::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id`,
      [
        jobKey,
        PMS_CALENDAR_AUTO_OPEN_QUEUE,
        domainEventId,
        DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
        context.now.toISOString(),
        candidate.propertyId,
        candidate.correlationId ?? context.correlationId,
        keyHash,
        JSON.stringify(payload),
        JSON.stringify({ source: "pms-calendar-auto-open-scheduler" }),
      ],
    );
    await client.query("COMMIT");
    return { candidate, createdNewJob: Boolean(inserted.rows[0]), eventKey, jobKey };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runCalendarAutoOpen(
  store: PmsChannexSchedulerStore,
  input: {
    now: Date;
    context: PmsChannexSchedulerContext;
    limit: number;
  },
): Promise<PmsChannexSchedulerRunResult> {
  const selection = await store.findCalendarAutoOpenCandidates(input.now, input.limit);
  const run = emptyRun("calendarAutoOpen", selection.candidates.length + selection.failures.length);
  run.autoOpenFailures.push(...selection.failures);

  for (const candidate of selection.candidates) {
    try {
      const result = await store.enqueueCalendarAutoOpenJob(candidate, input.context);
      if (result.createdNewJob) {
        run.enqueued += 1;
        run.autoOpenEnqueued += 1;
      } else {
        run.reused += 1;
      }
    } catch (error) {
      run.autoOpenFailures.push({
        propertyId: candidate.propertyId,
        stage: "enqueue",
        message: errorMessage(error),
      });
    }
  }

  return run;
}

function emptyRun(name: PmsChannexSchedulerRunName, scanned: number): PmsChannexSchedulerRunResult {
  return {
    name,
    scanned,
    enqueued: 0,
    reused: 0,
    providerAttempts: 0,
    succeeded: 0,
    retryScheduled: 0,
    deadLettered: 0,
    autoOpenEnqueued: 0,
    autoOpenFailures: [],
  };
}

async function insertOrTouchIdempotencyKey(
  client: pg.PoolClient,
  input: {
    operation: string;
    keyHash: string;
    requestFingerprintHash: string;
    responseResourceType: string;
    responseResourceId: string;
    candidate: { propertyId: string; organizationId: string };
    context: PmsChannexSchedulerContext;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         property_id,
         response_status_code,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         response_body_hash,
         correlation_id,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'completed',
       'property',
       $4::uuid,
       202,
       'pms',
       $5,
       $6,
       $3,
       $7,
       $8::timestamptz,
       $9::timestamptz,
       $10::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       completed_at = COALESCE(platform.idempotency_keys.completed_at, EXCLUDED.completed_at),
       idempotency_metadata = platform.idempotency_keys.idempotency_metadata || EXCLUDED.idempotency_metadata`,
    [
      input.operation,
      input.keyHash,
      input.requestFingerprintHash,
      input.candidate.propertyId,
      input.responseResourceType,
      input.responseResourceId,
      input.context.correlationId,
      input.context.now.toISOString(),
      new Date(input.context.now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        ...input.metadata,
        organizationId: input.candidate.organizationId,
      }),
    ],
  );
}

async function insertOrFindPmsDomainEvent(
  client: pg.PoolClient,
  input: {
    eventKey: string;
    eventType: string;
    propertyId: string;
    resourceType: string;
    resourceId: string;
    keyHash: string;
    payload: Record<string, unknown>;
    context: PmsChannexSchedulerContext;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         occurred_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES (
       'pms',
       $1,
       $2,
       $3::timestamptz,
       'property',
       $4::uuid,
       'pms',
       $5,
       $6,
       'system',
       $7,
       $1,
       $8,
       $9::jsonb,
       $10::jsonb,
       'internal'
     )
     ON CONFLICT (source_system, event_key) DO NOTHING
     RETURNING id`,
    [
      input.eventKey,
      input.eventType,
      input.context.now.toISOString(),
      input.propertyId,
      input.resourceType,
      input.resourceId,
      input.context.correlationId,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.metadata),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.domain_events
     WHERE source_system = 'pms' AND event_key = $1
     LIMIT 1`,
    [input.eventKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve PMS domain event ${input.eventKey}`);
  }
  return existingId;
}

async function selectExistingAriJob(
  client: pg.PoolClient,
  jobKey: string,
): Promise<{
  id: string;
  status: string;
  attemptsMade: number;
  maxAttempts: number;
} | null> {
  const result = await client.query<{
    id: string;
    status: string;
    attemptsMade: number;
    maxAttempts: number;
  }>(
    `SELECT
       id,
       status,
       attempts_count AS "attemptsMade",
       max_attempts AS "maxAttempts"
     FROM platform.jobs
     WHERE queue_name = $1 AND job_key = $2
     LIMIT 1`,
    [PMS_CHANNEX_SCHEDULER_QUEUE, jobKey],
  );
  return result.rows[0] ?? null;
}

function ariCandidateFromRow(row: AriCandidateRow): PmsChannexAriPushCandidate {
  return {
    source: row.source,
    propertyId: row.propertyId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    channexPropertyId: row.channexPropertyId,
    roomTypeId: row.roomTypeId,
    channexRoomTypeId: row.channexRoomTypeId,
    dateRange: {
      from: dateOnly(row.dateFrom),
      to: dateOnly(row.dateTo),
    },
    inventoryVersion: row.inventoryVersion,
    rateGateOpen: row.rateGateOpen,
    triggerRefId: row.triggerRefId,
    sourceOutboxEventId: row.sourceOutboxEventId ?? undefined,
    outboxKey: row.outboxKey ?? undefined,
    correlationId: row.correlationId ?? undefined,
  };
}

function calendarCandidateFromSourceRow(
  row: CalendarSourceRow,
  now: Date,
): PmsCalendarAutoOpenCandidate | null {
  if (!row.organizationId || !row.propertyTimeZone) {
    throw new Error("PMS calendar auto-open property source is incomplete");
  }
  const revision = positiveDatabaseInteger(row.settingRevision);
  const rollingMonths =
    row.rollingMonths === null ? null : positiveDatabaseInteger(row.rollingMonths);
  const fixedEndMonth = row.fixedEndMonth === null ? null : dateOnly(row.fixedEndMonth).slice(0, 7);
  if (
    (row.mode === "rolling" && ![12, 18, 24].includes(rollingMonths ?? 0)) ||
    (row.mode === "fixed" && fixedEndMonth === null)
  ) {
    throw new Error("PMS calendar auto-open setting source is invalid");
  }
  const setting = {
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId: row.propertyId,
    revision,
    enabled: true,
    mode: row.mode,
    rollingMonths: row.mode === "rolling" ? (rollingMonths as 12 | 18 | 24) : null,
    fixedEndMonth: row.mode === "fixed" ? fixedEndMonth : null,
    updatedAt: null,
  } as const;
  const horizon = calculatePmsCalendarAutoOpenHorizon(setting, row.propertyTimeZone, now);
  if (!isPmsCalendarAutoOpenFixedTargetWithinLimit(setting, row.propertyTimeZone, now)) {
    throw new Error("PMS calendar auto-open fixed target exceeds the 24-month maximum");
  }
  if (!horizon.targetOpenThrough || horizon.targetOpenThrough < horizon.propertyLocalDate)
    return null;

  const source = createPmsCalendarAutoOpenSource({
    settingRevision: revision,
    propertyProfileRevision: positiveDatabaseInteger(row.propertyProfileRevision),
    propertyTimeZone: row.propertyTimeZone,
    operatingCalendarRevision: positiveDatabaseInteger(row.operatingCalendarRevision),
    rooms: row.rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: positiveDatabaseInteger(room.roomFactsRevision),
      roomUnitsRevision: positiveDatabaseInteger(room.roomUnitsRevision),
    })),
    pricing: {
      pricingCurrencyRevision: positiveDatabaseInteger(row.pricingCurrencyRevision),
      flexibleRatePlans: row.flexibleRatePlans.map((plan) => ({
        roomTypeId: plan.roomTypeId,
        flexibleRatePlanRevision: positiveDatabaseInteger(plan.flexibleRatePlanRevision),
      })),
      optionalPricingAggregateRevision: nonNegativeDatabaseInteger(
        row.optionalPricingAggregateRevision,
      ),
    },
  });
  const sourceFingerprint = fingerprintPmsCalendarAutoOpenSource(source);
  const generatedCoverageFrom = row.generatedCoverageFrom
    ? dateOnly(row.generatedCoverageFrom)
    : null;
  const generatedCoverageThrough = row.generatedCoverageThrough
    ? dateOnly(row.generatedCoverageThrough)
    : null;
  const sourcesReflected = row.successfulApplications.some(
    (application) =>
      application.sourceFingerprint === sourceFingerprint &&
      /^\d{4}-\d{2}-\d{2}$/.test(application.openThrough) &&
      application.openThrough >= horizon.targetOpenThrough!,
  );
  if (
    generatedCoverageFrom &&
    generatedCoverageFrom <= horizon.propertyLocalDate &&
    generatedCoverageThrough &&
    generatedCoverageThrough >= horizon.targetOpenThrough &&
    sourcesReflected
  ) {
    return null;
  }

  return {
    propertyId: row.propertyId,
    organizationId: row.organizationId,
    openFrom: horizon.propertyLocalDate,
    openThrough: horizon.targetOpenThrough,
    roomTypeIds: source.rooms.map(({ roomTypeId }) => roomTypeId),
    generatedCoverageThrough,
    source,
    sourceFingerprint,
    correlationId: `pms.calendar-auto-open:${row.propertyId}:${horizon.targetOpenThrough}:source-${sourceFingerprint}`,
  };
}

function ariJobPayload(candidate: PmsChannexAriPushCandidate): Record<string, unknown> {
  return {
    provider: "channex",
    source: candidate.source,
    propertyId: candidate.propertyId,
    organizationId: candidate.organizationId,
    connectionId: candidate.connectionId,
    channexPropertyId: candidate.channexPropertyId,
    roomTypeId: candidate.roomTypeId,
    channexRoomTypeId: candidate.channexRoomTypeId,
    dateRange: candidate.dateRange,
    inventoryVersion: candidate.inventoryVersion,
    rateGateOpen: candidate.rateGateOpen,
    triggerRefId: candidate.triggerRefId,
    sourceOutboxEventId: candidate.sourceOutboxEventId ?? null,
    outboxKey: candidate.outboxKey ?? null,
  };
}

function rowJobStatus(status: string): PmsChannexAriPushJob["status"] {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "dead_lettered":
      return "dead_lettered";
    case "running":
      return "running";
    case "failed":
      return "retry_scheduled";
    default:
      return "queued";
  }
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateOnly(value: Date | string): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate(),
    ).padStart(2, "0")}`;
  }
  return value.slice(0, 10);
}

function positiveDatabaseInteger(value: number | string | null): number {
  if (value === null) throw new Error("PMS calendar auto-open source revision is missing");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("PMS calendar auto-open source revision is invalid");
  }
  return parsed;
}

function nonNegativeDatabaseInteger(value: number | string | null): number {
  if (value === null)
    throw new Error("PMS calendar auto-open pricing aggregate revision is missing");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PMS calendar auto-open pricing aggregate revision is invalid");
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown PMS calendar auto-open failure";
}

function sha256Key(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function sumBy<T extends Record<K, number>, K extends keyof T>(
  values: readonly T[],
  key: K,
): number {
  return values.reduce((sum, value) => sum + value[key], 0);
}
