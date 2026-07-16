import {
  requireAuthContext,
  type LinkedResource,
  type PermissionKey,
  type Product,
  type RequestContext,
  type ResourceRelationship,
  type ResourceType,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { enforceRoutePolicy } from "./policy.js";

export const PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION = "platform-media-upload.v1" as const;
export const PLATFORM_MEDIA_IMPORT_CONTRACT_VERSION = "platform-media-import.v1" as const;

export type PlatformMediaPurpose =
  | "identity.user.profile_image"
  | "property.hero_image"
  | "property.gallery_image"
  | "property.logo"
  | "marketplace.offer.media"
  | "marketplace.creator.profile_image"
  | "marketplace.collaboration_chat.attachment"
  | "pms.room_type.media"
  | "pms.messaging.attachment"
  | "pms.import.source_image";

export type PlatformMediaVisibility = "public" | "private";

export type PlatformMediaVariantName =
  | "original_safe"
  | "large"
  | "thumbnail"
  | "blur_preview"
  | "provider_original";

export type PlatformMediaResourceProduct =
  | "hotel_catalog"
  | "booking"
  | "pms"
  | "marketplace"
  | "distribution"
  | "platform"
  | "migration";

export type PlatformMediaResourceScope = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  propertyId?: string;
  targetResourceId?: string;
};

