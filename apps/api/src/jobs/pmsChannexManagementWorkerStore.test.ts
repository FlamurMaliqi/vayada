import { describe, expect, it, vi } from "vitest";

import type { ChannexManagementJob } from "./pmsChannexManagementWorker.js";
import {
  createPgPmsChannexManagementWorkerStore,
  type ChannexManagementTargetStatePort,
} from "./pmsChannexManagementWorkerStore.js";

const now = new Date("2026-08-13T10:00:00.000Z");
const job: ChannexManagementJob = {
  jobId: "job-1",
  propertyId: "property-1",
  correlationId: "correlation-1",
  attemptNumber: 1,
  maxAttempts: 5,
  input: { commandId: "command-1", idempotencyKey: "key-1", operationType: "enable" },
};

describe("PMS Channex management worker store", () => {
  it("leases work", async () => {
    const harness = setup({ withJob: true });
    await expect(harness.store.claim({ workerId: "worker-1", now })).resolves.toEqual(job);
    expect(harness.db.sql()).toContain("FOR UPDATE SKIP LOCKED");
    expect(harness.db.sql()).toContain("INSERT INTO platform.job_attempts");
  });

  it("persists completion", async () => {
    const harness = setup();
    await harness.store.succeed(
      job,
      { ok: true, providerRequestId: "provider-1" },
      { workerId: "worker-1", now },
    );
    expect(harness.state.succeed).toHaveBeenCalled();
    expect(harness.db.sql()).toMatch(
      /platform\.jobs[\s\S]*platform\.idempotency_keys[\s\S]*platform\.product_audit_events/,
    );
  });

  it("dead-letters terminal failure", async () => {
    const harness = setup();
    await expect(
      harness.store.fail(
        job,
        { ok: false, code: "timeout", message: "timed out" },
        { workerId: "worker-1", now, retryable: true, retryAt: null },
      ),
    ).resolves.toBe("dead_lettered");
    expect(harness.db.sql()).toContain("platform.dead_letter_events");
    expect(harness.db.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("schedules transient retries without dead-lettering", async () => {
    const harness = setup();
    await expect(
      harness.store.fail(
        job,
        { ok: false, code: "rate_limited", message: "slow down" },
        { workerId: "worker-1", now, retryable: true, retryAt: new Date(now.getTime() + 1_000) },
      ),
    ).resolves.toBe("retry_scheduled");
    expect(harness.state.fail).toHaveBeenCalled();
    expect(harness.db.sql()).not.toContain("platform.dead_letter_events");
    expect(harness.db.sql()).not.toContain("platform.idempotency_keys");
    expect(harness.db.sql()).not.toContain("platform.product_audit_events");
    expect(harness.db.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("times out a stale lease before reclaiming it", async () => {
    const harness = setup({ withJob: true, status: "running", attemptsCount: 1 });

    await expect(harness.store.claim({ workerId: "worker-2", now })).resolves.toMatchObject({
      attemptNumber: 2,
    });

    expect(harness.db.sql()).toContain("status = 'timed_out'");
  });

  it("dead-letters an exhausted stale job instead of blocking the queue", async () => {
    const harness = setup({
      withJob: true,
      status: "running",
      attemptsCount: 5,
      maxAttempts: 5,
    });

    await expect(harness.store.claim({ workerId: "worker-2", now })).resolves.toBeNull();

    expect(harness.db.sql()).toContain("status = 'dead_lettered'");
    expect(harness.db.sql()).toContain("platform.dead_letter_events");
    expect(harness.db.sql()).not.toContain("INSERT INTO platform.job_attempts");
    expect(harness.state.fail).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function) }),
      expect.objectContaining({ attemptNumber: 5 }),
      expect.objectContaining({ code: "provider_unavailable" }),
      { now, retryAt: null },
    );
  });

  it("rolls back rather than finalizing when the worker lease is lost", async () => {
    const harness = setup({ jobUpdateRowCount: 0 });

    await expect(
      harness.store.succeed(
        job,
        { ok: true, providerRequestId: "provider-1" },
        { workerId: "worker-1", now },
      ),
    ).rejects.toThrow(`Lost Channex job lease ${job.jobId}`);

    expect(harness.db.sql()).not.toContain("platform.idempotency_keys");
    expect(harness.db.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("preserves the original error when rollback fails", async () => {
    const rollbackError = new Error("rollback failed");
    const originalError = new Error("target update failed");
    const harness = setup({ rollbackError });
    vi.mocked(harness.state.succeed).mockRejectedValue(originalError);

    await expect(
      harness.store.succeed(
        job,
        { ok: true, providerRequestId: "provider-1" },
        { workerId: "worker-1", now },
      ),
    ).rejects.toBe(originalError);

    expect(harness.db.releasedWith).toBe(rollbackError);
  });

  it("fences heartbeats by attempt even when the worker id is reused", async () => {
    const harness = setup({ leaseUpdateRowCount: 0 });

    await expect(harness.store.heartbeat(job, { workerId: "worker-1" })).rejects.toThrow(
      `Lost Channex job lease ${job.jobId}`,
    );

    const heartbeat = harness.db.calls.find(({ text }) => text.includes("RETURNING id"));
    expect(heartbeat?.text).toContain("attempts_count = $3");
    expect(heartbeat?.text).toContain("locked_at = now()");
    expect(heartbeat?.values).toEqual([job.jobId, "worker-1", job.attemptNumber]);
  });

  it("rolls back when the running attempt cannot be finalized", async () => {
    const harness = setup({ attemptUpdateRowCount: 0 });

    await expect(
      harness.store.succeed(
        job,
        { ok: true, providerRequestId: "provider-1" },
        { workerId: "worker-1", now },
      ),
    ).rejects.toThrow("Channex job lease lost");

    expect(harness.db.calls.at(-1)?.text).toBe("ROLLBACK");
  });
});

type FakeJobRow = {
  status: "pending" | "running";
  attemptsCount: number;
  maxAttempts: number;
};

type FakeDbOptions = Partial<FakeJobRow> & {
  withJob?: boolean;
  jobUpdateRowCount?: number;
  leaseUpdateRowCount?: number;
  attemptUpdateRowCount?: number;
  rollbackError?: Error;
};

function setup(options: FakeDbOptions = {}) {
  const db = new FakeDb(options);
  const state: ChannexManagementTargetStatePort = { succeed: vi.fn(), fail: vi.fn() };
  const store = createPgPmsChannexManagementWorkerStore({
    connectionString: "postgresql://target",
    pool: db.pool(),
    targetState: state,
  });
  return { db, state, store };
}

// SQL-shape fake only; it does not replace a real PostgreSQL schema integration test.
class FakeDb {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  releasedWith: Error | boolean | undefined;
  constructor(private readonly options: FakeDbOptions) {}
  pool() {
    return {
      connect: async () => ({
        query: this.query.bind(this),
        release: (error?: Error | boolean) => {
          this.releasedWith = error;
        },
      }),
      end: async () => undefined,
    };
  }
  sql() {
    return this.calls.map(({ text }) => text).join("\n");
  }
  async query<T>(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (text === "ROLLBACK" && this.options.rollbackError) throw this.options.rollbackError;
    const rows =
      this.options.withJob && text.includes("FROM platform.jobs")
        ? [
            {
              jobId: job.jobId,
              propertyId: job.propertyId,
              correlationId: job.correlationId,
              status: this.options.status ?? "pending",
              attemptsCount: this.options.attemptsCount ?? 0,
              maxAttempts: this.options.maxAttempts ?? 5,
              payload: job.input,
            },
          ]
        : [];
    const leaseUpdate = text.includes("UPDATE platform.jobs SET locked_at = now()");
    const attemptUpdate =
      text.includes("UPDATE platform.job_attempts SET status = 'succeeded'") ||
      text.includes("UPDATE platform.job_attempts SET status = 'failed'");
    const guardedJobUpdate =
      text.includes("UPDATE platform.jobs SET status") && text.includes("locked_by = $2");
    const rowCount = leaseUpdate
      ? (this.options.leaseUpdateRowCount ?? this.options.jobUpdateRowCount ?? 1)
      : attemptUpdate
        ? (this.options.attemptUpdateRowCount ?? 1)
        : guardedJobUpdate
          ? (this.options.jobUpdateRowCount ?? 1)
          : text.trimStart().startsWith("SELECT")
            ? rows.length
            : 1;
    return { rows: rows as T[], rowCount };
  }
}
