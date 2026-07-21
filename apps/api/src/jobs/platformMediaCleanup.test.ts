import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION,
  PLATFORM_MEDIA_CLEANUP_QUEUE,
  buildPlatformMediaCleanupJobKey,
  buildPlatformMediaCleanupKey,
  createPgPlatformMediaCleanupStore,
  distinctPlatformMediaStorageKeys,
  runPlatformMediaCleanupJobs,
  type PlatformMediaCleanupAction,
  type PlatformMediaCleanupCandidate,
  type PlatformMediaCleanupContext,
  type PlatformMediaCleanupFailureResult,
  type PlatformMediaCleanupMutation,
  type PlatformMediaCleanupMutationResult,
  type PlatformMediaCleanupRunName,
  type PlatformMediaCleanupStore,
} from "./platformMediaCleanup.js";

const cleanupContractCases = JSON.parse(
  readFileSync(
    new URL("../../../../engineering/fixtures/platform-media-cleanup/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  contractVersion: string;
  cases: Array<{
    caseId: string;
    runName: PlatformMediaCleanupRunName;
    candidate: PlatformMediaCleanupCandidate;
    expected: {
      action: PlatformMediaCleanupAction;
      statusAfter: string;
      rollbackCleanupStatus?: string;
      cleanupKey: string;
      jobType: string;
      eventType: string;
      auditAction: string;
    };
  }>;
};

describe("platform media cleanup jobs", () => {
  it("cleans every platform media lifecycle fixture idempotently", async () => {
    const now = new Date("2026-06-13T12:00:00.000Z");
    const store = createFixtureStore();

    const firstRun = await runPlatformMediaCleanupJobs(store, {
      now,
      workerId: "worker_media_cleanup",
    });
    const rerun = await runPlatformMediaCleanupJobs(store, {
      now,
      workerId: "worker_media_cleanup",
    });

    expect(cleanupContractCases.contractVersion).toBe(PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION);
    expect(firstRun).toMatchObject({
      contractVersion: PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION,
      scanned: 4,
      applied: 4,
      skipped: 0,
      failed: 0,
    });
    expect(rerun).toMatchObject({
      scanned: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
    });

    for (const fixture of cleanupContractCases.cases) {
      const resource = store.resource(fixture.candidate);
      expect(resource?.lifecycleStatus).toBe(fixture.expected.statusAfter);
      if (fixture.expected.rollbackCleanupStatus) {
        expect(resource?.rollbackCleanupStatus).toBe(fixture.expected.rollbackCleanupStatus);
      }
      expect(store.domainEvents).toContainEqual(
        expect.objectContaining({
          eventKey: fixture.expected.cleanupKey,
          eventType: fixture.expected.eventType,
        }),
      );
      expect(store.jobs).toContainEqual(
        expect.objectContaining({
          jobKey: buildPlatformMediaCleanupJobKey({
            action: fixture.expected.action,
            resourceId: cleanupResourceId(fixture.candidate),
            deadlineOrWindow: deadlineOrWindowForFixture(fixture.candidate, fixture.runName),
          }),
          jobType: fixture.expected.jobType,
          queueName: PLATFORM_MEDIA_CLEANUP_QUEUE,
          status: "succeeded",
        }),
      );
      expect(store.idempotencyKeys).toContain(fixture.expected.cleanupKey);
      expect(store.productAuditEvents).toContainEqual(
        expect.objectContaining({
          auditKey: fixture.expected.cleanupKey,
          action: fixture.expected.auditAction,
        }),
      );
    }

    expect(store.domainEvents).toHaveLength(4);
    expect(store.jobs).toHaveLength(4);
    expect(store.jobAttempts).toHaveLength(4);
    expect(store.idempotencyKeys).toHaveLength(4);
    expect(store.productAuditEvents).toHaveLength(4);
    expect(store.deadLetterEvents).toHaveLength(0);
    expect(store.storageDeletes).toEqual([
      {
        kind: "prefix",
        bucket: null,
        key: "staging/00000000-0000-0000-0000-000000000101",
      },
      {
        kind: "object",
        bucket: "vayada-media-local",
        key: "public/properties/property_alpenrose/00000000-0000-0000-0000-000000000201/original_safe.jpg",
      },
      {
        kind: "object",
        bucket: "vayada-media-local",
        key: "private/pms/properties/property_alpenrose/messages/thread_guest_123/00000000-0000-0000-0000-000000000301/invoice.pdf",
      },
      {
        kind: "object",
        bucket: "legacy-vayada-media",
        key: "legacy/booking/hotels/alpenrose/hero.jpg",
      },
    ]);
  });

  it("does not delete private attachments before the retained-until date", async () => {
    const store = new MemoryPlatformMediaCleanupStore([
      {
        mediaObjectId: "00000000-0000-0000-0000-000000000302",
        resourceProduct: "pms",
        resourceType: "message_thread",
        resourceId: "thread_guest_future",
        purpose: "pms.messaging.attachment",
        visibility: "private",
        lifecycleStatus: "retained",
        retainedUntil: "2026-06-20T00:00:00.000Z",
      },
    ]);

    const result = await runPlatformMediaCleanupJobs(store, {
      now: new Date("2026-06-13T12:00:00.000Z"),
      run: ["privateAttachmentRetention"],
    });

    expect(result).toMatchObject({ scanned: 0, applied: 0, failed: 0 });
    expect(store.media("00000000-0000-0000-0000-000000000302")?.lifecycleStatus).toBe("retained");
    expect(store.jobs).toHaveLength(0);
  });

  it("deletes a private attachment exactly at its retained-until deadline", async () => {
    const mediaObjectId = "00000000-0000-0000-0000-000000000303";
    const retainedUntil = "2026-06-20T00:00:00.000Z";
    const storageKey = `private/media/${mediaObjectId}/provider_original/image.jpg`;
    const store = new MemoryPlatformMediaCleanupStore([
      {
        mediaObjectId,
        resourceProduct: "marketplace",
        resourceType: "collaboration",
        resourceId: "collaboration_expired",
        purpose: "marketplace.collaboration_chat.attachment",
        visibility: "private",
        lifecycleStatus: "active",
        bucket: "vayada-media-local",
        storageKey,
        retainedUntil,
      },
    ]);

    const result = await runPlatformMediaCleanupJobs(store, {
      now: new Date(retainedUntil),
      run: ["privateAttachmentRetention"],
    });

    expect(result).toMatchObject({ scanned: 1, applied: 1, failed: 0 });
    expect(store.media(mediaObjectId)).toMatchObject({
      lifecycleStatus: "deleted",
      deletedAt: retainedUntil,
    });
    expect(store.storageDeletes).toEqual([
      { kind: "object", bucket: "vayada-media-local", key: storageKey },
    ]);
  });

  it("rechecks retention under lock before deleting a selected chat attachment", async () => {
    const retainedUntil = "2026-06-20T00:00:00.000Z";
    const query = vi.fn(async (statement: string) => {
      if (statement === "BEGIN" || statement === "COMMIT") return { rows: [] };
      if (statement.includes("FOR UPDATE")) {
        expect(statement).toContain("media.retained_until <= $2::timestamptz");
        expect(statement).toContain("marketplace.collaboration_chat.attachment");
        return { rows: [] };
      }
      throw new Error(`Unexpected cleanup query: ${statement}`);
    });
    const connect = vi
      .spyOn(pg.Pool.prototype, "connect")
      .mockResolvedValue({ query, release: vi.fn() } as never);
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const objectDeleter = {
      deleteObject: vi.fn(async () => undefined),
      deletePrefix: vi.fn(async () => undefined),
    };
    const store = createPgPlatformMediaCleanupStore({
      connectionString: "postgresql://cleanup-race.invalid/vayada",
      objectDeleter,
    });

    try {
      const result = await store.applyCleanupMutation(
        {
          mediaObjectId: "00000000-0000-0000-0000-000000000304",
          resourceProduct: "marketplace",
          resourceType: "collaboration",
          resourceId: "collaboration_claimed_during_cleanup",
          purpose: "marketplace.collaboration_chat.attachment",
          visibility: "private",
          lifecycleStatus: "active",
          bucket: "vayada-media-local",
          storageKey: "private/chat/claimed.webp",
          retainedUntil,
        },
        {
          action: "delete-private-attachment-after-retention",
          runName: "privateAttachmentRetention",
          jobType: "platform.media.cleanup.private-attachment-retention",
          eventType: "platform_media.private_attachment.deleted_after_retention",
          auditAction: "platform_media.cleanup.private_attachment_deleted_after_retention",
          deadlineOrWindow: retainedUntil,
        },
        {
          now: new Date(retainedUntil),
          correlationId: "cleanup-race-regression",
          workerId: "cleanup-test",
        },
      );

      expect(result.applied).toBe(false);
      expect(objectDeleter.deleteObject).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      await store.close();
      connect.mockRestore();
      end.mockRestore();
    }
  });

  it("records failure visibility without deleting the candidate and without duplicate dead letters", async () => {
    const replaced = contractCase("replaced-public-image-deletes-after-request");
    const store = new MemoryPlatformMediaCleanupStore([replaced.candidate], {
      failResourceIds: [cleanupResourceId(replaced.candidate)],
    });

    const firstRun = await runPlatformMediaCleanupJobs(store, {
      now: new Date("2026-06-13T12:00:00.000Z"),
      workerId: "worker_media_cleanup",
      run: ["replacedPublicImages"],
    });
    const rerun = await runPlatformMediaCleanupJobs(store, {
      now: new Date("2026-06-13T12:00:00.000Z"),
      workerId: "worker_media_cleanup",
      run: ["replacedPublicImages"],
    });

    expect(firstRun).toMatchObject({ scanned: 1, applied: 0, failed: 1 });
    expect(rerun).toMatchObject({ scanned: 1, applied: 0, failed: 1 });
    expect(store.media(replaced.candidate.mediaObjectId!)?.lifecycleStatus).toBe(
      "delete_requested",
    );
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      queueName: PLATFORM_MEDIA_CLEANUP_QUEUE,
      jobType: replaced.expected.jobType,
      status: "dead_lettered",
    });
    expect(store.jobAttempts).toHaveLength(1);
    expect(store.jobAttempts[0]).toMatchObject({
      status: "failed",
      errorType: "Error",
      errorMessage: "object storage delete failed",
    });
    expect(store.deadLetterEvents).toHaveLength(1);
    expect(store.deadLetterEvents[0]).toMatchObject({
      reasonCode: "media_storage_delete_failed",
      recoveryStatus: "open",
    });
  });

  it("uses the stable media cleanup key format", () => {
    expect(
      buildPlatformMediaCleanupKey({
        action: "delete-private-attachment-after-retention",
        resourceId: "media_123",
        deadlineOrWindow: "2026-06-12T00:00:00.000Z",
      }),
    ).toBe(
      "platform.media.cleanup:media_123:delete-private-attachment-after-retention:2026-06-12T00:00:00.000Z:v1",
    );
    expect(
      buildPlatformMediaCleanupJobKey({
        action: "delete-private-attachment-after-retention",
        resourceId: "media_123",
        deadlineOrWindow: "2026-06-12T00:00:00.000Z",
      }),
    ).toBe(
      "platform.media.cleanup:job:media_123:delete-private-attachment-after-retention:2026-06-12T00:00:00.000Z:v1",
    );
  });

  it("includes every recorded variant key and deduplicates the canonical object key", () => {
    const originalSafe = "media/object/original_safe.webp";
    expect(
      distinctPlatformMediaStorageKeys(originalSafe, [
        originalSafe,
        "media/object/large.webp",
        "media/object/thumbnail.webp",
        "media/object/blur_preview.webp",
      ]),
    ).toEqual([
      originalSafe,
      "media/object/large.webp",
      "media/object/thumbnail.webp",
      "media/object/blur_preview.webp",
    ]);
  });
});