export type PlatformMediaUploadFileRequest = {
  clientFileId?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type PlatformMediaUploadSessionRequest = {
  purpose: PlatformMediaPurpose;
  visibility?: PlatformMediaVisibility;
  resource: PlatformMediaResourceScope;
  files: PlatformMediaUploadFileRequest[];
};

export type PlatformMediaFinalizeFileRequest = {
  uploadTargetId: string;
  contentType?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
};

export type PlatformMediaFinalizeRequest = {
  files: PlatformMediaFinalizeFileRequest[];
};

export type PlatformMediaUploadTarget = {
  uploadTargetId: string;
  clientFileId: string;
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
  stagingKey: string;
  expiresAt: string;
};

export type PlatformMediaResolvedTarget = {
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
  propertyId?: string;
};

export type PlatformMediaSessionRecord = {
  sessionId: string;
  uploadSessionKey: string;
  purpose: PlatformMediaPurpose;
  requestedVisibility: PlatformMediaVisibility;
  effectiveVisibility: PlatformMediaVisibility;
  actorUserId: string;
  ownerOrganizationId: string;
  resource: PlatformMediaResourceScope;
  target: PlatformMediaResolvedTarget;
  files: Array<
    PlatformMediaUploadFileRequest & {
      clientFileId: string;
      uploadTargetId: string;
      mediaId: string;
    }
  >;
  uploadTargets: PlatformMediaUploadTarget[];
  stagingPrefix: string;
  status: "signed" | "completed" | "failed";
  expiresAt: string;
  createdAt: string;
  completedAt?: string;
  completedMediaObject?: PlatformMediaObjectRecord;
  completedMediaObjects?: PlatformMediaObjectRecord[];
};

export type PlatformMediaVariantRecord = {
  variantName: PlatformMediaVariantName;
  visibility: PlatformMediaVisibility;
  storageKey: string;
  contentType: string;
  widthPx?: number;
  heightPx?: number;
  sizeBytes: number;
  checksumSha256?: string;
  publicCdnUrl: string | null;
};

export type PlatformMediaObjectRecord = {
  mediaId: string;
  purpose: PlatformMediaPurpose;
  visibility: PlatformMediaVisibility;
  requestedVisibility: PlatformMediaVisibility;
  approvalStatus: "pending_domain_approval" | "private" | "approved";
  lifecycleStatus: "staged" | "active";
  storageKind: "vayada_managed" | "external_reference";
  bucket: string;
  storageKey: string;
  ownerOrganizationId: string;
  actorUserId: string;
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
  propertyId?: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
  originalFilename: string;
  variants: PlatformMediaVariantRecord[];
  createdAt: string;
};

export type PlatformMediaAuditEvent = {
  action:
    | "platform_media.upload_session.created"
    | "platform_media.upload_session.finalized"
    | "platform_media.import_job.created";
  auditKey: string;
  actorUserId: string;
  organizationId: string;
  targetType: "media_upload_session" | "media_object" | "media_import_job";
  targetId: string;
  requestId: string;
  metadata: Record<string, unknown>;
};

export type PlatformMediaImportRequest = {
  purpose: "pms.import.source_image";
  resource: PlatformMediaResourceScope;
  sourceImageUrls: string[];
  idempotencyKey?: string;
};

export type PlatformMediaImportJobRecord = {
  importJobId: string;
  jobKey: string;
  purpose: "pms.import.source_image";
  status: "pending";
  actorUserId: string;
  ownerOrganizationId: string;
  sourceImageUrls: string[];
  resource: PlatformMediaResourceScope;
  target: PlatformMediaResolvedTarget;
  createdAt: string;
};

export type PlatformMediaFinalizedFileInspection = {
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  widthPx?: number;
  heightPx?: number;
};

export type PlatformMediaFinalizedFileRecord = {
  sessionFile: PlatformMediaSessionRecord["files"][number];
  uploadTarget: PlatformMediaUploadTarget;
  inspection: PlatformMediaFinalizedFileInspection;
};

export type PlatformMediaCompleteUploadSessionResult = {
  uploadSession: PlatformMediaSessionRecord;
  mediaObjects: PlatformMediaObjectRecord[];
};

export type PlatformMediaRepository = {
  createUploadSession(input: {
    sessionId: string;
    uploadSessionKey: string;
    stagingPrefix: string;
    context: RequestContext;
    request: PlatformMediaUploadSessionRequest;
    policy: PlatformMediaPurposePolicy;
    target: PlatformMediaResolvedTarget;
    uploadTargets: PlatformMediaUploadTarget[];
    now: string;
    expiresAt: string;
    auditEvent: PlatformMediaAuditEvent;
  }): Promise<PlatformMediaSessionRecord>;
  findUploadSession(sessionId: string): Promise<PlatformMediaSessionRecord | null>;
  findMediaObject(mediaId: string): Promise<PlatformMediaObjectRecord | null>;
  completeUploadSession(input: {
    session: PlatformMediaSessionRecord;
    files: PlatformMediaFinalizedFileRecord[];
    variantSets: PlatformMediaVariantRecord[][];
    bucketName: string;
    now: string;
    auditEvent: PlatformMediaAuditEvent;
  }): Promise<PlatformMediaCompleteUploadSessionResult>;
  createImportJob(input: {
    importJobId: string;
    jobKey: string;
    context: RequestContext;
    request: PlatformMediaImportRequest;
    policy: PlatformMediaPurposePolicy;
    target: PlatformMediaResolvedTarget;
    now: string;
  }): Promise<PlatformMediaImportJobRecord>;
  recordAudit(event: PlatformMediaAuditEvent): Promise<void>;
  close?(): Promise<void>;
};

export type ApprovedPublicProfileImageRepository = {
  persistent?: boolean;
  publicCdnBaseUrl?: string;
  findMediaObject(mediaId: string): Promise<PlatformMediaObjectRecord | null>;
};

export type ApprovedPublicProfileImageTarget = {
  purpose: "identity.user.profile_image" | "marketplace.creator.profile_image";
  resourceProduct: PlatformMediaResourceProduct;
  resourceType: string;
  resourceId: string;
};

export async function resolveApprovedPublicProfileImage(input: {
  repository?: ApprovedPublicProfileImageRepository;
  mediaId: string;
  actorUserId: string;
  ownerOrganizationId: string;
  allowedTargets: ApprovedPublicProfileImageTarget[];
}): Promise<{ ok: true; publicCdnUrl: string } | { ok: false; reason: "unavailable" | "invalid" }> {
  const { repository } = input;
  if (!repository?.persistent || !repository.publicCdnBaseUrl) {
    return { ok: false, reason: "unavailable" };
  }

  const mediaObject = await repository.findMediaObject(input.mediaId);
  const targetAllowed = input.allowedTargets.some(
    (target) =>
      mediaObject?.purpose === target.purpose &&
      mediaObject.resourceProduct === target.resourceProduct &&
      mediaObject.resourceType === target.resourceType &&
      mediaObject.resourceId === target.resourceId,
  );
  const canonicalVariant = mediaObject?.variants.find(
    (variant) => variant.variantName === "original_safe",
  );
  const publicCdnUrl = canonicalVariant?.publicCdnUrl ?? null;
  const isApprovedPublicImage =
    mediaObject?.actorUserId === input.actorUserId &&
    mediaObject.ownerOrganizationId === input.ownerOrganizationId &&
    targetAllowed &&
    mediaObject.storageKind === "vayada_managed" &&
    mediaObject.requestedVisibility === "public" &&
    mediaObject.visibility === "public" &&
    mediaObject.approvalStatus === "approved" &&
    mediaObject.lifecycleStatus === "active" &&
    mediaObject.contentType.startsWith("image/") &&
    !mediaObject.storageKey.startsWith("staging/") &&
    canonicalVariant?.visibility === "public" &&
    canonicalVariant.contentType.startsWith("image/") &&
    !canonicalVariant.storageKey.startsWith("staging/") &&
    publicCdnUrl !== null &&
    isUrlUnderBase(publicCdnUrl, repository.publicCdnBaseUrl);

  return isApprovedPublicImage && publicCdnUrl
    ? { ok: true, publicCdnUrl }
    : { ok: false, reason: "invalid" };
}

function isUrlUnderBase(value: string, base: string): boolean {
  try {
    const url = new URL(value);
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
    return (
      url.protocol === "https:" &&
      baseUrl.protocol === "https:" &&
      url.origin === baseUrl.origin &&
      (url.pathname === baseUrl.pathname || url.pathname.startsWith(basePath))
    );
  } catch {
    return false;
  }
}

export type PlatformMediaUploadSigner = {
  signUploadTarget(input: {
    sessionId: string;
    uploadTargetId: string;
    stagingKey: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: string;
  }): Promise<Omit<PlatformMediaUploadTarget, "clientFileId" | "stagingKey">>;
};

export type PlatformMediaTargetResolver = {
  resolveTarget(input: {
    context: RequestContext;
    request: PlatformMediaUploadSessionRequest;
    policy: PlatformMediaPurposePolicy;
  }): Promise<
    | { ok: true; target: PlatformMediaResolvedTarget }
    | { ok: false; statusCode: 400 | 403 | 404; code: string; message: string }
  >;
};

export type PlatformMediaUploadFinalizer = {
  inspectUploadedFile(input: {
    session: PlatformMediaSessionRecord;
    sessionFile: PlatformMediaSessionRecord["files"][number];
    uploadTarget: PlatformMediaUploadTarget;
    clientFile: PlatformMediaFinalizeFileRequest;
    policy: PlatformMediaPurposePolicy;
  }): Promise<
    | { ok: true; inspection: PlatformMediaFinalizedFileInspection }
    | { ok: false; code: string; message: string }
  >;
  generateVariants(input: {
    session: PlatformMediaSessionRecord;
    file: PlatformMediaFinalizedFileRecord;
    fileIndex: number;
    policy: PlatformMediaPurposePolicy;
  }): Promise<PlatformMediaVariantRecord[]>;
  cleanupUploadedFile?(input: {
    session: PlatformMediaSessionRecord;
    file: PlatformMediaFinalizedFileRecord;
  }): Promise<void>;
};

export type PlatformMediaRoutesOptions = {
  repository: PlatformMediaRepository;
  signer: PlatformMediaUploadSigner;
  targetResolver: PlatformMediaTargetResolver;
  finalizer: PlatformMediaUploadFinalizer;
  enabledPurposes: readonly PlatformMediaPurpose[];
  allowedOrigins?: string[];
  bucketName?: string;
  cleanupTimeoutMs?: number;
  now?: () => Date;
};

export type PlatformMediaPurposePolicy = {
  purpose: PlatformMediaPurpose;
  permission?: PermissionKey;
  actorOwned?: boolean;
  allowedRelationships: readonly ResourceRelationship[];
  allowedResources: ReadonlyArray<Pick<LinkedResource, "product" | "resourceType">>;
  allowedContentTypes: readonly string[];
  allowedExtensions: readonly string[];
  maxFileSizeBytes: number;
  maxFileCount: number;
  maxImagePixels?: number;
  resizeOversizedPublicImages?: boolean;
  autoApprovePublicOnFinalize?: boolean;
  privateOnly: boolean;
  targetResourceProduct: PlatformMediaResourceProduct;
  targetResourceType: string;
  requiredVariants: readonly PlatformMediaVariantName[];
};

const imageContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"] as const;
const publicImageVariants = ["original_safe", "large", "thumbnail", "blur_preview"] as const;
const providerOriginalVariant = ["provider_original"] as const;
const defaultMaxImagePixels = 60_000_000;
const publicImageVariantMaxDimensions: Record<
  Exclude<PlatformMediaVariantName, "provider_original">,
  { widthPx: number; heightPx: number }
> = {
  original_safe: { widthPx: 1920, heightPx: 1920 },
  large: { widthPx: 1280, heightPx: 720 },
  thumbnail: { widthPx: 320, heightPx: 180 },
  blur_preview: { widthPx: 32, heightPx: 18 },
};

const purposePolicies: Record<PlatformMediaPurpose, PlatformMediaPurposePolicy> = {
  "identity.user.profile_image": {
    purpose: "identity.user.profile_image",
    actorOwned: true,
    allowedRelationships: [],
    allowedResources: [{ product: "platform", resourceType: "user_profile" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: true,
    privateOnly: false,
    targetResourceProduct: "platform",
    targetResourceType: "user_profile",
    requiredVariants: publicImageVariants,
  },
  "property.hero_image": {
    purpose: "property.hero_image",
    permission: "booking.settings.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "booking", resourceType: "booking_hotel" },
      { product: "marketplace", resourceType: "hotel_profile" },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: false,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "property.gallery_image": {
    purpose: "property.gallery_image",
    permission: "booking.settings.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "booking", resourceType: "booking_hotel" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 25,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: false,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "property.logo": {
    purpose: "property.logo",
    permission: "booking.settings.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "booking", resourceType: "booking_hotel" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: false,
    targetResourceProduct: "hotel_catalog",
    targetResourceType: "property",
    requiredVariants: publicImageVariants,
  },
  "marketplace.offer.media": {
    purpose: "marketplace.offer.media",
    permission: "marketplace.profile.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [{ product: "marketplace", resourceType: "marketplace_offer" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 12,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: false,
    targetResourceProduct: "marketplace",
    targetResourceType: "marketplace_offer",
    requiredVariants: publicImageVariants,
  },
  "marketplace.creator.profile_image": {
    purpose: "marketplace.creator.profile_image",
    permission: "marketplace.profile.manage",
    allowedRelationships: ["owner"],
    allowedResources: [{ product: "marketplace", resourceType: "creator_profile" }],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 5 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    autoApprovePublicOnFinalize: true,
    privateOnly: false,
    targetResourceProduct: "marketplace",
    targetResourceType: "creator_profile",
    requiredVariants: publicImageVariants,
  },
  "marketplace.collaboration_chat.attachment": {
    purpose: "marketplace.collaboration_chat.attachment",
    permission: "marketplace.collaboration.review",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "marketplace", resourceType: "marketplace_offer" },
      { product: "marketplace", resourceType: "creator_profile" },
    ],
    allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    maxFileSizeBytes: 20 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "marketplace",
    targetResourceType: "collaboration",
    requiredVariants: providerOriginalVariant,
  },
  "pms.room_type.media": {
    purpose: "pms.room_type.media",
    permission: "pms.operations.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "pms", resourceType: "pms_property" },
      { product: "pms", resourceType: "pms_hotel" },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 20,
    maxImagePixels: defaultMaxImagePixels,
    resizeOversizedPublicImages: true,
    privateOnly: false,
    targetResourceProduct: "pms",
    targetResourceType: "room_type",
    requiredVariants: publicImageVariants,
  },
  "pms.messaging.attachment": {
    purpose: "pms.messaging.attachment",
    permission: "pms.operations.manage",
    allowedRelationships: ["owner", "operator", "front_desk"],
    allowedResources: [
      { product: "pms", resourceType: "pms_property" },
      { product: "pms", resourceType: "pms_hotel" },
    ],
    allowedContentTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "application/pdf",
    ],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".pdf"],
    maxFileSizeBytes: 25 * 1024 * 1024,
    maxFileCount: 1,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "pms",
    targetResourceType: "message_thread",
    requiredVariants: providerOriginalVariant,
  },
  "pms.import.source_image": {
    purpose: "pms.import.source_image",
    permission: "pms.operations.manage",
    allowedRelationships: ["owner", "operator"],
    allowedResources: [
      { product: "pms", resourceType: "pms_property" },
      { product: "pms", resourceType: "pms_hotel" },
    ],
    allowedContentTypes: imageContentTypes,
    allowedExtensions: imageExtensions,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFileCount: 20,
    maxImagePixels: defaultMaxImagePixels,
    privateOnly: true,
    targetResourceProduct: "pms",
    targetResourceType: "import_job",
    requiredVariants: providerOriginalVariant,
  },
};

