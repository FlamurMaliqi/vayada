import { describe, expect, it, vi } from "vitest";

import type {
  PlatformMediaObjectRecord,
  PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";

describe("PostgreSQL platform media repository", () => {
  it("persists upload targets and stable media IDs across repository instances", async () => {
    const database = createFakeDatabase();
    const first = repositoryFor(database.pool);
    const created = await createSession(first);
    const mediaId = created.files[0]!.mediaId;

    expect(mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.effectiveVisibility).toBe("public");
    expect(created.uploadTargets[0]!.uploadUrl).toBe("https://s3.example.com/signed");

    const fresh = repositoryFor(database.pool);
    const restored = await fresh.findUploadSession(created.sessionId);
    expect(restored?.files[0]!.mediaId).toBe(mediaId);
    expect(restored?.uploadTargets[0]).toMatchObject({
      uploadTargetId: "target-1",
      stagingKey: "staging/session-1/1/profile.jpg",
      uploadUrl: "",
      headers: {},
    });
    expect(database.session).toMatchObject({
      files: [{ mediaId, uploadTargetId: "target-1" }],
      uploadTargets: [{ stagingKey: "staging/session-1/1/profile.jpg", uploadUrl: "" }],
    });
    expect(JSON.stringify(database.session)).not.toContain("https://s3.example.com");
  });

  it("completes once, replays idempotently, and reads media from a fresh repository", async () => {
    const database = createFakeDatabase();
    const first = repositoryFor(database.pool);
    const session = await createSession(first);
    const completion = completionInput(session);

    const completed = await first.completeUploadSession(completion);
    const replayed = await repositoryFor(database.pool).completeUploadSession(completion);

    expect(replayed).toEqual(completed);
    expect(
      database.queries.filter(({ text }) => text.includes("INSERT INTO platform.media_objects")),
    ).toHaveLength(1);
    expect(completed.mediaObjects[0]).toMatchObject({
      mediaId: session.files[0]!.mediaId,
      visibility: "public",
      approvalStatus: "approved",
      lifecycleStatus: "active",
      storageKey: "media/profile/original-safe.webp",
      checksumSha256: "b".repeat(64),
    });

    const fresh = repositoryFor(database.pool);
    await expect(fresh.findMediaObject(session.files[0]!.mediaId)).resolves.toEqual(
      completed.mediaObjects[0],
    );
  });

  it("records append-only platform audit events", async () => {
    const database = createFakeDatabase();
    await repositoryFor(database.pool).recordAudit({
      action: "platform_media.upload_session.finalized",
      auditKey: "media.finalize:session-1",
      actorUserId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      targetType: "media_object",
      targetId: "00000000-0000-4000-8000-000000000003",
      requestId: "request-1",
      metadata: { purpose: "identity.user.profile_image" },
    });

    const audit = database.queries.find(({ text }) =>
      text.includes("INSERT INTO platform.product_audit_events"),
    );
    expect(audit?.values?.slice(0, 7)).toEqual([
      "media.finalize:session-1",
      "platform_media.upload_session.finalized",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
      "media_object",
      "00000000-0000-4000-8000-000000000003",
      "request-1",
    ]);
  });

  it("treats malformed PostgreSQL identifiers as missing without querying", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);

    await expect(repository.findUploadSession("not-a-uuid")).resolves.toBeNull();
    await expect(
      repository.findMediaObject("https://legacy.example/photo.jpg"),
    ).resolves.toBeNull();
    expect(database.queries).toEqual([]);
  });

  it("rolls back completion when its audit event cannot be recorded", async () => {
    const database = createFakeDatabase("platform_media.upload_session.finalized");
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository);
    const completion = completionInput(session);

    await expect(repository.completeUploadSession(completion)).rejects.toThrow("audit failed");
    expect(database.session?.status).toBe("signed");
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");

    database.failAuditActions.clear();
    await expect(repository.completeUploadSession(completion)).resolves.toMatchObject({
      uploadSession: { status: "completed" },
    });
  });
});

function repositoryFor(pool: ReturnType<typeof createFakeDatabase>["pool"]) {
  return createPgPlatformMediaRepository({
    connectionString: "postgresql://target.test/vayada",
    publicCdnBaseUrl: "https://cdn.example.com",
    pool: pool as never,
  });
}

