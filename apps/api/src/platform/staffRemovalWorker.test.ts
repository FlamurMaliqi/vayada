import { describe, expect, it, vi } from "vitest";

import { startStaffRemovalWorker } from "./staffRemovalWorker.js";

describe("startStaffRemovalWorker", () => {
  it("automatically revokes every due job", async () => {
    const repository = { listDueJobIds: vi.fn(async () => ["job-1", "job-2"]) };
    const coordinator = {
      revoke: vi.fn(async (jobId: string) => ({ outcome: "revoked" as const, jobId })),
    };
    const worker = startStaffRemovalWorker({ repository, coordinator, warn: vi.fn() });

    await worker.runNow();
    expect(coordinator.revoke).toHaveBeenCalledTimes(2);
    expect(coordinator.revoke).toHaveBeenCalledWith("job-1");
    expect(coordinator.revoke).toHaveBeenCalledWith("job-2");
    await worker.close();
  });

  it("does not overlap runs and waits for every active job on close", async () => {
    const failure = new Error("unexpected coordinator failure");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const repository = { listDueJobIds: vi.fn(async () => ["job-1", "job-2"]) };
    const coordinator = {
      revoke: vi.fn(async (jobId: string) => {
        if (jobId === "job-1") throw failure;
        await pending;
        return { outcome: "revoked" as const, jobId };
      }),
    };
    const warn = vi.fn();
    const worker = startStaffRemovalWorker({ repository, coordinator, warn });
    const overlapping = worker.runNow();

    await vi.waitFor(() => expect(coordinator.revoke).toHaveBeenCalledTimes(2));
    expect(repository.listDueJobIds).toHaveBeenCalledOnce();
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await Promise.all([overlapping, closing]);
    expect(warn).toHaveBeenCalledWith({ err: failure }, "Staff removal worker failed");
  });

  it("logs a failed run and allows the next run", async () => {
    const failure = new Error("database unavailable");
    const repository = {
      listDueJobIds: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([]),
    };
    const warn = vi.fn();
    const worker = startStaffRemovalWorker({
      repository,
      coordinator: { revoke: vi.fn() },
      warn,
    });

    await worker.runNow();
    expect(warn).toHaveBeenCalledWith({ err: failure }, "Staff removal worker failed");
    await worker.runNow();
    expect(repository.listDueJobIds).toHaveBeenCalledTimes(2);
    await worker.close();
  });
});