export async function registerPlatformMediaRoutes(
  app: FastifyInstance,
  options: PlatformMediaRoutesOptions,
): Promise<void> {
  const bucketName = options.bucketName ?? "vayada-media-local";
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  const now = options.now ?? (() => new Date());
  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins?.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  });

  app.options("/*", async (_request, reply) => reply.status(204).send());

  app.post<{ Body: PlatformMediaUploadSessionRequest }>(
    "/upload-sessions",
    async (request, reply) => {
      const validation = validateUploadSessionRequest(request.body);
      if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);
      if (!isPurposeEnabled(options, request.body.purpose)) {
        return sendPurposeUnavailable(reply);
      }

      const policy = purposePolicies[request.body.purpose];
      const resourceError = validateResourceScope(request.body.resource, policy);
      if (resourceError) {
        return sendMediaError(reply, 400, resourceError.code, resourceError.message);
      }

      const context = policy.actorOwned
        ? requireAuthContext(request)
        : enforceRoutePolicy(request, {
            permission: permissionForResource(policy, request.body.resource),
            resource: {
              product: request.body.resource.product,
              resourceType: request.body.resource.resourceType,
              resourceId: request.body.resource.resourceId,
              allowedRelationships: policy.allowedRelationships,
            },
          });
      if (policy.actorOwned && request.body.resource.resourceId !== context.actor.internalUserId) {
        return sendMediaError(
          reply,
          403,
          "media_resource_forbidden",
          "Profile images can only be uploaded for the signed-in user.",
        );
      }
      if (
        policy.actorOwned &&
        (request.body.resource.targetResourceId !== undefined ||
          request.body.resource.propertyId !== undefined)
      ) {
        return sendMediaError(
          reply,
          400,
          "invalid_resource_scope",
          "Profile image targets cannot be overridden.",
        );
      }

      const requestedVisibility = request.body.visibility ?? "private";
      if (policy.autoApprovePublicOnFinalize && requestedVisibility !== "public") {
        return sendMediaError(
          reply,
          400,
          "invalid_media_visibility",
          `${request.body.purpose} uploads must be public.`,
        );
      }
      if (policy.privateOnly && requestedVisibility !== "private") {
        return sendMediaError(
          reply,
          400,
          "invalid_media_visibility",
          `${request.body.purpose} uploads must stay private.`,
        );
      }

      const filePolicyError = validateFiles(request.body.files, policy);
      if (filePolicyError) {
        return sendMediaError(reply, 400, filePolicyError.code, filePolicyError.message);
      }

      const resolvedTarget = await options.targetResolver.resolveTarget({
        context,
        request: request.body,
        policy,
      });
      if (!resolvedTarget.ok) {
        return sendMediaError(
          reply,
          resolvedTarget.statusCode,
          resolvedTarget.code,
          resolvedTarget.message,
        );
      }

      const createdAt = now().toISOString();
      const expiresAt = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
      const sessionId = randomUUID();
      const uploadSessionKey = `media.upload_session:${sessionId}`;
      const stagingPrefix = `staging/${sessionId}`;
      const files = request.body.files.map((file, index) => ({
        ...file,
        filename: normalizeFilename(file.filename),
        contentType: normalizeContentType(file.contentType),
        clientFileId: file.clientFileId?.trim() || `file_${index + 1}`,
        uploadTargetId: randomUUID(),
      }));
      const uploadTargets = await Promise.all(
        files.map(async (file, index) => {
          const stagingKey = `${stagingPrefix}/${index + 1}/${file.filename}`;
          const signed = await options.signer.signUploadTarget({
            sessionId,
            uploadTargetId: file.uploadTargetId,
            stagingKey,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            expiresAt,
          });
          return {
            ...signed,
            clientFileId: file.clientFileId,
            stagingKey,
          };
        }),
      );

      const session = await options.repository.createUploadSession({
        context,
        sessionId,
        uploadSessionKey,
        stagingPrefix,
        request: {
          ...request.body,
          visibility: requestedVisibility,
          files,
        },
        policy,
        target: resolvedTarget.target,
        uploadTargets,
        now: createdAt,
        expiresAt,
        auditEvent: {
          action: "platform_media.upload_session.created",
          auditKey: uploadSessionKey,
          actorUserId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
          targetType: "media_upload_session",
          targetId: sessionId,
          requestId: context.audit.requestId,
          metadata: {
            purpose: request.body.purpose,
            requestedVisibility,
            resource: request.body.resource,
            target: resolvedTarget.target,
            fileCount: files.length,
          },
        },
      });

      return reply.code(201).send({
        contractVersion: PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION,
        uploadSession: serializeSession(session),
        uploadTargets: session.uploadTargets,
        audit: serializeAudit(context),
      });
    },
  );

  app.post<{ Body: PlatformMediaFinalizeRequest; Params: { sessionId: string } }>(
    "/upload-sessions/:sessionId/finalize",
    async (request, reply) => {
      const session = await options.repository.findUploadSession(request.params.sessionId);
      if (!session) {
        return sendMediaError(reply, 404, "upload_session_not_found", "Upload session not found.");
      }
      if (!isPurposeEnabled(options, session.purpose)) {
        return sendPurposeUnavailable(reply);
      }
      const policy = purposePolicies[session.purpose];
      const context = policy.actorOwned
        ? requireAuthContext(request)
        : enforceRoutePolicy(request, {
            permission: permissionForResource(policy, session.resource),
            resource: {
              product: session.resource.product,
              resourceType: session.resource.resourceType,
              resourceId: session.resource.resourceId,
              allowedRelationships: policy.allowedRelationships,
            },
          });
      if (policy.actorOwned && session.resource.resourceId !== context.actor.internalUserId) {
        return sendMediaError(
          reply,
          403,
          "media_resource_forbidden",
          "Profile images can only be finalized by the signed-in user.",
        );
      }
      if (
        context.actor.internalUserId !== session.actorUserId ||
        context.selectedOrganization.organizationId !== session.ownerOrganizationId
      ) {
        return sendMediaError(
          reply,
          403,
          "upload_session_actor_mismatch",
          "Upload session belongs to a different actor or organization.",
        );
      }
      if (session.status === "completed" && session.completedMediaObject) {
        await cleanupUploadedFiles({
          finalizer: options.finalizer,
          session,
          files: finalizedFilesFromCompletedSession(session),
          timeoutMs: cleanupTimeoutMs,
          onError(error, file) {
            request.log.warn(
              {
                err: error,
                sessionId: session.sessionId,
                uploadTargetId: file.uploadTarget.uploadTargetId,
              },
              "Platform media staging cleanup failed; a finalize replay will retry it.",
            );
          },
        });
        return reply.code(200).send({
          contractVersion: PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION,
          uploadSession: serializeSession(session),
          mediaObject: session.completedMediaObject,
          mediaObjects: session.completedMediaObjects ?? [session.completedMediaObject],
          sideEffects: ["idempotency_replay"],
        });
      }
      if (new Date(session.expiresAt).getTime() <= now().getTime()) {
        return sendMediaError(reply, 409, "upload_session_expired", "Upload session expired.");
      }
      const finalizationSession =
        session.requestedVisibility === "public" && policy.autoApprovePublicOnFinalize === true
          ? { ...session, effectiveVisibility: "public" as const }
          : session;
      const validation = validateFinalizeRequest(request.body, finalizationSession);
      if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);

      const finalizedFiles = await inspectFinalizedFiles({
        request: request.body,
        session: finalizationSession,
        policy,
        finalizer: options.finalizer,
      });
      if (!finalizedFiles.ok) {
        return sendMediaError(reply, 400, finalizedFiles.code, finalizedFiles.message);
      }

      const variantSets = await Promise.all(
        finalizedFiles.files.map((file, index) =>
          options.finalizer.generateVariants({
            session: finalizationSession,
            file,
            fileIndex: index,
            policy,
          }),
        ),
      );
      const completedAt = now().toISOString();
      const completed = await options.repository.completeUploadSession({
        session: finalizationSession,
        files: finalizedFiles.files,
        variantSets,
        bucketName,
        now: completedAt,
        auditEvent: {
          action: "platform_media.upload_session.finalized",
          auditKey: `media.finalize:${session.sessionId}`,
          actorUserId: finalizationSession.actorUserId,
          organizationId: finalizationSession.ownerOrganizationId,
          targetType: "media_object",
          targetId: finalizationSession.files[0]!.mediaId,
          requestId: context.audit.requestId,
          metadata: {
            purpose: finalizationSession.purpose,
            requestedVisibility: finalizationSession.requestedVisibility,
            effectiveVisibility: finalizationSession.effectiveVisibility,
            target: finalizationSession.target,
            mediaIds: finalizationSession.files.map(({ mediaId }) => mediaId),
            variantNames: variantSets[0]?.map(({ variantName }) => variantName) ?? [],
          },
        },
      });
      const completedSession = completed.uploadSession;
      const mediaObjects = completed.mediaObjects;
      const primaryMediaObject = mediaObjects[0]!;
      await cleanupUploadedFiles({
        finalizer: options.finalizer,
        session: completedSession,
        files: finalizedFiles.files,
        timeoutMs: cleanupTimeoutMs,
        onError(error, file) {
          request.log.warn(
            {
              err: error,
              sessionId: completedSession.sessionId,
              uploadTargetId: file.uploadTarget.uploadTargetId,
            },
            "Platform media staging cleanup failed; a finalize replay will retry it.",
          );
        },
      });

      return reply.code(200).send({
        contractVersion: PLATFORM_MEDIA_UPLOAD_CONTRACT_VERSION,
        uploadSession: serializeSession(completedSession),
        mediaObject: primaryMediaObject,
        mediaObjects,
        sideEffects: ["variant_generation", "audit_event"],
      });
    },
  );

  app.post<{ Body: PlatformMediaImportRequest }>("/imports", async (request, reply) => {
    const validation = validateImportRequest(request.body);
    if (!validation.ok) return sendMediaError(reply, 400, validation.code, validation.message);
    if (!isPurposeEnabled(options, request.body.purpose)) {
      return sendPurposeUnavailable(reply);
    }

    const policy = purposePolicies[request.body.purpose];
    const resourceError = validateResourceScope(request.body.resource, policy);
    if (resourceError) {
      return sendMediaError(reply, 400, resourceError.code, resourceError.message);
    }

    const context = enforceRoutePolicy(request, {
      permission: permissionForResource(policy, request.body.resource),
      resource: {
        product: request.body.resource.product,
        resourceType: request.body.resource.resourceType,
        resourceId: request.body.resource.resourceId,
        allowedRelationships: policy.allowedRelationships,
      },
    });

    const resolvedTarget = await options.targetResolver.resolveTarget({
      context,
      request: {
        ...request.body,
        visibility: "private",
        files: request.body.sourceImageUrls.map((sourceImageUrl, index) => ({
          clientFileId: `source_${index + 1}`,
          filename: sourceFilename(sourceImageUrl, index),
          contentType: "image/jpeg",
          sizeBytes: 1,
        })),
      },
      policy,
    });
    if (!resolvedTarget.ok) {
      return sendMediaError(
        reply,
        resolvedTarget.statusCode,
        resolvedTarget.code,
        resolvedTarget.message,
      );
    }

    const createdAt = now().toISOString();
    const importJobId = randomUUID();
    const jobKey =
      request.body.idempotencyKey?.trim() ||
      `media.import:pms:${request.body.resource.targetResourceId ?? request.body.resource.resourceId}:${importJobId}:v1`;
    const importJob = await options.repository.createImportJob({
      context,
      importJobId,
      jobKey,
      request: request.body,
      policy,
      target: resolvedTarget.target,
      now: createdAt,
    });

    await options.repository.recordAudit({
      action: "platform_media.import_job.created",
      auditKey: jobKey,
      actorUserId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
      targetType: "media_import_job",
      targetId: importJob.importJobId,
      requestId: context.audit.requestId,
      metadata: {
        purpose: importJob.purpose,
        sourceImageCount: importJob.sourceImageUrls.length,
        resource: importJob.resource,
        target: importJob.target,
      },
    });

    return reply.code(202).send({
      contractVersion: PLATFORM_MEDIA_IMPORT_CONTRACT_VERSION,
      importJob: serializeImportJob(importJob),
      sideEffects: ["media_import_job_created", "audit_event"],
      audit: serializeAudit(context),
    });
  });
}

