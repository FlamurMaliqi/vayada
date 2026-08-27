import { PROPERTY_MEDIA_PUBLIC_VARIANTS } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import type {
  PlatformMediaObjectRecord,
  PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import {
  PlatformMediaPlanLimitError,
  PlatformMediaTargetInvalidError,
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

  it("scopes persistent upload-session reads to both actor and organization", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository);

    await expect(
      repository.findUploadSessionForActor({
        sessionId: session.sessionId,
        actorUserId: session.actorUserId,
        ownerOrganizationId: session.ownerOrganizationId,
      }),
    ).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(
      repository.findUploadSessionForActor({
        sessionId: session.sessionId,
        actorUserId: "00000000-0000-4000-8000-000000000099",
        ownerOrganizationId: session.ownerOrganizationId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findUploadSessionForActor({
        sessionId: session.sessionId,
        actorUserId: session.actorUserId,
        ownerOrganizationId: "00000000-0000-4000-8000-000000000099",
      }),
    ).resolves.toBeNull();
  });

  it("rejects public property media before persistence", async () => {
    const database = createFakeDatabase();

    await expect(
      createSession(repositoryFor(database.pool), "property.hero_image", "public"),
    ).rejects.toThrow("Persistent platform media policy does not support this upload");
    expect(database.queries).toEqual([]);
  });

  it("rejects noncanonical property media before persistence", async () => {
    const database = createFakeDatabase();

    await expect(
      createSession(repositoryFor(database.pool), "property.hero_image", "private", {
        product: "booking",
        resourceType: "hotel",
        resourceId: "booking_hotel_alpenrose",
      } as never),
    ).rejects.toThrow("Property media requires a canonical property target");
    expect(database.queries).toEqual([]);
  });

  it("blocks room-media upload sessions at the commission plan limit", async () => {
    const database = createFakeDatabase();
    database.setRoomMediaCount(10);

    await expect(
      createSession(repositoryFor(database.pool), "pms.room_type.media"),
    ).rejects.toBeInstanceOf(PlatformMediaPlanLimitError);
    expect(
      database.clientQueries.some(({ text }) =>
        text.includes("INSERT INTO platform.media_upload_sessions"),
      ),
    ).toBe(false);
  });

  it("rejects a persisted noncanonical property session during finalization", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "property.hero_image");
    database.updateSession({
      resource: {
        product: "booking",
        resourceType: "hotel",
        resourceId: "booking_hotel_alpenrose",
      } as never,
    });

    await expect(repository.completeUploadSession(completionInput(session))).rejects.toBeInstanceOf(
      PlatformMediaTargetInvalidError,
    );
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

  it("persists Finance receipts as bounded staged orphans", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    await createSession(repository, "marketplace.collaboration_chat.attachment");
    database.updateSession({
      purpose: "finance.expense.receipt",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: PROPERTY_ID,
        propertyId: PROPERTY_ID,
        targetResourceId: "00000000-0000-4000-8000-000000000060",
      },
      target: {
        resourceProduct: "finance",
        resourceType: "expense",
        resourceId: "00000000-0000-4000-8000-000000000060",
        propertyId: PROPERTY_ID,
      },
    });
    const session = database.session!;
    const completed = await repository.completeUploadSession(completionInput(session));

    expect(completed.mediaObjects[0]).toMatchObject({
      purpose: "finance.expense.receipt",
      resourceProduct: "finance",
      resourceType: "expense",
      lifecycleStatus: "staged",
      retainedUntil: "2026-07-16T13:01:00.000Z",
      variants: [expect.objectContaining({ variantName: "provider_original" })],
    });
    const objectInsert = database.clientQueries.find(({ text }) =>
      text.includes("INSERT INTO platform.media_objects"),
    );
    expect(JSON.parse(String(objectInsert?.values?.[17]))).toMatchObject({
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

  it.each([
    ["property.hero_image", null],
    ["property.gallery_image", null],
    ["property.logo", null],
    ["pms.room_type.media", ROOM_TYPE_ID],
  ] as const)("resolves and persists canonical %s media", async (purpose, roomTypeId) => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const resolved = await repository.resolveTarget({
      request: {
        purpose,
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: PROPERTY_ID,
          ...(roomTypeId ? { targetResourceId: roomTypeId } : {}),
        },
        files: [],
      },
      policy: {
        targetResourceProduct: roomTypeId ? "pms" : "hotel_catalog",
        targetResourceType: roomTypeId ? "room_type" : "property",
      } as never,
      context: {} as never,
    });
    expect(resolved).toEqual({
      ok: true,
      target: {
        resourceProduct: roomTypeId ? "pms" : "hotel_catalog",
        resourceType: roomTypeId ? "room_type" : "property",
        resourceId: roomTypeId ?? PROPERTY_ID,
        propertyId: PROPERTY_ID,
      },
    });

    const session = await createSession(repository, purpose);
    const completed = await repository.completeUploadSession(completionInput(session));
    const publicRoomMedia = purpose === "pms.room_type.media";
    expect(completed.mediaObjects[0]).toMatchObject({
      purpose,
      propertyId: PROPERTY_ID,
      resourceProduct: roomTypeId ? "pms" : "hotel_catalog",
      resourceType: roomTypeId ? "room_type" : "property",
      resourceId: roomTypeId ?? PROPERTY_ID,
      visibility: publicRoomMedia ? "public" : "private",
      requestedVisibility: publicRoomMedia ? "public" : "private",
      approvalStatus: publicRoomMedia ? "approved" : "private",
      lifecycleStatus: publicRoomMedia ? "active" : "staged",
      variants: expect.arrayContaining([
        expect.objectContaining({
          visibility: publicRoomMedia ? "public" : "private",
          publicCdnUrl: publicRoomMedia ? expect.stringMatching(/^https:\/\//) : null,
        }),
      ]),
    });
    expect(completed.mediaObjects[0]!.variants.map(({ variantName }) => variantName)).toEqual(
      PROPERTY_MEDIA_PUBLIC_VARIANTS,
    );
    expect(
      database.clientQueries.some(({ text }) => text.includes("hotel_catalog.property_media")),
    ).toBe(false);
    expect(database.clientQueries.some(({ text }) => text.includes("profile_revision"))).toBe(
      false,
    );
  });

  it.each([
    ["a missing variant", (variants: PlatformMediaObjectRecord["variants"]) => variants.slice(1)],
    [
      "a duplicate variant",
      (variants: PlatformMediaObjectRecord["variants"]) => [
        variants[0]!,
        variants[0]!,
        ...variants.slice(2),
      ],
    ],
    [
      "a foreign storage key",
      (variants: PlatformMediaObjectRecord["variants"]) =>
        variants.map((variant, index) =>
          index === 0
            ? { ...variant, storageKey: variant.storageKey.replace("/media/", "/other/") }
            : variant,
        ),
    ],
    [
      "a public URL",
      (variants: PlatformMediaObjectRecord["variants"]) =>
        variants.map((variant, index) =>
          index === 0
            ? { ...variant, publicCdnUrl: "https://cdn.example.com/unsafe.webp" }
            : variant,
        ),
    ],
    [
      "a non-WebP MIME type",
      (variants: PlatformMediaObjectRecord["variants"]) =>
        variants.map((variant, index) =>
          index === 0 ? { ...variant, contentType: "image/jpeg" } : variant,
        ),
    ],
  ])("rejects property media persistence with %s", async (_label, mutateVariants) => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "property.gallery_image");
    const completion = completionInput(session);
    completion.variantSets[0] = mutateVariants(
      completion.variantSets[0]!,
    ) as (typeof completion.variantSets)[0];

    await expect(repository.completeUploadSession(completion)).rejects.toMatchObject({
      outcome: "rolled_back",
    });
    expect(database.session?.status).toBe("signed");
    expect(database.mediaRowCount).toBe(0);
  });

  it("rolls back when the room target changes inside the completion transaction", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "pms.room_type.media");
    database.setRoomTargetExists(false);

    await expect(repository.completeUploadSession(completionInput(session))).rejects.toBeInstanceOf(
      PlatformMediaTargetInvalidError,
    );
    expect(database.session?.status).toBe("signed");
    expect(database.mediaRowCount).toBe(0);
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("replays completed room media without requiring the room to still exist", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository, "pms.room_type.media");
    const completion = completionInput(session);
    await repository.completeUploadSession(completion);
    database.setRoomTargetExists(false);

    await expect(repository.completeUploadSession(completion)).resolves.toMatchObject({
      uploadSession: { status: "completed" },
      mediaObjects: [{ mediaId: session.files[0]!.mediaId }],
    });
  });

  it("reconciles a COMMIT that applied before its acknowledgement was lost", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository);
    database.setCommitMode("apply_then_throw");

    await expect(repository.completeUploadSession(completionInput(session))).resolves.toMatchObject(
      {
        uploadSession: { status: "completed" },
        mediaObjects: [{ mediaId: session.files[0]!.mediaId }],
      },
    );
    expect(database.session?.status).toBe("completed");
    expect(database.mediaRowCount).toBe(1);
  });

  it("reports an unknown outcome when COMMIT fails before applying", async () => {
    const database = createFakeDatabase();
    const repository = repositoryFor(database.pool);
    const session = await createSession(repository);
    database.setCommitMode("throw_before_apply");

    await expect(repository.completeUploadSession(completionInput(session))).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(database.session?.status).toBe("signed");
    expect(database.mediaRowCount).toBe(0);
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

    await expect(repository.completeUploadSession(completion)).rejects.toMatchObject({
      outcome: "rolled_back",
      cause: expect.objectContaining({ message: "audit failed" }),
    });
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

const PROPERTY_ID = "00000000-0000-4000-8000-000000000040";
const ROOM_TYPE_ID = "00000000-0000-4000-8000-000000000050";

async function createSession(
  repository: ReturnType<typeof createPgPlatformMediaRepository>,
  purpose:
    | "identity.user.profile_image"
    | "marketplace.offer.media"
    | "marketplace.collaboration_chat.attachment"
    | "property.hero_image"
    | "property.gallery_image"
    | "property.logo"
    | "pms.room_type.media" = "identity.user.profile_image",
  visibility?: "public" | "private",
  resourceOverride?: PlatformMediaSessionRecord["resource"],
) {
  const isProfile = purpose === "identity.user.profile_image";
  const isOffer = purpose === "marketplace.offer.media";
  const isChat = purpose === "marketplace.collaboration_chat.attachment";
  const isPropertyMedia = [
    "property.hero_image",
    "property.gallery_image",
    "property.logo",
    "pms.room_type.media",
  ].includes(purpose);
  const isRoomMedia = purpose === "pms.room_type.media";
  const product = isProfile ? "platform" : isOffer || isChat ? "marketplace" : "hotel_catalog";
  const resourceType = isProfile
    ? "user_profile"
    : isOffer
      ? "marketplace_offer"
      : isChat
        ? "creator_profile"
        : "property";
  const resourceId = isProfile
    ? "00000000-0000-4000-8000-000000000001"
    : isOffer || isChat
      ? "00000000-0000-4000-8000-000000000020"
      : PROPERTY_ID;
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
      visibility:
        visibility ?? (isRoomMedia ? "public" : isChat || isPropertyMedia ? "private" : "public"),
      resource: resourceOverride ?? {
        product,
        resourceType,
        resourceId,
        ...(isRoomMedia ? { targetResourceId: ROOM_TYPE_ID } : {}),
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
      autoApprovePublicOnFinalize: isProfile || isRoomMedia ? true : undefined,
      privateOnly: (isPropertyMedia && !isRoomMedia) || isChat,
    } as never,
    target: {
      resourceProduct: isProfile
        ? "platform"
        : isOffer || isChat
          ? "marketplace"
          : isRoomMedia
            ? "pms"
            : "hotel_catalog",
      resourceType: isProfile
        ? "user_profile"
        : isOffer
          ? "marketplace_offer"
          : isChat
            ? "collaboration"
            : isRoomMedia
              ? "room_type"
              : "property",
      resourceId: isChat
        ? "collaboration-target-001"
        : isProfile || isOffer
          ? resourceId
          : isRoomMedia
            ? ROOM_TYPE_ID
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
  const isFinance = session.purpose === "finance.expense.receipt";
  const isPropertyMedia = [
    "property.hero_image",
    "property.gallery_image",
    "property.logo",
    "pms.room_type.media",
  ].includes(session.purpose);
  const variantNames = isPropertyMedia
    ? PROPERTY_MEDIA_PUBLIC_VARIANTS
    : [isChat || isFinance ? ("provider_original" as const) : ("original_safe" as const)];
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
      variantNames.map((variantName, index) => {
        const checksumSha256 = String.fromCharCode(98 + index).repeat(64);
        const storageKey = isPropertyMedia
          ? `${isPrivate ? "private" : "public"}/media/${session.files[0]!.mediaId}/${variantName}/sha256-${checksumSha256}.webp`
          : isPrivate
            ? "private/media/offer/original-safe.webp"
            : "media/profile/original-safe.webp";
        const dimensions =
          variantName === "blur_preview"
            ? { widthPx: 32, heightPx: 18 }
            : variantName === "thumbnail"
              ? { widthPx: 320, heightPx: 180 }
              : variantName === "large"
                ? { widthPx: 800, heightPx: 720 }
                : { widthPx: 800, heightPx: 800 };
        return {
          variantName,
          visibility: session.effectiveVisibility,
          storageKey,
          contentType: "image/webp",
          ...dimensions,
          sizeBytes: 900,
          checksumSha256,
          publicCdnUrl: isPrivate
            ? null
            : `https://cdn.example.com/${storageKey.replace(/^public\//, "")}`,
        };
      }),
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
};

function createFakeDatabase(failAuditAction?: string) {
  let committed = emptyDatabaseState();
  let transaction: FakeDatabaseState | null = null;
  let roomTargetExists = true;
  let roomMediaCount = 0;
  let commitMode: "normal" | "apply_then_throw" | "throw_before_apply" = "normal";
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
    return executeFakeQuery(
      committed,
      text,
      values,
      failAuditActions,
      roomTargetExists,
      roomMediaCount,
    );
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
      if (commitMode === "throw_before_apply") {
        transaction = null;
        commitMode = "normal";
        throw new Error("commit acknowledgement lost before apply");
      }
      committed = transaction;
      transaction = null;
      if (commitMode === "apply_then_throw") {
        commitMode = "normal";
        throw new Error("commit acknowledgement lost after apply");
      }
      return { rows: [] };
    }
    return executeFakeQuery(
      transaction ?? committed,
      text,
      values,
      failAuditActions,
      roomTargetExists,
      roomMediaCount,
    );
  });

  return {
    get session() {
      return committed.session;
    },
    get mediaRowCount() {
      return committed.mediaRows.size;
    },
    queries,
    poolQueries,
    clientQueries,
    failAuditActions,
    setRoomTargetExists(value: boolean) {
      roomTargetExists = value;
    },
    setRoomMediaCount(value: number) {
      roomMediaCount = value;
    },
    setCommitMode(value: "normal" | "apply_then_throw" | "throw_before_apply") {
      commitMode = value;
    },
    updateMediaRow(mediaId: string, patch: Partial<FakeMediaRow>) {
      const row = committed.mediaRows.get(mediaId);
      if (!row) throw new Error(`Unknown fake media row ${mediaId}`);
      committed.mediaRows.set(mediaId, { ...row, ...patch });
    },
    updateSession(patch: Partial<PlatformMediaSessionRecord>) {
      if (!committed.session) throw new Error("Missing fake upload session");
      committed.session = { ...committed.session, ...patch };
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
  };
}

function executeFakeQuery(
  state: FakeDatabaseState,
  text: string,
  values: readonly unknown[] | undefined,
  failAuditActions: ReadonlySet<string>,
  roomTargetExists: boolean,
  roomMediaCount: number,
) {
  if (
    text.includes("INSERT INTO platform.product_audit_events") &&
    failAuditActions.has(String(values?.[1]))
  ) {
    throw new Error("audit failed");
  }
  if (text.includes("WITH property_candidates")) {
    return String(values?.[2]) === "booking_hotel_alpenrose"
      ? { rows: [{ propertyId: PROPERTY_ID }] }
      : { rows: [] };
  } else if (
    text.includes('property.profile_revision AS "profileRevision"') &&
    text.includes("FROM hotel_catalog.properties property")
  ) {
    return String(values?.[0]) === PROPERTY_ID ? { rows: [{ profileRevision: 1 }] } : { rows: [] };
  } else if (text.includes("FROM hotel_catalog.properties property")) {
    return String(values?.[0]) === PROPERTY_ID
      ? { rows: [{ propertyId: PROPERTY_ID }] }
      : { rows: [] };
  } else if (text.includes('AS "currentCount"') && text.includes("FROM pms.room_types room_type")) {
    return roomTargetExists &&
      String(values?.[0]) === PROPERTY_ID &&
      String(values?.[1]) === ROOM_TYPE_ID
      ? { rows: [{ currentCount: roomMediaCount }] }
      : { rows: [] };
  } else if (text.includes("FROM pms.room_types room_type")) {
    return roomTargetExists &&
      String(values?.[0]) === ROOM_TYPE_ID &&
      String(values?.[1]) === PROPERTY_ID
      ? { rows: [{ propertyId: PROPERTY_ID }] }
      : { rows: [] };
  } else if (text.includes("INSERT INTO platform.media_upload_sessions")) {
    if (state.session) return { rows: [] };
    state.session = metadata(values?.[15]).session;
    return { rows: [{ id: state.session.sessionId }] };
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
    const scoped =
      text.includes("actor_user_id = $2::uuid") &&
      text.includes("owner_organization_id = $3::uuid");
    const matchesScope =
      !scoped ||
      (state.session?.actorUserId === String(values?.[1]) &&
        state.session.ownerOrganizationId === String(values?.[2]));
    return {
      rows:
        state.session && matchesScope
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
