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
  it("leases work, persists completion, and dead-letters terminal failure", async () => {
    let harness = setup(true);
    await expect(harness.store.claim({ workerId: "worker-1", now })).resolves.toEqual(job);
    expect(harness.db.sql()).toContain("FOR UPDATE SKIP LOCKED");
    expect(harness.db.sql()).toContain("INSERT INTO platform.job_attempts");

    harness = setup();
    await harness.store.succeed(
      job,
      { ok: true, providerRequestId: "provider-1" },
      { workerId: "worker-1", now },
    );
    expect(harness.state.succeed).toHaveBeenCalled();
    expect(harness.db.sql()).toMatch(
      /platform\.jobs[\s\S]*platform\.idempotency_keys[\s\S]*platform\.product_audit_events/,
    );

    harness = setup();
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
  });
});

function setup(withJob = false) {
  const db = new FakeDb(withJob);
  const state: ChannexManagementTargetStatePort = { succeed: vi.fn(), fail: vi.fn() };
  const store = createPgPmsChannexManagementWorkerStore({
    connectionString: "postgresql://target",
    pool: db.pool(),
    targetState: state,
  });
  return { db, state, store };
}

class FakeDb {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  constructor(private readonly withJob: boolean) {}
  pool() {
    return {
      connect: async () => ({ query: this.query.bind(this), release() {} }),
      end: async () => undefined,
    };
  }
  sql() {
    return this.calls.map(({ text }) => text).join("\n");
  }
  async query<T>(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    const rows =
      this.withJob && text.includes("FROM platform.jobs")
        ? [
            {
              jobId: job.jobId,
              propertyId: job.propertyId,
              correlationId: job.correlationId,
              status: "pending",
              attemptsCount: 0,
              maxAttempts: 5,
              payload: job.input,
            },
          ]
        : [];
    return { rows: rows as T[], rowCount: rows.length };
  }
}
