import { describe, expect, it } from "vitest";

import {
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";

import {
  DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
  buildAriPushDomainEventKey,
  buildAriPushJobKey,
  buildCalendarAutoOpenEventKey,
  buildCalendarAutoOpenJobKey,
  buildPmsChannexAriPushJob,
  runPmsChannexSchedulerJobs,
  type ChannexAriProvider,
  type ChannexAriProviderResult,
  type ChannexProviderAttemptRecord,
  type PmsCalendarAutoOpenCandidate,
  type PmsCalendarAutoOpenResult,
  type PmsChannexAriPushCandidate,
  type PmsChannexAriPushJob,
  type PmsChannexDeadLetterRecord,
  type PmsChannexJobEnqueueResult,
  type PmsChannexProviderFailureCategory,
  type PmsChannexSchedulerContext,
  type PmsChannexSchedulerStore,
} from "./pmsChannexScheduler.js";

const fixedNow = new Date("2026-09-01T10:00:00.000Z");

describe("PMS Channex ARI and calendar scheduler jobs", () => {
  it("pushes incremental and full ARI windows idempotently and persists Channex attempts", async () => {
    const store = new MemoryPmsChannexSchedulerStore({
      incrementalAri: [ariCandidate({ inventoryVersion: "outbox-ari-001", source: "incremental" })],
      fullAri: [
        ariCandidate({
          source: "full",
          roomTypeId: "rt_suite",
          channexRoomTypeId: "chx_rt_suite",
          inventoryVersion: "full-2026-09-01",
          dateRange: { from: "2026-09-01", to: "2027-03-01" },
        }),
      ],
    });
    const provider = createSequenceProvider([
      { ok: true, providerRequestId: "chx_req_incremental_1", statusCode: 200 },
      { ok: true, providerRequestId: "chx_req_full_1", statusCode: 200 },
    ]);

    const firstRun = await runPmsChannexSchedulerJobs(store, provider, {
      now: fixedNow,
      workerId: "worker_ari",
      run: ["incrementalAriPush", "fullAriPush"],
    });
    const rerun = await runPmsChannexSchedulerJobs(store, provider, {
      now: fixedNow,
      workerId: "worker_ari",
      run: ["incrementalAriPush", "fullAriPush"],
    });

    expect(firstRun).toMatchObject({
      scanned: 2,
      enqueued: 2,
      reused: 0,
      providerAttempts: 2,
      succeeded: 2,
    });
    expect(rerun).toMatchObject({
      scanned: 2,
      enqueued: 0,
      reused: 2,
      providerAttempts: 0,
    });

    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "channex.push-ari:room_type:rt_deluxe:2026-09-12_2026-09-15:outbox-ari-001:v1",
      "channex.push-ari:room_type:rt_suite:2026-09-01_2027-03-01:full-2026-09-01:v1",
    ]);
    expect(store.domainEvents.map((event) => event.eventKey)).toEqual([
      "channex.push-ari:prop_alpenrose:rt_deluxe:2026-09-12_2026-09-15:outbox-ari-001:v1",
      "channex.push-ari:prop_alpenrose:rt_suite:2026-09-01_2027-03-01:full-2026-09-01:v1",
    ]);
    expect(store.idempotencyKeys).toEqual(store.jobs.map((job) => job.jobKey));
    expect(store.providerAttempts).toMatchObject([
      {
        provider: "channex",
        providerRequestId: "chx_req_incremental_1",
        attemptNumber: 1,
        status: "succeeded",
        workerId: "worker_ari",
      },
      {
        provider: "channex",
        providerRequestId: "chx_req_full_1",
        attemptNumber: 1,
        status: "succeeded",
        workerId: "worker_ari",
      },
    ]);
    expect(
      store.providerAttempts.every((attempt) => attempt.requestPayloadHash.startsWith("sha256:")),
    ).toBe(true);
  });

  it("enqueues calendar windows once per property, horizon, and source", async () => {
    const candidate = calendarCandidate();
    const store = new MemoryPmsChannexSchedulerStore({
      calendarAutoOpen: [candidate],
    });
    const provider = createSequenceProvider([]);

    const firstRun = await runPmsChannexSchedulerJobs(store, provider, {
      now: fixedNow,
      workerId: "worker_calendar",
      run: ["calendarAutoOpen"],
    });
    const rerun = await runPmsChannexSchedulerJobs(store, provider, {
      now: fixedNow,
      workerId: "worker_calendar",
      run: ["calendarAutoOpen"],
    });

    expect(firstRun).toMatchObject({
      scanned: 1,
      enqueued: 1,
      reused: 0,
      autoOpenEnqueued: 1,
    });
    expect(rerun).toMatchObject({
      scanned: 1,
      enqueued: 0,
      reused: 1,
      autoOpenEnqueued: 0,
    });
    expect(store.calendarOpenResults).toEqual([
      {
        candidate,
        createdNewJob: true,
        eventKey: `pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${candidate.sourceFingerprint}:v2`,
        jobKey: `pms.calendar-auto-open:property:prop_alpenrose:open-through-2028-03-31:source-${candidate.sourceFingerprint}:v2`,
      },
    ]);
    expect(store.domainEvents.map((event) => event.eventKey)).toContain(
      `pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${candidate.sourceFingerprint}:v2`,
    );
  });

  it("reports one calendar enqueue failure without stopping later properties", async () => {
    const failed = calendarCandidate({ propertyId: "prop_failed" });
    const later = calendarCandidate({ propertyId: "prop_later" });
    const store = new MemoryPmsChannexSchedulerStore({
      calendarAutoOpen: [failed, later],
      calendarEnqueueFailures: [failed.propertyId],
    });

    const result = await runPmsChannexSchedulerJobs(store, createSequenceProvider([]), {
      now: fixedNow,
      run: ["calendarAutoOpen"],
    });

    expect(result.autoOpenEnqueued).toBe(1);
    expect(result.autoOpenFailures).toEqual([
      { propertyId: failed.propertyId, stage: "enqueue", message: "enqueue failed" },
    ]);
    expect(store.calendarOpenResults[0]?.candidate.propertyId).toBe(later.propertyId);
  });

  it("retries retryable Channex provider failures and dead-letters after max attempts", async () => {
    const store = new MemoryPmsChannexSchedulerStore({
      incrementalAri: [ariCandidate({ inventoryVersion: "outbox-ari-retry-001" })],
    });
    const failures = Array.from({ length: DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS }, (_, index) =>
      providerFailure({
        providerRequestId: `chx_req_retry_${index + 1}`,
        errorCategory: "provider_5xx",
        message: "Channex returned 503.",
        statusCode: 503,
        retryable: true,
      }),
    );
    const provider = createSequenceProvider(failures);

    for (let attempt = 1; attempt <= DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS; attempt += 1) {
      await runPmsChannexSchedulerJobs(store, provider, {
        now: new Date(fixedNow.getTime() + attempt * 60_000),
        workerId: "worker_retry",
        run: ["incrementalAriPush"],
      });
    }

    expect(store.providerAttempts).toHaveLength(DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS);
    expect(store.providerAttempts.map((attempt) => attempt.providerRequestId)).toEqual([
      "chx_req_retry_1",
      "chx_req_retry_2",
      "chx_req_retry_3",
      "chx_req_retry_4",
      "chx_req_retry_5",
    ]);
    expect(store.jobs[0]).toMatchObject({
      attemptsMade: DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
      status: "dead_lettered",
    });
    expect(store.deadLetters).toEqual([
      expect.objectContaining({
        reasonCode: "max_attempts_exhausted",
        errorCategory: "provider_5xx",
        attemptCount: DEFAULT_CHANNEX_ARI_MAX_ATTEMPTS,
        replayEligible: true,
        ownerPackage: "backend-events",
      }),
    ]);
  });

  it("dead-letters non-retryable mapping failures without burning the retry window", async () => {
    const store = new MemoryPmsChannexSchedulerStore({
      incrementalAri: [ariCandidate({ inventoryVersion: "outbox-ari-mapping-missing" })],
    });
    const provider = createSequenceProvider([
      providerFailure({
        errorCategory: "mapping_missing",
        message: "Missing Channex room-type mapping.",
        retryable: false,
      }),
    ]);

    const result = await runPmsChannexSchedulerJobs(store, provider, {
      now: fixedNow,
      workerId: "worker_mapping",
      run: ["incrementalAriPush"],
    });

    expect(result).toMatchObject({
      providerAttempts: 1,
      retryScheduled: 0,
      deadLettered: 1,
    });
    expect(store.jobs[0]).toMatchObject({ attemptsMade: 1, status: "dead_lettered" });
    expect(store.deadLetters[0]).toMatchObject({
      reasonCode: "non_retryable_error",
      errorCategory: "mapping_missing",
      replayEligible: false,
    });
  });

  it("uses cutover-plan key formats for ARI and calendar windows", () => {
    const ari = ariCandidate({ inventoryVersion: "inventory-version-42" });

    expect(buildAriPushDomainEventKey(ari)).toBe(
      "channex.push-ari:prop_alpenrose:rt_deluxe:2026-09-12_2026-09-15:inventory-version-42:v1",
    );
    expect(buildAriPushJobKey(ari)).toBe(
      "channex.push-ari:room_type:rt_deluxe:2026-09-12_2026-09-15:inventory-version-42:v1",
    );
    expect(
      buildCalendarAutoOpenEventKey({
        propertyId: "prop_alpenrose",
        openThrough: "2028-03-31",
        sourceFingerprint: "a".repeat(64),
      }),
    ).toBe(`pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${"a".repeat(64)}:v2`);
    expect(
      buildCalendarAutoOpenJobKey({
        propertyId: "prop_alpenrose",
        openThrough: "2028-03-31",
        sourceFingerprint: "a".repeat(64),
      }),
    ).toBe(
      `pms.calendar-auto-open:property:prop_alpenrose:open-through-2028-03-31:source-${"a".repeat(64)}:v2`,
    );
  });
});

