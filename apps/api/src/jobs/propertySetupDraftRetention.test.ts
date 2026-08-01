import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPgPropertySetupDraftRetentionStore,
  startPropertySetupDraftRetentionWorker,
  type PropertySetupDraftRetentionPool,
  type PropertySetupDraftRetentionStore,
} from "./propertySetupDraftRetention.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("property setup draft retention", () => {
  it("deletes bounded, oldest-first session and step-draft batches with cross-worker locking", async () => {
    const query = vi
      .fn<PropertySetupDraftRetentionPool["query"]>()
      .mockResolvedValueOnce({
        rows: [{ id: "session-1" }, { id: "session-2" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "session-3" }],
      });
    const end = vi.fn(async () => undefined);
    const store = createPgPropertySetupDraftRetentionStore({
      connectionString: "postgresql://retention.invalid/vayada",
      pool: { query, end },
    });
    const now = new Date("2026-07-30T12:00:00.000Z");

    await expect(store.deleteExpiredBatch(now, 2)).resolves.toEqual({
      sessions: 2,
      stepDrafts: 1,
    });
    expect(query).toHaveBeenCalledTimes(2);

    const [sessionStatement, sessionValues] = query.mock.calls[0]!;
    expect(sessionStatement).toContain("WHERE retention_expires_at <= $1::timestamptz");
    expect(sessionStatement).toContain("ORDER BY retention_expires_at ASC, id ASC");
    expect(sessionStatement).toContain("LIMIT $2");
    expect(sessionStatement).toContain("FOR UPDATE SKIP LOCKED");
    expect(sessionStatement).toContain("DELETE FROM hotel_catalog.property_setup_sessions");
    expect(sessionValues).toEqual([now.toISOString(), 2]);

    const [draftStatement, draftValues] = query.mock.calls[1]!;
    expect(draftStatement).toContain("WHERE retention_expires_at <= $1::timestamptz");
    expect(draftStatement).toContain(
      "ORDER BY retention_expires_at ASC, session_id ASC, step_id ASC",
    );
    expect(draftStatement).toContain("LIMIT $2");
    expect(draftStatement).toContain("FOR UPDATE SKIP LOCKED");
    expect(draftStatement).toContain(
      "DELETE FROM hotel_catalog.property_setup_step_drafts AS draft",
    );
    expect(draftValues).toEqual([now.toISOString(), 2]);
  });

  it("relies on the migration's cascading session-to-draft foreign key", () => {
    const migration = readFileSync(
      new URL(
        "../../../../packages/backend-migration/migrations/0045_property_setup_drafts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toMatch(
      /REFERENCES hotel_catalog\.property_setup_sessions\(id\) ON DELETE CASCADE/,
    );
  });

  it("runs immediately and periodically without overlapping", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deleteExpiredBatch = vi
      .fn<PropertySetupDraftRetentionStore["deleteExpiredBatch"]>()
      .mockImplementationOnce(() => firstRun.then(() => ({ sessions: 1, stepDrafts: 0 })))
      .mockResolvedValue({ sessions: 0, stepDrafts: 0 });
    const store = fakeStore(deleteExpiredBatch);
    const worker = startPropertySetupDraftRetentionWorker({
      store,
      enabled: true,
      intervalMs: 1_000,
      batchSize: 25,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      logger: { warn: vi.fn() },
    });

    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
    releaseFirst();
    await worker.runNow();
    await worker.runNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deleteExpiredBatch).toHaveBeenCalledTimes(3);
    expect(deleteExpiredBatch).toHaveBeenLastCalledWith(new Date("2026-07-30T12:00:00.000Z"), 25);
    await worker.close();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("does not schedule or run when disabled", async () => {
    vi.useFakeTimers();
    const deleteExpiredBatch = vi
      .fn<PropertySetupDraftRetentionStore["deleteExpiredBatch"]>()
      .mockResolvedValue({ sessions: 0, stepDrafts: 0 });
    const store = fakeStore(deleteExpiredBatch);
    const worker = startPropertySetupDraftRetentionWorker({
      store,
      enabled: false,
      intervalMs: 1_000,
      logger: { warn: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deleteExpiredBatch).not.toHaveBeenCalled();
    await worker.close();
  });

  it("drains every full batch against one cutoff time", async () => {
    const deleteExpiredBatch = vi
      .fn<PropertySetupDraftRetentionStore["deleteExpiredBatch"]>()
      .mockResolvedValueOnce({ sessions: 2, stepDrafts: 2 })
      .mockResolvedValueOnce({ sessions: 2, stepDrafts: 0 })
      .mockResolvedValueOnce({ sessions: 1, stepDrafts: 0 });
    const now = vi.fn(() => new Date("2026-07-30T12:00:00.000Z"));
    const worker = startPropertySetupDraftRetentionWorker({
      store: fakeStore(deleteExpiredBatch),
      enabled: false,
      intervalMs: 1_000,
      batchSize: 2,
      now,
      logger: { warn: vi.fn() },
    });

    await worker.runNow();

    expect(deleteExpiredBatch).toHaveBeenCalledTimes(3);
    expect(now).toHaveBeenCalledOnce();
    expect(deleteExpiredBatch.mock.calls.map(([cutoff]) => cutoff)).toEqual([
      new Date("2026-07-30T12:00:00.000Z"),
      new Date("2026-07-30T12:00:00.000Z"),
      new Date("2026-07-30T12:00:00.000Z"),
    ]);
    await worker.close();
  });

  it("rejects timer intervals above Node's supported maximum", () => {
    expect(() =>
      startPropertySetupDraftRetentionWorker({
        store: fakeStore(vi.fn()),
        enabled: false,
        intervalMs: 2_147_483_648,
        logger: { warn: vi.fn() },
      }),
    ).toThrow("interval must be between 1 and 2147483647");
  });

  it("stops draining after the current batch when closing", async () => {
    let releaseBatch!: () => void;
    const batch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const deleteExpiredBatch = vi
      .fn<PropertySetupDraftRetentionStore["deleteExpiredBatch"]>()
      .mockImplementation(() => batch.then(() => ({ sessions: 2, stepDrafts: 2 })));
    const store = fakeStore(deleteExpiredBatch);
    const worker = startPropertySetupDraftRetentionWorker({
      store,
      enabled: false,
      intervalMs: 1_000,
      batchSize: 2,
      logger: { warn: vi.fn() },
    });

    void worker.runNow();
    const closing = worker.close();
    releaseBatch();
    await closing;

    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    await worker.runNow();
    expect(deleteExpiredBatch).toHaveBeenCalledOnce();
  });

  it("logs cleanup failures without rejecting the worker run", async () => {
    const failure = new Error("database unavailable");
    const warn = vi.fn();
    const deleteExpiredBatch = vi
      .fn<PropertySetupDraftRetentionStore["deleteExpiredBatch"]>()
      .mockRejectedValue(failure);
    const worker = startPropertySetupDraftRetentionWorker({
      store: fakeStore(deleteExpiredBatch),
      enabled: false,
      intervalMs: 1_000,
      logger: { warn },
    });

    await expect(worker.runNow()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { err: failure },
      "Property setup draft retention cleanup failed",
    );
    await worker.close();
  });
});

function fakeStore(
  deleteExpiredBatch: PropertySetupDraftRetentionStore["deleteExpiredBatch"],
): PropertySetupDraftRetentionStore & { close: ReturnType<typeof vi.fn> } {
  return {
    deleteExpiredBatch,
    close: vi.fn(async () => undefined),
  };
}
