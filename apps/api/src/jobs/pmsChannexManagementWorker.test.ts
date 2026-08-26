import { describe, expect, it, vi } from "vitest";

import {
  channexManagementFailureIsRetryable,
  runPmsChannexManagementWorkerOnce,
  type ChannexManagementJob,
  type ChannexManagementProvider,
  type ChannexManagementWorkerStore,
} from "./pmsChannexManagementWorker.js";

const now = new Date("2026-08-13T10:00:00.000Z");

describe("PMS Channex management worker", () => {
  it("claims provider work and persists success", async () => {
    const harness = store(job());
    const execute = vi.fn<ChannexManagementProvider["execute"]>(async (_job, input) => {
      await input?.onProgress?.();
      return { ok: true as const, providerRequestId: "req-1" };
    });
    const provider = { execute };

    await expect(
      runPmsChannexManagementWorkerOnce({
        store: harness.port,
        provider,
        workerId: "worker-1",
        now,
      }),
    ).resolves.toEqual({ outcome: "succeeded", jobId: "job-1", operationType: "enable" });
    expect(execute).toHaveBeenCalledWith(
      job(),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(harness.heartbeat).toHaveBeenCalledWith(job(), { workerId: "worker-1" });
    expect(harness.succeed).toHaveBeenCalledWith(
      job(),
      { ok: true, providerRequestId: "req-1" },
      { workerId: "worker-1", now },
    );
  });

  it("uses bounded exponential retry for timeouts, 429s, and 5xx failures", async () => {
    for (const failure of [
      { ok: false as const, code: "timeout" as const, message: "timed out" },
      { ok: false as const, code: "rate_limited" as const, message: "slow down", statusCode: 429 },
      { ok: false as const, code: "provider_rejected" as const, message: "bad", statusCode: 503 },
    ]) {
      const harness = store(job());
      harness.fail.mockResolvedValue("retry_scheduled");
      const result = await runPmsChannexManagementWorkerOnce({
        store: harness.port,
        provider: { execute: vi.fn().mockResolvedValue(failure) },
        workerId: "worker-1",
        now,
      });
      expect(result.outcome).toBe("retry_scheduled");
      expect(harness.fail).toHaveBeenCalledWith(
        job(),
        failure,
        expect.objectContaining({ retryable: true, retryAt: new Date(now.getTime() + 1_000) }),
      );
    }
  });

  it("dead-letters non-retryable rejection and exhausted transient work", async () => {
    for (const [claimed, failure] of [
      [job(), { ok: false, code: "invalid_state", message: "not connected" }],
      [
        { ...job(), attemptNumber: 5 },
        { ok: false, code: "provider_unavailable", message: "offline" },
      ],
    ] as const) {
      const harness = store(claimed);
      harness.fail.mockResolvedValue("dead_lettered");
      await runPmsChannexManagementWorkerOnce({
        store: harness.port,
        provider: { execute: vi.fn().mockResolvedValue(failure) },
        workerId: "worker-1",
        now,
      });
      expect(harness.fail).toHaveBeenCalledWith(
        claimed,
        failure,
        expect.objectContaining({ retryAt: null }),
      );
    }
  });

  it("treats thrown transport errors as retryable and reports idle queues", async () => {
    let harness = store(job());
    harness.fail.mockResolvedValue("retry_scheduled");
    await runPmsChannexManagementWorkerOnce({
      store: harness.port,
      provider: { execute: vi.fn().mockRejectedValue(new Error("socket closed")) },
      workerId: "worker-1",
      now,
    });
    expect(harness.fail).toHaveBeenCalledWith(
      job(),
      { ok: false, code: "provider_unavailable", message: "socket closed" },
      expect.objectContaining({ retryable: true }),
    );

    harness = store(null);
    await expect(
      runPmsChannexManagementWorkerOnce({
        store: harness.port,
        provider: { execute: vi.fn() },
        workerId: "worker-1",
        now,
      }),
    ).resolves.toEqual({ outcome: "idle" });
  });

  it("does not retry provider or payload rejections without a 5xx status", () => {
    expect(
      channexManagementFailureIsRetryable({
        ok: false,
        code: "provider_rejected",
        message: "denied",
        statusCode: 422,
      }),
    ).toBe(false);
    expect(
      channexManagementFailureIsRetryable({
        ok: false,
        code: "invalid_payload",
        message: "invalid",
      }),
    ).toBe(false);
  });

  it("schedules retries from provider completion time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const harness = store(job());
      harness.fail.mockResolvedValue("retry_scheduled");
      await runPmsChannexManagementWorkerOnce({
        store: harness.port,
        provider: {
          execute: vi.fn(async () => {
            vi.setSystemTime(new Date(now.getTime() + 30_000));
            return { ok: false, code: "timeout", message: "timed out" } as const;
          }),
        },
        workerId: "worker-1",
      });

      expect(harness.fail).toHaveBeenCalledWith(
        job(),
        expect.objectContaining({ code: "timeout" }),
        expect.objectContaining({
          now: new Date(now.getTime() + 30_000),
          retryAt: new Date(now.getTime() + 31_000),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function job(): ChannexManagementJob {
  return {
    jobId: "job-1",
    propertyId: "property-1",
    correlationId: "correlation-1",
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "command-1", idempotencyKey: "key-1", operationType: "enable" },
  };
}

function store(claimed: ChannexManagementJob | null) {
  const succeed = vi.fn<ChannexManagementWorkerStore["succeed"]>();
  const fail = vi.fn<ChannexManagementWorkerStore["fail"]>();
  const heartbeat = vi.fn<ChannexManagementWorkerStore["heartbeat"]>();
  return {
    succeed,
    fail,
    heartbeat,
    port: { claim: vi.fn().mockResolvedValue(claimed), heartbeat, succeed, fail },
  };
}