export function createDeterministicPlatformMediaUploadSigner(
  baseUrl = "https://uploads.vayada.localhost",
): PlatformMediaUploadSigner {
  return {
    async signUploadTarget(input) {
      return {
        uploadTargetId: input.uploadTargetId,
        method: "PUT",
        uploadUrl: `${baseUrl}/${encodeURIComponent(input.stagingKey)}`,
        headers: {
          "content-type": input.contentType,
          "x-vayada-upload-target-id": input.uploadTargetId,
        },
        expiresAt: input.expiresAt,
      };
    },
  };
}

export function createDeterministicPlatformMediaFinalizer(
  overrides: Partial<PlatformMediaFinalizedFileInspection> = {},
): PlatformMediaUploadFinalizer {
  return {
    async inspectUploadedFile(input) {
      return {
        ok: true,
        inspection: {
          contentType: input.sessionFile.contentType,
          sizeBytes: input.sessionFile.sizeBytes,
          checksumSha256:
            input.clientFile.checksumSha256 ??
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          widthPx: isImageContentType(input.sessionFile.contentType)
            ? (input.clientFile.widthPx ?? 1800)
            : undefined,
          heightPx: isImageContentType(input.sessionFile.contentType)
            ? (input.clientFile.heightPx ?? 1200)
            : undefined,
          ...overrides,
        },
      };
    },
    async generateVariants(input) {
      return input.policy.requiredVariants.map((variantName) => {
        const dimensions = resizedVariantDimensions(
          variantName,
          input.file.inspection.widthPx,
          input.file.inspection.heightPx,
          input.policy.resizeOversizedPublicImages === true,
        );
        return {
          variantName,
          visibility: input.session.effectiveVisibility,
          storageKey: `${input.session.stagingPrefix}/${input.fileIndex + 1}/variants/${variantName}`,
          contentType: normalizeContentType(input.file.inspection.contentType),
          widthPx: dimensions?.widthPx,
          heightPx: dimensions?.heightPx,
          sizeBytes: resizedVariantSize(input.file.inspection, dimensions),
          publicCdnUrl: null,
        };
      });
    },
  };
}

