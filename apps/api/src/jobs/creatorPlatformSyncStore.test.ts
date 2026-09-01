import { describe, expect, it } from "vitest";

import {
  CREATOR_PLATFORM_SYNC_JOB_TYPE,
  CREATOR_PLATFORM_SYNC_QUEUE,
  createPgCreatorPlatformSyncStore,
  type CreatorPlatformSyncJob,
} from "./creatorPlatformSyncStore.js";

const now = new Date("2026-09-01T00:00:00.000Z");
const connectionId = "00000000-0000-4000-8000-000000000001";
const job: CreatorPlatformSyncJob = {
  jobId: "00000000-0000-4000-8000-000000000002",
  connectionId,
  provider: "meta",
  scheduledAt: now.toISOString(),
  attemptNumber: 2,
  maxAttempts: 5,
  workerId: "creator-sync:test",
  invalidPayload: false,
};

describe("creator platform sync job store", () => {
  it("schedules due active connections with an ID-only payload", async () => {
    const db = new FakePool([[{ id: job.jobId }]]);
    const store = createPgCreatorPlatformSyncStore({ connectionString: "unused", pool: db });

    await expect(store.schedule({ now, syncIntervalMs: 86_400_000, maxAttempts: 5 })).resolves.toBe(
      1,
    );

    const call = db.calls[0]!;
    expect(call.text).toContain("jsonb_build_object('connectionId', connection.id::text)");
    expect(call.text).toContain("status IN ('pending', 'running')");
    expect(call.text).toContain("ON CONFLICT (queue_name, job_key) DO NOTHING");
    expect(call.values).toEqual([
      now.toISOString(),
      86_400_000,
      5,
      CREATOR_PLATFORM_SYNC_QUEUE,
      CREATOR_PLATFORM_SYNC_JOB_TYPE,
    ]);
  });

  it("claims one provider-fenced job and records an attempt", async () => {
    const db = new FakePool([
      [],
      [
        {
          jobId: job.jobId,
          attemptsCount: 2,
          maxAttempts: 5,
          payload: { connectionId },
          provider: "meta",
          scheduledAt: now,
        },
      ],
    ]);
    const store = createPgCreatorPlatformSyncStore({ connectionString: "unused", pool: db });

    await expect(
      store.claim({
        now,
        workerId: job.workerId,
        minimumSpacingMs: { meta: 1_000, tiktok: 2_000, google: 3_000 },
      }),
    ).resolves.toEqual(job);

    expect(db.sql()).toContain("pg_advisory_xact_lock");
    expect(db.sql()).toContain("FOR UPDATE OF job SKIP LOCKED");
    expect(db.sql()).toContain("INSERT INTO platform.job_attempts");
    expect(db.calls.find(({ text }) => text.includes("WITH candidate"))?.values?.slice(-3)).toEqual(
      [1_000, 2_000, 3_000],
    );
  });

  it("rejects payloads containing anything except the connection ID", async () => {
    const db = new FakePool([
      [],
      [
        {
          jobId: job.jobId,
          attemptsCount: 1,
          maxAttempts: 5,
          payload: { connectionId, credentialRef: "must-not-be-here" },
          provider: "meta",
          scheduledAt: now,
        },
      ],
    ]);
    const store = createPgCreatorPlatformSyncStore({ connectionString: "unused", pool: db });

    await expect(
      store.claim({
        now,
        workerId: job.workerId,
        minimumSpacingMs: { meta: 1, tiktok: 1, google: 1 },
      }),
    ).resolves.toMatchObject({ connectionId: null, invalidPayload: true });
  });

  it("fences completion by worker and attempt", async () => {
    const db = new FakePool([[{ id: job.jobId }]]);
    const store = createPgCreatorPlatformSyncStore({ connectionString: "unused", pool: db });

    await expect(store.succeed(job, { now, outcome: "succeeded" })).resolves.toBe(true);

    expect(db.sql()).toContain("attempt_number = $2 AND worker_id = $3");
    expect(db.sql()).toContain("attempts_count = $2 AND locked_by = $3");
  });

  it("persists bounded retry timing and terminal dead-letter evidence", async () => {
    const retryAt = new Date(now.getTime() + 60_000);
    const retryDb = new FakePool([[{ id: job.jobId }]]);
    const retryStore = createPgCreatorPlatformSyncStore({
      connectionString: "unused",
      pool: retryDb,
    });
    await expect(retryStore.fail(job, { now, code: "provider_rate_limit", retryAt })).resolves.toBe(
      true,
    );
    expect(retryDb.calls[0]?.values?.at(-1)).toBe(retryAt.toISOString());

    const terminalDb = new FakePool([[{ id: job.jobId }]]);
    const terminalStore = createPgCreatorPlatformSyncStore({
      connectionString: "unused",
      pool: terminalDb,
    });
    await expect(
      terminalStore.fail(job, { now, code: "provider_request", retryAt: null }),
    ).resolves.toBe(true);
    expect(terminalDb.sql()).toContain("INSERT INTO platform.dead_letter_events");
    expect(terminalDb.sql()).toContain("creator_platform_sync_exhausted");
  });
});

class FakePool {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly results: unknown[][]) {}
  async query<T>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    const controlStatement =
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("pg_advisory_xact_lock");
    return { rows: (controlStatement ? [] : (this.results.shift() ?? [])) as T[] };
  }
  async connect() {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }
  async end() {}
  sql() {
    return this.calls.map(({ text }) => text).join("\n");
  }
}