type FixtureResource = PlatformMediaCleanupCandidate & {
  deletedAt?: string;
  rollbackCleanupStatus?: string;
};

type FixtureJob = {
  jobKey: string;
  jobType: string;
  queueName: string;
  status: "succeeded" | "dead_lettered";
  payload: Record<string, unknown>;
};

type FixtureJobAttempt = {
  jobKey: string;
  attemptNumber: number;
  status: "succeeded" | "failed";
  errorType?: string;
  errorMessage?: string;
};

function createFixtureStore(): MemoryPlatformMediaCleanupStore {
  return new MemoryPlatformMediaCleanupStore(
    cleanupContractCases.cases.map((fixture) => fixture.candidate),
  );
}

class MemoryPlatformMediaCleanupStore implements PlatformMediaCleanupStore {
  readonly domainEvents: Array<{
    eventKey: string;
    eventType: string;
    payload: Record<string, unknown>;
  }> = [];
  readonly jobs: FixtureJob[] = [];
  readonly jobAttempts: FixtureJobAttempt[] = [];
  readonly idempotencyKeys: string[] = [];
  readonly productAuditEvents: Array<{
    auditKey: string;
    action: string;
    payload: Record<string, unknown>;
  }> = [];
  readonly deadLetterEvents: Array<{
    jobKey: string;
    reasonCode: string;
    recoveryStatus: "open";
    errorMessage: string;
  }> = [];
  readonly storageDeletes: Array<{
    kind: "object" | "prefix";
    bucket: string | null;
    key: string;
  }> = [];

