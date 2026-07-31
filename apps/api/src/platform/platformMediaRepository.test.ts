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

  it("atomically renews an unfinished signed upload session", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const created = await createSession(repository);

    const renewed = await repository.renewSignedUploadSession({
      session: created,
      expiresAt: "2026-07-16T13:15:00.000Z",
      now: "2026-07-16T13:00:00.000Z",
    });

    expect(renewed).toMatchObject({
      sessionId: created.sessionId,
      status: "signed",
      expiresAt: "2026-07-16T13:15:00.000Z",
      files: [{ mediaId: created.files[0]!.mediaId }],
    });
    expect(database.session?.expiresAt).toBe("2026-07-16T13:15:00.000Z");
    expect(database.session?.uploadTargets[0]?.expiresAt).toBe("2026-07-16T13:15:00.000Z");
    expect(
      database.poolQueries.some(({ text }) =>
        text.includes("platform_media_upload_session_renewal"),
      ),
    ).toBe(true);
  });

  it("returns the existing upload session when the idempotency identity races", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const created = await createSession(repository);
    const replayed = await createSession(repository);

    expect(replayed).toMatchObject({
      sessionId: created.sessionId,
      uploadSessionKey: created.uploadSessionKey,
      files: [{ mediaId: created.files[0]!.mediaId }],
      uploadTargets: [{ uploadTargetId: created.uploadTargets[0]!.uploadTargetId, uploadUrl: "" }],
    });
    expect(
      database.clientQueries.filter(({ text }) =>
        text.includes("INSERT INTO platform.media_upload_sessions"),
      ),
    ).toHaveLength(2);
    expect(
      database.clientQueries.filter(({ text }) =>
        text.includes("INSERT INTO platform.product_audit_events"),
      ),
    ).toHaveLength(1);
  });

  it("completes once, replays idempotently, and reads media from a fresh repository", async () => {
    const database = createFakeDatabase();
    const first = repositoryFor(database.pool);
    const session = await createSession(first);
    const completion = completionInput(session);

    const completed = await first.completeUploadSession(completion);
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

    const canonicalStorageKey = "media/profile/canonical-original-safe.webp";
    database.updateMediaRow(session.files[0]!.mediaId, { storageKey: canonicalStorageKey });
    const replayed = await repositoryFor(database.pool).completeUploadSession(completion);
    expect(replayed.mediaObjects[0]).toMatchObject({ storageKey: canonicalStorageKey });
    expect(replayed.uploadSession.completedMediaObject).toMatchObject({
      storageKey: canonicalStorageKey,
    });

    const fresh = repositoryFor(database.pool);
    await expect(fresh.findMediaObject(session.files[0]!.mediaId)).resolves.toMatchObject({
      storageKey: canonicalStorageKey,
    });
    expect(
      database.queries.find(({ text }) => text.includes("FROM platform.media_objects media"))?.text,
    ).toContain("to_char(");
  });

  it("persists requested-public offer media as private and staged for approval", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "marketplace.offer.media");

    expect(session).toMatchObject({
      purpose: "marketplace.offer.media",
      requestedVisibility: "public",
      effectiveVisibility: "private",
    });

    const completed = await repository.completeUploadSession(completionInput(session));
    expect(completed.mediaObjects[0]).toMatchObject({
      purpose: "marketplace.offer.media",
      visibility: "private",
      requestedVisibility: "public",
      approvalStatus: "pending_domain_approval",
      lifecycleStatus: "staged",
      variants: [
        expect.objectContaining({
          visibility: "private",
          publicCdnUrl: null,
        }),
      ],
    });

    const objectInsert = database.clientQueries.find(({ text }) =>
      text.includes("INSERT INTO platform.media_objects"),
    );
    expect(objectInsert?.values?.[3]).toBe("private");
    expect(objectInsert?.values?.[10]).toBe("staged");
    expect(objectInsert?.values?.[18]).toBe(false);
    const variantInsert = database.clientQueries.find(({ text }) =>
      text.includes("INSERT INTO platform.media_variants"),
    );
    expect(variantInsert?.values?.[2]).toBe("private");
    expect(variantInsert?.values?.[9]).toBeNull();

    await expect(
      repositoryFor(database.pool).findMediaObject(session.files[0]!.mediaId),
    ).resolves.toMatchObject({
      approvalStatus: "pending_domain_approval",
      lifecycleStatus: "staged",
    });
  });

  it("persists private collaboration attachments as active provider originals", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "marketplace.collaboration_chat.attachment");

    const completed = await repository.completeUploadSession(completionInput(session));

    expect(completed.mediaObjects[0]).toMatchObject({
      purpose: "marketplace.collaboration_chat.attachment",
      visibility: "private",
      approvalStatus: "private",
      lifecycleStatus: "active",
      resourceProduct: "marketplace",
      resourceType: "collaboration",
      variants: [
        expect.objectContaining({
          variantName: "provider_original",
          visibility: "private",
          publicCdnUrl: null,
        }),
      ],
    });

    const objectInsert = database.clientQueries.find(({ text }) =>
      text.includes("INSERT INTO platform.media_objects"),
    );
    expect(objectInsert?.text).toContain("retained_until");
    expect(objectInsert?.text).toContain("interval '1 hour'");
    expect(JSON.parse(String(objectInsert?.values?.[17]))).toMatchObject({
      requestedVisibility: "private",
      attachmentState: "orphan",
    });
  });

  it("resolves a chat target only when the source resource belongs to the collaboration", async () => {
    const query = vi.fn(async () => ({
      rows: [{ collaborationId: "collaboration-target-001", propertyId: PROPERTY_ID }],
    }));
    const repository = createPgPlatformMediaRepository({
      connectionString: "postgresql://target.test/vayada",
      publicCdnBaseUrl: "https://cdn.example.com",
      pool: { query, connect: vi.fn(), end: vi.fn() } as never,
    });

    await expect(
      repository.resolveTarget({
        request: {
          purpose: "marketplace.collaboration_chat.attachment",
          visibility: "private",
          resource: {
            product: "marketplace",
            resourceType: "creator_profile",
            resourceId: "creator-profile-001",
            targetResourceId: "collaboration-source-001",
          },
          files: [],
        },
        policy: {
          targetResourceProduct: "marketplace",
          targetResourceType: "collaboration",
        } as never,
        context: {} as never,
      }),
    ).resolves.toEqual({
      ok: true,
      target: {
        resourceProduct: "marketplace",
        resourceType: "collaboration",
        resourceId: "collaboration-target-001",
        propertyId: PROPERTY_ID,
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("creator_profile_id"), [
      "collaboration-source-001",
      "creator-profile-001",
    ]);
  });

  it("rejects property hero sessions without an expected profile revision", async () => {
    const database = createFakeDatabase();

    await expect(
      createSession(repositoryFor(database.pool), "property.hero_image"),
    ).rejects.toThrow("Property hero images require expectedProfileRevision");
    expect(database.queries).toEqual([]);
  });

  it.each(["property.hero_image", "property.gallery_image"] as const)(
    "resolves and persists requested-public %s against the canonical property",
    async (purpose) => {
      const database = createFakeDatabase();
      const repository = repositoryFor(database.pool);
      const resolved = await repository.resolveTarget({
        request: {
          purpose,
          visibility: "public",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: BOOKING_HOTEL_ID,
            propertyId: "00000000-0000-4000-8000-000000000099",
          },
          files: [],
        },
        policy: {
          targetResourceProduct: "hotel_catalog",
          targetResourceType: "property",
        } as never,
        context: {} as never,
      });
      expect(resolved).toEqual({
        ok: true,
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: PROPERTY_ID,
          propertyId: PROPERTY_ID,
        },
      });

      const session = await createSession(
        repository,
        purpose,
        purpose === "property.hero_image" ? 1 : undefined,
      );
      if (purpose === "property.hero_image") {
        expect(session.expectedProfileRevision).toBe(1);
      }
      const completed = await repository.completeUploadSession(completionInput(session));
      expect(completed.mediaObjects[0]).toMatchObject({
        purpose,
        propertyId: PROPERTY_ID,
        resourceProduct: "hotel_catalog",
        resourceType: "property",
        resourceId: PROPERTY_ID,
        visibility: "public",
        requestedVisibility: "public",
        approvalStatus: "approved",
        lifecycleStatus: "active",
        variants: [
          expect.objectContaining({
            visibility: "public",
            publicCdnUrl: "https://cdn.example.com/media/profile/original-safe.webp",
          }),
        ],
      });
      const projection = database.clientQueries.find(({ text }) =>
        text.includes("INSERT INTO hotel_catalog.property_media"),
      );
      expect(projection?.values).toEqual([
        session.files[0]!.mediaId,
        PROPERTY_ID,
        purpose === "property.hero_image" ? "hero_image" : "gallery_image",
        "https://cdn.example.com/media/profile/original-safe.webp",
        JSON.stringify({ platformMediaObjectId: session.files[0]!.mediaId }),
        "2026-07-16T12:01:00.000Z",
      ]);
      expect(projection?.text).toContain("platform_media_object_id = $1::uuid");
      expect(projection?.text).toContain("source_system = 'platform'");
      expect(projection?.text).toContain("public_approved = TRUE");
      expect(projection?.text).toContain("COALESCE(MAX(sort_order) + 1, 1)");
      expect(projection?.text).not.toContain("FOR UPDATE");
      expect(projection?.text).toContain("advanced_property AS");
      expect(projection?.text).toContain("projected_media AS");
      expect(projection?.text).toContain("completeness AS");
      expect(projection?.text).toContain("BTRIM(profile.short_description)");
      expect(projection?.text).toContain("THEN 'description' END");
      expect(projection?.text).toContain("THEN 'media' END");
      expect(projection?.text).toContain("SET completeness_reasons = completeness.reasons");
      expect(projection?.text).toContain(
        "WHEN property.profile_status IN ('disabled', 'private') THEN property.profile_status",
      );
      expect(projection?.text).toContain(
        "WHEN cardinality(completeness.reasons) = 0 THEN 'complete'",
      );
      expect(projection?.text).toContain("profile_revision = property.profile_revision + 1");
      expect(
        database.clientQueries.findIndex(({ text }) =>
          text.includes('SELECT property.profile_revision AS "profileRevision"'),
        ),
      ).toBeLessThan(
        database.clientQueries.findIndex(({ text }) =>
          text.includes("INSERT INTO platform.media_objects"),
        ),
      );
      expect(
        database.clientQueries.findIndex(({ text }) =>
          text.includes("INSERT INTO hotel_catalog.property_media"),
        ),
      ).toBeGreaterThan(
        database.clientQueries.findIndex(({ text }) =>
          text.includes("INSERT INTO platform.media_variants"),
        ),
      );
    },
  );

  it("rolls back hero finalization before media writes when the profile revision is stale", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "property.hero_image", 2);

    await expect(repository.completeUploadSession(completionInput(session))).rejects.toMatchObject({
      code: "profile_revision_conflict",
      currentRevision: 1,
    });
    expect(database.session).toMatchObject({
      status: "signed",
      expectedProfileRevision: 2,
    });
    expect(database.mediaRowCount).toBe(0);
    expect(database.propertyRevision).toBe(1);
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(
      database.clientQueries.some(({ text }) =>
        text.includes("INSERT INTO platform.media_objects"),
      ),
    ).toBe(false);
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
      metadata: {
        purpose: "identity.user.profile_image",
        resourceId: "owner@example.com",
        firstName: "Ada",
      },
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
    expect(JSON.parse(String(audit?.values?.[7]))).toEqual({
      purpose: "identity.user.profile_image",
      resourceId: "[redacted-email]",
    });
    expect(JSON.parse(String(audit?.values?.[8]))).toEqual({
      requestId: "request-1",
      source: "apps/api-platform-media",
    });
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

