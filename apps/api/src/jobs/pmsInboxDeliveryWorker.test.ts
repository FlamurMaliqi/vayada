import { describe, expect, it, vi } from "vitest";

import type {
  PmsInboxDeliveryCompletion,
  PmsInboxDeliveryJob,
  PmsInboxDeliveryStore,
} from "../domains/pmsInboxDelivery.js";
import { runPmsInboxDeliveryJobs } from "./pmsInboxDeliveryWorker.js";

const JOB: PmsInboxDeliveryJob = {
  id: "job-1",
  workerId: "worker-1",
  propertyId: "property-1",
  messageId: "message-1",
  attemptNumber: 1,
  maxAttempts: 5,
  correlationId: "correlation-1",
};

describe("PMS Inbox delivery worker", () => {
  it("sends a prepared route once and records the provider reference", async () => {
    const store = readyStore();
    const send = vi.fn(async () => ({ ok: true as const, providerReference: "provider-msg-1" }));

    await expect(
      runPmsInboxDeliveryJobs(store, { channex: { send } }, { workerId: "worker-1" }),
    ).resolves.toEqual({
      processed: 1,
      sent: 1,
      retrying: 0,
      held: 0,
      failed: 0,
      deadLettered: 0,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(JOB, {
      outcome: "accepted",
      attemptId: "attempt-1",
      providerReference: "provider-msg-1",
    });
  });

  it("schedules only a transient provider failure with bounded backoff", async () => {
    const store = readyStore();
    const send = vi.fn(async () => ({
      ok: false as const,
      failure: "transient_provider_failure" as const,
    }));
    const now = new Date("2026-09-03T00:00:00.000Z");

    await expect(
      runPmsInboxDeliveryJobs(store, { channex: { send } }, { now: () => now, random: () => 0.5 }),
    ).resolves.toMatchObject({ processed: 1, retrying: 1, deadLettered: 0 });
    expect(completion(store)).toMatchObject({
      outcome: "failed",
      failure: "transient_provider_failure",
      retryAt: new Date("2026-09-03T00:00:30.000Z"),
      projection: { state: "retrying", retry: true },
    });
  });

  it("holds route denial and ambiguous provider outcomes without retrying", async () => {
    const denied = storeWithPreparation({ state: "blocked", failure: "access_unavailable" });
    await runPmsInboxDeliveryJobs(denied, {});
    expect(completion(denied)).toMatchObject({
      attemptId: null,
      projection: { state: "held", reasonCode: "access_unavailable", retry: false },
    });

    const ambiguous = readyStore();
    await runPmsInboxDeliveryJobs(ambiguous, {
      channex: {
        send: vi.fn(async () => ({
          ok: false as const,
          failure: "ambiguous_provider_outcome" as const,
        })),
      },
    });
    expect(completion(ambiguous)).toMatchObject({
      attemptId: "attempt-1",
      projection: { state: "held", reasonCode: "ambiguous_provider_outcome", retry: false },
    });

    const unexpected = readyStore();
    await runPmsInboxDeliveryJobs(unexpected, {
      channex: { send: vi.fn(async () => Promise.reject(new Error("adapter crashed"))) },
    });
    expect(completion(unexpected)).toMatchObject({
      projection: { state: "held", reasonCode: "ambiguous_provider_outcome", retry: false },
    });
  });

  it("records an uncertain send as accepted when provider reconciliation finds it", async () => {
    const store = readyStore();
    const reconcile = vi.fn(async () => ({
      state: "accepted" as const,
      providerReference: "reconciled-message-1",
    }));

    await expect(
      runPmsInboxDeliveryJobs(store, {
        channex: {
          send: vi.fn(async () => ({
            ok: false as const,
            failure: "ambiguous_provider_outcome" as const,
          })),
          reconcile,
        },
      }),
    ).resolves.toMatchObject({ sent: 1, held: 0 });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" }));
    expect(completion(store)).toEqual({
      outcome: "accepted",
      attemptId: "attempt-1",
      providerReference: "reconciled-message-1",
    });
  });

  it.each(["unknown", "throws"])(
    "holds an uncertain send when provider reconciliation %s",
    async (outcome) => {
      const store = readyStore();
      const reconcile =
        outcome === "throws"
          ? vi.fn(async () => Promise.reject(new Error("reconciliation unavailable")))
          : vi.fn(async () => ({ state: "unknown" as const }));
      await runPmsInboxDeliveryJobs(store, {
        channex: {
          send: vi.fn(async () => ({
            ok: false as const,
            failure: "ambiguous_provider_outcome" as const,
          })),
          reconcile,
        },
      });
      expect(completion(store)).toMatchObject({
        projection: { state: "held", reasonCode: "ambiguous_provider_outcome", retry: false },
      });
    },
  );

  it("retries an uncertain send only after reconciliation proves it was not accepted", async () => {
    const store = readyStore();
    await runPmsInboxDeliveryJobs(
      store,
      {
        channex: {
          send: vi.fn(async () => ({
            ok: false as const,
            failure: "ambiguous_provider_outcome" as const,
          })),
          reconcile: vi.fn(async () => ({ state: "not_accepted" as const })),
        },
      },
      { now: () => new Date("2026-09-03T00:00:00.000Z"), random: () => 0.5 },
    );
    expect(completion(store)).toMatchObject({
      failure: "transient_provider_failure",
      retryAt: new Date("2026-09-03T00:00:30.000Z"),
      projection: { state: "retrying", retry: true },
    });
  });

  it("dead-letters exhausted transient failures", async () => {
    const store = readyStore({ attemptNumber: 5 });
    await expect(
      runPmsInboxDeliveryJobs(store, {
        channex: {
          send: vi.fn(async () => ({
            ok: false as const,
            failure: "transient_provider_failure" as const,
          })),
        },
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1, deadLettered: 1 });
    expect(completion(store)).toMatchObject({
      failure: "retry_exhausted",
      projection: { state: "failed", reasonCode: "retry_exhausted", retry: false },
    });
  });
});

function readyStore(overrides: Partial<PmsInboxDeliveryJob> = {}): PmsInboxDeliveryStore {
  return storeWithPreparation(
    {
      state: "ready",
      adapter: "channex",
      attemptId: "attempt-1",
      input: {
        messageId: "message-1",
        providerIdempotencyReference: "message:message-1",
        channel: "ota",
        providerConversationId: "thread-1",
        recipientEmail: null,
        senderEmail: null,
        subject: "Guest message",
        text: "Hello",
        attachments: [],
      },
    },
    overrides,
  );
}

function storeWithPreparation(
  preparation: Awaited<ReturnType<PmsInboxDeliveryStore["prepare"]>>,
  overrides: Partial<PmsInboxDeliveryJob> = {},
): PmsInboxDeliveryStore {
  let claimed = false;
  return {
    claim: vi.fn(async () => (claimed ? null : ((claimed = true), { ...JOB, ...overrides }))),
    prepare: vi.fn(async () => preparation),
    complete: vi.fn(async () => true),
  };
}

function completion(store: PmsInboxDeliveryStore): PmsInboxDeliveryCompletion {
  return vi.mocked(store.complete).mock.calls[0]![1];
}