type MemoryStoreOptions = {
  incrementalAri?: PmsChannexAriPushCandidate[];
  fullAri?: PmsChannexAriPushCandidate[];
  calendarAutoOpen?: PmsCalendarAutoOpenCandidate[];
  calendarEnqueueFailures?: string[];
};

class MemoryPmsChannexSchedulerStore implements PmsChannexSchedulerStore {
  readonly jobs: PmsChannexAriPushJob[] = [];
  readonly domainEvents: Array<{ eventKey: string; payload: Record<string, unknown> }> = [];
  readonly idempotencyKeys: string[] = [];
  readonly providerAttempts: ChannexProviderAttemptRecord[] = [];
  readonly deadLetters: PmsChannexDeadLetterRecord[] = [];
  readonly calendarOpenResults: PmsCalendarAutoOpenResult[] = [];

  private readonly incrementalAri: PmsChannexAriPushCandidate[];
  private readonly fullAri: PmsChannexAriPushCandidate[];
  private readonly calendarAutoOpen: PmsCalendarAutoOpenCandidate[];
  private readonly calendarEnqueueFailures: Set<string>;

  constructor(options: MemoryStoreOptions = {}) {
    this.incrementalAri = options.incrementalAri ?? [];
    this.fullAri = options.fullAri ?? [];
    this.calendarAutoOpen = options.calendarAutoOpen ?? [];
    this.calendarEnqueueFailures = new Set(options.calendarEnqueueFailures);
  }

