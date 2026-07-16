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
    expect(
      database.clientQueries.some(({ text }) =>
        text.includes("INSERT INTO platform.media_objects"),
      ),
    ).toBe(true);
    expect(
      database.poolQueries.some(({ text }) => text.includes("INSERT INTO platform.media_objects")),
    ).toBe(false);
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
    expect(
      database.clientQueries.some(({ text }) =>
        text.includes("INSERT INTO platform.media_objects"),
      ),
    ).toBe(true);
    expect(
      database.poolQueries.some(({ text }) => text.includes("INSERT INTO platform.media_objects")),
    ).toBe(false);
    await expect(repository.findMediaObject(session.files[0]!.mediaId)).resolves.toBeNull();

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

type FakeMediaRow = {
  mediaId: string;
  bucket: string;
  storageKey: string;
  purpose: PlatformMediaObjectRecord["purpose"];
  ownerOrganizationId: string;
  propertyId?: string;
  resourceProduct: PlatformMediaObjectRecord["resourceProduct"];
  resourceType: string;
  resourceId: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
  originalFilename: string;
  requestedVisibility: "public" | "private";
  actorUserId: string;
  createdAt: string;
};

type FakeVariantRow = PlatformMediaObjectRecord["variants"][number] & {
  mediaId: string;
  createdAt: string;
};

type FakeDatabaseState = {
  session: PlatformMediaSessionRecord | null;
  mediaRows: Map<string, FakeMediaRow>;
  variantRows: FakeVariantRow[];
};

function createFakeDatabase(failAuditAction?: string) {
  let committed = emptyDatabaseState();
  let transaction: FakeDatabaseState | null = null;
  const queries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const clientQueries: QueryCall[] = [];
  const failAuditActions = new Set(failAuditAction ? [failAuditAction] : []);
  const release = vi.fn();
  const end = vi.fn(async () => undefined);

  const poolQuery = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const call = { text, values };
    queries.push(call);
    poolQueries.push(call);
    return executeFakeQuery(committed, text, values, failAuditActions);
  });

  const clientQuery = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const call = { text, values };
    queries.push(call);
    clientQueries.push(call);
    if (text === "BEGIN") {
      transaction = structuredClone(committed);
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      transaction = null;
      return { rows: [] };
    }
    if (text === "COMMIT") {
      if (!transaction) throw new Error("Missing fake database transaction");
      committed = transaction;
      transaction = null;
      return { rows: [] };
    }
    return executeFakeQuery(transaction ?? committed, text, values, failAuditActions);
  });

  return {
    get session() {
      return committed.session;
    },
    queries,
    poolQueries,
    clientQueries,
    failAuditActions,
    pool: {
      query: poolQuery,
      async connect() {
        return { query: clientQuery, release };
      },
      end,
    },
  };
}

function emptyDatabaseState(): FakeDatabaseState {
  return { session: null, mediaRows: new Map(), variantRows: [] };
}

function executeFakeQuery(
  state: FakeDatabaseState,
  text: string,
  values: readonly unknown[] | undefined,
  failAuditActions: ReadonlySet<string>,
) {
  if (
    text.includes("INSERT INTO platform.product_audit_events") &&
    failAuditActions.has(String(values?.[1]))
  ) {
    throw new Error("audit failed");
  }
  if (text.includes("INSERT INTO platform.media_upload_sessions")) {
    state.session = metadata(values?.[15]).session;
  } else if (text.includes("completion_metadata -> 'session'")) {
    return { rows: state.session ? [{ session: state.session }] : [] };
  } else if (text.includes("UPDATE platform.media_upload_sessions")) {
    state.session = metadata(values?.[2]).session;
  } else if (text.includes("INSERT INTO platform.media_objects")) {
    const sourceMetadata = jsonValue<{ requestedVisibility: "public" | "private" }>(values?.[15]);
    const row: FakeMediaRow = {
      mediaId: String(values?.[0]),
      bucket: String(values?.[1]),
      storageKey: String(values?.[2]),
      purpose: values?.[3] as FakeMediaRow["purpose"],
      ownerOrganizationId: String(values?.[4]),
      propertyId: optionalString(values?.[5]),
      resourceProduct: values?.[6] as FakeMediaRow["resourceProduct"],
      resourceType: String(values?.[7]),
      resourceId: String(values?.[8]),
      contentType: String(values?.[9]),
      sizeBytes: Number(values?.[10]),
      checksumSha256: optionalString(values?.[11]),
      widthPx: optionalNumber(values?.[12]),
      heightPx: optionalNumber(values?.[13]),
      originalFilename: String(values?.[14]),
      requestedVisibility: sourceMetadata.requestedVisibility,
      actorUserId: String(values?.[16]),
      createdAt: String(values?.[17]),
    };
    state.mediaRows.set(row.mediaId, row);
  } else if (text.includes("INSERT INTO platform.media_variants")) {
    state.variantRows.push({
      mediaId: String(values?.[0]),
      variantName: values?.[1] as FakeVariantRow["variantName"],
      visibility: "public",
      storageKey: String(values?.[2]),
      contentType: String(values?.[3]),
      widthPx: optionalNumber(values?.[4]),
      heightPx: optionalNumber(values?.[5]),
      sizeBytes: Number(values?.[6]),
      checksumSha256: optionalString(values?.[7]),
      publicCdnUrl: optionalString(values?.[8]) ?? null,
      createdAt: String(values?.[9]),
    });
  } else if (text.includes("FROM platform.media_objects media")) {
    const row = state.mediaRows.get(String(values?.[0]));
    return { rows: row ? [{ record: mediaRecord(row, state.variantRows) }] : [] };
  }
  return { rows: [] };
}

function mediaRecord(row: FakeMediaRow, variantRows: FakeVariantRow[]): PlatformMediaObjectRecord {
  return {
    mediaId: row.mediaId,
    purpose: row.purpose,
    visibility: "public",
    requestedVisibility: row.requestedVisibility,
    approvalStatus: "approved",
    lifecycleStatus: "active",
    storageKind: "vayada_managed",
    bucket: row.bucket,
    storageKey: row.storageKey,
    ownerOrganizationId: row.ownerOrganizationId,
    actorUserId: row.actorUserId,
    resourceProduct: row.resourceProduct,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    propertyId: row.propertyId,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    originalFilename: row.originalFilename,
    variants: variantRows
      .filter(({ mediaId }) => mediaId === row.mediaId)
      .map(({ mediaId: _mediaId, createdAt: _createdAt, ...variant }) => variant),
    createdAt: row.createdAt,
  };
}

function metadata(value: unknown): { session: PlatformMediaSessionRecord } {
  return jsonValue<{ session: PlatformMediaSessionRecord }>(value);
}

function jsonValue<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Expected JSON metadata");
  return JSON.parse(value) as T;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
