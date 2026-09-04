import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BookingPublicationOperation,
  type ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import { createProductReadinessResult } from "@vayada/domain-hotels";

import {
  createBookingPublicationRefresh,
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

describe("Booking publication refresh", () => {
  it("accepts a pending operation when the background worker leased it first", async () => {
    const propertyId = "22222222-2222-4222-8222-222222222222";
    const readiness = (await createProductReadinessResult({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId,
      product: "booking",
      status: "ready",
      sourceManifest: {
        contractVersion: "onboarding-source-manifest.v1",
        propertyId,
        sources: [
          {
            ownerDomain: "booking",
            entityType: "booking_settings",
            entityId: propertyId,
            revision: "booking-settings:4",
          },
        ],
      },
      groups: [
        {
          groupId: "booking.guest_experience",
          status: "ready",
          steps: [
            {
              owningStepId: "guest_experience",
              status: "ready",
              entities: [
                {
                  source: {
                    ownerDomain: "booking",
                    entityType: "booking_settings",
                    entityId: propertyId,
                    revision: "booking-settings:4",
                  },
                  status: "ready",
                  blockers: [],
                },
              ],
            },
          ],
        },
      ],
      evaluatedAt: "2026-09-03T00:00:00.000Z",
    })) as ReadyBookingPublicationEvidence;
    const pending: BookingPublicationOperation = {
      operationId: "33333333-3333-4333-8333-333333333333",
      propertyId,
      status: "pending",
      expectedActiveContentRevisionId: null,
      resultContentRevisionId: null,
      failureCode: null,
      requestedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      completedAt: null,
    };
    const projectPending = vi.fn().mockResolvedValue({
      processed: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
    });
    const refresh = createBookingPublicationRefresh({
      readinessProvider: { getBookingReadiness: vi.fn().mockResolvedValue(readiness) },
      projection: { getActive: vi.fn().mockResolvedValue(null) },
      repository: {
        requestPublication: vi.fn().mockResolvedValue({ ok: true, operation: pending }),
        getPublicationStatus: vi.fn().mockResolvedValue(pending),
      },
      projector: { projectPending },
    });

    await expect(
      refresh({
        organizationId: "11111111-1111-4111-8111-111111111111",
        propertyId,
        actorUserId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "refresh-1",
        audit: { requestId: "request-1", source: "booking-admin" },
      }),
    ).resolves.toEqual(pending);
    expect(projectPending).toHaveBeenCalledWith({ propertyId });
  });
});
