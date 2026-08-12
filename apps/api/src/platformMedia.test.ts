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
  PlatformMediaTargetInvalidError,
  type PlatformMediaObjectRecord,
  type PlatformMediaPurpose,
  type PlatformMediaRepository,
  type PlatformMediaSessionRecord,
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
    contractVersion:
      | "platform-media-upload.v1"
      | "platform-media-upload.v2"
      | "platform-media-import.v1";
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
      mediaObject?: Record<string, unknown>;
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
  "booking.header_logo",
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
    status: "signed" | "completed" | "failed";
    requestedVisibility: string;
    effectiveVisibility: string;
    expiresAt: string;
  };
  uploadTargets: Array<{
    uploadTargetId: string;
    method: string;
    clientFileId: string;
    uploadUrl: string;
    headers: Record<string, string>;
    expiresAt: string;
  }>;
  mediaObjects?: Array<PlatformMediaObjectRecord | PrivateHotelMediaResponse>;
  sideEffects?: string[];
};

type MediaFinalizeResponse = {
  mediaObject: PlatformMediaObjectRecord;
  mediaObjects: PlatformMediaObjectRecord[];
  sideEffects: string[];
};

type PrivateHotelMediaResponse = {
  mediaObjectId: string;
  purpose:
    | "property.logo"
    | "property.hero_image"
    | "property.gallery_image"
    | "pms.room_type.media";
  status: "private_ready";
  publicVariants: [];
};