  async findIncrementalAriPushCandidates(
    _now: Date,
    limit: number,
  ): Promise<PmsChannexAriPushCandidate[]> {
    return this.incrementalAri.slice(0, limit);
  }

  async findFullAriPushCandidates(
    _now: Date,
    limit: number,
  ): Promise<PmsChannexAriPushCandidate[]> {
    return this.fullAri.slice(0, limit);
  }

  async findCalendarAutoOpenCandidates(_now: Date, limit: number) {
    return { candidates: this.calendarAutoOpen.slice(0, limit), failures: [] };
  }

  async enqueueAriPushJob(
    candidate: PmsChannexAriPushCandidate,
    _context: PmsChannexSchedulerContext,
  ): Promise<PmsChannexJobEnqueueResult> {
    const jobKey = buildAriPushJobKey(candidate);
    const existing = this.jobs.find((job) => job.jobKey === jobKey);
    if (existing) return { createdNewJob: false, job: existing };

    const job = buildPmsChannexAriPushJob(candidate, `job_${this.jobs.length + 1}`);
    this.jobs.push(job);
    this.domainEvents.push({
      eventKey: job.domainEventKey,
      payload: {
        propertyId: candidate.propertyId,
        roomTypeId: candidate.roomTypeId,
        source: candidate.source,
      },
    });
    this.idempotencyKeys.push(job.jobKey);
    return { createdNewJob: true, job };
  }

  async recordChannexProviderAttempt(attempt: ChannexProviderAttemptRecord): Promise<void> {
    this.providerAttempts.push(attempt);
  }

  async markAriPushSucceeded(job: PmsChannexAriPushJob): Promise<void> {
    job.attemptsMade += 1;
    job.status = "succeeded";
  }

  async scheduleAriPushRetry(job: PmsChannexAriPushJob): Promise<void> {
    job.attemptsMade += 1;
    job.status = "retry_scheduled";
  }