async function createSession(repository: ReturnType<typeof createPgPlatformMediaRepository>) {
  return repository.createUploadSession({
    sessionId: "00000000-0000-4000-8000-000000000010",
    uploadSessionKey: "media.upload_session:session-1",
    stagingPrefix: "staging/session-1",
    context: {
      actor: { internalUserId: "00000000-0000-4000-8000-000000000001" },
      selectedOrganization: {
        organizationId: "00000000-0000-4000-8000-000000000002",
      },
    } as never,
    request: {
      purpose: "identity.user.profile_image",
      visibility: "public",
      resource: {
        product: "platform",
        resourceType: "user_profile",
        resourceId: "00000000-0000-4000-8000-000000000001",
      },
      files: [
        {
          clientFileId: "profile",
          filename: "profile.jpg",
          contentType: "image/jpeg",
          sizeBytes: 1024,
        },
      ],
    },
    policy: { autoApprovePublicOnFinalize: true } as never,
    target: {
      resourceProduct: "platform",
      resourceType: "user_profile",
      resourceId: "00000000-0000-4000-8000-000000000001",
    },
    uploadTargets: [
      {
        uploadTargetId: "target-1",
        clientFileId: "profile",
        method: "PUT",
        uploadUrl: "https://s3.example.com/signed",
        headers: { "content-type": "image/jpeg" },
        stagingKey: "staging/session-1/1/profile.jpg",
        expiresAt: "2026-07-16T12:15:00.000Z",
      },
    ],
    now: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-16T12:15:00.000Z",
    auditEvent: {
      action: "platform_media.upload_session.created",
      auditKey: "media.upload_session:session-1",
      actorUserId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      targetType: "media_upload_session",
      targetId: "00000000-0000-4000-8000-000000000010",
      requestId: "request-1",
      metadata: { purpose: "identity.user.profile_image" },
    },
  });
}

function completionInput(session: PlatformMediaSessionRecord) {
  return {
    session,
    files: [
      {
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        inspection: {
          contentType: "image/webp",
          sizeBytes: 900,
          checksumSha256: "a".repeat(64),
          widthPx: 800,
          heightPx: 800,
        },
      },
    ],
    variantSets: [
      [
        {
          variantName: "original_safe" as const,
          visibility: "public" as const,
          storageKey: "media/profile/original-safe.webp",
          contentType: "image/webp",
          widthPx: 800,
          heightPx: 800,
          sizeBytes: 900,
          checksumSha256: "b".repeat(64),
          publicCdnUrl: "https://cdn.example.com/media/profile/original-safe.webp",
        },
      ],
    ],
    bucketName: "vayada-media-production",
    now: "2026-07-16T12:01:00.000Z",
    auditEvent: {
      action: "platform_media.upload_session.finalized" as const,
      auditKey: "media.finalize:session-1",
      actorUserId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      targetType: "media_object" as const,
      targetId: session.files[0]!.mediaId,
      requestId: "request-1",
      metadata: { purpose: "identity.user.profile_image" },
    },
  };
}

type QueryCall = { text: string; values?: readonly unknown[] };

function createFakeDatabase(failAuditAction?: string) {
  let session: PlatformMediaSessionRecord | null = null;
  let transactionSnapshot: PlatformMediaSessionRecord | null = null;
  const queries: QueryCall[] = [];
  const failAuditActions = new Set(failAuditAction ? [failAuditAction] : []);
  const release = vi.fn();
  const end = vi.fn(async () => undefined);

  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, values });
    if (text === "BEGIN") {
      transactionSnapshot = session ? structuredClone(session) : null;
    } else if (text === "ROLLBACK") {
      session = transactionSnapshot;
      transactionSnapshot = null;
    } else if (text === "COMMIT") {
      transactionSnapshot = null;
    } else if (
      text.includes("INSERT INTO platform.product_audit_events") &&
      failAuditActions.has(String(values?.[1]))
    ) {
      throw new Error("audit failed");
    } else if (text.includes("INSERT INTO platform.media_upload_sessions")) {
      session = metadata(values?.[15]).session;
    } else if (text.includes("completion_metadata -> 'session'")) {
      return { rows: session ? [{ session }] : [] };
    } else if (text.includes("UPDATE platform.media_upload_sessions")) {
      session = metadata(values?.[2]).session;
    } else if (text.includes("FROM platform.media_objects media")) {
      const mediaId = values?.[0];
      const record = session?.completedMediaObjects?.find((media) => media.mediaId === mediaId);
      return { rows: record ? [{ record }] : [] };
    }
    return { rows: [] };
  });

  return {
    get session() {
      return session;
    },
    queries,
    failAuditActions,
    pool: {
      query,
      async connect() {
        return { query, release };
      },
      end,
    },
  };
}

function metadata(value: unknown): { session: PlatformMediaSessionRecord } {
  if (typeof value !== "string") throw new Error("Expected JSON metadata");
  return JSON.parse(value) as { session: PlatformMediaSessionRecord };
}