export function createInMemoryPlatformMediaRepository(): PlatformMediaRepository & {
  sessions: Map<string, PlatformMediaSessionRecord>;
  importJobs: Map<string, PlatformMediaImportJobRecord>;
  auditEvents: PlatformMediaAuditEvent[];
} {
  const sessions = new Map<string, PlatformMediaSessionRecord>();
  const importJobs = new Map<string, PlatformMediaImportJobRecord>();
  const auditEvents: PlatformMediaAuditEvent[] = [];

  return {
    sessions,
    importJobs,
    auditEvents,
    async createUploadSession(input) {
      const session: PlatformMediaSessionRecord = {
        sessionId: input.sessionId,
        uploadSessionKey: input.uploadSessionKey,
        purpose: input.request.purpose,
        requestedVisibility: input.request.visibility ?? "private",
        effectiveVisibility: "private",
        actorUserId: input.context.actor.internalUserId,
        ownerOrganizationId: input.context.selectedOrganization.organizationId,
        resource: input.request.resource,
        target: input.target,
        files: input.request.files.map((file, index) => ({
          ...file,
          clientFileId: file.clientFileId?.trim() || `file_${index + 1}`,
          uploadTargetId: input.uploadTargets[index]!.uploadTargetId,
          mediaId: randomUUID(),
        })),
        uploadTargets: input.uploadTargets,
        stagingPrefix: input.stagingPrefix,
        status: "signed",
        expiresAt: input.expiresAt,
        createdAt: input.now,
      };
      sessions.set(session.sessionId, session);
      recordInMemoryAudit(auditEvents, input.auditEvent);
      return session;
    },
    async findUploadSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async findMediaObject(mediaId) {
      for (const session of sessions.values()) {
        const mediaObject = (session.completedMediaObjects ?? []).find(
          (candidate) => candidate.mediaId === mediaId,
        );
        if (mediaObject) return mediaObject;
      }
      return null;
    },
    async completeUploadSession(input) {
      const autoApproved =
        input.session.requestedVisibility === "public" &&
        input.session.effectiveVisibility === "public";
      const effectiveVisibility = autoApproved ? "public" : input.session.effectiveVisibility;
      const mediaObjects = input.files.map((finalized, index) => {
        const sessionFile = finalized.sessionFile;
        return {
          mediaId: sessionFile.mediaId,
          purpose: input.session.purpose,
          visibility: effectiveVisibility,
          requestedVisibility: input.session.requestedVisibility,
          approvalStatus: autoApproved
            ? "approved"
            : input.session.requestedVisibility === "public"
              ? "pending_domain_approval"
              : "private",
          lifecycleStatus: autoApproved ? "active" : "staged",
          storageKind: "vayada_managed",
          bucket: input.bucketName,
          storageKey: `${input.session.stagingPrefix}/${index + 1}/active/${sessionFile.filename}`,
          ownerOrganizationId: input.session.ownerOrganizationId,
          actorUserId: input.session.actorUserId,
          resourceProduct: input.session.target.resourceProduct,
          resourceType: input.session.target.resourceType,
          resourceId: input.session.target.resourceId,
          propertyId: input.session.target.propertyId,
          contentType: normalizeContentType(finalized.inspection.contentType),
          sizeBytes: finalized.inspection.sizeBytes,
          checksumSha256: finalized.inspection.checksumSha256,
          widthPx: finalized.inspection.widthPx,
          heightPx: finalized.inspection.heightPx,
          originalFilename: sessionFile.filename,
          variants: input.variantSets[index]!.map((variant) => ({
            ...variant,
            visibility: effectiveVisibility,
          })),
          createdAt: input.now,
        } satisfies PlatformMediaObjectRecord;
      });
      const uploadSession: PlatformMediaSessionRecord = {
        ...input.session,
        effectiveVisibility,
        status: "completed",
        completedAt: input.now,
        completedMediaObjects: mediaObjects,
        completedMediaObject: mediaObjects[0],
      };
      sessions.set(uploadSession.sessionId, uploadSession);
      recordInMemoryAudit(auditEvents, input.auditEvent);
      return { uploadSession, mediaObjects };
    },
    async createImportJob(input) {
      const existing = [...importJobs.values()].find(
        ({ jobKey, ownerOrganizationId }) =>
          jobKey === input.jobKey &&
          ownerOrganizationId === input.context.selectedOrganization.organizationId,
      );
      if (existing) return existing;

      const importJob: PlatformMediaImportJobRecord = {
        importJobId: input.importJobId,
        jobKey: input.jobKey,
        purpose: input.request.purpose,
        status: "pending",
        actorUserId: input.context.actor.internalUserId,
        ownerOrganizationId: input.context.selectedOrganization.organizationId,
        sourceImageUrls: input.request.sourceImageUrls,
        resource: input.request.resource,
        target: input.target,
        createdAt: input.now,
      };
      importJobs.set(importJob.importJobId, importJob);
      return importJob;
    },
    async recordAudit(event) {
      recordInMemoryAudit(auditEvents, event);
    },
  };
}