  async deadLetterAriPush(
    job: PmsChannexAriPushJob,
    _attempt: ChannexProviderAttemptRecord,
    failure: {
      retryable: boolean;
      errorCategory: PmsChannexProviderFailureCategory;
      message: string;
    },
    context: PmsChannexSchedulerContext,
  ): Promise<PmsChannexDeadLetterRecord> {
    job.attemptsMade += 1;
    job.status = "dead_lettered";
    const deadLetter: PmsChannexDeadLetterRecord = {
      jobId: job.jobId,
      jobKey: job.jobKey,
      idempotencyKey: job.jobKey,
      reasonCode: failure.retryable ? "max_attempts_exhausted" : "non_retryable_error",
      errorCategory: failure.errorCategory,
      failureSummary: failure.message,
      attemptCount: job.attemptsMade,
      replayEligible: failure.retryable,
      ownerPackage: "backend-events",
      createdAt: context.now.toISOString(),
    };
    this.deadLetters.push(deadLetter);
    return deadLetter;
  }

  async enqueueCalendarAutoOpenJob(
    candidate: PmsCalendarAutoOpenCandidate,
    _context: PmsChannexSchedulerContext,
  ): Promise<PmsCalendarAutoOpenResult> {
    if (this.calendarEnqueueFailures.has(candidate.propertyId)) throw new Error("enqueue failed");
    const eventKey = buildCalendarAutoOpenEventKey(candidate);
    const jobKey = buildCalendarAutoOpenJobKey(candidate);
    const existing = this.calendarOpenResults.find((result) => result.eventKey === eventKey);
    if (existing) return { ...existing, createdNewJob: false };

    const result = { candidate, createdNewJob: true, eventKey, jobKey };
    this.calendarOpenResults.push(result);
    this.domainEvents.push({
      eventKey,
      payload: {
        propertyId: candidate.propertyId,
        openThrough: candidate.openThrough,
        roomTypeIds: candidate.roomTypeIds,
      },
    });
    this.idempotencyKeys.push(jobKey);
    return result;
  }
}

function ariCandidate(
  overrides: Partial<PmsChannexAriPushCandidate> = {},
): PmsChannexAriPushCandidate {
  return {
    source: "incremental",
    propertyId: "prop_alpenrose",
    organizationId: "org_alpenrose",
    connectionId: "conn_channex_alpenrose",
    channexPropertyId: "chx_prop_alpenrose",
    roomTypeId: "rt_deluxe",
    channexRoomTypeId: "chx_rt_deluxe",
    dateRange: { from: "2026-09-12", to: "2026-09-15" },
    inventoryVersion: "outbox-ari-001",
    triggerRefId: "room-block-001",
    sourceOutboxEventId: "outbox_ari_001",
    outboxKey: "pms.inventory.ari_changed:prop_alpenrose:rt_deluxe:2026-09-12_2026-09-15",
    correlationId: "corr_ari_001",
    ...overrides,
  };
}

function calendarCandidate(
  overrides: Partial<PmsCalendarAutoOpenCandidate> = {},
): PmsCalendarAutoOpenCandidate {
  const source = createPmsCalendarAutoOpenSource({
    settingRevision: 6,
    propertyProfileRevision: 4,
    propertyTimeZone: "Europe/Berlin",
    operatingCalendarRevision: 9,
    rooms: [
      { roomTypeId: "rt_deluxe", roomFactsRevision: 2, roomUnitsRevision: 3 },
      { roomTypeId: "rt_suite", roomFactsRevision: 4, roomUnitsRevision: 5 },
    ],
    pricing: {
      pricingCurrencyRevision: 2,
      flexibleRatePlans: [{ roomTypeId: "rt_deluxe", flexibleRatePlanRevision: 5 }],
      optionalPricingAggregateRevision: 7,
    },
  });
  return {
    propertyId: "prop_alpenrose",
    organizationId: "org_alpenrose",
    openFrom: "2027-09-01",
    openThrough: "2028-03-31",
    roomTypeIds: ["rt_deluxe", "rt_suite"],
    generatedCoverageThrough: "2027-08-31",
    source,
    sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(source),
    correlationId: "corr_calendar_001",
    ...overrides,
  };
}

function createSequenceProvider(results: ChannexAriProviderResult[]): ChannexAriProvider {
  const pending = [...results];
  return {
    async pushAri(job) {
      const result = pending.shift();
      if (!result) {
        throw new Error(`No provider result queued for ${job.jobKey}`);
      }
      return result;
    },
  };
}

function providerFailure(input: {
  errorCategory: PmsChannexProviderFailureCategory;
  message: string;
  retryable: boolean;
  providerRequestId?: string;
  statusCode?: number;
}): ChannexAriProviderResult {
  return {
    ok: false,
    providerRequestId: input.providerRequestId,
    statusCode: input.statusCode,
    retryable: input.retryable,
    errorCategory: input.errorCategory,
    message: input.message,
  };
}