const BOOKING_HOTEL_ID = "00000000-0000-4000-8000-000000000030";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000040";

async function createSession(
  repository: ReturnType<typeof createPgPlatformMediaRepository>,
  purpose:
    | "identity.user.profile_image"
    | "marketplace.offer.media"
    | "marketplace.collaboration_chat.attachment"
    | "property.hero_image"
    | "property.gallery_image" = "identity.user.profile_image",
  expectedProfileRevision?: number,
) {
  const isProfile = purpose === "identity.user.profile_image";
  const isOffer = purpose === "marketplace.offer.media";
  const isChat = purpose === "marketplace.collaboration_chat.attachment";
  const product = isProfile ? "platform" : isOffer || isChat ? "marketplace" : "booking";
  const resourceType = isProfile
    ? "user_profile"
    : isOffer
      ? "marketplace_offer"
      : isChat
        ? "creator_profile"
        : "booking_hotel";
  const resourceId = isProfile
    ? "00000000-0000-4000-8000-000000000001"
    : isOffer || isChat
      ? "00000000-0000-4000-8000-000000000020"
      : BOOKING_HOTEL_ID;
  const filename = isProfile
    ? "profile.jpg"
    : isOffer
      ? "offer.jpg"
      : isChat
        ? "chat.jpg"
        : "property.jpg";
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
      purpose,
      visibility: isChat ? "private" : "public",
      expectedProfileRevision,
      resource: {
        product,
        resourceType,
        resourceId,
      },
      files: [
        {
          clientFileId: purpose,
          filename,
          contentType: "image/jpeg",
          sizeBytes: 1024,
        },
      ],
    },
    policy: {
      purpose,
      autoApprovePublicOnFinalize: isOffer || isChat ? undefined : true,
    } as never,
    target: {
      resourceProduct: isProfile ? "platform" : isOffer || isChat ? "marketplace" : "hotel_catalog",
      resourceType: isProfile
        ? "user_profile"
        : isOffer
          ? "marketplace_offer"
          : isChat
            ? "collaboration"
            : "property",
      resourceId: isChat
        ? "collaboration-target-001"
        : isProfile || isOffer
          ? resourceId
          : PROPERTY_ID,
      propertyId: isChat ? PROPERTY_ID : isProfile || isOffer ? undefined : PROPERTY_ID,
    },
    uploadTargets: [
      {
        uploadTargetId: "target-1",
        clientFileId: purpose,
        method: "PUT",
        uploadUrl: "https://s3.example.com/signed",
        headers: { "content-type": "image/jpeg" },
        stagingKey: `staging/session-1/1/${filename}`,
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
      metadata: { purpose },
    },
  });
}