type PrivateHotelMediaFinalizeResponse = {
  mediaObject: PrivateHotelMediaResponse;
  mediaObjects: PrivateHotelMediaResponse[];
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
  it("labels each fixture with the contract selected by its request shape", () => {
    for (const contractCase of uploadContractCases.cases) {
      const body = contractCase.request.body;
      const resource = body["resource"] as Record<string, unknown> | undefined;
      const expectedContractVersion =
        body["purpose"] === "pms.import.source_image"
          ? "platform-media-import.v1"
          : resource?.["product"] === "hotel_catalog" && resource["resourceType"] === "property"
            ? "platform-media-upload.v2"
            : "platform-media-upload.v1";
      expect(contractCase.contractVersion, contractCase.caseId).toBe(expectedContractVersion);
    }
  });

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

  it("rejects disabled media purposes for new work while allowing signed sessions to drain", async () => {
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

    for (const response of [createDisabled, importDisabled]) {
      expect(response.statusCode).toBe(503);
      expect((response.body as ErrorResponse).code).toBe("media_purpose_unavailable");
    }
    expect(finalizeDisabled.statusCode).toBe(200);
    expectPrivateHotelMediaResponse(
      (finalizeDisabled.body as PrivateHotelMediaFinalizeResponse).mediaObject,
      "property.gallery_image",
    );
  });

  it("creates and finalizes private property media without exposing storage details", async () => {
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
    expect(createBody.contractVersion).toBe(propertyGalleryCase.contractVersion);
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
    expect(createBody.uploadTargets[0]).not.toHaveProperty("stagingKey");
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
    const finalizeBody = finalize.body as PrivateHotelMediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryCase.expected.mediaObjectCount ?? 1,
    );
    expect(finalizeBody.mediaObject).toMatchObject(propertyGalleryCase.expected.mediaObject!);
    expectPrivateHotelMediaResponse(finalizeBody.mediaObject, "property.gallery_image");
    const completed = repository.sessions.get(createBody.uploadSession.sessionId);
    expect(completed?.completedMediaObject).toMatchObject({
      visibility: "private",
      requestedVisibility: "private",
      approvalStatus: "private",
      lifecycleStatus: "staged",
    });
    expect(completed?.completedMediaObject?.variants.map((variant) => variant.variantName)).toEqual(
      [...(propertyGalleryCase.expected.requiredVariants ?? [])],
    );
    expect(
      completed?.completedMediaObject?.variants.every(
        (variant) => variant.visibility === "private" && variant.publicCdnUrl === null,
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
    const authenticatedReplayBody = authenticatedReplay.body as PrivateHotelMediaFinalizeResponse;
    expectPrivateHotelMediaResponse(authenticatedReplayBody.mediaObject, "property.gallery_image");
    expect(authenticatedReplayBody.sideEffects).toEqual(["idempotency_replay"]);
  });

  it("replays completed room-media creation after the room is deleted or reparented", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    let roomAvailable = true;
    const resolveTarget = vi.fn<PlatformMediaTargetResolver["resolveTarget"]>(async (input) =>
      roomAvailable
        ? propertyMediaTargetResolver.resolveTarget(input)
        : {
            ok: false,
            statusCode: 403,
            code: "media_target_forbidden",
            message: "Room no longer belongs to the property.",
          },
    );
    const app = buildMediaApp({ repository, targetResolver: { resolveTarget } });
    const payload = { ...pmsRoomTypeMediaCase.request.body, idempotencyKey: "room-replay" };
    const create = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const created = create.body as MediaCreateResponse;
    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: pmsRoomTypeMediaCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    roomAvailable = false;

    const replay = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload,
    });

    expect(create.statusCode).toBe(201);
    expect(finalize.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect((replay.body as MediaCreateResponse).contractVersion).toBe("platform-media-upload.v2");
    expect((replay.body as MediaCreateResponse).sideEffects).toEqual(["idempotency_replay"]);
    expect(resolveTarget).toHaveBeenCalledTimes(2);
  });

  it("hides sessions from another actor or organization behind the same not-found response", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const ownerApp = buildMediaApp({ repository });
    const create = await injectJson(ownerApp, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const otherOrganizationApp = buildMediaApp({
      repository,
      organizationId: "org_media_second",
      workosOrgId: "workos_media_org_second",
    });
    const otherActorApp = buildMediaApp({ repository, userId: "user_media_second" });

    for (const crossScopeApp of [otherOrganizationApp, otherActorApp]) {
      const crossScope = await injectJson(crossScopeApp, {
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
      const unknownSession = await injectJson(crossScopeApp, {
        method: "POST",
        url: "/api/media/upload-sessions/00000000-0000-4000-8000-000000000099/finalize",
        headers: { authorization: "Bearer valid-token" },
        payload: { files: [] },
      });

      expect(crossScope.statusCode).toBe(404);
      expect(crossScope.body).toEqual(unknownSession.body);
      expect((crossScope.body as ErrorResponse).code).toBe("upload_session_not_found");
    }
  });

  it.each([
    {
      name: "public visibility",
      mutate: (session: PlatformMediaSessionRecord) => ({
        ...session,
        requestedVisibility: "public" as const,
        effectiveVisibility: "public" as const,
      }),
    },
    {
      name: "a noncanonical Booking resource",
      mutate: (session: PlatformMediaSessionRecord) => ({
        ...session,
        resource: {
          product: "booking" as const,
          resourceType: "booking_hotel" as const,
          resourceId: "booking_hotel_alpenrose",
        },
      }),
    },
  ])("rejects a signed hotel-media session carrying $name", async ({ mutate }) => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });
    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const session = repository.sessions.get(created.uploadSession.sessionId)!;
    repository.sessions.set(session.sessionId, mutate(session));

    const finalize = await app.inject({
      method: "POST",
      url: `/api/media/upload-sessions/${session.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: { files: [] },
    });

    expect(finalize.statusCode).toBe(409);
    expect(finalize.json<ErrorResponse>().code).toBe("upload_session_not_reusable");
    expect(finalize.headers["cache-control"]).toBe("private, no-store");
    expect(repository.sessions.get(session.sessionId)?.status).toBe("signed");
  });

  it("does not replay a completed hotel-media session carrying public visibility", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });
    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: propertyGalleryCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const finalizeFiles = propertyGalleryCase.finalize!.files.map((file) => ({
      ...file,
      uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
    }));
    await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: { files: finalizeFiles },
    });
    const completed = repository.sessions.get(created.uploadSession.sessionId)!;
    repository.sessions.set(completed.sessionId, {
      ...completed,
      requestedVisibility: "public",
      effectiveVisibility: "public",
    });

    const replay = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${completed.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: { files: finalizeFiles },
    });

    expect(replay.statusCode).toBe(409);
    expect((replay.body as ErrorResponse).code).toBe("upload_session_not_reusable");
    expect(JSON.stringify(replay.body)).not.toContain("storageKey");
    expect(JSON.stringify(replay.body)).not.toContain("publicCdnUrl");
  });

  it("rejects room finalization when the room no longer belongs to the property", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    let roomBelongsToProperty = true;
    const app = buildMediaApp({
      repository,
      targetResolver: {
        async resolveTarget(input) {
          return roomBelongsToProperty
            ? propertyMediaTargetResolver.resolveTarget(input)
            : {
                ok: false,
                statusCode: 403,
                code: "media_target_forbidden",
                message: "Property media target is unavailable.",
              };
        },
      },
    });
    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsRoomTypeMediaCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    roomBelongsToProperty = false;

    const finalize = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: { files: [] },
    });

    expect(finalize.statusCode).toBe(409);
    expect((finalize.body as ErrorResponse).code).toBe("upload_session_not_reusable");
    expect(
      repository.sessions.get(created.uploadSession.sessionId)?.completedMediaObject,
    ).toBeUndefined();
  });

  it("replays completed room media after the room relationship later changes", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    let roomBelongsToProperty = true;
    const resolveTarget = vi.fn(
      async (input: Parameters<PlatformMediaTargetResolver["resolveTarget"]>[0]) =>
        roomBelongsToProperty
          ? propertyMediaTargetResolver.resolveTarget(input)
          : {
              ok: false as const,
              statusCode: 403 as const,
              code: "media_target_forbidden",
              message: "Property media target is unavailable.",
            },
    );
    const generateVariants = vi.fn(createDeterministicPlatformMediaFinalizer().generateVariants);
    const app = buildMediaApp({
      repository,
      targetResolver: { resolveTarget },
      finalizer: { ...createDeterministicPlatformMediaFinalizer(), generateVariants },
    });
    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsRoomTypeMediaCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const finalizeRequest = {
      method: "POST" as const,
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: pmsRoomTypeMediaCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    };

    expect((await injectJson(app, finalizeRequest)).statusCode).toBe(200);
    const resolverCalls = resolveTarget.mock.calls.length;
    const generationCalls = generateVariants.mock.calls.length;
    roomBelongsToProperty = false;
    const replay = await injectJson(app, finalizeRequest);

    expect(replay.statusCode).toBe(200);
    expect((replay.body as { sideEffects: string[] }).sideEffects).toEqual(["idempotency_replay"]);
    expect(resolveTarget).toHaveBeenCalledTimes(resolverCalls);
    expect(generateVariants).toHaveBeenCalledTimes(generationCalls);
  });

  it("rejects replay when persisted private property variants are malformed", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });
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
    expect((await injectJson(app, finalizeRequest)).statusCode).toBe(200);
    const completed = repository.sessions.get(created.uploadSession.sessionId)!;
    const malformed = {
      ...completed.completedMediaObjects![0]!,
      variants: completed.completedMediaObjects![0]!.variants.map((variant, index) =>
        index === 0 ? { ...variant, storageKey: `staging/${completed.sessionId}/unsafe` } : variant,
      ),
    };
    repository.sessions.set(completed.sessionId, {
      ...completed,
      completedMediaObject: malformed,
      completedMediaObjects: [malformed],
    });

    const replay = await injectJson(app, finalizeRequest);
    expect(replay.statusCode).toBe(409);
    expect((replay.body as ErrorResponse).code).toBe("upload_session_not_reusable");
    expect(JSON.stringify(replay.body)).not.toContain("storageKey");
  });

  it("maps a transactional room-target race to a non-reusable session", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    repository.completeUploadSession = async () => {
      throw new PlatformMediaTargetInvalidError();
    };
    const app = buildMediaApp({ repository });
    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsRoomTypeMediaCase.request.body,
    });
    const created = create.body as MediaCreateResponse;
    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: pmsRoomTypeMediaCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
        })),
      },
    });

    expect(response.statusCode).toBe(409);
    expect((response.body as ErrorResponse).code).toBe("upload_session_not_reusable");
    expect(repository.sessions.get(created.uploadSession.sessionId)?.status).toBe("signed");
  });

  it("replays an idempotent signed session and rejects reuse for different files", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });
    const payload = {
      ...propertyGalleryCase.request.body,
      idempotencyKey: "hotel-setup:property-alpenrose:gallery:v1",
    };

    const first = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const replay = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const firstBody = first.body as MediaCreateResponse;
    const replayBody = replay.body as MediaCreateResponse;

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replayBody.uploadSession.sessionId).toBe(firstBody.uploadSession.sessionId);
    expect(replayBody.uploadSession.status).toBe("signed");
    expect(replayBody.uploadTargets[0]).toMatchObject({
      uploadTargetId: firstBody.uploadTargets[0]!.uploadTargetId,
      uploadUrl: expect.stringContaining("staging%2F"),
    });
    expect(replayBody.sideEffects).toEqual(["idempotency_replay"]);
    expect(repository.sessions.size).toBe(1);
    expect(repository.auditEvents).toHaveLength(1);

    const conflict = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...payload,
        files: [
          {
            clientFileId: "hero",
            filename: "different-suite.jpg",
            contentType: "image/jpeg",
            sizeBytes: 2048,
          },
        ],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.body as ErrorResponse).code).toBe("upload_session_idempotency_conflict");

    const otherOrganizationApp = buildMediaApp({
      repository,
      organizationId: "org_media_second",
      workosOrgId: "workos_media_org_second",
    });
    const otherOrganization = await injectJson(otherOrganizationApp, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    expect(otherOrganization.statusCode).toBe(201);
    expect((otherOrganization.body as MediaCreateResponse).uploadSession.sessionId).not.toBe(
      firstBody.uploadSession.sessionId,
    );
    expect(repository.sessions.size).toBe(2);
    expect(repository.auditEvents.map(({ organizationId }) => organizationId).sort()).toEqual([
      "org_media",
      "org_media_second",
    ]);
  });

  it("returns completed media on create replay even after the upload session expires", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    let currentTime = new Date("2026-06-12T12:00:00.000Z");
    const app = buildMediaApp({ repository, now: () => currentTime });
    const payload = {
      ...propertyGalleryCase.request.body,
      idempotencyKey: "hotel-setup:property-alpenrose:completed-gallery:v1",
    };
    const create = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const createBody = create.body as MediaCreateResponse;
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
    expect(finalize.statusCode).toBe(200);

    currentTime = new Date("2026-06-12T13:00:00.000Z");
    const replay = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const replayBody = replay.body as MediaCreateResponse;

    expect(replay.statusCode).toBe(200);
    expect(replayBody.uploadSession).toMatchObject({
      sessionId: createBody.uploadSession.sessionId,
      status: "completed",
    });
    expect(replayBody.uploadTargets).toEqual([]);
    expect(replayBody.mediaObjects).toEqual((finalize.body as MediaFinalizeResponse).mediaObjects);
    expect(replayBody.sideEffects).toEqual(["idempotency_replay"]);
    expect(repository.auditEvents).toHaveLength(2);
  });

  it("renews an expired unfinished session without changing its idempotency identity", async () => {
    let currentTime = new Date("2026-06-12T12:00:00.000Z");
    const app = buildMediaApp({ now: () => currentTime });
    const payload = {
      ...propertyGalleryCase.request.body,
      idempotencyKey: "hotel-setup:property-alpenrose:abandoned-gallery:v1",
    };
    const created = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const createdBody = created.body as MediaCreateResponse;

    currentTime = new Date("2026-06-12T13:00:00.000Z");
    const replay = await injectJson(app, {
      method: "POST",
      url: propertyGalleryCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    const replayBody = replay.body as MediaCreateResponse;

    expect(replay.statusCode).toBe(200);
    expect(replayBody.uploadSession).toMatchObject({
      sessionId: createdBody.uploadSession.sessionId,
      status: "signed",
      expiresAt: "2026-06-12T13:15:00.000Z",
    });
    expect(replayBody.uploadTargets).toEqual([
      expect.objectContaining({
        uploadTargetId: createdBody.uploadTargets[0]!.uploadTargetId,
        expiresAt: "2026-06-12T13:15:00.000Z",
      }),
    ]);
    expect(replayBody.sideEffects).toEqual(["idempotency_replay"]);
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

  it("retains generated variants and staging when durable completion fails", async () => {
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
    const finalizeBody = finalize.body as PrivateHotelMediaFinalizeResponse;
    expect(finalizeBody.mediaObjects).toHaveLength(
      propertyGalleryBatchCase.expected.mediaObjectCount ?? 2,
    );
    expect(finalizeBody.mediaObject.mediaObjectId).toBe(
      finalizeBody.mediaObjects[0]!.mediaObjectId,
    );
    expect(finalizeBody.mediaObjects.map(({ mediaObjectId }) => mediaObjectId)).toHaveLength(2);
    expect(new Set(finalizeBody.mediaObjects.map(({ mediaObjectId }) => mediaObjectId)).size).toBe(
      2,
    );
    for (const mediaObject of finalizeBody.mediaObjects) {
      expectPrivateHotelMediaResponse(mediaObject, "property.gallery_image");
    }
    const completed = repository.sessions.get(createBody.uploadSession.sessionId);
    expect(
      completed?.completedMediaObjects?.map((mediaObject) => mediaObject.originalFilename),
    ).toEqual(["alpine suite.jpg", "patio.png"]);
    expect(completed?.completedMediaObjects?.[0]!.storageKey).toMatch(
      /^private\/media\/.+\/original_safe\/sha256-[a-f0-9]{64}\.webp$/,
    );
    expect(completed?.completedMediaObjects?.[1]!.storageKey).toMatch(
      /^private\/media\/.+\/original_safe\/sha256-[a-f0-9]{64}\.webp$/,
    );
    expect(
      completed?.completedMediaObjects?.[1]!.variants.map((variant) => variant.storageKey),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/original_safe/sha256-"),
        expect.stringContaining("/thumbnail/sha256-"),
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

  it("allows canonical property owners to create private hero media sessions", async () => {
    const app = buildMediaApp({
      permissions: ["hotel_catalog.setup.manage"],
      resources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "property.hero_image",
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
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
    expect(response.body).toMatchObject({
      uploadSession: {
        purpose: "property.hero_image",
        requestedVisibility: "private",
        effectiveVisibility: "private",
      },
    });
  });

  it("publishes Booking-scoped SVG header logos within the 500 KB limit", async () => {
    const app = buildMediaApp({
      permissions: ["booking.settings.manage"],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
    });
    const resource = {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
    };
    const files = [
      {
        clientFileId: "logo",
        filename: "logo.svg",
        contentType: "image/svg+xml",
        sizeBytes: 1024,
      },
    ];

    const created = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: { purpose: "booking.header_logo", visibility: "public", resource, files },
    });
    expect(created.statusCode).toBe(201);
    const upload = created.body as MediaCreateResponse;

    const finalized = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${upload.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: [
          {
            uploadTargetId: upload.uploadTargets[0]!.uploadTargetId,
            contentType: "image/svg+xml",
            sizeBytes: 1024,
          },
        ],
      },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.body).toMatchObject({
      mediaObject: {
        purpose: "booking.header_logo",
        visibility: "public",
        approvalStatus: "approved",
        lifecycleStatus: "active",
        variants: expect.arrayContaining([
          expect.objectContaining({ publicCdnUrl: expect.stringMatching(/^https:\/\//) }),
        ]),
      },
    });

    const oversized = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "booking.header_logo",
        visibility: "public",
        resource,
        files: [{ ...files[0], sizeBytes: 500 * 1024 + 1 }],
      },
    });

    expect(oversized.statusCode).toBe(400);
    expect(oversized.body).toMatchObject({ code: "media_file_too_large" });

    const unsupportedWebp = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "booking.header_logo",
        visibility: "public",
        resource,
        files: [
          {
            clientFileId: "logo",
            filename: "logo.webp",
            contentType: "image/webp",
            sizeBytes: 1024,
          },
        ],
      },
    });
    expect(unsupportedWebp.statusCode).toBe(400);
    expect(unsupportedWebp.body).toMatchObject({ code: "unsupported_media_type" });
  });

  it.each(["property.hero_image", "property.logo"] as const)(
    "finalizes %s as a private-ready library item and rejects public staging",
    async (purpose) => {
      const repository = createInMemoryPlatformMediaRepository();
      const app = buildMediaApp({ repository });
      const payload = {
        purpose,
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
        },
        files: [
          {
            clientFileId: purpose,
            filename: `${purpose}.webp`,
            contentType: "image/webp",
            sizeBytes: 1024,
          },
        ],
      };

      const create = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: { authorization: "Bearer valid-token" },
        payload,
      });
      expect(create.statusCode).toBe(201);
      const created = create.body as MediaCreateResponse;

      const finalize = await injectJson(app, {
        method: "POST",
        url: `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
        headers: { authorization: "Bearer valid-token" },
        payload: {
          files: [
            {
              uploadTargetId: created.uploadTargets[0]!.uploadTargetId,
              contentType: "image/webp",
              sizeBytes: 1024,
              widthPx: 1200,
              heightPx: 800,
            },
          ],
        },
      });
      expect(finalize.statusCode).toBe(200);
      expectPrivateHotelMediaResponse(
        (finalize.body as PrivateHotelMediaFinalizeResponse).mediaObject,
        purpose,
      );

      const publicCreate = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: { authorization: "Bearer valid-token" },
        payload: { ...payload, visibility: "public" },
      });
      expect(publicCreate.statusCode).toBe(400);
      expect((publicCreate.body as ErrorResponse).code).toBe("invalid_media_visibility");
    },
  );

  it("keeps assignment revisions out and rejects old Booking-shaped hotel uploads", async () => {
    const app = buildMediaApp({
      permissions: ["hotel_catalog.setup.manage", "booking.settings.manage"],
      resources: [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
        },
      ],
    });
    const payload = {
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: "00000000-0000-4000-8000-000000000040",
      },
      files: [
        {
          filename: "hero.webp",
          contentType: "image/webp",
          sizeBytes: 1024,
        },
      ],
    };

    const revision = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: { ...payload, expectedProfileRevision: 1 },
    });
    const bookingResource = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...payload,
        visibility: "public",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
    });

    expect(revision.statusCode).toBe(400);
    expect((revision.body as ErrorResponse).code).toBe("invalid_profile_revision");
    expect(bookingResource.statusCode).toBe(400);
    expect((bookingResource.body as ErrorResponse).code).toBe("invalid_resource_scope");
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

  it.each([
    ["camera.heic", "image/heic"],
    ["camera.heif", ""],
  ])("gives mobile creators conversion guidance for %s", async (filename, contentType) => {
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

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/media/upload-sessions",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        purpose: "marketplace.creator.profile_image",
        visibility: "public",
        resource: {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_lina",
        },
        files: [{ filename, contentType, sizeBytes: 1024 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "unsupported_media_type",
      message:
        "HEIC and HEIF profile photos are not supported yet. Convert the photo to JPG, PNG, or WebP and try again.",
    });
  });

  it.each([
    ["identity.user.profile_image", "platform", "user_profile", "user_media"],
    ["marketplace.creator.profile_image", "marketplace", "creator_profile", "creator_profile_lina"],
  ])(
    "accepts a supported mobile %s photo when the browser omits its MIME type",
    async (purpose, product, resourceType, resourceId) => {
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

      const response = await injectJson(app, {
        method: "POST",
        url: "/api/media/upload-sessions",
        headers: { authorization: "Bearer valid-token" },
        payload: {
          purpose,
          visibility: "public",
          resource: { product, resourceType, resourceId },
          files: [{ filename: "camera.png", contentType: "", sizeBytes: 1024 }],
        },
      });

      expect(response.statusCode).toBe(201);
      expect((response.body as MediaCreateResponse).uploadTargets[0]?.headers).toMatchObject({
        "content-type": "image/png",
      });
    },
  );

  it("creates and finalizes PMS room type media through platform media", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      permissions: ["hotel_catalog.setup.manage"],
      resources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
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
    const finalizeBody = finalize.body as PrivateHotelMediaFinalizeResponse;
    expect(finalizeBody.mediaObject).toMatchObject(pmsRoomTypeMediaCase.expected.mediaObject!);
    expectPrivateHotelMediaResponse(finalizeBody.mediaObject, "pms.room_type.media");
    expect(
      repository.sessions
        .get(createBody.uploadSession.sessionId)
        ?.completedMediaObject?.variants.map((variant) => variant.variantName),
    ).toEqual([...(pmsRoomTypeMediaCase.expected.requiredVariants ?? [])]);
    expect(finalizeBody.sideEffects).toEqual(pmsRoomTypeMediaCase.expected.sideEffects);
  });

  it("accepts valid large-dimension PMS room images and resizes display variants", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({
      repository,
      permissions: ["hotel_catalog.setup.manage"],
      resources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
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
            widthPx: 7680,
            heightPx: 4320,
          },
        ],
      },
    });

    expect(finalize.statusCode).toBe(200);
    const safeMediaObject = (finalize.body as PrivateHotelMediaFinalizeResponse).mediaObject;
    expectPrivateHotelMediaResponse(safeMediaObject, "pms.room_type.media");
    const mediaObject = repository.sessions.get(
      createBody.uploadSession.sessionId,
    )?.completedMediaObject;
    expect(mediaObject?.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantName: "original_safe", widthPx: 1920, heightPx: 1080 }),
        expect.objectContaining({ variantName: "large", widthPx: 1280, heightPx: 720 }),
        expect.objectContaining({ variantName: "thumbnail", widthPx: 320, heightPx: 180 }),
        expect.objectContaining({ variantName: "blur_preview", widthPx: 32, heightPx: 18 }),
      ]),
    );
    expect(mediaObject?.variants.every((variant) => variant.sizeBytes < sourceSizeBytes)).toBe(
      true,
    );
  });

  it("rejects PMS room sources above the 60 megapixel inspection limit", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const app = buildMediaApp({ repository });
    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: pmsRoomTypeMediaCase.request.body,
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: pmsRoomTypeMediaCase.finalize!.files.map((file) => ({
          ...file,
          uploadTargetId: createBody.uploadTargets[0]!.uploadTargetId,
          widthPx: 10_000,
          heightPx: 6_001,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as ErrorResponse).code).toBe("invalid_media_dimensions");
    expect(repository.sessions.get(createBody.uploadSession.sessionId)?.status).toBe("signed");
  });

  it("generates a maximum-size room image batch one file at a time", async () => {
    const repository = createInMemoryPlatformMediaRepository();
    const baseFinalizer = createDeterministicPlatformMediaFinalizer();
    let activeGenerations = 0;
    let maxActiveGenerations = 0;
    const generateVariants = vi.fn(async (input) => {
      activeGenerations += 1;
      maxActiveGenerations = Math.max(maxActiveGenerations, activeGenerations);
      await Promise.resolve();
      try {
        return await baseFinalizer.generateVariants(input);
      } finally {
        activeGenerations -= 1;
      }
    });
    const app = buildMediaApp({
      repository,
      finalizer: { ...baseFinalizer, generateVariants },
    });
    const files = Array.from({ length: 20 }, (_, index) => ({
      clientFileId: `room-${index + 1}`,
      filename: `room-${index + 1}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 10 * 1024 * 1024,
    }));
    const create = await injectJson(app, {
      method: "POST",
      url: pmsRoomTypeMediaCase.request.path,
      headers: { authorization: "Bearer valid-token" },
      payload: { ...pmsRoomTypeMediaCase.request.body, files },
    });
    const createBody = create.body as MediaCreateResponse;

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        files: createBody.uploadTargets.map((target) => ({
          uploadTargetId: target.uploadTargetId,
          contentType: "image/jpeg",
          sizeBytes: 10 * 1024 * 1024,
          widthPx: 10_000,
          heightPx: 6_000,
        })),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(generateVariants).toHaveBeenCalledTimes(20);
    expect(maxActiveGenerations).toBe(1);
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
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
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

  it("accepts the canonical Hotel Catalog property authorization contract", async () => {
    const app = buildMediaApp({
      permissions: ["hotel_catalog.setup.manage"],
      resources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "property_alpenrose",
          relationship: "operator",
        },
      ],
      targetResolver: {
        async resolveTarget({ request, policy }) {
          return {
            ok: true,
            target: {
              resourceProduct: policy.targetResourceProduct,
              resourceType: policy.targetResourceType,
              resourceId: request.resource.resourceId,
              propertyId: request.resource.resourceId,
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
        purpose: "property.gallery_image",
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "property_alpenrose",
        },
        files: [
          {
            filename: "gallery.webp",
            contentType: "image/webp",
            sizeBytes: 1024,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      uploadSession: {
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: "property_alpenrose",
          propertyId: "property_alpenrose",
        },
      },
    });
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
      permissions: ["hotel_catalog.setup.manage"],
      resources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
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
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "00000000-0000-4000-8000-000000000040",
          relationship: "owner",
        },
      ],
      expectedStatus: 403,
    },
    {
      name: "missing linked resource",
      auth: "Bearer valid-token",
      permissions: ["hotel_catalog.setup.manage"],
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
          visibility: "private",
          resource: {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "00000000-0000-4000-8000-000000000040",
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
    now?: () => Date;
    organizationId?: string;
    workosOrgId?: string;
    userId?: string;
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
      now: options.now ?? (() => new Date("2026-06-12T12:00:00.000Z")),
    },
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", { ...session, workosOrgId }]])),
      repository: identityRepository(
        options.resources,
        {
          organizationId: options.organizationId ?? "org_media",
          workosOrgId,
          kind: options.organizationKind ?? "hotel_group",
        },
        options.userId,
      ),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["hotel_catalog.setup.manage"];
        },
      },
    },
  });
}

const propertyMediaTargetResolver: PlatformMediaTargetResolver = {
  async resolveTarget({ request, policy }) {
    if (
      request.resource.product === "hotel_catalog" &&
      request.resource.resourceType === "property" &&
      request.resource.resourceId === "00000000-0000-4000-8000-000000000040"
    ) {
      return {
        ok: true,
        target: {
          resourceProduct: policy.targetResourceProduct,
          resourceType: policy.targetResourceType,
          resourceId:
            request.purpose === "pms.room_type.media"
              ? request.resource.targetResourceId!
              : request.resource.resourceId,
          propertyId: request.resource.resourceId,
        },
      };
    }
    if (
      request.purpose === "property.hero_image" ||
      request.purpose === "property.gallery_image" ||
      request.purpose === "property.logo" ||
      request.purpose === "pms.room_type.media"
    ) {
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
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: "00000000-0000-4000-8000-000000000040",
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
  userId = "user_media",
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId,
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

function expectPrivateHotelMediaResponse(
  mediaObject: PrivateHotelMediaResponse,
  purpose: PrivateHotelMediaResponse["purpose"],
): void {
  expect(mediaObject).toEqual({
    mediaObjectId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    purpose,
    status: "private_ready",
    publicVariants: [],
  });
}

function contractCase(caseId: string): (typeof uploadContractCases.cases)[number] {
  const found = uploadContractCases.cases.find((candidate) => candidate.caseId === caseId);
  if (!found) throw new Error(`Missing platform media upload fixture: ${caseId}`);
  return found;
}