  private readonly resources: FixtureResource[];
  private readonly failResourceIds: Set<string>;

  constructor(
    resources: PlatformMediaCleanupCandidate[],
    options: { failResourceIds?: string[] } = {},
  ) {
    this.resources = resources.map((resource) => ({ ...resource }));
    this.failResourceIds = new Set(options.failResourceIds ?? []);
  }

  resource(candidate: PlatformMediaCleanupCandidate): FixtureResource | undefined {
    return candidate.uploadSessionId
      ? this.uploadSession(candidate.uploadSessionId)
      : this.media(candidate.mediaObjectId!);
  }

  media(mediaObjectId: string): FixtureResource | undefined {
    return this.resources.find((resource) => resource.mediaObjectId === mediaObjectId);
  }

  uploadSession(uploadSessionId: string): FixtureResource | undefined {
    return this.resources.find((resource) => resource.uploadSessionId === uploadSessionId);
  }

  async findAbandonedStagingUploads(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]> {
    return this.resources
      .filter(
        (resource) =>
          Boolean(resource.uploadSessionId) &&
          ["requested", "signed", "uploaded", "failed"].includes(resource.lifecycleStatus) &&
          Boolean(resource.expiresAt) &&
          new Date(resource.expiresAt!) <= now,
      )
      .slice(0, limit);
  }

