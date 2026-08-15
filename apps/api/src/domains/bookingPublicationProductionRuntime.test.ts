import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startBookingPublicationWorker,
  type BookingPublicationWorker,
} from "./bookingPublicationProductionRuntime.js";

describe("Booking publication production worker", () => {
  let worker: BookingPublicationWorker | undefined;

  afterEach(async () => {
    await worker?.close();
    vi.useRealTimers();
  });

  it("starts immediately, stays single-flight, and drains before closing", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const runRetryBatch = vi.fn(
      () =>
        new Promise<{ processed: number; succeeded: number; failed: number; exhausted: number }>(
          (resolve) => {
            finish = () => resolve({ processed: 1, succeeded: 1, failed: 0, exhausted: 0 });
          },
        ),
    );
    worker = startBookingPublicationWorker({
      projector: { projectPending: vi.fn(), runRetryBatch },
      workerId: "worker-1",
      warn: vi.fn(),
      intervalMs: 10,
    });
    expect(runRetryBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30);
    expect(runRetryBatch).toHaveBeenCalledOnce();

    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish?.();
    await closing;
    await vi.advanceTimersByTimeAsync(30);
    expect(runRetryBatch).toHaveBeenCalledOnce();
  });

  it("reports failed batches and rejected worker calls without stopping the timer", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const runRetryBatch = vi
      .fn()
      .mockResolvedValueOnce({ processed: 1, succeeded: 0, failed: 1, exhausted: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({ processed: 0, succeeded: 0, failed: 0, exhausted: 0 });
    worker = startBookingPublicationWorker({
      projector: { projectPending: vi.fn(), runRetryBatch },
      workerId: "worker-2",
      warn,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(runRetryBatch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      { failed: 1, exhausted: 1 },
      "Booking publication worker completed with failures",
    );
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Booking publication worker failed",
    );
  });
});