function recordInMemoryAudit(
  auditEvents: PlatformMediaAuditEvent[],
  event: PlatformMediaAuditEvent,
): void {
  if (
    !auditEvents.some(
      ({ auditKey, action, organizationId }) =>
        auditKey === event.auditKey &&
        action === event.action &&
        organizationId === event.organizationId,
    )
  ) {
    auditEvents.push(event);
  }
}

export function createPassthroughPlatformMediaTargetResolver(): PlatformMediaTargetResolver {
  return {
    async resolveTarget({ request, policy }) {
      return {
        ok: true,
        target: {
          resourceProduct: policy.targetResourceProduct,
          resourceType: policy.targetResourceType,
          resourceId:
            request.resource.targetResourceId ??
            request.resource.propertyId ??
            request.resource.resourceId,
          propertyId: request.resource.propertyId,
        },
      };
    },
  };
}

function validateUploadSessionRequest(
  body: PlatformMediaUploadSessionRequest | undefined,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_upload_request", message: "Request body is required." };
  }
  if (!isMediaPurpose(body.purpose)) {
    return { ok: false, code: "invalid_media_purpose", message: "Unsupported media purpose." };
  }
  if (
    body.visibility !== undefined &&
    body.visibility !== "public" &&
    body.visibility !== "private"
  ) {
    return { ok: false, code: "invalid_media_visibility", message: "Unsupported visibility." };
  }
  if (!body.resource || typeof body.resource !== "object") {
    return { ok: false, code: "invalid_resource_scope", message: "Resource scope is required." };
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return { ok: false, code: "invalid_upload_files", message: "At least one file is required." };
  }
  return { ok: true };
}

function validateImportRequest(
  body: PlatformMediaImportRequest | undefined,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "invalid_import_request", message: "Request body is required." };
  }
  if (body.purpose !== "pms.import.source_image") {
    return { ok: false, code: "invalid_media_purpose", message: "Unsupported media purpose." };
  }
  if (!body.resource || typeof body.resource !== "object") {
    return { ok: false, code: "invalid_resource_scope", message: "Resource scope is required." };
  }
  if (!Array.isArray(body.sourceImageUrls) || body.sourceImageUrls.length === 0) {
    return {
      ok: false,
      code: "invalid_import_sources",
      message: "At least one source image URL is required.",
    };
  }
  const policy = purposePolicies["pms.import.source_image"];
  if (body.sourceImageUrls.length > policy.maxFileCount) {
    return {
      ok: false,
      code: "media_file_count_exceeded",
      message: `${policy.purpose} accepts at most ${policy.maxFileCount} source URL(s).`,
    };
  }
  for (const sourceImageUrl of body.sourceImageUrls) {
    if (typeof sourceImageUrl !== "string" || !isSupportedSourceImageUrl(sourceImageUrl)) {
      return {
        ok: false,
        code: "invalid_import_source_url",
        message: "Each source image URL must be an http(s) URL with a supported image extension.",
      };
    }
  }
  if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
    return {
      ok: false,
      code: "invalid_import_request",
      message: "idempotencyKey must be a string.",
    };
  }
  return { ok: true };
}

function permissionForResource(
  policy: PlatformMediaPurposePolicy,
  resource: PlatformMediaResourceScope,
): PermissionKey {
  if (policy.purpose === "property.hero_image" && resource.product === "marketplace") {
    return "marketplace.profile.manage";
  }
  if (!policy.permission) throw new Error(`${policy.purpose} does not use a role permission.`);
  return policy.permission;
}

function validateResourceScope(
  resource: PlatformMediaResourceScope,
  policy: PlatformMediaPurposePolicy,
): { code: string; message: string } | null {
  if (typeof resource.product !== "string" || typeof resource.resourceType !== "string") {
    return {
      code: "invalid_resource_scope",
      message: "resource.product and resource.resourceType are required.",
    };
  }
  if (typeof resource.resourceId !== "string" || !resource.resourceId.trim()) {
    return { code: "invalid_resource_scope", message: "resource.resourceId is required." };
  }
  if (resource.propertyId !== undefined && typeof resource.propertyId !== "string") {
    return { code: "invalid_resource_scope", message: "resource.propertyId must be a string." };
  }
  if (resource.targetResourceId !== undefined && typeof resource.targetResourceId !== "string") {
    return {
      code: "invalid_resource_scope",
      message: "resource.targetResourceId must be a string.",
    };
  }
  const allowed = policy.allowedResources.some(
    (candidate) =>
      candidate.product === resource.product && candidate.resourceType === resource.resourceType,
  );
  if (!allowed) {
    return {
      code: "invalid_resource_scope",
      message: `${policy.purpose} cannot be uploaded for ${resource.product}:${resource.resourceType}.`,
    };
  }
  return null;
}

function validateFiles(
  files: PlatformMediaUploadFileRequest[],
  policy: PlatformMediaPurposePolicy,
): { code: string; message: string } | null {
  if (files.length > policy.maxFileCount) {
    return {
      code: "media_file_count_exceeded",
      message: `${policy.purpose} accepts at most ${policy.maxFileCount} file(s).`,
    };
  }
  for (const file of files) {
    if (!file || typeof file !== "object") {
      return { code: "invalid_upload_files", message: "Each file must be an object." };
    }
    if (file.clientFileId !== undefined && typeof file.clientFileId !== "string") {
      return { code: "invalid_upload_files", message: "clientFileId must be a string." };
    }
    if (typeof file.filename !== "string" || !file.filename.trim()) {
      return { code: "invalid_media_filename", message: "filename is required." };
    }
    if (typeof file.contentType !== "string" || !file.contentType.trim()) {
      return { code: "unsupported_media_type", message: "contentType is required." };
    }
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      return { code: "invalid_media_size", message: "sizeBytes must be greater than zero." };
    }
    if (file.sizeBytes > policy.maxFileSizeBytes) {
      return {
        code: "media_file_too_large",
        message: `${policy.purpose} files must be ${policy.maxFileSizeBytes} bytes or smaller.`,
      };
    }
    const normalizedContentType = normalizeContentType(file.contentType);
    if (!policy.allowedContentTypes.includes(normalizedContentType)) {
      return { code: "unsupported_media_type", message: `${file.contentType} is not allowed.` };
    }
    const extension = filenameExtension(file.filename);
    if (!extension || !policy.allowedExtensions.includes(extension)) {
      return { code: "unsupported_media_extension", message: `${file.filename} is not allowed.` };
    }
    if (!contentTypeAllowsExtension(normalizedContentType, extension)) {
      return {
        code: "media_type_mismatch",
        message: "File extension must match the requested content type.",
      };
    }
  }
  return null;
}

