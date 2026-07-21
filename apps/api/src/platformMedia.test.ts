import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type Product,
  type ResourceRelationship,
  type ResourceType,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  createDeterministicPlatformMediaFinalizer,
  createDeterministicPlatformMediaUploadSigner,
  createInMemoryPlatformMediaRepository,
  type PlatformMediaObjectRecord,
  type PlatformMediaPurpose,
  type PlatformMediaRepository,
  type PlatformMediaTargetResolver,
  type PlatformMediaUploadFinalizer,
} from "./routes/platformMedia.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_media_user",
  workosOrgId: "workos_media_org",
  sessionId: "session_media",
  expiresAt: futureExpiry,
};

const uploadContractCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/platform-media-upload/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    request: {
      path: string;
      method: "POST";
      body: Record<string, unknown>;
    };
    finalize?: {
      files: Array<Record<string, unknown>>;
    };
    expected: {
      status: number;
      errorCode?: string;
      requestedVisibility?: string;
      effectiveVisibility?: string;
      finalizeStatus?: number;
      mediaObjectCount?: number;
      mediaObject?: Record<string, string>;
      requiredVariants?: string[];
      sideEffects?: string[];
    };
  }>;
};

const propertyGalleryCase = contractCase("property-gallery-upload-session");
const propertyGalleryBatchCase = contractCase("property-gallery-batch-upload-session");
const propertyTargetDenyCase = contractCase("property-gallery-deny-unresolved-property-target");
const privateChatVisibilityCase = contractCase("private-chat-attachment-rejects-public-visibility");
const propertyHeroPdfCase = contractCase("property-hero-rejects-pdf");
const pmsRoomTypeMediaCase = contractCase("pms-room-type-media-upload-session");
const pmsImportSourceImageCase = contractCase("pms-import-source-image-job");
const marketplaceCreatorProfileCase = contractCase("marketplace-creator-profile-upload-session");
const marketplaceOfferMediaCase = contractCase("marketplace-offer-media-upload-session");
const allMediaPurposes: readonly PlatformMediaPurpose[] = [
  "identity.user.profile_image",
  "property.hero_image",
  "property.gallery_image",
  "property.logo",
  "marketplace.offer.media",
  "marketplace.creator.profile_image",
  "marketplace.collaboration_chat.attachment",
  "pms.room_type.media",
  "pms.messaging.attachment",
  "pms.import.source_image",
];