function completionInput(session: PlatformMediaSessionRecord) {
  const isPrivate = session.effectiveVisibility === "private";
  const isChat = session.purpose === "marketplace.collaboration_chat.attachment";
  const storageKey = isPrivate
    ? "private/media/offer/original-safe.webp"
    : "media/profile/original-safe.webp";
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
          variantName: isChat ? ("provider_original" as const) : ("original_safe" as const),
          visibility: session.effectiveVisibility,
          storageKey,
          contentType: "image/webp",
          widthPx: 800,
          heightPx: 800,
          sizeBytes: 900,
          checksumSha256: "b".repeat(64),
          publicCdnUrl: isPrivate
            ? null
            : "https://cdn.example.com/media/profile/original-safe.webp",
        },
      ],
    ],
    policy: { autoApprovePublicOnFinalize: true } as never,
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
      metadata: { purpose: session.purpose },
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
  visibility: "public" | "private";
  lifecycleStatus: "staged" | "active";
  publicApproved: boolean;
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
  propertyLinks: Map<string, string>;
  propertyRevision: number;
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
    get mediaRowCount() {
      return committed.mediaRows.size;
    },
    get propertyRevision() {
      return committed.propertyRevision;
    },
    queries,
    poolQueries,
    clientQueries,
    failAuditActions,
    updateMediaRow(mediaId: string, patch: Partial<FakeMediaRow>) {
      const row = committed.mediaRows.get(mediaId);
      if (!row) throw new Error(`Unknown fake media row ${mediaId}`);
      committed.mediaRows.set(mediaId, { ...row, ...patch });
    },
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
  return {
    session: null,
    mediaRows: new Map(),
    variantRows: [],
    propertyLinks: new Map([[BOOKING_HOTEL_ID, PROPERTY_ID]]),
    propertyRevision: 1,
  };
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
  if (text.includes("WITH property_candidates AS")) {
    const propertyId = state.propertyLinks.get(String(values?.[2]));
    return { rows: propertyId ? [{ propertyId }] : [] };
  } else if (text.includes("INSERT INTO platform.media_upload_sessions")) {
    if (state.session) return { rows: [] };
    state.session = metadata(values?.[15]).session;
    return { rows: [{ id: state.session.sessionId }] };
  } else if (text.includes('SELECT property.profile_revision AS "profileRevision"')) {
    return String(values?.[0]) === PROPERTY_ID
      ? { rows: [{ profileRevision: state.propertyRevision }] }
      : { rows: [] };
  } else if (text.includes("platform_media_upload_session_renewal")) {
    if (
      state.session?.sessionId === String(values?.[0]) &&
      state.session.status === "signed" &&
      state.session.expiresAt === String(values?.[1])
    ) {
      state.session = jsonValue<PlatformMediaSessionRecord>(values?.[2]);
      return {
        rows: [
          {
            session: state.session,
            completedMediaObjectId: null,
            mediaObjectIds: null,
          },
        ],
      };
    }
    return { rows: [] };
  } else if (text.includes("completion_metadata -> 'session'")) {
    return {
      rows: state.session
        ? [
            {
              session: state.session,
              completedMediaObjectId: state.session.completedMediaObject?.mediaId ?? null,
              mediaObjectIds:
                state.session.completedMediaObjects?.map(({ mediaId }) => mediaId) ?? null,
            },
          ]
        : [],
    };
  } else if (text.includes("UPDATE platform.media_upload_sessions")) {
    state.session = metadata(values?.[2]).session;
  } else if (text.includes("INSERT INTO platform.media_objects")) {
    const sourceMetadata = jsonValue<{ requestedVisibility: "public" | "private" }>(values?.[17]);
    const row: FakeMediaRow = {
      mediaId: String(values?.[0]),
      bucket: String(values?.[1]),
      storageKey: String(values?.[2]),
      visibility: values?.[3] as FakeMediaRow["visibility"],
      purpose: values?.[4] as FakeMediaRow["purpose"],
      ownerOrganizationId: String(values?.[5]),
      propertyId: optionalString(values?.[6]),
      resourceProduct: values?.[7] as FakeMediaRow["resourceProduct"],
      resourceType: String(values?.[8]),
      resourceId: String(values?.[9]),
      lifecycleStatus: values?.[10] as FakeMediaRow["lifecycleStatus"],
      contentType: String(values?.[11]),
      sizeBytes: Number(values?.[12]),
      checksumSha256: optionalString(values?.[13]),
      widthPx: optionalNumber(values?.[14]),
      heightPx: optionalNumber(values?.[15]),
      originalFilename: String(values?.[16]),
      requestedVisibility: sourceMetadata.requestedVisibility,
      publicApproved: Boolean(values?.[18]),
      actorUserId: String(values?.[19]),
      createdAt: String(values?.[20]),
    };
    state.mediaRows.set(row.mediaId, row);
  } else if (text.includes("INSERT INTO platform.media_variants")) {
    state.variantRows.push({
      mediaId: String(values?.[0]),
      variantName: values?.[1] as FakeVariantRow["variantName"],
      visibility: values?.[2] as FakeVariantRow["visibility"],
      storageKey: String(values?.[3]),
      contentType: String(values?.[4]),
      widthPx: optionalNumber(values?.[5]),
      heightPx: optionalNumber(values?.[6]),
      sizeBytes: Number(values?.[7]),
      checksumSha256: optionalString(values?.[8]),
      publicCdnUrl: optionalString(values?.[9]) ?? null,
      createdAt: String(values?.[10]),
    });
  } else if (text.includes("INSERT INTO hotel_catalog.property_media")) {
    state.propertyRevision += 1;
    return { rows: [{ id: PROPERTY_ID }] };
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
    visibility: row.visibility,
    requestedVisibility: row.requestedVisibility,
    approvalStatus: row.publicApproved
      ? "approved"
      : row.requestedVisibility === "public"
        ? "pending_domain_approval"
        : "private",
    lifecycleStatus: row.lifecycleStatus,
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