function validateFinalizeRequest(
  body: PlatformMediaFinalizeRequest | undefined,
  session: PlatformMediaSessionRecord,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!body || !Array.isArray(body.files)) {
    return { ok: false, code: "invalid_finalize_request", message: "files are required." };
  }
  if (body.files.length !== session.files.length) {
    return {
      ok: false,
      code: "media_file_count_mismatch",
      message: "Finalize file count must match the upload session.",
    };
  }
  const knownTargets = new Set(session.files.map((file) => file.uploadTargetId));
  const seenTargets = new Set<string>();
  for (const file of body.files) {
    if (!file || typeof file !== "object") {
      return {
        ok: false,
        code: "invalid_finalize_request",
        message: "Each file must be an object.",
      };
    }
    if (typeof file.uploadTargetId !== "string" || !file.uploadTargetId.trim()) {
      return { ok: false, code: "unknown_upload_target", message: "uploadTargetId is required." };
    }
    if (!knownTargets.has(file.uploadTargetId)) {
      return { ok: false, code: "unknown_upload_target", message: "Unknown upload target." };
    }
    if (seenTargets.has(file.uploadTargetId)) {
      return {
        ok: false,
        code: "duplicate_upload_target",
        message: "Each upload target may be finalized once.",
      };
    }
    seenTargets.add(file.uploadTargetId);
    if (file.contentType !== undefined && typeof file.contentType !== "string") {
      return {
        ok: false,
        code: "unsupported_media_type",
        message: "Finalized contentType must be a string.",
      };
    }
    if (
      file.sizeBytes !== undefined &&
      (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0)
    ) {
      return {
        ok: false,
        code: "invalid_media_size",
        message: "Finalized sizeBytes must be greater than zero.",
      };
    }
    if (file.checksumSha256 !== undefined && !isSha256Hex(file.checksumSha256)) {
      return {
        ok: false,
        code: "invalid_media_checksum",
        message: "checksumSha256 must be a lowercase SHA-256 hex string.",
      };
    }
    if (
      (file.widthPx !== undefined && (!Number.isInteger(file.widthPx) || file.widthPx <= 0)) ||
      (file.heightPx !== undefined && (!Number.isInteger(file.heightPx) || file.heightPx <= 0))
    ) {
      return {
        ok: false,
        code: "invalid_media_dimensions",
        message: "Image dimensions must be positive integers when supplied.",
      };
    }
  }
  return { ok: true };
}

async function inspectFinalizedFiles(input: {
  request: PlatformMediaFinalizeRequest;
  session: PlatformMediaSessionRecord;
  policy: PlatformMediaPurposePolicy;
  finalizer: PlatformMediaUploadFinalizer;
}): Promise<
  | { ok: true; files: PlatformMediaFinalizedFileRecord[] }
  | { ok: false; code: string; message: string }
> {
  const files: PlatformMediaFinalizedFileRecord[] = [];
  for (const sessionFile of input.session.files) {
    const clientFile = input.request.files.find(
      (file) => file.uploadTargetId === sessionFile.uploadTargetId,
    )!;
    const uploadTarget = input.session.uploadTargets.find(
      (target) => target.uploadTargetId === sessionFile.uploadTargetId,
    )!;
    const inspected = await input.finalizer.inspectUploadedFile({
      session: input.session,
      sessionFile,
      uploadTarget,
      clientFile,
      policy: input.policy,
    });
    if (!inspected.ok) return inspected;
    const validation = validateFinalizedInspection(
      clientFile,
      sessionFile,
      inspected.inspection,
      input.policy,
    );
    if (validation) return validation;
    files.push({
      sessionFile,
      uploadTarget,
      inspection: {
        ...inspected.inspection,
        contentType: normalizeContentType(inspected.inspection.contentType),
      },
    });
  }
  return { ok: true, files };
}

function validateFinalizedInspection(
  clientFile: PlatformMediaFinalizeFileRequest,
  sessionFile: PlatformMediaSessionRecord["files"][number],
  inspection: PlatformMediaFinalizedFileInspection,
  policy: PlatformMediaPurposePolicy,
): { ok: false; code: string; message: string } | null {
  if (!Number.isInteger(inspection.sizeBytes) || inspection.sizeBytes <= 0) {
    return {
      ok: false,
      code: "invalid_media_size",
      message: "Inspected upload size must be greater than zero.",
    };
  }
  if (
    inspection.sizeBytes > sessionFile.sizeBytes ||
    inspection.sizeBytes > policy.maxFileSizeBytes
  ) {
    return {
      ok: false,
      code: "media_file_too_large",
      message: "Inspected upload cannot exceed the signed upload size.",
    };
  }
  const inspectedContentType = normalizeContentType(inspection.contentType);
  if (!policy.allowedContentTypes.includes(inspectedContentType)) {
    return {
      ok: false,
      code: "unsupported_media_type",
      message: "Inspected content type is not allowed.",
    };
  }
  if (inspectedContentType !== normalizeContentType(sessionFile.contentType)) {
    return {
      ok: false,
      code: "media_type_mismatch",
      message: "Inspected content type must match the signed upload target.",
    };
  }
  if (
    clientFile.contentType !== undefined &&
    normalizeContentType(clientFile.contentType) !== inspectedContentType
  ) {
    return {
      ok: false,
      code: "media_type_mismatch",
      message: "Finalized content type must match the inspected upload.",
    };
  }
  if (clientFile.sizeBytes !== undefined && clientFile.sizeBytes !== inspection.sizeBytes) {
    return {
      ok: false,
      code: "media_size_mismatch",
      message: "Finalized size must match the inspected upload.",
    };
  }
  if (clientFile.checksumSha256 !== undefined) {
    if (inspection.checksumSha256 === undefined) {
      return {
        ok: false,
        code: "finalizer_missing_inspected_checksum",
        message: "Inspected upload must include checksum when finalize checksum is supplied.",
      };
    }
    if (!isSha256Hex(inspection.checksumSha256)) {
      return {
        ok: false,
        code: "invalid_media_checksum",
        message: "Inspected checksum must be a lowercase SHA-256 hex string.",
      };
    }
    if (clientFile.checksumSha256 !== inspection.checksumSha256) {
      return {
        ok: false,
        code: "media_checksum_mismatch",
        message: "Finalized checksum must match the inspected upload.",
      };
    }
  }
  if (inspection.checksumSha256 !== undefined && !isSha256Hex(inspection.checksumSha256)) {
    return {
      ok: false,
      code: "invalid_media_checksum",
      message: "Inspected checksum must be a lowercase SHA-256 hex string.",
    };
  }
  if (
    (inspection.widthPx !== undefined &&
      (!Number.isInteger(inspection.widthPx) || inspection.widthPx <= 0)) ||
    (inspection.heightPx !== undefined &&
      (!Number.isInteger(inspection.heightPx) || inspection.heightPx <= 0))
  ) {
    return {
      ok: false,
      code: "invalid_media_dimensions",
      message: "Inspected image dimensions must be positive integers.",
    };
  }
  if (
    inspection.widthPx !== undefined &&
    inspection.heightPx !== undefined &&
    policy.maxImagePixels &&
    !policy.resizeOversizedPublicImages &&
    inspection.widthPx * inspection.heightPx > policy.maxImagePixels
  ) {
    return {
      ok: false,
      code: "invalid_media_dimensions",
      message: "Inspected image dimensions exceed the platform media limit.",
    };
  }
  return null;
}