type MediaCreateResponse = {
  contractVersion: string;
  uploadSession: {
    sessionId: string;
    requestedVisibility: string;
    effectiveVisibility: string;
  };
  uploadTargets: Array<{
    uploadTargetId: string;
    method: string;
    clientFileId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>;
};

type MediaFinalizeResponse = {
  mediaObject: PlatformMediaObjectRecord;
  mediaObjects: PlatformMediaObjectRecord[];
  sideEffects: string[];
};

type MediaImportResponse = {
  contractVersion: string;
  importJob: {
    importJobId: string;
    jobKey: string;
    purpose: string;
    status: string;
    sourceImageCount: number;
    target: {
      resourceProduct: string;
      resourceType: string;
      resourceId: string;
    };
  };
  sideEffects: string[];
};

type ErrorResponse = {
  code: string;
};

describe("platform media upload routes", () => {
  it("allows browser preflight requests from configured admin origins", async () => {
    const app = buildMediaApp({ allowedOrigins: ["https://admin.booking.localhost"] });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/media/upload-sessions",
      headers: {
        origin: "https://admin.booking.localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://admin.booking.localhost");
    expect(response.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
    expect(response.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
    expect(response.headers.vary).toBe("Origin");
  });

  it("omits CORS allow headers for unconfigured origins", async () => {
    const app = buildMediaApp({ allowedOrigins: ["https://admin.booking.localhost"] });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/media/upload-sessions",
      headers: {
        origin: "https://admin.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBeUndefined();
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    expect(response.headers.vary).toBe("Origin");
  });

  it("rejects disabled media purposes on create, finalize, and import", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const enabledApp = buildMediaApp({ repository });
    const create = await injectJson(enabledApp, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    expect(create.statusCode).toBe(201);

    const app = buildMediaApp({
      repository,
      enabledPurposes: ["identity.user.profile_image", "marketplace.creator.profile_image"],
    });

    const createDisabled = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const finalizeDisabled = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    const importDisabled = await injectJson(app, {
      method: "POST",
      url: pmsImportSourceImageCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsImportSourceImageCase.request.body,
    });

    for (const response of [createDisabled, finalizeDisabled, importDisabled]) {
      expect(response.statusCode).toBe(503);
      expect((response.body as ErrorResponse).code).toBe("media_purpose_unavailable");
    }
  });

  it("creates a signed property upload session and finalizes it with public variants", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });

    expect(create.statusCode).toBe(propertyGalleryCase.expected.status);
    const createBody = create.body as MediaCreateResponse;
    expect(createBody.contractVersion).toBe("platform-media-upload.v1");
    expect(createBody.uploadSession.requestedVisibility).toBe(
      propertyGalleryCase.expected.requestedVisibility,
    );
    expect(createBody.uploadSession.effectiveVisibility).toBe(
      propertyGalleryCase.expected.effectiveVisibility,
    );
    expect(createBody.uploadTargets).toHaveLength(1);
    expect(createBody.uploadTargets[0]).toMatchObject({
      method: "PUT",
      clientFileId: "hero",
      headers: {
        "content-type": "image/jpeg",
      },
    });
    expect(createBody.uploadTargets[0]!.uploadUrl).toContain("staging%2F");
    expect(repository.auditEvents).toHaveLength(1);
    expect(repository.auditEvents[0]).toMatchObject({
      action: "platform_media.upload_session.created",
      actorUserId: "user_media",
      organizationId: "org_media",
    });

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(finalize.statusCode).toBe(propertyGalleryCase.expected.finalizeStatus);
    const finalizeBody = finalize.body as MediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryCase.expected.mediaObjectCount ?? 1,
    );
    expect(finalizeBody.mediaObject).toMatchObject(propertyGalleryCase.expected.mediaObject!);
    expect(finalizeBody.mediaObject.variants.map((variant) => variant.variantName)).toEqual([
      ...(propertyGalleryCase.expected.requiredVariants ?? []),
    ]);
    expect(
      finalizeBody.mediaObject.variants.every(
        (variant) => variant.publicCdnUrl?.startsWith("https://") === true,
      ),
    ).toBe(true);
    expect(finalizeBody.sideEffects).toEqual(propertyGalleryCase.expected.sideEffects);
    expect(repository.auditEvents).toHaveLength(2);
    expect(repository.auditEvents[1]).toMatchObject({
      action: "platform_media.upload_session.finalized",
      organizationId: "org_media",
    });

    const unauthenticatedReplay = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    expect(unauthenticatedReplay.statusCode).toBe(401);

    const authenticatedReplay = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    expect(authenticatedReplay.statusCode).toBe(200);
    expect((authenticatedReplay.body as { sideEffects: string[] }).sideEffects).toEqual([
      "idempotency_replay",
    ]);
  });

  it("marks signed upload URL responses private and authorization-varying", async () => {
    const app = buildMediaApp();
    const response = await app.inject({
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Origin, Authorization");
  });

  it("does not clean staging when durable completion fails", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    repository.completeUploadSession = async () => {
      throw new Error("database unavailable");
    };
    const cleanupUploadedFile = vi.fn(async () => undefined);
    const app = buildMediaApp({
      repository,
      finalizer: {
        ...createDeterministicPlatformMediaFinalizer(),
        cleanupUploadedFile,
      },
    });
    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(finalize.statusCode).toBe(500);
    expect(cleanupUploadedFile).not.toHaveBeenCalled();
  });

  it("bounds staging cleanup and retries it on an idempotent finalize replay", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const cleanupUploadedFile = vi.fn(() => new Promise<void>(() => undefined));
    const app = buildMediaApp({
      repository,
      cleanupTimeoutMs: 5,
      finalizer: {
        ...createDeterministicPlatformMediaFinalizer(),
        cleanupUploadedFile,
      },
    });
    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const finalizeRequest = {
      method: "POST" as const,
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    };

    const finalize = await injectJson(app, finalizeRequest);
    expect(finalize.statusCode).toBe(200);
    expect(cleanupUploadedFile).toHaveBeenCalledTimes(1);

    cleanupUploadedFile.mockImplementation(async () => undefined);
    const replay = await injectJson(app, finalizeRequest);
    expect(replay.statusCode).toBe(200);
    expect((replay.body as { sideEffects: string[] }).sideEffects).toEqual(["idempotency_replay"]);
    expect(cleanupUploadedFile).toHaveBeenCalledTimes(2);
  });

  it("finalizes every signed file in a batch upload session", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryBatchCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryBatchCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    expect(create.statusCode).toBe(201);
    expect(createBody.uploadTargets).toHaveLength(2);

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        // Reverse createBody.uploadTargets against propertyGalleryBatchCase.finalize.files to
        // prove finalization matches by uploadTargetId rather than submission order.
        files: [
          {
            uploadTargetId: createBody.uploadTargets[1]!.uploadTargetId,
            ...propertyGalleryBatchCase.finalize!.files[1],
          },
          {
            uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
            ...propertyGalleryBatchCase.finalize!.files[0],
          },
        ],
      },
    });

    expect(finalize.statusCode).toBe(propertyGalleryBatchCase.expected.finalizeStatus);
    const finalizeBody = finalize.body as MediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryBatchCase.expected.mediaObjectCount ?? 2,
    );
    expect(finalizeBody.mediaObject.mediaId).toBe(finalizeBody.mediaObjects[0]!.mediaId);
    expect(finalizeBody.mediaObjects.map((mediaObject) => mediaObject.originalFilename)).toEqual([
      "alpine suite.jpg",
      "patio.png",
    ]);
    expect(finalizeBody.mediaObjects[0]!.storageKey).toContain("/1/active/alpine suite.jpg");
    expect(finalizeBody.mediaObjects[1]!.storageKey).toContain("/2/active/patio.png");
    expect(finalizeBody.mediaObjects[1]!.variants.map((variant) => variant.storageKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/2/variants/original_safe"),
        expect.stringContaining("/2/variants/thumbnail"),
      ]),
    );
    expect((repository.auditEvents[1]!.metadata as { mediaIds: string[] }).mediaIds).toHaveLength(
      2,
    );
  });

  it("rejects property media targets that the resolver cannot prove from the linked resource", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: propertyTargetDenyCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyTargetDenyCase.request.body,
    });

    expect(response.statusCode).toBe(propertyTargetDenyCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(propertyTargetDenyCase.expected.errorCode);
  });

  it("rejects finalize metadata that does not match the inspected staged object", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          contentType: "image/png",
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("media_type_mismatch");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects unsupported inspected staged content before creating media records", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      finalizer: createDeterministicPlatformMediaFinalizer({
        contentType: "application/pdf",
      }),
    });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("unsupported_media_type");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects malformed client checksum metadata before inspecting staged content", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          checksumSha256: "abc123",
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_checksum");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects malformed inspected checksum metadata before creating media records", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      finalizer: createDeterministicPlatformMediaFinalizer({
        checksumSha256: "not-a-sha",
      }),
    });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          checksumSha256: undefined,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_checksum");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("requires inspected checksum metadata when finalize supplies a checksum", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      finalizer: createDeterministicPlatformMediaFinalizer({
        checksumSha256: undefined,
      }),
    });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("finalizer_missing_inspected_checksum");
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("rejects public visibility for private-only chat attachments", async () => {
    const app = buildMediaApp({
      organizationKind: "creator_workspace",
      permissions: ["marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: privateChatVisibilityCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: privateChatVisibilityCase.request.body,
    });

    expect(response.statusCode).toBe(privateChatVisibilityCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(
      privateChatVisibilityCase.expected.errorCode,
    );
  });

  it.each([
    {
      name: "creator participant",
      organizationKind: "creator_workspace" as const,
      resource: {
        product: "marketplace" as const,
        resourceType: "creator_profile" as const,
        resourceId: "creator_profile_lina",
        relationship: "owner" as const,
      },
      resources: [
        {
          product: "marketplace" as const,
          resourceType: "creator_profile" as const,
          resourceId: "creator_profile_lina",
          relationship: "owner" as const,
        },
      ],
      expectedStatus: 201,
    },
    {
      name: "hotel participant with profile and offer links",
      organizationKind: "hotel_group" as const,
      resource: {
        product: "marketplace" as const,
        resourceType: "marketplace_offer" as const,
        resourceId: "offer_alpenrose",
        relationship: "operator" as const,
      },
      resources: [
        {
          product: "marketplace" as const,
          resourceType: "hotel_profile" as const,
          resourceId: "hotel_profile_alpenrose",
          relationship: "owner" as const,
        },
        {
          product: "marketplace" as const,
          resourceType: "marketplace_offer" as const,
          resourceId: "offer_alpenrose",
          relationship: "operator" as const,
        },
      ],
      expectedStatus: 201,
    },
    {
      name: "hotel missing its profile-owner link",
      organizationKind: "hotel_group" as const,
      resource: {
        product: "marketplace" as const,
        resourceType: "marketplace_offer" as const,
        resourceId: "offer_alpenrose",
        relationship: "operator" as const,
      },
      resources: [
        {
          product: "marketplace" as const,
          resourceType: "marketplace_offer" as const,
          resourceId: "offer_alpenrose",
          relationship: "operator" as const,
        },
      ],
      expectedStatus: 403,
    },
  ])("enforces exact chat-write upload policy for $name", async (testCase) => {
    const app = buildMediaApp({
      organizationKind: testCase.organizationKind,
      permissions: ["marketplace.collaboration.write"],
      resources: testCase.resources,
    });
    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...privateChatVisibilityCase.request.body,
        visibility: "private",
        resource: {
          product: testCase.resource.product,
          resourceType: testCase.resource.resourceType,
          resourceId: testCase.resource.resourceId,
          targetResourceId: "collaboration-source-001",
        },
      },
    });

    expect(response.statusCode).toBe(testCase.expectedStatus);
  });

  it("marks private media finalize and replay responses private and authorization-varying", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      organizationKind: "creator_workspace",
      permissions: ["marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
          relationship: "owner",
        },
      ],
    });
    const create = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...privateChatVisibilityCase.request.body,
        visibility: "private",
        resource: {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
          targetResourceId: "collaboration-source-001",
        },
      },
    });
    const created = create.body as MediaCreateResponse;
    const finalizeRequest = {
      method: "POST" as const,
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: [
          {
            uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
            contentType: "image/gif",
            sizeBytes: 1024,
          },
        ],
      },
    };

    const finalize = await app.inject(finalizeRequest);
    const replay = await app.inject(finalizeRequest);

    for (const response of [finalize, replay]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.vary).toBe("Origin, Authorization");
    }
    expect(replay.json<MediaFinalizeResponse>().sideEffects).toEqual(["idempotency_replay"]);
  });

  it("requires explicit public visibility for public profile images", async () => {
    const app = buildMediaApp({
      permissions: ["marketplace.profile.manage"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
          relationship: "owner",
        },
      ],
    });
    const { visibility: _visibility, ...body } = marketplaceCreatorProfileCase.request.body;

    for (const visibility of [undefined, "private"] as const) {
      const response = await injectJson(app, {
        method: "POST",
        url: marketplaceCreatorProfileCase.request.path,
        headers: { authorization: "Bearer valid-token" },
        payload: visibility === undefined ? body : { ...body, visibility },
      });

      expect(response.statusCode).toBe(400);
      expect((response.body as ErrorResponse).code).toBe("invalid_media_visibility");
    }
  });

  it.each([
    {
      contractCase: marketplaceCreatorProfileCase,
      resources: [
        {
          product: "marketplace" as const,
          resourceType: "creator_profile" as const,
          resourceId: "creator_profile_lina",
          relationship: "owner" as const,
        },
      ],
    },
    {
      contractCase: marketplaceOfferMediaCase,
      resources: [
        {
          product: "marketplace" as const,
          resourceType: "marketplace_offer" as const,
          resourceId: "offer_alpenrose",
          relationship: "owner" as const,
        },
      ],
    },
  ])(
    "creates and finalizes marketplace media for $contractCase.caseId",
    async ({ contractCase, resources }) => {
      const repository = createInMemoryPlatformMediaRepository();
      const app = buildMediaApp({
        repository,
        permissions: ["marketplace.profile.manage"],
        resources,
      });

      const create = await injectJson(app, {
        method: "POST",
        url: contractCase.request.path,
        headers: { authorization: "Bearer valid-token" },
        payload: contractCase.request.body,
      });
      const createBody = create.body as MediaCreateResponse;

      expect(create.statusCode).toBe(contractCase.expected.status);
      expect(createBody.uploadSession.requestedVisibility).toBe(
        contractCase.expected.requestedVisibility,
      );
      expect(createBody.uploadTargets).toHaveLength(contractCase.expected.mediaObjectCount ?? 1);

      const finalize = await injectJson(app, {
        method: "POST",
        url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
        headers: { authorization: "Bearer valid-token" },
        payload: {
          files: contractCase.finalize!.files.map((file, index) => ({
            ...file,
            uploadTargetId: createBody.uploadTargets[index]!.uploadTargetId,
          })),
        },
      });

      expect(finalize.statusCode).toBe(contractCase.expected.finalizeStatus);
      const finalizeBody = finalize.body as MediaFinalizeResponse;
      expect(finalizeBody.mediaObjects).toHaveLength(contractCase.expected.mediaObjectCount ?? 1);
      expect(finalizeBody.mediaObject).toMatchObject(contractCase.expected.mediaObject!);
      expect(finalizeBody.mediaObject.mediaId).toBeTruthy();
      expect(finalizeBody.mediaObject.variants.map((variant) => variant.variantName)).toEqual([
        ...(contractCase.expected.requiredVariants ?? []),
      ]);
      if (contractCase === marketplaceCreatorProfileCase) {
        expect(finalizeBody.mediaObject).toMatchObject({
          visibility: "public",
          approvalStatus: "approved",
          lifecycleStatus: "active",
        });
        expect(
          finalizeBody.mediaObject.variants.every(({ visibility }) => visibility === "public"),
        ).toBe(true);
      }
      expect(finalizeBody.sideEffects).toEqual(contractCase.expected.sideEffects);
    },
  );

  it("allows marketplace hotel profile owners to create property hero media sessions", async () => {
    const app = buildMediaApp({
      permissions: ["marketplace.profile.manage"],
      resources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: "hotel_profile_alpenrose",
          relationship: "owner",
        },
      ],
      targetResolver: {
        async resolveTarget({ request, policy }) {
          return {
            ok: true,
            target: {
              resourceProduct: policy.targetResourceProduct,
              resourceType: policy.targetResourceType,
              resourceId: request.resource.targetResourceId ?? request.resource.resourceId,
            },
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "property.hero_image",
        visibility: "public",
        resource: {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: "hotel_profile_alpenrose",
          targetResourceId: "property_alpenrose",
        },
        files: [
          {
            clientFileId: "hero",
            filename: "hero.webp",
            contentType: "image/webp",
            sizeBytes: 1024,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
  });

  it("rejects unsupported content types before signing", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: propertyHeroPdfCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyHeroPdfCase.request.body,
    });

    expect(response.statusCode).toBe(propertyHeroPdfCase.expected.status);
    expect((response.body as ErrorResponse).code).toBe(propertyHeroPdfCase.expected.errorCode);
  });

  it("creates and finalizes PMS room type media through platform media", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      permissions: ["pms.operations.manage"],
      resources: [
        {
          product: "pms",
          resourceType: "pms_hotel",
          resourceId: "pms_hotel_alpenrose",
          relationship: "owner",
        },
      ],
    });

    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsRoomTypeMediaCase.request.body,
    });

    expect(create.statusCode).toBe(pmsRoomTypeMediaCase.expected.status);
    const createBody = create.body as MediaCreateResponse;
    expect(createBody.uploadTargets).toHaveLength(1);

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: pmsRoomTypeMediaCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(finalize.statusCode).toBe(pmsRoomTypeMediaCase.expected.finalizeStatus);
    const finalizeBody = finalize.body as MediaFinalizeResponse;
    expect(finalizeBody.mediaObject).toMatchObject(pmsRoomTypeMediaCase.expected.mediaObject!);
    expect(finalizeBody.mediaObject.variants.map((variant) => variant.variantName)).toEqual([
      ...(pmsRoomTypeMediaCase.expected.requiredVariants ?? []),
    ]);
    expect(finalizeBody.sideEffects).toEqual(pmsRoomTypeMediaCase.expected.sideEffects);
  });

  it("accepts valid large-dimension PMS room images and resizes display variants", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      permissions: ["pms.operations.manage"],
      resources: [
        {
          product: "pms",
          resourceType: "pms_hotel",
          resourceId: "pms_hotel_alpenrose",
          relationship: "owner",
        },
      ],
    });
    const sourceSizeBytes = 9 * 1024 * 1024;

    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...pmsRoomTypeMediaCase.request.body,
        files: [
          {
            clientFileId: "room-8k",
            filename: "suite-8k.jpg",
            contentType: "image/jpeg",
            sizeBytes: sourceSizeBytes,
          },
        ],
      },
    });
    const createBody = create.body as MediaCreateResponse;

    expect(create.statusCode).toBe(201);

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: [
          {
            uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
            contentType: "image/jpeg",
            sizeBytes: sourceSizeBytes,
            widthPx: 12000,
            heightPx: 6750,
          },
        ],
      },
    });

    expect(finalize.statusCode).toBe(200);
    const mediaObject = (finalize.body as MediaFinalizeResponse).mediaObject;
    expect(mediaObject).toMatchObject(pmsRoomTypeMediaCase.expected.mediaObject!);
    expect(mediaObject.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantName: "original_safe", widthPx: 1920, heightPx: 1080 }),
        expect.objectContaining({ variantName: "large", widthPx: 1280, heightPx: 720 }),
        expect.objectContaining({ variantName: "thumbnail", widthPx: 320, heightPx: 180 }),
        expect.objectContaining({ variantName: "blur_preview", widthPx: 32, heightPx: 18 }),
      ]),
    );
    expect(mediaObject.variants.every((variant) => variant.sizeBytes < sourceSizeBytes)).toBe(true);
  });

  it("keeps oversized source-pixel rejection for non-PMS public images", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });

    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: propertyGalleryCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
          widthPx: 12000,
          heightPx: 6750,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_dimensions");
  });

  it("queues PMS import source image jobs instead of PMS-owned downloads", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      permissions: ["pms.operations.manage"],
      resources: [
        {
          product: "pms",
          resourceType: "pms_hotel",
          resourceId: "pms_hotel_alpenrose",
          relationship: "operator",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: pmsImportSourceImageCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsImportSourceImageCase.request.body,
    });

    expect(response.statusCode).toBe(pmsImportSourceImageCase.expected.status);
    const body = response.body as MediaImportResponse;
    expect(body.contractVersion).toBe("platform-media-import.v1");
    expect(body.importJob).toMatchObject({
      jobKey: "media.import:pms:room_type_suite:listing-preview-1:v1",
      purpose: "pms.import.source_image",
      status: "pending",
      sourceImageCount: 2,
      target: {
        resourceProduct: "pms",
        resourceType: "import_job",
        resourceId: "room_type_suite",
      },
    });
    expect(body.sideEffects).toEqual(pmsImportSourceImageCase.expected.sideEffects);
    expect(repository.importJobs.size).toBe(1);
    expect(repository.auditEvents.at(-1)).toMatchObject({
      action: "platform_media.import_job.created",
      targetType: "media_import_job",
      organizationId: "org_media",
    });

    const replay = await injectJson(app, {
      method: "POST",
      url: pmsImportSourceImageCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsImportSourceImageCase.request.body,
    });
    expect((replay.body as MediaImportResponse).importJob.importJobId).toBe(
      body.importJob.importJobId,
    );
    expect(repository.importJobs.size).toBe(1);
    expect(repository.auditEvents).toHaveLength(1);
  });

  it("scopes import idempotency and audits to the owning organization", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const resources = [
      {
        product: "pms" as const,
        resourceType: "pms_hotel" as const,
        resourceId: "pms_hotel_alpenrose",
        relationship: "operator" as const,
      },
    ];
    const firstApp = buildMediaApp({
      repository,
      permissions: ["pms.operations.manage"],
      resources,
      organizationId: "org_media_first",
      workosOrgId: "workos_media_org_first",
    });
    const secondApp = buildMediaApp({
      repository,
      permissions: ["pms.operations.manage"],
      resources,
      organizationId: "org_media_second",
      workosOrgId: "workos_media_org_second",
    });

    const first = await injectJson(firstApp, {
      method: "POST",
      url: pmsImportSourceImageCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsImportSourceImageCase.request.body,
    });
    const second = await injectJson(secondApp, {
      method: "POST",
      url: pmsImportSourceImageCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsImportSourceImageCase.request.body,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect((second.body as MediaImportResponse).importJob.importJobId).not.toBe(
      (first.body as MediaImportResponse).importJob.importJobId,
    );
    expect(repository.importJobs.size).toBe(2);
    expect(repository.auditEvents.map(({ organizationId }) => organizationId).sort()).toEqual([
      "org_media_first",
      "org_media_second",
    ]);
  });

  it("rejects malformed file fields before signing", async () => {
    const app = buildMediaApp();

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "property.hero_image",
        visibility: "public",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
        files: [
          {
            filename: "hero.webp",
            contentType: 123,
            sizeBytes: 1024,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("unsupported_media_type");
  });

  it("allows any signed-in account to upload only their own profile image", async () => {
    const app = buildMediaApp({ permissions: [], resources: [] });
    const payload = {
      purpose: "identity.user.profile_image",
      visibility: "public",
      resource: {
        product: "platform",
        resourceType: "user_profile",
        resourceId: "user_media",
      },
      files: [
        {
          filename: "owner.webp",
          contentType: "image/webp",
          sizeBytes: 1024,
        },
      ],
    };

    const allowed = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload,
    });

    expect(allowed.statusCode).toBe(201);
    expect((allowed.body as MediaCreateResponse).uploadSession).toMatchObject({
      purpose: "identity.user.profile_image",
    });

    const forbidden = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...payload,
        resource: { ...payload.resource, resourceId: "user_someone_else" },
      },
    });

    expect(forbidden.statusCode).toBe(403);
    expect((forbidden.body as ErrorResponse).code).toBe("media_resource_forbidden");

    for (const override of [
      { targetResourceId: "user_someone_else" },
      { propertyId: "property_someone_else" },
    ]) {
      const overridden = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: { authorization: "Bearer valid-token" },
        payload: {
          ...payload,
          resource: { ...payload.resource, ...override },
        },
      });

      expect(overridden.statusCode).toBe(400);
      expect((overridden.body as ErrorResponse).code).toBe("invalid_resource_scope");
    }
  });

  const denialCases: Array<{
    name: string;
    auth?: string;
    permissions: PermissionKey[];
    resources: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
    expectedStatus: number;
  }> = [
    {
      name: "missing authentication",
      auth: undefined,
      permissions: ["booking.settings.manage"],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
      expectedStatus: 401,
    },
    {
      name: "missing permission",
      auth: "Bearer valid-token",
      permissions: [],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
      expectedStatus: 403,
    },
    {
      name: "missing linked resource",
      auth: "Bearer valid-token",
      permissions: ["booking.settings.manage"],
      resources: [],
      expectedStatus: 403,
    },
  ];

  it.each(denialCases)(
    "enforces route policy for $name",
    async ({ auth, permissions, resources, expectedStatus }) => {
      const app = buildMediaApp({ permissions, resources });

      const response = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: auth ? { authorization: auth } : undefined,
        payload: {
          purpose: "property.hero_image",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
          files: [
            {
              filename: "hero.webp",
              contentType: "image/webp",
              sizeBytes: 1024,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(expectedStatus);
    },
  );
});

function buildMediaApp(
  options: {
    repository?: PlatformMediaRepository;
    permissions?: PermissionKey[];
    resources?: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
    targetResolver?: PlatformMediaTargetResolver;
    finalizer?: PlatformMediaUploadFinalizer;
    enabledPurposes?: readonly PlatformMediaPurpose[];
    allowedOrigins?: string[];
    cleanupTimeoutMs?: number;
    organizationId?: string;
    workosOrgId?: string;
    organizationKind?: "creator_workspace" | "hotel_group";
  } = {},
): ReturnType<typeof buildApp> {
  const workosOrgId = options.workosOrgId ?? session.workosOrgId ?? "workos_media_org";
  return buildApp({
    logger: false,
    platformMedia: {
      repository: options.repository ?? createInMemoryPlatformMediaRepository(),
      signer: createDeterministicPlatformMediaUploadSigner(),
      targetResolver: options.targetResolver ?? propertyMediaTargetResolver,
      finalizer: options.finalizer ?? createDeterministicPlatformMediaFinalizer(),
      enabledPurposes: options.enabledPurposes ?? allMediaPurposes,
      allowedOrigins: options.allowedOrigins,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    },
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", { ...session, workosOrgId }]])),
      repository: identityRepository(options.resources, {
        organizationId: options.organizationId ?? "org_media",
        workosOrgId,
        kind: options.organizationKind ?? "hotel_group",
      }),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.settings.manage"];
        },
      },
    },
  });
}