  async findReplacedPublicImages(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]> {
    return this.resources
      .filter(
        (resource) =>
          resource.visibility === "public" &&
          resource.lifecycleStatus === "delete_requested" &&
          Boolean(resource.deletionRequestedAt) &&
          new Date(resource.deletionRequestedAt!) <= now &&
          Boolean(resource.replacedByMediaObjectId),
      )
      .slice(0, limit);
  }

  async findPrivateAttachmentsPastRetention(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]> {
    return this.resources
      .filter(
        (resource) =>
          resource.visibility === "private" &&
          ["marketplace.collaboration_chat.attachment", "pms.messaging.attachment"].includes(
            resource.purpose ?? "",
          ) &&
          ["active", "retained", "delete_requested"].includes(resource.lifecycleStatus) &&
          Boolean(resource.retainedUntil) &&
          new Date(resource.retainedUntil!) <= now,
      )
      .slice(0, limit);
  }

  async findRollbackWindowCleanupCandidates(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]> {
    return this.resources
      .filter(
        (resource) =>
          Boolean(resource.rollbackWindowEndsAt) &&
          new Date(resource.rollbackWindowEndsAt!) <= now &&
          resource.rollbackCleanupStatus !== "completed",
      )
      .slice(0, limit);
  }

  async applyCleanupMutation(
    candidate: PlatformMediaCleanupCandidate,
    mutation: PlatformMediaCleanupMutation,
    context: PlatformMediaCleanupContext,
  ): Promise<PlatformMediaCleanupMutationResult> {
    const resource = this.resource(candidate);
    const resourceId = cleanupResourceId(candidate);
    const cleanupKey = buildPlatformMediaCleanupKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });
    const jobKey = buildPlatformMediaCleanupJobKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });

    if (this.failResourceIds.has(resourceId)) {
      throw new Error("object storage delete failed");
    }
    if (!resource || this.idempotencyKeys.includes(cleanupKey)) {
      return { action: mutation.action, applied: false, resourceId, cleanupKey, jobKey };
    }

    if (mutation.action === "abandoned-staging-upload") {
      resource.lifecycleStatus = "expired";
      if (resource.stagingPrefix) {
        this.storageDeletes.push({
          kind: "prefix",
          bucket: resource.bucket ?? null,
          key: resource.stagingPrefix,
        });
      }
    } else if (mutation.action === "cleanup-rollback-window-object") {
      resource.rollbackCleanupStatus = "completed";
      if (resource.rollbackStorageKey) {
        this.storageDeletes.push({
          kind: "object",
          bucket: resource.rollbackBucket ?? resource.bucket ?? null,
          key: resource.rollbackStorageKey,
        });
      }
    } else {
      resource.lifecycleStatus = "deleted";
      resource.deletedAt = context.now.toISOString();
      if (resource.storageKey) {
        this.storageDeletes.push({
          kind: "object",
          bucket: resource.bucket ?? null,
          key: resource.storageKey,
        });
      }
    }

    const payload = {
      action: mutation.action,
      resourceId,
      lifecycleStatus: resource.lifecycleStatus,
      deadlineOrWindow: mutation.deadlineOrWindow,
    };
    this.idempotencyKeys.push(cleanupKey);
    this.domainEvents.push({ eventKey: cleanupKey, eventType: mutation.eventType, payload });
    this.jobs.push({
      jobKey,
      jobType: mutation.jobType,
      queueName: PLATFORM_MEDIA_CLEANUP_QUEUE,
      status: "succeeded",
      payload,
    });
    this.jobAttempts.push({ jobKey, attemptNumber: 1, status: "succeeded" });
    this.productAuditEvents.push({
      auditKey: cleanupKey,
      action: mutation.auditAction,
      payload,
    });

    return { action: mutation.action, applied: true, resourceId, cleanupKey, jobKey };
  }

  async recordCleanupFailure(
    candidate: PlatformMediaCleanupCandidate,
    mutation: PlatformMediaCleanupMutation,
    error: unknown,
    _context: PlatformMediaCleanupContext,
  ): Promise<PlatformMediaCleanupFailureResult> {
    const resourceId = cleanupResourceId(candidate);
    const cleanupKey = buildPlatformMediaCleanupKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });
    const jobKey = buildPlatformMediaCleanupJobKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });
    const errorInfo = error instanceof Error ? error : new Error(String(error));

    if (!this.jobs.some((job) => job.jobKey === jobKey)) {
      this.jobs.push({
        jobKey,
        jobType: mutation.jobType,
        queueName: PLATFORM_MEDIA_CLEANUP_QUEUE,
        status: "dead_lettered",
        payload: { action: mutation.action, resourceId },
      });
      this.jobAttempts.push({
        jobKey,
        attemptNumber: 1,
        status: "failed",
        errorType: errorInfo.name,
        errorMessage: errorInfo.message,
      });
      this.deadLetterEvents.push({
        jobKey,
        reasonCode: "media_storage_delete_failed",
        recoveryStatus: "open",
        errorMessage: errorInfo.message,
      });
    }

    return {
      action: mutation.action,
      resourceId,
      cleanupKey,
      jobKey,
      reasonCode: "media_storage_delete_failed",
      errorType: errorInfo.name,
      errorMessage: errorInfo.message,
      deadLettered: true,
    };
  }
}

function contractCase(caseId: string): (typeof cleanupContractCases.cases)[number] {
  const found = cleanupContractCases.cases.find((candidate) => candidate.caseId === caseId);
  if (!found) throw new Error(`Missing platform media cleanup fixture: ${caseId}`);
  return found;
}

function cleanupResourceId(candidate: PlatformMediaCleanupCandidate): string {
  return candidate.mediaObjectId ?? candidate.uploadSessionId ?? candidate.resourceId;
}

function deadlineOrWindowForFixture(
  candidate: PlatformMediaCleanupCandidate,
  runName: PlatformMediaCleanupRunName,
): string {
  switch (runName) {
    case "abandonedStagingUploads":
      return candidate.expiresAt!;
    case "replacedPublicImages":
      return candidate.deletionRequestedAt!;
    case "privateAttachmentRetention":
      return candidate.retainedUntil!;
    case "rollbackWindowCleanup":
      return candidate.rollbackWindowEndsAt!;
  }
}