function serializeSession(session: PlatformMediaSessionRecord): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    purpose: session.purpose,
    requestedVisibility: session.requestedVisibility,
    effectiveVisibility: session.effectiveVisibility,
    status: session.status,
    expiresAt: session.expiresAt,
    resource: session.resource,
    target: session.target,
    fileCount: session.files.length,
  };
}

function serializeImportJob(importJob: PlatformMediaImportJobRecord): Record<string, unknown> {
  return {
    importJobId: importJob.importJobId,
    jobKey: importJob.jobKey,
    purpose: importJob.purpose,
    status: importJob.status,
    resource: importJob.resource,
    target: importJob.target,
    sourceImageCount: importJob.sourceImageUrls.length,
    createdAt: importJob.createdAt,
  };
}

function serializeAudit(context: RequestContext): Record<string, string> {
  return {
    requestId: context.audit.requestId,
    actorInternalUserId: context.actor.internalUserId,
    organizationId: context.selectedOrganization.organizationId,
  };
}

function sendMediaError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ code, message });
}

function sendPurposeUnavailable(reply: FastifyReply) {
  return sendMediaError(
    reply,
    503,
    "media_purpose_unavailable",
    "This media purpose is not available in the configured runtime.",
  );
}

function isPurposeEnabled(
  options: PlatformMediaRoutesOptions,
  purpose: PlatformMediaPurpose,
): boolean {
  return options.enabledPurposes?.includes(purpose) === true;
}

async function cleanupUploadedFiles(input: {
  finalizer: PlatformMediaUploadFinalizer;
  session: PlatformMediaSessionRecord;
  files: PlatformMediaFinalizedFileRecord[];
  timeoutMs: number;
  onError(error: unknown, file: PlatformMediaFinalizedFileRecord): void;
}): Promise<void> {
  if (!input.finalizer.cleanupUploadedFile) return;

  await Promise.all(
    input.files.map(async (file) => {
      try {
        await withTimeout(
          input.finalizer.cleanupUploadedFile!({ session: input.session, file }),
          input.timeoutMs,
        );
      } catch (error) {
        input.onError(error, file);
      }
    }),
  );
}

function finalizedFilesFromCompletedSession(
  session: PlatformMediaSessionRecord,
): PlatformMediaFinalizedFileRecord[] {
  const mediaObjects = new Map(
    (
      session.completedMediaObjects ??
      (session.completedMediaObject ? [session.completedMediaObject] : [])
    ).map((mediaObject) => [mediaObject.mediaId, mediaObject]),
  );
  return session.files.flatMap((sessionFile) => {
    const uploadTarget = session.uploadTargets.find(
      (candidate) => candidate.uploadTargetId === sessionFile.uploadTargetId,
    );
    const mediaObject = mediaObjects.get(sessionFile.mediaId);
    if (!uploadTarget || !mediaObject) return [];
    return [
      {
        sessionFile,
        uploadTarget,
        inspection: {
          contentType: mediaObject.contentType,
          sizeBytes: mediaObject.sizeBytes,
          checksumSha256: mediaObject.checksumSha256,
          widthPx: mediaObject.widthPx,
          heightPx: mediaObject.heightPx,
        },
      },
    ];
  });
}

function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([
    operation,
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error(`Platform media staging cleanup timed out after ${timeoutMs} ms.`);
    }),
  ]);
}

function isMediaPurpose(value: unknown): value is PlatformMediaPurpose {
  return typeof value === "string" && Object.hasOwn(purposePolicies, value);
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFilename(value: string): string {
  return value.trim().replaceAll("/", "_").replaceAll("\\", "_");
}

function filenameExtension(value: string): string | null {
  const filename = value.trim().toLowerCase();
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > -1 ? filename.slice(dotIndex) : null;
}

function contentTypeAllowsExtension(contentType: string, extension: string): boolean {
  switch (contentType) {
    case "image/jpeg":
      return extension === ".jpg" || extension === ".jpeg";
    case "image/png":
      return extension === ".png";
    case "image/webp":
      return extension === ".webp";
    case "image/gif":
      return extension === ".gif";
    case "image/heic":
      return extension === ".heic";
    case "image/heif":
      return extension === ".heif";
    case "application/pdf":
      return extension === ".pdf";
    default:
      return false;
  }
}

function isImageContentType(contentType: string): boolean {
  return normalizeContentType(contentType).startsWith("image/");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSupportedSourceImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const extension = filenameExtension(url.pathname);
    if (extension === null) return true;
    return purposePolicies["pms.import.source_image"].allowedExtensions.includes(extension);
  } catch {
    return false;
  }
}

function resizedVariantDimensions(
  variantName: PlatformMediaVariantName,
  widthPx: number | undefined,
  heightPx: number | undefined,
  resizeOversizedPublicImages: boolean,
): { widthPx: number; heightPx: number } | null {
  if (
    !widthPx ||
    !heightPx ||
    variantName === "provider_original" ||
    !resizeOversizedPublicImages
  ) {
    return widthPx && heightPx ? { widthPx, heightPx } : null;
  }
  const max = publicImageVariantMaxDimensions[variantName];
  const scale = Math.min(1, max.widthPx / widthPx, max.heightPx / heightPx);
  return {
    widthPx: Math.max(1, Math.round(widthPx * scale)),
    heightPx: Math.max(1, Math.round(heightPx * scale)),
  };
}

function resizedVariantSize(
  inspection: PlatformMediaFinalizedFileInspection,
  dimensions: { widthPx: number; heightPx: number } | null,
): number {
  if (!dimensions || !inspection.widthPx || !inspection.heightPx) return inspection.sizeBytes;
  const originalPixels = inspection.widthPx * inspection.heightPx;
  const variantPixels = dimensions.widthPx * dimensions.heightPx;
  return Math.max(1, Math.round(inspection.sizeBytes * (variantPixels / originalPixels)));
}

function sourceFilename(sourceImageUrl: string, index: number): string {
  try {
    const pathname = new URL(sourceImageUrl).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    return filename ? normalizeFilename(filename) : `source-${index + 1}.jpg`;
  } catch {
    return `source-${index + 1}.jpg`;
  }
}