const propertyMediaTargetResolver: PlatformMediaTargetResolver = {
  async resolveTarget({ request, policy }) {
    if (
      policy.targetResourceProduct === "hotel_catalog" &&
      request.resource.resourceId === "booking_hotel_alpenrose" &&
      request.resource.propertyId === "property_alpenrose"
    ) {
      return {
        ok: true,
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: "property_alpenrose",
          propertyId: "property_alpenrose",
        },
      };
    }
    if (policy.targetResourceProduct === "hotel_catalog") {
      return {
        ok: false,
        statusCode: 403,
        code: "media_target_forbidden",
        message: "Property media target is not linked to this booking hotel.",
      };
    }
    return {
      ok: true,
      target: {
        resourceProduct: policy.targetResourceProduct,
        resourceType: policy.targetResourceType,
        resourceId: request.resource.targetResourceId ?? request.resource.resourceId,
        propertyId: request.resource.propertyId,
      },
    };
  },
};

function identityRepository(
  resources: Array<{
    product: Product;
    resourceType: ResourceType;
    resourceId: string;
    relationship: ResourceRelationship;
  }> = [
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
      relationship: "owner",
    },
  ],
  organization: {
    organizationId: string;
    workosOrgId: string;
    kind: "creator_workspace" | "hotel_group";
  } = {
    organizationId: "org_media",
    workosOrgId: "workos_media_org",
    kind: "hotel_group",
  },
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_media",
        email: "media@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        ...organization,
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_media",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "membership_workos_media",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return resources.map((resource) => ({
        ...resource,
        status: "active",
      }));
    },
  };
}

function contractCase(caseId: string): (typeof uploadContractCases.cases)[number] {
  const found = uploadContractCases.cases.find((candidate) => candidate.caseId === caseId);
  if (!found) throw new Error(`Missing platform media upload fixture: ${caseId}`);
  return found;
}
